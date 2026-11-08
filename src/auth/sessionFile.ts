/**
 * Local session files are bearer secrets.
 * The file is `session.json` inside a directory named `auth`.
 * Mode 600 on the file, 700 on that directory. Symlinks are refused.
 * Deleting the file does not sign the website out.
 */

import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { AuthOriginPolicy, AuthPublicMetadata, AuthStorageState } from './contract.js';
import { assertSessionBound, jarExpired } from './origins.js';
import { assertPublicSafe } from './redact.js';
import { publicMetadata } from './report.js';

export const SESSION_FILE_SCHEMA = 1;
export const SESSION_KIND = 'monkeytest-auth-session';

export interface StoredAuthSession {
  schema: typeof SESSION_FILE_SCHEMA;
  kind: typeof SESSION_KIND;
  targetOrigin: string;
  idpOrigins: string[];
  createdAt: string;
  expiresAt?: string;
  storageState: AuthStorageState;
}

export function defaultSessionPath(dir: string): string {
  return resolve(dir, 'auth', 'session.json');
}

export function ensureAuthGitignore(dir: string): void {
  const file = join(resolve(dir), '.gitignore');
  const line = 'auth/';
  if (!existsSync(file)) {
    writeFileSync(file, `# Local sign-in sessions are bearer secrets.\n${line}\n`);
    return;
  }
  const current = readFileSync(file, 'utf8');
  if (/(^|\n)auth\/(\n|$)/.test(current)) return;
  writeFileSync(file, current.endsWith('\n') ? `${current}${line}\n` : `${current}\n${line}\n`);
}

export function writeAuthSession(input: {
  path: string;
  policy: AuthOriginPolicy;
  storageState: AuthStorageState;
  ttlMs?: number;
  nowMs?: number;
}): { path: string; expiresAt?: string } {
  const path = assertSessionLocation(input.path);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  refuseUnrelatedNeighbors(parent, basename(path));
  if (existsSync(path)) assertExistingSession(path, input.policy);
  const now = input.nowMs ?? Date.now();
  const expiresAt = input.ttlMs ? new Date(now + input.ttlMs).toISOString() : undefined;
  const stored: StoredAuthSession = {
    schema: SESSION_FILE_SCHEMA,
    kind: SESSION_KIND,
    targetOrigin: input.policy.targetOrigin,
    idpOrigins: [...input.policy.idpOrigins],
    createdAt: new Date(now).toISOString(),
    ...(expiresAt ? { expiresAt } : {}),
    storageState: input.storageState,
  };
  writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
  chmodSync(path, 0o600);
  ensureAuthGitignore(dirname(parent));
  return { path, expiresAt };
}

export interface ReadSessionResult {
  metadata: AuthPublicMetadata;
  storageState?: AuthStorageState;
  needsPermission?: boolean;
}

export function readAuthSession(
  path: string,
  policy: AuthOriginPolicy,
  opts: { allow: boolean; nowMs?: number },
): ReadSessionResult {
  const full = assertSessionLocation(path);
  if (!opts.allow) {
    return {
      needsPermission: true,
      metadata: sessionMeta(policy, 'not_authorized', 'A saved sign-in is not reused automatically. Pass --use-session for this run, or sign in again with --password-env or --password-stdin. This is not a verified run.'),
    };
  }
  if (!existsSync(full)) {
    return {
      metadata: sessionMeta(policy, 'not_authorized', 'No local session file was found for this target. Run monkeytest auth login, then rerun with --use-session. This is not a verified run.'),
    };
  }
  const stored = parseSession(full);
  if (stored.targetOrigin !== policy.targetOrigin || !sameList(stored.idpOrigins, policy.idpOrigins)) {
    return {
      metadata: sessionMeta(policy, 'origin_rejected', 'This session file is bound to a different origin or a different IdP list. It was not loaded. This is not a verified run.'),
    };
  }
  const now = opts.nowMs ?? Date.now();
  if (stored.expiresAt && Date.parse(stored.expiresAt) <= now) {
    return {
      metadata: sessionMeta(policy, 'expired', 'The local session is past the expiry you set. It was not loaded. This is not a verified run and it does not mean the site has no bugs. Sign in again.', stored.expiresAt),
    };
  }
  if (jarExpired(stored.storageState, now)) {
    return {
      metadata: sessionMeta(policy, 'expired', 'The site session cookies in the local file are expired. They were not loaded. This is not a verified run and it does not mean the site has no bugs. Sign in again.', stored.expiresAt),
    };
  }
  const bound = assertSessionBound(stored.storageState, policy);
  if (!bound.ok) {
    return { metadata: sessionMeta(policy, 'origin_rejected', `${bound.detail} This is not a verified run.`) };
  }
  const metadata = publicMetadata({
    mode: 'session',
    outcome: 'authenticated',
    policy,
    sessionReused: true,
    ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}),
    detail: 'Loaded a local session file for this exact origin. It was not uploaded. Reports can contain private application data and are not scrubbed of that data. Deleting the file later does not sign the website out.',
  });
  assertPublicSafe(metadata, secretValues(stored.storageState));
  return { metadata, storageState: stored.storageState };
}

export function deleteAuthSession(path: string, opts: { confirm: boolean }): { deleted: boolean; detail: string } {
  if (!opts.confirm) {
    return {
      deleted: false,
      detail: 'The local session file was kept. Pass --delete to remove it. Removing the file does not sign the account out on the website.',
    };
  }
  const full = assertSessionLocation(path);
  if (!existsSync(full)) {
    return {
      deleted: false,
      detail: 'No local session file was found. Nothing was deleted. This command does not sign the account out on the website.',
    };
  }
  assertExistingSession(full);
  unlinkSync(full);
  return {
    deleted: true,
    detail: 'Removed the local session file. The website session was not revoked. If the site offers a sign-out control, use that in a browser.',
  };
}

export function parseTtl(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = /^(\d+)(m|h|d)$/.exec(raw.trim());
  if (!match) throw new Error('--session-ttl must look like 30m, 12h, or 7d. No default expiry is applied.');
  const n = Number(match[1]);
  const ms = match[2] === 'm' ? n * 60_000 : match[2] === 'h' ? n * 3_600_000 : n * 86_400_000;
  if (ms < 60_000 || ms > 30 * 86_400_000) throw new Error('--session-ttl must be between 1m and 30d.');
  return ms;
}

function sessionMeta(
  policy: AuthOriginPolicy,
  outcome: 'not_authorized' | 'expired' | 'origin_rejected',
  detail: string,
  expiresAt?: string,
): AuthPublicMetadata {
  return publicMetadata({
    mode: 'session',
    outcome,
    policy,
    detail,
    ...(expiresAt ? { expiresAt } : {}),
  });
}

function assertSessionLocation(path: string): string {
  const full = resolve(path);
  if (basename(full) !== 'session.json' || basename(dirname(full)) !== 'auth') {
    throw new Error('The session file must be named session.json inside a directory named auth.');
  }
  refuseSymlink(dirname(full));
  refuseSymlink(full);
  return full;
}

function refuseSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing to use a symlink for the session (${basename(path)}).`);
  }
}

function refuseUnrelatedNeighbors(parent: string, ownName: string): void {
  if (!existsSync(parent)) return;
  for (const entry of readdirSync(parent)) {
    if (entry === ownName) continue;
    const full = join(parent, entry);
    if (!existsSync(full) || lstatSync(full).isSymbolicLink() || !isSessionJson(full)) {
      throw new Error(`Refusing to store a session in ${basename(parent)} because it contains ${entry}.`);
    }
  }
}

function assertExistingSession(path: string, policy?: AuthOriginPolicy): void {
  const stored = parseSession(path);
  if (policy && (stored.targetOrigin !== policy.targetOrigin || !sameList(stored.idpOrigins, policy.idpOrigins))) {
    throw new Error('Refusing to overwrite a session file bound to a different origin. Delete it with monkeytest auth logout --delete first.');
  }
}

function isSessionJson(path: string): boolean {
  try { parseSession(path); return true; } catch { return false; }
}

function parseSession(path: string): StoredAuthSession {
  let raw = '';
  try { raw = readFileSync(path, 'utf8'); }
  catch { throw new Error('Could not read the session file.'); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('Refusing to overwrite a file that is not a monkeytest auth session.'); }
  const obj = parsed as Partial<StoredAuthSession>;
  if (obj.kind !== SESSION_KIND || obj.schema !== SESSION_FILE_SCHEMA || !obj.storageState || !obj.targetOrigin) {
    throw new Error('Refusing to overwrite a file that is not a monkeytest auth session.');
  }
  return obj as StoredAuthSession;
}

function sameList(left: string[] = [], right: string[] = []): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function secretValues(state: AuthStorageState): string[] {
  const values: string[] = [];
  for (const cookie of state.cookies || []) if (cookie.value) values.push(cookie.value);
  for (const origin of state.origins || []) {
    for (const item of origin.localStorage || []) if (item.value) values.push(item.value);
  }
  return values;
}
