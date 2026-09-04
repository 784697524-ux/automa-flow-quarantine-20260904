/**
 * NL 验收用例的解析与断言（自然语言 → .automa.json 的质量闸门）。
 *
 * 用例是 `test/nl-cases/*.md`：YAML/JSON frontmatter（name + expect）+ 正文自然语言。
 * 两种消费方式：
 *   - 单测里：模板/agent 产出 JSON 后调 `checkNlCase` 断言；
 *   - CLI 里：`automa-flow check-nl-case <case.md> <generated.json>`，
 *     agent 用自然语言搭完流程后自检。
 */
import { lintWorkflow } from './lint/lint.js';
import type { AutomaWorkflowJson } from './types.js';

export interface NlCaseExpect {
  /** 节点 label 多重集（排序后逐一比对） */
  labels?: string[];
  /** 边数精确值 */
  edges?: number;
  /** lint error 上限，默认 0 */
  maxLintErrors?: number;
  /** JSON 全文必须包含的子串（如关键选择器、secrets 引用） */
  contains?: string[];
}

export interface NlCase {
  name: string;
  expect: NlCaseExpect;
  /** 正文自然语言描述 */
  nl: string;
}

/** 解析 `---\n<yaml-or-json>\n---\n<nl>` 形态的用例文件 */
export function parseNlCase(text: string): NlCase {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error('NL 用例必须以 YAML/JSON frontmatter（--- 包裹）开头');
  const head = parseFrontmatter(m[1]!);
  if (!head.name) throw new Error('NL 用例 frontmatter 缺少 name');
  return { name: head.name, expect: head.expect ?? {}, nl: (m[2] ?? '').trim() };
}

/** 对生成物跑用例断言，返回问题列表（空 = 通过） */
export function checkNlCase(kase: NlCase, json: AutomaWorkflowJson): string[] {
  const problems: string[] = [];
  const { labels, edges, contains } = kase.expect;
  const maxErrors = kase.expect.maxLintErrors ?? 0;

  if (labels) {
    const actual = json.drawflow.nodes.map((n) => n.label).sort();
    const expected = [...labels].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(
        `节点 label 多重集不符：\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`
      );
    }
  }

  if (edges !== undefined && json.drawflow.edges.length !== edges) {
    problems.push(`边数不符：期望 ${edges}，实际 ${json.drawflow.edges.length}`);
  }

  const errors = lintWorkflow(json).filter((i) => i.severity === 'error');
  if (errors.length > maxErrors) {
    problems.push(
      `lint error ${errors.length} 条（上限 ${maxErrors}）：${errors
        .map((e) => `[${e.rule}] ${e.message}`)
        .join('；')}`
    );
  }

  if (contains) {
    const s = JSON.stringify(json);
    for (const frag of contains) {
      if (!s.includes(frag)) problems.push(`JSON 缺少必需片段：${frag}`);
    }
  }

  return problems;
}

function parseFrontmatter(text: string): { name?: string; expect?: NlCaseExpect } {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as { name?: string; expect?: NlCaseExpect };
  }

  const head: { name?: string; expect?: NlCaseExpect } = {};
  const expect: Record<string, unknown> = {};
  let inExpect = false;
  let arrayKey: keyof NlCaseExpect | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine;
    if (!line.trim()) continue;

    const top = /^([A-Za-z][\w-]*):(?:\s*(.*))?$/.exec(line);
    if (top) {
      inExpect = top[1] === 'expect';
      arrayKey = undefined;
      if (top[1] === 'name') head.name = parseScalar(top[2] ?? '') as string;
      continue;
    }

    const expectPair = /^  ([A-Za-z][\w-]*):(?:\s*(.*))?$/.exec(line);
    if (inExpect && expectPair) {
      const key = expectPair[1] as keyof NlCaseExpect;
      const value = expectPair[2] ?? '';
      if (value.trim() === '') {
        expect[key] = [];
        arrayKey = key;
      } else {
        expect[key] = parseScalar(value);
        arrayKey = undefined;
      }
      continue;
    }

    const item = /^    -\s*(.*)$/.exec(line);
    if (inExpect && arrayKey && item) {
      (expect[arrayKey] as unknown[]).push(parseScalar(item[1] ?? ''));
      continue;
    }

    throw new Error(`NL 用例 frontmatter 存在暂不支持的 YAML 行：${rawLine}`);
  }

  head.expect = expect as NlCaseExpect;
  return head;
}

function parseScalar(value: string): unknown {
  const v = value.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[')) return parseInlineArray(v);
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function parseInlineArray(value: string): string[] {
  const jsonLike = value.replace(/([A-Za-z][\w-]*)(?=\s*(,|\]))/g, '"$1"');
  return JSON.parse(jsonLike) as string[];
}
