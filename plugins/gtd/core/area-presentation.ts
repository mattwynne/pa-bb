import type { Area } from './model.ts';

/** Read-only presentation roll-up: exact IDs first, then enclosing entry path.
 * Never use display titles or change the project's persisted areaId.
 */
export function enclosingArea(areas: Area[], areaId?: string): Area | undefined {
  if (!areaId) return undefined;
  const exact = areas.find(area => area.id === areaId);
  if (exact) return exact;
  return areas.find(area => {
    const base = area.id.endsWith('/') ? area.id.slice(0, -1) : area.id.endsWith('.md') ? area.id.slice(0, -3) : area.id;
    return areaId === base || areaId.startsWith(base + '/');
  });
}
