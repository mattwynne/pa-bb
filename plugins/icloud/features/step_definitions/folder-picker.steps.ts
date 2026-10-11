import { Given, When, Then, World } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { selectionStatus } from '../../folder-selection.ts';
import type { SelectedFolder } from '../../folder-selection.ts';
type PickerWorld = World & { pickerSelected: SelectedFolder[]; pickerFolder: SelectedFolder['folder'] };
Given('the picker has a {string} selection for Test Vault', function(this: PickerWorld, phase: string) {
  this.pickerSelected = [{ folder: { id: 'vault', ancestors: ['notes'] }, phase }];
});
When('the picker displays the {string} folder', function(this: PickerWorld, name: string) {
  const folders: Record<string, SelectedFolder['folder']> = {
    'Test Vault': { id: 'vault', ancestors: ['notes'] }, 'Notes': { id: 'notes', ancestors: [] },
    'Child': { id: 'child', ancestors: ['notes', 'vault'] }, 'Other Vault': { id: 'other', ancestors: ['notes'] },
  };
  assert.ok(folders[name]); this.pickerFolder = folders[name];
});
Then('its selection label is {string}', function(this: PickerWorld, label: string) {
  assert.equal(selectionStatus(this.pickerFolder, this.pickerSelected), label);
});
Then('the picker offers selection', function(this: PickerWorld) {
  assert.equal(selectionStatus(this.pickerFolder, this.pickerSelected), null);
});
