import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectEvidencePaths } from '../src/reportPaths.js';

describe('monkeytest open', () => {
  it('prints local evidence paths and does not include a star line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'monkeytest-open-'));
    const shot = join(dir, 'step.png');
    const video = join(dir, 'flow.webm');
    writeFileSync(shot, 'png');
    writeFileSync(video, 'webm');
    const run = {
      startUrl: 'http://127.0.0.1:9/',
      startedAt: '2026-11-08T00:00:00.000Z',
      finishedAt: '2026-11-08T00:00:01.000Z',
      flows: [{
        flowId: 'checkout',
        name: 'Checkout',
        description: 'Checkout',
        kind: 'happy_path',
        startUrl: 'http://127.0.0.1:9/',
        status: 'failed',
        steps: [{ index: 1, action: 'Click Place order', status: 'failed', observation: 'disabled', screenshotPath: shot }],
        durationMs: 10,
        bugIds: [],
        videoPath: video,
      }],
      bugs: [{ evidence: { screenshots: [shot] } }],
      stats: {
        flowsTotal: 1, flowsPassed: 0, flowsFailed: 1, flowsBlocked: 0,
        stepsTotal: 1, stepsPassed: 0, stepsFailed: 1,
        bugsCritical: 0, bugsMajor: 1, bugsMinor: 0,
      },
    };
    expect(collectEvidencePaths(run)).toEqual([video, shot]);
    const id = 'sample-run';
    const runs = join(dir, 'runs');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(runs);
    writeFileSync(join(runs, `${id}.json`), JSON.stringify({
      schema: 1,
      id,
      createdAt: '2026-11-08T00:00:00.000Z',
      run,
    }));
    const cli = await runCli(['open', id, '--dir', dir, '--json']);
    expect(cli.code).toBe(0);
    const parsed = JSON.parse(cli.stdout);
    expect(parsed.evidence).toEqual([video, shot]);
    expect(parsed.runFile.endsWith(`${id}.json`)).toBe(true);
    expect(cli.stdout).not.toContain('github.com/monkeytestai/monkeytester');
    expect(cli.stderr).not.toContain('github.com');
  });
});

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: root,
      env: { ...process.env, CI: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
