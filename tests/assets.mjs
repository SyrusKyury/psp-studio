import { access, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function assert(condition, message) { if (!condition) throw new Error(message); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exists = async (relative) => { try { await access(path.join(root, relative)); return true; } catch { return false; } };

const sources = [];
for (const relative of ['index.html', 'help.html']) {
  let html = await readFile(path.join(root, relative), 'utf8');
  // Documentation code samples are inert text, not runtime asset references.
  if (relative === 'help.html') html = html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, '');
  sources.push(html);
}
for (const area of ['js', 'assets/css']) {
  const stack = [path.join(root, area)];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.(?:js|css)$/.test(entry.name)) sources.push(await readFile(full, 'utf8'));
    }
  }
}
const source = sources.join('\n');
const literalAssets = new Set([...source.matchAll(/(?:\.\.\/|\.\/)*assets\/([A-Za-z0-9_./-]+\.svg)/g)].map((match) => `assets/${match[1]}`));
for (const relative of literalAssets) assert(await exists(relative), `Missing referenced SVG asset: ${relative}`);

const iconService = await readFile(path.join(root, 'js/core/file-icon-service.js'), 'utf8');
const fileKinds = new Set(['file', 'folder', 'folder-open']);
for (const match of iconService.matchAll(/map\('([^']+)'/g)) fileKinds.add(match[1]);
for (const kind of fileKinds) {
  const filename = kind === 'folder-open' ? 'folder-open.svg' : `${kind}.svg`;
  assert(await exists(`assets/file-icons/${filename}`), `Missing dynamic Project Explorer icon: ${filename}`);
}

const catalog = JSON.parse(await readFile(path.join(root, 'tools/catalog.json'), 'utf8'));
for (const id of [...catalog.core, ...catalog.tools]) {
  const manifest = JSON.parse(await readFile(path.join(root, 'tools', id, 'tool.json'), 'utf8'));
  const relative = manifest.icon ? `tools/${id}/${manifest.icon}` : 'assets/tool-default.svg';
  assert(await exists(relative), `Missing catalog tool icon: ${relative}`);
}

const uiFiles = (await readdir(path.join(root, 'assets/ui-icons'))).filter((name) => name.endsWith('.svg')).sort();
const componentsPath = path.join(root, 'assets/css/components.css');
const components = await readFile(componentsPath, 'utf8');
assert(!source.includes("--icon:url('./assets/ui-icons/") && !source.includes('--icon:url("./assets/ui-icons/'), 'UI icon URLs must not be embedded as document-relative custom properties');

const iconRules = new Map();
for (const match of components.matchAll(/\.icon-([a-z0-9-]+)\{--icon:url\(["']([^"']+\.svg)["']\)\}/g)) {
  iconRules.set(match[1], match[2]);
  const resolved = path.resolve(path.dirname(componentsPath), match[2]);
  assert(resolved.startsWith(path.resolve(root) + path.sep), `UI icon CSS path escapes project root: ${match[2]}`);
  assert(await exists(path.relative(root, resolved)), `UI icon CSS URL resolves to missing asset: ${match[2]}`);
}

const uiUsageSource = [await readFile(path.join(root, 'index.html'), 'utf8'), ...(await Promise.all((await readdir(path.join(root, 'js/core'))).filter((name) => name.endsWith('.js')).map((name) => readFile(path.join(root, 'js/core', name), 'utf8'))))].join('\n');
const usedIconClasses = new Set([...uiUsageSource.matchAll(/\bui-icon\s+icon-([a-z0-9-]+)\b/g)].map((match) => match[1]));
for (const name of usedIconClasses) assert(iconRules.has(name), `UI icon class has no CSS asset mapping: icon-${name}`);
for (const name of iconRules.keys()) assert(usedIconClasses.has(name), `Unused UI icon CSS mapping: icon-${name}`);
for (const icon of uiFiles) {
  const logical = icon.replace(/\.svg$/, '');
  assert(iconRules.has(logical), `Unused UI icon asset: ${icon}`);
}
for (const [name, relativeUrl] of iconRules) {
  const filename = path.basename(relativeUrl);
  assert(uiFiles.includes(filename), `Referenced UI icon is missing: ${filename}`);
}
assert(await exists('js/workers/search-worker.js'), 'Search worker entry point is missing');
console.log(`Asset validation passed: ${literalAssets.size} literal SVG references, ${fileKinds.size} dynamic file-icon kinds, ${uiFiles.length} UI icons with stylesheet-relative paths`);
