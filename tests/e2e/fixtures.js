import { test as base, chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Transaction } from 'ethers';

export const LOCAL_CHAIN_ID = '0x539'; // 1337

const DAPP_HTML = `<!doctype html><html><head><title>Test dApp</title></head><body>
<h1>Test dApp</h1>
<script>
  window.__events = [];
  window.__announced = [];
  window.addEventListener('eip6963:announceProvider', (e) => window.__announced.push(e.detail.info));
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  function attach() {
    if (!window.ethereum || window.__attached) return;
    window.__attached = true;
    for (const name of ['accountsChanged', 'chainChanged', 'connect', 'disconnect']) {
      window.ethereum.on(name, (payload) => window.__events.push({ name, payload: name === 'disconnect' ? payload?.code : payload }));
    }
  }
  attach();
  window.addEventListener('ethereum#initialized', attach);
  window.call = (method, params) => window.ethereum.request({ method, params }).then(
    (result) => ({ result }),
    (error) => ({ error: { code: error.code, message: error.message } }),
  );
</script></body></html>`;

/** A tiny HTTP server: serves the dApp page and a fake JSON-RPC node for chain 1337. */
export function startServer() {
  const broadcasts = [];
  const control = { holdReceipts: false }; // tests set this to keep transactions unmined
  const server = createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(DAPP_HTML);
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      const results = {
        eth_chainId: LOCAL_CHAIN_ID,
        eth_blockNumber: '0x2a',
        eth_getBalance: '0xde0b6b3a7640000',
        eth_estimateGas: '0x5208',
        eth_maxPriorityFeePerGas: '0x3b9aca00',
        eth_getBlockByNumber: { number: '0x2a', baseFeePerGas: '0x77359400' },
        eth_getTransactionCount: `0x${broadcasts.length.toString(16)}`,
      };
      // Every broadcast is "mined" immediately and succeeds.
      const mined = broadcasts.map((raw) => Transaction.from(raw).hash);
      if (method === 'eth_getTransactionReceipt' && mined.includes(params[0]) && !control.holdReceipts) {
        results.eth_getTransactionReceipt = {
          transactionHash: params[0],
          blockHash: `0x${'ab'.repeat(32)}`,
          blockNumber: '0x2b',
          gasUsed: '0x5208',
          status: '0x1',
          logs: [],
        };
      }
      let payload;
      if (method === 'eth_sendRawTransaction') {
        broadcasts.push(params[0]);
        payload = { jsonrpc: '2.0', id, result: Transaction.from(params[0]).hash };
      } else if (method in results) {
        payload = { jsonrpc: '2.0', id, result: results[method] };
      } else {
        payload = { jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported ${method}` } };
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify(payload));
    });
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({
        port,
        broadcasts,
        control,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      });
    });
  });
}

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  server: async ({}, use) => {
    const server = await startServer();
    await use(server);
    await server.close();
  },
  context: async ({ channel }, use, testInfo) => {
    const extensionPath = resolve(process.cwd(), 'dist');
    const userDataDir = mkdtempSync(join(tmpdir(), 'wallet-e2e-'));
    const launchOptions = testInfo.project.use.launchOptions || {};
    let context;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        channel,
        headless: true,
        ...launchOptions,
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
          // An origin that is NOT a secure context (unlike localhost), to exercise plain-http sites.
          '--host-resolver-rules=MAP insecure.test 127.0.0.1',
        ],
      });
    } catch (error) {
      rmSync(userDataDir, { recursive: true, force: true });
      testInfo.skip(true, `${testInfo.project.name}: browser not available (${error.message.split('\n')[0]})`);
      return;
    }
    testInfo.annotations.push({ type: 'browser', description: `${testInfo.project.name} ${context.browser()?.version() ?? ''}`.trim() });
    await use(context);
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  },
  extensionId: async ({ context }, use, testInfo) => {
    let [worker] = context.serviceWorkers();
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
    }
    if (!worker) {
      testInfo.skip(true, `${testInfo.project.name}: extension did not load (branded Chrome 137+ ignores --load-extension)`);
      return;
    }
    await use(new URL(worker.url()).host);
  },
});

/** Runs a provider call in the page without awaiting it, so a test can drive the approval window. */
export async function startCall(page, method, params) {
  const key = `__call_${Math.random().toString(36).slice(2)}`;
  await page.evaluate(([k, m, p]) => {
    window[k] = window.call(m, p);
  }, [key, method, params]);
  return () => page.evaluate((k) => window[k], key);
}

/** Returns the approval window once it is showing a pending request (skips windows that are closing). */
export async function approvalWindow(context, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (page.isClosed() || !page.url().includes('#/approval')) continue;
      const ready = await page
        .getByTestId('approval-reject-button')
        .isVisible()
        .catch(() => false);
      if (ready) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Approval window did not show a pending request');
}

export { expect };
