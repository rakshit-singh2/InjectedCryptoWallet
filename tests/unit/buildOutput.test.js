import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(__dirname, '../../dist');
const built = existsSync(resolve(dist, 'manifest.json'));

// Run `npm run verify` (build + tests) to exercise these checks.
describe.skipIf(!built)('extension build output', () => {
  it('content scripts are self-contained classic scripts', () => {
    for (const file of ['content.js', 'provider.js']) {
      const source = readFileSync(resolve(dist, file), 'utf8');
      expect(source, file).not.toMatch(/(^|[;\n}])\s*import\s*[{*\w"']/);
      expect(source, file).not.toMatch(/(^|[;\n}])\s*export\s*[{*]/);
    }
  });

  it('manifest references files that exist and requests minimal permissions', () => {
    const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
    expect(existsSync(resolve(dist, manifest.background.service_worker))).toBe(true);
    for (const script of manifest.content_scripts) {
      for (const file of script.js) expect(existsSync(resolve(dist, file)), file).toBe(true);
    }
    expect(manifest.permissions.sort()).toEqual(['alarms', 'storage']);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  it('no API keys or secrets are bundled', () => {
    for (const file of ['popup.js', 'background.js']) {
      expect(readFileSync(resolve(dist, file), 'utf8'), file).not.toMatch(/infura\.io\/v3\/[0-9a-f]{32}/);
    }
  });
});
