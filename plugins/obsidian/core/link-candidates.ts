import { posix } from 'node:path';

export const pathKey = (path: string) => path.normalize('NFC').toLocaleLowerCase('und');
export const noteNameKey = (path: string) => pathKey(posix.basename(path)).replace(/\.md$/, '');

const isRelativeLink = (name: string) => name.startsWith('./') || name.startsWith('../');

export function linkPathForms(name: string, folder: string, wiki: boolean) {
  const path = posix.normalize(name.startsWith('/') ? name.slice(1)
    : wiki && !isRelativeLink(name) ? name : posix.join(folder, name));
  return [path, path + '.md'];
}

export const isShortWikiPath = (name: string) => name.includes('/') && !name.startsWith('/') && !isRelativeLink(name);
export const suffixForms = (name: string) => linkPathForms(name, '', true).map(pathKey);
export const matchesSuffix = (forms: string[], path: string) => forms.some(form => path === form || path.endsWith('/' + form));

export function createLinkCandidates(paths: ReadonlySet<string>) {
  const basenames = new Map<string, string[]>();
  for (const path of paths) {
    const key = noteNameKey(path);
    const matches = basenames.get(key);
    if (matches) matches.push(path);
    else basenames.set(key, [path]);
  }
  return {
    byName: (name: string) => basenames.get(noteNameKey(name)) ?? [],
    byPath: (forms: string[]) => forms.filter(path => paths.has(path)),
    // A suffix match is evidence of a possible target, not a resolution rule.
    bySuffix: (forms: string[]) => [...new Set(forms.flatMap(form => basenames.get(noteNameKey(form)) ?? []))]
      .filter(path => matchesSuffix(forms, pathKey(path))),
  };
}
