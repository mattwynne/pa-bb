import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, CSSProperties } from 'react';
import type { Asset, PhotoIndex, PhotoMonth, PhotoScope } from './contract.ts';
import { gridThumbnail, JournalError, thumbnailQueue, unwrap } from './journal-images.ts';
import type { PhotoRef, Rpc, ThumbnailQueue, ThumbnailRequest } from './journal-images.ts';
import { gridGeometry, gridWindow, isGathering, monthAt, monthJump, PAGE_SIZE, pageOffsets } from './journal-model.ts';

export type Selection = PhotoRef & { preview?: Blob };
export const photoIdentity = (photo: PhotoRef) => JSON.stringify([photo.library, photo.asset.id]);
const pageError = 'This part of your library couldn’t be opened.';

type Page = { assets: Asset[]; expected: number; error?: string };

class PhotoPages {
  private readonly pages = new Map<number, Page>();
  private readonly loading = new Set<number>();
  private offsets: number[] = [];
  private available: number | null = null;
  private snapshot = "";
  private disposed = false;
  total: number | null = null;
  version = 0;

  constructor(private readonly rpc: Rpc, private readonly scope: PhotoScope, private readonly publish: () => void) {}

  at(index: number) {
    return this.pages.get(Math.floor(index / PAGE_SIZE) * PAGE_SIZE)?.assets[index % PAGE_SIZE];
  }

  issue(offsets: number[]) {
    return offsets.map(offset => this.pages.get(offset)?.error).find(Boolean);
  }

  setTargets(offsets: number[], available: number | null, snapshot: string) {
    this.offsets = offsets;
    this.available = available;
    if (this.snapshot !== snapshot) {
      this.snapshot = snapshot;
      // The finished index can reorder records that arrived during the scan.
      // Keep painting the old pages while the viewport is checked again.
      for (const page of this.pages.values()) { page.expected = 0; page.error = undefined; }
    }
    const spare = [...this.pages.keys()].filter(offset => !offsets.includes(offset));
    for (const offset of spare.slice(0, Math.max(0, spare.length - 12))) this.pages.delete(offset);
    this.fillSlots();
  }

  retry() {
    for (const [offset, page] of this.pages) if (page.error) this.pages.delete(offset);
    this.changed();
    this.fillSlots();
  }

  dispose() { this.disposed = true; }

  private changed() { this.version++; this.publish(); }

  private fillSlots() {
    if (this.disposed) return;
    for (const offset of this.offsets) {
      if (this.loading.size >= 2) break;
      const expected = Math.min(PAGE_SIZE, (this.available ?? Infinity) - offset);
      const page = this.pages.get(offset);
      if (expected <= 0 || this.loading.has(offset) || page?.error || (page && page.expected >= expected)) continue;
      this.loading.add(offset);
      void this.read(offset, expected, this.snapshot);
    }
  }

  private async read(offset: number, expected: number, snapshot: string) {
    try {
      const result = unwrap(await this.rpc.call('photoAssets', { ...this.scope, limit: PAGE_SIZE, offset }));
      if (this.disposed || snapshot !== this.snapshot || !this.offsets.includes(offset)) return;
      this.total = result.total;
      this.pages.set(offset, { expected, assets: result.assets });
    } catch (error) {
      if (!this.disposed && snapshot === this.snapshot && this.offsets.includes(offset)) {
        this.pages.set(offset, { expected, assets: this.pages.get(offset)?.assets ?? [],
          error: error instanceof JournalError ? error.message : pageError });
      }
    } finally {
      this.loading.delete(offset);
      if (!this.disposed) {
        if (snapshot === this.snapshot && this.offsets.includes(offset)) this.changed();
        this.fillSlots();
      }
    }
  }
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' });
const dayNumber = new Intl.NumberFormat();
const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const captureFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' });
export function photoLabel(photo: PhotoRef) {
  const { created, filename, kind } = photo.asset;
  const time = created ? Date.parse(created) : NaN;
  const label = kind === 'video' ? 'Video' : 'Photo';
  return Number.isFinite(time) ? `${label} from ${captureFormatter.format(time)}` : filename || label;
}

function monthName(month: string) {
  return monthFormatter.format(new Date(`${month}-01T00:00:00Z`));
}

function Timeline({ months, active, onJump }: { months: PhotoMonth[]; active: number; onJump(index: number): void }) {
  if (months.length < 2) return null;
  return <aside className="pa-journal__timeline" aria-label="Photo timeline">
    <span aria-hidden="true">{months[0].month.slice(0, 4)}</span>
    <input type="range" min="0" max={months.length - 1} value={active} aria-label="Scrub by month"
      aria-valuetext={monthName(months[active].month)} onChange={event => onJump(event.currentTarget.valueAsNumber)} />
    <span aria-hidden="true">{months.at(-1)!.month.slice(0, 4)}</span>
  </aside>;
}

function MonthPicker({ months, active, onJump }: { months: PhotoMonth[]; active: number; onJump(index: number): void }) {
  const options = useMemo(() => {
    const years = new Map<string, [PhotoMonth, number][]>();
    months.forEach((month, index) => {
      const year = month.month.slice(0, 4);
      const group = years.get(year);
      if (group) group.push([month, index]);
      else years.set(year, [[month, index]]);
    });
    return [...years].map(([year, group]) => <optgroup key={year} label={year}>
      {group.map(([month, index]) => <option key={month.month} value={index}>{monthName(month.month)}</option>)}
    </optgroup>);
  }, [months]);
  if (months.length < 2) return null;
  return <label className="pa-journal__month-picker">
    <span aria-hidden="true">Jump to month</span>
    <select aria-label="Jump to month" value={active} onChange={event => onJump(Number(event.currentTarget.value))}>
      {options}
    </select>
  </label>;
}

export function JournalGrid({ rpc, library, album, index, selection, onToggle }: {
  rpc: Rpc; library: string; album: string | null; index: PhotoIndex;
  selection: Map<string, number>; onToggle(photo: Selection): void;
}) {
  const scope = useMemo<PhotoScope>(() => ({ library, album, order: 'newest' }), [library, album]);
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const lastTop = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const repaint = useRef(0);
  const focusRequest = useRef<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [measure, setMeasure] = useState({ width: 0, height: 0, ratio: 1 });
  const [position, setPosition] = useState({ top: 0, backwards: false, idle: true });
  const [jump, setJump] = useState<{ offset: number; row: number } | null>(null);
  const [months, setMonths] = useState<PhotoMonth[]>([]);
  const [monthFailed, setMonthFailed] = useState(false);
  const [monthRetry, setMonthRetry] = useState(0);
  const [data, setData] = useState<{ pages: PhotoPages; images: ThumbnailQueue }>();
  const [revision, setRevision] = useState(0);
  const { columns, tile, stride } = gridGeometry(measure.width);

  useEffect(() => {
    const publish = () => {
      if (repaint.current) return;
      repaint.current = requestAnimationFrame(() => { repaint.current = 0; setRevision(value => value + 1); });
    };
    const pages = new PhotoPages(rpc, scope, publish);
    const images = thumbnailQueue(rpc, publish);
    setData({ pages, images });
    return () => {
      pages.dispose(); images.dispose();
      cancelAnimationFrame(repaint.current); repaint.current = 0;
    };
  }, [rpc, scope]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = () => setMeasure({ width: element.clientWidth, height: element.clientHeight, ratio: devicePixelRatio || 1 });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, []);

  useEffect(() => () => { cancelAnimationFrame(frame.current); clearTimeout(idleTimer.current); }, []);

  const gathering = isGathering(index);
  const available = album ? data?.pages.total ?? null : index.state === 'ready' ? index.total ?? index.indexed : index.indexed;
  const total = album ? data?.pages.total ?? null : index.total ?? Math.max(data?.pages.total ?? 0, index.indexed);
  const showCount = Math.min(total ?? columns * 4, available ?? Infinity);
  const rendered = gridWindow(total ?? columns * 4, columns, stride, position.top, measure.height);
  const firstIndex = rendered.first * columns;
  const visibleEnd = Math.min(rendered.end * columns, showCount);
  const snapshot = album ? 'album' : index.state === 'ready' ? index.updatedAt ?? 'ready' : 'gathering';
  const monthGeneration = gathering ? Math.ceil(index.indexed / 500) : -1;

  useEffect(() => {
    if (monthGeneration === 0 && !scope.album) return;
    let active = true;
    void rpc.call('photoMonths', scope).then(reply => {
      if (!active) return;
      if (!reply.ok) { setMonthFailed(true); return; }
      setMonths([...reply.months].filter(month => month.count > 0).sort((a, b) => a.offset - b.offset));
      setMonthFailed(false);
    }).catch(() => { if (active) setMonthFailed(true); });
    return () => { active = false; };
  }, [rpc, scope, monthGeneration, monthRetry]);

  const visiblePages = pageOffsets(firstIndex, visibleEnd, showCount, position.backwards);
  // The index count can be unknown for an album. Open its first page to size the grid.
  const offsets = [...new Set([
    ...(total === null ? [0] : []), ...visiblePages,
    ...pageOffsets(rendered.start * columns, rendered.stop * columns, showCount, position.backwards),
    ...(focus === null ? [] : pageOffsets(focus, focus + 1, showCount)),
    ...(position.idle ? pageOffsets((position.backwards ? rendered.behind : rendered.end) * columns,
      (position.backwards ? rendered.first : rendered.ahead) * columns, showCount, position.backwards) : []),
  ])].join(',');
  useEffect(() => {
    data?.pages.setTargets(offsets ? offsets.split(',').map(Number) : [], available, snapshot);
  }, [data, offsets, available, snapshot]);

  const photoAt = (at: number): PhotoRef | null => {
    const asset = data?.pages.at(at);
    return asset ? { library, asset } : null;
  };
  const pixels = Math.ceil(tile * measure.ratio);
  const pageVersion = data?.pages.version;
  const requestAt = (at: number) => {
    const photo = photoAt(at);
    return photo ? gridThumbnail(photo, pixels) : null;
  };

  useEffect(() => {
    if (!data) return;
    const range = (start: number, end: number, reverse = false) => {
      const requests: ThumbnailRequest[] = [];
      for (let at = start; at < Math.min(end, showCount); at++) {
        const request = requestAt(at);
        if (request) requests.push(request);
      }
      return reverse ? requests.reverse() : requests;
    };
    const foreground = range(firstIndex, visibleEnd, position.backwards);
    let background: ThumbnailRequest[] = [];
    if (position.idle) {
      background = position.backwards
        ? [...range(rendered.behind * columns, firstIndex, true), ...range(visibleEnd, rendered.stop * columns)]
        : [...range(visibleEnd, rendered.ahead * columns), ...range(rendered.start * columns, firstIndex, true)];
    }
    data.images.setTargets(foreground, background);
  }, [data, pageVersion, library, pixels, columns, firstIndex, visibleEnd, showCount, position.backwards, position.idle,
    rendered.ahead, rendered.behind, rendered.start, rendered.stop]);

  useLayoutEffect(() => {
    if (focusRequest.current === null) return;
    const button = scroller.current?.querySelector<HTMLButtonElement>(`[data-photo-index="${focusRequest.current}"]`);
    if (button) { focusRequest.current = null; button.focus({ preventScroll: true }); }
  }, [revision, position.top, focus, columns]);

  function onScroll() {
    if (!scroller.current || frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const top = scroller.current?.scrollTop ?? lastTop.current;
      const backwards = top < lastTop.current;
      lastTop.current = top;
      // Quantize updates at row boundaries. The browser translates the rest
      // of the scroll without a React render or a synchronous layout read per tile.
      setJump(previous => previous && previous.row !== Math.floor(top / stride) ? null : previous);
      setPosition(previous => {
        const sameRows = Math.floor(previous.top / stride) === Math.floor(top / stride)
          && Math.ceil((previous.top + measure.height) / stride) === Math.ceil((top + measure.height) / stride);
        return sameRows && !previous.idle && previous.backwards === backwards ? previous : { top, backwards, idle: false };
      });
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setPosition(previous => ({ ...previous, idle: true })), 160);
    });
  }

  function jumpToMonth(choice: number) {
    const month = months[choice];
    if (!month || !scroller.current) return;
    scroller.current.scrollTop = monthJump(month, columns, stride);
    setJump({ offset: month.offset, row: Math.floor(scroller.current.scrollTop / stride) });
  }

  function onTileKey(event: KeyboardEvent<HTMLButtonElement>, at: number) {
    const destination = { ArrowUp: at - columns, ArrowDown: at + columns, ArrowLeft: at - 1, ArrowRight: at + 1,
      Home: event.ctrlKey || event.metaKey ? 0 : Math.floor(at / columns) * columns,
      End: event.ctrlKey || event.metaKey ? showCount - 1 : Math.ceil((at + 1) / columns) * columns - 1,
    }[event.key];
    const element = scroller.current;
    if (destination === undefined || !element) return;
    event.preventDefault();
    const next = Math.min(showCount - 1, Math.max(0, destination));
    const top = Math.floor(next / columns) * stride;
    if (top < element.scrollTop) element.scrollTop = top;
    if (top + tile > element.scrollTop + measure.height) element.scrollTop = Math.max(0, top + tile - measure.height);
    focusRequest.current = next;
    setFocus(next);
    const button = element.querySelector<HTMLButtonElement>(`[data-photo-index="${next}"]`);
    if (button) { focusRequest.current = null; button.focus({ preventScroll: true }); }
  }

  const displayedIndex = jump?.row === rendered.first ? jump.offset : firstIndex;
  const activeMonth = monthAt(months, displayedIndex);
  const activePhoto = photoAt(displayedIndex);
  const date = activePhoto?.asset.created;
  const capture = date ? Date.parse(date) : NaN;
  const dateKnown = Number.isFinite(capture);
  const month = dateKnown ? monthFormatter.format(capture)
    : !activePhoto && months[activeMonth] && displayedIndex < showCount ? monthName(months[activeMonth].month) : '';
  const day = dateKnown ? `${weekday.format(capture)} ${dayNumber.format(new Date(capture).getUTCDate())}`
    : activePhoto ? 'No capture date' : '';
  const issue = data?.pages.issue(total === null ? [0] : visiblePages);
  const imageIssue = !issue && Array.from({ length: Math.max(0, visibleEnd - firstIndex) }, (_, i) => requestAt(firstIndex + i))
    .some(request => request && data?.images.get(request.key) === null);
  const rows = Array.from({ length: rendered.stop - rendered.start }, (_, i) => rendered.start + i);
  if (focus !== null && focus < showCount) {
    const row = Math.floor(focus / columns);
    if (row < rendered.start || row >= rendered.stop) rows.push(row);
  }
  rows.sort((a, b) => a - b);
  const firstTab = focus !== null && photoAt(focus) ? focus : Array.from(
    { length: Math.max(0, visibleEnd - firstIndex) }, (_, i) => firstIndex + i).find(at => photoAt(at));

  return <section className="pa-journal__browser" aria-label={album ? 'Album photos' : 'Library photos'}>
    <div className="pa-journal__date-bar">
      <div>
        {month && <h2 className="pa-journal__serif">{month}</h2>}
        {day && <span className="pa-journal__date-day">{day}</span>}
        {!month && !day && gathering && firstIndex >= showCount && <span className="pa-journal__date-day">Gathering this part of your library…</span>}
        {!month && !day && total === null && !issue && <span className="pa-journal__date-day" role="status">Opening this album…</span>}
      </div>
      <MonthPicker months={months} active={activeMonth} onJump={jumpToMonth} />
    </div>
    {issue && <div className="pa-journal__notice" role="alert">{issue}
      <button className="pa-journal__quiet" type="button" onClick={() => data?.pages.retry()}>Try again</button>
    </div>}
    {monthFailed && <div className="pa-journal__notice" role="status">Dates couldn’t be loaded.
      <button className="pa-journal__quiet" type="button" onClick={() => setMonthRetry(value => value + 1)}>Reload dates</button>
    </div>}
    {imageIssue && <div className="pa-journal__notice pa-journal__preview-error" role="status">Some previews couldn’t load.
      <button className="pa-journal__quiet" type="button" onClick={() => data?.images.retry()}>Reload previews</button>
    </div>}
    {total === 0 && !gathering && !issue && <p className="pa-journal__quiet-text">{album ? 'There are no photos in this album yet.' : 'There are no photos in this library yet.'}</p>}
    <div className="pa-journal__grid-area">
      <div className="pa-journal__scroll" ref={scroller} onScroll={onScroll} onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) { focusRequest.current = null; setFocus(null); }
      }}>
        <div className="pa-journal__canvas" style={{
          height: rendered.rows ? (rendered.rows - 1) * stride + tile : 0, '--cols': columns, '--tile': `${tile}px`,
        } as CSSProperties}>
          {measure.width > 0 && rows.map(row => <div className="pa-journal__grid-row" key={row}
            style={{ transform: `translateY(${row * stride}px)` }}>
            {Array.from({ length: Math.min(columns, (total ?? columns * 4) - row * columns) }, (_, col) => {
              const at = row * columns + col;
              const photo = photoAt(at);
              if (!photo) return <span key={at} className="pa-journal__skeleton" aria-hidden="true" />;
              const request = requestAt(at);
              const thumbnail = request ? data?.images.get(request.key) : undefined;
              const order = selection.get(photoIdentity(photo)) ?? 0;
              const video = photo.asset.kind === 'video';
              const seconds = Math.floor(photo.asset.duration ?? 0);
              return <button type="button" className={`pa-journal__tile${order ? ' is-picked' : ''}`} key={at}
                aria-pressed={order > 0} aria-label={photoLabel(photo)} aria-disabled={video || undefined}
                data-photo-index={at} tabIndex={at === firstTab ? 0 : -1}
                onFocus={() => setFocus(at)} onKeyDown={event => onTileKey(event, at)}
                onClick={() => { if (!video) onToggle({ ...photo, preview: thumbnail?.blob }); }}>
                {thumbnail && <img src={thumbnail.url} alt="" decoding="async" draggable={false} />}
                {video && <span className="pa-journal__duration" aria-hidden="true">{seconds > 0 && `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</span>}
                {order > 0 && <span className="pa-journal__badge" aria-hidden="true">{order}</span>}
              </button>;
            })}
          </div>)}
        </div>
      </div>
      <Timeline months={months} active={activeMonth} onJump={jumpToMonth} />
    </div>
  </section>;
}
