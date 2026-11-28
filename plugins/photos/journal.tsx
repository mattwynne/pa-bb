import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { z } from 'zod';
import { JournalGrid, photoIdentity, photoLabel } from './journal-grid.tsx';
import type { Selection } from './journal-grid.tsx';
import { JournalError, unwrap } from './journal-images.ts';
import type { Rpc } from './journal-images.ts';
import type { PhotoAlbum, PhotoIndex, rpcContract } from './contract.ts';
import { indexProgress, isGathering, observeIndex } from './journal-model.ts';
import { byteLength, clampBytes, shareGallery, TITLE_LIMIT, WORDS_LIMIT } from './share.ts';
import './journal.css';

type Status = z.infer<typeof rpcContract.status.output>;
type Library = { id: string; name: string; kind: 'personal' | 'shared' };
const spring = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const;
const settingsLink = '/plugins/icloud?configure=icloud';
const groupName = (handle: string) => handle.split('.')[0].replace(/^./, letter => letter.toUpperCase());

function dateRange(photos: Selection[]) {
  const days = photos.flatMap(({ asset }) => asset.created && Number.isFinite(Date.parse(asset.created))
    ? [asset.created.slice(0, 10)] : []).sort();
  if (!days.length) return null;
  const first = new Date(days[0]);
  const last = new Date(days.at(-1)!);
  const format = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return format.formatRange(first, last);
}

function LockIcon() {
  return <svg aria-hidden="true" viewBox="0 0 16 16" width="13" height="13"><rect x="3" y="7" width="10" height="7" rx="2" fill="currentColor" /><path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
}

function Preview({ photo, decorative = false }: { photo: Selection; decorative?: boolean }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!photo.preview) { setUrl(undefined); return; }
    const url = URL.createObjectURL(photo.preview);
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo.preview]);
  return url ? <img src={url} alt={decorative ? '' : photoLabel(photo)} decoding="async" />
    : <span className="pa-journal__preview-placeholder" role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : photoLabel(photo)} />;
}

function Compose({ photos, group, title, words, setTitle, setWords, onClose }: {
  photos: Selection[]; group: Status['group']; title: string; words: string;
  setTitle(value: string): void; setWords(value: string): void; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [sending, setSending] = useState(false);
  const reducedMotion = useReducedMotion();
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
    } catch (error) { setNote(error instanceof JournalError ? error.message : "The gallery couldn’t be shared."); }
    finally { setSending(false); }
  }

  return <dialog ref={dialog} className="pa-journal__sheet" aria-labelledby="pa-journal-compose-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <motion.div className="pa-journal__sheet-body" initial={reducedMotion ? false : { opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
      <h2 id="pa-journal-compose-title" className="pa-journal__sr">New gallery</h2>
      <figure className="pa-journal__cover"><Preview photo={cover} /></figure>
      {rest.length > 0 && <ul className="pa-journal__strip" aria-label="Other photos in this gallery">
        {rest.map(photo => <li key={photoIdentity(photo)}><Preview photo={photo} /></li>)}
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

function Albums({ rpc, library, onOpen }: { rpc: Rpc; library: string; onOpen(album: PhotoAlbum): void }) {
  const [albums, setAlbums] = useState<PhotoAlbum[] | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setFailure('');
    void rpc.call('photoAlbums', { library }).then(reply => {
      if (active) setAlbums(unwrap(reply).albums.filter(album => album.kind !== 'smart' || !['Hidden', 'Recently Deleted'].includes(album.name)));
    }).catch(error => { if (active) setFailure(error instanceof JournalError ? error.message : 'Albums couldn’t be opened.'); });
    return () => { active = false; };
  }, [rpc, library, retry]);
  const folder = albums?.find(album => album.id === parent);
  const folders = new Set(albums?.filter(album => album.kind === 'folder').map(album => album.id));
  const visible = albums?.filter(album => (album.parent && folders.has(album.parent) ? album.parent : null) === parent);
  return <section className="pa-journal__album-view" aria-label="Albums">
    {folder && <div className="pa-journal__album-heading">
      <button className="pa-journal__quiet" type="button" onClick={() => setParent(folder.parent && folders.has(folder.parent) ? folder.parent : null)}>‹ Back</button>
      <h2 className="pa-journal__serif">{folder.name}</h2>
    </div>}
    {failure && <div className="pa-journal__notice" role="alert">{failure}
      <button className="pa-journal__quiet" type="button" onClick={() => setRetry(value => value + 1)}>Try again</button>
    </div>}
    {!albums && !failure && <p className="pa-journal__quiet-text" role="status">Opening your albums…</p>}
    {visible?.length === 0 && <p className="pa-journal__quiet-text">There are no albums here yet.</p>}
    {!!visible?.length && <ul className="pa-journal__albums">
      {visible.map(album => <li key={album.id}>
        <button type="button" className="pa-journal__album" onClick={() => album.kind === 'folder' ? setParent(album.id) : onOpen(album)}>
          <span className="pa-journal__serif">{album.name}</span>
          <span className="pa-journal__album-detail">{album.kind === 'folder' ? 'Folder'
            : album.count === null ? '' : album.count.toLocaleString() + (album.count === 1 ? ' item' : ' items')}</span>
        </button>
      </li>)}
    </ul>}
  </section>;
}

function LibraryView({ rpc, library, libraries, onLibrary, group }: {
  rpc: Rpc; library: Library; libraries: Library[]; onLibrary(id: string): void; group: Status['group'];
}) {
  const [index, setIndex] = useState<PhotoIndex | null>(null);
  const [failure, setFailure] = useState('');
  const [retry, setRetry] = useState(0);
  const [album, setAlbum] = useState<PhotoAlbum | null>(null);
  const [albumsOpen, setAlbumsOpen] = useState(false);
  const [selected, setSelected] = useState<Selection[]>([]);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState('');
  const [words, setWords] = useState('');
  const reducedMotion = useReducedMotion();
  const order = useMemo(() => new Map(selected.map((photo, index) => [photoIdentity(photo), index + 1])), [selected]);

  useEffect(() => {
    const controller = new AbortController();
    setFailure('');
    void observeIndex(async () => unwrap(await rpc.call('photoIndexStatus', { library: library.id })), setIndex, controller.signal)
      .catch(error => {
        if (!controller.signal.aborted) setFailure(error instanceof JournalError ? error.message : 'Your library couldn’t be opened.');
      });
    return () => controller.abort();
  }, [rpc, library.id, retry]);

  function toggle(photo: Selection) {
    const id = photoIdentity(photo);
    setSelected(list => list.some(item => photoIdentity(item) === id)
      ? list.filter(item => photoIdentity(item) !== id) : [...list, photo]);
  }

  const gathering = index && isGathering(index) && !index.updatedAt;
  const error = failure || (index?.state === 'error' ? index.error ?? 'Your library couldn’t be gathered.' : '');
  const heading = albumsOpen ? 'Albums' : album?.name ?? 'All Photos';
  const count = albumsOpen ? null : album ? album.count : index?.total;

  return <>
    <header className="pa-journal__header">
      <div>
        <h1 className="pa-journal__serif">{heading}</h1>
        {count != null && !gathering && <p className="pa-journal__meta">{count.toLocaleString()} {count === 1 ? 'item' : 'items'}</p>}
      </div>
      <div className="pa-journal__actions">
        {libraries.length > 1 && <label className="pa-journal__library-picker">
          <span className="pa-journal__sr">Photo library</span>
          <select value={library.id} onChange={event => onLibrary(event.currentTarget.value)}>
            {libraries.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>}
        <button className="pa-journal__pill" type="button" aria-pressed={albumsOpen} onClick={() => {
          if (albumsOpen) setAlbum(null);
          setAlbumsOpen(open => !open);
        }}>{albumsOpen ? 'All Photos' : 'Albums'}</button>
      </div>
    </header>

    {!index && !error && <p className="pa-journal__quiet-text" role="status">Opening your photos…</p>}
    {gathering && !error && <div className="pa-journal__progress">
      <span id="pa-journal-index-label" role="status">{indexProgress(index)}</span>
      <progress aria-labelledby="pa-journal-index-label" max={index.total || undefined}
        value={index.total ? Math.min(index.indexed, index.total) : undefined} />
    </div>}
    {error && <div className="pa-journal__notice" role="alert">
      <span>{error}</span>
      <div className="pa-journal__actions">
        <a className="pa-journal__quiet" href={settingsLink}>iCloud settings</a>
        <button type="button" className="pa-journal__quiet" onClick={() => setRetry(value => value + 1)}>Try again</button>
      </div>
    </div>}
    {albumsOpen ? <Albums rpc={rpc} library={library.id} onOpen={next => { setAlbum(next); setAlbumsOpen(false); }} />
      : index && (index.state !== 'error' || index.indexed > 0) && <JournalGrid key={album ? `album:${album.id}` : 'all'}
        rpc={rpc} library={library.id} album={album?.id ?? null} index={index} selection={order} onToggle={toggle} />}

    <AnimatePresence>
      {selected.length > 0 && <motion.div className="pa-journal__tray" role="region" aria-label="Selected photos"
        initial={reducedMotion ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        exit={reducedMotion ? undefined : { opacity: 0, y: 16 }} transition={spring}>
        <span className="pa-journal__tray-thumbs" aria-hidden="true">
          {selected.slice(0, 4).map(photo => <Preview key={photoIdentity(photo)} photo={photo} decorative />)}
        </span>
        <span className="pa-journal__tray-count">{selected.length.toLocaleString()} {selected.length === 1 ? 'photo' : 'photos'}</span>
        <button type="button" className="pa-journal__tray-clear" onClick={() => setSelected([])}>Clear</button>
        <button type="button" className="pa-journal__tray-make" onClick={() => setComposing(true)}>Make a gallery</button>
      </motion.div>}
    </AnimatePresence>

    {composing && selected.length > 0 && <Compose photos={selected} group={group} title={title} words={words}
      setTitle={setTitle} setWords={setWords} onClose={() => setComposing(false)} />}
  </>;
}

export function JournalPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [libraryId, setLibraryId] = useState('');
  const [failure, setFailure] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setFailure('');
    void (async () => {
      try {
        const next = await rpc.call('status', null);
        if (!active) return;
        setStatus(next);
        if (next.apple !== 'shared') return;
        const result = unwrap(await rpc.call('photoLibraries', null));
        if (!active) return;
        setLibraries(result.libraries);
        setLibraryId((result.libraries.find(library => library.kind === 'personal') ?? result.libraries[0])?.id ?? '');
      } catch (error) {
        if (active) setFailure(error instanceof JournalError ? error.message : 'Your photo libraries couldn’t be opened.');
      }
    })();
    return () => { active = false; };
  }, [rpc, retry]);

  const library = libraries?.find(item => item.id === libraryId);
  if (library) return <MotionConfig reducedMotion="user">
    <div className="pa-journal"><LibraryView key={library.id} rpc={rpc} library={library} libraries={libraries!}
      onLibrary={setLibraryId} group={status?.group ?? null} /></div>
  </MotionConfig>;

  const configured = status?.apple === 'shared';
  const showRecovery = !!failure || !!status && !configured || libraries?.length === 0;
  return <div className="pa-journal"><div className="pa-journal__empty">
    <h1 className="pa-journal__serif">{showRecovery ? 'Your photos will appear here' : 'All Photos'}</h1>
    <p role={failure ? 'alert' : 'status'}>{failure || (status?.apple === 'disconnected'
      ? 'Connect your Apple account in iCloud settings.'
      : status?.apple === 'unavailable' ? 'Enable or update the iCloud plugin in Settings.'
        : libraries?.length === 0 ? 'No photo library was found in iCloud.' : 'Opening your photos…')}</p>
    {showRecovery && <div className="pa-journal__row">
      <a className="pa-journal__primary" href={settingsLink}>Open iCloud settings</a>
      <button type="button" className="pa-journal__quiet" onClick={() => setRetry(value => value + 1)}>Try again</button>
    </div>}
  </div></div>;
}
