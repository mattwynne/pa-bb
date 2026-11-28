import { CloudError } from '../core/ports.ts';
import type { PhotoAsset, PhotoVersion, PhotoVersionMetadata } from '../core/photos-contract.ts';

export type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
export const recordId = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
export const whole = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export const flag = (value: unknown) => value === true || value === 1;
export const field = (row: ObjectValue, name: string) => object(object(row.fields)[name]).value;
function date(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return date.getUTCFullYear() >= 0 && date.getUTCFullYear() <= 9999 ? date.toISOString() : null;
}
export function decodedName(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const name = Buffer.from(value, 'base64').toString('utf8').normalize('NFC');
  return name && !name.includes('\u0000') ? name : null;
}

const resourcePrefixes = [
  'resOriginal', 'resOriginalVidCompl', 'resJPEGThumb', 'resJPEGMed', 'resJPEGLarge', 'resJPEGFull',
  'resVidSmall', 'resVidMed', 'resVidFull',
] as const;
type Prefix = typeof resourcePrefixes[number];
type ResourceKey = `${Prefix}Res`;
export type Resource = { record: string; key: ResourceKey; metadata: PhotoVersionMetadata };
export type VersionSet = Partial<Record<PhotoVersion, Resource>>;

export const photoKeys = [
  'masterRef', 'assetDate', 'addedDate', 'duration', 'orientation', 'originalOrientation', 'isFavorite', 'isHidden',
  'isDeleted', 'isExpunged', 'assetSubtype', 'assetSubtypeV2', 'filenameEnc', 'itemType',
  ...resourcePrefixes.flatMap(prefix => [`${prefix}Res`, `${prefix}Width`, `${prefix}Height`, `${prefix}FileType`, `${prefix}FileSize`]),
];

type Resources = Partial<Record<Prefix, Resource>>;
export type AssetRecord = {
  id: string; master: string; created: string | null; added: string | null; duration: number | null;
  orientation: number | null; favorite: boolean; live: boolean; resources: Resources;
};
export type MasterRecord = { id: string; filename: string | null; video: boolean; orientation: number | null; resources: Resources };
export type Projection = { assets: AssetRecord[]; masters: MasterRecord[]; deletedAssets: string[]; deletedMasters: string[]; deletedUnknown: string[] };
export type RememberUrl = (record: string, key: string, url: unknown) => void;

const mimeTypes: Readonly<Record<string, string>> = {
  'public.jpeg': 'image/jpeg', 'public.png': 'image/png', 'public.heic': 'image/heic', 'public.heif': 'image/heif',
  'public.tiff': 'image/tiff', 'com.compuserve.gif': 'image/gif', 'org.webmproject.webp': 'image/webp',
  'public.avif': 'image/avif', 'public.mpeg-4': 'video/mp4', 'com.apple.quicktime-movie': 'video/quicktime',
  'public.mpeg': 'video/mpeg', 'public.avi': 'video/x-msvideo', 'public.3gpp': 'video/3gpp',
};
export const mediaMime = (type: unknown): string | null => {
  if (typeof type !== 'string') return null;
  return /^((image|video)\/[a-z0-9][a-z0-9.+_-]{0,63})$/i.test(type) && type.toLowerCase() !== 'image/svg+xml'
    ? type.toLowerCase() : Object.hasOwn(mimeTypes, type) ? mimeTypes[type] : null;
};

function projectResources(row: ObjectValue, id: string, remember?: RememberUrl): Resources {
  const result: Resources = {};
  for (const prefix of resourcePrefixes) {
    const key = `${prefix}Res` as const;
    const blob = object(field(row, key));
    // A projected resource can lack a URL. Its record and field still allow lookups.
    if (!Object.keys(blob).length) continue;
    const uti = field(row, `${prefix}FileType`);
    const type = mediaMime(uti) ?? (typeof uti === 'string' && /^[a-z\d.-]{1,128}$/i.test(uti) ? uti : null);
    result[prefix] = { record: id, key, metadata: {
      width: whole(field(row, `${prefix}Width`)), height: whole(field(row, `${prefix}Height`)),
      bytes: whole(blob.size) ?? whole(field(row, `${prefix}FileSize`)), type,
    } };
    remember?.(id, key, blob.downloadURL);
  }
  return result;
}

export function projectRecords(rows: ObjectValue[], remember?: RememberUrl, previousMaster?: (id: string) => string | null): Projection {
  const result: Projection = { assets: [], masters: [], deletedAssets: [], deletedMasters: [], deletedUnknown: [] };
  for (const row of rows) {
    const id = recordId(row.recordName);
    const type = row.recordType;
    const deleted = flag(row.deleted);
    if (!id && (deleted || type === 'CPLAsset' || type === 'CPLMaster')) throw new CloudError('provider_rejected');
    if (!id) continue;
    if (deleted) {
      if (type === 'CPLAsset') result.deletedAssets.push(id);
      else if (type === 'CPLMaster') result.deletedMasters.push(id);
      else if (type === undefined) result.deletedUnknown.push(id);
      continue;
    }
    if (type === 'CPLMaster') {
      const resources = projectResources(row, id, remember);
      const itemType = field(row, 'itemType');
      const originalType = resources.resOriginal?.metadata.type;
      const video = /^(video\/|public\.movie$)/i.test(originalType ?? '') || /^(video\/|public\.movie$)/i.test(mediaMime(itemType) ?? String(itemType ?? ''));
      result.masters.push({ id, filename: decodedName(field(row, 'filenameEnc')), video: video || !!resources.resVidFull,
        orientation: whole(field(row, 'originalOrientation')), resources });
    }
    if (type !== 'CPLAsset') continue;
    if (['isHidden', 'isDeleted', 'isExpunged'].some(key => flag(field(row, key)))) {
      result.deletedAssets.push(id);
      continue;
    }
    const master = recordId(object(field(row, 'masterRef')).recordName) ?? previousMaster?.(id);
    if (!master) throw new CloudError('provider_rejected');
    const duration = field(row, 'duration');
    result.assets.push({ id, master, created: date(field(row, 'assetDate')), added: date(field(row, 'addedDate')),
      duration: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null,
      orientation: whole(field(row, 'orientation')), favorite: flag(field(row, 'isFavorite')),
      live: field(row, 'assetSubtypeV2') === 2, resources: projectResources(row, id, remember) });
  }
  return result;
}

export function materialize(asset: AssetRecord, master: MasterRecord | null) {
  const resources = { ...master?.resources, ...asset.resources };
  const kind = master?.video || asset.resources.resVidFull ? 'video'
    : asset.live || resources.resOriginalVidCompl ? 'live' : 'photo';
  const original = master?.resources.resOriginal ?? resources.resOriginal;
  const dimensions = original?.metadata;
  const orientation = master?.orientation ?? asset.orientation;
  const rotated = orientation !== null && orientation >= 5 && orientation <= 8;
  const versions: VersionSet = {
    thumb: resources.resJPEGThumb,
    medium: kind === 'video' ? resources.resVidMed ?? resources.resVidSmall : resources.resJPEGMed,
    large: kind === 'video' ? resources.resVidFull : resources.resJPEGLarge ?? resources.resJPEGFull,
    original,
  };
  const metadata: PhotoAsset['versions'] = {};
  for (const [name, resource] of Object.entries(versions) as [PhotoVersion, Resource | undefined][]) {
    if (resource) metadata[name] = resource.metadata;
  }
  const value: PhotoAsset = {
    id: asset.id, created: asset.created, added: asset.added, kind, favorite: asset.favorite,
    duration: kind === 'video' ? asset.duration : null, filename: master?.filename ?? null,
    width: (rotated ? dimensions?.height : dimensions?.width) ?? null,
    height: (rotated ? dimensions?.width : dimensions?.height) ?? null,
    versions: metadata,
  };
  return { value, versions };
}
