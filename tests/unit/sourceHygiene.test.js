import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeText } from '../../src/background/validation.js';

const root = resolve(__dirname, '../..');
const BIDI_OR_INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(jsx?|cjs|json|html)$/.test(name)) yield path;
  }
}

describe('source hygiene', () => {
  it('contains no invisible or bidi-control characters (Trojan Source)', () => {
    const offenders = [];
    for (const dir of ['src', 'tests', 'public']) {
      for (const path of files(join(root, dir))) {
        if (BIDI_OR_INVISIBLE.test(readFileSync(path, 'utf8'))) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('rejects bidi overrides in user-visible names shown in approvals', () => {
    expect(() => normalizeText('Safe\u202eNetwork', 'name')).toThrow();
    expect(() => normalizeText('Line\nbreak', 'name')).toThrow();
    expect(normalizeText('  Polygon  ', 'name')).toBe('Polygon');
  });
});
