import { reference } from './contract.ts';

type RecordRef = { source: string; id: string };
export type PanelPath = 'areas' | 'projects';
export type Destination = { panel: PanelPath; subPath?: string };
export const areasIndex: Destination = { panel: 'areas' };
export const unassignedArea: Destination = { panel: 'areas', subPath: 'unassigned' };

export function recordDestination(panel: PanelPath, source: string, id: string): Destination {
  // A vault ID and note path form the identity. Keep the pair in one URL-safe
  // segment so slashes, percent escapes and Unicode survive BB's router.
  const bytes = new TextEncoder().encode(JSON.stringify([source, id]));
  const subPath = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return { panel, subPath };
}

export function panelHref({ panel, subPath }: Destination) {
  return `/plugins/gtd/${panel}${subPath ? `/${subPath}` : ''}`;
}

type Route = { kind: 'index' | 'unassigned' | 'invalid' } | { kind: 'area' | 'project'; record: RecordRef };
export function readRoute(panel: PanelPath, subPath: string): Route {
  if (!subPath) return { kind: 'index' };
  if (panel === 'areas' && subPath === unassignedArea.subPath) return { kind: 'unassigned' };
  if (/^[A-Za-z0-9_-]{1,12000}$/.test(subPath)) {
    try {
      const binary = atob(subPath.replaceAll('-', '+').replaceAll('_', '/'));
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
      if (Array.isArray(value) && value.length === 2) {
        const record = reference.safeParse({ source: value[0], id: value[1] }).data;
        if (record) return { kind: panel === 'areas' ? 'area' : 'project', record };
      }
    } catch {
      // Treat malformed bookmarks as unavailable pages.
    }
  }
  return { kind: 'invalid' };
}
