/** Generate the synthetic test fixtures if they are missing (pretest hook). */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(resolve(root, 'tests/fixtures/index.json'))) {
  console.log('test fixtures missing — generating…');
  execFileSync('node', [resolve(root, 'scripts/gen-fixtures.mjs')], { stdio: 'inherit' });
}
