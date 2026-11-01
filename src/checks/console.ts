/**
 * First-party console errors and uncaught exceptions on load.
 */

import type { ConsoleErrorEvidence } from '../types.js';
import { isIgnoredConsoleMessage } from './noise.js';

export interface ConsoleHit {
  message: string;
  sourceUrl?: string;
  /** `pageerror` is an uncaught exception. `console` is console.error. */
  kind: 'pageerror' | 'console';
}

export interface ConsoleJudgement {
  bugs: ConsoleHit[];
  ignored: number;
}

export function judgeConsole(hits: ConsoleHit[], pageUrl: string): ConsoleJudgement {
  const bugs: ConsoleHit[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  for (const hit of hits) {
    const message = hit.message.replace(/\s+/g, ' ').trim();
    if (!message) continue;
    if (isIgnoredConsoleMessage(message, hit.sourceUrl, pageUrl)) {
      ignored += 1;
      continue;
    }
    const key = message.slice(0, 180);
    if (seen.has(key)) continue;
    seen.add(key);
    bugs.push({ ...hit, message });
  }
  return { bugs, ignored };
}

export function consoleEvidence(bugs: ConsoleHit[]): ConsoleErrorEvidence[] {
  return bugs.slice(0, 8).map(hit => ({
    message: hit.message.slice(0, 300),
    level: 'error' as const,
    ...(hit.sourceUrl ? { url: hit.sourceUrl } : {}),
  }));
}
