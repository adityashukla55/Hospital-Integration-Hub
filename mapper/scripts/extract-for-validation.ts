/**
 * Extracts every resource from the golden and corpus expected bundles into
 * one file per resource, ready for the HL7 FHIR Validator:
 *
 *   node mapper/scripts/extract-for-validation.ts <out-dir> [--corpus]
 *
 * Bundle-internal references (urn:uuid:..., conditional "Encounter?identifier=")
 * only resolve inside a transaction, so they are rewritten to plain literal
 * references; the validator then checks structure, profiles and bindings.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const out = process.argv[2];
if (!out) throw new Error('usage: extract-for-validation.ts <out-dir> [--corpus]');
const dirs = ['golden', ...(process.argv.includes('--corpus') ? ['corpus'] : [])];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

let count = 0;
for (const dir of dirs) {
  const base = join(repo, 'testdata', dir);
  for (const f of readdirSync(base).filter((x) => x.endsWith('.json')).sort()) {
    const expected = JSON.parse(readFileSync(join(base, f), 'utf8'));
    if (expected.status !== 'MAPPED') continue;
    const entries: any[] = expected.bundle.entry;
    const ids = new Map<string, string>();
    entries.forEach((e, i) => ids.set(e.fullUrl, `${e.resource.resourceType}/${e.resource.id ?? `v${count + i}`}`));
    entries.forEach((e, i) => {
      const r = structuredClone(e.resource);
      r.id = ids.get(e.fullUrl)!.split('/')[1];
      const text = JSON.stringify(r, (_k, v) => {
        if (v && typeof v === 'object' && typeof v.reference === 'string') {
          if (ids.has(v.reference)) return { ...v, reference: ids.get(v.reference) };
          if (v.reference.includes('?')) return { ...v, reference: `${v.reference.split('?')[0]}/conditional` };
        }
        return v;
      });
      writeFileSync(join(out, `${dir}-${f.replace(/\.json$/, '')}-${String(i).padStart(2, '0')}-${r.resourceType}.json`), text);
      count++;
    });
  }
}
console.log(`extracted ${count} resources to ${out}`);
