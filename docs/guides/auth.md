# Auth and login-only sites

```bash
npx monkeytest run https://example.com/login --depth basic
```

A password field, or a path or query that says `login`, `signin`, `signup`, `register`, `forgot`, `reset`, `otp`, or `auth`, marks the page auth-gated. The crawl still follows links on that page. Auth URLs have their own budget of 3, so a `/?mode=signup` or `/forgot-password` link can be visited inside the page cap.

## What the run reports

`public_screens` is how many crawled pages are not auth-gated. When that number is `0` and at least one page was crawled, `outcome_reason` is `login_required`, including when `outcome` is `clean` or `bugs_found`.

`outcome_detail` then says deeper journeys need an account. For a clean login-only run the sentence is:

```text
The sign-in checks we could run finished with no confirmed bugs. Deeper journeys need an account.
```

An anonymous run does not type a customer password. Signing in with an existing account is a separate local step, described below. It is not sign-up.

## Existing account, on your machine

The local runner can sign in before it explores. Two ways:

```bash
monkeytest auth login https://app.example.com
monkeytest run https://app.example.com --use-session
```

`auth login` opens a headed browser. You complete the form, MFA, or SSO yourself. Press Enter in the terminal to save `.monkeytest/auth/session.json`. The file mode is `600` and the `auth/` directory mode is `700`. It is gitignored. It is not uploaded.

```bash
monkeytest run https://app.example.com \
  --username-env MONKEYTEST_USERNAME \
  --password-env MONKEYTEST_PASSWORD
```

`--password-env` is the name of an environment variable, not the password. The same is true of `--username-env`. `--password-stdin` reads a hidden prompt, or one line from a pipe when there is no terminal. There is no flag that puts the password on the command line.

Form and manual sign-in also need `--post-login-url` or `--post-login-selector`. That check has to be visible on the target after a real sign-in. Without it the result is `could_not_test`, not a pass. An empty session, an expired session, a second factor, or a redirect off the named origin is `could_not_test` as well.

Environment variables are visible to the shell, to CI logs, and to other users who can read the process table. They are not a hidden channel. Command examples use names such as `MONKEYTEST_PASSWORD`. They do not contain a real password.

A later `rerun` or `verify` does not load that session unless you pass `--use-session` again or supply a new password reference. `--session-ttl 12h` is optional. There is no default expiry. `monkeytest auth logout --delete` removes the local file. It does not sign the account out on the website.

Form login stops when the site asks for a second factor or SSO. Use `auth login` for that. The engine does not store an OTP seed. An expired or rejected sign-in is `could_not_test` with an auth reason. It is not a verified run and it does not mean the site has no bugs.

While a session is bound, screenshots and video are not recorded, and requests that would carry the session or a known secret off the authorized origin are blocked. Reports can still contain private application data from the signed-in pages. That data is not scrubbed. `auth.privateDataScrubbed` is `false`.

Loopback (`127.0.0.1`, `localhost`, `::1`) is allowed for a local dev server you named. Any other `http` target is refused. There is no flag that turns the origin check off.

Sign-up, contact, payment, and account deletion stay on their existing rules. A signed-in run does not grant `allowSensitive`.

## What the hosted product does not do

`createAuthProvider` and `AUTH_PROVIDER_CONTRACT` are the in-memory interface a server you operate can call later. `AUTH_PROVIDER_CONTRACT` is the string `monkeytester.auth.provider.v1`. The hosted product does not pin that string yet, and this package does not claim the hosted product holds a customer password. Whoever can read the process can read the secret while it exists. Password masking is not a zero-knowledge proof.

The provider accepts `hosted_credentials` or `local_session` for one `open()`. A second `open()` does not reuse the secret. `release()` aborts an in-flight sign-in and drops that object's copies. `RuntimeAuthProvider.open(policy)` is a different interface and can be called again until `close()`. `executeAndTriage` takes `auth: { targetOrigin, storageState, expiresAt }`, not a provider object.

Hosted targets are public `https` only. The local CLI loopback exception does not apply to `createAuthProvider`. Hosted DNS is a preflight lookup, not a connection-time pin. A hosted worker must block private, link-local, and metadata ranges in its own network. See [Auth provider contract](/reference/auth-contract).

## Auth-negative checks

When the crawl sees a password field, the engine adds cases with ids `auth-neg-*` and kind `edge_case`. They do not use the planner's flow budget. On Quick pass, at most 6 are kept.

The cases are: empty submit, invalid email, one wrong-password attempt (`monkeytest+<rand>@example.invalid`), password visibility (a missing toggle is info, not a bug), a forgot-password link, and a sign-up link. Sign-up and reset forms are not submitted. Captcha, phone, and payment fields are not handled.

A login-only site is no longer `inconclusive` only because the model journey was tagged `auth_required`. These checks decide `clean` or `bugs_found`, and `login_required` still rides along so you can see that the rest of the product was behind the wall.

Submitting a real sign-up is a different feature. It needs an inbox you operate. See [Sign-up testing](/guides/signup).
