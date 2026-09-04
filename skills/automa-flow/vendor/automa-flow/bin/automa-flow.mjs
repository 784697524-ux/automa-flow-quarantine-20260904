#!/usr/bin/env node
/**
 * bin 入口：开发期直接以 tsx 跑 TS 源码（本包 private，不走 tsup 构建产物）。
 * tsx 从包自己的 node_modules/.bin 解析（包内 `pnpm install` 后即可用）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'cli', 'index.ts');
const tsxBin = join(here, '..', 'node_modules', '.bin', 'tsx');

if (!existsSync(tsxBin)) {
  console.error('× 找不到 tsx，请先在包目录（packages/automa-flow）执行 `pnpm install`');
  process.exit(1);
}

const result = spawnSync(tsxBin, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
