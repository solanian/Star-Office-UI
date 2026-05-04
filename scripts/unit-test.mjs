#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = process.cwd();
const sourcePath = path.join(root, 'src/lib/server/office.ts');
const tmp = await mkdtemp(path.join(root, '.unit-tmp-'));
const outPath = path.join(tmp, 'office.mjs');
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true
  }
});

await writeFile(outPath, transpiled.outputText, 'utf8');
try {
  const { normalizeAgentState, normalizeUserModel, stateToArea } = await import(pathToFileURL(outPath).href);

  const stateCases = [
    ['working', 'writing'],
    ['busy', 'writing'],
    ['write', 'writing'],
    ['run', 'executing'],
    ['running', 'executing'],
    ['execute', 'executing'],
    ['exec', 'executing'],
    ['sync', 'syncing'],
    ['research', 'researching'],
    ['search', 'researching'],
    ['error', 'error'],
    ['unknown', 'idle'],
    ['', 'idle'],
    [null, 'idle']
  ];

  for (const [input, expected] of stateCases) {
    assert.equal(normalizeAgentState(input), expected, `normalizeAgentState(${String(input)})`);
  }

  assert.equal(stateToArea('idle'), 'breakroom');
  assert.equal(stateToArea('error'), 'error');
  assert.equal(stateToArea('writing'), 'writing');
  assert.equal(stateToArea('researching'), 'writing');
  assert.equal(stateToArea('executing'), 'writing');
  assert.equal(stateToArea('syncing'), 'writing');

  assert.equal(normalizeUserModel('nanobanana-2'), 'nanobanana-2');
  assert.equal(normalizeUserModel('gemini-2.5-flash-image'), 'nanobanana-2');
  assert.equal(normalizeUserModel('nanobanana-pro'), 'nanobanana-pro');
  assert.equal(normalizeUserModel('Gemini-3-Pro-Image-Preview'), 'nanobanana-pro');
  assert.equal(normalizeUserModel('other-model'), 'nanobanana-pro');

  console.log('[unit] PASS');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
