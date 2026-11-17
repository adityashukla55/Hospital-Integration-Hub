/**
 * Writes the channel XML (engine/channels/*.xml) and the code template
 * library export (engine/code-templates/hub-library.xml) from the TypeScript
 * definitions. Both are committed: they are what you import into an OIE
 * Administrator, and CI fails when they are out of date (`--check`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { channels, codeTemplates, engineDir, LIBRARY_ID } from '../src/channels.ts';
import { channelXml, codeTemplateLibraryXml, codeTemplateXml } from '../src/xml.ts';

const check = process.argv.includes('--check');
const bundlePath = join(engineDir, '..', 'mapper', 'dist', 'hub-mapper.js');
if (!existsSync(bundlePath)) throw new Error('mapper/dist/hub-mapper.js missing: run npm run build -w mapper first');

const outputs = new Map<string, string>();
const defs = channels();
for (const c of defs) outputs.set(join(engineDir, 'channels', `${c.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '')}.xml`), channelXml(c));

const templates = codeTemplates(readFileSync(bundlePath, 'utf8'));
const library =
  '<list>\n' +
  codeTemplateLibraryXml({
    id: LIBRARY_ID,
    name: 'Hospital Integration Hub',
    description: 'HubMapper (generated from mapper/) and the hub runtime adapters.',
    channelIds: defs.map((c) => c.id),
    templates
  }) +
  '</list>\n';
outputs.set(join(engineDir, 'code-templates', 'hub-library.xml'), library);
for (const t of templates) outputs.set(join(engineDir, 'code-templates', `template-${t.name.replace(/\s+/g, '-').toLowerCase()}.xml`), codeTemplateXml(t));

let stale = 0;
mkdirSync(join(engineDir, 'channels'), { recursive: true });
for (const [path, content] of outputs) {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current === content) continue;
  if (check) {
    console.error(`out of date: ${path}`);
    stale++;
  } else {
    writeFileSync(path, content);
    console.log(`wrote ${path}`);
  }
}
if (check && stale) {
  console.error('run `npm run build -w engine` and commit the result');
  process.exit(1);
}
