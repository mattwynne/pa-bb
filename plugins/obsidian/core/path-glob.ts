import picomatch from 'picomatch';
import { VaultError } from './ports.ts';

export type PathGlob = ((path: string) => boolean) & { readonly fixedDirectory: string; mayMatchBelow(directory: string): boolean };

/** Positive POSIX glob, never passed to the filesystem. */
export function compilePathGlob(pattern: string): PathGlob {
  const invalid = () => new VaultError('invalid_query', 'Use one vault-relative POSIX glob (for example Projects/**/*.md).');
  const parts = pattern.split('/');
  if (!pattern || pattern.length > 256 || /^!|^[A-Za-z]:\//.test(pattern) || /[\\\x00-\x1f\x7f]|[?*+@!]\(/.test(pattern) ||
    parts.some(part => !part || part === '.' || part === '..' || (part.match(/\*+/g)?.length ?? 0) > 2 ||
      (part.match(/\{/g)?.length ?? 0) > 2 || (part.match(/,/g)?.length ?? 0) > 12)) throw invalid();
  let components: (RegExp | null)[];
  try {
    // Picomatch treats unmatched closing braces as literals; this contract
    // requires balanced brace syntax (braces inside a class are literals).
    for (const part of parts) {
      let depth = 0, bracket = false;
      for (let i = 0; i < part.length; i++) {
        const char = part[i];
        if (bracket && part.startsWith('[:', i)) {
          const end = part.indexOf(':]', i + 2);
          if (end < 0) throw invalid();
          i = end + 1;
        } else if (char === '[') bracket = true;
        else if (char === ']') bracket = false;
        else if (!bracket && char === '{') depth++;
        else if (!bracket && char === '}' && --depth < 0) throw invalid();
      }
      if (depth) throw invalid();
    }
    // Picomatch handles ordinary segment syntax; only a standalone ** spans
    // directories. Match globstars with bounded dynamic programming rather
    // than nested regex repetition across a potentially deep note path.
    components = parts.map(part => part === '**' ? null : picomatch.makeRe(part.replace(/[()|"]/g, '\\$&'), {
      dot: true, posix: true, nocase: false, nonegate: true, noextglob: true,
      strictBrackets: true, strictSlashes: true, literalBrackets: false, regex: false, debug: true,
    }));
  } catch { throw invalid(); }
  const globstars = components.includes(null);
  const match = (names: string[], below: boolean) => {
    if (!globstars) return (below ? names.length < components.length : names.length === components.length) && names.every((name, i) => components[i]!.test(name));
    let row = new Uint8Array(names.length + 1); row[0] = 1;
    const last = names.length;
    for (const re of components) {
      // A valid prefix before another component can extend to a descendant.
      // Conservatively allow any suffix, even when it could match no note.
      if (below && row[last]) return true;
      const next = new Uint8Array(row.length);
      if (!re) next[0] = row[0];
      let any = !!next[0];
      for (let i = 1; i < row.length; i++) {
        next[i] = re ? Number(!!row[i - 1] && re.test(names[i - 1])) : row[i] | next[i - 1];
        any ||= !!next[i];
      }
      if (!any) return false;
      if (below && !re && next[last]) return true; // trailing globstar can keep consuming
      row = next;
    }
    return !below && !!row[last];
  };
  // Only assert a fixed directory when its leading segments are literal.
  // General wildcard/exclusion intersections remain conservative.
  const dirs = parts.slice(0, -1);
  const variable = dirs.findIndex(part => /[*?\[\]{}]/.test(part));
  const fixedDirectory = (variable === -1 ? dirs : dirs.slice(0, variable)).join('/');
  return Object.assign((path: string) => match(path.split('/'), false), {
    fixedDirectory,
    mayMatchBelow: (directory: string) => match(directory ? directory.split('/') : [], true),
  });
}
