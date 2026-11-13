/**
 * Connection-time egress for a signed-in browser.
 * Loopback is allowed only when every authorized host is itself a loopback
 * name. Any other target is pinned to the public addresses resolved now.
 * A later lookup that adds a private or unpinned address is denied.
 */

import { chromium, type Browser } from 'playwright';
import type { AuthOriginPolicy } from './contract.js';
import {
  addressIsNonPublic,
  allowedHosts,
  canonicalAddress,
  isLiteralAddress,
  isLoopbackAddress,
  isLoopbackHost,
  originAllowed,
} from './origins.js';
import { HOSTED_PROXY_REQUIRED, resolveEgressProxy, type EgressProxy } from './proxy.js';

export type { EgressProxy } from './proxy.js';
export { describeEgressProxy, resolveEgressProxy } from './proxy.js';

export interface EgressPin {
  mode: 'local-loopback' | 'hosted-public';
  /** Canonical addresses the browser is allowed to use for each host. */
  hosts: Record<string, string[]>;
}

const pinnedBrowsers = new WeakSet<Browser>();
const browserProxies = new WeakMap<Browser, EgressProxy>();
let testLookup: ((hostname: string) => Promise<string[]>) | undefined;

export class EgressProxyRequiredError extends Error {
  readonly outcome = 'egress_proxy_required' as const;
  constructor(message = HOSTED_PROXY_REQUIRED) {
    super(message);
    this.name = 'EgressProxyRequiredError';
  }
}

export function proxyForBrowser(browser: Browser): EgressProxy | undefined {
  return browserProxies.get(browser);
}

/** Tests inject a resolver. Production uses `dns.lookup` for every address. */
export function setEgressLookupForTests(fn?: (hostname: string) => Promise<string[]>): void {
  testLookup = fn;
}

async function lookupHost(hostname: string): Promise<string[]> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isLiteralAddress(host)) return [canonicalAddress(host)];
  if (testLookup) return (await testLookup(host)).map(canonicalAddress);
  const dns = await import('node:dns/promises');
  const records = await dns.lookup(host, { all: true, verbatim: true });
  return records.map(record => canonicalAddress(record.address));
}

export async function prepareEgress(policy: AuthOriginPolicy): Promise<
  | { ok: true; pin: EgressPin; launchArgs: string[] }
  | { ok: false; detail: string }
> {
  const hosts = allowedHosts(policy);
  if (hosts.length === 0) {
    return { ok: false, detail: 'The authorized origin has no host. Nothing was submitted.' };
  }
  const local = hosts.every(host => isLoopbackHost(host));
  if (local) {
    for (const host of hosts) {
      let addresses: string[];
      try { addresses = await lookupHost(host); }
      catch {
        return { ok: false, detail: 'The loopback target did not resolve to a loopback address. Nothing was submitted.' };
      }
      if (addresses.length === 0 || addresses.some(address => !isLoopbackAddress(address))) {
        return { ok: false, detail: 'The loopback target resolved outside loopback. Nothing was submitted.' };
      }
    }
    return { ok: true, pin: { mode: 'local-loopback', hosts: {} }, launchArgs: [] };
  }
  const pinned: Record<string, string[]> = {};
  const rules: string[] = [];
  for (const host of hosts) {
    let addresses: string[];
    try { addresses = await lookupHost(host); }
    catch {
      return { ok: false, detail: 'Hosted sign-in could not resolve the host. Nothing was submitted.' };
    }
    if (addresses.length === 0 || addresses.some(address => addressIsNonPublic(address))) {
      return { ok: false, detail: 'Hosted sign-in refused a non-public address. Nothing was submitted.' };
    }
    pinned[host] = [...new Set(addresses)];
    if (!isLiteralAddress(host)) rules.push(`MAP ${host} ${pinned[host]![0]}`);
  }
  return {
    ok: true,
    pin: { mode: 'hosted-public', hosts: pinned },
    launchArgs: rules.length ? [`--host-resolver-rules=${rules.join(', ')}`] : [],
  };
}

export async function connectionAllowed(url: URL, policy: AuthOriginPolicy, pin: EgressPin): Promise<boolean> {
  if (url.protocol === 'about:' || url.protocol === 'data:' || url.protocol === 'blob:') return true;
  if (!originAllowed(url, policy)) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  let addresses: string[];
  try { addresses = await lookupHost(host); }
  catch { return false; }
  if (addresses.length === 0) return false;
  if (pin.mode === 'local-loopback') return addresses.every(address => isLoopbackAddress(address));
  if (addresses.some(address => addressIsNonPublic(address))) return false;
  const allowed = pin.hosts[host];
  if (!allowed || allowed.length === 0) return false;
  return addresses.every(address => allowed.includes(address));
}

export function browserHasPin(browser: Browser): boolean {
  return pinnedBrowsers.has(browser);
}

export async function launchFencedBrowser(opts: {
  headless?: boolean;
  policy?: AuthOriginPolicy;
  /**
   * Wins over `MTAI_EGRESS_PROXY`, including `''` (no proxy).
   * Passed to Chromium and every context this launch opens.
   */
  egressProxy?: string;
}): Promise<
  | { ok: true; browser: Browser; pin?: EgressPin; proxy?: EgressProxy }
  | { ok: false; detail: string; outcome: 'target_rejected' | 'egress_proxy_required' }
> {
  const resolved = resolveEgressProxy(opts.egressProxy);
  if (!resolved.ok) return { ok: false, outcome: 'egress_proxy_required', detail: resolved.detail };
  const launchProxy = resolved.proxy ? { proxy: resolved.proxy } : {};
  if (!opts.policy) {
    const browser = await chromium.launch({ headless: opts.headless !== false, ...launchProxy });
    if (resolved.proxy) browserProxies.set(browser, resolved.proxy);
    return { ok: true, browser, ...(resolved.proxy ? { proxy: resolved.proxy } : {}) };
  }
  const prepared = await prepareEgress(opts.policy);
  if (!prepared.ok) return { ok: false, outcome: 'target_rejected', detail: prepared.detail };
  if (prepared.pin.mode === 'hosted-public' && !resolved.proxy) {
    return { ok: false, outcome: 'egress_proxy_required', detail: HOSTED_PROXY_REQUIRED };
  }
  const browser = await chromium.launch({
    headless: opts.headless !== false,
    ...launchProxy,
    args: [
      // A host-resolver rule dials the pinned address directly and skips the
      // proxy. With a proxy, the hostname is sent to the proxy instead.
      ...(resolved.proxy ? [] : prepared.launchArgs),
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
  });
  pinnedBrowsers.add(browser);
  if (resolved.proxy) browserProxies.set(browser, resolved.proxy);
  return { ok: true, browser, pin: prepared.pin, ...(resolved.proxy ? { proxy: resolved.proxy } : {}) };
}
