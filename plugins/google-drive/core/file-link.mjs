// Canonical links only; MIME is untrusted metadata, never a URL or a move allowlist.
export function fileLink(id, mimeType) {
  const encoded = encodeURIComponent(id);
  switch (mimeType) {
    case 'application/vnd.google-apps.folder': return `https://drive.google.com/drive/folders/${encoded}`;
    case 'application/vnd.google-apps.document': return `https://docs.google.com/document/d/${encoded}/edit`;
    case 'application/vnd.google-apps.spreadsheet': return `https://docs.google.com/spreadsheets/d/${encoded}/edit`;
    case 'application/vnd.google-apps.presentation': return `https://docs.google.com/presentation/d/${encoded}/edit`;
    default: return `https://drive.google.com/file/d/${encoded}/view`;
  }
}
