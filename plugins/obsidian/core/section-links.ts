import { fromMarkdown } from 'mdast-util-from-markdown';
import { z } from 'zod';

export const linkReturnDate = z.iso.date().refine(date => !date.startsWith('0000-'));

/** A correspondence section consists of unordered bullets containing one inline link each. */
export function sectionLinkEntries(text: string, dated = false) {
  const links: { title: string; url: string; returnDate?: string; start: number; end: number }[] = [];
  let incomplete = false;
  for (const block of fromMarkdown(text).children) {
    if (block.type !== 'list' || block.ordered) { incomplete = true; continue; }
    for (const item of block.children) {
      const paragraph = item.children[0];
      const link = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined;
      if (item.children.length !== 1 || paragraph?.type !== 'paragraph' || paragraph.children.length !== 1 ||
          link?.type !== 'link' || link.children.some(part => part.type !== 'text')) {
        incomplete = true;
        continue;
      }
      const title = link.children.map(part => part.type === 'text' ? part.value : '').join('').replace(/\s+/g, ' ').trim();
      const returnDate = dated ? linkReturnDate.safeParse(link.title).data : undefined;
      if (links.length >= 40 || !title || title.length > 1024 || !link.url || link.url.length > 2048 || (dated && !returnDate)) {
        incomplete = true;
        continue;
      }
      const start = item.position?.start.offset, end = item.position?.end.offset;
      if (start === undefined || end === undefined) { incomplete = true; continue; }
      const newline = text.indexOf('\n', end);
      links.push({ title, url: link.url, ...(returnDate ? { returnDate } : {}), start: start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1,
        end: newline < 0 ? text.length : newline + 1 });
    }
  }
  return { links, incomplete };
}

export function sectionLinks(text: string, dated = false) {
  const { links, incomplete } = sectionLinkEntries(text, dated);
  return { links: links.map(({ start: _start, end: _end, ...link }) => link), incomplete };
}
