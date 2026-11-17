/**
 * Golden files: every .hl7 under testdata/golden (hand-written edge cases)
 * and testdata/corpus (generated, 200+ messages) has an expected .json next
 * to it. Any change in mapping output shows up as a reviewable diff.
 *
 *   npm run golden:update   # rewrite the expected files after an intended change
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as hub from '../build/index.js';
import { NOW, repoRoot, terminology } from './helpers.ts';

const UPDATE = process.env.UPDATE_GOLDEN === '1';
const term = terminology();

function expected(raw: string) {
  const out = hub.transform(raw, { terminology: term, now: NOW }) as any;
  if (out.status === 'MAPPED') return { status: out.status, type: out.message.type, issues: out.result.issues, bundle: out.result.bundle };
  if (out.status === 'IGNORED') return { status: out.status, type: out.message.type, reason: out.reason };
  return { status: out.status, code: out.code, message: out.message, location: out.location };
}

for (const dir of ['golden', 'corpus']) {
  const base = join(repoRoot, 'testdata', dir);
  const files = readdirSync(base).filter((f) => f.endsWith('.hl7')).sort();
  test(`${dir}: ${files.length} messages match their expected output`, () => {
    if (dir === 'corpus') assert.ok(files.length >= 200, 'corpus should hold 200+ messages');
    const mismatches: string[] = [];
    for (const f of files) {
      const raw = readFileSync(join(base, f), 'utf8');
      const actual = JSON.stringify(expected(raw), null, 2) + '\n';
      const target = join(base, f.replace(/\.hl7$/, '.json'));
      if (UPDATE) {
        writeFileSync(target, actual);
        continue;
      }
      if (!existsSync(target)) {
        mismatches.push(`${f}: no expected file (run npm run golden:update)`);
        continue;
      }
      if (readFileSync(target, 'utf8') !== actual) mismatches.push(f);
    }
    assert.deepEqual(mismatches, [], 'output differs from golden files; inspect with git diff after npm run golden:update');
  });
}

test('corpus: every generated message maps without errors', () => {
  const base = join(repoRoot, 'testdata', 'corpus');
  for (const f of readdirSync(base).filter((x) => x.endsWith('.hl7'))) {
    const out = hub.transform(readFileSync(join(base, f), 'utf8'), { terminology: term, now: NOW }) as any;
    assert.equal(out.status, 'MAPPED', `${f}: ${out.code} ${out.message}`);
  }
});
