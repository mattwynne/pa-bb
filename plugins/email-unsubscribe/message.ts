import { Resolver } from 'node:dns/promises';
import { dkimVerify } from 'mailauth';
import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import PostalMime from 'postal-mime';
import { z } from 'zod';
import { httpsTarget } from './web.ts';

export const mailboxAddress = z.email().max(320);
const managedKeys = ['list-unsubscribe', 'list-unsubscribe-post'] as const;
const unsubscribeLabel = /^(?:unsubscribe|opt[ -]?out)(?: from (?:this|the) (?:list|newsletter|mailing list))?[.!]?$/i;
const success = /^(?:you (?:have (?:successfully )?been|are now|are already|were successfully) unsubscribed(?: from (?:this|the) (?:list|mailing list|newsletter))?|(?:successfully |already )?unsubscribed|unsubscribe successful|your subscription has been removed)[.!]?$/i;

type Node = Tree.Node;
type Element = Tree.Element;
const hiddenTags = new Set(['script', 'style', 'head', 'noscript', 'template', 'iframe', 'svg']);
const isElement = (node: Node): node is Element => 'tagName' in node;
const attr = (node: Element, name: string) => node.attrs.find(item => item.name === name)?.value;
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

function visible(node: Node): Node[] {
  const pending = [node];
  const nodes: Node[] = [];
  while (pending.length) {
    const next = pending.pop()!;
    if (isElement(next) && (hiddenTags.has(next.tagName) || attr(next, 'hidden') !== undefined ||
      attr(next, 'aria-hidden') === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attr(next, 'style') ?? ''))) continue;
    nodes.push(next);
    if ('childNodes' in next) for (let index = next.childNodes.length - 1; index >= 0; index--) pending.push(next.childNodes[index]!);
  }
  return nodes;
}

function label(node: Node) {
  const snippets = visible(node).filter((item): item is Tree.TextNode => item.nodeName === '#text');
  return clean(snippets.map(item => item.value).join(' '));
}

function unique<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

export async function renderMessage(mime: string, mailbox: string) {
  const raw = Buffer.from(mime, 'base64');
  if (!raw.length || raw.length > 2 * 1024 * 1024) return null;
  const message = await PostalMime.parse(raw, { maxNestingDepth: 12, maxHeadersSize: 64 * 1024 });
  const header = (name: string) => unique(message.headers.filter(item => item.key === name).map(item => item.value));
  const listHeader = header('list-unsubscribe');
  // RFC 2369 encloses each URI in angle brackets. Commas inside URIs are data.
  const headerLinks = [...(listHeader ?? '').matchAll(/<([^<>]+)>/g)].map(match => match[1]!);
  const headerWeb = [...new Set(headerLinks.map(link => httpsTarget(link)?.href).filter((link): link is string => Boolean(link)))];
  const mail = unique([...new Set(headerLinks.filter(link => /^mailto:/i.test(link)))]);
  const bodyLinks: string[] = [];
  if (message.html && message.html.length <= 256 * 1024) {
    for (const link of visible(parse(message.html)).filter(isElement)) {
      if (link.tagName !== 'a' || !unsubscribeLabel.test(label(link))) continue;
      const href = httpsTarget(attr(link, 'href') ?? '');
      if (href) bodyLinks.push(href.href);
    }
  }
  if (message.text && message.text.length <= 256 * 1024) {
    for (const match of message.text.matchAll(/^\s*(?:unsubscribe|opt[ -]?out)\s*:?\s*<?(https:\/\/[^<>\s]+)>?\s*$/gim)) {
      const href = httpsTarget(match[1]!);
      if (href) bodyLinks.push(href.href);
    }
  }
  const deliveryHeaders = message.headers.filter(item => item.key === 'delivered-to');
  const delivered = unique(deliveryHeaders)?.value;
  const primary = mailbox.toLowerCase();
  const to = message.to?.flatMap(entry => 'address' in entry ? [entry.address] : entry.group.map(member => member.address)) ?? [];
  const recipient = deliveryHeaders.length
    ? delivered?.trim().toLowerCase() === primary ? mailbox : undefined
    : to.some(address => address?.toLowerCase() === primary) ? mailbox : undefined;
  const oneClick = headerWeb.length === 1 && header('list-unsubscribe-post')?.trim() === 'List-Unsubscribe=One-Click';
  return { raw, web: unique(headerWeb) ?? (!headerWeb.length ? unique([...new Set(bodyLinks)]) : undefined),
    mail, recipient, oneClick, ambiguous: headerWeb.length > 1 || (!headerWeb.length && new Set(bodyLinks).size > 1) };
}

export async function verifyOneClick(raw: Buffer, signal: AbortSignal, lookupTxt?: (name: string) => Promise<string[][]>) {
  const resolver = new Resolver({ timeout: 2400, tries: 1 });
  const abort = () => resolver.cancel();
  signal.addEventListener('abort', abort, { once: true });
  let queries = 0;
  try {
    signal.throwIfAborted();
    const results = await dkimVerify(raw, { strict: true, resolver: (name, rrtype) => {
      signal.throwIfAborted();
      if (rrtype !== 'TXT' || ++queries > 12) throw new Error('DKIM query limit');
      return lookupTxt ? lookupTxt(name) : resolver.resolveTxt(name);
    } });
    return results.results.some(signature => {
      const keys = signature.signingHeaders?.keys.toLowerCase().split(':').map(key => key.trim()) ?? [];
      return signature.status.result === 'pass' && Boolean(signature.status.aligned) && !signature.status.testing &&
        !signature.status.underSized && managedKeys.every(key => keys.includes(key));
    });
  } finally { signal.removeEventListener('abort', abort); }
}

export function mailtoRequest(value: string, recipient: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'mailto:' || url.hash || url.host) return null;
    const address = mailboxAddress.safeParse(decodeURIComponent(url.pathname));
    if (!address.success) return null;
    const params = new Map<string, string>();
    for (const [key, content] of url.searchParams) {
      const name = key.toLowerCase();
      if (!['subject', 'body'].includes(name) || params.has(name)) return null;
      params.set(name, content);
    }
    const subject = params.get('subject') ?? 'unsubscribe';
    const body = params.get('body') ?? '';
    if (subject.length > 256 || !/^[\x20-\x7e]*$/.test(subject) ||
      body.length > 2048 || !/^[\x20-\x7e\r\n]*$/.test(body)) return null;
    return { from: recipient, to: address.data, subject, body };
  } catch { return null; }
}

export function inspectPage(html: string, url: URL, recipient?: string) {
  const tree = parse(html);
  const elements = visible(tree).filter(isElement);
  const text = label(tree);
  const blocked = elements.some(el => attr(el, 'type')?.toLowerCase() === 'password' ||
    /(?:recaptcha|hcaptcha|turnstile)/i.test(`${attr(el, 'class') ?? ''} ${attr(el, 'id') ?? ''}`));
  if (blocked) return { kind: 'blocked' } as const;
  const shortConfirmation = elements.some(el => /^(?:p|h1|h2|h3)$/.test(el.tagName) && success.test(label(el)));
  if (success.test(text) || (shortConfirmation && !elements.some(el => el.tagName === 'form') &&
      !/if you (?:have|are)|(?:un)?successfully subscribed|could not|were not|failed|error/i.test(text)))
    return { kind: 'confirmed' } as const;
  const form = unique(elements.filter(el => el.tagName === 'form'));
  if (!form || /preferences|unsubscribe from all|all (?:lists|emails|subscriptions)/i.test(label(form)) ||
    attr(form, 'method')?.toLowerCase() !== 'post' ||
    attr(form, 'enctype') && attr(form, 'enctype') !== 'application/x-www-form-urlencoded')
    return { kind: 'browser' } as const;
  const action = attr(form, 'action');
  const target = action ? httpsTarget(action, url) : url;
  if (!target || target.origin !== url.origin || elements.some(el => attr(el, 'form') !== undefined) || /<base\b/i.test(html))
    return { kind: 'browser' } as const;
  const fields = new URLSearchParams();
  const descendants = visible(form).filter(isElement);
  const controls = descendants.filter(el => ['button', 'input', 'select', 'textarea', 'fieldset'].includes(el.tagName));
  let submit = false;
  let filled = false;
  for (const control of controls) {
    const type = attr(control, 'type')?.toLowerCase() ?? (control.tagName === 'button' ? 'submit' : 'text');
    const name = attr(control, 'name');
    const value = attr(control, 'value') ?? '';
    if (control.attrs.some(item => /^form|^on|^disabled$/.test(item.name))) return { kind: 'browser' } as const;
    if (['input', 'button'].includes(control.tagName) && type === 'submit' &&
        unsubscribeLabel.test(label(control) || value) && !submit) submit = true;
    else if (control.tagName === 'input' && type === 'email' && name && recipient && !filled && (!value || value.toLowerCase() === recipient.toLowerCase())) {
      fields.append(name, recipient);
      filled = true;
      continue;
    } else if (control.tagName !== 'input' || type !== 'hidden') return { kind: 'browser' } as const;
    if (name) fields.append(name, value);
  }
  // A script may change the form's behavior or synthesize required fields.
  if (!submit || fields.toString().length > 8192 || /<(?:script|iframe)\b|\sonsubmit\s*=/i.test(html))
    return { kind: 'browser' } as const;
  return { kind: 'form', target, fields } as const;
}
