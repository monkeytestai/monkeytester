/**
 * Identity of an HTTP failure: method + path + status.
 *
 * Two flows that POST /api/contact and get 500 are one bug. The host and
 * the query string are not part of the key. `www` and the apex share a path.
 */

import type { NetworkFailureEvidence } from '../types.js';

export interface HttpFailureIdentity {
  method: string;
  path: string;
  status: number;
}

const LINE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\S+)\s+returned HTTP\s+(\d{3})\b/i;
const ACTION = new Set(['document', 'xhr', 'fetch']);

export function httpFailureIdentity(
  text: string | undefined,
  network: NetworkFailureEvidence[] | undefined,
): HttpFailureIdentity | undefined {
  const fromNetwork = (network || [])
    .map(item => fromEvidence(item))
    .filter((item): item is HttpFailureIdentity => Boolean(item));
  const action = fromNetwork.find(item => item.status >= 500) || fromNetwork[0];
  if (action) return action;
  return fromText(text || '');
}

export function httpFailureKey(identity: HttpFailureIdentity): string {
  return `${identity.method}|${identity.path}|${identity.status}`;
}

function fromEvidence(item: NetworkFailureEvidence): HttpFailureIdentity | undefined {
  if (!item.status || item.status < 400) return undefined;
  if (item.resourceType && !ACTION.has(item.resourceType)) return undefined;
  const path = endpointPath(item.url);
  if (!path) return undefined;
  return {
    method: (item.method || 'GET').toUpperCase(),
    path,
    status: item.status,
  };
}

function fromText(text: string): HttpFailureIdentity | undefined {
  const match = text.match(LINE);
  if (!match) return undefined;
  const path = endpointPath(match[2]);
  if (!path) return undefined;
  return {
    method: match[1].toUpperCase(),
    path,
    status: Number(match[3]),
  };
}

/** Path only, lower case, no query, no trailing slash. */
export function endpointPath(raw: string): string {
  try {
    const url = new URL(raw, 'https://endpoint.invalid');
    let path = url.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return path.toLowerCase();
  } catch {
    return '';
  }
}
