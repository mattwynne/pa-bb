import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
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
    const status = { apple: 'disconnected', grain: null, group: null };
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
    await page.route(/\/api\/v1\/plugins\/(?:photos\/http\/(?:grain|group)-[^/]+|icloud\/http\/photo-download)/, route => {
      const url = new URL(route.request().url());
      const method = url.pathname.split('/').at(-1);
      if (method === 'photo-download') {
        const mode = tickets.get(url.searchParams.get('ticket'));
        assert.ok(mode);
        return route.fulfill({ body: png, headers: mode === 'preview' ? { 'content-type': 'image/png' }
          : { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture.png"' } });
      }
      if (method === 'grain-connect') status.grain = fixtureUrl;
      else if (method === 'group-save') status.group = route.request().postDataJSON();
      else if (method === 'group-clear') status.group = null;
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
    const sharing = main.getByRole('region', { name: 'Journal sharing' });
    await sharing.getByLabel('Group handle').fill('family.example.test');
    await sharing.getByRole('button', { name: 'Save group' }).click();
    await sharing.getByText('family.example.test').waitFor();
    assert.deepEqual(status.group, { handle: 'family.example.test', did: null });
    assert.equal(await main.evaluate(element => element.scrollWidth > element.clientWidth), false);
    await page.screenshot({ path: `${artifacts}/sharing-${width}.png`, fullPage: true });
    await page.close();
    console.log(`Photos at ${width}px: shared-session setup, keyboard, album browser, preview, download, Grain and recovery passed`);
  }

  // Journal, with generated photos. Nothing is posted: sharing is not connected yet.
  const crc = buffer => { let c, crc = ~0; for (const byte of buffer) { c = (crc ^ byte) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const picture = seed => {
    const [w, h] = [48, 36];
    const rows = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const at = y * (w * 3 + 1) + 1 + x * 3;
      rows[at] = (seed * 53 + y * 3) % 200 + 40; rows[at + 1] = (seed * 97 + x * 2) % 180 + 50; rows[at + 2] = (seed * 29 + x + y) % 160 + 70;
    }
    const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  };
  const names = Array.from({ length: 14 }, (_, index) => `2026-11-${String(20 + Math.floor(index / 5)).padStart(2, '0')} 1${index % 5}.00.00.png`);
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const status = { apple: 'disconnected', grain: fixtureUrl, group: { handle: 'family.example.test', did: null } };
    const listings = new Map();
    const tickets = new Map();
    let release = () => {};
    let hold = Promise.resolve();
    const tree = { '': ['PrimarySync'], PrimarySync: ['All Photos', 'Favorites', 'Hidden', 'Empty'], 'PrimarySync/All Photos': names, 'PrimarySync/Favorites': names.slice(0, 3), 'PrimarySync/Empty': [] };
    const entry = (path, name) => tree[[...path, name].join('/')] ? { name, directory: true, size: null } : { name, directory: false, size: picture(names.indexOf(name)).length };
    await page.route('**/api/v1/plugins/photos/rpc/**', async route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1);
      const input = route.request().postDataJSON();
      let result;
      if (method === 'status') result = status;
      else if (method === 'browse') {
        const path = input.parent ? [...listings.get(input.parent.listing), tree[listings.get(input.parent.listing).join('/')][input.parent.index]] : [];
        if (path.length === 2) await hold;
        const listing = randomUUID();
        listings.set(listing, path);
        const entries = tree[path.join('/')].map(name => entry(path, name));
        result = { ok: true, listing, total: entries.length, entries };
      } else if (method === 'page') result = { ok: true, entries: [] };
      else if (method === 'download') {
        const ticket = randomUUID();
        tickets.set(ticket, tree[listings.get(input.listing).join('/')][input.index]);
        result = { ok: true, ticket };
      } else throw new Error(`Unexpected RPC ${method}`);
      return route.fulfill({ json: { ok: true, result } });
    });
    await page.route(/\/api\/v1\/plugins\/icloud\/http\/photo-download/, route => {
      const name = tickets.get(new URL(route.request().url()).searchParams.get('ticket'));
      assert.ok(name);
      return route.fulfill({ body: picture(names.indexOf(name)), headers: { 'content-type': 'application/octet-stream' } });
    });
    await page.goto(`${base}/plugins/photos/journal`);
    const journal = page.locator('.pa-journal');
    await journal.getByText('Your photos will appear here').waitFor();
    assert.equal(await journal.getByRole('link', { name: 'Open iCloud settings' }).getAttribute('href'), '/plugins/icloud?configure=icloud');
    await page.screenshot({ path: `${artifacts}/journal-disconnected-${width}.png` });
    status.apple = 'shared';
    hold = new Promise(resolve => { release = resolve; });
    await journal.getByRole('button', { name: 'Try again' }).click();
    await journal.getByText('Opening your photos…').waitFor();
    await page.screenshot({ path: `${artifacts}/journal-loading-${width}.png` });
    release();
    await journal.getByText('14 photos', { exact: true }).waitFor();
    await journal.getByRole('heading', { name: 'Recent' }).waitFor();
    assert.equal(await journal.locator('.pa-journal__tile').count(), 14);
    assert.equal(await journal.getByRole('heading', { level: 2 }).count(), 3);
    assert.equal(await journal.evaluate(element => element.scrollWidth > element.clientWidth), false);
    await page.screenshot({ path: `${artifacts}/journal-${width}.png`, fullPage: true });
    const tiles = journal.locator('.pa-journal__tile');
    await tiles.nth(2).click();
    await tiles.nth(0).focus();
    await page.keyboard.press('Enter');
    assert.equal(await tiles.nth(2).getAttribute('aria-pressed'), 'true');
    assert.equal(await tiles.nth(2).textContent(), '1');
    assert.equal(await tiles.nth(0).textContent(), '2');
    const tray = journal.getByRole('region', { name: 'Selected photos' });
    await tray.getByText('2 photos').waitFor();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${artifacts}/journal-selected-${width}.png` });
    await tray.getByRole('button', { name: 'Make a gallery' }).click();
    const sheet = page.getByRole('dialog', { name: 'New gallery' });
    const title = sheet.getByLabel('Title');
    assert.equal(await title.evaluate(element => element === document.activeElement), true);
    await title.fill('Ä'.repeat(80));
    assert.equal(Buffer.byteLength(await title.inputValue()), 100);
    await title.fill('A quiet week');
    await sheet.getByText('Sharing with Family · private').waitFor();
    await page.screenshot({ path: `${artifacts}/journal-compose-${width}.png` });
    await sheet.getByRole('button', { name: 'Share with Family' }).click();
    await sheet.getByRole('status').getByText('Sharing isn’t connected yet').waitFor();
    await page.screenshot({ path: `${artifacts}/journal-share-${width}.png` });
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    await journal.getByRole('button', { name: 'Albums' }).click();
    await journal.getByRole('button', { name: 'Empty' }).click();
    await journal.getByText('There are no photos in this album yet.').waitFor();
    assert.equal(await journal.getByRole('button', { name: 'Hidden' }).count(), 0);
    await page.screenshot({ path: `${artifacts}/journal-empty-${width}.png` });
    await context.close();
    console.log(`Journal at ${width}px: disconnected, loading, days, keyboard selection, compose limits, unconnected sharing and empty album passed`);
  }
} finally { await browser.close(); }
