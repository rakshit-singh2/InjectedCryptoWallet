import { describe, expect, it } from 'vitest';
import { normalizeChainId, normalizeRpcUrl } from '../../src/background/validation.js';
import { createTestWallet, setupUnlockedWallet } from './helpers.js';

describe('validation', () => {
  it('normalises chain IDs and rejects malformed values', () => {
    expect(normalizeChainId('0x89')).toBe('0x89');
    expect(normalizeChainId('0xAA36A7')).toBe('0xaa36a7');
    for (const bad of ['137', '0x', '0x01', '0x0', 'ox1', 1, `0x${(2n ** 53n).toString(16)}`]) {
      expect(() => normalizeChainId(bad)).toThrow();
    }
  });

  it('only accepts https RPC URLs (http for loopback) without credentials', () => {
    expect(normalizeRpcUrl('https://rpc.example.com')).toBe('https://rpc.example.com');
    expect(normalizeRpcUrl('https://rpc.example.com/v1/abc')).toBe('https://rpc.example.com/v1/abc');
    expect(normalizeRpcUrl('http://localhost:8545')).toBe('http://localhost:8545');
    for (const bad of ['http://rpc.example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@rpc.example.com', 'https://rpc.example.com/#x', 'not a url']) {
      expect(() => normalizeRpcUrl(bad)).toThrow();
    }
  });
});

describe('NetworkController', () => {
  it('ships built-in networks with fixed chain IDs and no API keys', async () => {
    const { wallet } = await setupUnlockedWallet();
    const networks = await wallet.network.getNetworks();
    expect(Object.keys(networks)).toEqual(['0x1', '0xaa36a7', '0x89', '0x13882']);
    expect(JSON.stringify(networks)).not.toMatch(/infura|v3\/[0-9a-f]{32}/i);
    expect(await wallet.network.getSelectedChainId()).toBe('0x1');
  });

  it('refreshes saved built-in networks from code but never touches custom networks', async () => {
    const { wallet, chrome } = createTestWallet();
    await wallet.network.getNetworks();
    const saved = chrome.storage.local.dump().networks;
    await chrome.storage.local.set({
      networks: {
        ...saved,
        '0x89': { ...saved['0x89'], rpcUrl: 'https://polygon-rpc.com' }, // the old, now key-gated endpoint
        '0x7a69': { chainId: '0x7a69', name: 'Mine', ticker: 'MINE', rpcUrl: 'https://rpc.mine.example', blockExplorerUrl: '', builtIn: false },
      },
    });
    const networks = await wallet.network.getNetworks();
    expect(networks['0x89'].rpcUrl).toBe('https://polygon-bor-rpc.publicnode.com');
    expect(networks['0x7a69'].rpcUrl).toBe('https://rpc.mine.example');
    expect(chrome.storage.local.dump().networks['0x89'].rpcUrl).toBe('https://polygon-bor-rpc.publicnode.com');
  });

  it('verifies a custom network RPC reports the declared chain ID', async () => {
    const { wallet, rpc } = await setupUnlockedWallet({ rpc: { chainId: '0x539' } });
    const definition = { chainId: '0x539', name: 'Local', ticker: 'ETH', rpcUrl: 'http://127.0.0.1:8545', blockExplorerUrl: '' };
    await expect(wallet.network.addNetwork({ ...definition, chainId: '0x538' })).rejects.toThrow(/reports chain ID 0x539/);
    await wallet.popup.handle('addNetwork', definition);
    expect(rpc.calls.filter((call) => call.method === 'eth_chainId')).toHaveLength(2);
    await expect(wallet.popup.handle('addNetwork', definition)).rejects.toThrow(/already exists/);
  });

  it('cannot remove built-ins and falls back to Ethereum when the selected custom network is removed', async () => {
    const { wallet } = await setupUnlockedWallet({ rpc: { chainId: '0x539' } });
    await expect(wallet.popup.handle('removeNetwork', { chainId: '0x1' })).rejects.toThrow(/Built-in/);
    await wallet.popup.handle('addNetwork', { chainId: '0x539', name: 'Local', ticker: 'ETH', rpcUrl: 'http://127.0.0.1:8545' });
    await wallet.popup.handle('selectNetwork', { chainId: '0x539' });
    await wallet.popup.handle('removeNetwork', { chainId: '0x539' });
    expect(await wallet.network.getSelectedChainId()).toBe('0x1');
  });

  it('requires an unlocked wallet for network changes', async () => {
    const { wallet } = await setupUnlockedWallet();
    await wallet.vault.lock();
    await expect(wallet.popup.handle('selectNetwork', { chainId: '0x89' })).rejects.toThrow(/locked/);
  });
});
