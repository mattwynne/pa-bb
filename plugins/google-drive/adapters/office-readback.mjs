// Narrow bounded readback for imported native files, not a Google API proxy.
import { textEvidence } from './office-import.mjs';
import { uploadError } from '../core/upload.mjs';
const fail = () => { throw uploadError('incomplete'); };
const limits = 'Bounded editable text/structure readback, not visual fidelity. Fonts/layout, tables/objects, animations, media, unsupported features and omitted non-body content remain unverified.';
export function createOfficeReadback(transport) {
  return {
    async inspectDoc(record, id, expected) {
      const doc = await transport.get(record, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}?includeTabsContent=true`);
      if (doc.documentId !== id || expected?.kind !== 'doc') fail();
      const tabs = []; let nodes = 0, characters = 0, paragraphs = 0, tables = 0, inlineObjects = 0;
      function tabWalk(list, depth = 0) {
        if (!Array.isArray(list) || depth > 8) fail();
        for (const t of list) {
          if (tabs.length >= 20 || typeof t?.tabProperties?.tabId !== 'string' || !/^[\w.:-]{1,256}$/.test(t.tabProperties.tabId) || !t.documentTab || tabs.some(p => p.tabId === t.tabProperties.tabId)) fail();
          tabs.push({ tabId: t.tabProperties.tabId, body: t.documentTab.body });
          if (t.childTabs) tabWalk(t.childTabs, depth + 1);
        }
      }
      if (doc.tabs?.length) tabWalk(doc.tabs);
      else if (doc.body) tabs.push({ tabId: 'legacy-body', body: doc.body });
      else fail();
      function content(list, depth = 0) {
        if (!Array.isArray(list) || depth > 32) fail(); let text = '';
        for (const e of list) {
          if (++nodes > 10000) fail();
          if (e.paragraph) {
            paragraphs++; if (!Array.isArray(e.paragraph.elements)) fail();
            for (const el of e.paragraph.elements) {
              if (++nodes > 10000) fail();
              if (el.textRun) {
                if (typeof el.textRun.content !== 'string' || (characters += el.textRun.content.length) > 80000) fail();
                text += el.textRun.content;
              } else if (el.inlineObjectElement) inlineObjects++;
              // Other native elements are not claimed as text fidelity evidence.
            }
            text += ' ';
          } else if (e.table) {
            tables++; if (!Array.isArray(e.table.tableRows)) fail();
            for (const row of e.table.tableRows) {
              if (++nodes > 10000 || !Array.isArray(row.tableCells)) fail();
              for (const cell of row.tableCells) { if (++nodes > 10000) fail(); text += content(cell.content, depth + 1); }
            }
          } else if (e.tableOfContents) text += content(e.tableOfContents.content, depth + 1);
          else if (!e.sectionBreak) fail();
        }
        return text;
      }
      const bodies = tabs.map(t => textEvidence(content(t.body?.content)));
      const structureMatches = tabs.length === 1 && paragraphs > 0 && bodies[0].textHash === expected.body.textHash;
      return { structureMatches, tabs: tabs.map((t, i) => ({ tabId: t.tabId, ...bodies[i] })), paragraphs, tables, inlineObjects,
        sourceBody: expected.body, bodyTextMatches: structureMatches, fidelityVerified: false, inspection: `${limits} Only the single imported main body is compared; headers/footers, notes and comments are not compared. Native JSON is capped at 1 MiB, 20 tabs, 10,000 structural nodes and 80,000 text characters.` };
    },
    async inspectSlides(record, id, expected) {
      // No thumbnails, image fetches, exports or secondary reads of remote URLs.
      const url = new URL(`https://slides.googleapis.com/v1/presentations/${encodeURIComponent(id)}`);
      url.searchParams.set('fields', 'presentationId,slides(objectId,pageElements)');
      const p = await transport.get(record, url);
      if (p.presentationId !== id || expected?.kind !== 'slides' || !Array.isArray(p.slides) || !p.slides.length || p.slides.length > 100) fail();
      const ids = new Set(); let nodes = 0, characters = 0;
      function elements(list, depth = 0) {
        if (!Array.isArray(list) || depth > 16) fail(); let text = '', objects = 0;
        for (const el of list) {
          if (++nodes > 10000 || typeof el?.objectId !== 'string' || !/^[\w:-]{1,128}$/.test(el.objectId) || ids.has(el.objectId)) fail();
          ids.add(el.objectId); objects++;
          function runs(value) {
            if (!Array.isArray(value?.textElements)) return '';
            let s = '';
            for (const e of value.textElements) {
              if (++nodes > 10000) fail();
              if (e.textRun) { if (typeof e.textRun.content !== 'string' || (characters += e.textRun.content.length) > 80000) fail(); s += e.textRun.content; }
            }
            return s;
          }
          if (el.elementGroup) { const group = elements(el.elementGroup.children, depth + 1); text += group.text; objects += group.objects; }
          else if (el.shape) text += runs(el.shape.text) + ' ';
          else if (el.table) {
            if (!Array.isArray(el.table.tableRows)) fail();
            for (const row of el.table.tableRows) { if (++nodes > 10000 || !Array.isArray(row.tableCells)) fail(); for (const c of row.tableCells) { if (++nodes > 10000) fail(); text += runs(c.text) + ' '; } }
          }
          // Image/video/line/chart/WordArt evidence is object count only, not fidelity.
        }
        return { text, objects };
      }
      const slides = p.slides.map((s, index) => {
        if (typeof s?.objectId !== 'string' || !/^[\w:-]{1,128}$/.test(s.objectId) || ids.has(s.objectId)) fail(); ids.add(s.objectId);
        const body = elements(s.pageElements || []);
        return { index, slideId: s.objectId, objects: body.objects, ...textEvidence(body.text) };
      });
      const countMatches = slides.length === expected.slides.length;
      const textMatchesInOrder = countMatches && slides.every((s, i) => s.textHash === expected.slides[i].textHash);
      return { structureMatches: countMatches && textMatchesInOrder, slideCount: slides.length, countMatches, textMatchesInOrder, slides,
        fidelityVerified: false, inspection: `${limits} Slide count/order uses per-index normalized text hashes; text-identical/empty slides cannot distinguish ordering. Speaker notes, layouts and masters are not compared. Native JSON is capped at 1 MiB, 100 slides, 10,000 structural/text nodes and 80,000 text characters.` };
    },
  };
}
