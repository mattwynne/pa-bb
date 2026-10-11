import type { CloudFolder } from './core/ports.ts';
export type SelectedFolder = { folder: Pick<CloudFolder, 'id' | 'ancestors'>; phase: string };
export type SelectionStatus = 'Selected' | 'Inside a selected folder' | 'Contains a selected folder' | null;
export function selectionStatus(folder: Pick<CloudFolder, 'id' | 'ancestors'>, selected: readonly SelectedFolder[]): SelectionStatus {
  const active = selected.filter(mirror => mirror.phase !== 'retained');
  if (active.some(mirror => mirror.folder.id === folder.id)) return 'Selected';
  if (active.some(mirror => folder.ancestors.includes(mirror.folder.id))) return 'Inside a selected folder';
  if (active.some(mirror => mirror.folder.ancestors.includes(folder.id))) return 'Contains a selected folder';
  return null;
}
