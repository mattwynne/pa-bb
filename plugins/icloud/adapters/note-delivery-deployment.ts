import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { CloudError } from '../core/ports.ts';

export const managedMirrorBinding = z.string().max(512).regex(/^(FOLDER|APP_LIBRARY)::[A-Za-z0-9._-]+::[A-Za-z0-9._-]+$/);
const scope = z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/),managedMirrorBinding);
const part = z.string().max(1024);
const workerPin = z.strictObject({binary:part,sha256:part,mirrors:z.string().max(4096)});

export async function managedDeliveryDeployment(value: unknown) {
  const {binary,sha256,mirrors} = workerPin.parse(value);
  if (!binary && !sha256 && !mirrors) return null;
  const selected = scope.parse(JSON.parse(mirrors));
  if (!Object.keys(selected).length || Object.keys(selected).length > 4) throw new CloudError('configuration');
  await verifyManagedDeliveryBinary(binary,sha256);
  return {binary,mirrors:selected};
}

export async function verifyManagedDeliveryBinary(binary: string,sha256: string) {
  if (!isAbsolute(binary) || normalize(binary) !== binary || !/^[a-f0-9]{64}$/.test(sha256))
    throw new CloudError('configuration');
  const info = await lstat(binary);
  if (!info.isFile() || info.nlink !== 1 || (info.uid !== 0 && info.uid !== process.getuid?.()) ||
      (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0 || info.size > (64 << 20) || await realpath(binary) !== binary)
    throw new CloudError('configuration');
  const executable = await open(binary, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await executable.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new CloudError('source_changed');
    const actual = createHash('sha256').update(await executable.readFile()).digest('hex');
    if (actual !== sha256) throw new CloudError('source_changed');
  } finally { await executable.close(); }
}
