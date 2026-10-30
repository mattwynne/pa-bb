import { createDocsTransport } from './docs-transport.mjs';
import { readPermissionList } from '../core/permission-list.mjs';
import { filingError, filingHash, filingId } from '../core/filing.mjs';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder', DOC = 'application/vnd.google-apps.document';
// Capability-driven, not a native/binary MIME allowlist. Shortcuts would move the
// pointer, not its target; folder trees need a separate access policy.
const movableType = mime => typeof mime === 'string' && mime.length <= 255
  && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mime)
  && ![FOLDER, 'application/vnd.google-apps.shortcut'].includes(mime);
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
  return chain[0].permissions.flatMap(({ permissionDetails, ...p }) => {
    if (p.role === 'owner') return [p];
    const explicit = permissionDetails?.filter(d => d.inherited === false) || [];
    if (explicit.length) {
      // An ancestor grant for the same principal does not erase an explicit
      // item-level grant. Mixed rows can have a stronger effective role than
      // their direct component; preserve/check the known direct role itself.
      const mixed = permissionDetails.some(d => d.inherited !== false);
      if (mixed && explicit.some(d => !rank[d.role])) throw filingError('unsupported');
      const role = explicit.every(d => rank[d.role]) ? explicit.reduce((best, d) => rank[d.role] > rank[best] ? d.role : best, 'reader') : p.role;
      return [{ ...p, role }];
    }
    return !inheritedIds.has(p.id) && !permissionDetails?.some(d => d.inherited !== false) ? [p] : [];
  });
};
export function createFilingAdapter({ verifiedAccess, fetchImpl = fetch }) {
  const transport = createDocsTransport({ verifiedAccess, fetchImpl });
  function get(record, id) { return transport.get(record, `${FILES}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=false`); }
  function permissions(record, id, pageToken) {
    const u = new URL(`${FILES}/${encodeURIComponent(id)}/permissions`);
    u.search = new URLSearchParams({ pageSize: '100', supportsAllDrives: 'false', fields: 'nextPageToken,permissions(id,type,role,emailAddress,domain,allowFileDiscovery,expirationTime,pendingOwner,deleted,permissionDetails(inherited,inheritedFrom,role,permissionType))', ...(pageToken ? { pageToken } : {}) }).toString();
    return transport.get(record, u);
  }
  // Only moves may inspect non-owned *ancestors*. The file and destination
  // themselves stay owned, and folder creation retains its all-owned policy.
  async function chain(record, id, rootId, sharedAncestors = false) {
    const result = [], visited = new Set();
    for (let depth = 0; depth < 33; depth++) {
      const m = await get(record, id);
      if (!filingId.safeParse(m.id).success || (id !== 'root' && m.id !== id) || visited.has(m.id)
        || typeof m.name !== 'string' || !m.name || m.name.length > 1024 || m.trashed !== false || m.driveId || m.inheritedPermissionsDisabled === true
        || m.owners?.length !== 1 || typeof m.owners[0].me !== 'boolean' || typeof m.owners[0].emailAddress !== 'string'
        || !/^[^\s@]+@[^\s@]+$/.test(m.owners[0].emailAddress) || m.owners[0].emailAddress.length > 320) throw filingError('unsupported');
      const owned = m.owners[0].emailAddress.toLowerCase() === record.email.toLowerCase();
      if (m.owners[0].me !== owned || (!owned && (!sharedAncestors || !depth || m.id === rootId))) throw filingError('unsupported');
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
      if (list.permissions.filter(p => p.role === 'owner').length !== 1 || !list.permissions.some(p => p.role === 'owner' && p.type === 'user' && p.emailAddress.toLowerCase() === m.owners[0].emailAddress.toLowerCase())) throw filingError('unsupported');
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
    const destination = await chain(record, kind === 'folder' ? request.parentId : request.folderId, rootId, kind === 'move');
    const dest = destination[0].metadata;
    if (dest.mimeType !== FOLDER || dest.capabilities?.canAddChildren !== true) throw filingError('unsupported');
    let source = null;
    if (kind === 'folder') await exactFolder(record, dest.id, request.name);
    else {
      source = await chain(record, request.fileId, rootId, true);
      const file = source[0].metadata;
      if (!movableType(file.mimeType) || file.capabilities?.canMoveItemWithinDrive !== true || file.parents?.length !== 1
        || file.parents[0] !== (request.expectedParentId === 'root' ? rootId : request.expectedParentId) || dest.id === file.parents[0]) throw filingError('unsupported');
    }
    await prepare(record); // scope/identity before offering a proposal, never upgrades grants
    const context = [...destination, ...(source || [])];
    const sharedAncestors = context.some(i => i.metadata.owners[0].me !== true);
    // A foreign folder owner is an audience/authority fact too, even if its
    // owner permission does not propagate to the owned destination as owner.
    const nonOwners = context.flatMap(i => i.permissions.filter(p => p.role !== 'owner' || p.emailAddress?.toLowerCase() !== record.email.toLowerCase()));
    const audience = [...new Set(nonOwners.map(p => `${principal(p)} — ${p.role}`))];
    if (audience.length > 40) throw filingError('unsupported'); // no clipped audience card
    const describeAccess = item => {
      const others = item.permissions.filter(p => p.role !== 'owner');
      return others.length ? [...new Set(others.map(p => `${principal(p)} — ${p.role}`))].join('\n') : 'Only the owner principal appeared in this listing.';
    };
    const describeOwners = items => items ? [...items].reverse().map(i => `${i.metadata.name} — owner: ${i.metadata.owners[0].emailAddress}`).join('\n') : 'New folder — no existing path.';
    const accessChanges = () => {
      if (!source) return 'Destination visible audiences may inherit access to the new folder.';
      const before = source[0].permissions, after = [...destination[0].permissions, ...direct(source)];
      const external = p => p.emailAddress?.toLowerCase() !== record.email.toLowerCase();
      const strongest = (items, p) => Math.max(0, ...items.filter(q => accessKey(q) === accessKey(p)).map(q => rank[q.role]));
      const gains = after.filter(p => external(p) && rank[p.role] > strongest(before, p)).map(p => `${principal(p)} — may gain/increase to ${p.role}`);
      const losses = before.filter(p => external(p) && rank[p.role] > strongest(after, p)).map(p => `${principal(p)} — may lose/reduce inherited ${p.role} access`);
      return [...new Set([...gains, ...losses])].join('\n') || 'No gain or loss identified in the visible item/destination listings; this is not exhaustive access proof.';
    };
    const title = kind === 'folder' ? request.name : source[0].metadata.name;
    const proposal = { contextIds: [...new Set([...destination, ...(source || [])].map(i => i.metadata.id))], destinationId: dest.id, sourceParentId: source?.[0].metadata.parents[0], fileId: source?.[0].metadata.id,
      mimeType: source ? source[0].metadata.mimeType : FOLDER,
      resource: kind === 'folder' ? `folder:${record.subject}:${dest.id}:${filingHash(request.name)}` : `file:${request.fileId}`,
      fingerprint: filingHash([kind, destination, source]), destinationFingerprint: filingHash(destination), titleHash: filingHash(title),
      directBefore: source ? direct(source) : null, directEvidenceVersion: 1,
      allowedAccess: [...destination[0].permissions, ...(source?.[0].permissions || [])].map(p => [accessKey(p), rank[p.role]]),
      requiresApproval: sharedAncestors || nonOwners.length > 0,
      preview: { kind, account: record.email, title, sharedAncestors, mimeType: source ? source[0].metadata.mimeType : FOLDER, from: source ? source.slice(1).reverse().map(i => i.metadata.name).join(' / ') : 'New folder',
        to: [...destination].reverse().map(i => i.metadata.name).join(' / ') + (kind === 'folder' ? ` / ${request.name}` : ''),
        sourceAudience: source ? describeAccess(source[0]) : 'New folder — no existing audience.', destinationAudience: describeAccess(destination[0]),
        sourceOwners: describeOwners(source?.slice(1)), destinationOwners: describeOwners(destination), accessChanges: accessChanges(),
        reviewReason: sharedAncestors ? 'An inspected ancestor belongs to another person. Exact owner approval is required even if visible audiences appear equivalent.' : 'Review the visible inherited-access impact.',
        destinationId: dest.id, sourceParentId: source?.[0].metadata.parents[0] || '', fileId: source?.[0].metadata.id || '', audience: audience.length ? audience.join('\n') : 'Only the owner principal appeared in the inspected listings.',
        impact: 'Google re-evaluates inherited access when filing. Destination audiences may gain access; source-only inherited audiences may lose it. Direct grants are not rewritten. Group membership, domain policies and other access routes are not exhaustively visible.',
      } };
    if (Buffer.byteLength(JSON.stringify(proposal.preview), 'utf8') > 48_000) throw filingError('unsupported');
    return proposal;
  }
  async function verify(record, op) {
    const rootId = await root(record), destination = await chain(record, op.destinationId, rootId, op.kind === 'move');
    const current = await chain(record, op.fileId, rootId, op.kind === 'move'), m = current[0].metadata;
    const visibleAccess = current[0].permissions.map(p => ({ type: p.type, role: p.role, audience: principal(p) }));
    // Preserve legacy receipt verification; new receipts retain explicit direct
    // evidence even when a principal also appears on the inspected ancestry.
    const directNow = op.kind === 'folder' ? [] : op.directEvidenceVersion === 1 ? direct(current) : current[0].permissions.map(({ permissionDetails, ...p }) => p);
    const noUnexpectedAccess = current[0].permissions.every(p => op.allowedAccess.some(([key, max]) => key === accessKey(p) && rank[p.role] <= max));
    return { matches: m.id === op.fileId && m.mimeType === (op.kind === 'folder' ? FOLDER : (op.mimeType ?? DOC)) && m.parents?.length === 1 && m.parents[0] === op.destinationId
      && filingHash(m.name) === op.titleHash && filingHash(destination) === op.destinationFingerprint && noUnexpectedAccess
      && (op.kind === 'folder' || op.directBefore.every(before => directNow.some(p => filingHash(p) === filingHash(before)))), visibleAccess };
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
