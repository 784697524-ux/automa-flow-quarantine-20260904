/**
 * 工作流 lint —— 把「导入零校验、错误只在运行期暴露」变成生成期拦截（P2）。
 *
 * 规则来源：
 *   - G*：图结构与引擎硬约束（边 handle 规则见 convertWorkflowData.js；
 *     loop-breakpoint 收尾约束见 handlerLoopBreakpoint.js）；
 *   - B*：移植 automa 官方块级校验（src/newtab/utils/blocksValidation.js），
 *     剥离 browser.permissions 检查（生成期无法查扩展权限）；
 *   - T*：mustache 模板语法（见 ../templating.ts）。
 */
import { getBlock } from '../registry.js';
import {
  collectRefsInData,
  extractMustacheRefs,
  hasUnclosedMustache,
  isKnownNamespace,
} from '../templating.js';
import { inspectAttachmentDownloadCode } from '../attachment-download.js';
import { collectSensitiveGlobalDataKeys } from '../sensitive-global-data.js';
import ts from 'typescript';
import type { AutomaWorkflowJson, FlowEdge, FlowNode, LintIssue } from '../types.js';

const issue = (
  rule: string,
  severity: LintIssue['severity'],
  message: string,
  nodeId?: string
): LintIssue => ({ rule, severity, message, ...(nodeId ? { nodeId } : {}) });

/** 官方校验里走「selector 非空」的交互类块 */
const SELECTOR_BLOCKS = new Set([
  'event-click',
  'get-text',
  'forms',
  'element-scroll',
  'link',
  'trigger-event',
  'element-exists',
  'hover-element',
  'create-element',
]);

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

export function lintWorkflow(json: AutomaWorkflowJson): LintIssue[] {
  const issues: LintIssue[] = [];
  const nodes = json.drawflow?.nodes ?? [];
  const edges = json.drawflow?.edges ?? [];
  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  for (const id of duplicateValues(nodes.map((node) => node.id))) {
    issues.push(issue('G01', 'error', `节点 id "${id}" 重复，导入后节点引用会发生覆盖`));
  }
  for (const id of duplicateValues(edges.map((edge) => edge.id))) {
    issues.push(issue('G01', 'error', `边 id "${id}" 重复，图结构不唯一`));
  }
  const logicalEdges = edges.map(
    (edge) => `${edge.sourceHandle}\u0000${edge.target}\u0000${edge.targetHandle}`
  );
  for (const key of duplicateValues(logicalEdges)) {
    const [sourceHandle, target, targetHandle] = key.split('\u0000');
    issues.push(
      issue(
        'G01',
        'error',
        `重复逻辑连线：${sourceHandle} -> ${target}/${targetHandle}，可能导致同一分支重复执行`
      )
    );
  }

  // ── G01：唯一 trigger + 边的端点合法性 ──────────────────────────────
  const triggers = nodes.filter((n) => n.label === 'trigger');
  if (triggers.length === 0) {
    issues.push(issue('G01', 'error', '工作流缺少 trigger 块，无法启动执行'));
  } else if (triggers.length > 1) {
    issues.push(
      issue('G01', 'error', `存在 ${triggers.length} 个 trigger 块，只允许一个`)
    );
  }
  for (const edge of edges) {
    const from = nodesById.get(edge.source);
    const to = nodesById.get(edge.target);
    if (!from || !to) {
      issues.push(
        issue(
          'G01',
          'error',
          `边 ${edge.id} 的端点节点不存在（source=${edge.source}, target=${edge.target}）`
        )
      );
      continue;
    }
    // sourceHandle 必须是 `${source}-output-<port>`，port 落在该块合法输出端口上
    const expectedPrefix = `${from.id}-output-`;
    if (!edge.sourceHandle?.startsWith(expectedPrefix)) {
      issues.push(
        issue('G01', 'error', `边 ${edge.id} 的 sourceHandle 与 source 节点不匹配`, from.id)
      );
      continue;
    }
    const port = edge.sourceHandle.slice(expectedPrefix.length);
    const spec = getBlock(from.label);
    let portOk = port === '1' && spec.outputs >= 1;
    if (!portOk && port === 'fallback') {
      portOk = spec.component === 'BlockBasicWithFallback';
    }
    if (!portOk && spec.component === 'BlockConditions') {
      const groups = (from.data.conditions ?? []) as { id?: string }[];
      portOk = groups.some((g) => g.id === port);
      if (!portOk) {
        issues.push(
          issue('G01', 'error', `conditions 节点 ${from.id} 的输出端口引用了不存在的条件组 "${port}"`, from.id)
        );
      }
    } else if (!portOk) {
      issues.push(
        issue('G01', 'error', `块 "${from.label}" 没有 "${port}" 输出端口`, from.id)
      );
    }
    if (edge.targetHandle !== `${to.id}-input-1`) {
      issues.push(
        issue('G01', 'error', `边 ${edge.id} 的 targetHandle 非法（应为 ${to.id}-input-1）`, to.id)
      );
    }
  }

  // 每个输出端口的下游连线数不得超过注册表 maxConnection。
  for (const node of nodes) {
    const maxConnection = getBlock(node.label).maxConnection;
    if (maxConnection < 1) continue;
    const counts = new Map<string, number>();
    for (const edge of edges.filter((item) => item.source === node.id)) {
      counts.set(edge.sourceHandle, (counts.get(edge.sourceHandle) ?? 0) + 1);
    }
    for (const [sourceHandle, count] of counts) {
      if (count <= maxConnection) continue;
      issues.push(
        issue(
          'G01',
          'error',
          `节点 "${node.id}" 的输出端口 "${sourceHandle}" 连接了 ${count} 条下游边，超过 Automa maxConnection=${maxConnection}`,
          node.id
        )
      );
    }
  }

  // ── G02：loop-data 必须以同 loopId 的 loop-breakpoint 收尾 ──────────
  // 引擎只在 breakpoint 里做索引终止判断，缺失 = 无限循环（官方文档 + 源码确认）
  for (const node of nodes.filter((n) => n.label === 'loop-data')) {
    const loopId = node.data.loopId as string;
    if (isBlank(loopId)) continue; // B 规则会报 loopId 为空
    const breakpoint = nodes.find(
      (n) => n.label === 'loop-breakpoint' && n.data.loopId === loopId
    );
    if (!breakpoint) {
      issues.push(
        issue(
          'G02',
          'error',
          `loop-data "${node.id}"（loopId=${loopId}）缺少对应的 loop-breakpoint 块，运行期会无限循环`,
          node.id
        )
      );
    } else if (!isReachable(node.id, breakpoint.id, edges)) {
      issues.push(
        issue(
          'G02',
          'error',
          `loop-breakpoint "${breakpoint.id}" 不在 loop-data "${node.id}" 的下游，循环无法终止`,
          node.id
        )
      );
    }
  }

  // ── G03：fallback 端口未连接（告警） ────────────────────────────────
  for (const node of nodes) {
    if (getBlock(node.label).component !== 'BlockBasicWithFallback') continue;
    const hasFallback = edges.some((e) => e.sourceHandle === `${node.id}-output-fallback`);
    if (!hasFallback) {
      issues.push(
        issue(
          'G03',
          'warning',
          `块 "${node.label}"（${node.id}）的 fallback 端口未连接，请求失败时行为取决于 settings.onError`,
          node.id
        )
      );
    }
  }

  // ── G04：conditions 左值应是引用（字面量条件几乎总是配置错误） ──────
  for (const node of nodes.filter((n) => n.label === 'conditions')) {
    const groups = (node.data.conditions ?? []) as {
      id?: string;
      name?: string;
      conditions?: unknown[];
    }[];
    for (const group of groups) {
      walkConditionItems(group.conditions, (items) => {
        const left = items[0];
        const value = (left as { data?: { value?: unknown } })?.data?.value;
        if (typeof value === 'string' && !value.includes('{{')) {
          issues.push(
            issue(
              'G04',
              'warning',
              `conditions 节点 ${node.id} 条件组 "${group.name ?? group.id}" 的左值是字面量 "${value}"，通常需要 mustache 引用（如 {{variables@xxx}}）`,
              node.id
            )
          );
        }
      });
    }
  }

  // ── G05：new-tab 之前的 JS 块必须是 background 上下文 ──────────────
  // new-tab 打开后焦点切到新页，旧页 content script 上下文里的 JS 块会执行失败
  const newTabIds = nodes.filter((n) => n.label === 'new-tab').map((n) => n.id);
  const ancestors = collectAncestors(newTabIds, edges);
  for (const node of nodes.filter((n) => n.label === 'javascript-code')) {
    if (!ancestors.has(node.id)) continue;
    if (node.data.context !== 'background') {
      issues.push(
        issue(
          'G05',
          'error',
          `javascript-code "${node.id}" 位于 new-tab 上游，上下文必须是 "background"（当前 "${String(node.data.context)}"），否则打开新页后无法执行`,
          node.id
        )
      );
    }
  }

  // ── G06：upload-file 路径形态 ───────────────────────────────────────
  for (const node of nodes.filter((n) => n.label === 'upload-file')) {
    const paths = (node.data.filePaths ?? []) as string[];
    for (const p of paths) {
      if (typeof p !== 'string' || p.includes('{{')) continue; // 运行期变量，G07/T 覆盖
      if (p.startsWith('~')) {
        issues.push(
          issue('G06', 'error', `upload-file "${node.id}" 的路径 "${p}" 含 ~，Automa 不做 shell 展开，必须写绝对路径`, node.id)
        );
      } else if (!p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p)) {
        issues.push(
          issue('G06', 'warning', `upload-file "${node.id}" 的路径 "${p}" 不是绝对路径，可能找不到文件`, node.id)
        );
      }
    }
  }

  // ── G07：mustache 引用的变量必须有声明点 ───────────────────────────
  // 声明点：webhook 等块的 assignVariable+variableName、trigger.parameters、
  // loop-data.variableName（loopData 命名空间）、JS 代码里的 automaSetVariable。
  // JS 里若存在动态赋值（首参不是字符串字面量），声明集不完备，降级为告警。
  const { declared, declarationNodes, hasDynamicSet } = collectDeclaredVariables(nodes);
  const manualTrigger = triggers.every((t) => t.data.type === 'manual');
  for (const node of nodes) {
    const refs = collectRefsInData(node.data).map(({ path, ref }) => ({ path, ref }));
    if (typeof node.data.code === 'string') {
      for (const key of collectLiteralAutomaVariableReads(node.data.code)) {
        refs.push({
          path: 'code.automaRefData',
          ref: { namespace: 'variables', key, raw: `automaRefData(variables, ${key})` },
        });
      }
    }
    for (const { path, ref } of refs) {
      if (ref.namespace !== 'variables') continue;
      const root = ref.key.split('.')[0] ?? '';
      // $$name 是 Automa Storage -> Variables 注入，不由工作流内部声明。
      if (root.startsWith('$$')) continue;
      if (!root) continue;
      if (declared.has(root)) {
        const upstream = collectAncestors([node.id], edges);
        const declarationIsAvailable = [...(declarationNodes.get(root) ?? [])].some(
          (declarationNodeId) => declarationNodeId === node.id || upstream.has(declarationNodeId)
        );
        if (declarationIsAvailable) continue;
        const severity = manualTrigger && !hasDynamicSet ? 'error' : 'warning';
        issues.push(
          issue(
            'G07',
            severity,
            `节点 ${node.id} 的 ${path} 在上游声明之前读取变量 "${root}"；同名声明仅存在于下游或其他分支`,
            node.id
          )
        );
        continue;
      }
      // 非 manual 触发（URL/CustomEvent）可运行期注入变量；动态赋值无法静态枚举
      const severity =
        manualTrigger && !hasDynamicSet ? 'error' : 'warning';
      issues.push(
        issue(
          'G07',
          severity,
          `节点 ${node.id} 的 ${path} 引用了未声明变量 "${root}"（声明点：assignVariable / trigger.parameters / automaSetVariable / loop-data）`,
          node.id
        )
      );
    }
  }

  // ── G08：不可达节点（告警） ─────────────────────────────────────────
  const startIds = triggers.map((t) => t.id);
  const reachable = new Set<string>();
  for (const s of startIds) markReachable(s, edges, reachable);
  for (const node of nodes) {
    if (node.label === 'trigger') continue;
    if (!reachable.has(node.id)) {
      issues.push(
        issue('G08', 'warning', `节点 ${node.id}（${node.label}）从 trigger 不可达，永远不会执行`, node.id)
      );
    }
  }

  // ── G09：notification block 依赖浏览器通知 API，当前交付环境不稳定 ──
  for (const node of nodes.filter((n) => n.label === 'notification')) {
    issues.push(
      issue(
        'G09',
        'error',
        'notification block 依赖浏览器 notifications.create，当前 Automa 环境可能不可用；交付工作流请改用日志、变量或抛出明确错误',
        node.id
      )
    );
  }

  // ── G10：工作流完成通知也依赖 notifications 权限，生成物默认关闭 ─────
  if (json.settings?.notification === true) {
    issues.push(
      issue(
        'G10',
        'warning',
        'settings.notification=true 会在工作流完成时调用浏览器通知；面向业务用户交付建议关闭'
      )
    );
  }

  // ── G11：页面 JS 直接 fetch AI 表格附件 URL 容易被 CORS/鉴权拦截 ──
  for (const node of nodes.filter((n) => n.label === 'javascript-code')) {
    const code = typeof node.data.code === 'string' ? node.data.code : '';
    const context = typeof node.data.context === 'string' ? node.data.context : '';
    const attachmentDownload = inspectAttachmentDownloadCode(code);
    if (context === 'website' && attachmentDownload.risky) {
      issues.push(
        issue(
          'G11',
          'warning',
          "页面 JS 里直接 fetch 附件 URL 可能被 CORS、鉴权或临时 URL 拦截；优先用 automaFetch('base64', { url })，或给 upload-file 传 filename|mime|dataUrl",
          node.id
        )
      );
    }
  }

  // ── G12：automaFetch('base64') 只在已实测的 website 上下文使用 ────────
  for (const node of nodes.filter((n) => n.label === 'javascript-code')) {
    const code = typeof node.data.code === 'string' ? node.data.code : '';
    const context = typeof node.data.context === 'string' ? node.data.context : '';
    if (inspectAttachmentDownloadCode(code).usesAutomaFetchBase64 && context !== 'website') {
      issues.push(
        issue(
          'G12',
          'error',
          `javascript-code "${node.id}" 在 ${context || '未知'} 上下文调用 automaFetch('base64')；当前已验证的 Automa 运行时只能在 website 上下文完成附件 base64 下载`,
          node.id
        )
      );
    }
  }

  // ── G13：notable operatorId 必须是 unionId，不能直接传 userId ───────
  for (const node of nodes.filter((n) => n.label === 'webhook')) {
    const url = typeof node.data.url === 'string' ? node.data.url : '';
    if (
      /\/v1\.0\/notable\//.test(url) &&
      /operatorId=(?:\d+|\{\{(?:variables|secrets)@[^}]*user[_-]?id[^}]*\}\})/i.test(url)
    ) {
      issues.push(
        issue(
          'G13',
          'error',
          `HTTP 节点 "${node.id}" 把数字或 userId 引用用作 notable operatorId；应先通过用户详情接口取 unionId，再传 operatorId`,
          node.id
        )
      );
    }
  }

  // ── G18：动态变量名无法由 doctor 列出，认证依赖容易遗漏 ──────────
  for (const node of nodes.filter((n) => n.label === 'javascript-code')) {
    const code = typeof node.data.code === 'string' ? node.data.code : '';
    if (hasDynamicAutomaVariableRead(code)) {
      issues.push(
        issue(
          'G18',
          'warning',
          `javascript-code "${node.id}" 使用动态变量名调用 automaRefData，doctor 无法穷举运行依赖；认证变量请改用字面量名称`,
          node.id
        )
      );
    }
  }

  // ── G19：globalData 内嵌敏感值会随工作流文件一起转发 ──────────
  const inlineSensitiveGlobals = collectSensitiveGlobalDataKeys(json);
  if (inlineSensitiveGlobals.length > 0) {
    issues.push(
      issue(
        'G19',
        'warning',
        `globalData 内嵌敏感值（仅列字段名）：${inlineSensitiveGlobals.join('、')}；共享工作流必须改用目标端 Storage，并轮换已经暴露的凭据`
      )
    );
  }

  // ── G14：website JS 不得执行钉钉变更请求 ────────────────
  // content script 可能在 frame 中广播执行，重复 POST/PUT 会造成重复回写。
  for (const node of nodes.filter((n) => n.label === 'javascript-code')) {
    const code = typeof node.data.code === 'string' ? node.data.code : '';
    const mutatingMethodAliases = [
      ...code.matchAll(
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"](?:POST|PUT|PATCH|DELETE)['"]/gi
      ),
    ].map((match) => match[1] ?? '');
    const usesAliasedMutatingMethod = mutatingMethodAliases.some((name) =>
      new RegExp(`\\bmethod\\s*:\\s*${escapeRegExp(name)}\\b`).test(code)
    );
    if (
      node.data.context === 'website' &&
      /(?:api\.dingtalk\.com|\/v1\.0\/notable\/)/i.test(code) &&
      /\b(?:automaFetch|fetch)\s*\(/.test(code) &&
      (usesAliasedMutatingMethod ||
        /\b(?:method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]|\b(?:POST|PUT|PATCH|DELETE)\b\s*,\s*`?\/v1\.0\/notable\/)/i.test(code))
    ) {
      issues.push(
        issue(
          'G14',
          'error',
          `javascript-code "${node.id}" 在 website 上下文发起钉钉变更请求，可能被多 frame 重复执行；请改为单独的原生 HTTP Request 块`,
          node.id
        )
      );
    }
  }

  // ── G15：嵌入 JavaScript 语法与局部标识符拼写漂移 ───────────
  for (const node of nodes.filter((n) => n.label === 'javascript-code')) {
    const code = typeof node.data.code === 'string' ? node.data.code : '';
    const analysis = inspectJavascriptCode(code);
    if (analysis.syntaxError) {
      issues.push(issue('G15', 'error', `JavaScript 语法错误：${analysis.syntaxError}`, node.id));
    }
    for (const typo of analysis.nearMisses) {
      issues.push(
        issue(
          'G15',
          'error',
          `JavaScript 中引用了未声明标识符 "${typo.reference}"，但存在高度相似的局部声明 "${typo.declared}"；请检查变量名交接`,
          node.id
        )
      );
    }
  }

  // ── G16：存在非幂等副作时禁止整个工作流自动重试 ──────────
  const mutatingHttp = nodes.filter((n) => {
    if (n.label !== 'webhook') return false;
    const method = String(n.data.method ?? '').toUpperCase();
    if (/^(PUT|PATCH|DELETE)$/.test(method)) return true;
    if (method !== 'POST') return false;
    const url = String(n.data.url ?? '');
    // 钉钉的 token、用户详情和 records/list 虽然用 POST，但是只读请求。
    return !/(?:\/oauth2\/accessToken|\/topapi\/v2\/user\/get|\/records\/list)(?:[/?]|$)/i.test(url);
  });
  if (mutatingHttp.length > 0 && Number(json.settings?.restartTimes ?? 0) > 0) {
    issues.push(
      issue(
        'G16',
        'error',
        `工作流含 ${mutatingHttp.length} 个 POST/PUT/PATCH/DELETE HTTP 块，但 settings.restartTimes=${String(json.settings.restartTimes)}；结果不明时自动重试可造成重复发布或回写，应设为 0 并用 runId/幂等键保护`
      )
    );
  }

  // ── G17：钉钉 HTTP 超时下限 ───────────────────────────────
  for (const node of nodes.filter((n) => n.label === 'webhook')) {
    const url = typeof node.data.url === 'string' ? node.data.url : '';
    const timeout = Number(node.data.timeout ?? 0);
    if (/dingtalk\.com\//i.test(url) && (!Number.isFinite(timeout) || timeout < 30000)) {
      issues.push(
        issue(
          'G17',
          'error',
          `钉钉 HTTP 节点 "${node.id}" timeout=${String(node.data.timeout ?? '未设置')}ms，已验证的生产工作流使用至少 30000ms`,
          node.id
        )
      );
    }
  }

  // ── B*：官方块级校验移植 ────────────────────────────────────────────
  for (const node of nodes) {
    issues.push(...validateBlockData(node));
  }

  // ── T*：模板语法 ────────────────────────────────────────────────────
  for (const node of nodes) {
    walkStrings(node.data, (str, path) => {
      if (hasUnclosedMustache(str)) {
        issues.push(
          issue('T01', 'error', `节点 ${node.id} 的 ${path} 存在未闭合的 {{`, node.id)
        );
      }
      for (const ref of extractMustacheRefs(str)) {
        if (ref.namespace && !isKnownNamespace(ref.namespace)) {
          issues.push(
            issue('T02', 'warning', `节点 ${node.id} 的 ${path} 使用了未知命名空间 "${ref.namespace}"（${ref.raw}）`, node.id)
          );
        }
      }
    });
  }

  return issues;
}

// ── 辅助函数 ────────────────────────────────────────────────────────────

function isReachable(fromId: string, toId: string, edges: FlowEdge[]): boolean {
  const seen = new Set<string>();
  const queue = [fromId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === toId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of edges) {
      if (e.source === cur) queue.push(e.target);
    }
  }
  return false;
}

/** 收集 targets 的全部上游节点（不含自身判断由调用方处理） */
function collectAncestors(targetIds: string[], edges: FlowEdge[]): Set<string> {
  const result = new Set<string>();
  const queue = [...targetIds];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.target === cur && !result.has(e.source)) {
        result.add(e.source);
        queue.push(e.source);
      }
    }
  }
  return result;
}

function markReachable(startId: string, edges: FlowEdge[], out: Set<string>): void {
  const queue = [startId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const e of edges) {
      if (e.source === cur) queue.push(e.target);
    }
  }
}

/** 遍历 conditions 嵌套结构，对每个最内层 items 数组调用 cb */
function walkConditionItems(conditions: unknown, cb: (items: unknown[]) => void): void {
  if (!Array.isArray(conditions)) return;
  for (const item of conditions as Record<string, unknown>[]) {
    if (Array.isArray(item.items)) cb(item.items);
    if (Array.isArray(item.conditions)) walkConditionItems(item.conditions, cb);
  }
}

function walkStrings(
  data: unknown,
  cb: (str: string, path: string) => void,
  basePath = ''
): void {
  if (typeof data === 'string') {
    cb(data, basePath || '(root)');
  } else if (Array.isArray(data)) {
    data.forEach((item, i) => walkStrings(item, cb, `${basePath}[${i}]`));
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      walkStrings(v, cb, basePath ? `${basePath}.${k}` : k);
    }
  }
}

/** 收集工作流内的变量声明点（G07 用）。
 * hasDynamicSet：存在 `automaSetVariable(<非字面量>, ...)` 时为 true，
 * 此时声明集不完备，G07 应降级为告警。 */
function collectDeclaredVariables(nodes: FlowNode[]): {
  declared: Set<string>;
  declarationNodes: Map<string, Set<string>>;
  hasDynamicSet: boolean;
} {
  const declared = new Set<string>();
  const declarationNodes = new Map<string, Set<string>>();
  let hasDynamicSet = false;
  const addDeclaration = (name: string, nodeId: string): void => {
    declared.add(name);
    const nodeIds = declarationNodes.get(name) ?? new Set<string>();
    nodeIds.add(nodeId);
    declarationNodes.set(name, nodeIds);
  };
  for (const node of nodes) {
    const data = node.data;
    // assignVariable + variableName：webhook / get-text / forms / google-sheets 等
    if (data.assignVariable === true && typeof data.variableName === 'string') {
      const name = data.variableName.trim();
      if (name) addDeclaration(name, node.id);
    }
    // trigger.parameters：[{ name, ... }]
    if (node.label === 'trigger' && Array.isArray(data.parameters)) {
      for (const p of data.parameters as { name?: string }[]) {
        if (p?.name) addDeclaration(p.name, node.id);
      }
    }
    // loop-data.variableName 声明的是 loopData 命名空间，但 automa 允许
    // {{variables@<var>}} 间接访问的场景很少，这里保守不计入 variables。
    // JS 代码里的 automaSetVariable('name', ...)
    if (typeof data.code === 'string') {
      const literalRe = /automaSetVariable\(\s*['"`]([^'"`]+)['"`]/g;
      let m: RegExpExecArray | null;
      while ((m = literalRe.exec(data.code)) !== null) {
        if (m[1]) addDeclaration(m[1], node.id);
      }
      // 首参不是字符串字面量 = 动态赋值
      if (/automaSetVariable\(\s*[^'"`\s]/.test(data.code)) {
        hasDynamicSet = true;
      }
    }
  }
  return { declared, declarationNodes, hasDynamicSet };
}

function collectLiteralAutomaVariableReads(code: string): string[] {
  const reads = new Set<string>();
  const re = /automaRefData\(\s*['"]variables['"]\s*,\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    if (match[1]) reads.add(match[1]);
  }
  return [...reads];
}

function hasDynamicAutomaVariableRead(code: string): boolean {
  const re = /automaRefData\(\s*['"]variables['"]\s*,\s*([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    const argument = (match[1] ?? '').trim();
    const literal =
      /^'(?:\\.|[^'\\])*'$/.test(argument) ||
      /^"(?:\\.|[^"\\])*"$/.test(argument) ||
      /^`(?:\\.|[^`\\$]|\$(?!\{))*`$/.test(argument);
    if (!literal) return true;
  }
  return false;
}

function inspectJavascriptCode(code: string): {
  syntaxError?: string;
  nearMisses: Array<{ reference: string; declared: string }>;
} {
  // mustache 是 Automa 运行前替换项，先替换成合法标识符再解析。
  const normalized = code.replace(/\{\{[\s\S]*?\}\}/g, '__AUTOMA_VALUE__');
  const source = ts.createSourceFile(
    'automa-block.ts',
    `async function __automaBlock__() {\n${normalized}\n}`,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const first = parseDiagnostics[0]!;
    return {
      syntaxError: ts.flattenDiagnosticMessageText(first.messageText, ' '),
      nearMisses: [],
    };
  }

  const declared = new Set<string>();
  const referenced = new Set<string>();
  const addBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) declared.add(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) addBinding(element.name);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) addBinding(node.name);
    else if (ts.isParameter(node)) addBinding(node.name);
    else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) declared.add(node.name.text);
    else if (ts.isCatchClause(node) && node.variableDeclaration) addBinding(node.variableDeclaration.name);

    if (ts.isIdentifier(node) && isJavascriptValueReference(node)) referenced.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);

  const nearMisses: Array<{ reference: string; declared: string }> = [];
  for (const reference of referenced) {
    if (declared.has(reference)) continue;
    const match = [...declared].find((candidate) => isLikelyIdentifierSwap(reference, candidate));
    if (match) nearMisses.push({ reference, declared: match });
  }
  return { nearMisses };
}

function isJavascriptValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent)) && parent.name === node
  ) return false;
  if (ts.isCatchClause(parent) && parent.variableDeclaration?.name === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (
    (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  ) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  return true;
}

function isLikelyIdentifierSwap(left: string, right: string): boolean {
  if (left === right || left.length < 4 || right.length < 4) return false;
  // Error/error、Array/array 这类只有大小写差异的内建对象/局部名不是单词顺序拼错。
  if (left.toLowerCase() === right.toLowerCase()) return false;
  const words = (value: string) =>
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[_\-\s]+/)
      .map((part) => part.toLowerCase())
      .filter(Boolean)
      .sort()
      .join('|');
  return (
    words(left) === words(right) ||
    (left.length >= 6 && right.length >= 6 && editDistance(left, right) <= 1)
  );
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** B* 规则：逐块参数校验（官方 blocksValidation.js 的可离线部分） */
function validateBlockData(node: FlowNode): LintIssue[] {
  const issues: LintIssue[] = [];
  const d = node.data;
  const err = (message: string) => issues.push(issue(`B:${node.label}`, 'error', message, node.id));

  switch (node.label) {
    case 'trigger': {
      const type = d.type as string;
      if (type === 'cron-job' && isBlank(d.expression)) err('Cron 触发缺少 Expression');
      if (type === 'date' && isBlank(d.date)) err('日期触发缺少 Date');
      if (type === 'visit-web' && isBlank(d.url)) err('访问网页触发缺少 URL');
      if (type === 'keyboard-shortcut' && isBlank(d.shortcut)) err('快捷键触发缺少 Shortcut');
      if (type === 'context-menu' && isBlank(d.contextMenuName)) err('右键菜单触发缺少菜单名');
      break;
    }
    case 'new-tab':
      if (isBlank(d.url)) err('URL 为空');
      break;
    case 'webhook':
      if (isBlank(d.url)) err('URL 为空');
      break;
    case 'execute-workflow':
      if (isBlank(d.workflowId)) err('未选择要执行的工作流');
      break;
    case 'loop-data': {
      if (isBlank(d.loopId)) err('Loop id 为空');
      if (d.loopThrough === 'variable' && isBlank(d.variableName)) err('缺少要遍历的变量名');
      if (d.loopThrough === 'google-sheets' && isBlank(d.referenceKey)) err('缺少 Reference key');
      break;
    }
    case 'loop-elements': {
      if (isBlank(d.loopId)) err('Loop id 为空');
      if (isBlank(d.selector)) err('Selector 为空');
      if (
        d.loadMoreAction === 'click-element' ||
        (d.loadMoreAction === 'click-link' && isBlank(d.actionElSelector))
      ) {
        if (isBlank(d.actionElSelector)) err('缺少「加载更多」元素的 Selector');
      }
      break;
    }
    case 'upload-file': {
      if (isBlank(d.selector)) err('Selector 为空');
      const paths = (d.filePaths ?? []) as string[];
      if (paths.length === 0 || paths.some((p) => isBlank(p))) err('存在空的文件路径');
      break;
    }
    case 'switch-tab': {
      if (d.findTabBy === 'match-patterns' && isBlank(d.matchPattern)) err('Match patterns 为空');
      if (d.findTabBy === 'tab-title' && isBlank(d.tabTitle)) err('Tab title 为空');
      break;
    }
    case 'press-key': {
      if (!d.action) err('未指定按键动作');
      else if (d.action === 'press-key' && isBlank(d.keys)) err('按键内容为空');
      else if (d.action === 'multiple-keys' && isBlank(d.keysToPress)) err('按键序列为空');
      break;
    }
    case 'google-sheets':
      if (isBlank(d.spreadsheetId)) err('Spreadsheet Id 为空');
      if (isBlank(d.range)) err('Range 为空');
      break;
    case 'export-data':
      if (d.dataToExport === 'variable' && isBlank(d.variableName)) err('Variable name 为空');
      if (d.dataToExport === 'google-sheets' && isBlank(d.refKey)) err('Reference key 为空');
      break;
    case 'proxy':
      if (isBlank(d.host)) err('Host 为空');
      break;
    case 'take-screenshot':
      if (d.type === 'element' && isBlank(d.selector)) err('元素截图缺少 CSS selector');
      break;
    case 'switch-to':
      if (d.windowType === 'iframe' && isBlank(d.selector)) err('iframe 切换缺少 Selector');
      break;
    case 'attribute-value':
      if (isBlank(d.selector)) err('Selector 为空');
      if (isBlank(d.attributeName)) err('Attribute name 为空');
      break;
    case 'javascript-code':
      if (isBlank(d.code)) err('代码为空');
      break;
    default:
      if (SELECTOR_BLOCKS.has(node.label) && isBlank(d.selector)) err('Selector 为空');
      break;
  }
  return issues;
}
