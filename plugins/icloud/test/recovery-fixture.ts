import { mkdtemp, mkdir, readdir, lstat, readFile, copyFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandRunner } from '../adapters/rclone-process.ts';
export async function recoveryFixture() {
  const root = await mkdtemp('/tmp/icloud-incremental-'); const cloud = join(root, 'cloud'); const local = join(root, 'local');
  await mkdir(cloud); await mkdir(local);
  const commands: string[][] = []; let afterCopy: (() => Promise<void>) | undefined; let unknownTime = false;
  const list = async (base: string, prefix = ''): Promise<any[]> => {
    const result: any[] = [];
    for (const name of await readdir(join(base, prefix))) {
      const path = prefix ? `${prefix}/${name}` : name; const info = await lstat(join(base, path));
      if (info.isDirectory()) result.push(...await list(base, path));
      else result.push({ Path: path, IsDir: false, Size: info.size, ModTime: unknownTime ? '' : info.mtime.toISOString(), ID: path });
    }
    return result;
  };
  const run: CommandRunner = async (args, _capture, report) => {
    commands.push(args);
    if (args[0] === 'lsjson') return JSON.stringify((await list(args[1])).map(item => ({ ...item, Path: item.Path.replaceAll('\n', '␊') })));
    const destination = args[2].replace(/^:local,encoding=0x2018002:/, '');
    const single = args[0] === 'copyto';
    const selected = single ? [args[1]] : (await readFile(args[args.indexOf('--files-from-raw') + 1], 'utf8')).split('\n').filter(Boolean);
    let bytes = 0; let files = 0;
    for (const path of selected) {
      const source = single ? path : join(args[1], path.replaceAll('␊', '\n')); const target = single ? destination : join(destination, path);
      await mkdir(join(target, '..'), { recursive: true }); await copyFile(source, target); bytes += (await lstat(source)).size; files++;
      report?.({ bytes, files, totalBytes: bytes, totalFiles: selected.length });
    }
    await afterCopy?.(); return '';
  };
  const put = async (side: 'cloud' | 'local', path: string, text: string, seconds = 1_000_000) => {
    const file = join(side === 'cloud' ? cloud : local, path); await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, text); await utimes(file, seconds, seconds);
  };
  return { root, cloud, local, run, commands, put, afterCopy: (fn: (() => Promise<void>) | undefined) => { afterCopy = fn; }, unknownTime: () => { unknownTime = true; } };
}
