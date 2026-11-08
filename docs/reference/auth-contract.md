# Auth provider contract

Server, client, and admin import this from `@monkeytestai/monkeytester`. This page is the ABI this package implements. `ACCEPTED_ENGINE_CONTRACT` is a server pin. It is intentionally unset until a later server change sets it to the string below. This package does not read that pin and does not enable hosted sign-in.

## Pin

```ts
import { AUTH_PROVIDER_CONTRACT, createAuthProvider } from '@monkeytestai/monkeytester';

AUTH_PROVIDER_CONTRACT === 'monkeytester.auth.provider.v1';
```

`AUTH_PROVIDER_CONTRACT` is that string, not an object. Compare it with `===`. `AUTH_PROVIDER_ABI` describes the same id. `providerLoopback` is `rejected`: `createAuthProvider` does not allow loopback. Loopback `http` is only the local CLI and `establishFormAuth`.

`createAuthProvider(...).open()` takes no arguments and is consumed on the first call, including a failed attempt. `release()` aborts an in-flight sign-in and drops this object's copies. It does not wipe the caller's original object, and JavaScript cannot promise the string is gone from the heap.

`RuntimeAuthProvider` is a different type. Its `open(policy)` can be called again until `close()`. Do not pass either object to `executeAndTriage`. That method takes `auth: { targetOrigin, storageState, expiresAt }`.

Provider input `mode` is `hosted_credentials` or `local_session`. Public `metadata.mode` is `manual`, `form`, or `session`. Those are not the same field.

Hosted DNS is a preflight only. This library does not pin the address Chromium resolves later. A hosted worker must block private, link-local, and metadata ranges in its network. Without that, do not treat the preflight as a connection-time guarantee.

Signed-in requests are default-deny for every other origin. A redirect is fetched with no follow, and an off-origin `Location` is aborted before the browser continues. Cookie stripping and raw token matching are not the boundary. Service workers are not registered. Off-origin WebSockets are closed. This is not a claim that arbitrary signed-in page text is scrubbed: those sinks are omitted, and `privateDataScrubbed` stays false.

## `createAuthProvider`

```ts
const provider = createAuthProvider({
  mode: 'hosted_credentials',
  targetOrigin: 'https://app.example.com/login',
  username,          // in memory, from your envelope
  password,          // in memory, from your envelope
  expiresAt,         // ISO instant, 120s on the server
});
const result = await provider.open();
provider.release();
```

`local_session` passes `storageState` instead of a password. Cookies must be for the exact target host. A parent-domain cookie or another host is `unsafe_origin`.

`open()` runs once. A second call is `auth_required` and does not return the jar. `release()` drops this provider's references. It does not sign the website out. `otp_seed`, `auth_reuse`, `auth_secret_handle`, and `allowSensitive` are refused and not stored.

`toJSON()` is `{ contract, redacted: true, released }`. It has no password and no cookie.

Hosted targets are public `https` only. Loopback, private, link-local, `.local`, and `.internal` are `unsafe_origin`. The local CLI may still use `http://127.0.0.1` when you name that origin. That exception is not part of `createAuthProvider`.

## Result

`result.ok` is true only when `metadata.status` is `authenticated`. The jar is `result.storageState`. Do not write it to a plan, run, queue, database, or report. Pass it to a fresh browser for this process:

```ts
await monkey.executeAndTriage(targetOrigin, {
  auth: {
    targetOrigin: result.authOrigin.targetOrigin,
    storageState: result.storageState,
    expiresAt: result.metadata.expiresAt,
  },
  explore: { maxPages: 6 },
  plan: { maxFlows: 5 },
  run: { screenshotsDir: '.monkeytest/shots' },
});
```

`auth` is bound before explore, plan, and replay. A stored run does not contain the jar. Replay without a new provider returns `could_not_test` / `auth_not_authorized` and does not copy the old session.

| `metadata.status` | Meaning | Run outcome |
| --- | --- | --- |
| `authenticated` | Session is in memory for this process | explore may start |
| `unsafe_origin` | Target or cookie host is not allowed, or a request left that origin | `could_not_test` |
| `mfa_required` | Second factor or SSO. No OTP seed is stored | `could_not_test` |
| `expired` | `expiresAt` or the cookie jar is past | `could_not_test` |
| `auth_required` | No new secret or consent for this attempt | `could_not_test` |
| `credentials_rejected` | The form did not accept the sign-in | `could_not_test` |
| `storage_unsafe` | The password was written into browser storage and discarded | `could_not_test` |

None of those failed statuses are a pass and none of them mean the site has no bugs. A host that stores one code can map every non-`authenticated` status to `auth_required` and `passed: false`.

`metadata.privateDataScrubbed` is always `false`. `metadata.hostedProduct` is always `false`. `metadata.interaction` is `read-mostly`. Sign-up, contact, payment, and deletion consents are unchanged.

## Local fixture

The checked-in proof is `test/auth-login.test.ts`. It starts a loopback page owned by the test, signs in with `establishFormAuth` and `createMemorySecretProvider`, then opens the app with `openFencedContext`. A second origin records whether the password or cookie arrived. The assertions are booleans. The test does not print the password.

`test/auth-contract.test.ts` covers `createAuthProvider` without a browser: the pin string, loopback and private hosts, OTP seeds, `allowSensitive`, one-shot open, expired envelopes, session file mode `600` / directory `700`, and run JSON that drops `password` and `storageState` keys.

## Order

1. This package publishes the string and `createAuthProvider` on a branch. It does not publish to npm.
2. A later server change sets `ACCEPTED_ENGINE_CONTRACT` to `monkeytester.auth.provider.v1` and runs these fixtures from a tarball or a local build.
3. Client and admin read the metadata above. They are not in this pull request.
4. Operator flags stay off until that review. This library does not deploy them.
