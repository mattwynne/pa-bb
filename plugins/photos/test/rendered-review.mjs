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
    page.setDefaultTimeout(60_000);
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
    await page.goto(`${base}/plugins/photos?configure=photos`, { waitUntil: 'domcontentloaded' });
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

  // A fixed synthetic catalogue with bounded metadata responses and generated
  // thumbnails. The test never contacts an Apple or Grain service.
  const crc = buffer => {
    let value = ~0;
    for (const byte of buffer) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return ~value >>> 0;
  };
  const chunk = (type, data) => {
    const output = Buffer.alloc(12 + data.length);
    output.writeUInt32BE(data.length);
    output.write(type, 4);
    data.copy(output, 8);
    output.writeUInt32BE(crc(output.subarray(4, 8 + data.length)), 8 + data.length);
    return output;
  };
  const palettes = [
    [[117, 147, 165], [226, 200, 161], [55, 73, 69], [30, 49, 53]],
    [[94, 114, 139], [216, 175, 159], [125, 93, 83], [79, 51, 59]],
    [[139, 155, 142], [209, 218, 184], [88, 101, 63], [43, 63, 59]],
    [[131, 161, 183], [226, 226, 203], [102, 120, 133], [52, 75, 95]],
    [[171, 150, 138], [246, 214, 170], [153, 103, 81], [100, 71, 57]],
    [[103, 129, 156], [175, 208, 209], [71, 112, 128], [38, 57, 72]],
    [[113, 142, 137], [200, 202, 164], [80, 103, 77], [36, 68, 69]],
  ];
  const picture = seed => {
    const [width, height] = [256, 192];
    const rows = Buffer.alloc((width * 3 + 1) * height);
    const palette = palettes[seed % palettes.length];
    const phase = seed * 1.393;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const ridge = .49 + .13 * Math.sin(3 * u + phase) + .08 * Math.sin(8 * u - phase) + .022 * Math.sin(23 * u + seed);
      const shore = .69 + .15 * Math.sin(2.4 * u - phase);
      for (let y = 0; y < height; y++) {
        const v = y / height;
        const at = y * (width * 3 + 1) + 1 + x * 3;
        const grain = ((Math.imul(x + 47 * seed + y, 374761393) ^ Math.imul(y + 1, 668265263)) >>> 19) % 13 - 6;
        const water = v > shore ? Math.sin(y * .75 + Math.sin(9 * u) * 1.4) * 3 : 0;
        const shade = v < ridge ? v / ridge : Math.min(1, (v - ridge) * 1.55);
        const [a, b] = v < ridge ? palette.slice(0, 2) : palette.slice(2);
        for (let c = 0; c < 3; c++) rows[at + c] = Math.round(a[c] * (1 - shade) + b[c] * shade + grain + water);
      }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = 8; header[9] = 2;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  };
  const pictures = Array.from({ length: 35 }, (_, i) => picture(i));
  const total = 10_000;
  const library = 'fixture-library';
  const monthStarts = Array.from({ length: total / 100 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 10 - i, 1));
    return { month: date.toISOString().slice(0, 7), offset: i * 100, count: 100 };
  });
  const timestamp = i => `${monthStarts[Math.floor(i / 100)].month}-${String(27 - Math.floor(i % 100 / 5)).padStart(2, '0')}T12:00:00Z`;
  const asset = i => ({ id: `photo-${i}`, created: timestamp(i), added: null,
    width: 4000, height: 3000, kind: i % 73 === 17 ? 'video' : 'photo', favorite: false,
    filename: `Fixture ${i}.jpg`, duration: i % 73 === 17 ? 67 : null,
    versions: { thumb: { width: 509, height: 339, bytes: 36_000, type: 'image/png' },
      ...(i % 73 === 17 ? { medium: { width: 720, height: 480, bytes: 9_000_000, type: 'video/quicktime' } }
        : { [i % 11 === 0 ? 'large' : 'medium']: { width: 720, height: 480, bytes: 68_000, type: 'image/png' } }) },
  });

  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 },
      colorScheme: width === 390 ? 'dark' : 'light', deviceScaleFactor: width === 390 ? 3 : 1, locale: 'en-US',
      reducedMotion: width === 390 ? 'reduce' : 'no-preference',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const status = { apple: 'disconnected', grain: fixtureUrl, group: { handle: 'family.example.test', did: null } };
    const pageCalls = [];
    const imageCalls = [];
    const issuedTickets = new Map();
    let indexCalls = 0;
    let ready = false;
    let albumError = true;
    await page.route('**/api/v1/plugins/photos/rpc/**', async route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1);
      const body = route.request().postDataJSON();
      const input = body?.input ?? body;
      let result;
      if (method === 'status') result = status;
      else if (method === 'photoLibraries') result = { ok: true, libraries: [{ id: library, name: 'Personal library', kind: 'personal' }] };
      else if (method === 'photoIndexStatus') {
        indexCalls++;
        result = { ok: true, state: ready ? 'ready' : 'indexing', total, indexed: ready ? total : 3200, updatedAt: null, error: null };
      } else if (method === 'photoAssets') {
        assert.equal(input.library, library);
        assert.equal(input.order, 'newest');
        assert.ok(input.limit <= 200);
        pageCalls.push(input.offset);
        if (input.album === 'family' && albumError) result = { ok: false, error: 'This album couldn’t be opened.' };
        else {
          const available = input.album === 'empty' ? 0 : input.album === 'family' ? 12 : ready ? total : 3_200;
          const length = Math.max(0, Math.min(input.limit, available - input.offset));
          result = { ok: true, total: input.album ? available : total,
            assets: Array.from({ length }, (_, i) => asset(input.offset + i)) };
        }
      } else if (method === 'photoMonths') {
        result = { ok: true, months: input.album ? [] : monthStarts.slice(0, ready ? 100 : 32) };
      } else if (method === 'photoAlbums') {
        result = { ok: true, albums: [
          { id: 'family', name: 'Family', parent: null, count: 12, kind: 'album' },
          { id: 'empty', name: 'Empty', parent: null, count: 0, kind: 'album' },
          { id: 'hidden', name: 'Hidden', parent: null, count: null, kind: 'smart' },
        ] };
      } else if (method === 'photoVersionTickets') {
        assert.ok(input.ids.length > 0 && input.ids.length <= 200);
        result = { ok: true, tickets: Object.fromEntries(input.ids.map(id => {
          const index = Number(id.split('-').at(-1));
          const version = width === 1280 || index % 73 === 17 ? 'thumb' : index % 11 === 0 ? 'large' : 'medium';
          assert.equal(input.version, version);
          const ticket = randomUUID();
          issuedTickets.set(ticket, index);
          return [id, ticket];
        })) };
      } else throw new Error(`Unexpected RPC ${method}`);
      return route.fulfill({ json: { ok: true, result } });
    });
    await page.route(/\/api\/v1\/plugins\/icloud\/http\/photo-version/, route => {
      const ticket = new URL(route.request().url()).searchParams.get('ticket');
      const id = issuedTickets.get(ticket);
      assert.ok(Number.isInteger(id) && id >= 0 && id < total);
      imageCalls.push(id);
      return route.fulfill({ body: pictures[(id * 13 + Math.floor(id / 31)) % pictures.length], contentType: 'image/png' });
    });
    await page.route(/\/api\/v1\/plugins\/icloud\/http\/photo-download/, () => assert.fail('Journal requested an original'));
    await page.goto(`${base}/plugins/photos/journal`, { waitUntil: 'domcontentloaded' });
    const journal = page.locator('.pa-journal');
    const tiles = journal.locator('.pa-journal__tile');
    const scroller = page.locator('.pa-journal__scroll');
    const capture = name => page.screenshot({ path: `${artifacts}/journal2-${name}-${width}.png`, animations: 'disabled' });
    const hasImage = index => page.waitForFunction(i => document.querySelector(`[data-photo-index="${i}"] img`)?.naturalWidth > 0, index);
    const fillVisible = () => page.waitForFunction(() => {
      const viewport = document.querySelector('.pa-journal__scroll').getBoundingClientRect();
      const visible = [...document.querySelectorAll('.pa-journal__tile')].filter(button => {
        const box = button.getBoundingClientRect();
        return box.bottom > viewport.top && box.top < viewport.bottom;
      });
      return visible.length > 10 && visible.every(button => button.querySelector('img')?.naturalWidth > 0);
    });
    await journal.getByText('Your photos will appear here').waitFor();
    assert.equal(await journal.getByRole('link', { name: 'Open iCloud settings' }).getAttribute('href'), '/plugins/icloud?configure=icloud');
    status.apple = 'shared';
    const started = await page.evaluate(() => performance.now());
    await journal.getByRole('button', { name: 'Try again' }).click();
    await journal.getByText('Gathering your library · 3,200 of 10,000').waitFor();
    const progress = journal.getByRole('progressbar');
    assert.equal(await progress.getAttribute('value'), '3200');
    await hasImage(0);
    const firstTiles = Math.round(await page.evaluate(from => performance.now() - from, started));
    await fillVisible();
    assert.equal(await journal.evaluate(element => element.scrollWidth > element.clientWidth), false);
    const initialHeight = await scroller.evaluate(element => element.scrollHeight);
    assert.ok(initialHeight > 200_000, `Expected full scroll height, got ${initialHeight}`);
    await capture('progress');

    const refreshed = page.waitForResponse(response => {
      const request = response.request();
      if (!new URL(request.url()).pathname.endsWith('/rpc/photoAssets')) return false;
      const body = request.postDataJSON();
      return (body?.input ?? body).offset === 0;
    });
    ready = true;
    await progress.waitFor({ state: 'hidden' });
    await journal.getByText('10,000 items', { exact: true }).waitFor();
    await refreshed;
    assert.ok(Math.abs(await scroller.evaluate(element => element.scrollHeight) - initialHeight) < 4);
    const settledCalls = indexCalls;
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight * .675; });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-photo-index]')].some(
      button => Number(button.dataset.photoIndex) > 6700 && button.querySelector('img')?.naturalWidth > 0));
    await fillVisible();
    const deep = await journal.evaluate(element => ({
      nodes: element.querySelectorAll('*').length,
      tiles: element.querySelectorAll('.pa-journal__tile').length,
      rows: element.querySelectorAll('.pa-journal__grid-row').length,
    }));
    assert.ok(deep.tiles < 100 && deep.nodes < 400);
    assert.ok(pageCalls.some(offset => offset >= 6600 && offset <= 6800));
    await capture('deep');

    const pick = journal.getByLabel('Jump to month');
    await pick.selectOption('87');
    await hasImage(8700);
    await fillVisible();
    const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${monthStarts[87].month}-01T12:00:00Z`));
    await journal.getByRole('heading', { name: monthName }).waitFor();
    const timeline = journal.getByRole('slider', { name: 'Scrub by month' });
    assert.equal(await timeline.getAttribute('aria-valuetext'), monthName);
    await journal.getByText('Tuesday 27', { exact: true }).waitFor();
    await timeline.focus();
    await timeline.press('ArrowDown');
    await hasImage(8800);
    await fillVisible();
    await capture('jump');
    await pick.selectOption('87');
    await hasImage(8700);

    const first = journal.locator('[data-photo-index="8700"]');
    const second = journal.locator('[data-photo-index="8701"]');
    await first.focus();
    await page.keyboard.press('Enter');
    assert.equal(await first.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('ArrowRight');
    assert.equal(await second.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Space');
    assert.equal(await first.textContent(), '1');
    assert.equal(await second.textContent(), '2');
    const tray = journal.getByRole('region', { name: 'Selected photos' });
    await tray.getByText('2 photos').waitFor();
    await capture('selected');
    await tray.getByRole('button', { name: 'Make a gallery' }).click();
    const sheet = page.getByRole('dialog', { name: 'New gallery' });
    const title = sheet.getByLabel('Title');
    assert.equal(await title.evaluate(element => element === document.activeElement), true);
    await title.fill('Ä'.repeat(80));
    assert.equal(Buffer.byteLength(await title.inputValue()), 100);
    await title.fill('A quiet week');
    const words = sheet.getByLabel('A few words');
    await words.fill('🌲'.repeat(300));
    assert.equal(Buffer.byteLength(await words.inputValue()), 1000);
    await words.fill('A few photographs from the road.');
    await sheet.getByText('Sharing with Family · private').waitFor();
    await capture('compose');
    await sheet.getByRole('button', { name: 'Share with Family' }).click();
    await sheet.getByRole('status').getByText('Sharing isn’t connected yet').waitFor();
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });

    // Sample an animated scroll under the same request interception. The
    // timing is a browser frame estimate, not a GPU/display trace.
    const frameStats = await scroller.evaluate(element => new Promise(resolve => {
      const deltas = [];
      let previous;
      const base = element.scrollTop;
      function frame(now) {
        if (previous !== undefined) deltas.push(now - previous);
        previous = now;
        element.scrollTop = base - deltas.length * 67;
        if (deltas.length < 90) requestAnimationFrame(frame);
        else resolve({ sampled: deltas.length, over25ms: deltas.filter(delta => delta > 25).length,
          worstMs: Math.round(Math.max(...deltas)), missed: deltas.reduce((sum, delta) => sum + Math.max(0, Math.round(delta / 16.67) - 1), 0) });
      }
      requestAnimationFrame(frame);
    }));
    assert.equal(indexCalls, settledCalls);

    await journal.getByRole('button', { name: 'Albums' }).click();
    assert.equal(await journal.getByRole('button', { name: 'Hidden' }).count(), 0);
    await journal.getByRole('button', { name: 'Family' }).click();
    await journal.getByRole('alert').getByText('This album couldn’t be opened.').waitFor();
    albumError = false;
    await journal.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
    await hasImage(0);
    assert.equal(await tiles.count(), 12);
    await journal.getByRole('button', { name: 'Albums' }).click();
    await journal.getByRole('button', { name: 'Empty' }).click();
    await journal.getByText('There are no photos in this album yet.').waitFor();
    await journal.getByRole('button', { name: 'Albums' }).click();
    await journal.getByRole('button', { name: 'All Photos' }).click();
    const beforeRevisit = imageCalls.filter(id => id === 0).length;
    await hasImage(0);
    assert.equal(imageCalls.filter(id => id === 0).length, beforeRevisit);
    await context.close();
    console.log(JSON.stringify({ width, firstTilesMs: firstTiles, deep, frameStats }));
  }
} finally { await browser.close(); }
