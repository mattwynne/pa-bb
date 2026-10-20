// Copied from mattwynne/pi-extensions at 1bbb7ccb48a11462197457b890cab8ef71178082.
// MIT; see LICENSE.contact-groups. Local changes: BB configuration and error categories.
import { DOMParser } from "@xmldom/xmldom";
import { caseFoldEquals } from "unicode-case-folding";

export const ORIGIN = "https://carddav.fastmail.com";
export const DAV = "DAV:";
export const CARD = "urn:ietf:params:xml:ns:carddav";
export const MAX_BYTES = 16 * 1024 * 1024;
const MEMBER_KEYS = new Set(["MEMBER", "X-ADDRESSBOOKSERVER-MEMBER"]);

export type ContactGroupsFailure = "rejected" | "configuration" | "transport" | "access_denied" | "conflict" | "uncertain_write" | "verification_failed";

export class ContactGroupsError extends Error {
	readonly category: ContactGroupsFailure;
	constructor(message: string, category: ContactGroupsFailure = "rejected") {
		super(message);
		this.name = "ContactGroupsError";
		this.category = category;
	}
}

type HeadersMap = Record<string, string>;
export type TransportResult = [status: number, headers: HeadersMap, body: string];
export type DavTransport = (
	method: string,
	url: string,
	body?: string,
	headers?: HeadersMap,
) => TransportResult | Promise<TransportResult>;

interface VCardRecord {
	line: string;
	raw: string;
	key: string;
	header: string;
	value: string;
}

interface VCard {
	uid: string;
	name: string;
	version: string;
	isGroup: boolean;
	emails: string[];
	members: string[];
	records: VCardRecord[];
	url?: string;
	book?: string;
	etag?: string | null;
	raw?: string;
}

export interface ContactGroupParams {
	action: "list" | "get" | "add" | "remove";
	group?: string;
	email?: string;
	contactUid?: string;
	apply?: boolean;
}

export function memberRef(uid: unknown): string {
	const match = typeof uid === "string" ? /^(?:urn:uuid:)?([A-Za-z0-9._@+\-]{1,200})$/i.exec(uid) : null;
	if (!match) throw new ContactGroupsError("Unsupported contact UID; no changes made.");
	let value = `urn:uuid:${match[1]}`;
	if (/^urn:uuid:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) value = value.toLowerCase();
	return value;
}

function unescapeVCard(value: string): string {
	return value.replace(/\\([nN,;\\])/g, (_match, character) => character === "n" || character === "N" ? "\n" : character);
}

function physicalLines(text: string): string[] {
	return text.match(/.*(?:\r\n|\n|\r)|.+$/g) ?? [];
}

export function parseCard(text: string): VCard {
	const partialRecords: Array<Pick<VCardRecord, "line" | "raw">> = [];
	for (const physical of physicalLines(text)) {
		const logical = physical.replace(/[\r\n]+$/, "");
		if (logical.startsWith(" ") || logical.startsWith("\t")) {
			if (partialRecords.length === 0) throw new ContactGroupsError("Malformed folded vCard.");
			const previous = partialRecords.at(-1)!;
			previous.line += logical.slice(1);
			previous.raw += physical;
		} else {
			partialRecords.push({ line: logical, raw: physical });
		}
	}
	if (
		partialRecords.length < 4
		|| partialRecords[0].line.toUpperCase() !== "BEGIN:VCARD"
		|| partialRecords.at(-1)!.line.toUpperCase() !== "END:VCARD"
	) {
		throw new ContactGroupsError("Expected exactly one complete vCard.");
	}

	const values = new Map<string, string[]>();
	const records: VCardRecord[] = partialRecords.map(record => {
		let quoted = false;
		let separator = -1;
		for (let index = 0; index < record.line.length; index += 1) {
			const character = record.line[index];
			if (character === '"' && (index === 0 || record.line[index - 1] !== "\\")) quoted = !quoted;
			else if (character === ":" && !quoted) {
				separator = index;
				break;
			}
		}
		if (separator < 0) throw new ContactGroupsError("Malformed vCard property.");
		const header = record.line.slice(0, separator);
		const key = header.split(";", 1)[0].split(".").at(-1)!.toUpperCase();
		const value = record.line.slice(separator + 1);
		const decoded = unescapeVCard(value);
		values.set(key, [...(values.get(key) ?? []), decoded]);
		return { ...record, key, header, value };
	});

	if (
		JSON.stringify(values.get("BEGIN")) !== JSON.stringify(["VCARD"])
		|| JSON.stringify(values.get("END")) !== JSON.stringify(["VCARD"])
		|| values.get("UID")?.length !== 1
	) {
		throw new ContactGroupsError("Invalid or ambiguous vCard identity.");
	}
	const versions = values.get("VERSION");
	if (JSON.stringify(versions) !== JSON.stringify(["3.0"]) && JSON.stringify(versions) !== JSON.stringify(["4.0"])) {
		throw new ContactGroupsError("Unsupported vCard version.");
	}
	const kinds = [...(values.get("KIND") ?? []), ...(values.get("X-ADDRESSBOOKSERVER-KIND") ?? [])];
	return {
		uid: values.get("UID")![0],
		name: values.get("FN")?.[0] ?? "",
		version: versions![0],
		isGroup: kinds.length > 0 && kinds.every(kind => kind.toLowerCase() === "group"),
		emails: values.get("EMAIL") ?? [],
		members: records.filter(record => MEMBER_KEYS.has(record.key)).map(record => record.value),
		records,
	};
}

function normalizedRef(value: string): string {
	try {
		return memberRef(value);
	} catch (error) {
		if (error instanceof ContactGroupsError) return value;
		throw error;
	}
}

function fold(line: string, newline: string): string {
	const chunks: string[] = [];
	let current = "";
	let size = 0;
	for (const character of line) {
		const width = Buffer.byteLength(character, "utf8");
		if (size + width > 75) {
			chunks.push(current);
			current = " ";
			size = 1;
		}
		current += character;
		size += width;
	}
	chunks.push(current);
	return chunks.join(newline) + newline;
}

export function changeMembership(text: string, uid: string, action: "add" | "remove"): string {
	if (action !== "add" && action !== "remove") throw new ContactGroupsError("Expected add or remove.");
	const card = parseCard(text);
	if (!card.isGroup) throw new ContactGroupsError("Target is not a contact group.");
	const target = memberRef(uid);
	const matching = card.records.filter(record => MEMBER_KEYS.has(record.key) && normalizedRef(record.value) === target);
	if ((action === "add" && matching.length > 0) || (action === "remove" && matching.length === 0)) return text;
	if (action === "remove") return card.records.filter(record => !matching.includes(record)).map(record => record.raw).join("");
	const newline = card.records[0].raw.includes("\r\n") ? "\r\n" : "\n";
	const key = card.version === "4.0" ? "MEMBER" : "X-ADDRESSBOOKSERVER-MEMBER";
	return card.records.slice(0, -1).map(record => record.raw).join("")
		+ fold(`${key}:${target}`, newline)
		+ card.records.at(-1)!.raw;
}

function count(values: string[]): string {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return JSON.stringify([...counts].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

export function verifyEdit(before: string, after: string, uid: string, action: "add" | "remove"): void {
	const oldCard = parseCard(before);
	const newCard = parseCard(after);
	const target = memberRef(uid);
	const oldMembers = oldCard.members.map(normalizedRef);
	const newMembers = newCard.members.map(normalizedRef);
	if (oldCard.uid !== newCard.uid || !newCard.isGroup) throw new ContactGroupsError("Group identity changed during verification.");
	if (newMembers.includes(target) !== (action === "add")) throw new ContactGroupsError("Requested membership was not verified.");
	if (count(oldMembers.filter(member => member !== target)) !== count(newMembers.filter(member => member !== target))) {
		throw new ContactGroupsError("Unrelated group membership changed during verification.");
	}
	const unrelatedProperties = (card: VCard) => card.records
		.filter(record => MEMBER_KEYS.has(record.key) && normalizedRef(record.value) !== target)
		.map(record => JSON.stringify([record.header, normalizedRef(record.value)]));
	if (count(unrelatedProperties(oldCard)) !== count(unrelatedProperties(newCard))) {
		throw new ContactGroupsError("Unrelated member properties changed during verification.");
	}
	const otherProperties = (card: VCard) => card.records
		.filter(record => !MEMBER_KEYS.has(record.key) && record.key !== "REV")
		.map(record => record.line);
	if (count(otherProperties(oldCard)) !== count(otherProperties(newCard))) {
		throw new ContactGroupsError("Unrelated group properties changed during verification.");
	}
}

export function checkedUrl(href: string): string {
	let decodedInput: string;
	try {
		decodedInput = decodeURIComponent(href);
	} catch {
		throw new ContactGroupsError("Rejected unexpected CardDAV resource URL.");
	}
	const inputPath = decodedInput.split(/[?#]/, 1)[0];
	if (inputPath.split("/").some(part => part === "." || part === "..") || inputPath.includes("\\") || /[\u0000-\u001f]/.test(inputPath)) {
		throw new ContactGroupsError("Rejected unexpected CardDAV resource URL.");
	}
	let url: URL;
	try {
		url = new URL(href, `${ORIGIN}/`);
	} catch {
		throw new ContactGroupsError("Rejected unexpected CardDAV resource URL.");
	}
	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(url.pathname);
	} catch {
		throw new ContactGroupsError("Rejected unexpected CardDAV resource URL.");
	}
	if (
		url.protocol !== "https:"
		|| url.hostname !== "carddav.fastmail.com"
		|| url.port !== ""
		|| url.username !== ""
		|| url.password !== ""
		|| url.search !== ""
		|| url.hash !== ""
		|| !decodedPath.startsWith("/dav/addressbooks/user/")
		|| decodedPath.split("/").some(part => part === "." || part === "..")
		|| decodedPath.includes("\\")
		|| /[\u0000-\u001f]/.test(decodedPath)
	) {
		throw new ContactGroupsError("Rejected unexpected CardDAV resource URL.");
	}
	return url.href;
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw new ContactGroupsError("CardDAV response exceeds the safety limit; narrow the query.");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			throw new ContactGroupsError("CardDAV response exceeds the safety limit; narrow the query.");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export class HttpDav {
	readonly authorization: string;
	readonly signal?: AbortSignal;
	readonly fetchImplementation: typeof fetch;
	readonly maxBytes: number;

	constructor(username: string, password: string | undefined, options: {
		signal?: AbortSignal;
		fetchImplementation?: typeof fetch;
		maxBytes?: number;
	} = {}) {
		if (!username || username.includes(":") || /[\u0000-\u001f\u007f]/.test(username)) {
			throw new ContactGroupsError("Configure the CardDAV username with the Fastmail login account for Contacts access.", "configuration");
		}
		if (!password) throw new ContactGroupsError("Configure the CardDAV app password with Contacts access.", "configuration");
		this.authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
		this.signal = options.signal;
		this.fetchImplementation = options.fetchImplementation ?? fetch;
		this.maxBytes = options.maxBytes ?? MAX_BYTES;
	}

	async request(method: string, inputUrl: string, body?: string, headers: HeadersMap = {}): Promise<TransportResult> {
		const url = checkedUrl(inputUrl);
		const timeout = AbortSignal.timeout(30_000);
		const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await this.fetchImplementation(url, {
				method,
				headers: { ...headers, Authorization: this.authorization },
				body,
				redirect: "manual",
				signal,
			});
		} catch {
			if (this.signal?.aborted) {
				throw this.signal.reason instanceof Error ? this.signal.reason : new DOMException("Operation aborted", "AbortError");
			}
			throw new ContactGroupsError(`CardDAV ${method} failed due to a network/encoding error.`, "transport");
		}
		if (response.status >= 300) await response.body?.cancel().catch(() => {});
		if (response.status === 412) throw new ContactGroupsError("CardDAV conflict (412): group changed; re-read before retrying.", "conflict");
		if (response.status === 401 || response.status === 403) {
			throw new ContactGroupsError(`CardDAV access denied (${response.status}); check the app password's Contacts access.`, "access_denied");
		}
		if (response.status >= 300) {
			throw new ContactGroupsError(`CardDAV ${method} failed (HTTP ${response.status}); no redirects followed.`, "transport");
		}
		try {
			const text = await readLimitedText(response, this.maxBytes);
			return [response.status, Object.fromEntries(response.headers.entries()), text];
		} catch (error) {
			if (error instanceof ContactGroupsError) throw error;
			throw new ContactGroupsError(`CardDAV ${method} failed due to a network/encoding error.`, "transport");
		}
	}
}

function elements(parent: any, namespace: string, localName: string): any[] {
	return Array.from(parent.childNodes ?? []).filter((node: any) =>
		node.nodeType === 1 && node.namespaceURI === namespace && node.localName === localName);
}

function firstElement(parent: any, namespace: string, localName: string): any | undefined {
	return elements(parent, namespace, localName)[0];
}

function propertyKey(element: any): string {
	return `{${element.namespaceURI ?? ""}}${element.localName}`;
}

export function xmlResponses(text: string): Array<[string, Map<string, any>]> {
	if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new ContactGroupsError("Unsafe XML declaration in CardDAV response.");
	let document: any;
	try {
		document = new DOMParser({ onError: () => { throw new Error("invalid XML"); } }).parseFromString(text, "application/xml");
	} catch {
		throw new ContactGroupsError("Invalid CardDAV XML response.");
	}
	const root = document.documentElement;
	if (!root || root.namespaceURI !== DAV || root.localName !== "multistatus") {
		throw new ContactGroupsError("Expected a DAV multistatus response.");
	}
	const rows: Array<[string, Map<string, any>]> = [];
	for (const response of elements(root, DAV, "response")) {
		const href = firstElement(response, DAV, "href")?.textContent;
		if (!href) throw new ContactGroupsError("CardDAV response omitted a resource URL.");
		const props = new Map<string, any>();
		for (const block of elements(response, DAV, "propstat")) {
			const status = firstElement(block, DAV, "status")?.textContent ?? "";
			if (!/\s200(?:\s|$)/.test(status)) {
				throw new ContactGroupsError("Incomplete CardDAV property response; refusing a partial lookup.");
			}
			const prop = firstElement(block, DAV, "prop");
			if (prop) {
				for (const child of Array.from(prop.childNodes ?? []).filter((node: any) => node.nodeType === 1) as any[]) {
					props.set(propertyKey(child), child);
				}
			}
		}
		if (props.size === 0) throw new ContactGroupsError("CardDAV resource is unreadable; refusing a partial lookup.");
		rows.push([checkedUrl(href), props]);
	}
	return rows;
}

function xmlEscape(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function groupSummary(group: VCard) {
	return { uid: group.uid, name: group.name, memberCount: group.members.length };
}

export class GroupService {
	readonly home: string;
	readonly transport: DavTransport;

	constructor(username: string, transport: DavTransport) {
		this.home = checkedUrl(`${ORIGIN}/dav/addressbooks/user/${encodeURIComponent(username)}/`);
		this.transport = transport;
	}

	async xmlRequest(method: string, url: string, body: string, depth = "1") {
		const [status, , text] = await this.transport(method, checkedUrl(url), body, {
			"Content-Type": "application/xml; charset=utf-8",
			Depth: depth,
		});
		if (status !== 207) throw new ContactGroupsError(`Unexpected CardDAV ${method} response (${status}).`);
		return xmlResponses(text);
	}

	async books(): Promise<string[]> {
		const body = `<d:propfind xmlns:d="${DAV}"><d:prop><d:resourcetype/></d:prop></d:propfind>`;
		const rows = await this.xmlRequest("PROPFIND", this.home, body);
		const books: string[] = [];
		for (const [url, props] of rows) {
			const resourceType = props.get(`{${DAV}}resourcetype`);
			if (resourceType && firstElement(resourceType, CARD, "addressbook")) books.push(url);
		}
		if (books.length === 0) throw new ContactGroupsError("No readable CardDAV address books discovered.");
		return [...new Set(books)];
	}

	async query(book: string, fields: string[], value: string): Promise<VCard[]> {
		const filters = fields.map(field =>
			`<c:prop-filter name="${xmlEscape(field)}"><c:text-match collation="i;unicode-casemap" match-type="equals">${xmlEscape(value)}</c:text-match></c:prop-filter>`).join("");
		const body = `<c:addressbook-query xmlns:c="${CARD}" xmlns:d="${DAV}"><d:prop><d:getetag/><c:address-data/></d:prop><c:filter test="anyof">${filters}</c:filter></c:addressbook-query>`;
		const rows = await this.xmlRequest("REPORT", book, body);
		const cards: VCard[] = [];
		for (const [url, props] of rows) {
			if (!url.startsWith(`${book.replace(/\/$/, "")}/`)) {
				throw new ContactGroupsError("CardDAV query returned a resource outside its address book.");
			}
			const data = props.get(`{${CARD}}address-data`);
			const etag = props.get(`{${DAV}}getetag`);
			const raw = data?.textContent;
			if (!raw) throw new ContactGroupsError("CardDAV query omitted vCard data.");
			cards.push({ ...parseCard(raw), url, book, etag: etag?.textContent ?? null, raw });
		}
		return cards;
	}

	async execute(params: ContactGroupParams): Promise<Record<string, any>> {
		const { action, group, email, contactUid } = params;
		const apply = params.apply === true;
		if (!(["list", "get", "add", "remove"] as string[]).includes(action)) throw new ContactGroupsError("Unknown action.");
		if (apply && action !== "add" && action !== "remove") throw new ContactGroupsError("apply is only valid for add/remove.");
		if (action !== "list" && !group) throw new ContactGroupsError("group (exact name or CardDAV UID) is required.");
		if ((action === "add" || action === "remove") && !(email || contactUid)) throw new ContactGroupsError("email or contactUid is required.");
		if (email && (!email.includes("@") || /\s/.test(email))) throw new ContactGroupsError("Use one exact email address.");
		if (contactUid) memberRef(contactUid);

		const books = await this.books();
		const groups = (await Promise.all(books.map(book => this.query(book, ["KIND", "X-ADDRESSBOOKSERVER-KIND"], "group"))))
			.flat().filter(candidate => candidate.isGroup);
		if (action === "list") {
			return {
				summary: `Found ${groups.length} contact groups.`,
				groups: groups.slice(0, 50).map(groupSummary),
				total: groups.length,
				truncated: groups.length > 50,
			};
		}

		const byUid = groups.filter(candidate => candidate.uid === group);
		const matches = byUid.length > 0 ? byUid : groups.filter(candidate => caseFoldEquals(candidate.name, group!));
		if (matches.length !== 1) throw new ContactGroupsError("Group missing or ambiguous; list groups and use a unique CardDAV UID.");
		const selected = matches[0];
		const result: Record<string, any> = {
			summary: `Group: ${selected.name} (${selected.members.length} members).`,
			group: groupSummary(selected),
		};
		if (!(email || contactUid)) return result;

		const field = contactUid ? "UID" : "EMAIL";
		const value = contactUid ?? email!;
		let contacts = (await Promise.all(books.map(book => this.query(book, [field], value)))).flat().filter(candidate => !candidate.isGroup);
		contacts = contacts.filter(contact =>
			(!contactUid || contact.uid === contactUid)
			&& (!email || contact.emails.some(candidate => caseFoldEquals(candidate, email))));
		if (contacts.length !== 1) {
			throw new ContactGroupsError("Contact missing or ambiguous; use a unique CardDAV contactUid or resolve the contact first. No contact was created.");
		}
		const contact = contacts[0];
		if (contact.book !== selected.book) throw new ContactGroupsError("Contact and group are in different address books; refusing cross-book membership.");
		const target = memberRef(contact.uid);
		const memberships = groups.filter(candidate => candidate.members.map(normalizedRef).includes(target)).map(groupSummary);
		Object.assign(result, {
			contact: { uid: contact.uid, name: contact.name, emails: contact.emails },
			isMember: selected.members.map(normalizedRef).includes(target),
			currentGroups: memberships,
			membershipScope: "whole-contact",
		});
		if (contact.emails.length > 1) {
			result.warning = `Group membership can affect all ${contact.emails.length} email addresses on this contact. Confirm the entire contact belongs in this group.`;
		}
		if (action === "get") return result;

		const [freshStatus, headers, before] = await this.transport("GET", selected.url!);
		if (freshStatus !== 200) throw new ContactGroupsError("Could not read the current group resource.");
		const current = parseCard(before);
		if (!current.isGroup || current.uid !== selected.uid || current.name !== selected.name) {
			throw new ContactGroupsError("Group identity changed; re-read before retrying.");
		}
		const after = changeMembership(before, contact.uid, action);
		Object.assign(result, {
			group: groupSummary(current),
			isMember: current.members.map(normalizedRef).includes(target),
			changed: false,
			wouldChange: before !== after,
			applied: false,
			verified: false,
		});
		if (before === after) {
			Object.assign(result, { summary: "Membership already has the requested state; no write needed.", verified: true });
			return result;
		}
		if (!apply) {
			result.summary = `Would ${action} ${email ?? contact.uid} ${action === "add" ? "to" : "from"} ${current.name}. Other groups and contact details stay unchanged.`;
			return result;
		}
		const etagEntry = Object.entries(headers).find(([key]) => key.toLowerCase() === "etag");
		const etag = etagEntry?.[1];
		if (typeof etag !== "string" || !/^"[^"\r\n]+"$/.test(etag)) {
			throw new ContactGroupsError("A strong ETag is required; refusing an unsafe write.");
		}
		let writeStatus: number;
		try {
			[writeStatus] = await this.transport("PUT", selected.url!, after, {
				"Content-Type": "text/vcard; charset=utf-8",
				"If-Match": etag,
			});
		} catch (error) {
			if (error instanceof ContactGroupsError && (error.message.includes("(412)") || error.message.includes("access denied"))) throw error;
			throw new ContactGroupsError("Group write outcome is uncertain; re-read before retrying. No automatic retry.", "uncertain_write");
		}
		if (writeStatus !== 200 && writeStatus !== 204) {
			throw new ContactGroupsError(`Unexpected write response (${writeStatus}); re-read before retrying.`, "uncertain_write");
		}
		let saved: string;
		try {
			const [readStatus, , readBody] = await this.transport("GET", selected.url!);
			if (readStatus !== 200) throw new ContactGroupsError("Read-back failed.");
			saved = readBody;
			verifyEdit(before, saved, contact.uid, action);
		} catch {
			throw new ContactGroupsError("Group was written, but verification failed; inspect its current state before retrying.", "verification_failed");
		}
		Object.assign(result, {
			summary: `Verified: ${email ?? contact.uid} ${action === "add" ? "added to" : "removed from"} ${current.name}.`,
			group: groupSummary(parseCard(saved)),
			isMember: action === "add",
			changed: true,
			applied: true,
			verified: true,
		});
		result.previousGroups = result.currentGroups;
		delete result.currentGroups;
		return result;
	}
}

export function createConfiguredService(config: { username?: string; appPassword?: string }, options: {
	signal?: AbortSignal;
	fetchImplementation?: typeof fetch;
} = {}): GroupService {
	const rawUsername = config.username ?? "";
	if (/[\u0000-\u001f\u007f]/.test(rawUsername)) {
		throw new ContactGroupsError("Configure the CardDAV username with the Fastmail login account for Contacts access.", "configuration");
	}
	const username = rawUsername.trim();
	const http = new HttpDav(username, config.appPassword, options);
	return new GroupService(username, http.request.bind(http));
}
