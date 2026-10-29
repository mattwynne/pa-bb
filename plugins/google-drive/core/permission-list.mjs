// Bounded, protocol-neutral permission pagination shared by reads and writes.
export async function readPermissionList(readPage) {
  const permissions = [], seen = new Set(); let pageToken;
  for (let page = 0; page < 10; page++) {
    let result;
    try { result = await readPage(pageToken); }
    catch (error) { return { permissions, complete: false, error }; }
    if (!Array.isArray(result?.permissions)) return { permissions, complete: false };
    permissions.push(...result.permissions);
    pageToken = result.nextPageToken;
    if (!pageToken) return { permissions, complete: true };
    if (typeof pageToken !== 'string' || seen.has(pageToken)) break;
    seen.add(pageToken);
  }
  return { permissions, complete: false };
}
