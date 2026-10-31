import { readFile, mkdir, cp, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const source = new URL('../node_modules/pdfjs-dist/', import.meta.url);
const target = new URL('../extension/vendor/pdfjs/', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', source), 'utf8'));
if (pkg.version !== '6.4.299') throw new Error('Unexpected PDF.js version; review dependency before vendoring.');
await mkdir(target, { recursive: true });
// Legacy bundles include local compatibility shims for the manifest's Chrome 120 baseline.
for (const [entry, output] of [['legacy/build/pdf.mjs', 'build/pdf.mjs'], ['legacy/build/pdf.worker.mjs', 'build/pdf.worker.mjs'], ['cmaps', 'cmaps'], ['standard_fonts', 'standard_fonts'], ['LICENSE', 'LICENSE']]) {
  const destination = new URL(output, target);
  await mkdir(new URL('./', destination), { recursive: true });
  await cp(new URL(entry, source), destination, { recursive: true });
}
const hashes = {};
async function hashTree(url, prefix = '') {
  for (const entry of await readdir(url, { withFileTypes: true })) {
    if (entry.name === 'PROVENANCE.json') continue;
    const path = prefix + entry.name;
    if (entry.isDirectory()) await hashTree(new URL(entry.name + '/', url), path + '/');
    else hashes[path] = createHash('sha256').update(await readFile(new URL(entry.name, url))).digest('hex');
  }
}
await hashTree(target);
await writeFile(new URL('PROVENANCE.json', target), JSON.stringify({ package: 'pdfjs-dist', version: pkg.version, build: 'legacy/build modules copied to build/ (compatibility shims included)', license: 'Apache-2.0', source: 'https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz', integrity: 'sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==', regenerate: 'npm ci --ignore-scripts --omit=optional && npm run vendor:pdf', hashes }, null, 2) + '\n');
console.log('Vendored PDF.js', pkg.version, Object.keys(hashes).length, 'local resources; Wasm disabled by reader.');
