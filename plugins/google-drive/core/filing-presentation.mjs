// Display labels only. These never decide file eligibility or authority.
const roles = new Map([['reader', 'Can view'], ['commenter', 'Can comment'], ['writer', 'Can edit'], ['owner', 'Owner']]);
const types = new Map([
  ['application/vnd.google-apps.document', 'Google Doc'],
  ['application/vnd.google-apps.spreadsheet', 'Google Sheet'],
  ['application/vnd.google-apps.presentation', 'Google Slides'],
  ['application/vnd.google-apps.folder', 'Folder'],
  ['application/pdf', 'PDF'],
]);
const access = new Map([['reader', 'viewing'], ['commenter', 'commenting'], ['writer', 'editing'], ['owner', 'ownership']]);
export const filingRoleLabel = role => roles.get(role) || role;
export const filingAccessLabel = role => access.get(role) || role;
export const filingAudienceLabel = p => p.type === 'anyone'
  ? (p.allowFileDiscovery ? 'Anyone (publicly searchable)' : 'Anyone with the link')
  : p.type === 'group' ? `Group ${p.emailAddress}` : p.type === 'domain' ? `Everyone at ${p.domain}` : p.emailAddress;
export const filingTypeLabel = mime => types.get(mime) || (typeof mime === 'string' && mime.startsWith('image/') ? 'Image' : 'File');
