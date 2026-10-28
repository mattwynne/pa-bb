export const account = 'writer@example.test';
export const record = { subject: 'subject-a', email: account };
export const input = { account, document: 'doc-a', tabId: 'tab-a', expectedRevisionId: 'rev-a', oldText: 'old words', newText: 'new words' };
export function tab(text = 'Hello 😀 old words.\n', id = 'tab-a') {
  return { tabProperties: { tabId: id, title: 'Main' }, documentTab: { body: { content: [
    { endIndex: 1, sectionBreak: {} },
    { startIndex: 1, endIndex: 1 + text.length, paragraph: { elements: [
      { startIndex: 1, endIndex: 1 + text.length, textRun: { content: text, textStyle: { bold: true } } },
    ] } },
  ] } } };
}
export function document(text, id = 'doc-a') {
  return { documentId: id, revisionId: 'rev-a', suggestionsViewMode: 'SUGGESTIONS_INLINE', title: 'Synthetic fixture only', tabs: [tab(text)] };
}
