# Auth provider contract

Server, client, and admin import this from `@monkeytestai/monkeytester`. This page is the ABI this package implements. `ACCEPTED_ENGINE_CONTRACT` is a server pin. It is intentionally unset until a later server change sets it to the string below. This package does not read that pin and does not enable hosted sign-in.

## Pin

```ts
import { AUTH_PROVIDER_CONTRACT, createAuthProvider } from '@monkeytestai/monkeytester';

AUTH_PROVIDER_CONTRACT === 'monkeytester.auth.provider.v1';
```

`AUTH_PROVIDER_CONTRACT` is that string, not an object. Compare it with `===`. `AUTH_PROVIDER_ABI` describes the same id. `providerLoopback` is `rejected`: `createAuthProvider` does not allow loopback. Loopback `http` is only the local CLI and `establishFormAuth`.

`createAuthProvider(...).open()` takes no arguments and is consumed on the first call, including a failed attempt. `release()` aborts an in-flight sign-in and drops this object's copies. The original input record is not retained. JavaScript cannot promise those strings are gone from the heap.

`RuntimeAuthProvider` is a different type. `AUTH_PROVIDER_ABI.runtimeSession` is `repeatable-until-close`: its `open(policy)` can be called again until `close()`. `AUTH_PROVIDER_ABI.open` is `once` and describes `createAuthProvider` only. Do not pass either object to `executeAndTriage`. That method takes `auth: { targetOrigin, storageState, expiresAt }`.

Provider input `mode` is `hosted_credentials` or `local_session`. Public `metadata.mode` is `manual`, `form`, or `session`. Those are not the same field. `AUTH_PROVIDER_CONTRACT` is still `monkeytester.auth.provider.v1`.

Hosted DNS is a preflight plus a per-request recheck (`AUTH_PROVIDER_ABI.hostedDns` is `preflight-plus-per-request-recheck`). `AUTH_PROVIDER_ABI.hostedEgress` is `deny-nonpublic-recheck`. Chromium is given host rules for the addresses resolved then, unless an egress proxy is set, because those rules dial the pinned address and skip the proxy. A later lookup that is private or not in that set is denied. That recheck still runs, and it is not by itself a connection-time pin: Playwright's `route.fetch` and `context.request` ignore `HTTPS_PROXY` and resolve the name again. A public hosted target therefore requires an explicit proxy (`egressProxy` on the call, which wins, or `MTAI_EGRESS_PROXY`). The same `proxy` object is passed to `chromium.launch` and to every context the engine opens, including signed-in, replay, and rerun. Its bypass list is `<-loopback>` plus `localhost`, `127.0.0.1`, and `::1`. On the Playwright version this package ships, the token alone does not keep a context proxy from sending `127.0.0.1` to the proxy. Private and IPv6 unique-local addresses are not in that list. A hosted run with no proxy fails before navigation with `egress_proxy_required` / `auth_egress_proxy_required`. Credentials in the proxy URL are not written to errors or logs. A name that resolves to a private, loopback, link-local, or other reserved address is refused. Loopback is allowed only when the named host is itself loopback, which is the local CLI and `establishFormAuth`. `createAuthProvider` rejects that case. There is no loopback-allowed flag on the ABI. `AUTH_PROVIDER_ABI.hostedProxy` is `explicit-required`.

Signed-in page and frame requests are default-deny for every other origin, including GET. A redirect is fetched with no follow, and an off-origin `Location` is aborted before the browser continues. Page routes cannot `continue()` past that fence. Service workers are not registered. Dedicated workers, shared workers, WebRTC, and WebTransport cannot be constructed, and signed-in Chromium is launched with non-proxied UDP disabled. That is what stops a worker WebSocket or a STUN packet from leaving with the session cookie. It is not a claim that every possible browser network API is proxied. Sitemap and other API fetches are checked before they are sent and do not follow an off-origin redirect. While a session is loaded, same-origin link probes are not sent, so a `/logout` or delete link is not fetched with the jar.

A form login, a manual login, a saved session, and `local_session` are `authenticated` only when `postLoginUrl` or `postLoginSelector` is shown on the target. The URL is checked when the session is bound, on `new URL(postLoginUrl, targetOrigin)`, not on every later page. During the run, a password field or a missing post-login selector is `could_not_test`. An empty jar, an expired jar, MFA, and an off-origin session are `could_not_test` as well. The envelope expiry is checked again before each flow.

`runPlan`, `replayTraces`, and `explore` accept a raw `storageState` and do not repeat that proof. They still install the egress fence. Callers that need the proof should use `Monkey`, `bindAuthProvider`, or the CLI. Non-auth calls are unchanged.

Known credential values are scrubbed from prompts, events, errors, and saved runs, including base64 and URL encodings. `privateDataScrubbed` stays false. Scrubbed signed-in page text can still be sent to the model provider configured for the run. That is the user's own provider, not a claim that the page was withheld from it.

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
