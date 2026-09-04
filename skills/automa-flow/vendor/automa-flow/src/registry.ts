/**
 * 块注册表加载器。
 *
 * 注册表是 P0 从 automa 源码提取的 JSON 产物（src/generated/block-registry.json），
 * 是 Builder/Lint/CLI 的唯一块事实源。刻意不用 JSON import（规避 vitest/tsx 对
 * import attributes 的方言差异），用 readFileSync 相对本模块路径加载。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BlockRegistryFile, BlockSpec } from './types.js';

let cached: BlockRegistryFile | null = null;

export function getRegistry(): BlockRegistryFile {
  if (!cached) {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, 'generated', 'block-registry.json'), 'utf8');
    cached = JSON.parse(raw) as BlockRegistryFile;
  }
  return cached;
}

export function getBlock(label: string): BlockSpec {
  const block = getRegistry().blocks[label];
  if (!block) {
    throw new Error(
      `未知块类型 "${label}"。用 \`automa-flow list-blocks\` 查看合法块名` +
        `（注册表提取自 automa ${getRegistry().source.automaVersion}）`
    );
  }
  return block;
}

/** 深拷贝块的默认 data，避免多个节点共享同一引用 */
export function cloneDefaultData(label: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(getBlock(label).defaultData)) as Record<
    string,
    unknown
  >;
}
