// Shared passive-media boundary for Office containers. Signature checks are not
// malware/visual-fidelity certification; package/OLE relationships are rejected
// separately, irrespective of the part's filename or declared MIME.
import { uploadError } from '../core/upload.mjs';
export function ooxmlMediaType(path, prefix) {
  if (!['word', 'ppt', 'xl'].includes(prefix) || !new RegExp(`^${prefix}/media/[A-Za-z0-9_-]+\\.(?:png|jpe?g|gif)$`).test(path)) return undefined;
  return path.endsWith('.png') ? 'image/png' : path.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
}
export function inspectOoxmlMedia(content, type) {
  const valid = type === 'image/png' ? content.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : type === 'image/jpeg' ? content[0] === 255 && content[1] === 216 && content[2] === 255
      : type === 'image/gif' && (content.subarray(0, 6).equals(Buffer.from('GIF87a')) || content.subarray(0, 6).equals(Buffer.from('GIF89a')));
  if (!valid) throw uploadError('conversion');
}
