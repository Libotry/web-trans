import { readdir, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../extension/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page]) await access(new URL(file, root));
for (const file of await readdir(root)) if (file.endsWith('.js')) {
  const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(file, root))], { encoding: 'utf8' });
  if (result.status) throw new Error(result.stderr); console.log('Syntax OK:', file);
}
console.log('Manifest OK; no build or runtime dependencies required.');
