#!/usr/bin/env node
/**
 * Enforces the JavaScript-only rule: no TypeScript sources, configs or dependencies may
 * enter the repository.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'test-results', 'playwright-report', '.turbo']);
const FORBIDDEN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const FORBIDDEN_FILES = new Set(['tsconfig.json', 'tsconfig.base.json', 'next-env.d.ts']);
const FORBIDDEN_DEPENDENCIES = [/^typescript$/, /^ts-node$/, /^@types\//, /^tsx$/];

const problems = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full);
      continue;
    }
    if (FORBIDDEN_EXTENSIONS.has(extname(entry)) || FORBIDDEN_FILES.has(basename(entry))) {
      problems.push(`TypeScript artefact: ${full.replace(`${ROOT}/`, '')}`);
    }
    if (entry === 'package.json') {
      const manifest = JSON.parse(readFileSync(full, 'utf8'));
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const name of Object.keys(manifest[field] ?? {})) {
          if (FORBIDDEN_DEPENDENCIES.some((pattern) => pattern.test(name))) {
            problems.push(`TypeScript dependency "${name}" in ${full.replace(`${ROOT}/`, '')} (${field})`);
          }
        }
      }
    }
  }
}

walk(ROOT);

if (problems.length > 0) {
  console.error('TypeScript is not allowed in this repository:\n');
  problems.forEach((problem) => console.error(`  - ${problem}`));
  process.exit(1);
}
console.log('No TypeScript sources, configs or dependencies found.');
