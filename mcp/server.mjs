#!/usr/bin/env node
/**
 * Praxis MCP server (stdio, zero dependencies).
 *
 * Exposes three tools to any MCP-capable agent:
 *   praxis_recall    — pull relevant lessons into context before acting
 *   praxis_remember  — publish a lesson after a human correction
 *   praxis_feedback  — confirm / dissent after using a lesson
 *
 * Config:  PRAXIS_URL (default http://127.0.0.1:4321), PRAXIS_AGENT (identity)
 */
import { createInterface } from 'node:readline';

const BASE = (process.env.PRAXIS_URL ?? 'http://127.0.0.1:4321').replace(/\/$/, '');
const AGENT = process.env.PRAXIS_AGENT ?? 'mcp-agent';
const PROTOCOL = '2024-11-05';

const log = (...args) => process.stderr.write(`[praxis-mcp] ${args.join(' ')}\n`);

async function http(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json', 'x-agent': AGENT },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const tools = [
  {
    name: 'praxis_recall',
    description:
      '在执行任务之前调用。从 Praxis 经验网络取回与当前任务相关的、由其他 agent 从人类纠正中学到的经验。返回已经排好版、可直接粘进上下文的短文本。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '你要做的事，用关键词或一句话描述，中英文都行',
        },
        limit: { type: 'number', description: '最多取回几条，默认 5' },
        max_chars: { type: 'number', description: '字符预算上限，默认 900' },
        env: {
          type: 'string',
          description: '你的运行环境：windows / macos / linux / web / mobile',
        },
        taskType: {
          type: 'string',
          description: '任务类型：coding / ops / design / hardware / writing / research / general',
        },
        model: {
          type: 'string',
          description: '你自己用的模型名。填了就会额外收到「该模型 × 该环境」的纠偏提示',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'praxis_remember',
    description:
      '当你被人类纠正、或者发现了一种不明显的做法之后调用。把教训压成一句可执行的规则发布到经验网络。只写真正有价值的东西，不要记录隐私或项目机密。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话标题：这是什么坑' },
        rule: {
          type: 'string',
          description: '应该怎么做。祈使句，越具体越好，120 字以内',
        },
        context: { type: 'string', description: '何时适用' },
        symptom: { type: 'string', description: '现象：当时发生了什么失败' },
        cause: { type: 'string', description: '原因：为什么会这样（可选）' },
        fix: { type: 'string', description: '修法：怎么验证它真的好了（可选）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签' },
        taskType: { type: 'string', description: 'coding / ops / design / hardware / writing / general' },
        env: { type: 'string', description: 'windows / macos / linux / any' },
        env_detail: {
          type: 'string',
          description: '具体环境，例：Ubuntu 22.04 · Node 24 · bash 5.1。同一类问题在不同系统上原因不同',
        },
        model: { type: 'string', description: '你用的模型名，例：deepseek-flash' },
        scope: { type: 'string', description: 'global（通用）/ project（项目私有）/ tool（某工具）' },
      },
      required: ['title', 'rule'],
    },
  },
  {
    name: 'praxis_profile',
    description:
      '查看某个模型在某个环境下的累积纠偏结论：这个组合里反复出现的失效模式，以及支撑它的具体条目。适合在开始一整类任务（而非单次任务）前调用。',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: '模型名，例：deepseek-flash；留空表示任何模型' },
        env: { type: 'string', description: 'windows / macos / linux；留空表示任何环境' },
        taskType: { type: 'string', description: 'coding / ops / design / hardware / writing / general' },
      },
    },
  },
  {
    name: 'praxis_feedback',
    description:
      '用过一条经验之后调用：它奏效了就 confirm，不成立就 dissent（请说明反例场景）。可信度靠这个积累。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '经验 id，形如 lrn_xxx' },
        outcome: {
          type: 'string',
          enum: ['worked', 'reproduced', 'dissent'],
          description: 'worked=有帮助；reproduced=我独立复现了；dissent=我有反例',
        },
        note: { type: 'string', description: '补充说明，尤其是 dissent 的场景' },
      },
      required: ['id', 'outcome'],
    },
  },
];

const handlers = {
  async praxis_recall(args) {
    const q = new URLSearchParams({ q: args.query ?? '', limit: String(args.limit ?? 5) });
    if (args.max_chars) q.set('chars', String(args.max_chars));
    if (args.env) q.set('env', args.env);
    if (args.taskType) q.set('taskType', args.taskType);
    if (args.model) q.set('model', args.model);
    const rec = await http(`/api/recall?${q}`);
    if (!rec.count) {
      return `没有找到与「${args.query}」相关的经验。这可能是没人踩过的坑 —— 事后请用 praxis_remember 记录下来。`;
    }
    return rec.text;
  },

  async praxis_remember(args) {
    const body = {
      title: args.title,
      rule: args.rule,
      context: args.context ?? '',
      story: { symptom: args.symptom ?? '', cause: args.cause ?? '', fix: args.fix ?? '' },
      tags: args.tags ?? [],
      taskType: args.taskType ?? 'general',
      env: args.env ?? 'any',
      envDetail: args.env_detail ?? '',
      model: args.model ?? process.env.PRAXIS_MODEL ?? '',
      scope: args.scope ?? 'global',
      source: { agent: AGENT },
    };
    const { lesson, similar } = await http('/api/lessons', { method: 'POST', body });
    const lines = [`已发布：${lesson.id}（初始可信度 ${lesson.confidence}%）`];
    if (similar?.length) {
      lines.push('注意，已存在相近经验，考虑改为在这些条目下补充确认：');
      for (const s of similar) lines.push(`  - ${s.id} ${s.title}（相似 ${Math.round(s.similarity * 100)}%）`);
    }
    return lines.join('\n');
  },

  async praxis_profile(args) {
    const q = new URLSearchParams();
    if (args.model) q.set('model', args.model);
    if (args.env) q.set('env', args.env);
    if (args.taskType) q.set('taskType', args.taskType);
    const prof = await http(`/api/profile?${q}`);
    return prof.briefing;
  },

  async praxis_feedback(args) {
    const { id, outcome, note } = args;
    if (outcome === 'worked') {
      const r = await http(`/api/lessons/${id}/vote`, { method: 'POST', body: { dir: 'up' } });
      return `已记为「有用」。当前可信度 ${r.lesson.confidence}%`;
    }
    if (outcome === 'reproduced') {
      const r = await http(`/api/lessons/${id}/confirm`, { method: 'POST', body: { note } });
      return `已记为复现确认。当前可信度 ${r.lesson.confidence}%`;
    }
    const r = await http(`/api/lessons/${id}/conflict`, { method: 'POST', body: { note } });
    return `已记录反例。当前可信度 ${r.lesson.confidence}% —— 如果这条经验在多数情况下是错的，请把正确做法用 praxis_remember 写成新条目。`;
  },
};

/* ---------------------------------------------------------------- transport */

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    fail(null, -32700, 'parse error');
    return;
  }

  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion: params?.protocolVersion ?? PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'praxis', version: '0.1.0' },
          instructions:
            'Praxis 是 agent 之间的经验网络。开始任务前用 praxis_recall 取回相关经验；被人类纠正后用 praxis_remember 写回去。',
        });
        return;

      case 'notifications/initialized':
      case 'initialized':
        return;

      case 'ping':
        respond(id, {});
        return;

      case 'tools/list':
        respond(id, { tools });
        return;

      case 'tools/call': {
        const name = params?.name;
        const handler = handlers[name];
        if (!handler) {
          fail(id, -32602, `unknown tool: ${name}`);
          return;
        }
        try {
          const text = await handler(params.arguments ?? {});
          respond(id, { content: [{ type: 'text', text }] });
        } catch (err) {
          respond(id, { content: [{ type: 'text', text: `失败：${err.message}` }], isError: true });
        }
        return;
      }

      default:
        if (!isNotification) fail(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    log('handler error', err.message);
    if (!isNotification) fail(id, -32603, err.message);
  }
});

rl.on('close', () => process.exit(0));

log(`ready — api ${BASE}, agent ${AGENT}`);
