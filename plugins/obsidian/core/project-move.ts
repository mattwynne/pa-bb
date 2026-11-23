import { posix } from 'node:path';
import { VaultError } from './ports.ts';

export type ProjectMove = 'standalone' | 'paired' | 'folder';
export type MoveEndpoints = { path: string; destination: string; project?: ProjectMove; root?: string };
export type PhysicalMove = 'moved_locally_pending_sync' | 'not_moved' | 'partial' | 'uncertain';

export function projectFolders({ path, destination, project }: MoveEndpoints) {
  if (!project) return;
  if (path === destination || posix.basename(path) !== posix.basename(destination)) throw new VaultError('invalid_path');
  if (project === 'folder' && posix.basename(path) !== 'README.md') throw new VaultError('invalid_path');
  const from = project === 'folder' ? posix.dirname(path) : path.slice(0, -3);
  const to = project === 'folder' ? posix.dirname(destination) : destination.slice(0, -3);
  if (!from || !to || from === '.' || to === '.' || posix.basename(from) !== posix.basename(to) ||
    from.startsWith(to + '/') || to.startsWith(from + '/')) throw new VaultError('invalid_path');
  return { from, to };
}
