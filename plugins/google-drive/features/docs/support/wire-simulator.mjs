// Small test-only wire model. No production planner/compiler/verifier imports.
// Supports exact whole-run text style and single-run literal replacement only.
import assert from 'node:assert/strict';
export class WireSimulator {
  constructor(document) { this.document = structuredClone(document); }
  submit(batch) {
    assert.deepEqual(Object.keys(batch).sort(), ['requests', 'writeControl']);
    assert.deepEqual(batch.writeControl, { requiredRevisionId: this.document.revisionId }, 'simulator revision mismatch');
    const next = structuredClone(this.document), replies = [];
    for (const request of batch.requests) {
      assert.equal(Object.keys(request).length, 1);
      if (request.updateTextStyle) {
        const { range, textStyle, fields } = request.updateTextStyle;
        assert.equal(fields, 'bold', 'simulator unsupported style'); assert.equal(typeof textStyle.bold, 'boolean');
        const tab = next.tabs.find(t => t.tabProperties.tabId === range.tabId); assert.ok(tab);
        const elements = tab.documentTab.body.content.flatMap(b => b.paragraph?.elements ?? []);
        const run = elements.find(e => e.startIndex === range.startIndex && e.endIndex === range.endIndex);
        assert.ok(run?.textRun, 'simulator supports whole runs only');
        run.textRun.textStyle = { ...run.textRun.textStyle, bold: textStyle.bold }; replies.push({});
      } else if (request.replaceAllText) {
        const { containsText, replaceText, tabsCriteria } = request.replaceAllText;
        assert.equal(containsText.matchCase, true); assert.equal(containsText.searchByRegex, false);
        assert.ok(containsText.text && !containsText.text.includes('\n') && !replaceText.includes('\n'));
        let count = 0;
        for (const tab of next.tabs.filter(t => tabsCriteria.tabIds.includes(t.tabProperties.tabId))) {
          let shift = 0;
          for (const block of tab.documentTab.body.content) {
            if (!block.paragraph) { assert.equal(shift, 0, 'simulator cannot shift opaque blocks'); continue; }
            assert.equal(block.paragraph.elements.length, 1, 'simulator single-run paragraphs only');
            const e = block.paragraph.elements[0]; assert.ok(e.textRun);
            const old = e.textRun.content, parts = old.split(containsText.text); count += parts.length - 1;
            const changed = parts.join(replaceText), delta = changed.length - old.length;
            block.startIndex += shift; block.endIndex += shift + delta;
            e.startIndex += shift; e.endIndex += shift + delta; e.textRun.content = changed; shift += delta;
          }
        }
        replies.push({ replaceAllText: { occurrencesChanged: count } });
      } else throw new Error('simulator unsupported request');
    }
    assert.equal(this.document.revisionId, 'rev-a', 'simulator supports one accepted revision transition');
    next.revisionId = 'rev-b'; this.document = next;
    return { documentId: next.documentId, replies, writeControl: { requiredRevisionId: next.revisionId } };
  }
}
