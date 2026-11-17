import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { channels, engineDir, LIBRARY_ID } from '../src/channels.ts';

const xmlFiles = readdirSync(join(engineDir, 'channels')).filter((f) => f.endsWith('.xml'));

/** Minimal well-formedness check: balanced tags, no stray '<' in text. */
function wellFormed(xml: string): void {
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w.\-:]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(xml))) {
    const text = xml.slice(last, m.index);
    assert.ok(!text.includes('<'), `unescaped "<" before ${m[0]}`);
    last = re.lastIndex;
    const [, close, name, , selfClose] = m;
    if (selfClose) continue;
    if (close) assert.equal(stack.pop(), name, `unbalanced </${name}>`);
    else stack.push(name);
  }
  assert.deepEqual(stack, []);
}

test('channel XML files are well-formed and match the definitions', () => {
  const defs = channels();
  assert.equal(xmlFiles.length, defs.length);
  for (const f of xmlFiles) wellFormed(readFileSync(join(engineDir, 'channels', f), 'utf8'));
  wellFormed(readFileSync(join(engineDir, 'code-templates', 'hub-library.xml'), 'utf8'));
});

test('every channel uses the hub code template library and a unique id', () => {
  const defs = channels();
  assert.equal(new Set(defs.map((c) => c.id)).size, defs.length);
  for (const c of defs) assert.equal(c.codeTemplateLibraryId, LIBRARY_ID);
});

test('channels routed to by name exist', () => {
  const names = new Set(channels().map((c) => c.name));
  const sources = [
    ...readdirSync(join(engineDir, 'scripts')).map((f) => readFileSync(join(engineDir, 'scripts', f), 'utf8')),
    readFileSync(join(engineDir, 'code-templates', 'hub-runtime.js'), 'utf8')
  ].join('\n');
  const routed = [...sources.matchAll(/hubRoute\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(routed.length >= 4);
  for (const name of routed) assert.ok(names.has(name), `hubRoute target "${name}" is not a channel`);
});

test('channel scripts only use ES5 syntax (Rhino)', () => {
  for (const f of readdirSync(join(engineDir, 'scripts'))) {
    const code = readFileSync(join(engineDir, 'scripts', f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /=>|\blet\s|\bconst\s|`/, `${f} uses ES2015+ syntax`);
  }
  const runtime = readFileSync(join(engineDir, 'code-templates', 'hub-runtime.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(runtime, /=>|\blet\s|\bconst\s|`/);
});
