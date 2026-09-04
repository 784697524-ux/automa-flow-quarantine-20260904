import { describe, expect, it } from 'vitest';
import { WorkflowBuilder } from '../src/builder/builder.js';
import {
  analyzeRecordedWorkflow,
  mergeRecordedFragment,
  transformRecordedWorkflow,
} from '../src/recording.js';
import type { AutomaWorkflowJson } from '../src/types.js';

const workflowWith = (nodes: AutomaWorkflowJson['drawflow']['nodes']) => ({
  extVersion: '1.30.00',
  name: 'recorded',
  icon: 'riGlobalLine',
  table: [],
  version: '1.30.00',
  drawflow: { nodes, edges: [], position: [0, 0] as [number, number], zoom: 1 },
  settings: { publicId: '' },
  globalData: '{"key":"value"}',
  description: '',
  includedWorkflows: {},
});

describe('录制工作流处理', () => {
  it('提取录制片段中的页面操作与选择器清单', () => {
    const json = workflowWith([
      node('a', 'event-click', { description: '点击发布', selector: '#publish' }),
      node('b', 'forms', { description: '填标题', selector: 'input.title', value: 'hello' }),
      node('c', 'upload-file', {
        selector: 'input[type="file"]',
        filePaths: ['/tmp/a.png'],
      }),
      node('d', 'webhook', { url: 'https://api.example.test' }),
    ]);

    expect(analyzeRecordedWorkflow(json).selectorBlocks).toEqual([
      {
        id: 'a',
        label: 'event-click',
        description: '点击发布',
        selector: '#publish',
        findBy: 'cssSelector',
      },
      {
        id: 'b',
        label: 'forms',
        description: '填标题',
        selector: 'input.title',
        findBy: 'cssSelector',
        value: 'hello',
      },
      {
        id: 'c',
        label: 'upload-file',
        description: '',
        selector: 'input[type="file"]',
        findBy: 'cssSelector',
        filePaths: ['/tmp/a.png'],
      },
    ]);
  });

  it('分析录制噪音、IME 缺陷和硬编码值', () => {
    const pressA = {
      ...node('press-a', 'press-key', { selector: '', keys: 'n' }),
      groupId: 'ime-1',
    } as AutomaWorkflowJson['drawflow']['nodes'][number];
    const pressB = {
      ...node('press-b', 'press-key', { selector: '', keys: 'i' }),
      groupId: 'ime-1',
    } as AutomaWorkflowJson['drawflow']['nodes'][number];
    const json = workflowWith([
      node('scroll', 'element-scroll', { selector: '' }),
      node('change', 'trigger-event', { selector: '', eventName: 'change' }),
      node('click-editor', 'event-click', { selector: 'div.editor' }),
      pressA,
      pressB,
      node('title', 'forms', { selector: 'input.title', value: '录制标题' }),
      node('upload', 'upload-file', {
        selector: 'input[type="file"]',
        filePaths: ['/tmp/lake.jpeg'],
      }),
    ]);

    const analysis = analyzeRecordedWorkflow(json);

    expect(analysis.noise.map((item) => item.id)).toEqual([
      'scroll',
      'change',
      'press-a',
      'press-b',
    ]);
    expect(analysis.defects.map((item) => item.kind)).toEqual([
      'empty-trigger-event',
      'ime-contenteditable',
    ]);
    expect(analysis.hardcoded.map((item) => item.kind)).toEqual([
      'forms-value',
      'upload-filePaths',
    ]);
  });

  it('dropNoise 删除噪音节点并重连前后节点', () => {
    const builder = new WorkflowBuilder({ name: 'recorded' });
    const trigger = builder.addBlock('trigger', { id: 't' });
    const scroll = builder.addBlock('element-scroll', { id: 'scroll', data: { selector: '' } });
    const click = builder.addBlock('event-click', {
      id: 'click',
      data: { selector: '#publish' },
    });
    builder.chain([trigger, scroll, click]);

    const transformed = transformRecordedWorkflow(builder.emit(), { dropNoise: true });

    expect(transformed.drawflow.nodes.map((item) => item.id)).not.toContain('scroll');
    expect(transformed.drawflow.edges.some((edge) => edge.source === 't' && edge.target === 'click')).toBe(true);
    expect(analyzeRecordedWorkflow(transformed).issues.filter((item) => item.severity === 'error')).toEqual([]);
  });

  it('parametrize 按 nodeId 把录制值替换成变量引用', () => {
    const json = workflowWith([
      node('title', 'forms', { selector: 'input.title', value: '录制标题' }),
      node('upload', 'upload-file', {
        selector: 'input[type="file"]',
        filePaths: ['/tmp/lake.jpeg'],
      }),
    ]);

    const transformed = transformRecordedWorkflow(json, {
      parametrize: { forms: { title: 'postTitle' }, upload: { upload: 'mediaPath' } },
    });
    const title = transformed.drawflow.nodes.find((item) => item.id === 'title')!;
    const upload = transformed.drawflow.nodes.find((item) => item.id === 'upload')!;

    expect(title.data.value).toBe('{{variables@postTitle}}');
    expect(title.data.clearValue).toBe(true);
    expect(upload.data.filePaths).toEqual(['{{variables@mediaPath}}']);
  });

  it('把单 trigger 录制片段插入骨架 after 节点和原下游之间，并重写片段 id', () => {
    const skeleton = new WorkflowBuilder({ name: 'skeleton', publicId: 'pub-1' });
    const trigger = skeleton.addBlock('trigger', { id: 't' });
    const open = skeleton.addBlock('new-tab', { id: 'open', data: { url: 'https://x.test' } });
    const writeBack = skeleton.addBlock('webhook', { id: 'write', data: { url: 'https://api.test' } });
    skeleton.chain([trigger, open, writeBack]);

    const fragment = new WorkflowBuilder({ name: 'recorded', publicId: 'frag-pub' });
    const fragTrigger = fragment.addBlock('trigger', { id: 't' });
    const click = fragment.addBlock('event-click', {
      id: 'click',
      data: { selector: '#publish', waitForSelector: true },
    });
    const fill = fragment.addBlock('forms', {
      id: 'fill',
      data: { selector: 'input.title', value: '{{variables@title}}' },
    });
    fragment.chain([fragTrigger, click, fill]);

    const merged = mergeRecordedFragment(skeleton.emit(), fragment.emit(), { after: 'open' });
    const openEdge = merged.drawflow.edges.find((e) => e.source === 'open')!;
    const insertedClick = merged.drawflow.nodes.find(
      (n) => n.label === 'event-click' && n.data.selector === '#publish'
    )!;
    const insertedFill = merged.drawflow.nodes.find(
      (n) => n.label === 'forms' && n.data.selector === 'input.title'
    )!;

    expect(merged.settings.publicId).toBe('pub-1');
    expect(insertedClick.id).not.toBe('click');
    expect(openEdge.target).toBe(insertedClick.id);
    expect(
      merged.drawflow.edges.find((e) => e.source === insertedClick.id)?.target
    ).toBe(insertedFill.id);
    expect(
      merged.drawflow.edges.find((e) => e.source === insertedFill.id)?.target
    ).toBe('write');
  });

  it('merge 可在合并前清噪并参数化录制值', () => {
    const skeleton = new WorkflowBuilder({ name: 'skeleton' });
    const trigger = skeleton.addBlock('trigger', { id: 't' });
    const open = skeleton.addBlock('new-tab', { id: 'open', data: { url: 'https://x.test' } });
    const writeBack = skeleton.addBlock('webhook', { id: 'write', data: { url: 'https://api.test' } });
    skeleton.chain([trigger, open, writeBack]);

    const fragment = new WorkflowBuilder({ name: 'recorded' });
    const fragTrigger = fragment.addBlock('trigger', { id: 'ft' });
    const scroll = fragment.addBlock('element-scroll', { id: 'scroll', data: { selector: '' } });
    const fill = fragment.addBlock('forms', {
      id: 'fill-title',
      data: { selector: 'input.title', value: '录制标题' },
    });
    fragment.chain([fragTrigger, scroll, fill]);

    const merged = mergeRecordedFragment(skeleton.emit(), fragment.emit(), {
      after: 'open',
      dropNoise: true,
      parametrize: { forms: { 'fill-title': 'postTitle' } },
    });
    const insertedFill = merged.drawflow.nodes.find(
      (item) => item.label === 'forms' && item.data.selector === 'input.title'
    )!;

    expect(merged.drawflow.nodes.some((item) => item.data.selector === '')).toBe(false);
    expect(insertedFill.data.value).toBe('{{variables@postTitle}}');
    expect(merged.drawflow.edges.find((edge) => edge.source === 'open')?.target).toBe(insertedFill.id);
  });

  it('after 节点不存在时报错', () => {
    const skeleton = new WorkflowBuilder({ name: 'skeleton' });
    skeleton.addBlock('trigger', { id: 't' });
    const fragment = new WorkflowBuilder({ name: 'recorded' });
    fragment.addBlock('trigger', { id: 'ft' });

    expect(() =>
      mergeRecordedFragment(skeleton.emit(), fragment.emit(), { after: 'missing' })
    ).toThrow(/after 节点不存在/);
  });

  it('拒绝包含多个 trigger 的录制片段', () => {
    const skeleton = new WorkflowBuilder({ name: 'skeleton' });
    skeleton.addBlock('trigger', { id: 't' });
    const fragment = workflowWith([
      node('a', 'trigger'),
      node('b', 'trigger'),
      node('c', 'event-click', { selector: '#x' }),
    ]);

    expect(() =>
      mergeRecordedFragment(skeleton.emit(), fragment, { after: 't' })
    ).toThrow(/录制片段不能包含多个 trigger/);
  });
});

function node(
  id: string,
  label: string,
  data: Record<string, unknown> = {}
): AutomaWorkflowJson['drawflow']['nodes'][number] {
  return {
    id,
    label,
    type: 'BlockBasic',
    initialized: false,
    position: { x: 0, y: 0 },
    data,
  };
}
