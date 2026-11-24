export const externalLink = (value: string) => /^[a-z][\w+.-]*:/i.test(value) || value.startsWith('//');

export function linkReference(spelling: string) {
  const fragment = spelling.indexOf('#');
  const path = fragment < 0 ? spelling : spelling.slice(0, fragment);
  if (externalLink(path)) return { status: 'external' as const };
  if (/%(?:2f|5c)/i.test(path)) return { status: 'target_encoding' as const };
  try {
    const name = decodeURIComponent(path);
    if (externalLink(name)) return { status: 'external' as const };
    if (path.includes('?') || /[\\\x00-\x1f\x7f]/.test(name)) return { status: 'target_characters' as const };
    return { status: 'internal' as const, name, path, subpath: fragment < 0 ? '' : decodeURIComponent(spelling.slice(fragment + 1)) };
  } catch {
    return { status: 'target_encoding' as const };
  }
}
