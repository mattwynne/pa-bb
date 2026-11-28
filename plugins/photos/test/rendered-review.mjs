import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BB_REVIEW_BASE;
if (!base) throw new Error('Set BB_REVIEW_BASE to a running BB with Photos installed.');
const artifacts = process.env.BB_REVIEW_ARTIFACTS ?? '/tmp/photos-rendered-review';
const fixtureUrl = 'https://photos.example.test/mcp';
const photo = 'Café #1.png';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGKMAAAAASUVORK5CYII=', 'base64');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.BB_REVIEW_CHROME ? { executablePath: process.env.BB_REVIEW_CHROME } : {}) });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, acceptDownloads: true });
    const status = { apple: 'disconnected', grain: null };
    const listings = new Map();
    const tickets = new Map();
    let grainError = false;
    const dir = name => ({ name, directory: true, size: null });
    const file = name => ({ name, directory: false, size: png.length });
    await page.route('**/api/v1/plugins/photos/rpc/**', route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1);
      const request = route.request().postDataJSON();
      const input = request?.input ?? request;
      let result;
      if (method === 'status') result = status;
      else if (method === 'checkGrain') result = grainError ? { ok: false, error: 'Grain rejected the credentials.' } : { ok: true };
      else if (method === 'browse') {
        const { parent } = input;
        const current = parent ? listings.get(parent.listing) : [];
        assert.ok(current, JSON.stringify(input));
        const path = parent?.index === null ? current.slice(0, -1) : parent ? [...current, parent.index] : [];
        const entries = path.length === 0 ? [dir('Personal library')] : path.length === 1 ? [dir('Family album'), dir('Empty album')]
          : path.at(-1) === 0 ? [file(photo)] : [];
        const listing = randomUUID();
        listings.set(listing, path);
        result = { ok: true, listing, total: entries.length, entries };
      } else if (method === 'download') {
        const ticket = randomUUID(); tickets.set(ticket, input.mode);
        result = { ok: true, ticket };
      } else throw new Error(`Unexpected RPC ${method}`);
      return route.fulfill({ json: { ok: true, result } });
    });
    await page.route(/\/api\/v1\/plugins\/(?:photos\/http\/grain-[^/]+|icloud\/http\/photo-download)/, route => {
      const url = new URL(route.request().url());
      const method = url.pathname.split('/').at(-1);
      if (method === 'photo-download') {
        const mode = tickets.get(url.searchParams.get('ticket'));
        assert.ok(mode);
        return route.fulfill({ body: png, headers: mode === 'preview' ? { 'content-type': 'image/png' }
          : { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture.png"' } });
      }
      if (method === 'grain-connect') status.grain = fixtureUrl;
      else if (method === 'grain-disconnect') status.grain = null;
      else throw new Error(`Unexpected route ${method}`);
      return route.fulfill({ json: { ok: true, status } });
    });
    await page.goto(`${base}/plugins/photos?configure=photos`);
    const main = page.locator('.pa-photos');
    const apple = main.getByRole('region', { name: 'iCloud Photos' });
    const grain = main.getByRole('region', { name: 'Grain' });
    const link = apple.getByRole('link', { name: 'Open iCloud settings' });
    await link.waitFor();
    assert.equal(await link.getAttribute('href'), '/plugins/icloud?configure=icloud');
    assert.equal(await apple.locator('input').count(), 0);
    assert.equal(await main.evaluate(element => element.scrollWidth > element.clientWidth), false);
    await link.focus();
    await page.keyboard.press('Tab');
    const refresh = apple.getByRole('button', { name: 'Refresh connection' });
    assert.equal(await refresh.evaluate(el => el === document.activeElement), true);
    await page.screenshot({ path: `${artifacts}/setup-${width}.png` });
    status.apple = 'unavailable';
    await refresh.click();
    await apple.getByText('iCloud plugin required').waitFor();
    status.apple = 'shared';
    await refresh.click();
    await apple.getByRole('button', { name: 'Browse library' }).click();
    await apple.getByRole('button', { name: 'Open Personal library' }).click();
    await apple.getByRole('button', { name: 'Open Empty album' }).click();
    await apple.getByText('This location is empty.').waitFor();
    await apple.getByRole('button', { name: 'Up one level' }).click();
    await apple.getByRole('button', { name: 'Open Family album' }).click();
    const heading = apple.getByRole('heading', { name: 'Personal library / Family album' });
    await heading.waitFor();
    assert.equal(await heading.evaluate(el => el === document.activeElement), true);
    await apple.getByRole('button', { name: `Preview ${photo}` }).click();
    await apple.getByRole('img', { name: photo }).waitFor();
    await page.waitForFunction(() => document.querySelector('.pa-photos__preview img')?.naturalWidth === 1);
    const download = page.waitForEvent('download');
    await apple.getByRole('button', { name: `Download ${photo}` }).click();
    assert.ok((await download).suggestedFilename());
    await grain.getByLabel('MCP endpoint').fill(fixtureUrl);
    await grain.getByLabel('Access token (optional)').fill('fixture-token');
    await grain.getByRole('button', { name: 'Connect Grain' }).click();
    await grain.getByText('MCP verified', { exact: true }).waitFor();
    assert.equal(await main.evaluate(element => element.scrollWidth > element.clientWidth), false);
    await page.screenshot({ path: `${artifacts}/connected-${width}.png` });
    grainError = true;
    await grain.getByRole('button', { name: 'Check connection' }).click();
    await grain.getByRole('alert').getByText('Grain rejected the credentials.').waitFor();
    await grain.getByText('Manage Grain connection').click();
    await grain.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await grain.getByRole('button', { name: 'Connect Grain' }).waitFor();
    await page.close();
    console.log(`Photos at ${width}px: shared-session setup, keyboard, album browser, preview, download, Grain and recovery passed`);
  }
} finally { await browser.close(); }
