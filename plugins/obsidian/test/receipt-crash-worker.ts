import { receiptsFixture } from './receipt-fixture.ts';

const [root, db, operationId, stopAfter, path] = process.argv.slice(2);
const { fs, ledger } = receiptsFixture(root, db);
if (stopAfter === 'intent') {
  const begin = ledger.begin.bind(ledger);
  ledger.begin = row => { begin(row); process.kill(process.pid, 'SIGKILL'); };
} else {
  ledger.finish = () => { process.kill(process.pid, 'SIGKILL'); };
}
await fs.commit({ mirrorId: 'one', revision: 1, path, operationId, expectedHash: null, text: 'Generated', kind: 'create' });
