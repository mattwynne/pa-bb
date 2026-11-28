import type { PhotoRef } from './journal-images.ts';

// Grain limits, enforced in the compose sheet.
export const TITLE_LIMIT = 100;
export const WORDS_LIMIT = 1000;
export const byteLength = (value: string) => new TextEncoder().encode(value).length;
/** Trim text to at most `limit` UTF-8 bytes without splitting a character. */
export function clampBytes(value: string, limit: number) {
  if (byteLength(value) <= limit) return value;
  let result = '';
  for (const character of value) {
    if (byteLength(result + character) > limit) break;
    result += character;
  }
  return result;
}

export type Gallery = { title: string; words: string; photos: PhotoRef[] };
export type ShareResult = { ok: true; url: string | null } | { ok: false; message: string };

/**
 * Post a gallery to the configured Grain group.
 *
 * Posting plugs in here. The next version will sign in to HUD, render each
 * photo with `photoRendition` (JPEG, at most 2000 px and 1,000,000 bytes),
 * upload each through place.hud.uploadBlob, then make one apply_writes call
 * into the group's private space. Until then nothing is sent anywhere.
 */
export async function shareGallery(_gallery: Gallery): Promise<ShareResult> {
  return { ok: false, message: 'Sharing isn’t connected yet. It’s coming in the next version, and nothing has been posted.' };
}
