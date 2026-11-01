/**
 * Compare planner models on the same URLs.
 *
 *   npx tsx scripts/bakeoff.ts \
 *     --urls https://jewellerycasting08.lovable.app/?mode=signin,https://the-internet.herokuapp.com/ \
 *     --models gpt-4o-mini,gpt-4o \
 *     --out bakeoff.json
 *
 * Each run writes one JSON record, then the process prints a comparison table.
 * Page summaries stay on the cheap explorer model. Only the planner model changes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Monkey } from '../src/monkey.js';
import { BASIC_PRESET } from '../src/depth.js';
import { autoLLMConfig } from '../src/llm/presets.js';
import { estimateCostUsd, MODEL_PRICES } from '../src/llm/prices.js';
import { isOwnAutomationBug } from '../src/automation/signatures.js';
import { findUncrawledReferences } from '../src/planner/inventory.js';
import type { BugReport, LLMUsageEvent, TestPlan } from '../src/types.js';

interface BakeoffRow {
  url: string;
  plannerModel: string;
  caseCount: number;
  realBugs: number;
  realBugTitles: string[];
  inventedFlows: number;
  invented: { id: string; name: string; reason: string }[];
  falsePositiveCandidates: number;
  falsePositiveTitles: string[];
  plannerLatencyMs: number;
  wallTimeMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
}

function arg(name: string, argv: string[]): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function list(value: string | undefined): string[] {
  return (value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function isFalsePositiveCandidate(bug: BugReport): boolean {
  if (isOwnAutomationBug(bug)) return true;
  if (bug.severity === 'minor') return true;
  const text = `${bug.title}\n${bug.observed}`;
  return /autocomplete|tap target|viewport|meta description|h1/i.test(text);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('npx tsx scripts/bakeoff.ts --urls <url>[,<url>...] --models <id>[,<id>...] [--out bakeoff.json]');
    return;
  }
  const urls = list(arg('--urls', argv));
  const models = list(arg('--models', argv));
  const outPath = resolve(arg('--out', argv) || 'bakeoff.json');
  if (urls.length === 0 || models.length === 0) {
    console.error('Pass --urls and --models, comma-separated.');
    process.exit(2);
  }

  let base;
  try {
    base = autoLLMConfig({ quality: 'balanced' });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const rows: BakeoffRow[] = [];
  for (const url of urls) {
    for (const plannerModel of models) {
      const usage = { prompt: 0, completion: 0 };
      const onUsage = (event: LLMUsageEvent) => {
        usage.prompt += event.inputTokens || 0;
        usage.completion += event.outputTokens || 0;
      };
      const sink = <T extends { onUsage?: typeof onUsage }>(config: T): T => ({ ...config, onUsage });
      const monkey = new Monkey({
        plannerModel,
        llm: {
          explorer: sink(base.explorer),
          planner: sink(base.planner),
          runner: sink(base.runner ?? base.explorer),
        },
      });
      const screenshotsDir = resolve('.monkeytest/bakeoff', slug(url), slug(plannerModel));
      mkdirSync(screenshotsDir, { recursive: true });
      const wallStart = Date.now();
      const { siteMap, plan, run } = await monkey.executeAndTriage(url, {
        explore: {
          maxPages: BASIC_PRESET.pages,
          pageTimeoutMs: BASIC_PRESET.pageTimeoutMs,
          headless: true,
          screenshotsDir,
        },
        plan: {
          maxFlows: BASIC_PRESET.llmFlows,
          minFlows: BASIC_PRESET.llmFlows,
          maxPages: BASIC_PRESET.pages,
          focus: 'forms-search-cta',
        },
        run: {
          screenshotsDir,
          headless: true,
          recordVideo: false,
          stepTimeoutMs: BASIC_PRESET.stepTimeoutMs,
          flowTimeoutMs: BASIC_PRESET.flowTimeoutMs,
          totalBudgetMs: BASIC_PRESET.totalBudgetMs,
        },
      });
      const wallTimeMs = Date.now() - wallStart;
      const real = run.bugs.filter(bug => !isOwnAutomationBug(bug));
      const candidates = run.bugs.filter(isFalsePositiveCandidate);
      const invented = inventedFlows(plan, siteMap);
      const row: BakeoffRow = {
        url,
        plannerModel,
        caseCount: plan.flows.length,
        realBugs: real.length,
        realBugTitles: real.map(bug => bug.title).slice(0, 12),
        inventedFlows: invented.length,
        invented: invented.slice(0, 20),
        falsePositiveCandidates: candidates.length,
        falsePositiveTitles: candidates.map(bug => bug.title).slice(0, 12),
        plannerLatencyMs: plan.plannerLatencyMs ?? 0,
        wallTimeMs,
        promptTokens: usage.prompt,
        completionTokens: usage.completion,
        costUsd: estimateCostUsd(plannerModel, usage.prompt, usage.completion),
      };
      rows.push(row);
      const partial = { prices: MODEL_PRICES, runs: rows };
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(partial, null, 2));
      console.log(`\n${url} · ${plannerModel}: ${row.caseCount} cases, ${row.realBugs} real bugs, ${row.wallTimeMs}ms`);
    }
  }

  const report = { prices: MODEL_PRICES, runs: rows };
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  printTable(rows);
  console.log(`\nWrote ${outPath}`);
}

function inventedFlows(plan: TestPlan, siteMap: Parameters<typeof findUncrawledReferences>[1]) {
  const dropped = plan.droppedFlows ?? [];
  const still = findUncrawledReferences(plan.flows, siteMap);
  return [...dropped, ...still];
}

function printTable(rows: BakeoffRow[]): void {
  const header = ['url', 'model', 'cases', 'real bugs', 'invented', 'fp candidates', 'planner ms', 'wall s', 'prompt', 'completion', 'usd'];
  const body = rows.map(row => [
    row.url,
    row.plannerModel,
    String(row.caseCount),
    String(row.realBugs),
    String(row.inventedFlows),
    String(row.falsePositiveCandidates),
    String(row.plannerLatencyMs),
    (row.wallTimeMs / 1000).toFixed(1),
    String(row.promptTokens),
    String(row.completionTokens),
    row.costUsd === null ? 'n/a' : row.costUsd.toFixed(4),
  ]);
  const widths = header.map((cell, index) => Math.max(cell.length, ...body.map(line => line[index].length)));
  const format = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  console.log(`\n${format(header)}`);
  console.log(widths.map(width => '-'.repeat(width)).join('  '));
  for (const line of body) console.log(format(line));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'run';
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(3);
});
