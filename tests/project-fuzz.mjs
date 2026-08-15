import { File } from 'node:buffer';
import { ProjectStore } from '../js/core/project-store.js';

function assert(condition, message) { if (!condition) throw new Error(message); }
function flatten(project) { const out = []; const stack = [...project.root.children].reverse(); while (stack.length) { const node = stack.pop(); out.push(node); if (node.isDirectory) stack.push(...[...node.children].reverse()); } return out; }
function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 0x100000000; }; }

function verify(project) {
  const flat = flatten(project);
  assert(!('nodesById' in project) && !('nodesByPath' in project), 'Project internal indexes leaked onto the public store surface');
  assert(project.byId('root') === project.root && project.root.parent === null, 'Project root invariant failed');
  const paths = new Set(['/']); const ids = new Set(['root']);
  for (const node of flat) {
    assert(node.parent?.isDirectory && node.parent.children.includes(node), `Broken parent link: ${node.path}`);
    assert(project.byId(node.id) === node && project.owns(node), `Broken identity index: ${node.path}`);
    assert(!paths.has(node.path), `Duplicate Project path: ${node.path}`); paths.add(node.path);
    assert(!ids.has(node.id), `Duplicate Project node id: ${node.id}`); ids.add(node.id);
    assert(project.get(node.path) === node, `Path lookup mismatch: ${node.path}`);
  }
}

{
  const canonical = new ProjectStore('Canonical paths');
  const folder = canonical.createFolder('/', 'A');
  canonical.addBlob(folder.path, 'B.bin', new Blob(['x']));
  assert(canonical.get('/A/B.bin')?.name === 'B.bin', 'Canonical path lookup failed');
  assert(canonical.get('/A//B.bin') === null, 'Project path lookup accepted a double-slash alias');
  assert(canonical.get('A/B.bin') === null, 'Project path lookup accepted a relative alias');
  assert(canonical.get('/A/B.bin/') === null, 'Project path lookup accepted a trailing-slash alias');
}

for (let seed = 1; seed <= 12; seed += 1) {
  const random = rng(seed); const project = new ProjectStore(`Fuzz ${seed}`);
  for (let step = 0; step < 250; step += 1) {
    const all = [project.root, ...flatten(project)];
    const folders = all.filter((node) => node.isDirectory);
    const nonRoot = all.filter((node) => node !== project.root);
    const operation = Math.floor(random() * 5);
    try {
      if (operation === 0 || !nonRoot.length) {
        const folder = folders[Math.floor(random() * folders.length)];
        project.createFolder(folder.path, `D${Math.floor(random() * 35)}`);
      } else if (operation === 1) {
        const folder = folders[Math.floor(random() * folders.length)];
        project.addBlob(folder.path, `F${Math.floor(random() * 35)}.bin`, new Blob([`${seed}:${step}`]));
      } else if (operation === 2) {
        const node = nonRoot[Math.floor(random() * nonRoot.length)];
        project.rename(node, `${node.isDirectory ? 'R' : 'X'}${Math.floor(random() * 40)}${node.isDirectory ? '' : '.bin'}`);
      } else if (operation === 3 && folders.length > 1) {
        const node = nonRoot[Math.floor(random() * nonRoot.length)];
        const folder = folders[Math.floor(random() * folders.length)];
        project.move(node, folder);
      } else if (operation === 4) {
        project.remove(nonRoot[Math.floor(random() * nonRoot.length)]);
      }
    } catch (error) {
      if (!/already exists|Cannot move|nesting|safety limit/.test(error.message)) throw error;
    }
    verify(project);
  }

  const zip = await project.toZipBlob({ tabs: [] });
  const { project: reopened } = await ProjectStore.open(new File([zip], `fuzz-${seed}.pspstudio`));
  verify(reopened);
  const before = flatten(project).map((node) => `${node.isDirectory ? 'folder' : 'file'}:${node.path}:${node.blob?.size ?? ''}`).sort();
  const after = flatten(reopened).map((node) => `${node.isDirectory ? 'folder' : 'file'}:${node.path}:${node.blob?.size ?? ''}`).sort();
  assert(JSON.stringify(before) === JSON.stringify(after), `Project ZIP round-trip mismatch for seed ${seed}`);
}

console.log('ProjectStore fuzz/property validation passed: 12 seeds × 250 mutations + ZIP round-trips');
