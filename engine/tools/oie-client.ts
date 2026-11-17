/**
 * Minimal client for the OIE (Mirth Connect) REST API: Basic auth,
 * XML bodies. The engine ships a self-signed certificate, so TLS
 * verification is disabled for this client only (local development).
 */
import https from 'node:https';
import http from 'node:http';

export interface OieResponse {
  status: number;
  body: string;
}

export class OieClient {
  private base: URL;
  private auth: string;

  constructor(baseUrl: string, user: string, password: string) {
    this.base = new URL(baseUrl.replace(/\/+$/, '') + '/api/');
    this.auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  }

  request(method: string, path: string, body?: string, contentType = 'application/xml'): Promise<OieResponse> {
    const url = new URL(path.replace(/^\//, ''), this.base);
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method,
          rejectUnauthorized: false,
          headers: {
            Authorization: this.auth,
            'X-Requested-With': 'OpenAPI',
            // some endpoints (e.g. server/version) only produce text/plain
            Accept: 'application/xml, text/plain;q=0.9, */*;q=0.5',
            ...(body !== undefined ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) } : {})
          },
          timeout: 120000
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`timeout: ${method} ${url}`)));
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  async ok(method: string, path: string, body?: string, contentType?: string): Promise<string> {
    const res = await this.request(method, path, body, contentType);
    if (res.status < 200 || res.status >= 300) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${res.body.slice(0, 800)}`);
    return res.body;
  }
}

export async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs = 600000, intervalMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < end) {
    try {
      if (await probe()) return;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${what}${last ? ': ' + last : ''}`);
}
