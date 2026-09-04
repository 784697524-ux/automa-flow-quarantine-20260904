/**
 * Automa mustache 模板语法的轻量解析（生成期校验用，不复刻运行期渲染）。
 *
 * 语法事实（对齐 src/workflowEngine/templating/mustacheReplacer.js 与官方文档）：
 *   - `{{variables@x}}` 与 `{{variables.x}}` 等价；
 *   - 命名空间：variables / loopData / secrets / globalData / table / googleSheets
 *     / workflow / prevBlockData / activeTabUrl；
 *   - `$func(...)` 是内置函数（$date/$filter/...），不是变量引用；
 *   - `{{!!expr}}` 是 JS 表达式（仅 Chromium + popup），不校验内部引用；
 *   - `loopData@x` 运行时会自动插入 `.data` 层。
 */

export interface MustacheRef {
  /** 完整匹配，含 `{{ }}` */
  raw: string;
  /** 命名空间，如 'variables'；无法解析时为 '' */
  namespace: string;
  /** 命名空间后的键路径，如 'tokenResp.accessToken' */
  key: string;
}

const KNOWN_NAMESPACES = new Set([
  'variables',
  'loopData',
  'secrets',
  'globalData',
  'table',
  'googleSheets',
  'workflow',
  'prevBlockData',
  'activeTabUrl',
]);

/** 提取字符串中所有 `{{ ... }}` 引用 */
export function extractMustacheRefs(input: string): MustacheRef[] {
  const refs: MustacheRef[] = [];
  const re = /\{\{(.+?)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const inner = (m[1] ?? '').trim();
    if (!inner || inner.startsWith('!!')) continue; // JS 表达式，跳过
    if (inner.startsWith('$')) {
      // $func(...) 内置函数；参数里仍可能嵌引用，继续对参数做提取
      refs.push(...extractMustacheRefs(inner));
      continue;
    }
    const atMatch = /^([A-Za-z]+)@(.+)$/.exec(inner);
    const dotMatch = /^([A-Za-z]+)\.(.+)$/.exec(inner);
    const match = atMatch ?? dotMatch;
    if (match) {
      refs.push({ raw: m[0], namespace: match[1] ?? '', key: match[2] ?? '' });
    } else {
      refs.push({ raw: m[0], namespace: '', key: inner });
    }
  }
  return refs;
}

export function isKnownNamespace(ns: string): boolean {
  return KNOWN_NAMESPACES.has(ns);
}

/** 检测未闭合的 `{{`（有 `{{` 但后面没有 `}}`），返回是否存在残缺引用 */
export function hasUnclosedMustache(input: string): boolean {
  const stripped = input.replace(/\{\{.+?\}\}/g, '');
  return stripped.includes('{{');
}

/**
 * 深度遍历任意 data 结构，收集所有字符串里的 mustache 引用。
 * 返回 [{ path, ref }]，path 是 JSON 路径（如 'headers.1.value'）。
 */
export function collectRefsInData(
  data: unknown,
  basePath = ''
): { path: string; ref: MustacheRef }[] {
  const out: { path: string; ref: MustacheRef }[] = [];
  if (typeof data === 'string') {
    for (const ref of extractMustacheRefs(data)) {
      out.push({ path: basePath, ref });
    }
  } else if (Array.isArray(data)) {
    data.forEach((item, i) => {
      out.push(...collectRefsInData(item, `${basePath}[${i}]`));
    });
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out.push(...collectRefsInData(v, basePath ? `${basePath}.${k}` : k));
    }
  }
  return out;
}
