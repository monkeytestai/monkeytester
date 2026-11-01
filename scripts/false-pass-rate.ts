/**
 * Compare how many recorded flows beta.2 would mark passed from step
 * execution alone with how many beta.3 would still mark passed without a
 * verified outcome.
 *
 *   npx tsx scripts/false-pass-rate.ts
 */

import { FALSE_PASS_CASES } from '../src/audit/cases.js';
import { measureFalsePasses } from '../src/audit/falsePass.js';

const report = measureFalsePasses(FALSE_PASS_CASES);
const byType = new Map<string, { before: number; after: number }>();
for (const row of report.rows) {
  const bucket = byType.get(row.flowType) ?? { before: 0, after: 0 };
  if (row.before) bucket.before += 1;
  if (row.after) bucket.after += 1;
  byType.set(row.flowType, bucket);
}

console.log(`false-pass flows before (0.7.0-beta.2 execution-only): ${report.before}`);
console.log(`false-pass flows after (0.7.0-beta.3, no verified outcome): ${report.after}`);
console.log('by flow type:');
for (const [flowType, bucket] of byType) {
  console.log(`  ${flowType}: before ${bucket.before}, after ${bucket.after}`);
}
for (const row of report.rows) {
  console.log(`  ${row.before ? 'PASS' : 'ok  '} → ${row.after ? 'PASS' : 'held'}  ${row.flowType}  ${row.id}`);
}
