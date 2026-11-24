import test from 'node:test';
import assert from 'node:assert/strict';
import { enclosingArea } from '../core/area-presentation.ts';
import { Areas } from '../core/areas.ts';
const state = { propertiesAccessVersion: 1, childrenAccessVersion: 1, vaults: [{ vaultId: 'one', name: 'Synthetic', source: { local: { available: true }, cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null } }] };
test('nested areaId roll-up is exact-path presentation only, never display-title guessing or mutation', () => {
  const areas = [{ id: 'Life/Areas/Community.md', title: 'Renamed' }, { id: 'Life/Areas/Other/', title: 'Community' }];
  const project = { areaId: 'Life/Areas/Community/Example Committee/Meeting.md' };
  assert.equal(enclosingArea(areas, project.areaId)?.id, areas[0].id);
  assert.equal(project.areaId, 'Life/Areas/Community/Example Committee/Meeting.md');
  assert.equal(enclosingArea(areas, 'Life/Areas/Other/Meeting.md')?.id, areas[1].id);
  assert.equal(enclosingArea(areas, 'Life/Areas/Other/')?.id, areas[1].id);
  assert.equal(enclosingArea(areas, 'Life/Areas/Community-copy/Meeting.md'), undefined);
  assert.equal(enclosingArea(areas, 'Community'), undefined);
});
