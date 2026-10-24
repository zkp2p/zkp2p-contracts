require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { constants, VoidSigner } = require('ethers');
const { CanonicalJsonRpcProvider } = require('./canonical-receipts.ts');
const { TransactionJournal } = require('./deploy-orchestrator-v4.ts');
const receipt = require('./fixtures/base-curator-funding-receipt.json');

test('a Base preconfirmation cannot enter the journal; the same sealed transaction recovers without signing', async () => {
  let sealed = false;
  let observePendingReceipt;
  const methods = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    methods.push(rpc.method);
    let result;
    switch (rpc.method) {
      case 'eth_chainId': result = '0x2105'; break;
      case 'eth_blockNumber': result = `0x${(Number(receipt.blockNumber) + (sealed ? 3 : 2)).toString(16)}`; break;
      case 'eth_getTransactionReceipt':
        assert.deepEqual(rpc.params, [receipt.transactionHash]);
        result = { ...receipt, blockHash: sealed ? receipt.blockHash : constants.HashZero };
        if (!sealed && observePendingReceipt) observePendingReceipt();
        break;
      default: assert.fail(`Unexpected RPC during receipt recovery: ${rpc.method}`);
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'canonical-receipt-'));
  const path = join(directory, 'manifest.json');
  const provider = new CanonicalJsonRpcProvider(`http://127.0.0.1:${server.address().port}`);
  provider.pollingInterval = 10;
  const transaction = {
    step: 'fund-group-curator', hash: receipt.transactionHash, nonce: 49,
    to: '0x469dE3A098C6530E2842a538832eC0609D6c988d', data: '0x',
    value: '12000000000000', receipt: null,
  };
  const manifest = { configuration: { chainId: 8453 }, transactions: [transaction] };
  const signer = new VoidSigner('0x41123d6419C7b8e44157f6F3b0088442116641eC', provider);
  const journal = new TransactionJournal(path, manifest, signer);
  try {
    await assert.rejects(journal.execute(transaction.step, transaction), /Missing signed journal/);
    assert.equal(transaction.receipt, null);
    assert.equal(existsSync(path), false);
    const pendingObserved = new Promise((resolve) => { observePendingReceipt = resolve; });
    let confirmed = false;
    const waiting = provider.waitForTransaction(transaction.hash, 1, 5_000).then((result) => {
      confirmed = true;
      return result;
    });
    await pendingObserved;
    assert.equal(confirmed, false);
    sealed = true;
    assert.equal((await waiting).blockHash, receipt.blockHash);
    assert.equal(transaction.receipt, null);
    await journal.execute(transaction.step, transaction);
    assert.equal(transaction.receipt.blockHash, '0x7369bae26124ff72e3ae4660c93e679c47b907042a427afa438dbd294fe33d75');
    assert.equal(transaction.receipt.blockNumber, 52939787);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), manifest);
    assert.equal(methods.includes('eth_sendRawTransaction'), false);
  } finally {
    provider.removeAllListeners();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
