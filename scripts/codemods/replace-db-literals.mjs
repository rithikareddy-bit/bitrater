#!/usr/bin/env node
// Replace db('chai_q_lab') / db('master') / db('gld2sqs') in the dashboard with
// config lookups (dashboard/lib/config.js). Pure rename; verified by
// scripts/codemods/verify_equivalence.py.
//
// Usage: node scripts/codemods/replace-db-literals.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIRS = ['dashboard/app', 'dashboard/lib', 'dashboard/components'];
const SKIP = new Set(['dashboard/lib/config.js']);

const RULES = [
  [/db\('chai_q_lab'\)/g, 'db(DB_LAB)', 'DB_LAB'],
  [/db\('master'\)/g, 'db(DB_MASTER)', 'DB_MASTER'],
  [/db\('gld2sqs'\)/g, 'db(DB_DEV)', 'DB_DEV'],
];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : /\.(js|mjs|ts|tsx|jsx)$/.test(d.name) ? [p] : [];
  });
}

function insertImport(src, names) {
  const line = `import { ${names.join(', ')} } from '@/lib/config';`;
  const lines = src.split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\s/.test(lines[i])) {
      while (!/;\s*$|from\s+['"][^'"]+['"]\s*;?\s*$/.test(lines[i]) && i < lines.length - 1) i++;
      last = i;
    }
  }
  if (last === -1) {
    // No imports: keep any leading 'use client'/'use server' directive first.
    while (last + 1 < lines.length && /^\s*['"]use (client|server)['"];?\s*$/.test(lines[last + 1])) last++;
  }
  lines.splice(last + 1, 0, line);
  return lines.join('\n');
}

const check = process.argv.includes('--check');
const changed = [];
for (const file of DIRS.flatMap((d) => walk(path.join(ROOT, d)))) {
  const rel = path.relative(ROOT, file);
  if (SKIP.has(rel)) continue;
  const src = fs.readFileSync(file, 'utf8');
  let out = src;
  const used = [];
  for (const [re, repl, name] of RULES) {
    if (re.test(out)) { out = out.replace(re, repl); used.push(name); }
    re.lastIndex = 0;
  }
  if (out === src) continue;
  out = insertImport(out, used);
  changed.push(rel);
  if (!check) fs.writeFileSync(file, out);
}
for (const c of changed) console.log(`${check ? 'would change' : 'changed'}: ${c}`);
process.exit(check && changed.length ? 1 : 0);
