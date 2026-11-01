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

There is no flag that types a real password into the site. The engine does not log in as a user.

## Auth-negative checks

When the crawl sees a password field, the engine adds cases with ids `auth-neg-*` and kind `edge_case`. They do not use the planner's flow budget. On Quick pass, at most 6 are kept.

The cases are: empty submit, invalid email, one wrong-password attempt (`monkeytest+<rand>@example.invalid`), password visibility (a missing toggle is info, not a bug), a forgot-password link, and a sign-up link. Sign-up and reset forms are not submitted. Captcha, phone, and payment fields are not handled.

A login-only site is no longer `inconclusive` only because the model journey was tagged `auth_required`. These checks decide `clean` or `bugs_found`, and `login_required` still rides along so you can see that the rest of the product was behind the wall.

Submitting a real sign-up is a different feature. It needs an inbox you operate. See [Sign-up testing](/guides/signup).
