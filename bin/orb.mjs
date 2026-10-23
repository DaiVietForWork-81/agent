#!/usr/bin/env node
// bin/orb.mjs — global launcher: `orb` opens the Orbit CLI from any terminal.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { existsSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (!existsSync(tsx)) {
  console.error('Orbit chưa được cài đầy đủ — chạy `npm install` trong ' + root);
  process.exit(1);
}

const child = spawn(process.execPath, [tsx, path.join(root, 'src', 'cli.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('orb: ' + err.message);
  process.exit(1);
});
