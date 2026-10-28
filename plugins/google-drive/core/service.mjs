import { createHash, randomBytes } from 'node:crypto';

export const SCOPES = Object.freeze(['openid', 'email', 'https://www.googleapis.com/auth/drive']);
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
export function createDriveService({ store, oauth, drive, diagnose = /** @type {(stage: string, error: unknown) => void} */ (() => {}), clock = () => Date.now() }) {
  async function account(email) {
    const record = await store.byEmail(required(email, 'account'));
    if (!record) throw new Error('Unknown Google Drive account. Check connected accounts in BB settings.');
    return record;
  }
  /** @param {{ clientId: string, redirectUri: string, subject?: string }} args */
  async function beginConnect({ clientId, redirectUri, subject }) {
    const existing = subject === undefined ? null : await store.bySubject(required(subject, 'subject'));
    if (subject !== undefined && !existing) throw new Error('Reconnect account is no longer connected');
    required(clientId, 'OAuth client ID');
    if (!redirectUri?.startsWith('https://')) throw new Error('OAuth redirect URI must use HTTPS');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await store.savePending({ stateHash: createHash('sha256').update(state).digest('hex'), verifier, redirectUri, clientId, expiresAt: clock() + STATE_MS,
      reconnect: existing ? { subject: existing.subject, refreshHash: createHash('sha256').update(existing.refreshToken).digest('hex') } : null });
    return { url: oauth.authorizeUrl({ clientId, redirectUri, state, challenge, scopes: SCOPES, loginHint: existing?.email }) };
  }
  async function finishConnect({ state, code: authorizationCode, error, clientId, clientSecret, redirectUri }) {
    if (!state || !authorizationCode || error) throw new Error('Google authorization was cancelled or incomplete');
    const pending = await store.consumePending(createHash('sha256').update(state).digest('hex'));
    if (!pending || pending.expiresAt <= clock() || pending.redirectUri !== redirectUri || pending.clientId !== clientId) throw new Error('Google authorization has expired or is invalid');
    const tokens = await oauth.exchange({ code: authorizationCode, verifier: pending.verifier, clientId, clientSecret, redirectUri });
    if (!tokens?.refresh_token) throw new Error('Google did not provide a refresh token; reconnect with consent');
    const granted = new Set((tokens.scope || '').split(/\s+/));
    const missing = SCOPES.filter(scope => scope !== 'email' && !granted.has(scope));
    if (missing.length) throw new Error('Google did not grant the required full Drive access');
    const identity = await oauth.identity(tokens.access_token);
    if (!identity?.sub || identity.email_verified !== true || !identity.email) throw new Error('Google did not verify the account identity');
    const next = { subject: identity.sub, email: identity.email, refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token, expiresAt: clock() + (Number(tokens.expires_in) || 3600) * 1000 };
    if (pending.reconnect) {
      if (identity.sub !== pending.reconnect.subject) throw new Error('Reconnect requires the same Google account');
      const previous = await store.bySubject(pending.reconnect.subject);
      if (!previous || createHash('sha256').update(previous.refreshToken).digest('hex') !== pending.reconnect.refreshHash
        || !await store.replaceAccount(next, previous.refreshToken)) throw new Error('Reconnect account changed; start again');
    } else await store.addAccount(next);
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
      } catch (error) {
        status = code(error) === 'reauthentication_required' ? 'Re-authentication required' : 'Connection unavailable';
        diagnose('identity_lookup', error);
      }
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
      } catch (error) {
        diagnose('search_files', error);
        return { account: record.email, files: [], error: { code: code(error) } };
      }
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
  async function inspectSharing(args) {
    const record = await account(args.account);
    const id = required(args.fileId, 'fileId');
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Use explicit Drive file and folder IDs');
    const metadata = await drive.getSharingMetadata(record, id);
    const permissions = [];
    const seen = new Set();
    let pageToken;
    let listingComplete = false;
    let listingError = null;
    for (let page = 0; page < 10; page++) {
      try {
        const result = await drive.listPermissions(record, id, pageToken);
        if (!Array.isArray(result.permissions)) throw new Error('Incomplete permission response');
        for (const p of result.permissions) permissions.push({ id: p.id, type: p.type, role: p.role,
          emailAddress: p.emailAddress, domain: p.domain, displayName: p.displayName,
          allowFileDiscovery: p.allowFileDiscovery, deleted: p.deleted, expirationTime: p.expirationTime,
          pendingOwner: p.pendingOwner, permissionDetails: p.permissionDetails?.map(d => ({
            permissionType: d.permissionType, role: d.role, inherited: d.inherited, inheritedFrom: d.inheritedFrom })) });
        pageToken = result.nextPageToken;
        if (!pageToken) { listingComplete = true; break; }
        if (seen.has(pageToken)) break;
        seen.add(pageToken);
      } catch (error) {
        diagnose('inspect_sharing_permissions', error);
        listingError = code(error); break;
      }
    }
    return { account: record.email, file: fileInfo(metadata), owners: metadata.owners || [],
      sharedDriveId: metadata.driveId || null, shared: metadata.shared ?? null,
      canShare: metadata.capabilities?.canShare ?? null, permissions, listingComplete, listingError,
      anyoneAccess: permissions.filter(p => p.type === 'anyone' && p.deleted !== true).map(p => ({
        role: p.role, discovery: p.allowFileDiscovery === true ? 'discoverable' : p.allowFileDiscovery === false ? 'link' : 'unknown' })),
      visibility: 'Google-visible permissions only; not an exhaustive list of people with access. Group membership, domain audiences, ancestor policies and shared-drive membership may not be fully visible. Missing inheritance details mean unknown, not direct access. An empty list or shared=false does not establish privacy.' };
  }
  async function copyFile(args) {
    const record = await account(args.account);
    const sourceId = required(args.sourceId, 'sourceId');
    const folderId = required(args.folderId, 'folderId');
    if (![sourceId, folderId].every(id => /^[a-zA-Z0-9_-]+$/.test(id))) throw new Error('Use explicit Drive file and folder IDs');
    const title = args.title === undefined ? undefined : required(args.title, 'title');
    if (title && title.length > 255) throw new Error('Copy title is too long');
    const source = await drive.getFile(record, sourceId);
    const destination = await drive.getFile(record, folderId);
    if (source.trashed || source.mimeType === FOLDER || source.mimeType === 'application/vnd.google-apps.shortcut' || source.capabilities?.canCopy !== true)
      throw new Error('Source is not a copyable file');
    if (destination.trashed || destination.mimeType !== FOLDER || destination.capabilities?.canAddChildren !== true)
      throw new Error('Destination is not a writable folder');
    const result = await drive.copyFile(record, sourceId, folderId, title ?? source.name);
    if (!result.id) {
      diagnose('copy_outcome_uncertain', null);
      return { account: record.email, outcome: 'uncertain', retrySafe: false,
        guidance: 'Do not repeat the copy. Inspect the destination folder first; a copy may exist.' };
    }
    try {
      const file = await drive.getFile(record, result.id);
      if (file.id !== result.id || !file.parents?.includes(destination.id || folderId) || file.trashed) throw new Error('Copy verification failed');
      return { account: record.email, outcome: 'verified', file: fileInfo(file) };
    } catch (error) {
      diagnose('copy_verification', error);
      return { account: record.email, outcome: 'verification_unavailable', file: fileInfo({ id: result.id }), retrySafe: false,
        guidance: 'Copy returned an ID but verification failed. Inspect this file; do not copy again.' };
    }
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
    gdrive_get_file: getFile, gdrive_inspect_sharing: inspectSharing, gdrive_copy_file: copyFile, gdocs_read: readDoc };
  async function execute(name, args = {}) {
    if (!Object.hasOwn(tools, name)) throw new Error('Unknown Google Drive tool');
    return tools[name](args);
  }
  return { beginConnect, finishConnect, removeAccount: subject => store.removeAccount(required(subject, 'subject')), execute };
}
