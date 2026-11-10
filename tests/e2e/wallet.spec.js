import { Transaction, verifyMessage, verifyTypedData } from 'ethers';
import { test, expect, startCall, approvalWindow, LOCAL_CHAIN_ID } from './fixtures.js';

const PASSWORD = 'Correct-Horse-1';

test('injected provider, onboarding, connection, signing, chain add and transaction', async ({ context, extensionId, server }) => {
  const dappUrl = `http://localhost:${server.port}/`;
  const dapp = await context.newPage();
  await dapp.goto(dappUrl);

  // --- provider injection (MAIN world at document_start) and EIP-6963 announcement
  await expect.poll(() => dapp.evaluate(() => Boolean(window.ethereum?.isRakshitWallet))).toBe(true);
  await expect.poll(() => dapp.evaluate(() => window.__announced.map((info) => info.name))).toContain('Rakshit Wallet');
  expect(await dapp.evaluate(() => window.call('eth_chainId'))).toEqual({ result: '0x1' });
  expect(await dapp.evaluate(() => window.call('eth_accounts'))).toEqual({ result: [] });
  expect((await dapp.evaluate(() => window.call('eth_requestAccounts'))).error.code).toBe(4100);
  expect((await dapp.evaluate(() => window.call('eth_sign', []))).error.code).toBe(4200);
  // A page cannot reach the popup-only API through runtime messaging.
  expect(await dapp.evaluate(() => typeof window.chrome?.runtime?.sendMessage)).not.toBe('function');

  // --- onboarding in the popup
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/index.html`);
  await popup.getByTestId('create-wallet-button').click();
  await popup.getByTestId('generate-seed-phrase-button').click();
  const phrase = await popup.getByTestId('generated-seed-phrase').innerText();
  expect(phrase.trim().split(/\s+/)).toHaveLength(12);
  await popup.getByTestId('seed-phrase-saved-checkbox').check();
  await popup.getByTestId('open-wallet-button').click();
  await popup.getByTestId('new-password-input').fill(PASSWORD);
  await popup.getByTestId('confirm-password-input').fill(PASSWORD);
  await popup.getByTestId('set-password-submit-button').click();
  await expect(popup.getByTestId('account-selector-button')).toBeVisible();

  // No secret material in the popup's web storage.
  const webStorage = await popup.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(webStorage).not.toContain(phrase.trim().split(/\s+/)[0] + ' ' + phrase.trim().split(/\s+/)[1]);
  expect(webStorage).not.toContain(PASSWORD);

  // --- connect: rejection first, then approval
  let result = await startCall(dapp, 'eth_requestAccounts');
  let approval = await approvalWindow(context);
  await expect(approval.getByTestId('approval-origin')).toContainText(`http://localhost:${server.port}`);
  await approval.getByTestId('approval-reject-button').click();
  expect((await result()).error.code).toBe(4001);

  result = await startCall(dapp, 'eth_requestAccounts');
  approval = await approvalWindow(context);
  await approval.getByTestId('approval-approve-button').click();
  const accounts = (await result()).result;
  expect(accounts).toHaveLength(1);
  const [account] = accounts;
  await expect.poll(() => dapp.evaluate(() => window.__events.filter((e) => e.name === 'accountsChanged').at(-1)?.payload)).toEqual([account]);

  // --- personal_sign
  result = await startCall(dapp, 'personal_sign', ['0x48656c6c6f2c20776f726c64', account]);
  approval = await approvalWindow(context);
  await expect(approval.getByTestId('approval-message')).toHaveText('Hello, world');
  await approval.getByTestId('approval-approve-button').click();
  expect(verifyMessage('Hello, world', (await result()).result)).toBe(account);

  // --- add + switch to a local chain served by the fake RPC
  result = await startCall(dapp, 'wallet_addEthereumChain', [{
    chainId: LOCAL_CHAIN_ID,
    chainName: 'Local Test Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [`http://127.0.0.1:${server.port}`],
  }]);
  approval = await approvalWindow(context);
  await expect(approval.getByText('Local Test Chain')).toBeVisible();
  await approval.getByTestId('approval-approve-button').click();
  expect(await result()).toEqual({ result: null });
  await expect.poll(() => dapp.evaluate(() => window.ethereum.chainId)).toBe(LOCAL_CHAIN_ID);
  await expect.poll(() => dapp.evaluate(() => window.__events.some((e) => e.name === 'chainChanged' && e.payload === '0x539'))).toBe(true);
  // read pass-through goes to the selected network's RPC
  expect(await dapp.evaluate(() => window.call('eth_blockNumber'))).toEqual({ result: '0x2a' });

  // --- eth_sendTransaction: reject never broadcasts, approve signs the displayed tx
  const tx = { from: account, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', value: '0x2386f26fc10000' };
  result = await startCall(dapp, 'eth_sendTransaction', [tx]);
  approval = await approvalWindow(context);
  await approval.getByTestId('approval-reject-button').click();
  expect((await result()).error.code).toBe(4001);
  expect(server.broadcasts).toHaveLength(0);

  result = await startCall(dapp, 'eth_sendTransaction', [tx]);
  approval = await approvalWindow(context);
  await expect(approval.getByText('0.01 ETH').first()).toBeVisible();
  await approval.getByTestId('approval-approve-button').click();
  const hash = (await result()).result;
  expect(server.broadcasts).toHaveLength(1);
  const signed = Transaction.from(server.broadcasts[0]);
  expect(signed.hash).toBe(hash);
  expect(signed.chainId).toBe(1337n);
  expect(signed.from).toBe(account);
  expect(signed.to).toBe(tx.to);
  expect(signed.value).toBe(10n ** 16n);

  // --- eth_signTypedData_v3 (array-free EIP-712)
  const v3 = {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }],
      Mail: [{ name: 'contents', type: 'string' }],
    },
    primaryType: 'Mail',
    domain: { name: 'E2E', chainId: 1337 },
    message: { contents: 'v3 hello' },
  };
  result = await startCall(dapp, 'eth_signTypedData_v3', [account, JSON.stringify(v3)]);
  approval = await approvalWindow(context);
  await expect(approval.getByTestId('approval-message')).toContainText('v3 hello');
  await approval.getByTestId('approval-approve-button').click();
  expect(verifyTypedData(v3.domain, { Mail: v3.types.Mail }, v3.message, (await result()).result)).toBe(account);

  // --- EIP-5792: capabilities, then a sequential two-call batch
  expect(await dapp.evaluate((a) => window.call('wallet_getCapabilities', [a, ['0x539']]), account)).toEqual({
    result: { '0x539': { atomic: { status: 'unsupported' } } },
  });
  const carol = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
  result = await startCall(dapp, 'wallet_sendCalls', [{
    version: '2.0.0',
    chainId: LOCAL_CHAIN_ID,
    from: account,
    atomicRequired: false,
    calls: [{ to: tx.to, value: '0x1' }, { to: carol, value: '0x2' }],
  }]);
  approval = await approvalWindow(context);
  await expect(approval.getByTestId('approval-batch-warning')).toBeVisible();
  await expect(approval.getByTestId('approval-batch-call-1')).toContainText(tx.to);
  await expect(approval.getByTestId('approval-batch-call-2')).toContainText(carol);
  await approval.getByTestId('approval-approve-button').click();
  const { id: batchId } = (await result()).result;
  await expect
    .poll(async () => (await dapp.evaluate((i) => window.call('wallet_getCallsStatus', [i]), batchId)).result?.status, { timeout: 20_000 })
    .toBe(200);
  const batchTxs = server.broadcasts.slice(1).map((raw) => Transaction.from(raw));
  expect(batchTxs.map((t) => [t.to, t.value, t.nonce])).toEqual([[tx.to, 1n, 1], [carol, 2n, 2]]);

  // --- Stop batch from the popup while the first call is unmined: the second is never sent
  server.control.holdReceipts = true;
  result = await startCall(dapp, 'wallet_sendCalls', [{
    version: '2.0.0',
    chainId: LOCAL_CHAIN_ID,
    from: account,
    atomicRequired: false,
    calls: [{ to: tx.to, value: '0x3' }, { to: carol, value: '0x4' }],
  }]);
  approval = await approvalWindow(context);
  await approval.getByTestId('approval-approve-button').click();
  const { id: stoppedId } = (await result()).result;
  await expect.poll(() => server.broadcasts.length).toBe(4);
  await popup.reload();
  const dappKey = encodeURIComponent(`http://localhost:${server.port}`);
  await expect(popup.getByTestId(`running-batch-${dappKey}`)).toContainText('0 of 2 confirmed, 1 sent');
  await popup.getByTestId(`stop-batch-button-${dappKey}`).click();
  await expect(popup.getByTestId(`running-batch-${dappKey}`)).toHaveCount(0);
  server.control.holdReceipts = false;
  await expect
    .poll(async () => (await dapp.evaluate((i) => window.call('wallet_getCallsStatus', [i]), stoppedId)).result?.status, { timeout: 20_000 })
    .toBe(600);
  expect(server.broadcasts).toHaveLength(4);

  // --- settings: auto-lock duration persists
  await popup.reload();
  await popup.getByTestId('settings-button').click();
  await popup.getByTestId('auto-lock-select').selectOption('5');
  await expect(popup.getByText('Auto-lock set to 5 min')).toBeVisible();
  await popup.reload();
  await popup.getByTestId('settings-button').click();
  await expect(popup.getByTestId('auto-lock-select')).toHaveValue('5');
  await popup.getByTestId('settings-back-button').click();

  // --- lock from the popup: dApp loses accounts via the state-change broadcast
  await popup.reload();
  await popup.getByTestId('lock-wallet-button').click();
  await expect(popup.getByTestId('wallet-password-input')).toBeVisible();
  await expect.poll(() => dapp.evaluate(() => window.__events.filter((e) => e.name === 'accountsChanged').at(-1)?.payload)).toEqual([]);
  expect(await dapp.evaluate(() => window.call('eth_accounts'))).toEqual({ result: [] });

  // --- reconnect while locked prompts unlock inside the approval window
  result = await startCall(dapp, 'eth_requestAccounts');
  approval = await approvalWindow(context);
  await approval.getByTestId('wallet-password-input').fill(PASSWORD);
  await approval.getByTestId('unlock-wallet-button').click();
  await approval.getByTestId('approval-approve-button').click();
  expect((await result()).result).toEqual([account]);

  // --- revoke from the Connected Sites screen
  await popup.reload();
  await popup.getByTestId('connected-sites-button').click();
  await popup.getByTestId(`revoke-connection-${encodeURIComponent(`http://localhost:${server.port}`)}`).click();
  await expect.poll(() => dapp.evaluate(() => window.call('eth_accounts'))).toEqual({ result: [] });
});

test('closing the approval window rejects the request', async ({ context, extensionId, server }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/index.html`);
  await popup.getByTestId('recover-wallet-button').click();
  await popup.getByTestId('recover-seed-phrase-input').fill('test test test test test test test test test test test junk');
  await popup.getByTestId('recover-wallet-submit-button').click();
  await popup.getByTestId('new-password-input').fill(PASSWORD);
  await popup.getByTestId('confirm-password-input').fill(PASSWORD);
  await popup.getByTestId('set-password-submit-button').click();
  await expect(popup.getByTestId('account-selector-button')).toBeVisible();

  const dapp = await context.newPage();
  await dapp.goto(`http://localhost:${server.port}/`);
  await expect.poll(() => dapp.evaluate(() => Boolean(window.ethereum))).toBe(true);
  const result = await startCall(dapp, 'eth_requestAccounts');
  const approval = await approvalWindow(context);
  await approval.close();
  expect((await result()).error.code).toBe(4001);
});

test('provider injects and announces on a non-secure http origin', async ({ context, extensionId, server }) => {
  expect(extensionId).toBeTruthy();
  const page = await context.newPage();
  await page.goto(`http://insecure.test:${server.port}/`);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  await expect.poll(() => page.evaluate(() => Boolean(window.ethereum?.isRakshitWallet))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__announced[0]?.uuid)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(await page.evaluate(() => window.call('eth_chainId'))).toEqual({ result: '0x1' });
});

test('service-worker termination mid-approval fails closed and keeps the session', async ({ context, extensionId, server }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/index.html`);
  await popup.getByTestId('recover-wallet-button').click();
  await popup.getByTestId('recover-seed-phrase-input').fill('test test test test test test test test test test test junk');
  await popup.getByTestId('recover-wallet-submit-button').click();
  await popup.getByTestId('new-password-input').fill(PASSWORD);
  await popup.getByTestId('confirm-password-input').fill(PASSWORD);
  await popup.getByTestId('set-password-submit-button').click();
  await expect(popup.getByTestId('account-selector-button')).toBeVisible();

  const dapp = await context.newPage();
  await dapp.goto(`http://localhost:${server.port}/`);
  await expect.poll(() => dapp.evaluate(() => Boolean(window.ethereum))).toBe(true);
  let result = await startCall(dapp, 'eth_requestAccounts');
  let approval = await approvalWindow(context);
  await approval.getByTestId('approval-approve-button').click();
  const [account] = (await result()).result;

  result = await startCall(dapp, 'personal_sign', ['0x6869', account]);
  approval = await approvalWindow(context);

  // Kill the extension service worker while the signature prompt is open.
  const cdp = await context.newCDPSession(popup);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');

  const outcome = await result();
  expect(outcome.error.code).toBe(4900); // relay port dropped -> fail closed, nothing signed

  // The restarted worker discards the orphaned prompt; approving is no longer possible.
  await expect.poll(async () => approval.isClosed() || (await approval.getByTestId('approval-approve-button').count()) === 0, { timeout: 10_000 }).toBe(true);

  // The session key in chrome.storage.session survives the restart: still unlocked and connected.
  await expect.poll(() => dapp.evaluate(() => window.call('eth_accounts'))).toEqual({ result: [account] });
});
