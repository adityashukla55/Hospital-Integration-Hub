/**
 * Deploys the hub into a running OIE ("integration as code"):
 *   1. (optional) seeds the site ConceptMaps from terminology/ into HAPI
 *   2. sets the hub entries of the OIE configuration map
 *   3. upserts the code templates and the code template library
 *   4. upserts the channels from engine/channels/*.xml
 *   5. deploys them and waits until all are STARTED
 *
 *   node engine/tools/deploy.ts [--seed-terminology]
 *   env: OIE_URL, OIE_USER, OIE_PASSWORD, FHIR_BASE_URL
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OieClient, waitFor } from './oie-client.ts';

const engineDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const repoDir = join(engineDir, '..');
const OIE_URL = process.env.OIE_URL ?? 'https://localhost:8443';
const FHIR_BASE_URL = (process.env.FHIR_BASE_URL ?? 'http://localhost:8080/fhir').replace(/\/+$/, '');
const oie = new OieClient(OIE_URL, process.env.OIE_USER ?? 'admin', process.env.OIE_PASSWORD ?? 'admin');

/** Engine-side settings (Settings > Configuration Map in the Administrator). */
const CONFIGURATION: Record<string, [string, string]> = {
  'hub.fhir.baseUrl': [process.env.HUB_FHIR_URL_FOR_ENGINE ?? 'http://hapi:8080/fhir', 'FHIR server base URL as seen from the engine'],
  'hub.fhir.timeoutSeconds': ['60', 'HTTP timeout for FHIR calls'],
  'hub.db.url': ['jdbc:postgresql://postgres:5432/hub', 'hub message store'],
  'hub.db.user': ['hub', ''],
  'hub.db.password': [process.env.HUB_DB_PASSWORD ?? 'hub', ''],
  'hub.db.poolSize': ['10', 'JDBC pool size (HikariCP) shared by the hub channels'],
  'hub.deliver.maxWaitSeconds': ['600', 'give up on transient delivery failures (and missing encounters) after this long'],
  'hub.deliver.maxBackoffSeconds': ['60', 'upper bound of the exponential retry back-off'],
  'hub.terminology.cacheSeconds': ['300', 'how long $translate results are cached per channel'],
  'hub.mapper.config': ['', 'optional JSON overriding mapper/src/config.ts DEFAULT_CONFIG (site identifiers, IK number, ...)']
};

function xmlEscape(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function seedTerminology() {
  await waitFor('HAPI FHIR', async () => (await fetch(`${FHIR_BASE_URL}/metadata`)).ok);
  const dir = join(repoDir, 'terminology');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const resource = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const res = await fetch(`${FHIR_BASE_URL}/${resource.resourceType}/${resource.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify(resource)
    });
    if (!res.ok) throw new Error(`seeding ${f} failed: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
    console.log(`terminology: ${resource.resourceType}/${resource.id} (HTTP ${res.status})`);
  }
}

async function setConfigurationMap() {
  const current = await oie.ok('GET', 'server/configurationMap');
  // keep entries that are not ours
  const others = [...current.matchAll(/<entry>\s*<string>([^<]*)<\/string>([\s\S]*?)<\/entry>/g)].filter(([, key]) => !key.startsWith('hub.')).map(([m]) => m);
  const ours = Object.entries(CONFIGURATION).map(
    ([key, [value, comment]]) =>
      `<entry><string>${xmlEscape(key)}</string><com.mirth.connect.util.ConfigurationProperty><value>${xmlEscape(value)}</value><comment>${xmlEscape(comment)}</comment></com.mirth.connect.util.ConfigurationProperty></entry>`
  );
  await oie.ok('PUT', 'server/configurationMap', `<map>${[...others, ...ours].join('')}</map>`);
  console.log(`configuration map: ${ours.length} hub entries`);
}

async function upsertCodeTemplates() {
  const dir = join(engineDir, 'code-templates');
  for (const f of readdirSync(dir).filter((x) => x.startsWith('template-') && x.endsWith('.xml')).sort()) {
    const xml = readFileSync(join(dir, f), 'utf8');
    const id = /<id>([^<]+)<\/id>/.exec(xml)![1];
    await oie.ok('PUT', `codeTemplates/${id}?override=true`, xml);
    console.log(`code template: ${f}`);
  }
  await oie.ok('PUT', 'codeTemplateLibraries?override=true', readFileSync(join(dir, 'hub-library.xml'), 'utf8'));
  console.log('code template library: Hospital Integration Hub');
}

async function upsertChannels(): Promise<string[]> {
  const dir = join(engineDir, 'channels');
  const ids: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.xml')).sort()) {
    const xml = readFileSync(join(dir, f), 'utf8');
    const id = /<id>([^<]+)<\/id>/.exec(xml)![1];
    const existing = await oie.request('GET', `channels/${id}`);
    if (existing.status === 200 && existing.body.includes('<channel')) await oie.ok('PUT', `channels/${id}?override=true`, xml);
    else await oie.ok('POST', 'channels', xml);
    ids.push(id);
    console.log(`channel: ${f}`);
  }
  return ids;
}

/**
 * Downstream channels first (Dead Letter, Deliver, Transform, then Inbound and
 * Replay), so messages still queued from a previous deployment never find
 * their next hop missing.
 */
const DEPLOY_ORDER = ['Hub 4', 'Hub 3', 'Hub 2', 'Hub 1', 'Hub 5'];

async function deploy(ids: string[]) {
  const names = new Map<string, string>();
  for (const f of readdirSync(join(engineDir, 'channels')).filter((x) => x.endsWith('.xml'))) {
    const xml = readFileSync(join(engineDir, 'channels', f), 'utf8');
    names.set(/<id>([^<]+)<\/id>/.exec(xml)![1], /<name>([^<]+)<\/name>/.exec(xml)![1]);
  }
  const rank = (id: string) => DEPLOY_ORDER.findIndex((p) => (names.get(id) ?? '').startsWith(p));
  for (const id of [...ids].sort((a, b) => rank(a) - rank(b))) {
    await oie.ok('POST', `channels/${id}/_deploy?returnErrors=true`);
    console.log(`deployed ${names.get(id)}`);
  }
  await waitFor(
    'channels to start',
    async () => {
      const statuses = await oie.ok('GET', 'channels/statuses');
      const started = ids.filter((id) => new RegExp(`<channelId>${id}</channelId>[\\s\\S]*?<state>STARTED</state>`).test(statuses));
      return started.length === ids.length;
    },
    120000,
    2000
  );
  console.log(`deployed and started ${ids.length} channels`);
}

async function main() {
  await waitFor('OIE REST API', async () => (await oie.request('GET', 'server/version')).status === 200);
  if (process.argv.includes('--seed-terminology')) await seedTerminology();
  await setConfigurationMap();
  await upsertCodeTemplates();
  const ids = await upsertChannels();
  await deploy(ids);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
