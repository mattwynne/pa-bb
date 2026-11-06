// Linux BB-server storage only, matching the Drive source adapter. Pin every
// directory descriptor; never follow a path supplied by the agent or provider.
import { constants } from 'node:fs';
import { open, mkdir, link, unlink, rmdir, readlink } from 'node:fs/promises';
import { posix } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AttachmentError, attachmentFail, MAX_ATTACHMENT_BYTES } from './attachment-download.ts';

export function safeAttachmentName(name: string) {
  if (!name || name.startsWith('.') || Buffer.byteLength(name) > 255 || /[\\/\p{Cc}\p{Cs}]/u.test(name) || /[. ]$/.test(name))
    return attachmentFail('attachment_file', 'unsafe_filename');
  return name;
}
export async function saveOriginal(root: string, name: string, bytes: Buffer, provenance: object, ensureCurrent: () => void,
  options: { platform?: string; directoryName?: () => string } = {}) {
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  let directory = ''; let published = false; let receipt = false; let partial = false; let madeDirectory = false;
  let parent = ''; let segment = '';
  try {
    if ((options.platform ?? process.platform) !== 'linux' || !posix.isAbsolute(root) || posix.normalize(root) !== root || root === '/' ||
        /^\/(proc|dev|sys)(\/|$)/.test(root) || /[\x00-\x1f\x7f]/.test(root) || !bytes.length || bytes.length > MAX_ATTACHMENT_BYTES)
      return attachmentFail('attachment_file', 'unsupported_storage');
    safeAttachmentName(name); ensureCurrent();
    let current = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(current);
    for (const part of root.split('/').filter(Boolean)) {
      current = await open(`/proc/self/fd/${current.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(current);
    }
    parent = `/proc/self/fd/${current.fd}`;
    segment = options.directoryName?.() ?? `fastmail-${randomUUID()}`;
    if (!/^fastmail-[a-z0-9-]{1,64}$/.test(segment)) return attachmentFail('attachment_file', 'unsafe_filename');
    await mkdir(`${parent}/${segment}`, { mode: 0o700 }); madeDirectory = true; // EEXIST is a refusal, never reuse.
    const dir = await open(`${parent}/${segment}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(dir);
    directory = `/proc/self/fd/${dir.fd}`;
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR | constants.O_NONBLOCK;
    const file = await open(`${directory}/.partial`, flags, 0o600); handles.push(file); partial = true;
    await file.writeFile(bytes); await file.sync();
    const stat = await file.stat();
    const readback = Buffer.alloc(bytes.length); let offset = 0;
    while (offset < readback.length) { const r = await file.read(readback, offset, readback.length - offset, offset); if (!r.bytesRead) return attachmentFail('attachment_file', 'readback_failed'); offset += r.bytesRead; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes.length || !bytes.equals(readback) ||
        createHash('sha256').update(readback).digest('hex') !== (provenance as { sha256?: string }).sha256)
      return attachmentFail('attachment_file', 'readback_failed');
    if (await readlink(directory) !== posix.join(root, segment)) return attachmentFail('attachment_file', 'storage_changed');
    ensureCurrent();
    const manifest = await open(`${directory}/.provenance.json`, flags, 0o600); handles.push(manifest); receipt = true;
    await manifest.writeFile(JSON.stringify(provenance)); await manifest.sync();
    // Atomic no-replace publication. A partially written file is never returned.
    await link(`${directory}/.partial`, `${directory}/${name}`); published = true;
    await unlink(`${directory}/.partial`); partial = false;
    await dir.sync();
    ensureCurrent();
    if (await readlink(directory) !== posix.join(root, segment) || (await file.stat()).nlink !== 1)
      return attachmentFail('attachment_file', 'storage_changed');
    return `${segment}/${name}`;
  } catch (error) {
    // Cleanup only entries created by this attempt, never a colliding directory.
    let cleanupFailed = false;
    for (const [created, path] of [[published, `${directory}/${name}`], [partial, `${directory}/.partial`], [receipt, `${directory}/.provenance.json`]] as const) {
      if (created) try { await unlink(path); } catch { cleanupFailed = true; }
    }
    if (madeDirectory) try { await rmdir(`${parent}/${segment}`); } catch { cleanupFailed = true; }
    if (cleanupFailed) return attachmentFail('attachment_file', 'cleanup_failed');
    if (error instanceof AttachmentError) throw error;
    return attachmentFail('attachment_file', 'storage_refused');
  } finally { for (const h of handles.reverse()) await h.close().catch(() => {}); }
}
