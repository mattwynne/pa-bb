// Adapted from mattwynne/pi-extensions at 1bbb7ccb48a11462197457b890cab8ef71178082.
// MIT; see ../LICENSE.contact-groups. Only the import/configuration adapter differs.
import assert from "node:assert/strict";
import test from "node:test";

import {
	CARD,
	DAV,
	ORIGIN,
	ContactGroupsError,
	GroupService,
	HttpDav,
	changeMembership,
	checkedUrl,
	createConfiguredService,
	parseCard,
} from "../contact-groups.ts";

const USERNAME = "test@example.test";
const HOME = `${ORIGIN}/dav/addressbooks/user/test%40example.test/`;
const BOOK = `${HOME}default/`;
const SECOND_BOOK = `${HOME}other/`;
const GROUP_URL = `${BOOK}group.vcf`;
const CONTACT_URL = `${BOOK}contact.vcf`;
const UID = "12345678-1234-1234-1234-123456789abc";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const EMAIL = "person@example.test";
const SECRET = "NEVER-EXPOSE-test-password";
const SERVER_TEXT = "PRIVATE-REMOTE-BODY";

function groupCard({ uid = "group-uid", name = "Paperwork", members = [OTHER] } = {}) {
	return [
		"BEGIN:VCARD", "VERSION:3.0", `UID:${uid}`, `FN:${name}`,
		"X-ADDRESSBOOKSERVER-KIND:group", 'X-KEEP;LABEL="a:b":untouched',
		"NOTE:first part", " second part", "REV:20260909T120000Z",
		...members.map(member => `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${member}`),
		"END:VCARD", "",
	].join("\r\n");
}

function contactCard({ uid = UID, email = EMAIL } = {}) {
	return ["BEGIN:VCARD", "VERSION:3.0", `UID:${uid}`, "FN:Person", `EMAIL;TYPE=INTERNET:${email}`, "END:VCARD", ""].join("\r\n");
}

function addedCard(before, uid = UID) {
	return before.replace("END:VCARD", `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${uid}\r\nEND:VCARD`);
}

function xmlEscape(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function multistatus(rows) {
	const responses = rows.map(([href, card]) => {
		const property = card === null
			? `<d:resourcetype><c:addressbook/></d:resourcetype>`
			: `<d:getetag>&quot;stale-report-etag&quot;</d:getetag><c:address-data>${xmlEscape(card)}</c:address-data>`;
		return `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop>${property}</d:prop></d:propstat></d:response>`;
	}).join("");
	return `<d:multistatus xmlns:d="${DAV}" xmlns:c="${CARD}">${responses}</d:multistatus>`;
}

class FakeDav {
	constructor(before = groupCard()) {
		this.books = [BOOK];
		this.groups = { [BOOK]: [[GROUP_URL, groupCard()]] };
		this.contacts = { [BOOK]: [[CONTACT_URL, contactCard()]] };
		this.before = before;
		this.etagHeaders = { eTaG: '"fresh-get-etag"' };
		this.putResult = [204, {}, ""];
		this.verifyResult = null;
		this.freshStatus = 200;
		this.calls = [];
		this.saved = null;
		this.getCount = 0;
		this.transport = this.transport.bind(this);
	}

	transport(method, url, body, headers) {
		this.calls.push([method, url, body, headers]);
		if (method === "PROPFIND") {
			assert.equal(url, HOME);
			return [207, {}, multistatus(this.books.map(book => [book, null]))];
		}
		if (method === "REPORT") {
			assert(this.books.includes(url));
			const fields = [...body.matchAll(/<c:prop-filter name="([^"]+)"/g)].map(match => match[1]);
			const rows = fields.includes("KIND") ? this.groups : this.contacts;
			return [207, {}, multistatus(rows[url] ?? [])];
		}
		if (method === "GET") {
			assert.equal(url, GROUP_URL);
			this.getCount += 1;
			const result = this.getCount === 1
				? [this.freshStatus, this.etagHeaders, this.before]
				: this.verifyResult ?? [200, { ETag: '"after-put"' }, this.saved];
			if (result instanceof Error) throw result;
			return result;
		}
		if (method === "PUT") {
			assert.equal(url, GROUP_URL);
			this.saved = body;
			if (this.putResult instanceof Error) throw this.putResult;
			return this.putResult;
		}
		throw new Error(`Unexpected transport method: ${method}`);
	}

	get writes() {
		return this.calls.filter(([method]) => !["PROPFIND", "REPORT", "GET"].includes(method));
	}
}

function serviceFor(dav = new FakeDav()) {
	return { dav, service: new GroupService(USERNAME, dav.transport) };
}

function execute(service, action = "add", overrides = {}) {
	return service.execute({ action, group: "Paperwork", email: EMAIL, ...overrides });
}

function v3Group(version = "3.0", newline = "\r\n") {
	return [
		"BEGIN:VCARD", `VERSION:${version}`, "UID:group-uid", "FN:Paperwork",
		`${version === "4.0" ? "KIND" : "X-ADDRESSBOOKSERVER-KIND"}:group`,
		'X-KEEP;LABEL="a:b":untouched', "NOTE:folded first", " second",
		`${version === "4.0" ? "MEMBER" : "X-ADDRESSBOOKSERVER-MEMBER"}:urn:uuid:${OTHER}`,
		"END:VCARD", "",
	].join(newline);
}

test("vCard edits preserve unrelated bytes and are idempotent", () => {
	const before = v3Group();
	const after = changeMembership(before, UID, "add");
	const added = `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${UID}\r\n`;
	assert.equal(after.replace(added, ""), before);
	assert(parseCard(after).members.includes(`urn:uuid:${UID}`));
	assert.equal(changeMembership(after, UID, "add"), after);
	const removed = changeMembership(before, OTHER, "remove");
	assert(!removed.includes(`urn:uuid:${OTHER}`));
	assert(removed.includes('X-KEEP;LABEL="a:b":untouched'));
	assert(removed.includes("NOTE:folded first\r\n second"));
});

test("vCard UUID matching is case-insensitive and rejects injection", () => {
	const before = v3Group().replace(`urn:uuid:${OTHER}`, `URN:UUID:${OTHER.toUpperCase()}`);
	assert.equal(changeMembership(before, OTHER, "add"), before);
	assert(!changeMembership(before, OTHER, "remove").includes("URN:UUID:"));
	assert.throws(() => changeMembership(v3Group(), "bad\r\nFN:injected", "add"), ContactGroupsError);
	assert.throws(() => changeMembership("BEGIN:VCARD\r\nVERSION:3.0\r\nUID:x\r\nFN:A\r\nEND:VCARD\r\n", UID, "add"), ContactGroupsError);
});

test("vCard 4 additions use MEMBER and retain LF endings", () => {
	const after = changeMembership(v3Group("4.0", "\n"), UID, "add");
	assert(after.includes(`\nMEMBER:urn:uuid:${UID}\n`));
	assert(!after.includes("\r"));
});

test("preview defaults to zero writes and performs a fresh GET", async () => {
	const { dav, service } = serviceFor();
	const result = await execute(service);
	assert.deepEqual(dav.writes, []);
	assert.equal(result.wouldChange, true);
	for (const flag of ["changed", "applied", "verified", "isMember"]) assert.equal(result[flag], false, flag);
	assert.deepEqual(dav.calls.map(([method]) => method), ["PROPFIND", "REPORT", "REPORT", "GET"]);
	assert.equal(dav.calls[0][3].Depth, "1");
});

test("only literal apply=true can enable a write", async () => {
	const { dav, service } = serviceFor();
	const result = await execute(service, "add", { apply: "true" });
	assert.equal(result.wouldChange, true);
	assert.equal(result.applied, false);
	assert.deepEqual(dav.writes, []);
});

test("preview warns when membership affects multiple addresses", async () => {
	const { dav, service } = serviceFor();
	dav.contacts[BOOK] = [[CONTACT_URL, contactCard().replace("END:VCARD", "EMAIL:second@example.test\r\nEND:VCARD")]];
	const result = await execute(service);
	assert.match(result.warning, /all 2 email addresses/);
	assert.equal(result.membershipScope, "whole-contact");
	assert.deepEqual(dav.writes, []);
});

test("apply uses the fresh ETag, preserves bytes, and verifies", async () => {
	const { dav, service } = serviceFor();
	dav.before = groupCard({ members: [OTHER, "fresh-member"] });
	const result = await execute(service, "add", { apply: true });
	assert.equal(dav.writes.length, 1);
	const [method, url, body, headers] = dav.writes[0];
	assert.deepEqual([method, url], ["PUT", GROUP_URL]);
	assert.equal(headers["If-Match"], '"fresh-get-etag"');
	assert.equal(headers["Content-Type"], "text/vcard; charset=utf-8");
	assert.equal(body, addedCard(dav.before));
	assert.deepEqual(dav.calls.slice(-3).map(([candidate]) => candidate), ["GET", "PUT", "GET"]);
	for (const flag of ["changed", "applied", "verified", "isMember", "wouldChange"]) assert.equal(result[flag], true, flag);
	assert.equal(result.group.memberCount, 3);
	assert("previousGroups" in result);
	assert(!("currentGroups" in result));
});

test("remove writes only the target member and verifies", async () => {
	const { dav, service } = serviceFor(new FakeDav(groupCard({ members: [OTHER, UID, UID] })));
	const result = await execute(service, "remove", { apply: true });
	assert.equal(dav.saved, groupCard({ members: [OTHER] }));
	assert.equal(result.verified, true);
	assert.equal(result.isMember, false);
	assert.equal(dav.writes.length, 1);
});

test("idempotent mutations use fresh state without requiring an ETag", async () => {
	for (const [action, members] of [["add", [OTHER, UID]], ["remove", [OTHER]]]) {
		for (const apply of [false, true]) {
			const dav = new FakeDav(groupCard({ members }));
			dav.etagHeaders = {};
			const result = await execute(new GroupService(USERNAME, dav.transport), action, { apply });
			assert.equal(result.wouldChange, false);
			assert.equal(result.changed, false);
			assert.equal(result.applied, false);
			assert.equal(result.verified, true);
			assert.equal(result.isMember, action === "add");
			assert.deepEqual(dav.writes, []);
		}
	}
});

test("missing, weak, and invalid ETags refuse writes", async () => {
	for (const value of [undefined, 'W/"weak"', "unquoted", '""', '"bad\r\nvalue"', 123]) {
		const { dav, service } = serviceFor();
		dav.etagHeaders = value === undefined ? {} : { ETag: value };
		await assert.rejects(execute(service, "add", { apply: true }), /strong ETag/);
		assert.deepEqual(dav.writes, []);
	}
});

test("conflicts and denied writes are not retried or mislabeled", async () => {
	for (const message of [
		"CardDAV conflict (412): group changed; re-read before retrying.",
		"CardDAV access denied (403); check the app password's Contacts access.",
	]) {
		const { dav, service } = serviceFor();
		dav.putResult = new ContactGroupsError(message);
		await assert.rejects(execute(service, "add", { apply: true }), new RegExp(message.includes("conflict") ? "conflict" : "access denied"));
		assert.equal(dav.writes.length, 1);
		assert.equal(dav.getCount, 1);
	}
});

test("uncertain writes are sanitized and never retried", async () => {
	const { dav, service } = serviceFor();
	dav.putResult = new ContactGroupsError(SERVER_TEXT + SECRET);
	await assert.rejects(execute(service, "add", { apply: true }), error => {
		assert.match(error.message, /outcome is uncertain/);
		assert.doesNotMatch(error.message, new RegExp(`${SECRET}|${SERVER_TEXT}`));
		return true;
	});
	assert.equal(dav.writes.length, 1);
	assert.equal(dav.getCount, 1);
});

test("unexpected PUT statuses do not retry or expose response bodies", async () => {
	for (const status of [201, 302, 401, 403, 412, 500]) {
		const { dav, service } = serviceFor();
		dav.putResult = [status, {}, SERVER_TEXT];
		await assert.rejects(execute(service, "add", { apply: true }), error => {
			assert.match(error.message, new RegExp(`Unexpected write response \\(${status}\\)`));
			assert.doesNotMatch(error.message, /PRIVATE-REMOTE-BODY/);
			return true;
		});
		assert.equal(dav.writes.length, 1);
	}
});

test("read-back failures report written but unverified", async () => {
	const good = addedCard(groupCard());
	const cases = [
		groupCard(),
		good.replace("UID:group-uid", "UID:other-group"),
		good.replace("X-ADDRESSBOOKSERVER-KIND:group", "X-ADDRESSBOOKSERVER-KIND:individual"),
		good.replace(`urn:uuid:${OTHER}`, "urn:uuid:changed-other"),
		good.replace("NOTE:first part", "NOTE:changed"),
		`not a vCard ${SERVER_TEXT}`,
	];
	for (const body of cases) {
		const { dav, service } = serviceFor();
		dav.verifyResult = [200, {}, body];
		await assert.rejects(execute(service, "add", { apply: true }), error => {
			assert.match(error.message, /was written, but verification failed/);
			assert.doesNotMatch(error.message, /PRIVATE-REMOTE-BODY/);
			return true;
		});
		assert.equal(dav.writes.length, 1);
		assert.equal(dav.getCount, 2);
	}
});

test("verification protects unrelated member parameters but allows REV and folding changes", async () => {
	const first = serviceFor();
	first.dav.before = groupCard().replace("X-ADDRESSBOOKSERVER-MEMBER:", "X-ADDRESSBOOKSERVER-MEMBER;X-LABEL=keep:");
	first.dav.verifyResult = [200, {}, addedCard(first.dav.before).replace(";X-LABEL=keep", "")];
	await assert.rejects(execute(first.service, "add", { apply: true }), /was written, but verification failed/);

	const second = serviceFor();
	let saved = addedCard(groupCard()).replace("REV:20260909T120000Z", "REV:20260909T130000Z");
	saved = saved.replace("NOTE:first part\r\n second part", "NOTE:first partsecond part");
	second.dav.verifyResult = [200, {}, saved];
	assert.equal((await execute(second.service, "add", { apply: true })).verified, true);
});

test("fresh GET failures and changed group identity prevent writes", async () => {
	for (const [before, status] of [
		[groupCard(), 404], [contactCard(), 200], [groupCard({ uid: "new-uid" }), 200], ["bad card", 200],
	]) {
		const dav = new FakeDav(before);
		dav.freshStatus = status;
		await assert.rejects(execute(new GroupService(USERNAME, dav.transport), "add", { apply: true }));
		assert.deepEqual(dav.writes, []);
	}
});

test("renamed groups, duplicate groups, and duplicate contacts fail closed", async () => {
	const renamed = serviceFor();
	renamed.dav.before = groupCard({ name: "Feed" });
	await assert.rejects(execute(renamed.service, "add", { apply: true }), /identity changed/);
	assert.deepEqual(renamed.dav.writes, []);

	const duplicateGroup = serviceFor();
	duplicateGroup.dav.groups[BOOK].push([`${BOOK}duplicate.vcf`, groupCard({ uid: "different-uid" })]);
	await assert.rejects(execute(duplicateGroup.service, "add", { apply: true }), /Group missing or ambiguous/);
	assert.deepEqual(duplicateGroup.dav.writes, []);

	for (const selector of [{ email: EMAIL }, { email: undefined, contactUid: UID }]) {
		const duplicateContact = serviceFor();
		duplicateContact.dav.contacts[BOOK].push([`${BOOK}duplicate.vcf`, contactCard()]);
		await assert.rejects(duplicateContact.service.execute({ action: "add", group: "Paperwork", apply: true, ...selector }), /Contact missing or ambiguous/);
		assert.deepEqual(duplicateContact.dav.writes, []);
	}
});

test("cross-book memberships are refused", async () => {
	const { dav, service } = serviceFor();
	dav.books.push(SECOND_BOOK);
	dav.contacts = { [SECOND_BOOK]: [[`${SECOND_BOOK}contact.vcf`, contactCard()]] };
	await assert.rejects(execute(service, "add", { apply: true }), /different address books/);
	assert.deepEqual(dav.writes, []);
	assert.equal(dav.getCount, 0);
});

test("group and contact matching use full Unicode case folding", async () => {
	const { dav, service } = serviceFor();
	dav.groups[BOOK] = [[GROUP_URL, groupCard({ name: "Straße" })]];
	dav.contacts[BOOK] = [[CONTACT_URL, contactCard({ email: "straße@example.test" })]];
	const result = await service.execute({ action: "get", group: "STRASSE", email: "STRASSE@example.test" });
	assert.equal(result.group.name, "Straße");
	assert.equal(result.contact.emails[0], "straße@example.test");
});

test("contact matching is exact and case-insensitive", async () => {
	const { dav, service } = serviceFor();
	dav.contacts[BOOK] = [
		[CONTACT_URL, contactCard({ email: EMAIL.toUpperCase() })],
		[`${BOOK}prefix.vcf`, contactCard({ uid: "prefix", email: `x${EMAIL}` })],
		[`${BOOK}suffix.vcf`, contactCard({ uid: "suffix", email: `${EMAIL}.evil` })],
	];
	const result = await execute(service);
	assert.equal(result.contact.uid, UID);
	const report = dav.calls.filter(([method]) => method === "REPORT").at(-1);
	assert.match(report[2], /match-type="equals"/);
	assert.match(report[2], new RegExp(`>${EMAIL}<`));
});

test("exact UID selector works without email; fuzzy selectors do not", async () => {
	const exact = serviceFor();
	const result = await exact.service.execute({ action: "add", group: "group-uid", contactUid: UID });
	assert.equal(result.contact.uid, UID);
	for (const [selector, card] of [
		[{ email: EMAIL }, contactCard({ email: `x${EMAIL}` })],
		[{ contactUid: UID }, contactCard({ uid: `${UID}x` })],
		[{ contactUid: UID, email: EMAIL }, contactCard({ email: "wrong@example.test" })],
	]) {
		const candidate = serviceFor();
		candidate.dav.contacts[BOOK] = [[CONTACT_URL, card]];
		await assert.rejects(candidate.service.execute({ action: "add", group: "Paperwork", apply: true, ...selector }), /Contact missing or ambiguous/);
		assert.deepEqual(candidate.dav.writes, []);
	}
});

test("list and get are read-only", async () => {
	const { dav, service } = serviceFor();
	const list = await service.execute({ action: "list" });
	assert.equal(list.total, 1);
	assert.equal(list.groups[0].uid, "group-uid");
	const get = await execute(service, "get");
	assert.equal(get.isMember, false);
	assert.deepEqual(dav.writes, []);
	assert.equal(dav.getCount, 0);
});

test("folded members can be removed and long additions fold at 75 UTF-8 bytes", async () => {
	const folded = `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${UID.slice(0, 20)}\r\n ${UID.slice(20)}\r\n`;
	const removal = serviceFor();
	removal.dav.before = groupCard().replace("END:VCARD", `${folded}END:VCARD`);
	assert.equal((await execute(removal.service, "remove", { apply: true })).verified, true);
	assert.equal(removal.dav.saved, groupCard());

	const longUid = `long-${"a".repeat(160)}`;
	const addition = serviceFor();
	addition.dav.contacts[BOOK] = [[CONTACT_URL, contactCard({ uid: longUid })]];
	const result = await addition.service.execute({ action: "add", group: "Paperwork", contactUid: longUid, apply: true });
	assert.equal(result.verified, true);
	assert(parseCard(addition.dav.saved).members.includes(`urn:uuid:${longUid}`));
	assert(addition.dav.saved.split(/\r?\n/).every(line => Buffer.byteLength(line) <= 75));
});

test("unsafe discovery URLs are rejected before follow-up requests", async () => {
	const hrefs = [
		"https://evil.example/dav/addressbooks/user/test/book/", "//evil.example/dav/addressbooks/user/test/book/",
		"http://carddav.fastmail.com/dav/addressbooks/user/test/book/", "https://user:password@carddav.fastmail.com/dav/addressbooks/user/test/book/",
		"https://carddav.fastmail.com.evil.example/dav/addressbooks/user/test/book/", "/unrelated/path/",
		`${BOOK}?query=1`, `${BOOK}#fragment`, `${BOOK}%2e%2e/secret`, `${BOOK}%5csecret`, `${BOOK}%0asecret`,
	];
	for (const href of hrefs) {
		let calls = 0;
		const transport = () => { calls += 1; return [207, {}, multistatus([[href, null]])]; };
		await assert.rejects(new GroupService(USERNAME, transport).execute({ action: "list" }), /unexpected CardDAV resource URL/);
		assert.equal(calls, 1);
	}
});

test("REPORT resources outside their selected book are rejected", async () => {
	for (const href of [`${SECOND_BOOK}group.vcf`, `${BOOK.slice(0, -1)}-evil/group.vcf`]) {
		const { dav, service } = serviceFor();
		dav.groups[BOOK] = [[href, groupCard()]];
		await assert.rejects(execute(service, "add", { apply: true }), /outside its address book/);
		assert.deepEqual(dav.writes, []);
	}
});

test("unsafe, malformed, and incomplete XML are refused without leaking bodies", async () => {
	const valid = multistatus([[BOOK, null]]);
	const cases = [
		`<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///do-not-read">]>${valid}`,
		`<!ENTITY secret "private">${valid}`, "<multistatus", `<html>${SERVER_TEXT}</html>`,
		valid.replace("200 OK", "404 Not Found"),
		`<d:multistatus xmlns:d="${DAV}"><d:response><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>`,
		`<d:multistatus xmlns:d="${DAV}"><d:response><d:href>${BOOK}</d:href></d:response></d:multistatus>`,
	];
	for (const body of cases) {
		let calls = 0;
		const transport = () => { calls += 1; return [207, {}, body]; };
		await assert.rejects(new GroupService(USERNAME, transport).execute({ action: "list" }), error => {
			assert.doesNotMatch(error.message, /PRIVATE-REMOTE-BODY/);
			return true;
		});
		assert.equal(calls, 1);
	}
});

test("missing vCards and non-multistatus HTTP responses are refused", async () => {
	let index = 0;
	const missing = [
		[207, {}, multistatus([[BOOK, null]])],
		[207, {}, multistatus([[GROUP_URL, null]])],
	];
	await assert.rejects(new GroupService(USERNAME, () => missing[index++]).execute({ action: "list" }), /omitted vCard data/);
	for (const status of [200, 302, 500]) {
		let calls = 0;
		const transport = () => { calls += 1; return [status, { Location: "https://evil.example" }, SECRET + SERVER_TEXT]; };
		await assert.rejects(new GroupService(USERNAME, transport).execute({ action: "list" }), error => {
			assert.match(error.message, /Unexpected CardDAV PROPFIND response/);
			assert.doesNotMatch(error.message, new RegExp(`${SECRET}|${SERVER_TEXT}`));
			return true;
		});
		assert.equal(calls, 1);
	}
});

test("configured service rejects missing and malformed credentials without network", () => {
	for (const config of [
		{ username: USERNAME }, { username: "", appPassword: SECRET },
		{ username: "user:bad", appPassword: SECRET },
		{ username: "user\n", appPassword: SECRET },
		{ username: "  ", appPassword: SECRET },
	]) {
		assert.throws(() => createConfiguredService(config), ContactGroupsError);
	}
});

test("HTTP client sends authenticated UTF-8 requests and preserves If-Match", async () => {
	const calls = [];
	const fetchImplementation = async (...args) => {
		calls.push(args);
		return new Response(null, { status: 204, headers: { ETag: '"new"' } });
	};
	const client = new HttpDav(USERNAME, SECRET, { fetchImplementation });
	const result = await client.request("PUT", GROUP_URL, "FN:René", { "If-Match": '"fresh"' });
	assert.deepEqual(result, [204, { etag: '"new"' }, ""]);
	assert.equal(calls.length, 1);
	const [url, options] = calls[0];
	assert.equal(url, GROUP_URL);
	assert.equal(options.method, "PUT");
	assert.equal(options.body, "FN:René");
	assert.equal(options.headers["If-Match"], '"fresh"');
	assert.equal(options.headers.Authorization, client.authorization);
	assert.equal(options.redirect, "manual");
});

test("HTTP cancellation preserves the caller's abort reason", async () => {
	const controller = new AbortController();
	controller.abort();
	const client = new HttpDav(USERNAME, SECRET, {
		signal: controller.signal,
		fetchImplementation: async (_url, options) => { throw options.signal.reason; },
	});
	await assert.rejects(client.request("GET", GROUP_URL), error => error.name === "AbortError");
});

test("HTTP errors are sanitized, not retried, and cancel response bodies", async () => {
	for (const status of [301, 302, 307, 308, 401, 403, 412, 500]) {
		let calls = 0;
		let cancellations = 0;
		const body = new ReadableStream({
			start(stream) { stream.enqueue(new TextEncoder().encode(SECRET + SERVER_TEXT)); },
			cancel() { cancellations += 1; },
		});
		const fetchImplementation = async () => {
			calls += 1;
			return new Response(body, { status });
		};
		const client = new HttpDav(USERNAME, SECRET, { fetchImplementation });
		await assert.rejects(client.request("PUT", GROUP_URL, "body", { "If-Match": '"fresh"' }), error => {
			assert.match(error.message, new RegExp(String(status)));
			assert.doesNotMatch(error.message, new RegExp(`${SECRET}|${SERVER_TEXT}`));
			return true;
		});
		assert.equal(calls, 1);
		assert.equal(cancellations, 1);
	}
});

test("HTTP network and decoding errors are sanitized", async () => {
	for (const fetchImplementation of [
		async () => { throw new Error(SECRET + SERVER_TEXT); },
		async () => new Response(Uint8Array.from([0xff]), { status: 200 }),
	]) {
		const client = new HttpDav(USERNAME, SECRET, { fetchImplementation });
		await assert.rejects(client.request("GET", GROUP_URL), error => {
			assert.match(error.message, /network\/encoding error/);
			assert.doesNotMatch(error.message, new RegExp(`${SECRET}|${SERVER_TEXT}`));
			return true;
		});
	}
});

test("HTTP rejects unsafe URLs before fetch and cancels declared oversized responses", async () => {
	let calls = 0;
	let cancellations = 0;
	const body = new ReadableStream({
		start(stream) { stream.enqueue(new TextEncoder().encode("x".repeat(17))); },
		cancel() { cancellations += 1; },
	});
	const client = new HttpDav(USERNAME, SECRET, {
		maxBytes: 16,
		fetchImplementation: async () => {
			calls += 1;
			return new Response(body, { status: 200, headers: { "Content-Length": "17" } });
		},
	});
	await assert.rejects(client.request("GET", `https://evil.example/${SECRET}`), /unexpected CardDAV resource URL/);
	assert.equal(calls, 0);
	await assert.rejects(client.request("GET", GROUP_URL), /safety limit/);
	assert.equal(calls, 1);
	assert.equal(cancellations, 1);
});

test("HTTP decoding retains a UTF-8 BOM so vCard parsing fails closed", async () => {
	const encoded = new TextEncoder().encode(groupCard());
	const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...encoded]);
	const client = new HttpDav(USERNAME, SECRET, {
		fetchImplementation: async () => new Response(bytes, { status: 200 }),
	});
	const [, , text] = await client.request("GET", GROUP_URL);
	assert.equal(text.codePointAt(0), 0xfeff);
	assert.throws(() => parseCard(text), ContactGroupsError);
});

test("checkedUrl accepts only the Fastmail CardDAV origin and path", () => {
	assert.equal(checkedUrl(GROUP_URL), GROUP_URL);
	assert.throws(() => checkedUrl("https://evil.example/dav/addressbooks/user/x/"), ContactGroupsError);
});
