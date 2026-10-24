import type { SourceSwitch } from '../core/application-model.ts';

/** Private, immutable, server-derived intent. Never accepted from an RPC. */
export type SourceModeIntent = {
  receipt: SourceSwitch; baseUrl: string; sourceUrl: string; localPath: string; serverPid: number;
  expected: { generation: string; requested: string; resolved: string; subdirectory: string | null };
  local: { fingerprint: string; stamp: string; version: string } | null;
  dependencies: string[]; requirePause: boolean;
};

/** Literal JavaScript, deliberately NOT Function.toString(): BB's bundler may
 * inject closure helpers into functions. A literal cannot acquire dependencies
 * on removable code. Executed in disposable HTTP tests as a real Node process.
 */
export const sourceModeRunnerScript = String.raw`
(async () => {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { join, isAbsolute } = await import('node:path');
  const { createRequire } = await import('node:module');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const read = async name => {
    const handle = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 65536) throw Error(); return JSON.parse(await handle.readFile('utf8')); }
    finally { await handle.close(); }
  };
  const atomic = async (name, value) => {
    const handle = await fs.open(name + '.tmp', constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await handle.chmod(0o600); await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(name + '.tmp', name);
    const directory = await fs.open('.', constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  };
  const intent = await read('intent.json');
  const r = await read('receipt.json');
  if (r.jobId !== intent.receipt.jobId || r.id !== intent.receipt.id || r.target !== intent.receipt.target) throw Error();
  const ids = ['google-calendar', 'fastmail', 'google-drive', 'icloud', 'obsidian', 'pa-updates'];
  const base = new URL(intent.baseUrl);
  if (!ids.includes(r.id) || !['github', 'local'].includes(r.target) || base.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/' || !base.port || !isAbsolute(intent.localPath)) throw Error();
  const persist = async () => { r.updatedAt = new Date().toISOString(); await atomic('receipt.json', r); };
  let boundary = 'interrupted';
  const lifetime = new AbortController();
  let failing = null;
  const fail = reason => failing ??= (async () => {
    r.phase = 'attention'; r.reason = reason; r.manualRecovery = r.removalAttempted || r.syncReserved;
    await persist();
  })();
  const watchdog = setTimeout(() => { lifetime.abort(); void fail(boundary).finally(() => process.exit(1)); }, 10 * 60_000);
  const request = async (path, method = 'GET', body, expected = 200) => {
    lifetime.signal.throwIfAborted();
    const response = await fetch(base.origin + '/api/v1' + path, { method, redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', ...(path === '/plugins/install' ? { Prefer: 'respond-async' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status !== expected || !response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel(); throw Error(); }
    const reader = response.body?.getReader(); if (!reader) throw Error();
    const chunks = []; let size = 0;
    try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 1024 * 1024) throw Error(); chunks.push(next.value); } }
    finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  const listed = async () => { const value = await request('/plugins'); if (!Array.isArray(value.plugins) || value.plugins.length > 512) throw Error(); return value.plugins; };
  const noJobs = async () => {
    const installs = await request('/plugins/install-jobs');
    const updates = await request('/plugins/update-jobs');
    if (!Array.isArray(installs.jobs) || installs.jobs.length > 512 || !Array.isArray(updates.jobs) || updates.jobs.length > 512) throw Error();
    // Refuse active install AND update jobs, including unknown selected IDs.
    if ([...installs.jobs, ...updates.jobs].some(job => !['succeeded', 'failed', 'cancelled'].includes(job.state))) throw Error();
  };
  const source = () => request('/plugins/' + r.id + '/source');
  const healthy = plugin => plugin.enabled && ['running', 'needs-configuration'].includes(plugin.status) && !(plugin.status === 'running' && plugin.statusDetail) && (!plugin.app?.hasApp || plugin.app.bundle?.compatible);
  const generation = (plugin, src) => hash([plugin.id, plugin.version, plugin.enabled, plugin.rootDir, src.requested, src.resolved, src.subdirectory ?? null]);
  const paused = async () => {
    if (!r.syncReserved) throw Error();
    const reply = await request('/plugins/icloud/rpc/status', 'POST', null);
    if (reply.ok !== true || reply.result?.updatePause?.version !== 1 || reply.result.updatePause.jobId !== r.jobId || !Array.isArray(reply.result.mirrors) || reply.result.mirrors.length > 20 || reply.result.mirrors.some(m => m.enabled !== false || m.phase === 'running')) throw Error();
    return reply.result;
  };
  const dependenciesReady = async () => {
    if (!Array.isArray(intent.dependencies) || intent.dependencies.length > 128 || intent.dependencies.some(name => typeof name !== 'string' || name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name))) throw Error();
    const resolver = createRequire(join(intent.localPath, 'package.json'));
    for (const name of intent.dependencies) {
      // Node can cache a successful resolution across DELETE/disposal; check
      // that the resolved runtime entry still exists instead of trusting cache.
      if (!(await fs.stat(resolver.resolve(name))).isFile()) throw Error();
    }
  };
  const localDetails = async () => {
    const entries = [], stamps = []; let total = 0;
    const ignored = new Set(['.git', 'node_modules', 'dist', 'test', 'tests', 'features', 'docs']);
    const visit = async (dir, prefix = '') => {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        const path = prefix + item.name;
        if (ignored.has(item.name) || /(^|\/)(README[^/]*|LICENSE[^/]*|\.DS_Store|\.env[^/]*)$/.test(path)) continue;
        if (path.length > 1024 || path.split('/').length > 16 || /[\0\\]/.test(path) || item.isSymbolicLink()) throw Error();
        if (item.isDirectory()) { await visit(join(dir, item.name), path + '/'); continue; }
        const file = await fs.open(join(dir, item.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat({ bigint: true }); total += Number(stat.size);
          if (!stat.isFile() || stat.size > 2n * 1024n * 1024n || total > 32 * 1024 * 1024 || entries.length >= 512) throw Error();
          const data = await file.readFile(), after = await file.stat({ bigint: true });
          if (BigInt(data.length) !== stat.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) throw Error();
          entries.push([path, createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex')]);
          stamps.push([path, [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')]);
        } finally { await file.close(); }
      }
    };
    if (await fs.realpath(intent.localPath) !== intent.localPath) throw Error();
    await visit(intent.localPath);
    const digest = values => hash(values.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    if (!entries.length) throw Error(); return { fingerprint: digest(entries), stamp: digest(stamps) };
  };
  try {
    // Parent records the owned PID before readiness. Neither a stale gate nor
    // another process with a different UUID/PID can grant this runner authority.
    let launched = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { const launch = await read('launch.json'); launched = launch.jobId === r.jobId && launch.pid === process.pid; } catch { /* parent has not recorded ownership yet */ }
      if (launched) break; await sleep(50);
    }
    if (!launched) throw Error();
    // Readiness is not admission. No removal before the durable parent permit.
    await atomic('ready.json', { jobId: r.jobId, pid: process.pid });
    let permitted = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { const permit = await read('permit.json'); permitted = permit.jobId === r.jobId && permit.pid === process.pid; } catch { /* not admitted yet */ }
      if (permitted) break; await sleep(50);
    }
    if (!permitted) throw Error();
    r.phase = 'running'; await persist(); boundary = 'changed';
    await noJobs();
    let plugin = (await listed()).find(p => p.id === r.id);
    let src = await source();
    if (!plugin || !healthy(plugin) || generation(plugin, src) !== intent.expected.generation || src.requested !== intent.expected.requested || src.resolved !== intent.expected.resolved || (src.subdirectory ?? null) !== intent.expected.subdirectory) throw Error();
    if (intent.local) {
      boundary = 'dependencies_missing'; await dependenciesReady(); boundary = 'changed';
      const details = await localDetails();
      if (details.fingerprint !== intent.local.fingerprint || details.stamp !== intent.local.stamp) throw Error();
    }
    let handedOffIds = [];
    if (intent.requirePause) {
      boundary = 'pause_incomplete'; const status = await paused();
      handedOffIds = status.mirrors.map(m => m.id).sort();
      for (const mirror of status.mirrors) {
        if (typeof mirror.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(mirror.id)) throw Error();
        const result = await request('/plugins/icloud/rpc/pause', 'POST', { id: mirror.id });
        if (result.ok !== true || result.result?.updatePause?.version !== 1 || result.result.updatePause.jobId !== r.jobId || !Array.isArray(result.result.mirrors) || result.result.mirrors.length > 20 || result.result.mirrors.some(m => m.enabled !== false || m.phase === 'running')) throw Error();
      }
      const after = await paused();
      if (JSON.stringify(after.mirrors.map(m => m.id).sort()) !== JSON.stringify(handedOffIds)) throw Error();
      r.pauseHandoff = true; await persist();
    }
    // Re-read registration, local generation and pause state immediately before
    // the destructive boundary; draining never grants fresh source authority.
    boundary = 'changed'; await noJobs();
    plugin = (await listed()).find(p => p.id === r.id); src = await source();
    if (!plugin || !healthy(plugin) || generation(plugin, src) !== intent.expected.generation) throw Error();
    if (intent.local) {
      boundary = 'dependencies_missing'; await dependenciesReady(); boundary = 'changed';
      const details = await localDetails();
      if (details.fingerprint !== intent.local.fingerprint || details.stamp !== intent.local.stamp) throw Error();
    }
    if (intent.requirePause) {
      boundary = 'pause_incomplete'; const current = await paused();
      if (JSON.stringify(current.mirrors.map(m => m.id).sort()) !== JSON.stringify(handedOffIds)) throw Error();
    }
    lifetime.signal.throwIfAborted();
    boundary = 'remove_uncertain'; r.removalAttempted = true; r.configuration = 'possibly_deleted'; await persist();
    const removed = await request('/plugins/' + r.id, 'DELETE'); if (removed.ok !== true) throw Error();
    if ((await listed()).some(p => p.id === r.id)) throw Error();
    r.removed = true; r.configuration = 'deleted'; await persist();
    boundary = 'install_uncertain'; await noJobs();
    if ((await listed()).some(p => p.id === r.id)) throw Error();
    if (intent.local) {
      // DELETE can dispose code while the working copy is being edited. Recheck
      // identity and runtime bytes AFTER removal, immediately before admission.
      // This is not a lock against edits after this check or BB's final parse.
      boundary = 'changed';
      const manifest = await read(join(intent.localPath, 'package.json'));
      if (manifest.name !== 'bb-plugin-' + r.id || manifest.bb?.server !== './server.ts' || manifest.version !== intent.local.version) throw Error();
      boundary = 'dependencies_missing'; await dependenciesReady(); boundary = 'changed';
      const details = await localDetails();
      if (details.fingerprint !== intent.local.fingerprint || details.stamp !== intent.local.stamp) throw Error();
    }
    boundary = 'install_uncertain'; r.installAdmitted = true; await persist();
    const installed = await request('/plugins/install', 'POST', r.target === 'local'
      ? { source: 'path:' + intent.localPath, selection: { kind: 'root' } }
      : { source: 'git:' + intent.sourceUrl + '@main', selection: { kind: 'subdirectory', path: 'plugins/' + r.id } }, 202);
    if (installed.ok !== true || typeof installed.job?.id !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(installed.job.id)) throw Error();
    let succeeded = false;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const response = await request('/plugins/install-jobs/' + installed.job.id); const job = response.job;
      if (!job || job.id !== installed.job.id) throw Error();
      if (job.state === 'failed' || job.state === 'cancelled') { boundary = 'install_failed'; throw Error(); }
      if (job.state === 'succeeded') { if (job.plugin?.id !== r.id) throw Error(); succeeded = true; break; }
      if (!['queued', 'running', 'cancelling'].includes(job.state)) throw Error();
      await sleep(500);
    }
    if (!succeeded) throw Error();
    boundary = 'verification_failed';
    plugin = (await listed()).find(p => p.id === r.id); src = await source();
    const targetMatches = r.target === 'local' ? src.requested === 'path:' + intent.localPath && !src.subdirectory && plugin?.rootDir === intent.localPath
      : ['git:' + intent.sourceUrl + '@main', 'git:' + intent.sourceUrl + '@ref:main'].includes(src.requested) && src.subdirectory === 'plugins/' + r.id;
    if (!targetMatches || !plugin || !healthy(plugin) || typeof plugin.version !== 'string' || plugin.version.length > 64 || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i.test(plugin.version)) throw Error();
    if (intent.local) {
      const details = await localDetails();
      if (plugin.version !== intent.local.version || details.fingerprint !== intent.local.fingerprint || details.stamp !== intent.local.stamp) throw Error();
    }
    if (intent.requirePause) await paused();
    r.actual = plugin.version; r.phase = 'complete'; r.reason = null; r.manualRecovery = false; await persist();
  } catch { await fail(boundary); }
  finally { clearTimeout(watchdog); }
})().catch(() => process.exit(1));
`;
