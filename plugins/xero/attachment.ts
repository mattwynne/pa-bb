import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { XeroError } from './diagnostic.ts';
export async function attachment(filePath: string) {
  const failure = () => new XeroError('input', 'attachment_read', 'Could not read a regular PDF, PNG or JPEG of at most 3 MB. Use the exact source-document path on the BB server; symlinks are not accepted.');
  const ext = extname(filePath).toLowerCase();
  if (!['.pdf', '.png', '.jpg', '.jpeg'].includes(ext)) throw failure();
  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > 3_000_000) throw failure();
    // Bound even if a file grows between stat and read.
    const buffer = Buffer.alloc(3_000_001); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await file.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
    if (length > 3_000_000) throw failure();
    const bytes = buffer.subarray(0, length);
    const valid = ext === '.pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : ext === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!valid) throw failure();
    return { bytes, fileName: basename(filePath), contentType: ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg' };
  } catch { throw failure(); }
  finally { await file?.close(); }
}
