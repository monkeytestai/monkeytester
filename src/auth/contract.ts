/**
 * Public auth ABI for existing-account target testing.
 *
 * Server, client, and admin import this from `@monkeytestai/monkeytester`.
 * `ACCEPTED_ENGINE_CONTRACT` is owned by the server and is intentionally
 * unset until that server pins `AUTH_PROVIDER_CONTRACT.id`. This package
 * does not read that pin and does not claim the hosted product can sign in.
 *
 * The contract text for humans is `docs/reference/auth-contract.md`.
 */

export type AuthMode = 'manual' | 'form' | 'session';

export type AuthOutcome =
  | 'authenticated'
  | 'mfa_required'
  | 'expired'
  | 'origin_rejected'
  | 'credentials_rejected'
  | 'not_authorized'
  | 'target_rejected'
  | 'storage_unsafe';

/**
 * Coarse status a host can switch on.
 * `unsafe_origin`, `mfa_required`, `expired`, and `auth_required` are not passes.
 */
export type AuthStatus =
  | 'authenticated'
  | 'unsafe_origin'
  | 'mfa_required'
  | 'expired'
  | 'auth_required'
  | 'credentials_rejected'
  | 'storage_unsafe';

export type AuthCustody = 'customer-local' | 'in-memory';

export type AuthSecretSource = 'env' | 'stdin' | 'manual' | 'memory';

/**
 * Safe to store on a plan, run, log line, or report.
 * Passwords, cookies, and storage state are not fields here.
 * `privateDataScrubbed` is always false.
 */
export interface AuthPublicMetadata {
  schema: 1;
  mode: AuthMode;
  outcome: AuthOutcome;
  status: AuthStatus;
  /** Exact origin, `scheme://host[:port]`. */
  targetOrigin: string;
  idpOrigins: string[];
  sessionReused: boolean;
  expiresAt?: string;
  loginCapture: 'disabled';
  /** Screenshots, video, and HAR stay off while a session is bound. */
  runCapture: 'disabled';
  visibility: 'private';
  privateDataScrubbed: false;
  custody: AuthCustody;
  hostedProduct: false;
  interaction: 'read-mostly';
  detail: string;
}

export interface AuthCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface AuthStorageOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

/** Bearer secret. Memory or a chmod-600 session file only. Never a plan or run. */
export interface AuthStorageState {
  cookies: AuthCookie[];
  origins: AuthStorageOrigin[];
}

export interface AuthOriginPolicy {
  targetOrigin: string;
  idpOrigins: string[];
}

export interface AuthSecretProvider {
  readonly source: AuthSecretSource;
  describe(): string;
  takeSecrets(): { username: string; password: string } | { missing: string } | undefined;
  release(): void;
  toJSON(): { source: AuthSecretSource; redacted: true; usernameEnv?: string; passwordEnv?: string };
}

/**
 * In-memory session a worker already unwrapped. `open` returns it once.
 * `close` drops this wrapper's reference. It does not revoke the website session.
 */
export interface RuntimeAuthProvider {
  open(request: AuthOriginPolicy): Promise<
    | { ok: true; storageState: AuthStorageState }
    | { ok: false; outcome: Exclude<AuthOutcome, 'authenticated'> }
  >;
  close(): void;
  toJSON(): { source: 'memory-session'; redacted: true; held: boolean };
}

/**
 * Pin value. The server compares this export with `===` after it sets
 * `ACCEPTED_ENGINE_CONTRACT`. Until that pin is set, the server must not
 * claim it can sign in. This package does not read the pin.
 */
export const AUTH_PROVIDER_CONTRACT = 'monkeytester.auth.provider.v1' as const;

export const AUTH_PROVIDER_CONTRACT_ID = AUTH_PROVIDER_CONTRACT;

/** Descriptor of the provider this package actually implements. Not the pin. */
export const AUTH_PROVIDER_ABI = Object.freeze({
  id: AUTH_PROVIDER_CONTRACT,
  schema: 1 as const,
  create: 'createAuthProvider' as const,
  open: 'once' as const,
  modes: ['hosted_credentials', 'local_session'] as const,
  handoff: 'in-memory' as const,
  bindBefore: ['explore', 'plan', 'replay'] as const,
  rerun: 'requires-new-provider' as const,
  allowSensitive: 'not-granted' as const,
  egress: 'exact-origin-all-requests' as const,
  captureWhenAuthenticated: 'disabled' as const,
  hostedTarget: 'https-public-only' as const,
  localFixtureTarget: 'loopback-allowed' as const,
  hostedProduct: false as const,
});

export const MODEL_CREDENTIAL_RULE =
  'Never ask for, invent, or include a password, one-time code, cookie, or session token. If a step needs one, skip it.';

export function signedInPlanRules(signedIn: boolean): string {
  if (!signedIn) return '';
  return 'A customer session is already signed in. Do not ask for, invent, or repeat a password, OTP, cookie, or token. Prefer read-only journeys. Do not plan password changes, payment, account deletion, or a new sign-up.';
}
