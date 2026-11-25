import { constants } from 'node:fs';
import { open, lstat, mkdir, unlink, rmdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { XeroError } from './diagnostic.ts';
export const MAX_TRANSFER_BYTES = 20 * 1024 * 1024;
function failed(message: string): never { throw new XeroError('input', 'file_transfer', message); }
export function fileName(value: string) {
  if (!value || value !== basename(value) || value === '.' || value === '..' || /[\\/\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 240) failed('Use a plain filename, not a path or a name containing control characters.');
  return value;
}
export async function readUpload(path: string) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 0 || stat.size > MAX_TRANSFER_BYTES) failed('Use a regular source file on the BB server of at most 20 MiB. Symlinks are not accepted.');
    const buffer = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset !== stat.size) failed('The source file changed while it was read. Verify it and try again.');
    return { bytes: buffer.subarray(0, offset), name: fileName(basename(path)) };
  } catch (error) {
    if (error instanceof XeroError) throw error;
    throw new XeroError('input', 'file_transfer', 'Could not read the selected source file. Use its exact BB-server path; no upload was attempted.');
  } finally { await file?.close().catch(() => { throw new XeroError('input', 'upload_close', 'Could not close the source file safely. No upload was attempted.'); }); }
}
export async function responseBytes(response: Response, stage: string) {
  const reader = response.body?.getReader(); if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const value = await reader.read(); if (value.done) break;
      size += value.value.byteLength;
      if (size > MAX_TRANSFER_BYTES) { await reader.cancel(); throw new XeroError('response_invalid', stage, 'Xero response exceeds the 20 MiB transfer bound. Narrow the query or use paging. Any requested change may already be saved.'); }
      chunks.push(value.value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof XeroError) throw error;
    throw new XeroError('transport', stage, 'The Xero response was interrupted. Any requested change may already be saved; inspect the record before retrying.');
  } finally { reader.releaseLock(); }
}
export async function saveDownload(root: string, threadId: string, name: string, mimeType: string, bytes: Buffer, signal: AbortSignal) {
  fileName(name); signal.throwIfAborted();
  const segment = 'xero-' + randomUUID(), directory = join(root, segment), target = join(directory, name);
  let created = false, opened = false, file;
  try {
    const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) failed('Current-thread storage is not a regular directory. No download was saved.');
    await mkdir(directory, { mode: 0o700 }); created = true;
    file = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600); opened = true;
    await file.writeFile(bytes); await file.sync();
    const saved = await file.stat(), readback = Buffer.alloc(bytes.length); let offset = 0;
    while (offset < bytes.length) { const value = await file.read(readback, offset, bytes.length - offset, offset); if (!value.bytesRead) break; offset += value.bytesRead; }
    if (saved.size !== bytes.length || saved.nlink !== 1 || !readback.equals(bytes)) failed('Downloaded bytes could not be verified locally. No file reference was returned.');
    signal.throwIfAborted();
    return { source: { host: 'bb-server', threadId, path: segment + '/' + name }, name, mimeType, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    let cleanupFailed = false;
    if (opened) await unlink(target).catch(() => { cleanupFailed = true; });
    if (created) await rmdir(directory).catch(() => { cleanupFailed = true; });
    if (cleanupFailed) throw new XeroError('verification', 'download_cleanup', 'Local download cleanup did not complete. Inspect current-thread storage before retrying; no file reference was returned.');
    throw new XeroError('verification', 'download_save', 'Xero returned the download, but local saving or verification did not complete. No file reference was returned. Inspect any requested provider change before retrying.');
  } finally { await file?.close().catch(() => { throw new XeroError('verification', 'download_close', 'Could not close the downloaded file safely. Inspect current-thread storage before retrying.'); }); }
}
