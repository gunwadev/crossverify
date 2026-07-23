import { test } from 'node:test';
import assert from 'node:assert/strict';

test('smoke: test runner is wired up', () => {
  assert.equal(1 + 1, 2);
});

test('smoke: repo root package.json declares an ESM module', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.join(testDir, '..', 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.name, 'crossverify');
});
