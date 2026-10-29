import { createDocsAdapter } from './docs.mjs';
import { createDocsCreationAdapter } from './docs-create.mjs';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DOCS = 'https://docs.googleapis.com/v1';
function failure(response, operation) {
  const error = new Error(`${operation} failed (${response.status})`);
  error.status = response.status;
  if (response.status === 401) error.code = 'reauthentication_required';
  return error;
}
function params(url, values) {
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  return url;
}
export function createGoogleAdapter({ store, getClient, fetchImpl = fetch, clock = () => Date.now() }) {
  async function token(fields) {
    let response;
    try { response = await fetchImpl(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) }); }
    catch { throw new Error('Google authorization is temporarily unavailable'); }
    if (!response.ok) {
      const error = failure(response, 'Google authorization');
      // A generic 400 is not proof the user's grant was revoked.
      if (response.status === 400) {
        try { if ((await response.json())?.error === 'invalid_grant') error.code = 'invalid_grant'; }
        catch { /* Keep the bounded HTTP status. */ }
      }
      throw error;
    }
    return response.json();
  }
  async function userInfo(accessToken) {
    const response = await fetchImpl(USERINFO, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw failure(response, 'Google identity');
    const info = await response.json();
    if (!info.sub || info.email_verified !== true || !info.email) throw new Error('Google account identity is unverified');
    return info;
  }
  async function access(record, force = false) {
    const current = await store.bySubject(record.subject);
    if (!current) throw Object.assign(new Error('Google account was removed'), { code: 'reauthentication_required' });
    if (!force && current.accessToken && current.expiresAt > clock() + 60_000) return current.accessToken;
    const { clientId, clientSecret } = await getClient();
    if (!clientId || !clientSecret) throw new Error('Configure the Google Web OAuth client first');
    const next = await token({ grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: clientId, client_secret: clientSecret });
    if (!next.access_token) throw new Error('Google returned no access token');
    const saved = await store.mergeToken(current.subject, current.refreshToken, { accessToken: next.access_token,
      expiresAt: clock() + (Number(next.expires_in) || 3600) * 1000, refreshToken: next.refresh_token });
    if (!saved) throw Object.assign(new Error('Google account changed during refresh'), { code: 'reauthentication_required' });
    return next.access_token;
  }
  async function verifiedAccess(record, force = false) {
    let accessToken = await access(record, force);
    let info;
    try { info = await userInfo(accessToken); }
    catch (error) {
      if (force || error.status !== 401) throw error;
      accessToken = await access(record, true);
      info = await userInfo(accessToken);
    }
    if (info.sub !== record.subject) throw Object.assign(new Error('Google account identity changed'), { code: 'reauthentication_required' });
    if (info.email !== record.email) await store.updateEmail(record.subject, info.email);
    return accessToken;
  }
  async function get(record, url) {
    let accessToken = await verifiedAccess(record);
    let response;
    try { response = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` } }); }
    catch { throw new Error('Google Drive is temporarily unavailable'); }
    if (response.status === 401) {
      accessToken = await verifiedAccess(record, true);
      response = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` } });
    }
    if (!response.ok) throw failure(response, 'Google Drive request');
    return response.json();
  }
  return {
    docs: createDocsAdapter({ verifiedAccess, fetchImpl }),
    creation: createDocsCreationAdapter({ verifiedAccess, fetchImpl }),
    oauth: {
      authorizeUrl({ clientId, redirectUri, state, challenge, scopes, loginHint }) {
        return params(new URL(AUTH), { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '),
          access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state, login_hint: loginHint,
          code_challenge: challenge, code_challenge_method: 'S256' }).toString();
      },
      exchange({ code, verifier, clientId, clientSecret, redirectUri }) {
        return token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri });
      },
      identity: userInfo,
    },
    drive: {
      async identity(record) { const accessToken = await verifiedAccess(record); return userInfo(accessToken); },
      listFiles(record, { q, pageSize, pageToken }) {
        return get(record, params(new URL(`${DRIVE}/files`), { q, pageSize, pageToken,
          fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,description,modifiedTime,parents,webViewLink)',
          spaces: 'drive', corpora: 'user', supportsAllDrives: true, includeItemsFromAllDrives: true }));
      },
      getFile(record, id) {
        return get(record, params(new URL(`${DRIVE}/files/${encodeURIComponent(id)}`), {
          fields: 'id,name,mimeType,description,modifiedTime,parents,webViewLink,trashed,capabilities(canCopy,canAddChildren)', supportsAllDrives: true }));
      },
      getSharingMetadata(record, id) {
        return get(record, params(new URL(`${DRIVE}/files/${encodeURIComponent(id)}`), {
          fields: 'id,name,mimeType,webViewLink,driveId,shared,owners(displayName,emailAddress,me),capabilities(canShare)', supportsAllDrives: true }));
      },
      listPermissions(record, id, pageToken) {
        return get(record, params(new URL(`${DRIVE}/files/${encodeURIComponent(id)}/permissions`), {
          supportsAllDrives: true, pageSize: 100, pageToken,
          fields: 'nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,allowFileDiscovery,deleted,expirationTime,pendingOwner,permissionDetails(permissionType,role,inherited,inheritedFrom))',
        }));
      },
      async copyFile(record, sourceId, folderId, name) {
        const accessToken = await verifiedAccess(record);
        const grant = await fetchImpl('https://oauth2.googleapis.com/tokeninfo', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ access_token: accessToken }),
        });
        if (!grant.ok) throw failure(grant, 'Google scope inspection');
        const scopes = new Set(String((await grant.json()).scope || '').split(/\s+/));
        if (!scopes.has('https://www.googleapis.com/auth/drive.file') && !scopes.has('https://www.googleapis.com/auth/drive'))
          throw Object.assign(new Error('Copy requires a separately authorized write grant; current read-only access cannot copy.'), { code: 'copy_scope_required' });
        // Exactly one POST. Neither transport failures nor 401/5xx are retried.
        let response;
        try {
          response = await fetchImpl(params(new URL(`${DRIVE}/files/${encodeURIComponent(sourceId)}/copy`), {
            supportsAllDrives: true, fields: 'id',
          }), { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ parents: [folderId], ...(name === undefined ? {} : { name }) }) });
        } catch { return { outcome: 'uncertain', retrySafe: false }; }
        if (!response.ok) {
          if (response.status >= 500 || response.status === 408) return { outcome: 'uncertain', retrySafe: false };
          throw failure(response, 'Google copy');
        }
        let id;
        try { id = (await response.json()).id; } catch { /* Unknown write result. */ }
        if (!id) return { outcome: 'uncertain', retrySafe: false };
        return { id };
      },
      readDoc(record, id) {
        return get(record, params(new URL(`${DOCS}/documents/${encodeURIComponent(id)}`), { includeTabsContent: true }));
      },
    },
  };
}
