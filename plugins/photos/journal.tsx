import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from 'motion/react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.ts';
import { Album, cachedThumbnail, imageType, JournalError, photoKey, thumbnail } from './journal-images.ts';
import type { PhotoRef } from './journal-images.ts';
import { byteLength, clampBytes, shareGallery, TITLE_LIMIT, WORDS_LIMIT } from './share.ts';
import './journal.css';

type Status = { apple: 'disconnected' | 'shared' | 'unavailable'; grain: string | null; group: { handle: string; did: string | null } | null };
type Photo = PhotoRef & { state: 'pending' | 'ready' | 'failed'; url?: string; date?: string | null };
type Section = { key: string; title: string; detail: string; photos: Photo[] };

const ALL_PHOTOS = 'All Photos';
const SKIPPED_ALBUMS = new Set(['Hidden', 'Recently Deleted', 'Videos', 'Slo-mo', 'Time-lapse']);
const BATCH = 60;
const DAY_SECTION = 4;
const MEMORY = 'pa-photos.journal';
const spring = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const;

type Memory = { album?: string; allPhotosSlow?: boolean };
function remembered(): Memory {
  try { return JSON.parse(localStorage.getItem(MEMORY) ?? '{}') ?? {}; } catch { return {}; }
}
function remember(change: Memory) {
  try { localStorage.setItem(MEMORY, JSON.stringify({ ...remembered(), ...change })); } catch { /* private mode */ }
}
const message = (error: unknown) => error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.';
const groupName = (handle: string) => handle.split('.')[0].replace(/^./, letter => letter.toUpperCase());

function day(value: string) {
  const [year, month, date] = value.slice(0, 10).split('-').map(Number);
  return new Date(year, month - 1, date);
}
function dayHeading(key: string): Pick<Section, 'title' | 'detail'> {
  const when = day(key);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const ago = Math.round((today.getTime() - when.getTime()) / 86_400_000);
  const short = when.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (ago === 0) return { title: 'Today', detail: short };
  if (ago === 1) return { title: 'Yesterday', detail: short };
  if (ago > 1 && ago < 7) return { title: when.toLocaleDateString(undefined, { weekday: 'long' }), detail: short };
  return {
    title: when.toLocaleDateString(undefined, { day: 'numeric', month: 'long', ...(when.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) }),
    detail: when.toLocaleDateString(undefined, { weekday: 'long' }),
  };
}
function monthHeading(key: string): Pick<Section, 'title' | 'detail'> {
  const when = day(`${key}-01`);
  const thisYear = when.getFullYear() === new Date().getFullYear();
  return { title: when.toLocaleDateString(undefined, { month: 'long', ...(thisYear ? {} : { year: 'numeric' }) }), detail: '' };
}
function photoLabel(photo: Photo) {
  if (!photo.date) return `Photo ${photo.name}`;
  const when = new Date(photo.date);
  return `Photo from ${when.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
function dateRange(photos: Photo[]) {
  const days = [...new Set(photos.map(photo => photo.date?.slice(0, 10)).filter((value): value is string => Boolean(value)))].sort();
  if (!days.length) return null;
  const format = (value: string) => day(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(day(value).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
  return days.length === 1 ? day(days[0]).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : `${format(days[0])} – ${format(days.at(-1)!)}`;
}

function LockIcon() {
  return <svg aria-hidden="true" viewBox="0 0 16 16" width="13" height="13"><rect x="3" y="7" width="10" height="7" rx="2" fill="currentColor" /><path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
}

function Tile({ photo, order, picking, featured, onToggle }: { photo: Photo; order: number; picking: boolean; featured: boolean; onToggle(): void }) {
  const [shown, setShown] = useState(false);
  return <motion.button layout="position" layoutId={photo.key} type="button" transition={spring}
    className={`pa-journal__tile${featured ? ' pa-journal__tile--featured' : ''}${order ? ' is-picked' : ''}${picking && !order ? ' is-dimmed' : ''}`}
    aria-pressed={order > 0} aria-label={photoLabel(photo)} onClick={onToggle}
    initial={{ opacity: 0 }} animate={{ opacity: 1, scale: order ? 0.94 : 1 }}>
    <img src={photo.url} alt="" decoding="async" draggable={false} className={shown ? 'is-shown' : ''} onLoad={() => setShown(true)} />
    <span className="pa-journal__badge" aria-hidden="true">{order || ''}</span>
  </motion.button>;
}

function Skeletons({ count }: { count: number }) {
  return <div className="pa-journal__grid" aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <span key={index} className="pa-journal__skeleton" style={{ animationDelay: `${(index % 12) * 90}ms` }} />)}
  </div>;
}

function Compose({ photos, group, title, words, setTitle, setWords, onClose }: {
  photos: Photo[]; group: Status['group']; title: string; words: string;
  setTitle(value: string): void; setWords(value: string): void; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const [cover, ...rest] = photos;
  const when = dateRange(photos);
  const titleLeft = TITLE_LIMIT - byteLength(title);
  const wordsLeft = WORDS_LIMIT - byteLength(words);
  const name = group ? groupName(group.handle) : null;

  async function share() {
    if (!title.trim()) { setNote('Add a title first.'); return; }
    setSending(true); setNote('');
    try {
      const result = await shareGallery({ title: title.trim(), words: words.trim(), photos });
      setNote(result.ok ? 'Shared.' : result.message);
    } catch (error) { setNote(message(error)); }
    finally { setSending(false); }
  }

  return <dialog ref={dialog} className="pa-journal__sheet" aria-labelledby="pa-journal-compose-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <motion.div className="pa-journal__sheet-body" initial={{ opacity: 0, y: 48, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={spring}>
      <h2 id="pa-journal-compose-title" className="pa-journal__sr">New gallery</h2>
      <figure className="pa-journal__cover"><img src={cover.url} alt={photoLabel(cover)} /></figure>
      {rest.length > 0 && <ul className="pa-journal__strip" aria-label="Other photos in this gallery">
        {rest.map(photo => <li key={photo.key}><img src={photo.url} alt={photoLabel(photo)} /></li>)}
      </ul>}
      <label className="pa-journal__field">
        <span>Title</span>
        <input className="pa-journal__title-input" value={title} placeholder="Give it a title" autoFocus
          onChange={event => setTitle(clampBytes(event.target.value, TITLE_LIMIT))} aria-describedby="pa-journal-title-left" />
        <small id="pa-journal-title-left" className="pa-journal__left" aria-live="polite">{titleLeft <= 20 ? titleLeft === 0 ? 'Title is full' : `${titleLeft} left` : ''}</small>
      </label>
      <label className="pa-journal__field">
        <span>A few words <em>(optional)</em></span>
        <textarea className="pa-journal__words" value={words} rows={3} placeholder="What caught your eye?"
          onChange={event => setWords(clampBytes(event.target.value, WORDS_LIMIT))} aria-describedby="pa-journal-words-left" />
        <small id="pa-journal-words-left" className="pa-journal__left" aria-live="polite">{wordsLeft <= 60 ? wordsLeft === 0 ? 'That’s the limit' : `${wordsLeft} left` : ''}</small>
      </label>
      <div className="pa-journal__chips">
        <span className="pa-journal__chip">{photos.length === 1 ? '1 photo' : `${photos.length} photos`}{when ? ` · ${when}` : ''}</span>
        {group ? <span className="pa-journal__chip pa-journal__chip--to" title={group.handle}><LockIcon /> Sharing with {name} · private</span>
          : <a className="pa-journal__chip pa-journal__chip--to" href="/plugins/photos?configure=photos">Choose a Grain group in Photos settings</a>}
      </div>
      {note && <p className="pa-journal__note" role="status">{note}</p>}
      <div className="pa-journal__sheet-actions">
        <button type="button" className="pa-journal__quiet" onClick={onClose}>Back</button>
        <button type="button" className="pa-journal__primary" disabled={sending || !group} onClick={() => void share()}>
          {sending ? 'Sharing…' : `Share with ${name ?? 'your group'}`}
        </button>
      </div>
    </motion.div>
  </dialog>;
}

export function JournalPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [failure, setFailure] = useState('');
  const [library, setLibrary] = useState<string | null>(null);
  const [albums, setAlbums] = useState<string[]>([]);
  const [albumsOpen, setAlbumsOpen] = useState(false);
  const [album, setAlbum] = useState<Album | null>(null);
  const [opening, setOpening] = useState<{ name: string; slow: boolean } | null>(null);
  const [notice, setNotice] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<Photo[]>([]);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState('');
  const [words, setWords] = useState('');
  const photosRef = useRef<Photo[]>([]);
  const generation = useRef(0);
  const pumping = useRef(-1);
  const cursor = useRef(-1);
  const abort = useRef(new AbortController());
  const urls = useRef(new Map<string, string>());
  const albumsRef = useRef<string[]>([]);

  function update(change: (current: Photo[]) => Photo[]) {
    photosRef.current = change(photosRef.current);
    setPhotos(photosRef.current);
  }
  function urlFor(key: string, blob: Blob) {
    let url = urls.current.get(key);
    if (!url) { url = URL.createObjectURL(blob); urls.current.set(key, url); }
    return url;
  }

  useEffect(() => () => {
    generation.current++;
    abort.current.abort();
    for (const url of urls.current.values()) URL.revokeObjectURL(url);
  }, []);

  // Load thumbnails one at a time, newest first: iCloud serves one photo at a time.
  async function pump() {
    const current = generation.current;
    if (pumping.current === current) return;
    pumping.current = current;
    const { signal } = abort.current;
    try {
      for (;;) {
        const next = photosRef.current.find(photo => photo.state === 'pending');
        if (!next || current !== generation.current) return;
        let patch: Partial<Photo>;
        try {
          const thumb = await thumbnail(next, signal);
          patch = { state: 'ready', url: urlFor(next.key, thumb.blob), date: thumb.date };
        } catch {
          if (signal.aborted) return;
          patch = { state: 'failed' };
        }
        if (current !== generation.current) return;
        update(list => list.map(photo => photo.key === next.key ? { ...photo, ...patch } : photo));
      }
    } finally { if (pumping.current === current) pumping.current = -1; }
  }

  async function earlier(target: Album, current: number) {
    const found: PhotoRef[] = [];
    while (found.length < BATCH && cursor.current >= 0) {
      const end = Math.max(0, cursor.current - 199);
      const entries = await target.range(cursor.current, end);
      if (current !== generation.current) return;
      cursor.current = end - 1;
      for (const { entry, index } of entries) {
        if (entry.directory || entry.size === null || !imageType(entry.name)) continue;
        found.push({ key: photoKey(entry.name, entry.size), name: entry.name, size: entry.size, index, album: target });
        if (found.length === BATCH) { cursor.current = index - 1; break; }
      }
    }
    const cached = await Promise.all(found.map(photo => cachedThumbnail(photo.key)));
    if (current !== generation.current) return;
    const known = new Set(photosRef.current.map(photo => photo.key));
    const added = found.map((photo, index): Photo => {
      const thumb = cached[index];
      return thumb ? { ...photo, state: 'ready', url: urlFor(photo.key, thumb.blob), date: thumb.date } : { ...photo, state: 'pending' };
    }).filter(photo => !known.has(photo.key));
    update(list => [...list, ...added]);
    setMore(cursor.current >= 0);
    void pump();
  }

  async function openAlbum(libraryName: string, name: string) {
    const current = ++generation.current;
    abort.current.abort();
    abort.current = new AbortController();
    update(() => []);
    setAlbum(null); setFailure(''); setMore(false); setAlbumsOpen(false);
    setOpening({ name, slow: false });
    const slow = setTimeout(() => { if (current === generation.current) setOpening({ name, slow: true }); }, 8000);
    const started = Date.now();
    try {
      const opened = await Album.open(rpc, [libraryName, name]);
      if (current !== generation.current) return;
      remember(name === ALL_PHOTOS ? { album: name, allPhotosSlow: false } : { album: name });
      setAlbum(opened);
      setOpening(null);
      cursor.current = opened.total - 1;
      await earlier(opened, current);
    } catch (error) {
      if (current !== generation.current) return;
      setOpening(null);
      if (name === ALL_PHOTOS && Date.now() - started > 55_000) {
        // BB stops waiting for iCloud after 75 s; very large libraries take longer to list.
        remember({ allPhotosSlow: true });
        const names = albumsRef.current;
        const fallback = names.includes('Favorites') ? 'Favorites' : names.find(item => item !== ALL_PHOTOS);
        setNotice(`All Photos is too large to open here yet${fallback ? `, so Journal is showing ${fallback}` : ''}. Choose another album below.`);
        if (fallback) { void openAlbum(libraryName, fallback); return; }
      }
      setFailure(error instanceof JournalError ? error.message : message(error));
    } finally { clearTimeout(slow); }
  }

  async function start() {
    setFailure(''); setNotice('');
    try {
      const next = await rpc.call('status', null);
      setStatus(next);
      if (next.apple !== 'shared') return;
      const root = await Album.open(rpc, []);
      const libraries = root.directories();
      const libraryName = libraries.includes('PrimarySync') ? 'PrimarySync' : libraries[0];
      if (!libraryName) { setFailure('No photo library was found in iCloud.'); return; }
      const libraryAlbum = await Album.open(rpc, [libraryName]);
      await libraryAlbum.range(libraryAlbum.total - 1, 0);
      const names = libraryAlbum.directories().filter(name => !SKIPPED_ALBUMS.has(name));
      setLibrary(libraryName);
      setAlbums(names);
      albumsRef.current = names;
      const memory = remembered();
      const first = memory.album && names.includes(memory.album) ? memory.album
        : names.includes(ALL_PHOTOS) && !memory.allPhotosSlow ? ALL_PHOTOS
          : names.includes('Favorites') ? 'Favorites' : names[0];
      if (first) await openAlbum(libraryName, first);
      else setFailure('Your library has no albums to show yet.');
    } catch (error) { setFailure(message(error)); }
  }
  useEffect(() => { void start(); }, []);

  const sections = useMemo(() => {
    const ready = photos.filter(photo => photo.state === 'ready');
    // A busy day gets its own heading; quieter days are gathered into their month.
    const dated = ready.filter(item => item.date).sort((a, b) => b.date!.localeCompare(a.date!));
    const perDay = new Map<string, number>();
    for (const photo of dated) perDay.set(photo.date!.slice(0, 10), (perDay.get(photo.date!.slice(0, 10)) ?? 0) + 1);
    const groups = new Map<string, Photo[]>();
    for (const photo of dated) {
      const key = perDay.get(photo.date!.slice(0, 10))! >= DAY_SECTION ? photo.date!.slice(0, 10) : photo.date!.slice(0, 7);
      groups.set(key, [...groups.get(key) ?? [], photo]);
    }
    const result: Section[] = [...groups].map(([key, items]) => ({ key, ...(key.length === 7 ? monthHeading(key) : dayHeading(key)), photos: items }));
    const undated = ready.filter(photo => !photo.date);
    if (undated.length) result.push({ key: 'undated', title: 'Without a date', detail: '', photos: undated });
    return result;
  }, [photos]);
  const pending = photos.filter(photo => photo.state === 'pending').length;
  const failed = photos.filter(photo => photo.state === 'failed').length;
  const order = new Map(selected.map((photo, index) => [photo.key, index + 1]));
  const picking = selected.length > 0;
  const heading = album ? album.name === ALL_PHOTOS ? 'Recent' : album.name : opening ? opening.name === ALL_PHOTOS ? 'Recent' : opening.name : 'Journal';

  function toggle(photo: Photo) {
    setSelected(list => list.some(item => item.key === photo.key) ? list.filter(item => item.key !== photo.key) : [...list, photo]);
  }

  if (status && status.apple !== 'shared') {
    return <div className="pa-journal"><div className="pa-journal__empty">
      <h1 className="pa-journal__serif">Your photos will appear here</h1>
      <p>{status.apple === 'disconnected'
        ? 'Journal uses the Apple account connected in iCloud settings. Sign in there, then come back.'
        : 'Journal needs the iCloud plugin. Enable or update it, then come back.'}</p>
      <div className="pa-journal__row">
        <a className="pa-journal__primary" href="/plugins/icloud?configure=icloud">Open iCloud settings</a>
        <button type="button" className="pa-journal__quiet" onClick={() => void start()}>Try again</button>
      </div>
    </div></div>;
  }

  return <MotionConfig reducedMotion="user">
    <div className={`pa-journal${picking ? ' is-picking' : ''}`}>
      <header className="pa-journal__header">
        <div>
          <h1 className="pa-journal__serif">{heading}</h1>
          <p className="pa-journal__meta" role="status">
            {!status || opening ? opening?.slow ? 'Large albums can take up to a minute to open…' : 'Opening your photos…'
              : album ? `${photos.length - failed} ${photos.length - failed === 1 ? 'photo' : 'photos'}${pending ? ` · ${pending} still arriving` : ''}` : ''}
          </p>
        </div>
        {photos.length > 0 && <p className="pa-journal__hint">{picking ? 'Tap again to remove' : 'Tap photos to start a gallery'}</p>}
      </header>

      {notice && <p className="pa-journal__notice" role="status">{notice}</p>}
      {failure && <div className="pa-journal__notice pa-journal__notice--problem" role="alert">
        <span>{failure}</span>
        <button type="button" className="pa-journal__quiet" onClick={() => void (library && (album || opening) ? openAlbum(library, (album ?? opening)!.name) : start())}>Try again</button>
      </div>}

      {(!status || opening) && <Skeletons count={18} />}
      {album && !opening && photos.length === 0 && !failure && <p className="pa-journal__quiet-text">There are no photos in this album yet.</p>}

      <LayoutGroup>
        {sections.map(section => <section key={section.key} className="pa-journal__day" aria-labelledby={`pa-journal-day-${section.key}`}>
          <div className="pa-journal__day-heading">
            <h2 id={`pa-journal-day-${section.key}`} className="pa-journal__serif">{section.title}</h2>
            {section.detail && <span>{section.detail}</span>}
          </div>
          <div className="pa-journal__grid">
            {section.photos.map((photo, index) => <Tile key={photo.key} photo={photo} order={order.get(photo.key) ?? 0} picking={picking}
              featured={index === 0 && section.photos.length >= 7} onToggle={() => toggle(photo)} />)}
          </div>
        </section>)}
      </LayoutGroup>
      {pending > 0 && <Skeletons count={Math.min(pending, 24)} />}
      {failed > 0 && pending === 0 && <p className="pa-journal__quiet-text">{failed === 1 ? '1 photo' : `${failed} photos`} couldn’t be shown here.</p>}

      {library && <nav className="pa-journal__older" aria-label="Go further back">
        {more && <button type="button" className="pa-journal__pill" disabled={pending > 0}
          onClick={() => album && void earlier(album, generation.current)}>Show earlier photos</button>}
        <button type="button" className="pa-journal__pill" aria-expanded={albumsOpen} aria-controls="pa-journal-albums"
          onClick={() => setAlbumsOpen(open => !open)}>Albums</button>
      </nav>}
      <AnimatePresence>
        {albumsOpen && library && <motion.ul id="pa-journal-albums" className="pa-journal__albums" aria-label="Albums"
          initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={spring}>
          {albums.map(name => <li key={name}>
            <button type="button" className="pa-journal__pill" aria-current={album?.name === name ? 'true' : undefined}
              onClick={() => { setNotice(''); void openAlbum(library, name); }}>{name === ALL_PHOTOS ? 'All Photos (recent)' : name}</button>
          </li>)}
        </motion.ul>}
      </AnimatePresence>

      <AnimatePresence>
        {picking && <motion.div className="pa-journal__tray" role="region" aria-label="Selected photos"
          initial={{ opacity: 0, y: 72 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 72 }} transition={spring}>
          <span className="pa-journal__tray-thumbs" aria-hidden="true">
            {selected.slice(0, 4).map(photo => <img key={photo.key} src={photo.url} alt="" />)}
          </span>
          <span className="pa-journal__tray-count">{selected.length === 1 ? '1 photo' : `${selected.length} photos`}</span>
          <button type="button" className="pa-journal__tray-clear" onClick={() => setSelected([])}>Clear</button>
          <button type="button" className="pa-journal__tray-make" onClick={() => setComposing(true)}>Make a gallery</button>
        </motion.div>}
      </AnimatePresence>

      {composing && selected.length > 0 && <Compose photos={selected} group={status?.group ?? null} title={title} words={words}
        setTitle={setTitle} setWords={setWords} onClose={() => setComposing(false)} />}
    </div>
  </MotionConfig>;
}
