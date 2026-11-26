import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { dkimSign } from 'mailauth';
import { renderMessage, inspectPage, mailtoRequest, verifyOneClick } from '../message.ts';
import { browserWorker, unsubscribeMessage } from '../unsubscribe.ts';
import { httpsTarget, isPublicAddress, WebFailure } from '../web.ts';

const signal = AbortSignal.timeout(5000);
const mailbox = 'reader@example.com';
const link = 'https://mail.example.com/remove?token=a,b';
const form = '<form method="post" action="/submit"><input type="hidden" name="token" value="x"><input type="email" name="email"><button>Unsubscribe</button></form>';
const success = '<h1>You have been unsubscribed.</h1>';
const failure = () => {};
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
  assert.equal((await unsubscribeMessage(source, { failure, web, verify: async () => false }, signal)).reason, 'one_click_signature_unverified');
  assert.deepEqual(calls, []);
  assert.deepEqual(await unsubscribeMessage(source, { failure, web, verify: async () => true }, signal),
    { status: 'request_sent', method: 'one_click', reason: 'one_click_accepted' });
  assert.deepEqual(calls, [link, 'List-Unsubscribe=One-Click']);
});

test('renders a footer link and submits a single simple confirmation form', async () => {
  const source = await message('', `<p>Newsletter</p><a href="${link}">Unsubscribe</a>`);
  let requests = 0;
  const receipt = await unsubscribeMessage(source, {
    failure,
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

test('hands a scripted page to the isolated worker and matches its job receipt', async () => {
  const source = await message(`List-Unsubscribe: <${link}>\r\n`);
  const worker = browserWorker('https://worker.example.com', 'x'.repeat(32), async (target, options) => {
    assert.equal(String(target), 'https://worker.example.com/jobs');
    assert.equal(options?.redirect, 'error');
    const job = JSON.parse(String(options?.body));
    assert.deepEqual(Object.keys(job).sort(), ['jobId', 'recipientEmail', 'url']);
    assert.equal(job.recipientEmail, mailbox);
    assert.equal(job.url, link);
    return Response.json({ jobId: job.jobId, status: 'confirmed' });
  });
  assert.ok(worker);
  const result = await unsubscribeMessage(source, { failure, browser: worker,
    web: async () => ({ status: 200, html: form + '<script></script>' }),
  }, signal);
  assert.deepEqual(result, { status: 'confirmed', method: 'browser', reason: 'sender_confirmed' });
});

test('reports when it needs the user, finds no method or receives no confirmation', async () => {
  assert.equal((await unsubscribeMessage(await message(''), { failure, web: async () => assert.fail() }, signal)).status, 'unavailable');
  const source = await message(`List-Unsubscribe: <${link}>\r\n`);
  assert.equal((await unsubscribeMessage(source, {
    failure, web: async () => ({ status: 200, html: '<form><input type="password"></form>' }),
  }, signal)).reason, 'login_or_challenge');
  assert.equal((await unsubscribeMessage(source, {
    failure, web: async () => ({ status: 200, html: form }),
  }, signal)).status, 'unverified');
});

test('sends an exact RFC 2369 mailto and rejects extra recipients and injected headers', async () => {
  const source = await message('List-Unsubscribe: <mailto:leave@example.com?subject=leave%20list&body=bye>\r\n');
  const result = await unsubscribeMessage(source, {
    failure, web: async () => assert.fail(), send: async (mail) => {
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
