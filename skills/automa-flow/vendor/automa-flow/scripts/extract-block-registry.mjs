#!/usr/bin/env node
/**
 * P0：从 automa 源码提取块注册表（block registry）。
 *
 * 事实源是 automa 的 `src/utils/shared.js` 的 `export const tasks` —— 61 个块的
 * 纯数据注册表（零 import），包含每块的 name/component/inputs/outputs/maxConnection
 * 与默认 data。本脚本做三件事：
 *   1. 括号配平截取 `tasks` 对象字面量（处理字符串转义），`new Function` 求值；
 *   2. 规整成 CLI/Builder 消费的 `BlockSpec` 结构；
 *   3. 写入 `src/generated/block-registry.json`，带源仓标识与版本水印。
 *
 * 用法：
 *   node scripts/extract-block-registry.mjs [automa 仓库路径]
 *   或 AUTOMA_SRC=/path/to/automa node scripts/extract-block-registry.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// 包住在 automa 仓库的 packages/automa-flow/ 下，默认事实源就是两级上的仓库根；
// 也可用位置参数或 AUTOMA_SRC 指向其它 automa 检出。
const automaRoot =
  process.argv[2] || process.env.AUTOMA_SRC || join(here, '..', '..', '..');

const sharedPath = join(automaRoot, 'src/utils/shared.js');
const pkgPath = join(automaRoot, 'package.json');

const src = readFileSync(sharedPath, 'utf8');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

// ── 1. 截取 tasks 对象字面量 ─────────────────────────────────────────────
const marker = 'export const tasks = {';
const markerAt = src.indexOf(marker);
if (markerAt === -1) {
  throw new Error(`未在 ${sharedPath} 找到 "${marker}"，automa 源码结构可能已变化`);
}
const objStart = markerAt + marker.length - 1; // 指向 `{`

// 括号配平，跳过字符串字面量（单引号/双引号/反引号 + 反斜杠转义）
let depth = 0;
let objEnd = -1;
let inString = null;
for (let i = objStart; i < src.length; i += 1) {
  const ch = src[i];
  if (inString) {
    if (ch === '\\') {
      i += 1; // 跳过转义字符
    } else if (ch === inString) {
      inString = null;
    }
    continue;
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    inString = ch;
    continue;
  }
  if (ch === '{') depth += 1;
  else if (ch === '}') {
    depth -= 1;
    if (depth === 0) {
      objEnd = i + 1;
      break;
    }
  }
}
if (objEnd === -1) throw new Error('tasks 对象括号未配平，源码解析失败');

const literal = src.slice(objStart, objEnd);

// ── 2. 求值 + 规整 ──────────────────────────────────────────────────────
// tasks 为纯数据（无 import、无函数引用），直接求值安全。
let tasks;
try {
  // eslint-disable-next-line no-new-func
  tasks = new Function(`return (${literal});`)();
} catch (err) {
  throw new Error(`tasks 字面量求值失败（可能含非纯数据引用）：${err.message}`);
}

const blocks = {};
for (const [id, def] of Object.entries(tasks)) {
  blocks[id] = {
    id,
    name: def.name ?? id,
    description: def.description ?? '',
    component: def.component ?? 'BlockBasic',
    category: def.category ?? 'general',
    // inputs/outputs 端口数。conditions 等特殊块 outputs 可为 0（输出端口由
    // 条件项 id 动态决定）。
    inputs: def.inputs ?? 1,
    outputs: def.outputs ?? 1,
    allowedInputs: def.allowedInputs ?? false,
    maxConnection: def.maxConnection ?? 1,
    defaultData: def.data ?? {},
  };
}

// ── 3. 写产物（带水印） ─────────────────────────────────────────────────
const out = {
  $schemaNote:
    '由 scripts/extract-block-registry.mjs 生成，勿手工编辑。重新生成：pnpm registry',
  source: {
    repo: pkg.name || 'automa',
    file: 'src/utils/shared.js',
    automaVersion: pkg.version,
  },
  extractedAt: new Date().toISOString(),
  blockCount: Object.keys(blocks).length,
  blocks,
};

const outPath = join(here, '..', 'src', 'generated', 'block-registry.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');

console.log(
  `✔ block registry 已写入 ${outPath}（automa ${pkg.version}，${out.blockCount} 块）`
);
