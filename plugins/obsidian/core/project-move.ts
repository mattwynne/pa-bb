import { posix } from 'node:path';
import { VaultError } from './ports.ts';

export type ProjectMove = 'standalone' | 'paired';
export type MoveEndpoints = { path: string; destination: string; project?: ProjectMove; root?: string; directory?: true };
export type PhysicalMove = 'moved_locally_pending_sync' | 'not_moved' | 'partial' | 'uncertain';

export function projectFolders({ path, destination, project }: MoveEndpoints) {
  if (!project) return;
  if (path === destination || posix.basename(path) !== posix.basename(destination)) throw new VaultError('invalid_path');
  const from = path.slice(0, -3);
  const to = destination.slice(0, -3);
  if (!from || !to || from === '.' || to === '.' || posix.basename(from) !== posix.basename(to) ||
    from.startsWith(to + '/') || to.startsWith(from + '/')) throw new VaultError('invalid_path');
  return { from, to };
}

export function moveFolders(input: MoveEndpoints) {
  if (!input.directory) return projectFolders(input);
  const { path: from, destination: to } = input;
  if (from === to || from.startsWith(to + '/') || to.startsWith(from + '/'))
    throw new VaultError('invalid_path', 'The source and destination folders must be distinct and cannot contain one another.');
  return { from, to };
}
