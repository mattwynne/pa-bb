// Google Drive rules: deliberately My Drive only. Permission IDs identify a
// grantee across items, so a matching ancestor ID is conservatively inherited.
// Missing permissionDetails on My Drive never independently proves directness.
import { createHash } from 'node:crypto';
import { readPermissionList } from '../core/permission-list.mjs';
import { sharingError } from '../core/sharing.mjs';
import { createDocsTransport } from './docs-transport.mjs';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const definiteRejection = status => [400, 401, 403, 404, 409, 412, 422].includes(status);
const validId = value => typeof value === 'string' && /^[\w-]{1,256}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
const canonical = p => ({ id: p.id, type: p.type, role: p.role, emailAddress: p.emailAddress?.toLowerCase(), domain: p.domain,
  allowFileDiscovery: p.allowFileDiscovery, deleted: p.deleted, expirationTime: p.expirationTime, pendingOwner: p.pendingOwner,
  permissionDetails: p.permissionDetails?.map(d => ({ permissionType: d.permissionType, role: d.role, inherited: d.inherited, inheritedFrom: d.inheritedFrom }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
const sort = list => list.map(canonical).sort((a, b) => a.id.localeCompare(b.id));
const audience = p => p.type === 'anyone' ? 'Anyone — public audience' : `${p.type}: ${p.emailAddress || p.domain || 'unknown audience'}`;
export function createSharingAdapter({ drive, verifiedAccess, fetchImpl = fetch }) {
  const transport = createDocsTransport({ verifiedAccess, fetchImpl });
  async function snapshot(record, fileId) {
    const visited = new Set(), ancestry = [];
    const root = await drive.getSharingMetadata(record, 'root');
    if (!validId(root.id) || fileId === root.id) throw sharingError('unsupported');
    async function item(id) {
      const metadata = await drive.getSharingMetadata(record, id);
      if (metadata.id !== id || typeof metadata.name !== 'string' || !metadata.name || metadata.name.length > 1024
        || typeof metadata.mimeType !== 'string' || metadata.trashed !== false || metadata.driveId || metadata.inheritedPermissionsDisabled === true
        || metadata.owners?.length !== 1 || metadata.owners[0].me !== true) throw sharingError('unsupported');
      const list = await readPermissionList(token => drive.listPermissions(record, id, token));
      if (!list.complete || !list.permissions.length) throw Object.assign(sharingError('incomplete'), { status: list.error?.status });
      const ids = new Set();
      for (const p of list.permissions) {
        if (!validId(p.id) || ids.has(p.id) || !['user', 'group', 'domain', 'anyone'].includes(p.type)
          || !['owner', 'reader', 'commenter', 'writer'].includes(p.role) || p.pendingOwner === true || p.deleted === true
          || (['user', 'group'].includes(p.type) && (typeof p.emailAddress !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(p.emailAddress) || p.emailAddress.length > 320))
          || (p.type === 'domain' && (typeof p.domain !== 'string' || !p.domain))
          || (['domain', 'anyone'].includes(p.type) && typeof p.allowFileDiscovery !== 'boolean')) throw sharingError('unsupported');
        ids.add(p.id);
      }
      if (list.permissions.filter(p => p.role === 'owner').length !== 1
        || !list.permissions.some(p => p.role === 'owner' && p.type === 'user' && p.emailAddress.toLowerCase() === record.email.toLowerCase())) throw sharingError('unsupported');
      // shared changes as a consequence of granting; it is not an authority or
      // concurrency token. Keep only stable reviewed target/context fields.
      const { shared: _shared, ...context } = metadata;
      return { metadata: context, permissions: sort(list.permissions) };
    }
    const target = await item(fileId);
    if (target.metadata.capabilities?.canShare !== true || target.metadata.mimeType === 'application/vnd.google-apps.shortcut') throw sharingError('unsupported');
    let current = target;
    while (current.metadata.id !== root.id) {
      const parents = current.metadata.parents;
      if (!Array.isArray(parents) || parents.length !== 1 || !validId(parents[0]) || visited.has(parents[0]) || ancestry.length >= 32) throw sharingError('unsupported');
      visited.add(parents[0]); current = await item(parents[0]); ancestry.push(current);
    }
    return { target, ancestry };
  }
  function select(snap, request) {
    const { permissions } = snap.target;
    const matches = request.action === 'grant' ? permissions.filter(p => p.type === request.audience.type
      && (p.type === 'anyone' || p.emailAddress?.toLowerCase() === request.audience.emailAddress.toLowerCase()))
      : permissions.filter(p => p.id === request.permissionId);
    if (request.action === 'grant' ? matches.length !== 0 : matches.length !== 1) throw sharingError('unsupported');
    const current = matches[0];
    if (current && (current.role === 'owner' || !['user', 'group', 'anyone'].includes(current.type) || current.expirationTime
      || current.permissionDetails?.some(d => d.inherited !== false))) throw sharingError('unsupported');
    const inherited = snap.ancestry.some(a => a.permissions.some(p => current ? p.id === current.id
      : p.type === request.audience.type && (p.type === 'anyone' || p.emailAddress?.toLowerCase() === request.audience.emailAddress.toLowerCase())));
    if (inherited) throw sharingError('unsupported');
    const principal = current || request.audience;
    if ((principal.type === 'anyone' && !['reader', 'writer', undefined].includes(request.role))
      || (request.notify === true && (request.action !== 'grant' || principal.type === 'anyone'))) throw sharingError('invalid');
    const after = request.action === 'revoke' ? null : { ...(current || principal), role: request.role,
      ...(principal.type === 'anyone' ? { allowFileDiscovery: false } : {}) };
    if (current && request.action === 'change' && digest(canonical(current)) === digest(canonical(after))) throw sharingError('invalid');
    return { current, after, principal };
  }
  async function propose(record, request) {
    const snap = await snapshot(record, request.fileId);
    const { current, after, principal } = select(snap, request);
    // Check scope before offering approval; never ask for or modify a grant.
    await prepare(record);
    const metadata = snap.target.metadata;
    return { fingerprint: digest(snap), before: snap.target.permissions, permissionId: current?.id,
      preview: { account: record.email, fileId: request.fileId, title: metadata.name,
        kind: metadata.mimeType === FOLDER ? 'folder' : 'file', audience: audience(principal), action: request.action,
        from: current ? `${current.role}${current.type === 'anyone' ? current.allowFileDiscovery ? ' — publicly discoverable' : ' — link access' : ''}` : 'No direct permission',
        to: after ? `${after.role}${principal.type === 'anyone' ? ' — link access, not searchable/discoverable' : ''}` : 'Remove this direct permission',
        notification: request.notify === true ? 'Send Google’s sharing notification email to this named recipient (opted in).'
          : request.action === 'grant' ? 'No sharing invitation email requested (notifications off).'
          : 'No invitation requested. Google provides no notification switch for permission changes or removals.',
        impact: metadata.mimeType === FOLDER
          ? 'This changes the folder permission and can affect contained items that inherit it, including future items. Descendants and their full audiences are not enumerated. No descendant or ancestor is rewritten.'
          : 'This changes only this item’s direct permission. Other routes of access may remain.',
        risk: principal.type === 'anyone' ? 'Anyone who obtains the link may access this item at the proposed role; the link can be forwarded. Removing link access does not remove other access.'
          : principal.type === 'group' ? 'This affects the group, including members not enumerated here and future membership changes.' : 'Other direct, group, domain or inherited access may remain.',
        concurrency: 'Google Drive permission mutations expose no revision/CAS precondition here. Live state is rechecked after approval, but another actor can race the write. Readback detects differences; no automatic rollback.',
      } };
  }
  async function prepare(record) {
    const mutate = await transport.prepareWrite(record, {
      scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.file'],
      scopeError: () => sharingError('scope_required'),
      beforeSubmissionFailure: error => Object.assign(error, { sharingNotSubmitted: true }),
      // Known request/authority refusals are terminal, consumed rejections.
      // Timeouts/rate limits/5xx and unreadable replies stay unresolved.
      writeRejection: status => Object.assign(sharingError(definiteRejection(status) ? 'rejected' : 'write_unavailable'), { status,
        sharingRejected: definiteRejection(status) }),
    });
    return async (request, permissionId, signal) => {
      const url = new URL(`${DRIVE}/${encodeURIComponent(request.fileId)}/permissions${request.action === 'grant' ? '' : `/${encodeURIComponent(permissionId)}`}`);
      url.searchParams.set('supportsAllDrives', 'false');
      if (request.action !== 'revoke') url.searchParams.set('fields', 'id');
      if (request.action === 'grant' && request.audience.type !== 'anyone') url.searchParams.set('sendNotificationEmail', String(request.notify === true));
      const body = request.action === 'grant' ? { ...request.audience, role: request.role, ...(request.audience.type === 'anyone' ? { allowFileDiscovery: false } : {}) }
        : request.action === 'change' ? { role: request.role } : undefined;
      // The caller sets no provider rules. Re-resolve public target from the
      // inspected permission ID for PATCH's discovery reduction.
      if (request.action === 'change') {
        const list = await readPermissionList(token => drive.listPermissions(record, request.fileId, token));
        if (!list.complete) throw Object.assign(sharingError('incomplete'), { sharingNotSubmitted: true });
        if (list.permissions.find(p => p.id === permissionId)?.type === 'anyone') body.allowFileDiscovery = false;
      }
      const response = await mutate(url, body, signal, { method: request.action === 'grant' ? 'POST' : request.action === 'change' ? 'PATCH' : 'DELETE', emptyResponse: request.action === 'revoke' });
      if (request.action !== 'revoke' && !validId(response?.id)) throw sharingError('write_unavailable');
      if (request.action === 'change' && response.id !== permissionId) throw sharingError('write_unavailable');
      return { permissionId: response?.id || permissionId };
    };
  }
  async function verify(record, op) {
    const snap = await snapshot(record, op.fileId);
    const now = snap.target.permissions, before = op.before, request = op.request;
    let permissionId = op.permissionId;
    if (request.action === 'grant') {
      const candidates = now.filter(p => p.type === request.audience.type && (p.type === 'anyone' || p.emailAddress?.toLowerCase() === request.audience.emailAddress.toLowerCase()));
      if (candidates.length !== 1) return { matches: false };
      if (permissionId && candidates[0].id !== permissionId) return { matches: false };
      permissionId = candidates[0].id;
    }
    const current = now.find(p => p.id === permissionId);
    const previous = before.find(p => p.id === permissionId);
    const unaffected = digest(now.filter(p => p.id !== permissionId)) === digest(before.filter(p => p.id !== permissionId));
    const expected = request.action === 'revoke' ? !current : current && current.role === request.role
      && (current.type !== 'anyone' || current.allowFileDiscovery === false)
      && (request.action === 'grant' ? !current.expirationTime && !current.pendingOwner && !current.permissionDetails?.some(d => d.inherited !== false) : digest(canonical(current)) === digest(canonical({ ...previous, role: request.role, ...(previous.type === 'anyone' ? { allowFileDiscovery: false } : {}) })));
    // Authority, name, parents and ancestry must still match the reviewed target.
    const original = op.fingerprint;
    const unchangedContext = digest({ ...snap, target: { ...snap.target, permissions: before } }) === original;
    return { matches: Boolean(unaffected && expected && unchangedContext), permissionId };
  }
  return { propose, prepare, verify };
}
