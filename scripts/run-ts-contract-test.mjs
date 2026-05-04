#!/usr/bin/env node

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const dataDir = await mkdtemp(path.join(tmpdir(), 'star-office-contract-'));
const port = process.env.PORT || '19000';
const baseUrl = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, ['build/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: port,
    ORIGIN: baseUrl,
    STAR_OFFICE_DATA_DIR: dataDir
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // Keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('server did not become healthy in time');
}

let exitCode = 0;
try {
  await waitForHealth();
  const child = spawn(process.execPath, ['scripts/contract-test.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      CONTRACT_BASE_URL: baseUrl
    },
    stdio: 'inherit'
  });
  exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
} catch (err) {
  console.error(err instanceof Error ? err.stack : String(err));
  exitCode = 1;
} finally {
  server.kill('SIGTERM');
}

process.exit(exitCode);
