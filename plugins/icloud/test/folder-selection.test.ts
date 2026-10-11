import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionStatus } from '../folder-selection.ts';
const selected = [{ folder: { id: 'vault', ancestors: ['notes'] }, phase: 'ready' }];
test('picker marks exact selections and prevents nested choices before a failing RPC', () => {
  assert.equal(selectionStatus({ id: 'vault', ancestors: ['notes'] }, selected), 'Selected');
  assert.equal(selectionStatus({ id: 'notes', ancestors: [] }, selected), 'Contains a selected folder');
  assert.equal(selectionStatus({ id: 'child', ancestors: ['notes', 'vault'] }, selected), 'Inside a selected folder');
  assert.equal(selectionStatus({ id: 'other', ancestors: ['notes'] }, selected), null);
});
test('paused and failed mirrors still reserve their selected folder', () => {
  for (const phase of ['paused', 'failed', 'running']) assert.equal(selectionStatus({ id: 'vault', ancestors: ['notes'] }, [{ ...selected[0], phase }]), 'Selected');
});
test('retained previous mirrors do not block an independent current selection', () => {
  assert.equal(selectionStatus({ id: 'vault', ancestors: ['notes'] }, [{ ...selected[0], phase: 'retained' }]), null);
  assert.equal(selectionStatus({ id: 'notes', ancestors: [] }, [{ ...selected[0], phase: 'retained' }]), null);
});
