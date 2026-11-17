/**
 * End-to-end API regression. Boots its own server on a temp port + temp DB,
 * so it never touches data/praxis.db.  Run: npm test
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4300 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'praxis-test-'));

let pass = 0;
let fail = 0;

const server = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PRAXIS_PORT: String(PORT), PRAXIS_DB: join(DATA_DIR, 'test.db') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

async function waitForServer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('server did not start');
}

const req = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json', 'x-agent': 'apitest' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const group = (name) => console.log(`\n${name}`);

async function main() {
  await waitForServer();

  group('健康检查 / 统计');
  {
    const h = await req('/api/health');
    check('health 可用', h.status === 200 && h.data.ok === true);
    check('种子数据已载入', h.data.lessons >= 10, `lessons=${h.data.lessons}`);
    const s = await req('/api/stats');
    check('stats 结构完整', s.data.total > 0 && typeof s.data.avgConfidence === 'number');
    check('stats 有任务分布', Array.isArray(s.data.byTask) && s.data.byTask.length > 0);
  }

  group('检索');
  {
    const r = await req('/api/lessons?q=' + encodeURIComponent('截图'));
    check('中文检索有结果', r.data.total >= 3, `total=${r.data.total}`);
    check('结果带覆盖率', typeof r.data.results[0].coverage === 'number');
    const none = await req('/api/lessons?q=zzzznotfoundzzz');
    check('无命中返回空集', none.data.total === 0, `total=${none.data.total}`);
    const tagged = await req('/api/lessons?tag=powershell');
    check('标签过滤', tagged.data.total === 1 && tagged.data.results[0].tags.includes('powershell'));
    const env = await req('/api/lessons?env=windows&limit=50');
    check('环境过滤', env.data.results.every((l) => l.env === 'windows' || l.env === 'any'));
    const sorted = await req('/api/lessons?sort=new&limit=3');
    check('按时间排序', sorted.data.results[0].createdAt >= sorted.data.results[1].createdAt);
    const paged = await req('/api/lessons?limit=5&offset=5');
    check('分页生效', paged.data.results.length === 5);
  }

  group('召回（agent 的主入口）');
  {
    const r = await req('/api/recall?q=' + encodeURIComponent('windows 引号') + '&limit=2');
    check('返回可直接使用的文本块', typeof r.data.text === 'string' && r.data.text.includes('相关经验'));
    check('遵守条数与字符预算', r.data.count <= 2 && r.data.chars <= 900);
    const tiny = await req('/api/recall?q=' + encodeURIComponent('windows 引号') + '&chars=40');
    check('极小草稿预算只给一条', tiny.data.count <= 1);
    const empty = await req('/api/recall?q=zzzznotfoundzzz');
    check('无命中不编造', empty.data.count === 0 && empty.data.text === '');
    const noQuery = await req('/api/recall');
    check('空查询不召回（避免注入噪声）', noQuery.data.count === 0);
  }

  group('发布 / 读取 / 编辑');
  let created;
  {
    const c = await req('/api/lessons', {
      method: 'POST',
      body: {
        title: 'API 回归测试条目',
        rule: '这条规则用于验证写入、检索、可信度更新的完整链路。',
        context: '自动化测试',
        tags: ['apitest', 'regression'],
        taskType: 'coding',
        env: 'any',
        story: { symptom: '测试现象', cause: '测试原因', fix: '测试修法' },
        source: { agent: 'apitest', model: 'test-model' },
      },
    });
    check('创建返回 201', c.status === 201, `status=${c.status}`);
    created = c.data.lesson;
    check('新条目可信度 50%', created.confidence === 50, `got ${created.confidence}`);
    check('证据链往返正确', created.story.symptom === '测试现象');
    check('来源被记录', created.source.agent === 'apitest');

    const g = await req(`/api/lessons/${created.id}`);
    check('按 id 读取', g.status === 200 && g.data.lesson.id === created.id);

    const r = await req('/api/recall?q=' + encodeURIComponent('API 回归测试条目'));
    check('新条目立刻可召回', r.data.results.some((x) => x.id === created.id));

    const p = await req(`/api/lessons/${created.id}`, { method: 'PATCH', body: { title: 'API 回归测试条目 v2' } });
    check('编辑生效', p.data.lesson.title === 'API 回归测试条目 v2');
    check('编辑保留证据链', p.data.lesson.story.symptom === '测试现象');

    check('未知 id 返回 404', (await req('/api/lessons/lrn_nope')).status === 404);
    const bad = await req('/api/lessons', { method: 'POST', body: { title: '缺少 rule' } });
    check('缺 rule 返回 400', bad.status === 400 && /rule/.test(bad.data.error));
    const longBody = await req('/api/lessons', { method: 'POST', body: { title: 'x'.repeat(600000), rule: 'y' } });
    check('超大请求被拒', longBody.status === 413, `status=${longBody.status}`);
  }

  group('可信度机制');
  {
    const up = await req(`/api/lessons/${created.id}/vote`, { method: 'POST', body: { dir: 'up' } });
    check('投票返回 200 而非 201', up.status === 200, `status=${up.status}`);
    check('有用票提升可信度', up.data.lesson.confidence > 50, `got ${up.data.lesson.confidence}`);
    const con = await req(`/api/lessons/${created.id}/confirm`, { method: 'POST', body: { agent: 'other' } });
    check('复现确认被计数', con.data.lesson.corroboration.confirms === 1);
    const conf = await req(`/api/lessons/${created.id}/conflict`, { method: 'POST', body: { note: '反例' } });
    check('反例降低可信度', conf.data.lesson.confidence < con.data.lesson.confidence);
    const ver = await req(`/api/lessons/${created.id}/verify`, { method: 'POST', body: {} });
    check('人类核对打标', ver.data.lesson.corroboration.verified === true);
    const ev = await req(`/api/lessons/${created.id}`);
    check('事件时间线完整', ev.data.lesson.events.length >= 5, `got ${ev.data.lesson.events.length}`);
    check('非法投票方向 400', (await req(`/api/lessons/${created.id}/vote`, { method: 'POST', body: { dir: 'sideways' } })).status === 400);
    check('可信度不超过 98', ev.data.lesson.confidence <= 98);
  }

  group('查重');
  {
    const s = await req('/api/similar', {
      method: 'POST',
      body: { title: 'PowerShell 引号被吃掉', rule: '不要内联传 SQL', tags: ['powershell'], excludeId: 'lrn_seed_pwsh_quote' },
    });
    check('excludeId 生效（详情页不推荐自己）', !s.data.similar.some((x) => x.id === 'lrn_seed_pwsh_quote'));
    const dup = await req('/api/similar', {
      method: 'POST',
      body: { title: 'PowerShell 内联传 SQL 时引号被 shell 吃掉', rule: '写成临时 .mjs 文件再执行', tags: ['powershell', 'quoting'] },
    });
    check('能识别真重复', dup.data.similar.some((x) => x.id === 'lrn_seed_pwsh_quote'));
    const junk = await req('/api/similar', {
      method: 'POST',
      body: { title: '如何给 React 组件加动画', rule: '用 framer-motion', tags: ['react'] },
    });
    check('不误报无关内容', junk.data.similar.length === 0);
  }

  group('环境 / 模型维度与累积结论');
  {
    const c = await req('/api/lessons', {
      method: 'POST',
      body: {
        title: 'Linux 上符号链接导致构建路径比较失败',
        rule: '在 Linux 上用 realpath 解析后再比较路径，不要直接比较字符串。',
        env: 'linux',
        envDetail: 'Ubuntu 22.04 · Node 24',
        model: 'gpt-5',
        taskType: 'ops',
        tags: ['linux', 'paths'],
      },
    });
    check('模型被保存', c.data.lesson.model === 'gpt-5', JSON.stringify(c.data.lesson.model));
    check('环境说明被保存', c.data.lesson.envDetail === 'Ubuntu 22.04 · Node 24');

    const byModel = await req('/api/lessons?model=gpt-5');
    check('按模型过滤', byModel.data.total >= 1 && byModel.data.results.every((l) => l.model === 'gpt-5'));

    const prof = await req('/api/profile?model=gpt-5&env=linux');
    check('profile 返回纠偏文本', prof.data.briefing.includes('纠偏提示'));
    check('profile 指向具体条目', prof.data.lessons.length >= 1 && Boolean(prof.data.lessons[0].id));
    check('profile 说明样本局限', prof.data.briefing.includes('⚠'));
    check('profile 统计环境特有', typeof prof.data.envSpecific === 'number');

    const rec = await req(`/api/recall?q=${encodeURIComponent('linux 路径')}&model=gpt-5&env=linux`);
    check('recall 前置模型纠偏', rec.data.prelude.length > 0 && rec.data.text.startsWith('## 纠偏提示'));

    const recNoModel = await req(`/api/recall?q=${encodeURIComponent('linux 路径')}`);
    check('不传模型则不带前言', recNoModel.data.prelude === '');

    const ins = await req('/api/insights');
    check('insights 结构完整', ins.data.byModel.length > 0 && Array.isArray(ins.data.consensus));
    check('insights 默认不含合成样本', ins.data.totals.synthetic === 0);
    check('insights 有环境分布', ins.data.byEnv.some((e) => e.key === 'linux'));
  }

  group('静态资源与路由');
  {
    const home = await fetch(BASE + '/');
    check('首页可访问', home.status === 200 && (await home.text()).includes('Praxis'));
    const spa = await fetch(BASE + '/l/anything');
    check('前端路由回退', spa.status === 200 && (await spa.text()).includes('id="app"'));
    const css = await fetch(BASE + '/style.css');
    check('CSS content-type 正确', css.headers.get('content-type').startsWith('text/css'));
    const trav = await fetch(BASE + '/..%2f..%2fsrc%2fdb.mjs');
    check('拒绝路径穿越', !(await trav.text()).includes('DatabaseSync'));
    const api404 = await req('/api/nope');
    check('未知 API 返回 JSON 404', api404.status === 404 && typeof api404.data.error === 'string');
  }

  console.log(`\n${pass} 通过, ${fail} 失败`);
}

try {
  await main();
} catch (err) {
  console.error('\n测试执行失败:', err.message);
  fail++;
} finally {
  server.kill();
  // Wait for the child to actually exit: on Windows its open WAL files keep the
  // temp directory locked, and rmSync would throw EPERM.
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  try {
    rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* temp dir cleanup is best effort */
  }
  process.exit(fail ? 1 : 0);
}
