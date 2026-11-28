import type { PhotoIndex, PhotoMonth } from './contract.ts';

export const PAGE_SIZE = 100;
export const TILE_GAP = 3;

export function gridGeometry(width: number) {
  const columns = width < 500 ? 3 : width < 700 ? 4 : width < 900 ? 5 : width < 1120 ? 6 : 7;
  const tile = (width - (columns - 1) * TILE_GAP) / columns;
  return { columns, tile: Math.max(1, tile), stride: Math.max(1, tile) + TILE_GAP };
}

export function gridWindow(total: number, columns: number, stride: number, top: number, height: number) {
  const rows = Math.ceil(total / columns);
  const first = Math.min(rows, Math.floor(Math.max(0, top) / stride));
  const end = Math.min(rows, Math.ceil((Math.max(0, top) + height) / stride));
  const screen = Math.max(1, Math.ceil(height / stride));
  return {
    rows, first, end,
    start: Math.max(0, first - 2),
    stop: Math.min(rows, end + 2),
    ahead: Math.min(rows, end + 2 * screen),
    behind: Math.max(0, first - 2 * screen),
  };
}

/** Page starts in viewport order; a nearby date needs one bounded read even in a huge library. */
export function pageOffsets(start: number, end: number, total: number, backwards = false) {
  const offsets: number[] = [];
  const from = Math.max(0, start);
  const until = Math.min(end, total);
  if (from >= until) return offsets;
  for (let offset = Math.floor(from / PAGE_SIZE) * PAGE_SIZE; offset < until; offset += PAGE_SIZE) {
    offsets.push(offset);
  }
  return backwards ? offsets.reverse() : offsets;
}

export function monthAt(months: PhotoMonth[], offset: number) {
  let low = 0;
  let high = months.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (months[middle].offset <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

export function monthJump(month: PhotoMonth, columns: number, stride: number) {
  return Math.ceil(Math.floor(month.offset / columns) * stride);
}

export function indexProgress(index: PhotoIndex) {
  const count = index.indexed.toLocaleString();
  return 'Gathering your library · ' + (index.total && index.total >= index.indexed
    ? `${count} of ${index.total.toLocaleString()}`
    : count);
}

export function isGathering(index: PhotoIndex) {
  return index.state === 'empty' || index.state === 'indexing';
}

/** Poll serially, after each response, so a slow server cannot accumulate requests. */
export async function observeIndex(
  read: () => Promise<PhotoIndex>, publish: (index: PhotoIndex) => void, signal: AbortSignal,
  wait: (signal: AbortSignal) => Promise<void> = gentlePause,
) {
  while (!signal.aborted) {
    const index = await read();
    if (signal.aborted) return;
    publish(index);
    if (!isGathering(index)) return;
    await wait(signal);
  }
}

function gentlePause(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, 2000);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}
