import { createHash, randomBytes } from 'node:crypto';

export const SCOPES = Object.freeze(['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly']);
const STATE_MS = 5 * 60 * 1000;
const FOLDER = 'application/vnd.google-apps.folder';
const DOCUMENT = 'application/vnd.google-apps.document';
const MAX_TEXT = 100_000;
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
};
const limit = value => value === undefined ? 25 : Math.max(1, Math.min(100, Math.trunc(Number(value)) || 1));
// Drive q uses quoted literals; never interpolate unescaped user text as syntax.
const literal = value => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const code = e => e?.code === 'invalid_grant' || e?.status === 401 || e?.code === 'reauthentication_required'
  ? 'reauthentication_required' : 'drive_unavailable';
const fileInfo = file => ({
  id: file.id, name: file.name, mimeType: file.mimeType, description: file.description,
  modifiedTime: file.modifiedTime, parents: file.parents,
  url: file.webViewLink || (file.id ? file.mimeType === FOLDER
    ? `https://drive.google.com/drive/folders/${encodeURIComponent(file.id)}`
    : file.mimeType === DOCUMENT ? `https://docs.google.com/document/d/${encodeURIComponent(file.id)}/edit`
      : `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view` : null),
});
function textFromElements(elements) {
  let result = '';
  for (const item of elements || []) {
    if (item.paragraph) for (const part of item.paragraph.elements || []) result += part.textRun?.content || '';
    if (item.table) for (const row of item.table.tableRows || []) for (const cell of row.tableCells || []) result += textFromElements(cell.content) + '\t';
    if (item.tableOfContents) result += textFromElements(item.tableOfContents.content);
  }
  return result;
}
function textFromTabs(tabs) {
  let result = '';
  for (const tab of tabs || []) {
    if (tab.documentTab?.body?.content) result += textFromElements(tab.documentTab.body.content);
    result += textFromTabs(tab.childTabs);
  }
  return result;
}

// Ports are plugin-owned storage, Google OAuth, Google Drive/Docs reads, and clock.
export function createDriveService({ store, oauth, drive, clock = () => Date.now() }) {
  async function account(email) {
    const record = await store.byEmail(required(email, 'account'));
    if (!record) throw new Error('Unknown Google Drive account. Check connected accounts in BB settings.');
    return record;
  }
  async function beginConnect({ clientId, redirectUri }) {
    required(clientId, 'OAuth client ID');
    if (!redirectUri?.startsWith('https://')) throw new Error('OAuth redirect URI must use HTTPS');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await store.savePending({ stateHash: createHash('sha256').update(state).digest('hex'), verifier, redirectUri, clientId, expiresAt: clock() + STATE_MS });
    return { url: oauth.authorizeUrl({ clientId, redirectUri, state, challenge, scopes: SCOPES }) };
  }
  async function finishConnect({ state, code: authorizationCode, error, clientId, clientSecret, redirectUri }) {
    if (!state || !authorizationCode || error) throw new Error('Google authorization was cancelled or incomplete');
    const pending = await store.consumePending(createHash('sha256').update(state).digest('hex'));
    if (!pending || pending.expiresAt <= clock() || pending.redirectUri !== redirectUri || pending.clientId !== clientId) throw new Error('Google authorization has expired or is invalid');
    const tokens = await oauth.exchange({ code: authorizationCode, verifier: pending.verifier, clientId, clientSecret, redirectUri });
    if (!tokens?.refresh_token) throw new Error('Google did not provide a refresh token; reconnect with consent');
    const granted = new Set((tokens.scope || '').split(/\s+/));
    const missing = SCOPES.filter(scope => scope !== 'email' && !granted.has(scope));
    if (missing.length) throw new Error('Google did not grant the required read-only Drive access');
    const identity = await oauth.identity(tokens.access_token);
    if (!identity?.sub || identity.email_verified !== true || !identity.email) throw new Error('Google did not verify the account identity');
    await store.addAccount({ subject: identity.sub, email: identity.email, refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token, expiresAt: clock() + (Number(tokens.expires_in) || 3600) * 1000 });
    return { subject: identity.sub, email: identity.email };
  }
  async function authStatus() {
    const accounts = [];
    for (const record of await store.accounts()) {
      let status = 'Connected';
      try {
        const identity = await drive.identity(record);
        if (identity?.sub !== record.subject) throw Object.assign(new Error('Google identity changed'), { code: 'reauthentication_required' });
        if (identity.email !== record.email) await store.updateEmail(record.subject, identity.email);
      } catch (error) { status = code(error) === 'reauthentication_required' ? 'Re-authentication required' : 'Connection unavailable'; }
      accounts.push({ subject: record.subject, email: (await store.bySubject(record.subject))?.email || record.email, status });
    }
    return { accounts };
  }
  async function searchFiles(args) {
    const records = args.accounts?.length ? await Promise.all(args.accounts.map(account)) : await store.accounts();
    if (args.pageToken && records.length !== 1) throw new Error('Select exactly one account to continue a search page');
    const clauses = ['trashed = false'];
    if (args.query) {
      const term = required(args.query, 'query');
      if (term.length > 200) throw new Error('Search query is too long');
      clauses.push(`(name contains ${literal(term)} or fullText contains ${literal(term)})`);
    }
    if (args.folderId) clauses.push(`${literal(required(args.folderId, 'folderId'))} in parents`);
    if (args.foldersOnly) clauses.push(`mimeType = '${FOLDER}'`);
    const results = await Promise.all(records.map(async record => {
      try {
        const page = await drive.listFiles(record, { q: clauses.join(' and '), pageSize: limit(args.pageSize),
          // A provider page token belongs to the selected account, never broadcast it to others.
          pageToken: args.pageToken });
        return { account: record.email, files: (page.files || []).map(fileInfo), nextPageToken: page.nextPageToken || null, incompleteSearch: page.incompleteSearch === true };
      } catch (error) { return { account: record.email, files: [], error: { code: code(error) } }; }
    }));
    return { accounts: results };
  }
  async function listFolder(args) {
    const record = await account(args.account);
    const folderId = required(args.folderId, 'folderId');
    const page = await drive.listFiles(record, { q: `trashed = false and ${literal(folderId)} in parents`, pageSize: limit(args.pageSize), pageToken: args.pageToken });
    return { account: record.email, folderId, files: (page.files || []).map(fileInfo), nextPageToken: page.nextPageToken || null, incompleteSearch: page.incompleteSearch === true };
  }
  async function getFile(args) {
    const record = await account(args.account);
    return { account: record.email, file: fileInfo(await drive.getFile(record, required(args.fileId, 'fileId'))) };
  }
  async function readDoc(args) {
    const record = await account(args.account);
    const input = required(args.document, 'document');
    let id = input;
    if (/^https:\/\//.test(input)) {
      const url = new URL(input);
      if (url.hostname !== 'docs.google.com' || !/^\/document\/d\/[a-zA-Z0-9_-]+(?:\/|$)/.test(url.pathname)) throw new Error('Use a Google Docs URL or document ID');
      id = url.pathname.split('/')[3];
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Use a Google Docs URL or document ID');
    const metadata = await drive.getFile(record, id);
    if (metadata.mimeType !== DOCUMENT) throw new Error('This file is not a Google Doc; reading other formats is not supported yet');
    const doc = await drive.readDoc(record, id);
    const text = doc.tabs?.length ? textFromTabs(doc.tabs) : textFromElements(doc.body?.content);
    return { account: record.email, documentId: id, title: doc.title || metadata.name,
      url: metadata.webViewLink || `https://docs.google.com/document/d/${encodeURIComponent(id)}/edit`,
      text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
  }
  const tools = { gdrive_auth_status: authStatus, gdrive_search_files: searchFiles, gdrive_list_folder: listFolder,
    gdrive_get_file: getFile, gdocs_read: readDoc };
  async function execute(name, args = {}) {
    if (!Object.hasOwn(tools, name)) throw new Error('Unknown Google Drive tool');
    return tools[name](args);
  }
  return { beginConnect, finishConnect, removeAccount: subject => store.removeAccount(required(subject, 'subject')), execute };
}
