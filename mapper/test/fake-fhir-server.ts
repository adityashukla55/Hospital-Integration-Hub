/**
 * In-memory FHIR server for delivery tests. Implements the transaction
 * semantics HAPI provides (conditional create/update, If-Match, urn:uuid and
 * conditional reference resolution, no-op update suppression) closely enough
 * to test the delivery logic without Docker.
 */
import type { FhirClient, FhirResponse } from '../build/index.js';

type Res = { resourceType: string; id?: string; meta?: { versionId?: string; lastUpdated?: string }; [k: string]: any };

export class FakeFhirServer implements FhirClient {
  store = new Map<string, Res>(); // "Type/id" -> current version
  private nextId = 1;
  requests: Array<{ method: string; path: string; headers?: Record<string, string> }> = [];
  /** force the next transaction to fail with this response */
  failNext?: FhirResponse;
  down = false;

  request(method: string, path: string, body?: string, headers?: Record<string, string>): FhirResponse {
    this.requests.push({ method, path, headers });
    if (this.down) throw new Error('connect ECONNREFUSED');
    if (method === 'GET') return this.get(path);
    if (method === 'POST' && path === '') {
      if (this.failNext) {
        const f = this.failNext;
        this.failNext = undefined;
        return f;
      }
      return this.transaction(JSON.parse(body as string));
    }
    return { status: 405, body: '' };
  }

  // -- reads ------------------------------------------------------------------

  all(type: string): Res[] {
    return [...this.store.entries()].filter(([k]) => k.startsWith(type + '/')).map(([, v]) => v);
  }

  read(ref: string): Res | undefined {
    return this.store.get(ref);
  }

  private get(path: string): FhirResponse {
    const [typeAndId, query = ''] = path.split('?');
    if (typeAndId.includes('/')) {
      const r = this.store.get(typeAndId);
      return r ? ok(r) : { status: 404, body: '{}' };
    }
    const matches = this.search(typeAndId, query);
    let list = matches;
    const params = new URLSearchParams(query);
    if (params.get('_sort') === '-when') {
      list = [...list].sort((a, b) => Date.parse(b.occurredDateTime ?? '') - Date.parse(a.occurredDateTime ?? ''));
    }
    const count = params.get('_count');
    if (count) list = list.slice(0, Number(count));
    return ok({ resourceType: 'Bundle', type: 'searchset', total: matches.length, entry: list.map((r) => ({ resource: r, search: { mode: 'match' } })) });
  }

  search(type: string, query: string): Res[] {
    const params = new URLSearchParams(query);
    return this.all(type).filter((r) => {
      for (const [name, value] of params) {
        if (name.startsWith('_')) continue;
        if (name === 'identifier') {
          if (!matchIdentifier(r, value)) return false;
        } else if (name === 'active:not') {
          // :not keeps resources without the element, like HAPI does
          if (r.active !== undefined && String(r.active) === value) return false;
        } else if (['subject', 'beneficiary', 'subscriber', 'target'].includes(name)) {
          if (!hasReference(r[name], value)) return false;
        } else {
          throw new Error('fake server does not support search parameter ' + name);
        }
      }
      return true;
    });
  }

  // -- transaction ------------------------------------------------------------

  private transaction(bundle: any): FhirResponse {
    const entries: any[] = bundle.entry ?? [];
    const resolved = new Map<string, string>(); // fullUrl -> Type/id
    const plan: Array<{ entry: any; target: string; write: boolean; created: boolean }> = [];

    for (const entry of entries) {
      const req = entry.request;
      const type = entry.resource.resourceType;
      let target: string;
      let write = true;
      let created = false;
      if (req.method === 'PUT' && !req.url.includes('?')) {
        target = req.url;
        const current = this.store.get(target);
        if (req.ifMatch) {
          const v = /W\/"(.+)"/.exec(req.ifMatch)?.[1];
          if (!current || current.meta?.versionId !== v) return conflict(`version conflict on ${target}: expected ${v}, have ${current?.meta?.versionId}`);
        }
        created = !current;
      } else if (req.method === 'PUT') {
        const [t, q] = req.url.split('?');
        const m = this.search(t, q);
        if (m.length > 1) return preconditionFailed(`Multiple resources match this search: ${req.url}`);
        target = m.length ? `${t}/${m[0].id}` : `${t}/${this.nextId++}`;
        created = !m.length;
      } else if (req.method === 'POST') {
        const m = req.ifNoneExist ? this.search(type, req.ifNoneExist) : [];
        if (m.length > 1) return preconditionFailed(`Multiple resources match this search: ${req.ifNoneExist}`);
        if (m.length) {
          target = `${type}/${m[0].id}`;
          write = false;
        } else {
          target = `${type}/${this.nextId++}`;
          created = true;
        }
      } else {
        return { status: 400, body: JSON.stringify(oo('unsupported method ' + req.method)) };
      }
      if (entry.fullUrl) resolved.set(entry.fullUrl, target);
      plan.push({ entry, target, write, created });
    }

    // resolve references (fullUrl placeholders and conditional references)
    for (const p of plan) {
      const err = this.rewrite(p.entry.resource, resolved);
      if (err) return preconditionFailed(err);
    }

    const response: any[] = [];
    for (const p of plan) {
      if (!p.write) {
        response.push({ response: { status: '200 OK', location: `${p.target}/_history/${this.store.get(p.target)?.meta?.versionId}` } });
        continue;
      }
      const [type, id] = p.target.split('/');
      const current = this.store.get(p.target);
      const next: Res = structuredClone(p.entry.resource);
      next.id = id;
      next.resourceType = type;
      if (current && sameContent(current, next)) {
        response.push({ response: { status: '200 OK', location: `${p.target}/_history/${current.meta?.versionId}` } });
        continue;
      }
      const version = current ? String(Number(current.meta?.versionId ?? '0') + 1) : '1';
      next.meta = { ...(next.meta ?? {}), versionId: version, lastUpdated: new Date().toISOString() };
      this.store.set(p.target, next);
      response.push({ response: { status: p.created ? '201 Created' : '200 OK', location: `${p.target}/_history/${version}` } });
    }
    return ok({ resourceType: 'Bundle', type: 'transaction-response', entry: response });
  }

  private rewrite(node: any, resolved: Map<string, string>): string | undefined {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) {
        const e = this.rewrite(n, resolved);
        if (e) return e;
      }
      return;
    }
    if (typeof node.reference === 'string') {
      const r: string = node.reference;
      if (resolved.has(r)) node.reference = resolved.get(r);
      else if (r.includes('?')) {
        const [t, q] = r.split('?');
        const m = this.search(t, q);
        if (m.length !== 1) return `Invalid match URL "${r}" - ${m.length ? 'Multiple resources match this search' : 'No resources match this search'}`;
        node.reference = `${t}/${m[0].id}`;
      } else if (r.startsWith('urn:uuid:')) return `unresolved placeholder reference ${r}`;
    }
    for (const k of Object.keys(node)) {
      const e = this.rewrite(node[k], resolved);
      if (e) return e;
    }
    return;
  }
}

function matchIdentifier(r: Res, token: string): boolean {
  const ids = [...(r.identifier ?? []), ...(r.masterIdentifier ? [r.masterIdentifier] : [])];
  const unescaped = token.replace(/\\([|,$\\])/g, '\u0000$1');
  const idx = unescaped.indexOf('|');
  const system = idx >= 0 ? token.substring(0, idx) : undefined;
  const value = (idx >= 0 ? unescaped.substring(idx + 1) : unescaped).replace(/\u0000(.)/g, '$1');
  return ids.some((i: any) => (system === undefined || i.system === system) && i.value === value);
}

function hasReference(field: any, value: string): boolean {
  const list = Array.isArray(field) ? field : field ? [field] : [];
  return list.some((f: any) => f?.reference === value);
}

function sameContent(a: Res, b: Res): boolean {
  const strip = (r: Res) => JSON.stringify({ ...r, meta: { ...(r.meta ?? {}), versionId: undefined, lastUpdated: undefined } });
  return strip(a) === strip(b);
}

function ok(body: unknown): FhirResponse {
  return { status: 200, body: JSON.stringify(body) };
}

function oo(diagnostics: string) {
  return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'processing', diagnostics }] };
}

function conflict(msg: string): FhirResponse {
  return { status: 409, body: JSON.stringify(oo(msg)) };
}

function preconditionFailed(msg: string): FhirResponse {
  return { status: 412, body: JSON.stringify(oo(msg)) };
}
