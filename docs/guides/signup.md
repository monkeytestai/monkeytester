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

`signup_attempted` and `signup_verified` are set from that single attempt. `signup_started` is `true` once filling begins. A fill that fails before submit sets `signup_reason` to `automation_error`. No sign-up form sets `no_signup_form`.

The same hard guard covers password reset, OTP / magic-link / send-code, newsletter subscribe, checkout/payment, and account deletion. Without an allow, those forms get validation only (an empty submit). An inbox allows OTP and password reset as well as the one sign-up. Newsletter, payment, and account deletion need `run.allowSensitive`. The runner also aborts the POST. OAuth buttons (`Use Facebook`, `Continue with`, `/auth/<provider>`) are not clicked, and a navigation to an OAuth host is inconclusive.

Contact, enquiry, feedback, support, quote, and get-in-touch message forms are never submitted. Field labels, the button, the action URL, the page, and the planned step are all signals. A search box is not one of these forms. The POST is aborted, including an empty body. The flow is inconclusive with `contact_submit_blocked`. A click that only shows a client-side required-field message, and does not send a request, can still be checked. There is no allow flag for this.

Sign-in and sign-up pages are public screens. They are not auth-gated, and `/` and `/signin` that render the same form are stored once.
