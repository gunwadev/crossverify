import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

test('plugin.json is valid JSON with required fields', () => {
  const raw = fs.readFileSync(path.join(repoRoot, 'plugin/.claude-plugin/plugin.json'), 'utf8');
  const data = JSON.parse(raw);
  assert.equal(data.name, 'crossverify');
  assert.equal(data.version, '0.1.0');
  assert.equal(typeof data.description, 'string');
  assert.ok(data.description.length > 0);
});

test('hooks.json is valid JSON with a Stop hook running verifier.mjs', () => {
  const raw = fs.readFileSync(path.join(repoRoot, 'plugin/hooks/hooks.json'), 'utf8');
  const data = JSON.parse(raw);
  assert.ok(Array.isArray(data.hooks.Stop));
  assert.equal(data.hooks.Stop.length, 1);
  const command = data.hooks.Stop[0].hooks[0].command;
  assert.equal(command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/verifier.mjs"');
});

test('commands/setup.md exists and points at scripts/setup.mjs', () => {
  const raw = fs.readFileSync(path.join(repoRoot, 'plugin/commands/setup.md'), 'utf8');
  assert.ok(raw.includes('${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs'));
  assert.ok(raw.startsWith('---'));
});

test('marketplace.json is valid JSON with owner, plugin entry, and strict true', () => {
  const raw = fs.readFileSync(path.join(repoRoot, '.claude-plugin/marketplace.json'), 'utf8');
  const data = JSON.parse(raw);
  assert.equal(data.name, 'crossverify');
  assert.equal(typeof data.owner.name, 'string');
  assert.ok(data.owner.name.length > 0);
  assert.deepEqual(data.plugins, [{ name: 'crossverify', source: './plugin' }]);
  assert.equal(data.strict, true);
});
