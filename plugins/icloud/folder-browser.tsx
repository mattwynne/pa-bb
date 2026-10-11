import { experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';
import { ConnectionButton } from './connection-ui.js';
import { selectionStatus } from './folder-selection.js';
import type { SelectedFolder } from './folder-selection.js';
import type { CloudFolder } from './core/ports.ts';

export function FolderBrowser({ folders, trail, selected, busy, loading, onBrowse, onSelect, onClose }: {
  folders: readonly CloudFolder[]; trail: readonly CloudFolder[]; selected: readonly SelectedFolder[];
  busy: boolean; loading: boolean;
  onBrowse: (trail: CloudFolder[]) => void; onSelect: (folder: CloudFolder) => void; onClose: () => void;
}) {
  const current = trail.at(-1);
  const currentStatus = current ? selectionStatus(current, selected) : null;
  return <div className="pa-icloud__browser" aria-label="iCloud folder browser" aria-busy={busy}>
    <div className="pa-icloud__browser-toolbar">
      <ConnectionButton tone="secondary" className="pa-icloud__icon-button" disabled={busy || !current} aria-label="Back to parent folder" title="Back to parent folder" onClick={() => onBrowse(trail.slice(0, -1))}>
        <Icon name="ArrowLeft" className="pa-icloud__icon" aria-hidden />
      </ConnectionButton>
      <nav aria-label="Folder location" className="pa-icloud__breadcrumbs"><ol>
        <li>{current ? <button type="button" disabled={busy} onClick={() => onBrowse([])}>iCloud Drive</button> : <span aria-current="location">iCloud Drive</span>}</li>
        {trail.map((folder, index) => <li key={folder.id}><Icon name="ChevronRight" className="pa-icloud__icon" aria-hidden />
          {index === trail.length - 1 ? <span aria-current="location">{folder.name}</span> : <button type="button" disabled={busy} onClick={() => onBrowse(trail.slice(0, index + 1))}>{folder.name}</button>}
        </li>)}
      </ol></nav>
      <ConnectionButton tone="secondary" className="pa-icloud__icon-button" aria-label="Close folder browser" title="Close folder browser" onClick={onClose}>
        <Icon name="X" className="pa-icloud__icon" aria-hidden />
      </ConnectionButton>
    </div>
    <p className="pa-icloud__browser-help" role={busy ? 'status' : undefined}>{loading ? 'Loading folders…' : busy ? 'Folder actions will be available when the current operation finishes.' : 'Open a folder to browse inside, or select it to add to BB.'}</p>
    {folders.length ? <ul className="pa-icloud__folder-list">{folders.map(folder => {
      const status = selectionStatus(folder, selected);
      return <li key={folder.id} className="pa-icloud__folder-row">
        <button type="button" className="pa-icloud__folder-open" disabled={busy} aria-label={`Open ${folder.name}`} onClick={() => onBrowse([...trail, folder])}>
          <Icon name="Folder" className="pa-icloud__icon pa-icloud__folder-icon" aria-hidden />
          <span className="pa-icloud__folder-name">{folder.name}</span>
          <Icon name="ChevronRight" className="pa-icloud__icon pa-icloud__folder-chevron" aria-hidden />
        </button>
        {status ? <span className="pa-icloud__selection-status" aria-label={`${folder.name}: ${status}`}><Icon name="Check" className="pa-icloud__icon" aria-hidden />{status}</span>
          : <ConnectionButton tone="secondary" disabled={busy} aria-label={`Select ${folder.name}`} onClick={() => onSelect(folder)}><Icon name="Plus" className="pa-icloud__icon" aria-hidden />Select</ConnectionButton>}
      </li>;
    })}</ul> : <div className="pa-icloud__browser-empty"><Icon name="FolderOpen" className="pa-icloud__icon" aria-hidden /><p>{current ? currentStatus ? 'No child folders.' : 'No child folders. You can select this folder below.' : 'No folders found in iCloud Drive.'}</p></div>}
    {current && <div className="pa-icloud__browser-footer">
      <span className="pa-icloud__current-folder"><Icon name="FolderOpen" className="pa-icloud__icon" aria-hidden /><span>{current.name}</span></span>
      {currentStatus ? <span className="pa-icloud__selection-status" aria-label={`${current.name}: ${currentStatus}`}><Icon name="Check" className="pa-icloud__icon" aria-hidden />{currentStatus}</span>
        : <ConnectionButton tone="primary" disabled={busy} aria-label={`Select current folder ${current.name}`} onClick={() => onSelect(current)}><Icon name="Plus" className="pa-icloud__icon" aria-hidden />Select this folder</ConnectionButton>}
    </div>}
  </div>;
}
