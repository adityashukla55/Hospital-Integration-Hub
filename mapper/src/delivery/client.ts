/**
 * Synchronous FHIR HTTP port. Rhino has no event loop or Promises, so the
 * engine adapter (java.net.http.HttpClient) and the test fake are both
 * synchronous. Paths are relative to the FHIR base URL.
 */
export interface FhirResponse {
  status: number;
  body: string;
  headers?: { [name: string]: string };
}

export type HttpMethod = 'GET' | 'POST' | 'PUT';

export interface FhirClient {
  request(method: HttpMethod, path: string, body?: string, headers?: { [name: string]: string }): FhirResponse;
}
