import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const NAME = 'pa-bb-google';
const OWNER = 'pa-bb-plugin';

async function exists(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function paths(agentDir) {
  const directory = join(agentDir, 'extensions');
  return { directory, link: join(directory, NAME), marker: join(directory, `.${NAME}.owner.json`) };
}

async function ownedLink(link, marker) {
  const stat = await exists(link);
  const markerStat = await exists(marker);
  if (!stat && !markerStat) return null;
  if (!stat?.isSymbolicLink() || !markerStat?.isFile()) {
    throw new Error('Pi registration is occupied or incomplete; refusing to overwrite it');
  }
  const record = JSON.parse(await readFile(marker, 'utf8'));
  const target = await readlink(link);
  if (record.owner !== OWNER || record.target !== target || !target.startsWith('/')) {
    throw new Error('Pi registration ownership mismatch; refusing to overwrite it');
  }
  return target;
}

/** Explicitly scoped to the supplied Pi agent directory; never modify credentials or settings. */
export async function reconcilePiRegistration({ agentDir, packageDir }) {
  if (!agentDir || !packageDir) throw new Error('Pi agent directory and packaged extension are required');
  const target = resolve(packageDir);
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  if (!Array.isArray(manifest.pi?.extensions) || !manifest.pi.extensions.length) {
    throw new Error('Packaged extension has no Pi extension entries');
  }
  for (const entry of manifest.pi.extensions) {
    if (!entry.startsWith('./') || resolve(target, entry).startsWith(`${target}/`) === false) {
      throw new Error('Invalid Pi extension entry');
    }
    if (!(await exists(resolve(target, entry)))) throw new Error(`Missing packaged Pi extension: ${entry}`);
  }
  const { directory, link, marker } = paths(agentDir);
  await mkdir(directory, { recursive: true });
  const previous = await ownedLink(link, marker);
  if (previous === target) return { status: 'current', link, target };

  // Prepare the new link first; rename is atomic within the extensions directory.
  const pending = join(directory, `.${NAME}.${randomUUID()}`);
  await symlink(target, pending);
  try {
    // The sidecar makes ownership explicit across a managed plugin path change.
    // Recheck immediately before replacing, to refuse ordinary conflicting registrations.
    if ((await ownedLink(link, marker)) !== previous) throw new Error('Pi registration changed during update');
    await rename(pending, link);
    await writeFile(marker, JSON.stringify({ owner: OWNER, target }) + '\n', { flag: 'w', mode: 0o600 });
  } finally {
    await rm(pending, { force: true });
  }
  return { status: previous ? 'updated' : 'created', link, target };
}

/** Call only for an explicit disable/uninstall action, never on normal shutdown or reload. */
export async function removePiRegistration({ agentDir }) {
  if (!agentDir) throw new Error('Pi agent directory is required');
  const { link, marker } = paths(agentDir);
  const previous = await ownedLink(link, marker);
  if (!previous) return { status: 'absent' };
  await rm(link);
  await rm(marker);
  return { status: 'removed' };
}
