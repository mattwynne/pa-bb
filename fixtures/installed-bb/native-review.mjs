// Mac Chrome via a private tunnel to disposable installed Linux BB; no routes
// are intercepted. BB_REVIEW_BASE, BB_REVIEW_CHROME, BB_REVIEW_ARTIFACTS required.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.BB_REVIEW_BASE, chrome = process.env.BB_REVIEW_CHROME, dir = process.env.BB_REVIEW_ARTIFACTS;
assert.ok(base && chrome && dir);
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: chrome });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pages = [];
const result = { actualRpc: true, routeInterception: false, screenshots: [], nativeSamples: [], dialogs: 0, connectedDuringNative: false };
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } }); pages.push(page);
    page.on('dialog', dialog => { result.dialogs++; void dialog.dismiss(); });
    await page.goto(`${base}/plugins/icloud?configure=icloud`);
    await page.locator('.pa-icloud').waitFor({ timeout: 30000 });
    await page.screenshot({ path: `${dir}/icloud-initial-${width}.png` }); result.screenshots.push(`icloud-initial-${width}`);
    await page.goto(`${base}/plugins/obsidian?configure=obsidian`);
    const section = page.locator('.pa-obsidian'); await section.waitFor();
    await section.getByRole('button', { name: 'Add vault', exact: true }).click();
    await section.getByRole('button', { name: 'Connect Generated' }).waitFor();
    await section.getByRole('button', { name: 'Connect Other' }).waitFor();
    await page.screenshot({ path: `${dir}/picker-open-${width}.png` }); result.screenshots.push(`picker-open-${width}`);
  }
  console.log('PICKER_READY');
  const start = performance.now();
  let runningAt = null, connectedAt = null;
  while (performance.now() - start < 110000) {
    const response = await fetch(`${base}/api/v1/plugins/icloud/rpc/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
    const status = (await response.json()).result;
    assert.ok(status?.mirrors?.length === 2 && status.noteAccessVersion === 2);
    const native = status.mirrors.find(m => m.id === 'one' && m.phase === 'running');
    if (native) {
      runningAt ??= performance.now();
      result.nativeSamples.push({ ms: Math.round(performance.now() - runningAt), phase: native.phase, progress: native.progress?.stage ?? null });
      for (const [index, width] of [1280, 390].entries()) {
        const section = pages[index].locator('.pa-obsidian');
        const connect = section.getByRole('button', { name: 'Connect Generated' });
        if (!connectedAt && index === 0) {
          await connect.waitFor({ timeout: 10000 }); assert.equal(await connect.isEnabled(), true);
          await pages[index].keyboard.press('Tab'); await connect.focus(); assert.equal(await connect.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
          await connect.click(); await section.getByText('Vault connected.', { exact: true }).waitFor();
          connectedAt = performance.now(); result.connectedDuringNative = true;
        } else if (index === 1 && !connectedAt) await connect.waitFor();
        assert.equal(await section.evaluate(el => el.scrollWidth > el.clientWidth), false);
        assert.equal(await pages[index].evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await pages[index].screenshot({ path: `${dir}/native-${width}.png` }); result.screenshots.push(`native-${width}`);
      }
      break;
    }
    await delay(400);
  }
  assert.ok(connectedAt, 'real native command never started while picker was open');
  const local = await fetch(`${base}/api/v1/plugins/obsidian/rpc/fixtureInvoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'obsidian_status', input: {} }) });
  const tool = (await local.json()).result; assert.ok(tool && !tool.isError);
  while (performance.now() - runningAt < 41000) {
    const statusResponse = await fetch(`${base}/api/v1/plugins/icloud/rpc/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
    const mirror = (await statusResponse.json()).result.mirrors.find(m => m.id === 'one');
    assert.equal(mirror.phase, 'running', 'native command must remain active with picker open');
    result.nativeSamples.push({ ms: Math.round(performance.now() - runningAt), phase: mirror.phase, progress: mirror.progress?.stage ?? null });
    const section = pages[1].locator('.pa-obsidian');
    assert.equal(await section.getByRole('button', { name: 'Connect Other' }).isVisible(), true);
    const readResponse = await fetch(`${base}/api/v1/plugins/obsidian/rpc/fixtureInvoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'obsidian_read_note', input: { vaultId: 'one', path: 'Note.md' } }) });
    const read = (await readResponse.json()).result; assert.ok(read && !read.isError && JSON.parse(read.text).complete);
    await delay(2000);
  }
  for (const [index, width] of [1280, 390].entries()) {
    const page = pages[index], section = page.locator('.pa-obsidian');
    await section.getByRole('button', { name: 'Check again', exact: true }).click();
    if (index === 1) await section.getByRole('button', { name: 'Remove Generated' }).waitFor();
    assert.equal(await section.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: `${dir}/native-after-40s-${width}.png` }); result.screenshots.push(`native-after-40s-${width}`);
  }
  result.openMs = Math.round(performance.now() - runningAt); assert.ok(result.openMs >= 40000 && result.dialogs === 0);
  await writeFile(`${dir}/native-ui.json`, JSON.stringify(result, null, 2) + '\n');
  console.log('NATIVE_UI_COMPLETE', result.openMs);
} finally { await Promise.all(pages.map(p => p.close())); await browser.close(); }
