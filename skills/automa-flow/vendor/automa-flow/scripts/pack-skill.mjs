import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(scriptDir, '../../..');
const distDir = join(skillRoot, 'dist');
const fixedTime = new Date('2020-01-01T00:00:00.000Z');
const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);
const ignoredFiles = new Set(['.DS_Store', 'MANIFEST.json']);

function listFiles(root, dir = root) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const absolute = join(dir, name);
    const rel = relative(root, absolute).split('\\').join('/');
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      if (!ignoredDirectories.has(name)) files.push(...listFiles(root, absolute));
    } else if (!ignoredFiles.has(name)) {
      files.push(rel);
    }
  }
  return files.sort();
}

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function copyFiles(files, destinationRoot, prefix = '') {
  for (const rel of files) {
    const destination = join(destinationRoot, prefix, rel);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(skillRoot, rel), destination);
    utimesSync(destination, fixedTime, fixedTime);
  }
}

const sourceFiles = listFiles(skillRoot);
const manifest = {
  schemaVersion: 1,
  name: 'automa-flow',
  packageType: 'skill',
  deterministic: {
    fileOrder: 'lexicographic',
    timestamps: fixedTime.toISOString(),
    zipExtraFields: 'stripped-by-zip-X',
  },
  entries: sourceFiles.map((path) => {
    const absolute = join(skillRoot, path);
    return { path, size: statSync(absolute).size, sha256: digest(absolute) };
  }),
};
writeFileSync(join(skillRoot, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const packageFiles = [...sourceFiles, 'MANIFEST.json'].sort();
const staging = mkdtempSync(join(tmpdir(), 'automa-flow-pack-'));
const flatStage = join(staging, 'flat');
const wrappedStage = join(staging, 'wrapped');
copyFiles(packageFiles, flatStage);
copyFiles(packageFiles, wrappedStage, 'automa-flow');

mkdirSync(distDir, { recursive: true });
const skillOutput = join(distDir, 'automa-flow.skill');
const zipOutput = join(distDir, 'automa-flow.zip');
rmSync(skillOutput, { force: true });
rmSync(zipOutput, { force: true });
execFileSync('zip', ['-X', '-q', skillOutput, ...packageFiles], { cwd: flatStage });
execFileSync(
  'zip',
  ['-X', '-q', zipOutput, ...packageFiles.map((path) => `automa-flow/${path}`)],
  { cwd: wrappedStage }
);

rmSync(staging, { recursive: true, force: true });
console.log(skillOutput);
console.log(zipOutput);
