import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { dkimSign } from 'mailauth';
import { renderMessage, inspectPage, mailtoRequest, verifyOneClick } from '../message.ts';
import { unsubscribeMessage } from '../unsubscribe.ts';
import { httpsTarget, isPublicAddress, WebFailure } from '../web.ts';

const signal = AbortSignal.timeout(5000);
const mailbox = 'reader@example.com';
const link = 'https://mail.example.com/remove?token=a,b';
const form = '<form method="post" action="/submit"><input type="hidden" name="token" value="x"><input type="email" name="email"><button>Unsubscribe</button></form>';
const success = '<h1>You have been unsubscribed.</h1>';
const failure = () => {};
const noBrowser = { browser: async () => assert.fail('Unexpected browser fallback') };
const message = async (headers: string, html = '') => {
  const mime = Buffer.from(`From: lists@example.com\r\nTo: ${mailbox}\r\nContent-Type: text/html; charset=UTF-8\r\n${headers}\r\n${html}`).toString('base64');
  const rendered = await renderMessage(mime, mailbox);
  assert.ok(rendered);
  return rendered;
};

test('one-click requires signature evidence and preserves the exact token', async () => {
  const source = await message(`List-Unsubscribe: <mailto:remove@example.com>, <${link}>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n`);
  assert.equal(source.web, link);
  const calls: string[] = [];
  const web = async (url: URL, _: AbortSignal, data?: URLSearchParams) => {
    calls.push(url.href, String(data));
    return { status: 204, html: '' };
  };
  assert.equal((await unsubscribeMessage(source, { ...noBrowser, failure, web, verify: async () => false }, signal)).reason, 'one_click_signature_unverified');
  assert.deepEqual(calls, []);
  assert.deepEqual(await unsubscribeMessage(source, { ...noBrowser, failure, web, verify: async () => true }, signal),
    { status: 'request_sent', method: 'one_click', reason: 'one_click_accepted' });
  assert.deepEqual(calls, [link, 'List-Unsubscribe=One-Click']);
});

test('renders a footer link and submits a single simple confirmation form', async () => {
  const source = await message('', `<p>Newsletter</p><a href="${link}">Unsubscribe</a>`);
  let requests = 0;
  const receipt = await unsubscribeMessage(source, {
    ...noBrowser, failure,
    async web(url, _, data) {
      requests++;
      if (requests === 1) {
        assert.equal(url.href, link);
        assert.equal(data, undefined);
        return { status: 200, html: form };
      }
      assert.equal(url.href, 'https://mail.example.com/submit');
      assert.equal(data?.toString(), 'token=x&email=reader%40example.com');
      return { status: 200, html: success };
    },
  }, signal);
  assert.equal(requests, 2);
  assert.equal(receipt.status, 'confirmed');
  assert.equal(receipt.method, 'web_form');
});

test('does not run the browser or mailto after an uncertain form POST', async () => {
  const source = await message(`List-Unsubscribe: <${link}>, <mailto:remove@example.com>\r\n`);
  const outcome = await unsubscribeMessage(source, {
    failure,
    web: async (_url, _signal, data) => {
      if (data) throw new WebFailure('transport', true);
      return { status: 200, html: form };
    },
    browser: async () => assert.fail('Unexpected second attempt'),
    send: async () => assert.fail('Unexpected second attempt'),
  }, signal);
  assert.deepEqual(outcome, { status: 'unverified', method: 'web_form', reason: 'transport' });
});

test('reports when it needs the user, finds no method or receives no confirmation', async () => {
  assert.equal((await unsubscribeMessage(await message(''), { ...noBrowser, failure, web: async () => assert.fail() }, signal)).status, 'unavailable');
  const source = await message(`List-Unsubscribe: <${link}>\r\n`);
  assert.equal((await unsubscribeMessage(source, {
    ...noBrowser, failure, web: async () => ({ status: 200, html: '<form><input type="password"></form>' }),
  }, signal)).reason, 'login_or_challenge');
  assert.equal((await unsubscribeMessage(source, {
    ...noBrowser, failure, web: async () => ({ status: 200, html: form }),
  }, signal)).status, 'unverified');
});

test('sends an exact RFC 2369 mailto and rejects extra recipients and injected headers', async () => {
  const source = await message('List-Unsubscribe: <mailto:leave@example.com?subject=leave%20list&body=bye>\r\n');
  const result = await unsubscribeMessage(source, {
    ...noBrowser, failure, web: async () => assert.fail(), send: async (mail) => {
      assert.deepEqual(mail, { from: mailbox, to: 'leave@example.com', subject: 'leave list', body: 'bye' });
      return { status: 'request_sent' };
    },
  }, signal);
  assert.equal(result.status, 'request_sent');
  assert.equal(mailtoRequest('mailto:leave@example.com?bcc=other@example.com', mailbox), null);
  assert.equal(mailtoRequest('mailto:leave@example.com?subject=x%0aBcc%3Ay', mailbox), null);
});

test('refuses internal addresses and keeps broader forms out of the static submitter', () => {
  for (const url of ['https://169.254.169.254/x', 'https://internal.local/x', 'https://a.com:444/x', 'http://a.com/x'])
    assert.equal(httpsTarget(url), null);
  for (const ip of ['10.1.2.3', '169.254.169.254', '127.0.0.1', '100.64.0.1', '::1', '192.0.0.1'])
    assert.equal(isPublicAddress(ip), false);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(inspectPage(form.replace('Unsubscribe', 'Unsubscribe from all'), new URL(link), mailbox).kind, 'browser');
  assert.equal(inspectPage(form.replace('/submit', 'https://another.example.com/submit'), new URL(link), mailbox).kind, 'browser');
});

test('verifies both one-click headers against an actual DKIM signature', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const raw = Buffer.from(
    `From: News <lists@example.com>\r\nTo: ${mailbox}\r\nList-Unsubscribe: <${link}>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nNews\r\n`,
  );
  const lookup = async (name: string) => {
    assert.equal(name, 'selector._domainkey.example.com');
    const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    return [[`v=DKIM1; k=rsa; p=${key}`]];
  };
  const signed = await dkimSign(raw, {
    headerList: 'From:List-Unsubscribe:List-Unsubscribe-Post',
    signatureData: [{ signingDomain: 'example.com', selector: 'selector', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }],
  });
  assert.equal(await verifyOneClick(Buffer.concat([Buffer.from(signed.signatures), raw]), signal, lookup), true);
  const altered = raw.toString().replace('token=a,b', 'token=changed');
  assert.equal(await verifyOneClick(Buffer.from(signed.signatures + altered), signal, lookup), false);
});

test('an unverified one-click signature falls back to a distinct footer link and browser subthread', async () => {
  const footer = 'https://links.example.com/leave?token=footer';
  const source = await message(
    `List-Unsubscribe: <${link}>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n`,
    `<p><a href="${footer}">Unsubscribe</a></p>`,
  );
  const page = 'https://lists.example.com/preferences';
  const visited: string[] = [];
  const result = await unsubscribeMessage(source, {
    failure, verify: async () => false,
    async web(url, _, body) {
      assert.equal(body, undefined);
      visited.push(url.href);
      if (url.href === footer) return { status: 302, html: '', location: page };
      assert.equal(url.href, page);
      return { status: 200, html: '<form><select><option>This list</option></select></form>' };
    },
    async browser(url, address) {
      assert.equal(url.href, page);
      assert.equal(address, mailbox);
      return { status: 'in_progress', method: 'browser', reason: 'browser_subthread_started', childThreadId: 'thr_example' };
    },
  }, signal);
  assert.deepEqual(visited, [footer, page]);
  assert.equal(result.status, 'in_progress');
  assert.equal(result.childThreadId, 'thr_example');
});

test('an explicitly labelled footer may share the header URL and only opens it as a web page', async () => {
  const raw = Buffer.from(
    `From: lists@example.com\r\nTo: ${mailbox}\r\nList-Unsubscribe: <${link}>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nNewsletter\r\nunsubscribe ( ${link} )\r\n`,
  );
  const source = await renderMessage(raw.toString('base64'), mailbox);
  assert.ok(source);
  assert.equal(source.footer, link);
  const result = await unsubscribeMessage(source, {
    ...noBrowser, failure, verify: async () => false,
    async web(url, _, body) {
      assert.equal(url.href, link);
      assert.equal(body, undefined);
      return { status: 200, html: success };
    },
  }, signal);
  assert.equal(result.method, 'web_link');
  assert.equal(result.status, 'confirmed');
});

test('parses mixed legacy URLs while preserving commas in the token', async () => {
  const source = await message(`List-Unsubscribe: mailto:remove@example.com, ${link}\r\n`);
  assert.equal(source.web, link);
  assert.equal(source.mail, 'mailto:remove@example.com');
  assert.equal(source.oneClick, false);
});

test('accepts public IPv6 over HTTPS and rejects nonpublic or mapped addresses', () => {
  assert.equal(httpsTarget('https://[2606:4700:4700::1111]/remove')?.hostname, '[2606:4700:4700::1111]');
  for (const host of ['fd00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '::1']) {
    assert.equal(httpsTarget(`https://[${host}]/remove`), null);
  }
});

test('never contacts an unsafe redirect or the skipped one-click endpoint', async () => {
  const footer = 'https://links.example.com/leave';
  const source = await message(
    `List-Unsubscribe: <${link}>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n`,
    `<a href="${footer}">Unsubscribe</a>`,
  );
  for (const location of [link, 'https://127.0.0.1/leave', footer, 'http://example.com/leave']) {
    const out = await unsubscribeMessage(source, {
      ...noBrowser, failure, verify: async () => false,
      async web(url) {
        assert.equal(url.href, footer);
        return { status: 302, html: '', location };
      },
    }, signal);
    assert.equal(out.reason, 'unsubscribe_redirect_unavailable');
  }
});

test('a definitive one-click rejection can reach a clear GET acknowledgment', async () => {
  const source = await message(`List-Unsubscribe: <${link}>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n`);
  const answer = await unsubscribeMessage(source, {
    ...noBrowser, failure, verify: async () => true,
    web: async (_, __, body) => body ? { status: 404, html: '' } : { status: 200, html: success },
  }, signal);
  assert.deepEqual(answer, { status: 'confirmed', method: 'web_link', reason: 'sender_confirmed' });
});

test('submits a simple GET form with only its active controls and verified address', async () => {
  const source = await message(`List-Unsubscribe: <${link}>\r\n`);
  const getForm = `<h1>Unsubscribe from the list</h1><form action="/done?ignore=1">
    <input type="hidden" name="token" value="a b">
    <input type="email" name="email" value="Reader@example.com">
    <input type="button" name="ignored" value="dismiss">
    <button type="button" name="action" value="cancel">Cancel</button>
    <button name="action" value="remove">Confirm</button></form>`;
  const result = await unsubscribeMessage(source, {
    ...noBrowser, failure,
    async web(url, _, body) {
      assert.equal(body, undefined);
      if (url.href === link) return { status: 200, html: getForm };
      assert.equal(url.href, 'https://mail.example.com/done?token=a+b&email=Reader%40example.com&action=remove');
      return { status: 200, html: success };
    },
  }, signal);
  assert.equal(result.method, 'web_form');
  assert.equal(result.status, 'confirmed');
  assert.equal(inspectPage(getForm.replace('Reader@example.com', 'another@example.com'), new URL(link), mailbox).kind, 'browser');
});

test('suppresses hidden confirmation text and defers ambiguous controls and challenges', () => {
  const at = new URL(link);
  assert.equal(inspectPage('<script>const answer = "You have been unsubscribed.";</script><template>' + success + '</template>', at).kind, 'browser');
  assert.equal(inspectPage('<form><div class="g-recaptcha"></div><button>Continue</button></form>', at).kind, 'blocked');
  assert.equal(inspectPage(form.replace('</form>', '<button>Keep subscription</button></form>'), at, mailbox).kind, 'browser');
  assert.equal(inspectPage('<form method="post"><input type="image" name="Unsubscribe"></form>', at, mailbox).kind, 'browser');
  assert.equal(inspectPage('<form method="post"><select name="scope"><option>This list only</option></select><button>Save</button></form>', at, mailbox).kind, 'browser');
});

test('uses the HTML rendition of a tracked footer and opens tokenized pages without an address', async () => {
  const raw = Buffer.from([
    'From: lists@example.com', 'To: alias@example.com', `List-Unsubscribe: <${link}>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click', 'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary=alt', '', '--alt',
    'Content-Type: text/plain', '', 'unsubscribe ( https://track.example.com/leave )',
    '--alt', 'Content-Type: text/html', '', `<a class="untracked" href="${link}">unsubscribe</a>`,
    '--alt--', '',
  ].join('\r\n'));
  const source = await renderMessage(raw.toString('base64'), mailbox);
  assert.ok(source);
  assert.equal(source.footer, link);
  assert.equal(source.recipient, undefined);
  const result = await unsubscribeMessage(source, {
    failure, verify: async () => false,
    async web(url, _, body) {
      assert.equal(url.href, link);
      assert.equal(body, undefined);
      return { status: 200, html: '<script></script><button>Confirm unsubscribe</button>' };
    },
    async browser(url, recipient) {
      assert.equal(url.href, link);
      assert.equal(recipient, undefined);
      return { status: 'in_progress', method: 'browser', reason: 'browser_subthread_started' };
    },
  }, signal);
  assert.equal(result.method, 'browser');
  assert.equal(result.status, 'in_progress');
});

test('two different clearly labelled HTML destinations are ambiguous even with a plain-text rendition', async () => {
  const raw = Buffer.from([
    'From: newsletters@example.org', `To: ${mailbox}`, 'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary=variants', '', '--variants',
    'Content-Type: text/plain', '', 'unsubscribe ( https://tracking.example.org/route )',
    '--variants', 'Content-Type: text/html', '',
    '<footer><a href="https://lists.example.org/weekly">Unsubscribe</a>',
    '<a href="https://lists.example.org/all">Unsubscribe</a></footer>', '--variants--', '',
  ].join('\r\n'));
  const source = await renderMessage(raw.toString('base64'), mailbox);
  assert.ok(source);
  const outcome = await unsubscribeMessage(source, {
    ...noBrowser, failure, web: async () => assert.fail('Unexpected destination selected'),
  }, signal);
  assert.deepEqual(outcome, { status: 'needs_user', reason: 'ambiguous_unsubscribe_links' });
});

test('an alias can use token-only confirmation but must never fill an address or send email', async () => {
  const raw = Buffer.from([
    'From: newsletter@example.org', 'Delivered-To: masked@example.org',
    `To: ${mailbox}`, 'List-Unsubscribe: <mailto:remove@example.org>', '', 'Newsletter',
  ].join('\r\n'));
  const source = await renderMessage(raw.toString('base64'), mailbox);
  assert.ok(source);
  assert.equal(source.recipient, undefined);
  const outcome = await unsubscribeMessage(source, {
    ...noBrowser, failure, web: async () => assert.fail(),
    send: async () => assert.fail('The tool must not guess a sending identity'),
  }, signal);
  assert.deepEqual(outcome, { method: 'mailto', status: 'needs_user', reason: 'recipient_not_verified' });

  const tokenForm = '<form method="post" action="/final"><input name="token" type="hidden" value="a+b"><button>Confirm unsubscribe</button></form>';
  assert.equal(inspectPage(tokenForm, new URL(link), source.recipient).kind, 'form');
  assert.equal(inspectPage(tokenForm.replace('<button>', '<input type="email" name="email"><button>'),
    new URL(link), source.recipient).kind, 'browser');
});
