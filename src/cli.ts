#!/usr/bin/env node
/**
 * monkeytest CLI — the bug-finding loop on the command line.
 *
 * Subcommands:
 *
 *   monkeytest init              Scaffold a .monkeytest/ directory.
 *   monkeytest explore <url>     Crawl + plan only. Writes plan.json.
 *   monkeytest run <url>         Full pipeline: explore + plan + run + triage.
 *                                Writes plan.json + runs/<id>.json + shots/.
 *   monkeytest rerun [<runId>]   Replay the recorded action trace (no LLM).
 *                                --heal re-resolves a step whose locator missed.
 *   monkeytest verify [run]      Replay each bug trace and report fixed /
 *                                still_broken / flaky / healed / blocked.
 *   monkeytest diff <a> <b>      Diff two stored runs by bug fingerprint.
 *                                "<a>" / "<b>" are run ids or "latest"/"prev".
 *   monkeytest report [<runId>]  Pretty-print a stored run (flows, bugs, paths).
 *   monkeytest open [<runId>]    Print local paths for that run and its evidence.
 *
 * Common flags:
 *   --dir <path>          Working directory (default ./.monkeytest)
 *   --provider <id>       openai | gemini | anthropic | mistral | groq | openai_compatible
 *   --model <id>          Override model id (provider-specific)
 *   --quality <preset>    cheap | balanced | smart  (used by autoLLMConfig)
 *   --depth <preset>      basic (Quick pass) | standard | deep | shallow
 *   --max <n>             Max pages to crawl (explore/run only, default 8)
 *   --flows <n>           Max flows to plan (explore/run only, default 6)
 *   --no-headless         Show the browser window
 *   --label <text>        Free-form label saved on the plan/run
 *   --heal                Re-resolve a trace step when its locator misses
 *   --repeat <n>          Replay each bug n times during `verify` (default 1)
 *   --bug <fingerprint>   Verify a single bug
 *   --json                Machine-readable output (run/diff/report/verify)
 *   --fail-on-5xx         Fail a step that saw a same-origin HTTP ≥500 (default)
 *   --no-fail-on-5xx      Leave those responses as evidence on a passed step
 *
 * Exit codes:
 *   0  success / no blocking bugs / no bug still firing
 *   1  blocking bugs (`run` / `rerun`), new or regressed bugs (`diff`),
 *      or any `still_broken` / `flaky` verdict (`verify`)
 *   2  invalid args / setup error
 *   3  engine / runtime error
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { Monkey } from './monkey.js';
import { createLLM, type LLM } from './llm/index.js';
import { autoLLMConfig, detectProviderFromEnv, CHEAP_FAST_MODEL, SMART_MODEL } from './llm/presets.js';
import { applyDepthPreset, BASIC_PRESET, type PlanFocus } from './depth.js';
import {
  savePlan, loadPlan, saveRun, loadRun, listRuns,
  type StoredRun,
} from './persistence/index.js';
import { bugMatchesFingerprint, diffRuns, summariseDiff } from './diff/index.js';
import { replayTraces } from './runner/replay.js';
import { triage } from './triager/index.js';
import { verifyBugs, type VerifyReport } from './verify/index.js';
import type {
  LLMProvider, LLMConfig, MonkeyLLMConfig, BugReport, FlowTrace, InboxProvider, RunResult,
} from './types.js';
import { ENGINE_VERSION } from './version.js';
import { collectEvidencePaths } from './reportPaths.js';
import { starMarkerName, starNudgeLine, type StarNudgeInput } from './starNudge.js';
import { createHttpInbox } from './inbox/http.js';
import { loadInboxProvider } from './inbox/load.js';
import {
  authBlockedRun,
  authProcessExit,
  defaultSessionPath,
  deleteAuthSession,
  parseTtl,
  readSecretLine,
  rejectCredentialArg,
  resolveAuthInvocation,
} from './auth/index.js';
import type { AuthOriginPolicy, AuthPublicMetadata, AuthStorageState } from './auth/contract.js';

/* ── Tiny ANSI helpers (no chalk dep) ─────────────────────────────────── */

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  cyan:   '\x1b[36m',
};

function tty(s: string, code: keyof typeof c): string {
  return process.stdout.isTTY ? `${c[code]}${s}${c.reset}` : s;
}

const ENGINE_LABEL = `monkeytester@${ENGINE_VERSION}`;

/* ── Arg parsing ──────────────────────────────────────────────────────── */

interface CommonOpts {
  dir: string;
  provider?: LLMProvider;
  model?: string;
  /** Planner model only. Explorer summaries stay on the cheap default. */
  plannerModel?: string;
  quality: 'cheap' | 'balanced' | 'smart';
  /** Depth preset id. `basic` is Quick pass (6 pages, 5 LLM flows, page checks, 120s). */
  depth?: string;
  maxPages: number;
  maxFlows: number;
  /** True when the user passed `--max`, so it wins over `--depth`. */
  maxPagesSet: boolean;
  /** True when the user passed `--flows`, so it wins over `--depth`. */
  maxFlowsSet: boolean;
  /** Planner bias from the depth preset, when it has one. */
  focus?: PlanFocus;
  /** Ask the planner for at least this many journeys when the first plan is thin. */
  minFlows?: number;
  stepTimeoutMs?: number;
  flowTimeoutMs?: number;
  totalBudgetMs?: number;
  pageTimeoutMs?: number;
  headless: boolean;
  label?: string;
  json: boolean;
  apiKey?: string;
  baseURL?: string;
  /** Re-resolve a recorded step when every stored locator misses. */
  heal: boolean;
  /** How many times `verify` replays each bug. */
  repeat: number;
  /** Restrict `verify` to one fingerprint. */
  bug?: string;
  /**
   * Promote a same-origin HTTP ≥500 observed during a step into a blocking
   * bug. Default true. `--no-fail-on-5xx` turns it off.
   */
  failOn5xx: boolean;
  /** Path to a module that exports an InboxProvider. */
  inboxModule?: string;
  /** Base URL of a caller-operated HTTP inbox. No default host. */
  inboxHttp?: string;
  /** Skip the one-time star line. `MONKEYTEST_NO_STAR=1` does the same. */
  noStar: boolean;
  authManual: boolean;
  useSession: boolean;
  saveSession: boolean;
  deleteSession: boolean;
  sessionPath?: string;
  sessionTtl?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  passwordStdin: boolean;
  idpOrigins: string[];
  postLoginUrl?: string;
  postLoginSelector?: string;
}

function defaultCommonOpts(): CommonOpts {
  return {
    dir: '.monkeytest',
    quality: 'balanced',
    maxPages: 8,
    maxFlows: 6,
    maxPagesSet: false,
    maxFlowsSet: false,
    headless: true,
    json: false,
    heal: false,
    repeat: 1,
    failOn5xx: true,
    noStar: false,
    authManual: false,
    useSession: false,
    saveSession: false,
    deleteSession: false,
    passwordStdin: false,
    idpOrigins: [],
  };
}

interface Parsed {
  command: string;
  positional: string[];
  opts: CommonOpts;
  showHelp: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const [, , rawCmd, ...rest] = argv;

  // Treat top-level `--help`/`-h`/`--version`/`-v` as commands, not flags.
  let cmd = rawCmd || 'help';
  if (cmd === '-h' || cmd === '--help') cmd = 'help';
  if (cmd === '-v' || cmd === '--version') cmd = 'version';

  const out: Parsed = {
    command: cmd,
    positional: [],
    opts: defaultCommonOpts(),
    showHelp: false,
  };

  for (let i = 0; i < rest.length; i++){
    const a = rest[i];
    const next = () => rest[++i];

    switch (a){
      case '-h': case '--help':            out.showHelp = true; break;
      case '-v': case '--version':         out.command = 'version'; break;
      case '-d': case '--dir':             out.opts.dir = next(); break;
      case '--provider':                   out.opts.provider = next() as LLMProvider; break;
      case '--model':                      out.opts.model = next(); break;
      case '--planner-model': {
        const id = next();
        if (!id) die(2, '--planner-model requires a model id');
        out.opts.plannerModel = id;
        break;
      }
      case '--api-key': case '--apikey':   out.opts.apiKey = next(); break;
      case '--base-url':                   out.opts.baseURL = next(); break;
      case '--quality':                    out.opts.quality = next() as CommonOpts['quality']; break;
      case '--depth': case '--preset': {
        const name = next();
        if (!name) die(2, '--depth requires a preset: basic (Quick pass), standard, deep, or shallow');
        out.opts.depth = name;
        break;
      }
      case '-m': case '--max':             out.opts.maxPages = parseInt(next(), 10); out.opts.maxPagesSet = true; break;
      case '--flows':                      out.opts.maxFlows = parseInt(next(), 10); out.opts.maxFlowsSet = true; break;
      case '--no-headless':                out.opts.headless = false; break;
      case '--label':                      out.opts.label = next(); break;
      case '--json':                       out.opts.json = true; break;
      case '--no-star':                    out.opts.noStar = true; break;
      case '--fail-on-5xx':                out.opts.failOn5xx = true; break;
      case '--no-fail-on-5xx':             out.opts.failOn5xx = false; break;
      case '--inbox': {
        const spec = next();
        if (!spec) die(2, '--inbox requires a module path');
        out.opts.inboxModule = spec;
        break;
      }
      case '--inbox-http': {
        const url = next();
        if (!url) die(2, '--inbox-http requires your inbox base URL');
        out.opts.inboxHttp = url;
        break;
      }
      case '--auth': {
        const mode = next();
        if (mode !== 'manual') die(2, '--auth only supports manual. Form login uses --username-env and --password-env.');
        out.opts.authManual = true;
        break;
      }
      case '--use-session':            out.opts.useSession = true; break;
      case '--save-session':           out.opts.saveSession = true; break;
      case '--delete':                 out.opts.deleteSession = true; break;
      case '--session': {
        const path = next();
        if (!path) die(2, '--session requires a path ending in auth/session.json');
        out.opts.sessionPath = path;
        break;
      }
      case '--session-ttl': {
        const ttl = next();
        if (!ttl) die(2, '--session-ttl requires a value such as 12h');
        out.opts.sessionTtl = ttl;
        break;
      }
      case '--username-env': {
        const name = next();
        if (!name) die(2, '--username-env requires an uppercase variable name');
        out.opts.usernameEnv = name;
        break;
      }
      case '--password-env': {
        const name = next();
        if (!name) die(2, '--password-env requires an uppercase variable name');
        out.opts.passwordEnv = name;
        break;
      }
      case '--password-stdin':         out.opts.passwordStdin = true; break;
      case '--idp-origin': {
        const origin = next();
        if (!origin) die(2, '--idp-origin requires an absolute origin');
        out.opts.idpOrigins.push(origin);
        break;
      }
      case '--post-login-url': {
        const value = next();
        if (!value) die(2, '--post-login-url requires a path or absolute URL on the target');
        out.opts.postLoginUrl = value;
        break;
      }
      case '--post-login-selector': {
        const value = next();
        if (!value) die(2, '--post-login-selector requires a selector that is visible after sign-in');
        out.opts.postLoginSelector = value;
        break;
      }
      case '--heal':                       out.opts.heal = true; break;
      case '--bug': {
        const fp = next();
        if (!fp) die(2, '--bug requires a fingerprint');
        out.opts.bug = fp;
        break;
      }
      case '--repeat': {
        const n = parseInt(next(), 10);
        if (!Number.isInteger(n) || n < 1) die(2, '--repeat must be a positive integer');
        out.opts.repeat = n;
        break;
      }
      default: {
        const rejected = rejectCredentialArg(a);
        if (rejected) die(2, rejected);
        if (a.startsWith('-')){
          die(2, `Unknown flag: ${a}`);
        }
        out.positional.push(a);
      }
    }
  }

  if (out.opts.depth) {
    try {
      const applied = applyDepthPreset(out.opts.depth, out.opts);
      out.opts.maxPages = applied.maxPages;
      out.opts.maxFlows = applied.maxFlows;
      out.opts.focus = applied.focus;
      out.opts.depth = applied.preset.id;
      out.opts.stepTimeoutMs = applied.stepTimeoutMs;
      out.opts.flowTimeoutMs = applied.flowTimeoutMs;
      out.opts.totalBudgetMs = applied.totalBudgetMs;
      out.opts.pageTimeoutMs = applied.pageTimeoutMs;
      if (applied.preset.id === 'basic') {
        out.opts.minFlows = Math.min(BASIC_PRESET.llmFlows, applied.maxFlows);
      }
    } catch (err) {
      die(2, err instanceof Error ? err.message : String(err));
    }
  }

  return out;
}

/* ── LLM config resolution ────────────────────────────────────────────── */

function buildLLMConfig(opts: CommonOpts): MonkeyLLMConfig {

  // Explorer summaries stay on the cheap model. --model changes the runner
  // and, unless --planner-model is set, the planner. --planner-model never
  // changes the summary or runner models.
  let config: MonkeyLLMConfig;
  if (opts.provider){
    const base: LLMConfig = {
      provider: opts.provider,
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    };
    const cheap = CHEAP_FAST_MODEL[opts.provider];
    const plannerDefault = opts.quality === 'cheap' ? cheap : SMART_MODEL[opts.provider];
    config = {
      explorer: { ...base, model: cheap },
      planner: { ...base, model: opts.model || plannerDefault },
      runner: { ...base, model: opts.model || cheap },
    };
  } else {
    config = autoLLMConfig({ quality: opts.quality });
    if (opts.model) {
      config = {
        ...config,
        planner: { ...config.planner, model: opts.model },
        runner: { ...(config.runner ?? config.planner), model: opts.model },
      };
    }
  }
  if (opts.plannerModel) {
    config = { ...config, planner: { ...config.planner, model: opts.plannerModel } };
  }
  return config;

}

function ensureLLMReady(opts: CommonOpts){
  if (opts.provider) return;
  const detected = detectProviderFromEnv();
  if (!detected){
    die(2,
      'No LLM provider configured. Set one of: '
      + 'GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY, '
      + 'GROQ_API_KEY, or OPENAI_COMPATIBLE_BASE_URL — or pass --provider explicitly.'
    );
  }
}

/* ── Help ─────────────────────────────────────────────────────────────── */

function printHelp(cmd?: string){

  if (!cmd || cmd === 'help'){
    console.log(`
${tty('monkeytest', 'bold')} — the AI bug-finding loop for any web app.

Usage:
  monkeytest <command> [args] [flags]

Commands:
  ${tty('init', 'cyan')}                       Scaffold a .monkeytest/ directory.
  ${tty('explore', 'cyan')} <url>              Crawl + plan only. Writes plan.json.
  ${tty('run', 'cyan')} <url>                  Full pipeline: explore + plan + run + triage.
  ${tty('rerun', 'cyan')} [<runId>]            Replay a stored trace. No LLM unless --heal.
  ${tty('verify', 'cyan')} [run]               Replay each bug trace and print a verdict.
  ${tty('diff', 'cyan')} <runA> <runB>         Diff two stored runs by bug fingerprint.
  ${tty('report', 'cyan')} [<runId>]           Pretty-print a stored run.
  ${tty('open', 'cyan')} [<runId>]             Print local evidence paths. Unreleased in this tree.
  ${tty('auth', 'cyan')} login <url>           Headed local sign-in. Saves auth/session.json.
  ${tty('auth', 'cyan')} logout --delete       Deletes that local file. Does not sign the site out.
  ${tty('help', 'cyan')} [<command>]           Show help (this page or per-command).
  ${tty('version', 'cyan')}                    Print engine version and exit.

Common flags (apply to most commands):
  -d, --dir <path>           Working dir (default ./.monkeytest)
      --provider <id>        openai | gemini | anthropic | mistral | groq | openai_compatible
      --model <id>           Runner model. Also the planner model unless --planner-model is set
      --planner-model <id>   Planner model only. Page summaries stay on the cheap model
      --api-key <key>        Override env API key
      --base-url <url>       Required for openai_compatible (Ollama, vLLM, …)
      --quality <preset>     cheap | balanced | smart   (default balanced)
      --depth <preset>       basic (Quick pass) | standard | deep | shallow
                             basic: 6 pages, 5 LLM flows, 5 page checks, 120s budget
  -m, --max <n>              Max pages to crawl (default 8, or the depth preset)
      --flows <n>            Max flows to plan (default 6, or the depth preset)
      --no-headless          Show the browser window
      --label <text>         Free-form label saved on the plan/run
      --heal                 If a recorded locator misses, ask the LLM (rerun/verify)
      --repeat <n>           Replay each bug n times (verify, default 1)
      --bug <fingerprint>    Verify one bug
      --json                 Machine-readable output
      --no-star              Do not print the one-time star link
      --fail-on-5xx          Fail steps that saw a same-origin HTTP ≥500 (default)
      --no-fail-on-5xx       Keep those 5xx responses as evidence only
      --inbox <module>       Module that exports your InboxProvider (no hosted inbox)
      --inbox-http <url>     Your HTTP inbox API (MONKEYTEST_INBOX_TOKEN). No default host.
      --auth manual          Headed sign-in for this run. No password flag.
      --use-session          Load the local session file for this command only.
      --save-session         Write auth/session.json after a successful sign-in.
      --session <path>       Session file. Must be named auth/session.json.
      --session-ttl <dur>    Opt-in expiry: 30m, 12h, or 7d. No default.
      --username-env <NAME>  Env var NAME for the account. Not the account itself.
      --password-env <NAME>  Env var NAME for the password. Not the password.
      --post-login-url <path>  URL path that exists only after sign-in
      --post-login-selector <css>  Selector that exists only after sign-in
      --password-stdin       Hidden prompt, or one stdin line when there is no TTY.
      --idp-origin <origin>  Extra origin allowed during sign-in. Repeatable.

Env vars named above are visible to the shell, CI logs, and process listings.
Do not pass the password as an argument. The hosted product does not take these credentials.

Exit codes: 0 ok · 1 bugs still firing · 2 bad args / setup · 3 engine error.

Environment:
  GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY,
  GROQ_API_KEY, OPENAI_COMPATIBLE_BASE_URL

Quick start:
  monkeytest run https://example.com
  monkeytest rerun                    # replay the latest trace, no LLM
  monkeytest verify --repeat 3        # is each known bug actually fixed?
  monkeytest diff prev latest         # see what changed

Docs: https://docs.monkeytest.ai
`);
    return;
  }

  // Per-command help
  const text: Record<string, string> = {
    init: `monkeytest init [--dir .monkeytest]
Scaffold a working directory with config defaults. Idempotent.`,
    explore: `monkeytest explore <url> [--max 8] [--flows 6] [--depth basic] [--no-headless]
Crawl <url>, summarise pages, generate a TestPlan. Writes plan.json + shots/.
--depth basic is Quick pass: 6 pages, 5 LLM flows, page checks outside that budget, 120s total.`,
    run: `monkeytest run <url> [--max 8] [--flows 6] [--depth basic] [--quality balanced]
Run the full pipeline (explore + plan + run + triage). Writes plan.json,
runs/<id>.json, and screenshots. Exits with code 1 if blocking bugs found.
--depth basic is Quick pass (6 pages, 5 LLM flows, page checks, 120s budget).
Same-origin HTTP ≥500 responses fail the step (--no-fail-on-5xx opts out).
The crawl reserves room for help/contact/about pages under a small --max.
A crawled form, an enabled button, a link to a page the crawl did not open,
and a disabled button each keep a grounded flow when --flows has room.
Exits 3 when the explorer loads no pages.`,
    rerun: `monkeytest rerun [<runId>] [--heal] [--dir .monkeytest]
Replay the action trace stored on a run. Does not call the LLM.
--heal re-resolves a step whose locator no longer matches and marks it healed.
If <runId> is omitted, the latest run is replayed. Runs recorded before
traces existed fall back to re-executing the stored plan with the LLM.`,
    verify: `monkeytest verify [runDir|runId] [--bug <fingerprint>] [--repeat N] [--heal]
Replay each known bug's trace and print a verdict:
  fixed         the failing step passed on every attempt
  still_broken  the failing step failed on every attempt
  flaky         the bug fired on some but not all attempts
  healed        a stale locator was re-resolved (--heal) and the bug did not recur
  blocked       the failing step could not be reached
Exit 1 if any bug is still_broken or flaky. --json prints the report.`,
    diff: `monkeytest diff <runA> <runB>
Diff two stored runs by stable bug fingerprint. Use "latest"/"prev" as
shortcuts. Prints new / fixed / persisting / regressed bugs.`,
    report: `monkeytest report [<runId>] [--json]
Pretty-print a stored run (flows, bugs, evidence paths). Defaults to
"latest". Use --json for machine-readable output.`,
    open: `monkeytest open [<runId>] [--json]
Unreleased: this command is in this source tree and is not in the published
npm dist-tags. Print the absolute path of a stored run and the screenshot
and WebM paths already recorded on it. Does not upload them, does not fetch
the site, and does not launch a browser. Defaults to "latest".`,
    auth: `monkeytest auth login <url> [--idp-origin <origin>] [--session-ttl 12h]
Open a headed browser on that exact origin. You log in, including MFA or SSO.
Press Enter here to save .monkeytest/auth/session.json (file mode 600, directory mode 700).
The file is not uploaded. Deleting it later does not sign the website out.

monkeytest auth logout --delete
Remove the local file only.

Form login, instead of the headed browser:
  monkeytest run <url> --username-env MONKEYTEST_USERNAME --password-env MONKEYTEST_PASSWORD
  monkeytest run <url> --username-env MONKEYTEST_USERNAME --password-stdin

Those are variable names, not secret values. Form and manual sign-in also need
--post-login-url or --post-login-selector. Without that proof the run is
could_not_test, not a pass. A rerun does not reuse the session unless you pass
--use-session or a new password reference. An expired session is expired. It
is not a verified run.`,
  };
  console.log(text[cmd] || `No help for "${cmd}". Try \`monkeytest help\`.`);

}

/* ── Commands ─────────────────────────────────────────────────────────── */

async function cmdInit(opts: CommonOpts){
  const dir = resolve(opts.dir);
  mkdirSync(dir, { recursive: true });
  mkdirSync(resolve(dir, 'runs'),  { recursive: true });
  mkdirSync(resolve(dir, 'shots'), { recursive: true });

  const config = resolve(dir, 'config.json');
  if (!existsSync(config)){
    writeFileSync(config, JSON.stringify({
      $schema: 'https://docs.monkeytest.ai/config-schema-v1.json',
      provider: opts.provider || 'auto',
      quality: opts.quality,
      depth: opts.depth,
      maxPages: opts.maxPages,
      maxFlows: opts.maxFlows,
    }, null, 2));
  }

  const gitignore = resolve(dir, '.gitignore');
  if (!existsSync(gitignore)){
    writeFileSync(gitignore, [
      '# MonkeyTest local artefacts',
      'shots/',
      'runs/',
      'auth/',
      '*.tmp',
      '',
      '# Keep config + plan tracked',
      '!config.json',
      '!plan.json',
      '.star-noted',
      '',
    ].join('\n'));
  }

  console.log(`${tty('✓', 'green')} Initialised ${tty(relative(process.cwd(), dir) || '.', 'cyan')}/`);
  console.log(`  Tracked:    config.json, plan.json (after first run)`);
  console.log(`  Ignored:    shots/, runs/, auth/`);
  console.log(`\nNext: ${tty('monkeytest run https://example.com', 'cyan')}`);
}

type PreparedAuth =
  | { kind: 'anonymous' }
  | { kind: 'blocked'; run: RunResult; exitCode: number }
  | { kind: 'ready'; storageState: AuthStorageState; authOrigin: AuthOriginPolicy; metadata: AuthPublicMetadata };

function authBind(prepared: PreparedAuth, opts: CommonOpts) {
  if (prepared.kind !== 'ready') return undefined;
  return {
    targetOrigin: prepared.authOrigin.targetOrigin,
    idpOrigins: prepared.authOrigin.idpOrigins,
    storageState: prepared.storageState,
    ...(prepared.metadata.expiresAt ? { expiresAt: prepared.metadata.expiresAt } : {}),
    ...(opts.postLoginUrl ? { postLoginUrl: opts.postLoginUrl } : {}),
    ...(opts.postLoginSelector ? { postLoginSelector: opts.postLoginSelector } : {}),
  };
}

async function prepareAuth(
  url: string,
  opts: CommonOpts,
  extra: { prior?: AuthPublicMetadata; persist?: boolean } = {},
): Promise<PreparedAuth> {
  const persist = Boolean(extra.persist || opts.saveSession);
  const fresh = Boolean(opts.passwordEnv || opts.passwordStdin);
  const wants = opts.authManual || opts.useSession || fresh || persist || extra.prior?.outcome === 'authenticated';
  if (!wants) return { kind: 'anonymous' };
  if (opts.sessionTtl && !persist) die(2, '--session-ttl applies when saving a session (--save-session or auth login).');
  let sessionTtlMs: number | undefined;
  try { sessionTtlMs = parseTtl(opts.sessionTtl); }
  catch (err) { die(2, err instanceof Error ? err.message : String(err)); }
  if (opts.authManual && !process.stdin.isTTY) {
    die(2, 'Manual login needs a terminal so you can finish SSO or a second factor. Nothing was opened.');
  }
  let passwordFromStdin: string | undefined;
  if (opts.passwordStdin) passwordFromStdin = await readSecretLine({ prompt: 'Password (input hidden): ' });
  const sessionPath = (opts.useSession || persist) ? (opts.sessionPath || defaultSessionPath(opts.dir)) : undefined;
  const resolution = await resolveAuthInvocation({
    targetUrl: url,
    idpOrigins: opts.idpOrigins,
    usernameEnv: opts.usernameEnv,
    passwordEnv: opts.passwordEnv,
    passwordFromStdin,
    useSession: opts.useSession,
    saveSession: persist,
    sessionPath,
    sessionTtlMs,
    manual: opts.authManual,
    priorAuthenticated: extra.prior?.outcome === 'authenticated',
    postLoginUrl: opts.postLoginUrl,
    postLoginSelector: opts.postLoginSelector,
    headless: opts.authManual ? false : opts.headless,
    settle: opts.authManual
      ? async () => { await readSecretLine({ prompt: 'Log in in the browser, including any second factor, then press Enter. ' }); }
      : undefined,
  });
  if (resolution.kind === 'anonymous') return { kind: 'anonymous' };
  if (resolution.kind === 'blocked') {
    const run = triage(authBlockedRun(url, resolution.result.metadata));
    return { kind: 'blocked', run, exitCode: authProcessExit(resolution.result.metadata.outcome, resolution.result.setup) };
  }
  return {
    kind: 'ready',
    storageState: resolution.result.storageState,
    authOrigin: resolution.result.authOrigin,
    metadata: resolution.result.metadata,
  };
}

function finishBlockedAuth(run: RunResult, exitCode: number, opts: CommonOpts): void {
  const { path: runFile, id } = saveRun(run, { dir: opts.dir, engine: ENGINE_LABEL });
  if (opts.json) console.log(JSON.stringify({ run, runId: id, runFile }, null, 2));
  else {
    console.log(summariseRun(run));
    console.log(`  ${tty('run', 'dim')} → ${relative(process.cwd(), runFile)}`);
  }
  process.exit(exitCode);
}

async function cmdAuth(positional: string[], opts: CommonOpts) {
  const sub = positional[0];
  if (sub === 'logout') {
    const result = deleteAuthSession(opts.sessionPath || defaultSessionPath(opts.dir), { confirm: opts.deleteSession });
    console.log(result.detail);
    if (!opts.deleteSession) process.exit(2);
    return;
  }
  if (sub !== 'login') die(2, 'Usage: monkeytest auth login <url> | monkeytest auth logout --delete');
  const url = positional[1];
  if (!url) die(2, 'Usage: monkeytest auth login <url>');
  opts.authManual = true;
  const prepared = await prepareAuth(url, opts, { persist: true });
  if (prepared.kind === 'blocked') return finishBlockedAuth(prepared.run, prepared.exitCode, opts);
  console.log('Saved the local session file. It was not uploaded. A later run needs --use-session. Deleting the file does not sign the website out.');
}

async function cmdExplore(url: string | undefined, opts: CommonOpts){
  if (!url) die(2, 'Usage: monkeytest explore <url>');
  const prepared = await prepareAuth(url, opts);
  if (prepared.kind === 'blocked') return finishBlockedAuth(prepared.run, prepared.exitCode, opts);
  ensureLLMReady(opts);

  const monkey = new Monkey({ llm: buildLLMConfig(opts), plannerModel: opts.plannerModel, strictOracles: true, failOn5xx: opts.failOn5xx });
  console.log(`\n→ Exploring ${tty(url, 'cyan')} (max ${opts.maxPages} pages, headless=${opts.headless})…\n`);

  const t0 = Date.now();
  const screenshotsDir = resolve(opts.dir, 'shots');
  mkdirSync(screenshotsDir, { recursive: true });

  const { siteMap, plan } = await monkey.exploreAndPlan(url, {
    ...(authBind(prepared, opts) ? { auth: authBind(prepared, opts) } : {}),
    explore: {
      maxPages: opts.maxPages,
      headless: opts.headless,
      screenshotsDir: prepared.kind === 'ready' ? undefined : screenshotsDir,
      pageTimeoutMs: opts.pageTimeoutMs,
      onPage: (p) => console.log(`  · visited [${p.authGated ? 'auth' : 'open'}] ${p.url} — ${truncate(p.summary, 80)}`),
    },
    plan: { maxFlows: opts.maxFlows, focus: opts.focus, minFlows: opts.minFlows, maxPages: opts.maxPages, signupInbox: Boolean(opts.inboxModule || opts.inboxHttp) },
  });

  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  const sitemapFile = resolve(opts.dir, 'sitemap.json');
  mkdirSync(opts.dir, { recursive: true });
  writeFileSync(sitemapFile, JSON.stringify(siteMap, null, 2));
  const planFile = savePlan(plan, { dir: opts.dir, label: opts.label, engine: ENGINE_LABEL });

  console.log(summariseSiteMap(siteMap));
  console.log(summarisePlan(plan));
  console.log(`\n${tty('✓', 'green')} Done in ${dt}s.`);
  console.log(`  ${tty('sitemap', 'dim')} → ${relative(process.cwd(), sitemapFile)}`);
  console.log(`  ${tty('plan',    'dim')} → ${relative(process.cwd(), planFile)}\n`);
}

async function cmdRun(url: string | undefined, opts: CommonOpts){
  if (!url) die(2, 'Usage: monkeytest run <url>');
  const prepared = await prepareAuth(url, opts);
  if (prepared.kind === 'blocked') return finishBlockedAuth(prepared.run, prepared.exitCode, opts);
  ensureLLMReady(opts);

  const screenshotsDir = resolve(opts.dir, 'shots');
  mkdirSync(screenshotsDir, { recursive: true });

  const inbox = await inboxFromOpts(opts);
  const monkey = new Monkey({ llm: buildLLMConfig(opts), plannerModel: opts.plannerModel, strictOracles: true, failOn5xx: opts.failOn5xx, inbox });
  console.log(`\n→ Running ${tty(url, 'cyan')} (max ${opts.maxPages} pages, ${opts.maxFlows} flows, headless=${opts.headless})…\n`);

  const t0 = Date.now();
  const { siteMap, plan, run } = await monkey.executeAndTriage(url, {
    ...(authBind(prepared, opts) ? { auth: authBind(prepared, opts) } : {}),
    explore: {
      maxPages: opts.maxPages,
      headless: opts.headless,
      screenshotsDir: prepared.kind === 'ready' ? undefined : screenshotsDir,
      pageTimeoutMs: opts.pageTimeoutMs,
      onPage: (p) => console.log(`  · visited ${p.url}`),
    },
    plan: { maxFlows: opts.maxFlows, focus: opts.focus, minFlows: opts.minFlows, maxPages: opts.maxPages, signupInbox: Boolean(opts.inboxModule || opts.inboxHttp) },
    run:  {
      screenshotsDir,
      headless: opts.headless,
      stepTimeoutMs: opts.stepTimeoutMs,
      flowTimeoutMs: opts.flowTimeoutMs,
      totalBudgetMs: opts.totalBudgetMs,
      onEvent: (evt) => {
        if (evt.type === 'flow.start') console.log(`  ▶ ${tty(evt.flow.name, 'magenta')}`);
        if (evt.type === 'step.complete'){
          const sym = evt.result.status === 'passed' ? tty('✓', 'green') : evt.result.status === 'failed' ? tty('✗', 'red') : tty('·', 'dim');
          console.log(`    ${sym} step ${evt.index}: ${truncate(evt.result.observation, 80)}`);
        }
      },
    },
  });

  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  const planFile = savePlan(plan, { dir: opts.dir, label: opts.label, engine: ENGINE_LABEL });
  const { path: runFile, id: runId } = saveRun(run, {
    dir: opts.dir,
    planRef: { path: planFile, createdAt: new Date().toISOString() },
    engine: ENGINE_LABEL,
  });

  if (opts.json){
    console.log(JSON.stringify({ siteMap, plan, run, runId, runFile, planFile }, null, 2));
  } else {
    console.log(summariseSiteMap(siteMap));
    console.log(summarisePlan(plan));
    console.log(summariseRun(run));
  }

  console.log(`\n${tty('✓', 'green')} Done in ${dt}s.`);
  console.log(`  ${tty('plan', 'dim')} → ${relative(process.cwd(), planFile)}`);
  console.log(`  ${tty('run',  'dim')} → ${relative(process.cwd(), runFile)}  (id: ${tty(runId, 'cyan')})`);

  const blocking = run.bugs.filter(b => b.severity !== 'minor');
  if (blocking.length){
    console.error(`\n${tty(`✗ ${blocking.length} blocking bug${blocking.length === 1 ? '' : 's'} found.`, 'red')}`);
    process.exit(1);
  }
  if (siteMap.pages.length === 0) {
    console.error(`\n${tty('✗ Explorer loaded no pages, so this run cannot judge the site.', 'red')}`);
    process.exit(3);
  }
}

async function cmdRerun(runId: string | undefined, opts: CommonOpts){
  const stored = storedRunForRerun(runId, opts);
  const traces = stored ? tracesOf(stored.run) : [];

  if (stored && traces.length > 0){
    return replayStoredRun(stored, traces, opts);
  }

  if (stored){
    console.log(tty('No action trace on this run. Falling back to LLM re-resolution of the stored plan.', 'yellow'));
  }
  return rerunStoredPlan(stored, opts);
}

async function replayStoredRun(stored: StoredRun, traces: FlowTrace[], opts: CommonOpts){
  const prepared = await prepareAuth(stored.run.startUrl, opts, { prior: stored.run.auth });
  if (prepared.kind === 'blocked') return finishBlockedAuth(prepared.run, prepared.exitCode, opts);
  if (opts.heal) ensureLLMReady(opts);

  const screenshotsDir = resolve(opts.dir, 'shots');
  mkdirSync(screenshotsDir, { recursive: true });

  console.log(`\n↻ Replaying ${traces.length} trace(s) from ${tty(stored.id, 'cyan')}${opts.heal ? ' (heal on)' : ''}…\n`);
  const t0 = Date.now();
  const raw = await replayTraces(traces, {
    screenshotsDir,
    headless: opts.headless,
    heal: opts.heal,
    llm: opts.heal ? runnerLLM(opts) : undefined,
    strictOracles: true,
    failOn5xx: opts.failOn5xx,
    ...(prepared.kind === 'ready' ? {
      storageState: prepared.storageState,
      authOrigin: prepared.authOrigin,
      ...(prepared.metadata.expiresAt ? { sessionExpiresAt: prepared.metadata.expiresAt } : {}),
      ...(opts.postLoginUrl ? { postLoginUrl: opts.postLoginUrl } : {}),
      ...(opts.postLoginSelector ? { postLoginSelector: opts.postLoginSelector } : {}),
    } : {}),
  });
  const triaged = triage(raw, { failOn5xx: opts.failOn5xx });
  const run = raw.auth && raw.auth.outcome !== 'authenticated'
    ? { ...triaged, auth: raw.auth }
    : prepared.kind === 'ready' ? { ...triaged, auth: prepared.metadata } : triaged;
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const { path: runFile, id: newRunId } = saveRun(run, {
    dir: opts.dir,
    planRef: stored.planRef,
    engine: ENGINE_LABEL,
  });

  if (opts.json){
    console.log(JSON.stringify({ run, runId: newRunId, runFile, replay: true, heal: opts.heal }, null, 2));
  } else {
    console.log(summariseRun(run));
    const healed = run.flows.reduce((n, flow) => n + flow.steps.filter(step => step.resolution === 'healed').length, 0);
    if (healed) console.log(`  healed steps: ${healed}`);
  }
  console.log(`\n${tty('✓', 'green')} Replay complete in ${dt}s.`);
  console.log(`  ${tty('run', 'dim')} → ${relative(process.cwd(), runFile)}  (id: ${tty(newRunId, 'cyan')})`);
  suggestDiff(opts.dir, newRunId);
  exitIfBlocking(run);
}

async function rerunStoredPlan(stored: StoredRun | undefined, opts: CommonOpts){
  // Resolve plan: an explicit run means "use the plan stored alongside that run",
  // otherwise just load the canonical plan.json.
  let storedPlan;
  let planSource: string;

  if (stored?.planRef?.path){
    storedPlan = loadPlan(stored.planRef.path);
    planSource = stored.planRef.path;
  } else if (stored){
    die(2, `Stored run ${stored.id} has no action trace and no planRef. Cannot rerun.`);
    return;
  } else {
    storedPlan = loadPlan(opts.dir);
    planSource = resolve(opts.dir, 'plan.json');
  }
  const prepared = await prepareAuth(storedPlan.plan.startUrl, opts, { prior: stored?.run.auth ?? storedPlan.plan.auth });
  if (prepared.kind === 'blocked') return finishBlockedAuth(prepared.run, prepared.exitCode, opts);
  ensureLLMReady(opts);

  const screenshotsDir = resolve(opts.dir, 'shots');
  mkdirSync(screenshotsDir, { recursive: true });

  const monkey = new Monkey({ llm: buildLLMConfig(opts), plannerModel: opts.plannerModel, strictOracles: true, failOn5xx: opts.failOn5xx });
  console.log(`\n↻ Re-running ${storedPlan.plan.flows.length} flow(s) from ${tty(relative(process.cwd(), planSource), 'cyan')}…\n`);

  const t0 = Date.now();
  const { run } = await monkey.runFromPlan(storedPlan.plan, {
    ...(authBind(prepared, opts) ? { auth: authBind(prepared, opts) } : {}),
    run: {
      screenshotsDir,
      headless: opts.headless,
      onEvent: (evt) => {
        if (evt.type === 'flow.start') console.log(`  ▶ ${tty(evt.flow.name, 'magenta')}`);
        if (evt.type === 'step.complete'){
          const sym = evt.result.status === 'passed' ? tty('✓', 'green') : evt.result.status === 'failed' ? tty('✗', 'red') : tty('·', 'dim');
          console.log(`    ${sym} step ${evt.index}: ${truncate(evt.result.observation, 80)}`);
        }
      },
    },
  });

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const { path: runFile, id: newRunId } = saveRun(run, {
    dir: opts.dir,
    planRef: { path: planSource, createdAt: storedPlan.createdAt },
    engine: ENGINE_LABEL,
  });

  console.log(summariseRun(run));
  console.log(`\n${tty('✓', 'green')} Re-run complete in ${dt}s.`);
  console.log(`  ${tty('run', 'dim')} → ${relative(process.cwd(), runFile)}  (id: ${tty(newRunId, 'cyan')})`);

  // Auto-suggest a diff if there's a previous run to compare against.
  const ids = listRuns(opts.dir);
  if (ids.length >= 2){
    const previousId = ids[1]; // listRuns returns newest-first; [0] is the run we just wrote
    console.log(`\n${tty('Tip:', 'dim')} compare to previous run with:`);
    console.log(`  ${tty(`monkeytest diff ${previousId} ${newRunId}`, 'cyan')}`);
  }

  exitIfBlocking(run);
}

async function cmdVerify(positional: string | undefined, opts: CommonOpts){
  const stored = resolveStoredRun(positional, opts);
  const prepared = await prepareAuth(stored.run.startUrl, opts, { prior: stored.run.auth });
  if (prepared.kind === 'blocked') return finishBlockedAuth(prepared.run, prepared.exitCode, opts);
  if (opts.bug && !stored.run.bugs.some(bug => bugMatchesFingerprint(bug, opts.bug!))){
    const known = stored.run.bugs.map(bug => bug.fingerprint).slice(0, 8).join(', ');
    die(2, `No bug with fingerprint ${opts.bug} on run ${stored.id}.${known ? ` Known: ${known}` : ''}`);
  }
  if (opts.heal) ensureLLMReady(opts);

  const screenshotsDir = resolve(opts.dir, 'shots');
  mkdirSync(screenshotsDir, { recursive: true });

  if (!opts.json){
    const scope = opts.bug ? `bug ${opts.bug}` : `${stored.run.bugs.length} bug(s)`;
    console.log(`\n→ Verifying ${scope} from ${tty(stored.id, 'cyan')} (repeat ${opts.repeat}${opts.heal ? ', heal' : ''})…\n`);
  }

  const report = await verifyBugs(stored.run, {
    screenshotsDir,
    headless: opts.headless,
    ...(prepared.kind === 'ready' ? {
      storageState: prepared.storageState,
      authOrigin: prepared.authOrigin,
      ...(prepared.metadata.expiresAt ? { sessionExpiresAt: prepared.metadata.expiresAt } : {}),
      ...(opts.postLoginUrl ? { postLoginUrl: opts.postLoginUrl } : {}),
      ...(opts.postLoginSelector ? { postLoginSelector: opts.postLoginSelector } : {}),
    } : {}),
    heal: opts.heal,
    llm: opts.heal ? runnerLLM(opts) : undefined,
    repeat: opts.repeat,
    fingerprints: opts.bug ? [opts.bug] : undefined,
    recordVideo: false,
    strictOracles: true,
    failOn5xx: opts.failOn5xx,
  });

  if (opts.json){
    console.log(JSON.stringify({ runId: stored.id, ...report }, null, 2));
  } else {
    printVerifyTable(stored.id, report);
  }

  if (report.exitCode !== 0){
    const broken = report.stats.still_broken + report.stats.flaky;
    console.error(tty(`✗ ${broken} bug${broken === 1 ? '' : 's'} still firing.`, 'red'));
    process.exit(report.exitCode);
  }
}

function cmdDiff(a: string | undefined, b: string | undefined, opts: CommonOpts){
  if (!a || !b) die(2, 'Usage: monkeytest diff <runA> <runB>');

  const ids = listRuns(opts.dir);
  const resolveId = (s: string) => {
    if (s === 'latest') return ids[0];
    if (s === 'prev')   return ids[1];
    return s;
  };
  const idA = resolveId(a!);
  const idB = resolveId(b!);
  if (!idA || !idB) die(2, `Could not resolve run id(s). Available: ${ids.slice(0, 5).join(', ') || '(none)'}`);

  const runA = loadRun(idA, { dir: opts.dir });
  const runB = loadRun(idB, { dir: opts.dir });

  const diff = diffRuns(runA.run, runB.run);

  if (opts.json){
    console.log(JSON.stringify({ from: idA, to: idB, diff }, null, 2));
    return;
  }

  console.log(`\n${tty('Diff', 'bold')} ${tty(idA, 'dim')} → ${tty(idB, 'dim')}`);
  console.log(`  ${tty(summariseDiff(diff), 'bold')}\n`);

  printDiffSection('New bugs',         diff.newBugs,        'red');
  printDiffSection('Regressed bugs',   diff.regressedBugs,  'red');
  printDiffSection('Fixed bugs',       diff.fixedBugs,      'green');
  printDiffSection('Still broken',     diff.persistingBugs, 'yellow');

  // Exit 1 if anything got worse, so CI can gate on this
  if (diff.newBugs.length > 0 || diff.regressedBugs.length > 0){
    process.exit(1);
  }
  noteStar(opts, runB.run, { kind: 'diff', stats: diff.stats });
}

function cmdOpen(runId: string | undefined, opts: CommonOpts){
  const stored = resolveStoredRun(runId, opts);
  const runFile = storedRunFile(runId, opts, stored);
  const evidence = collectEvidencePaths(stored.run);
  if (opts.json){
    console.log(JSON.stringify({ runFile, evidence }, null, 2));
    return;
  }
  console.log(`Run file: ${runFile}`);
  console.log('Evidence (local files, not uploaded):');
  if (evidence.length === 0) console.log('  (none recorded)');
  for (const file of evidence) console.log(`  ${file}`);
  console.log('Open those paths on this machine. This command does not fetch the site and does not start a browser.');
}

function cmdReport(runId: string | undefined, opts: CommonOpts){
  const id = runId || 'latest';
  const stored = loadRun(id, { dir: opts.dir });
  const { run } = stored;

  if (opts.json){
    console.log(JSON.stringify(stored, null, 2));
    return;
  }

  console.log(`\n${tty('Report', 'bold')} for run ${tty(stored.id, 'cyan')}  (${stored.createdAt})`);
  if (stored.planRef?.path){
    console.log(`  ${tty('plan', 'dim')}: ${stored.planRef.path}`);
  }
  console.log(summariseRun(run));

  for (const flow of run.flows){
    const sym = flow.status === 'passed' ? tty('✓', 'green') : flow.status === 'failed' ? tty('✗', 'red') : tty('·', 'yellow');
    console.log(`\n  ${sym} ${tty(flow.name, 'bold')}  (${flow.steps.length} steps, ${(flow.durationMs / 1000).toFixed(1)}s)`);
    for (const s of flow.steps){
      const ssym = s.status === 'passed' ? tty('✓', 'green') : s.status === 'failed' ? tty('✗', 'red') : tty('·', 'dim');
      console.log(`      ${ssym} ${s.index}. ${truncate(s.action, 80)}`);
      if (s.screenshotPath) console.log(`         ${tty('shot', 'dim')}: ${relative(process.cwd(), s.screenshotPath)}`);
    }
  }

  if (run.suggestions?.length){
    console.log(`\n  ${tty('Suggestions:', 'bold')} ${tty('(not bugs)', 'dim')}`);
    const byPage = new Map<string, typeof run.suggestions>();
    for (const item of run.suggestions) {
      const list = byPage.get(item.pageUrl) ?? [];
      list.push(item);
      byPage.set(item.pageUrl, list);
    }
    for (const [pageUrl, items] of byPage) {
      console.log(`    ${pageUrl}`);
      for (const item of items) console.log(`      [${item.kind}] ${truncate(item.detail, 120)}`);
    }
  }

  if (run.bugs.length){
    console.log(`\n  ${tty('Bugs:', 'bold')}`);
    for (const b of run.bugs){
      const sev = b.severity === 'critical' ? tty(b.severity, 'red')
        : b.severity === 'major' ? tty(b.severity, 'yellow')
        : tty(b.severity, 'dim');
      console.log(`    [${sev}] ${b.title}`);
      console.log(`           ${tty('observed:', 'dim')} ${truncate(b.observed, 100)}`);
      console.log(`           ${tty('fingerprint:', 'dim')} ${b.fingerprint}`);
    }
  }
  console.log();
}

/* ── Pretty-print helpers ─────────────────────────────────────────────── */

function summariseSiteMap(siteMap: { startUrl: string; siteType: string; summary: string; pages: unknown[]; pendingUrls: unknown[]; failedUrls: unknown[]; warnings?: string[] }): string {
  const warnings = siteMap.warnings?.length
    ? `\n${siteMap.warnings.map(warning => `  ${tty('warning:', 'yellow')} ${warning}`).join('\n')}`
    : '';
  return `\n${tty('SiteMap', 'bold')}
  start:    ${siteMap.startUrl}
  type:     ${siteMap.siteType}
  summary:  ${truncate(siteMap.summary, 200)}
  pages:    ${siteMap.pages.length} visited, ${siteMap.pendingUrls.length} pending, ${siteMap.failedUrls.length} failed${warnings}`;
}

function summarisePlan(plan: { flows: { name: string; kind: string; steps: unknown[] }[]; notes?: string; plannerFallback?: boolean; plannerFallbackReason?: string }): string {
  if (plan.flows.length === 0 && !plan.plannerFallback) return `\n${tty('Plan', 'bold')}\n  (no flows)`;
  const lines = plan.flows.map((f, i) => `  ${i + 1}. [${f.kind}] ${f.name}  (${f.steps.length} steps)`);
  const fallback = plan.plannerFallback
    ? `\n  ${tty('fallback:', 'yellow')} ${plan.plannerFallbackReason || 'grounded plan'}`
    : '';
  return `\n${tty('Plan', 'bold')}\n${lines.join('\n') || '  (no flows)'}${fallback}${plan.notes ? `\n  notes: ${plan.notes}` : ''}`;
}

function summariseRun(run: { outcome?: string; outcome_reason?: string; outcome_detail?: string; suggestions?: unknown[]; warnings?: string[]; stats: { flowsTotal: number; flowsPassed: number; flowsFailed: number; bugsCritical: number; bugsMajor: number; bugsMinor: number } }): string {
  const { flowsTotal, flowsPassed, flowsFailed, bugsCritical, bugsMajor, bugsMinor } = run.stats;
  const outcome = run.outcome
    ? `\n  outcome:  ${tty(run.outcome, run.outcome === 'bugs_found' ? 'red' : run.outcome === 'clean' ? 'green' : 'yellow')}${run.outcome_reason ? ` (${run.outcome_reason})` : ''}`
    : '';
  const detail = run.outcome_detail ? `\n  ${truncate(run.outcome_detail, 220)}` : '';
  const suggestions = run.suggestions?.length
    ? `\n  suggestions: ${run.suggestions.length} (not counted as bugs)`
    : '';
  const warnings = run.warnings?.length
    ? `\n${run.warnings.map(warning => `  ${tty('warning:', 'yellow')} ${truncate(warning, 180)}`).join('\n')}`
    : '';
  return `\n${tty('Run', 'bold')}
  flows:    ${tty(`${flowsPassed}/${flowsTotal}`, flowsFailed === 0 ? 'green' : 'yellow')} passed, ${flowsFailed} failed
  bugs:     ${tty(String(bugsCritical), bugsCritical ? 'red' : 'dim')} critical, ${tty(String(bugsMajor), bugsMajor ? 'yellow' : 'dim')} major, ${tty(String(bugsMinor), 'dim')} minor${suggestions}${outcome}${detail}${warnings}`;
}

function printDiffSection(title: string, entries: { fingerprint: string; bug: BugReport }[], colour: keyof typeof c){
  if (entries.length === 0) return;
  console.log(`  ${tty(`${title} (${entries.length})`, colour)}`);
  for (const e of entries){
    console.log(`    [${e.bug.severity}] ${e.bug.title}`);
    console.log(`           ${tty('fingerprint:', 'dim')} ${e.fingerprint}`);
  }
  console.log();
}

function printVerifyTable(runId: string, report: VerifyReport){
  const { stats } = report;
  console.log(`${tty('Verify', 'bold')} ${tty(runId, 'dim')}`);
  console.log(
    `  ${tty(String(stats.fixed), 'green')} fixed, `
    + `${tty(String(stats.still_broken), stats.still_broken ? 'red' : 'dim')} still broken, `
    + `${tty(String(stats.flaky), stats.flaky ? 'yellow' : 'dim')} flaky, `
    + `${tty(String(stats.healed), stats.healed ? 'cyan' : 'dim')} healed, `
    + `${tty(String(stats.blocked), 'dim')} blocked\n`,
  );
  if (report.results.length === 0){
    console.log('  No bugs to verify.\n');
    return;
  }
  console.log(`  ${'fingerprint'.padEnd(18)} ${'verdict'.padEnd(14)} ${'fired'.padEnd(8)} title`);
  for (const row of report.results){
    const colour = row.verdict === 'fixed' ? 'green'
      : row.verdict === 'still_broken' ? 'red'
      : row.verdict === 'flaky' ? 'yellow'
      : row.verdict === 'healed' ? 'cyan'
      : 'dim';
    const shown = row.fingerprintV2 || row.fingerprint;
    console.log(`  ${shown.padEnd(18)} ${tty(row.verdict.padEnd(14), colour)} ${`${row.fired}/${row.repeat}`.padEnd(8)} ${truncate(row.title, 72)}`);
    if (row.verdict !== 'fixed'){
      console.log(`  ${''.padEnd(18)} ${tty(truncate(row.detail, 110), 'dim')}`);
    }
  }
  console.log();
}

function storedRunForRerun(runId: string | undefined, opts: CommonOpts): StoredRun | undefined {
  if (runId) return loadRun(runId, { dir: opts.dir });
  const ids = listRuns(opts.dir);
  if (ids.length === 0) return undefined;
  return loadRun(ids[0], { dir: opts.dir });
}

function resolveStoredRun(positional: string | undefined, opts: CommonOpts): StoredRun {
  if (!positional || positional === 'latest' || positional === 'prev'){
    const ids = listRuns(opts.dir);
    const id = positional === 'prev' ? ids[1] : ids[0];
    if (!id) die(2, `No runs found under ${resolve(opts.dir, 'runs')}.`);
    return loadRun(id, { dir: opts.dir });
  }
  const abs = resolve(positional);
  if (existsSync(abs) && statSync(abs).isDirectory()){
    return loadRun('latest', { dir: abs });
  }
  if (positional.endsWith('.json') || existsSync(abs)){
    return loadRun(abs);
  }
  return loadRun(positional, { dir: opts.dir });
}

function tracesOf(run: RunResult): FlowTrace[] {
  return run.flows
    .map(flow => flow.trace)
    .filter((trace): trace is FlowTrace => !!trace && trace.steps.length > 0);
}

function runnerLLM(opts: CommonOpts): LLM {
  const cfg = buildLLMConfig(opts);
  return createLLM(cfg.runner ?? cfg.planner);
}

function suggestDiff(dir: string, newRunId: string){
  const ids = listRuns(dir);
  if (ids.length >= 2){
    const previousId = ids[1];
    console.log(`\n${tty('Tip:', 'dim')} compare to previous run with:`);
    console.log(`  ${tty(`monkeytest diff ${previousId} ${newRunId}`, 'cyan')}`);
  }
}

function exitIfBlocking(run: RunResult){
  const blocking = run.bugs.filter(bug => bug.severity !== 'minor');
  if (blocking.length){
    console.error(`\n${tty(`✗ ${blocking.length} blocking bug${blocking.length === 1 ? '' : 's'} still failing.`, 'red')}`);
    process.exit(1);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function inboxFromOpts(opts: CommonOpts): Promise<InboxProvider | undefined> {
  if (opts.inboxModule && opts.inboxHttp) die(2, 'Pass either --inbox or --inbox-http, not both.');
  if (opts.inboxModule) return loadInboxProvider(opts.inboxModule);
  if (!opts.inboxHttp) return undefined;
  const token = process.env.MONKEYTEST_INBOX_TOKEN;
  return createHttpInbox({ baseUrl: opts.inboxHttp, ...(token ? { token } : {}) });
}

function storedRunFile(positional: string | undefined, opts: CommonOpts, stored: StoredRun): string {
  if (positional){
    const abs = resolve(positional);
    if (existsSync(abs) && !statSync(abs).isDirectory()) return abs;
  }
  return resolve(opts.dir, 'runs', `${stored.id}.json`);
}

function noteStar(opts: CommonOpts, run: RunResult, signal: StarNudgeInput['signal']){
  const marker = resolve(opts.dir, starMarkerName());
  const line = starNudgeLine({
    json: opts.json,
    tty: Boolean(process.stdout.isTTY),
    ci: Boolean(process.env.CI),
    optOut: opts.noStar || process.env.MONKEYTEST_NO_STAR === '1',
    alreadyNoted: existsSync(marker),
    startUrl: run.startUrl,
    finishedAt: run.finishedAt,
    outcome: run.outcome,
    currentBugCount: run.bugs.length,
    warnings: run.warnings,
    outcome_detail: run.outcome_detail,
    flows: run.flows.map(flow => ({
      outcome_detail: flow.outcome_detail,
      description: flow.description,
      failureReason: flow.failureReason,
      steps: flow.steps.map(step => ({ observation: step.observation, error: step.error })),
    })),
    bugs: run.bugs.map(bug => ({
      title: bug.title,
      observed: bug.observed,
      expected: bug.expected,
      triageNotes: bug.triageNotes,
    })),
    signal,
  });
  if (!line) return;
  try {
    writeFileSync(marker, 'noted\n', { flag: 'wx' });
  } catch {
    return;
  }
  console.log(`\n${line}\n`);
}

function die(code: number, msg: string): never {
  console.error(tty(msg, 'red'));
  process.exit(code);
}

/* ── Entrypoint ───────────────────────────────────────────────────────── */

async function main(){
  const args = parseArgs(process.argv);

  if (args.command === 'help' || args.showHelp){
    // If the user typed `monkeytest help <cmd>` we show that command's help.
    // Otherwise (`monkeytest --help` or no command) show the top-level help.
    const sub = args.command === 'help' ? args.positional[0] : args.command;
    printHelp(sub);
    return;
  }

  if (args.command === 'version'){
    console.log(ENGINE_LABEL);
    return;
  }

  switch (args.command){
    case 'init':    return cmdInit(args.opts);
    case 'explore': return cmdExplore(args.positional[0], args.opts);
    case 'run':     return cmdRun(args.positional[0], args.opts);
    case 'rerun':   return cmdRerun(args.positional[0], args.opts);
    case 'verify':  return cmdVerify(args.positional[0], args.opts);
    case 'diff':    return cmdDiff(args.positional[0], args.positional[1], args.opts);
    case 'report':  return cmdReport(args.positional[0], args.opts);
    case 'open':    return cmdOpen(args.positional[0], args.opts);
    case 'auth':    return cmdAuth(args.positional, args.opts);
    default:
      console.error(tty(`Unknown command: ${args.command}`, 'red'));
      printHelp();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`\n${tty('✗ monkeytest failed:', 'red')} ${err instanceof Error ? err.message : err}`);
  if (process.env.MONKEYTEST_DEBUG && err instanceof Error && err.stack){
    console.error(err.stack);
  }
  process.exit(3);
});
