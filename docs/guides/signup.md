# Sign-up testing

```bash
npx monkeytest run https://example.com/signup --inbox ./my-inbox.mjs
```

The package does not include an inbox and it does not default to a domain. A completed sign-up or account-creation form is submitted only when you pass an `InboxProvider`. Without one, the runner stops at validation (empty, invalid email, password mismatch) and sets:

| Field | Value |
| --- | --- |
| `signup_status` | `not_tested` |
| `signup_reason` | `no_inbox` |

That refusal is a hard guard, not a prompt.

## Your module

`--inbox` loads a module. The default export must be an `InboxProvider`, or a function that returns one.

```ts
export default {
  async allocate({ runId, purpose }) {
    return { address: 'qa@your-domain.example' };
  },
  async waitFor({ address, kind, timeoutMs, signal }) {
    return { received: false };
  },
};
```

`allocate` receives `{ runId, purpose }` where `purpose` is `'signup'` or `'reset'`, and returns `{ address, expiresAt? }`. `waitFor` receives `{ address, sinceMs, timeoutMs, kind, signal }` where `kind` is `'otp'`, `'link'`, or `'any'`. It may return `text` and `html`. `release` is optional.

```bash
npx monkeytest run https://example.com/signup --inbox-http https://inbox.example/v1
```

`--inbox-http` calls your API. `POST {base}/allocate`, `GET {base}/messages?address=&since=`, and `DELETE {base}/messages?address=`. The bearer token is `MONKEYTEST_INBOX_TOKEN`. Pass either `--inbox` or `--inbox-http`, not both.

From the library, `createHttpInbox({ baseUrl, token })` is that client, and `loadInboxProvider(specifier)` is the module loader. Pass the provider on the `Monkey` constructor as `inbox`.

## What the engine will and will not do

One sign-up per run. The name typed into the form is `MonkeyTest QA`. The password stays in memory. Phone and payment are not filled. Captcha, phone, payment, timeout, and `cap_reached` are not filed as bugs. `signup_status` is `verified`, `unverified`, `not_tested`, or `blocked`. `signup_reason` is `no_inbox`, `captcha`, `phone`, `payment`, `timeout`, `cap_reached`, or `no_signup_form`.

`signup_attempted` and `signup_verified` are set from that single attempt.
