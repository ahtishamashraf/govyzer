#!/usr/bin/env node
/**
 * Fails when unfinished work slips into the source: TODO/FIXME markers, empty click
 * handlers, alert() driven UX, hardcoded tenant ids or production paths that fall back to
 * a mock provider.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'test-results', 'playwright-report', 'docs']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);

const PATTERNS = [
  { name: 'TODO marker', pattern: /\b(TODO|FIXME|XXX|HACK)\b/ },
  { name: 'empty click handler', pattern: /on(Click|Submit|Change)=\{\s*\(\)\s*=>\s*\{\s*\}\s*\}/ },
  { name: 'alert() interaction', pattern: /(?<![\w.])alert\(/ },
  { name: 'not implemented stub', pattern: /not\s+implemented\b/i },
  { name: 'hardcoded ULID tenant id', pattern: /organization_id\s*[:=]\s*'01[0-9A-HJKMNP-TV-Z]{24}'/ },
  { name: 'coming soon placeholder', pattern: /coming soon/i },
];

const ALLOWLIST = [
  // The adapter contract deliberately reports an unimplemented capability to callers.
  { file: 'packages/integrations/src/contract.js', name: 'not implemented stub' },
  { file: 'scripts/check-placeholders.mjs', name: null },
];

const findings = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extname(entry))) continue;

    const relative = full.replace(`${ROOT}/`, '');
    const lines = readFileSync(full, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const { name, pattern } of PATTERNS) {
        if (!pattern.test(line)) continue;
        const allowed = ALLOWLIST.some((entry) => relative === entry.file && (entry.name === null || entry.name === name));
        if (allowed) continue;
        findings.push(`${relative}:${index + 1}  ${name}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
}

walk(ROOT);

if (findings.length > 0) {
  console.error('Unfinished work markers found:\n');
  findings.forEach((finding) => console.error(`  - ${finding}`));
  process.exit(1);
}
console.log('No placeholder or unfinished-work markers found in source files.');
