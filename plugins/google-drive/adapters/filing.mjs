import { createDocsTransport } from './docs-transport.mjs';
import { readPermissionList } from '../core/permission-list.mjs';
import { filingError, filingHash, filingId } from '../core/filing.mjs';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder', DOC = 'application/vnd.google-apps.document';
const fields = 'id,name,mimeType,trashed,parents,driveId,inheritedPermissionsDisabled,owners(me,emailAddress),capabilities(canAddChildren,canMoveItemWithinDrive)';
const literal = value => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const accessKey = p => JSON.stringify([p.type, p.emailAddress?.toLowerCase() || p.domain || '', p.type === 'anyone' ? p.allowFileDiscovery : null]);
const rank = { reader: 1, commenter: 2, writer: 3, owner: 4 };
const principal = p => p.type === 'anyone' ? (p.allowFileDiscovery ? 'Anyone — publicly discoverable' : 'Anyone with the link') : `${p.type}: ${p.emailAddress || p.domain || 'unknown audience'}`;
const canon = p => ({ id: p.id, type: p.type, role: p.role, emailAddress: p.emailAddress?.toLowerCase(), domain: p.domain,
  allowFileDiscovery: p.allowFileDiscovery, expirationTime: p.expirationTime, pendingOwner: p.pendingOwner,
  permissionDetails: p.permissionDetails?.map(d => ({ inherited: d.inherited, inheritedFrom: d.inheritedFrom, role: d.role, permissionType: d.permissionType }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
const sorted = list => list.map(canon).sort((a, b) => a.id.localeCompare(b.id));
const direct = chain => {
  const inheritedIds = new Set(chain.slice(1).flatMap(i => i.permissions.map(p => p.id)));
  return chain[0].permissions.filter(p => p.role === 'owner' || (!inheritedIds.has(p.id) && !p.permissionDetails?.some(d => d.inherited !== false)))
    .map(({ permissionDetails, ...p }) => p);
};
export function createFilingAdapter({ verifiedAccess, fetchImpl = fetch }) {
  const transport = createDocsTransport({ verifiedAccess, fetchImpl });
  function get(record, id) { return transport.get(record, `${FILES}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=false`); }
  function permissions(record, id, pageToken) {
    const u = new URL(`${FILES}/${encodeURIComponent(id)}/permissions`);
    u.search = new URLSearchParams({ pageSize: '100', supportsAllDrives: 'false', fields: 'nextPageToken,permissions(id,type,role,emailAddress,domain,allowFileDiscovery,expirationTime,pendingOwner,deleted,permissionDetails(inherited,inheritedFrom,role,permissionType))', ...(pageToken ? { pageToken } : {}) }).toString();
    return transport.get(record, u);
  }
  async function chain(record, id, rootId) {
    const result = [], visited = new Set();
    for (let depth = 0; depth < 33; depth++) {
      const m = await get(record, id);
      if (!filingId.safeParse(m.id).success || (id !== 'root' && m.id !== id) || visited.has(m.id)
        || typeof m.name !== 'string' || !m.name || m.name.length > 1024 || m.trashed !== false || m.driveId || m.inheritedPermissionsDisabled === true
        || m.owners?.length !== 1 || m.owners[0].me !== true || typeof m.owners[0].emailAddress !== 'string'
        || m.owners[0].emailAddress.toLowerCase() !== record.email.toLowerCase()) throw filingError('unsupported');
      if (depth && m.mimeType !== FOLDER) throw filingError('unsupported');
      visited.add(m.id);
      const list = await readPermissionList(token => permissions(record, m.id, token));
      if (!list.complete) throw Object.assign(filingError('incomplete'), { status: list.error?.status });
      const seen = new Set();
      for (const p of list.permissions) {
        if (!filingId.safeParse(p.id).success || seen.has(p.id) || p.deleted === true || p.pendingOwner === true
          || !['user', 'group', 'domain', 'anyone'].includes(p.type) || !['owner', 'reader', 'commenter', 'writer'].includes(p.role)
          || (['user', 'group'].includes(p.type) && (typeof p.emailAddress !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(p.emailAddress) || p.emailAddress.length > 320))
          || (p.type === 'domain' && (typeof p.domain !== 'string' || !p.domain))
          || (['domain', 'anyone'].includes(p.type) && typeof p.allowFileDiscovery !== 'boolean')) throw filingError('unsupported');
        seen.add(p.id);
      }
      if (list.permissions.filter(p => p.role === 'owner').length !== 1 || !list.permissions.some(p => p.role === 'owner' && p.type === 'user' && p.emailAddress.toLowerCase() === record.email.toLowerCase())) throw filingError('unsupported');
      result.push({ metadata: m, permissions: sorted(list.permissions) });
      if (m.id === rootId) return result;
      if (m.parents?.length !== 1 || !filingId.safeParse(m.parents[0]).success) throw filingError('unsupported');
      id = m.parents[0];
    }
    throw filingError('unsupported');
  }
  async function root(record) {
    const m = await get(record, 'root');
    if (!filingId.safeParse(m.id).success || m.mimeType !== FOLDER) throw filingError('unsupported');
    return m.id;
  }
  async function exactFolder(record, parentId, name) {
    const u = new URL(FILES);
    u.search = new URLSearchParams({ q: `trashed = false and mimeType = '${FOLDER}' and ${literal(parentId)} in parents and name = ${literal(name)}`,
      spaces: 'drive', corpora: 'user', pageSize: '2', fields: 'files(id),nextPageToken,incompleteSearch' }).toString();
    const p = await transport.get(record, u);
    if (p.incompleteSearch === true || !Array.isArray(p.files)) throw filingError('incomplete');
    if (p.files.length) throw filingError('duplicate');
    if (p.nextPageToken) throw filingError('incomplete');
  }
  async function prepare(record) {
    const mutate = await transport.prepareWrite(record, {
      scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.file'],
      scopeError: () => filingError('scope'), beforeSubmissionFailure: e => Object.assign(e, { filingNotSubmitted: true }),
      writeRejection: status => Object.assign(filingError('rejected'), { status, filingRejected: [400, 401, 403, 404, 409, 412, 422].includes(status) }),
    });
    return (kind, request, signal) => {
      if (kind === 'folder') return mutate(`${FILES}?fields=id`, { name: request.name, mimeType: FOLDER, parents: [request.destinationId], appProperties: { paFilingCreation: request.operationId } }, signal);
      const u = new URL(`${FILES}/${encodeURIComponent(request.fileId)}`);
      u.search = new URLSearchParams({ addParents: request.destinationId, removeParents: request.sourceParentId, fields: 'id', supportsAllDrives: 'false' }).toString();
      return mutate(u, {}, signal, { method: 'PATCH' }); // metadata only: never content, title, or permission changes
    };
  }
  async function propose(record, kind, request) {
    const rootId = await root(record);
    const destination = await chain(record, kind === 'folder' ? request.parentId : request.folderId, rootId);
    const dest = destination[0].metadata;
    if (dest.mimeType !== FOLDER || dest.capabilities?.canAddChildren !== true) throw filingError('unsupported');
    let source = null;
    if (kind === 'folder') await exactFolder(record, dest.id, request.name);
    else {
      source = await chain(record, request.fileId, rootId);
      const file = source[0].metadata;
      if (file.mimeType !== DOC || file.capabilities?.canMoveItemWithinDrive !== true || file.parents?.length !== 1
        || file.parents[0] !== (request.expectedParentId === 'root' ? rootId : request.expectedParentId) || dest.id === file.parents[0]) throw filingError('unsupported');
    }
    await prepare(record); // scope/identity before offering a proposal, never upgrades grants
    const nonOwners = [...destination, ...(source || [])].flatMap(i => i.permissions.filter(p => p.role !== 'owner'));
    const audience = [...new Set(nonOwners.map(p => `${principal(p)} — ${p.role}`))];
    if (audience.length > 40) throw filingError('unsupported'); // no clipped audience card
    const describeAccess = item => {
      const others = item.permissions.filter(p => p.role !== 'owner');
      return others.length ? [...new Set(others.map(p => `${principal(p)} — ${p.role}`))].join('\n') : 'Only the owner principal appeared in this listing.';
    };
    const title = kind === 'folder' ? request.name : source[0].metadata.name;
    const proposal = { contextIds: [...new Set([...destination, ...(source || [])].map(i => i.metadata.id))], destinationId: dest.id, sourceParentId: source?.[0].metadata.parents[0], fileId: source?.[0].metadata.id,
      resource: kind === 'folder' ? `folder:${record.subject}:${dest.id}:${filingHash(request.name)}` : `file:${request.fileId}`,
      fingerprint: filingHash([kind, destination, source]), destinationFingerprint: filingHash(destination), titleHash: filingHash(title),
      directBefore: source ? direct(source) : null,
      allowedAccess: [...destination[0].permissions, ...(source?.[0].permissions || [])].map(p => [accessKey(p), rank[p.role]]),
      requiresApproval: nonOwners.length > 0,
      preview: { kind, account: record.email, title, from: source ? source.slice(1).reverse().map(i => i.metadata.name).join(' / ') : 'New folder',
        to: [...destination].reverse().map(i => i.metadata.name).join(' / ') + (kind === 'folder' ? ` / ${request.name}` : ''),
        sourceAudience: source ? describeAccess(source[0]) : 'New folder — no existing audience.', destinationAudience: describeAccess(destination[0]),
        destinationId: dest.id, sourceParentId: source?.[0].metadata.parents[0] || '', fileId: source?.[0].metadata.id || '', audience: audience.length ? audience.join('\n') : 'Only the owner principal appeared in the inspected listings.',
        impact: 'Google re-evaluates inherited access when filing. Destination audiences may gain access; source-only inherited audiences may lose it. Direct grants are not rewritten. Group membership, domain policies and other access routes are not exhaustively visible.',
      } };
    if (Buffer.byteLength(JSON.stringify(proposal.preview), 'utf8') > 48_000) throw filingError('unsupported');
    return proposal;
  }
  async function verify(record, op) {
    const rootId = await root(record), destination = await chain(record, op.destinationId, rootId);
    const current = await chain(record, op.fileId, rootId), m = current[0].metadata;
    const visibleAccess = current[0].permissions.map(p => ({ type: p.type, role: p.role, audience: principal(p) }));
    const noUnexpectedAccess = current[0].permissions.every(p => op.allowedAccess.some(([key, max]) => key === accessKey(p) && rank[p.role] <= max));
    return { matches: m.id === op.fileId && m.mimeType === (op.kind === 'folder' ? FOLDER : DOC) && m.parents?.length === 1 && m.parents[0] === op.destinationId
      && filingHash(m.name) === op.titleHash && filingHash(destination) === op.destinationFingerprint && noUnexpectedAccess
      && (op.kind === 'folder' || op.directBefore.every(before => current[0].permissions.some(({ permissionDetails, ...p }) => filingHash(p) === filingHash(before)))), visibleAccess };
  }
  return { propose, prepare, verify,
    async findFolder(record, operationId) {
      const u = new URL(FILES);
      u.search = new URLSearchParams({ q: `trashed = false and mimeType = '${FOLDER}' and appProperties has { key='paFilingCreation' and value=${literal(operationId)} }`,
        spaces: 'drive', corpora: 'user', pageSize: '2', fields: 'files(id),nextPageToken,incompleteSearch' }).toString();
      const p = await transport.get(record, u);
      return p.incompleteSearch !== true && !p.nextPageToken && p.files?.length === 1 && filingId.safeParse(p.files[0].id).success ? p.files[0].id : null;
    },
  };
}
