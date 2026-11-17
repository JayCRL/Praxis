import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { indexDoc, matchQuery, hasCjk, tokenize } from './text.mjs';

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function newId(prefix = 'x') {
  const bytes = randomBytes(9);
  let s = '';
  for (const b of bytes) s += ID_ALPHABET[b % 32];
  return `${prefix}_${s}`;
}

const nowIso = () => new Date().toISOString();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lessons (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  rule        TEXT NOT NULL,
  context     TEXT NOT NULL DEFAULT '',
  symptom     TEXT NOT NULL DEFAULT '',
  cause       TEXT NOT NULL DEFAULT '',
  fix         TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',
  task_type   TEXT NOT NULL DEFAULT 'general',
  env         TEXT NOT NULL DEFAULT 'any',
  env_detail  TEXT NOT NULL DEFAULT '',
  tools       TEXT NOT NULL DEFAULT '[]',
  scope       TEXT NOT NULL DEFAULT 'global',
  agent       TEXT NOT NULL DEFAULT 'unknown',
  model       TEXT NOT NULL DEFAULT '',
  session     TEXT NOT NULL DEFAULT '',
  up          INTEGER NOT NULL DEFAULT 0,
  down        INTEGER NOT NULL DEFAULT 0,
  confirms    INTEGER NOT NULL DEFAULT 0,
  conflicts   INTEGER NOT NULL DEFAULT 0,
  verified    INTEGER NOT NULL DEFAULT 0,
  synthetic   INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  agent      TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_lesson ON events(lesson_id);
CREATE INDEX IF NOT EXISTS idx_lessons_created ON lessons(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lessons_model ON lessons(model);
CREATE INDEX IF NOT EXISTS idx_lessons_env ON lessons(env);

CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(
  doc,
  lesson_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

const SEARCHABLE = ['title', 'rule', 'context', 'symptom', 'cause', 'fix', 'tags', 'tools', 'env_detail', 'model'];

/** Raw searchable text of a lesson row, in a stable order. */
function searchableParts(row) {
  const parts = [];
  for (const key of SEARCHABLE) {
    const value = row[key];
    if (!value) continue;
    parts.push(value.startsWith('[') ? JSON.parse(value).join(' ') : value);
  }
  return parts;
}

function rowTokensOf(row) {
  return new Set(tokenize(searchableParts(row).join(' ')));
}

/** How much of the query a candidate actually contains, 0..1. */
function coverageOf(qTokens, tokens) {
  if (!qTokens.length) return 0;
  let hit = 0;
  for (const t of qTokens) {
    if (tokens.has(t)) {
      hit += 1;
    } else if (!hasCjk(t[0])) {
      for (const rt of tokens) {
        if (rt.startsWith(t)) {
          hit += 1;
          break;
        }
      }
    }
  }
  return hit / qTokens.length;
}

function rowToLesson(row) {
  if (!row) return null;
  const parse = (v) => {
    try {
      return JSON.parse(v);
    } catch {
      return [];
    }
  };
  return {
    id: row.id,
    title: row.title,
    rule: row.rule,
    context: row.context,
    story: { symptom: row.symptom, cause: row.cause, fix: row.fix },
    tags: parse(row.tags),
    taskType: row.task_type,
    env: row.env,
    envDetail: row.env_detail ?? '',
    model: row.model ?? '',
    tools: parse(row.tools),
    scope: row.scope,
    synthetic: Boolean(row.synthetic),
    source: { agent: row.agent, model: row.model, session: row.session },
    votes: { up: row.up, down: row.down },
    corroboration: {
      confirms: row.confirms,
      conflicts: row.conflicts,
      verified: Boolean(row.verified),
    },
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Trust score, 0-100. Evidence is signed (votes + corroborations, human
 * verification worth more than anonymous upvotes) and squashed with tanh so the
 * score approaches 100% without ever claiming certainty: 0 evidence = 50%
 * ("unproven"), and it takes real corroboration to climb past 80%.
 */
export function confidenceOf(row) {
  const pos = (row.up ?? 0) + (row.confirms ?? 0) * 2 + (row.verified ? 3 : 0);
  const neg = (row.down ?? 0) + (row.conflicts ?? 0) * 2;
  const evidence = pos - neg;
  const score = 50 + 50 * Math.tanh(evidence / 14);
  return Math.max(3, Math.min(98, Math.round(score)));
}

/** 0-1, exponential decay over ~9 months. */
function freshness(iso, now = Date.now()) {
  const days = Math.max(0, (now - Date.parse(iso)) / 86400000);
  return Math.exp(-days / 300);
}

export class Store {
  constructor(file = ':memory:') {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Older databases predate the environment/model dimensions. */
  migrate() {
    const cols = new Set(this.db.prepare('PRAGMA table_info(lessons)').all().map((c) => c.name));
    const add = (name, ddl) => {
      if (cols.has(name)) return;
      this.db.exec(`ALTER TABLE lessons ADD COLUMN ${ddl}`);
      console.log(`[praxis] migrated: added lessons.${name}`);
    };
    add('env_detail', "env_detail TEXT NOT NULL DEFAULT ''");
    add('synthetic', 'synthetic INTEGER NOT NULL DEFAULT 0');
  }

  close() {
    this.db.close();
  }

  // ---------------------------------------------------------------- write

  insert(input, { agent = 'unknown', model = '', session = '' } = {}) {
    const id = input.id ?? newId('lrn');
    const ts = nowIso();
    const lesson = {
      title: String(input.title ?? '').trim(),
      rule: String(input.rule ?? '').trim(),
      context: String(input.context ?? '').trim(),
      symptom: String(input.story?.symptom ?? input.symptom ?? '').trim(),
      cause: String(input.story?.cause ?? input.cause ?? '').trim(),
      fix: String(input.story?.fix ?? input.fix ?? '').trim(),
    };
    if (!lesson.title) throw new HttpError(400, 'title is required');
    if (!lesson.rule) throw new HttpError(400, 'rule is required (the one sentence an agent should follow)');

    const tags = normList(input.tags);
    const tools = normList(input.tools);
    const taskType = oneOf(input.taskType, TASK_TYPES, 'general');
    const env = oneOf(input.env, ENVS, 'any');
    const scope = oneOf(input.scope, SCOPES, 'global');

    this.db
      .prepare(
        `INSERT INTO lessons (id, title, rule, context, symptom, cause, fix, tags,
           task_type, env, env_detail, tools, scope, agent, model, session, synthetic, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        lesson.title,
        lesson.rule,
        lesson.context,
        lesson.symptom,
        lesson.cause,
        lesson.fix,
        JSON.stringify(tags),
        taskType,
        env,
        String(input.envDetail ?? '').slice(0, 200),
        JSON.stringify(tools),
        scope,
        String(input.source?.agent ?? agent),
        String(input.model ?? input.source?.model ?? model).slice(0, 80),
        String(input.source?.session ?? session),
        input.synthetic ? 1 : 0,
        ts,
        ts,
      );

    this.reindex(id);
    this.logEvent(id, 'create', String(input.source?.agent ?? agent), input.source?.session ?? '');
    return this.get(id);
  }

  update(id, patch) {
    const row = this.db.prepare('SELECT * FROM lessons WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'lesson not found');
    const merged = {
      ...rowToLesson(row),
      ...patch,
      story: { ...rowToLesson(row).story, ...(patch.story ?? {}) },
    };
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE lessons SET title=?, rule=?, context=?, symptom=?, cause=?, fix=?, tags=?,
           task_type=?, env=?, env_detail=?, tools=?, scope=?, model=?, status=?, updated_at=? WHERE id=?`,
      )
      .run(
        String(merged.title).trim(),
        String(merged.rule).trim(),
        String(merged.context ?? ''),
        String(merged.story?.symptom ?? ''),
        String(merged.story?.cause ?? ''),
        String(merged.story?.fix ?? ''),
        JSON.stringify(normList(merged.tags)),
        oneOf(merged.taskType, TASK_TYPES, 'general'),
        oneOf(merged.env, ENVS, 'any'),
        String(merged.envDetail ?? ''),
        JSON.stringify(normList(merged.tools)),
        oneOf(merged.scope, SCOPES, 'global'),
        String(merged.model ?? ''),
        oneOf(merged.status, ['active', 'deprecated', 'draft'], 'active'),
        ts,
        id,
      );
    this.reindex(id);
    this.logEvent(id, 'edit', patch.editedBy ?? '', '');
    return this.get(id);
  }

  reindex(id) {
    const row = this.db.prepare('SELECT * FROM lessons WHERE id = ?').get(id);
    if (!row) return;
    this.db.prepare('DELETE FROM lessons_fts WHERE lesson_id = ?').run(id);
    this.db
      .prepare('INSERT INTO lessons_fts (doc, lesson_id) VALUES (?, ?)')
      .run(indexDoc(searchableParts(row)), id);
  }

  logEvent(lessonId, kind, agent = '', note = '') {
    this.db
      .prepare('INSERT INTO events (lesson_id, kind, agent, note, created_at) VALUES (?,?,?,?,?)')
      .run(lessonId, kind, String(agent ?? ''), String(note ?? ''), nowIso());
  }

  vote(id, dir) {
    const field = dir === 'down' ? 'down' : dir === 'up' ? 'up' : null;
    if (!field) throw new HttpError(400, 'dir must be "up" or "down"');
    const res = this.db.prepare(`UPDATE lessons SET ${field} = ${field} + 1, updated_at = ? WHERE id = ?`).run(nowIso(), id);
    if (!res.changes) throw new HttpError(404, 'lesson not found');
    this.logEvent(id, `vote_${field}`, '');
    return this.get(id);
  }

  corroborate(id, kind, { agent = '', note = '' } = {}) {
    const field = kind === 'conflict' ? 'conflicts' : 'confirms';
    const res = this.db
      .prepare(`UPDATE lessons SET ${field} = ${field} + 1, updated_at = ? WHERE id = ?`)
      .run(nowIso(), id);
    if (!res.changes) throw new HttpError(404, 'lesson not found');
    this.logEvent(id, kind === 'conflict' ? 'conflict' : 'confirm', agent, note);
    return this.get(id);
  }

  verify(id, on = true) {
    const res = this.db
      .prepare('UPDATE lessons SET verified = ?, updated_at = ? WHERE id = ?')
      .run(on ? 1 : 0, nowIso(), id);
    if (!res.changes) throw new HttpError(404, 'lesson not found');
    this.logEvent(id, on ? 'verify' : 'unverify', 'human');
    return this.get(id);
  }

  // ----------------------------------------------------------------- read

  get(id) {
    const row = this.db.prepare('SELECT * FROM lessons WHERE id = ?').get(id);
    if (!row) return null;
    const lesson = rowToLesson(row);
    lesson.confidence = confidenceOf(row);
    lesson.freshness = freshness(row.created_at);
    lesson.events = this.events(id);
    return lesson;
  }

  events(id, limit = 30) {
    return this.db
      .prepare('SELECT kind, agent, note, created_at FROM events WHERE lesson_id = ? ORDER BY id DESC LIMIT ?')
      .all(id, limit)
      .map((e) => ({ kind: e.kind, agent: e.agent, note: e.note, at: e.created_at }));
  }

  /**
   * Ranked search. Blends BM25 position, trust and freshness, then boosts
   * lessons matching the caller's environment / task type.
   */
  search({
    q = '',
    tag = '',
    taskType = '',
    env = '',
    model = '',
    scope = '',
    sort = 'relevant',
    limit = 20,
    offset = 0,
    includeSynthetic = false,
  } = {}) {
    const where = [];
    const params = [];
    if (scope) {
      where.push('l.scope = ?');
      params.push(scope);
    }
    if (taskType) {
      where.push('l.task_type = ?');
      params.push(taskType);
    }
    if (env && env !== 'any') {
      where.push('(l.env = ? OR l.env = ?)');
      params.push(env, 'any');
    }
    if (model) {
      where.push('l.model = ?');
      params.push(model);
    }
    if (tag) {
      where.push('l.tags LIKE ?');
      params.push(`%"${tag}"%`);
    }
    where.push("l.status != 'deprecated'");
    if (!includeSynthetic) where.push('l.synthetic = 0');
    const sqlWhere = `WHERE ${where.join(' AND ')}`;

    let rows = null;
    let matchInfo = null;

    const match = q ? matchQuery(q) : null;
    if (match) {
      const hits = this.db
        .prepare(
          `SELECT f.lesson_id AS id, bm25(lessons_fts) AS bm
             FROM lessons_fts f WHERE lessons_fts MATCH ? ORDER BY bm LIMIT 400`,
        )
        .all(match);
      if (hits.length) {
        const ids = hits.map((h) => h.id);
        const placeholders = ids.map(() => '?').join(',');
        const filtered = this.db
          .prepare(`SELECT * FROM lessons l ${sqlWhere} AND l.id IN (${placeholders})`)
          .all(...params, ...ids);
        const byId = new Map(filtered.map((r) => [r.id, r]));
        // rank position -> 0..1, best first (bm25 is more negative when better)
        matchInfo = new Map();
        let pos = 0;
        for (const hit of hits) {
          const row = byId.get(hit.id);
          if (!row) continue;
          matchInfo.set(row.id, { bm: hit.bm, rank: 1 - pos++ / hits.length });
        }
        rows = filtered;
      }
    }

    if (rows === null) {
      if (q) {
        // No hit. Very short CJK queries produce no bigrams, so fall back to a
        // substring scan; otherwise the honest answer is "nothing found".
        if (!hasCjk(q)) return { total: 0, results: [] };
        const like = `%${q.trim()}%`;
        rows = this.db
          .prepare(
            `SELECT * FROM lessons l ${sqlWhere}
             AND (l.title LIKE ? OR l.rule LIKE ? OR l.context LIKE ? OR l.tags LIKE ?)`,
          )
          .all(...params, like, like, like, like);
      } else {
        rows = this.db.prepare(`SELECT * FROM lessons l ${sqlWhere}`).all(...params);
      }
    }

    const now = Date.now();
    const qTokens = q ? [...new Set(tokenize(q))] : [];

    // Coverage gate: an OR-query gives every document that shares one bigram a
    // bm25 score. For CJK, one bigram means almost nothing, so measure how much
    // of the query each candidate actually contains and drop the stragglers.
    const scored = [];
    for (const row of rows) {
      const conf = confidenceOf(row) / 100;
      const fresh = freshness(row.created_at, now);
      const m = matchInfo?.get(row.id);
      const coverage = q ? coverageOf(qTokens, rowTokensOf(row)) : 0;
      if (q && m && coverage < 0.25) continue;

      let textScore;
      let score;
      if (q) {
        const rank = m ? m.rank : 0.15;
        textScore = 0.4 * rank + 0.6 * coverage;
        const envBoost = env && env !== 'any' && row.env === env ? 1 : 0;
        score = textScore * 0.56 + conf * 0.3 + fresh * 0.09 + envBoost * 0.05;
      } else {
        textScore = 0;
        score = conf * 0.62 + fresh * 0.3 + (row.verified ? 0.08 : 0);
      }
      scored.push({ row, score, conf, fresh, coverage, textScore });
    }

    if (sort === 'trusted') scored.sort((a, b) => b.conf - a.conf || b.score - a.score);
    else if (sort === 'new') scored.sort((a, b) => b.row.created_at.localeCompare(a.row.created_at));
    else scored.sort((a, b) => b.score - a.score);

    const total = scored.length;
    const page = scored.slice(offset, offset + limit).map(({ row, score, coverage }) => {
      const lesson = rowToLesson(row);
      lesson.confidence = Math.round(confidenceOf(row));
      lesson.freshness = Number(freshness(row.created_at, now).toFixed(3));
      lesson.coverage = Number(coverage.toFixed(2));
      lesson.score = Number(score.toFixed(4));
      return lesson;
    });
    return { total, results: page };
  }

  /** Compact recall payload: what an agent actually pastes into its context. */
  recall({ q, limit = 5, chars = 900, model = '', ...filters }) {
    // Without a query there is nothing to be relevant *to*; returning the
    // globally most trusted lessons would just inject noise into the context.
    if (!String(q ?? '').trim()) {
      return { query: '', total: 0, count: 0, chars: 0, text: '', results: [] };
    }
    const { results, total } = this.search({ q, limit: Math.max(limit * 3, 9), sort: 'relevant', ...filters });
    const best = results[0]?.score ?? 0;
    const picked = [];
    let used = 0;
    for (const r of results) {
      // Drop tail matches: with an OR-query a single shared bigram is not a hit.
      if (q && r.score < best * 0.72) continue;
      const line = `${r.rule}${r.context ? `（适用于：${r.context}）` : ''} [${r.confidence}%] #${r.id}`;
      if (used + line.length > chars && picked.length) break;
      used += line.length;
      picked.push({ ...r, line });
      if (picked.length >= limit) break;
    }
    const text = picked.length
      ? `## 相关经验（Praxis 检索 · 取回 ${picked.length} 条 / 共 ${total} 条匹配）\n${picked
          .map((p, i) => `${i + 1}. ${p.line}`)
          .join('\n')}`
      : '';
    // If the caller says who it is, prepend the accumulated correction for this
    // model × environment — a macro conclusion sitting on top of the individual
    // hits, still pointing at their ids.
    let prelude = '';
    if (model) {
      const prof = this.profile({ model, env: filters.env ?? '', taskType: filters.taskType ?? '', limit: 4 });
      if (prof.matched) prelude = prof.briefing.slice(0, Math.floor(chars * 0.45));
    }

    return {
      query: q ?? '',
      total,
      count: picked.length,
      chars: used + prelude.length,
      text: prelude ? `${prelude}\n\n${text}` : text,
      prelude,
      results: picked.map((p) => ({
        id: p.id,
        confidence: p.confidence,
        rule: p.rule,
        context: p.context,
        tags: p.tags,
        taskType: p.taskType,
        env: p.env,
      })),
    };
  }

  /** Lessons that probably overlap with `input` — shown before publishing. */
  similar(input, limit = 4) {
    const text = [input.title, input.rule, input.context].filter(Boolean).join(' ');
    const match = matchQuery(text);
    if (!match) return [];
    const hits = this.db
      .prepare('SELECT lesson_id AS id, bm25(lessons_fts) AS bm FROM lessons_fts WHERE lessons_fts MATCH ? ORDER BY bm LIMIT ?')
      .all(match, limit * 4);

    const inputTokens = new Set(tokenize(text));
    const wanted = new Set(normList(input.tags ?? []).map((t) => t.toLowerCase()));

    return hits
      .map((h, i) => {
        const row = this.db.prepare('SELECT * FROM lessons WHERE id = ?').get(h.id);
        if (!row) return null;
        const l = rowToLesson(row);
        l.confidence = confidenceOf(row);

        // Lexical overlap is the honest signal for "same lesson twice":
        // bm25 always ranks *something* first, even for unrelated text.
        const rowTokens = rowTokensOf(row);
        let shared = 0;
        for (const t of inputTokens) if (rowTokens.has(t)) shared++;
        const union = inputTokens.size + rowTokens.size - shared || 1;
        const lexical = shared / union;

        const tags = new Set(l.tags.map((t) => t.toLowerCase()));
        const tagShared = [...tags].filter((t) => wanted.has(t)).length;
        const tagUnion = new Set([...tags, ...wanted]).size || 1;
        const rank = 1 - i / Math.max(1, hits.length);

        l.similarity = Number((0.62 * lexical + 0.23 * (tagShared / tagUnion) + 0.15 * rank).toFixed(2));
        return l;
      })
      .filter((l) => l && l.similarity >= 0.22 && l.id !== input.excludeId)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * What does the corpus say about *this* model on *this* environment?
   *
   * The point is not a summary of everything — it's a correction: which failure
   * modes keep recurring for this combination, and which concrete entries prove
   * it. Every claim links back to individual lessons; nothing is invented.
   */
  profile({ model = '', env = '', taskType = '', limit = 6 } = {}) {
    const rows = this.db
      .prepare("SELECT * FROM lessons WHERE status != 'deprecated' AND synthetic = 0")
      .all();

    const scored = rows
      .map((row) => {
        const envScore = !env ? 1 : row.env === env ? 2 : row.env === 'any' ? 1 : 0;
        const modelScore = !model ? 1 : row.model === model ? 2 : !row.model ? 1 : 0;
        const taskScore = !taskType ? 0 : row.task_type === taskType ? 1 : 0;
        return { row, score: envScore + modelScore + taskScore, envScore, modelScore };
      })
      // Both constraints must hold: a lesson about another model is not
      // evidence about this one, even if the environment matches.
      .filter((x) => (!model || x.modelScore > 0) && (!env || x.envScore > 0))
      .sort((a, b) => b.score - a.score || confidenceOf(b.row) - confidenceOf(a.row));

    const totalMatched = scored.length;
    const picked = scored.slice(0, Math.max(limit, 6));
    const exactEnv = picked.some((x) => x.envScore === 2);
    const envSpecific = picked.filter((x) => x.row.env === env && env).length;
    const modelsInSample = new Set(picked.map((x) => x.row.model).filter(Boolean));
    const modelsInCorpus = new Set(rows.map((r) => r.model).filter(Boolean));

    const tagCounts = new Map();
    for (const { row } of picked) {
      for (const tag of safeParse(row.tags)) {
        if (ENVS.includes(tag)) continue;
        const entry = tagCounts.get(tag) ?? { tag, count: 0, ids: [] };
        entry.count += 1;
        entry.ids.push(row.id);
        tagCounts.set(tag, entry);
      }
    }
    const signals = [...tagCounts.values()]
      .filter((s) => s.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map((s) => ({
        tag: s.tag,
        count: s.count,
        lessons: picked
          .filter((p) => safeParse(p.row.tags).includes(s.tag))
          .slice(0, 4)
          .map((p) => ({
            id: p.row.id,
            title: p.row.title,
            rule: p.row.rule,
            confidence: confidenceOf(p.row),
          })),
      }));

    const lessons = picked.map(({ row }) => ({
      id: row.id,
      title: row.title,
      rule: row.rule,
      confidence: confidenceOf(row),
      env: row.env,
      envDetail: row.env_detail ?? '',
      model: row.model ?? '',
      tags: safeParse(row.tags),
    }));

    const head = `## 纠偏提示 · ${model || '任何模型'} × ${env || '任何环境'}${taskType ? ` × ${taskType}` : ''}`;
    const lines = [];
    if (lessons.length) {
      const split = envSpecific
        ? `（${envSpecific} 条 ${env} 特有、${lessons.length - envSpecific} 条通用）`
        : '（全部为通用条目）';
      lines.push(`本库 ${totalMatched} 条命中这个组合；取最相关的 ${lessons.length} 条${split}。动手前先过一遍：`);
      for (const l of lessons.slice(0, 4)) {
        lines.push(`- ${l.rule} [${l.confidence}%] #${l.id}`);
      }
    } else {
      lines.push('本库还没有命中这个组合的经验。踩到新坑之后请写回来 —— 下一个同环境的 agent 会用到。');
    }

    const caveats = [];
    if (env && !exactEnv) caveats.push(`没有环境恰为 ${env} 的条目，以上全部来自通用经验`);
    if (model && modelsInSample.size < 2) {
      caveats.push(
        modelsInCorpus.size < 2
          ? '库里目前只有 1 个模型贡献，还分不清这是模型特有还是环境本身的问题'
          : `命中样本只来自 ${modelsInSample.size} 个模型，暂时分不清模型特有与环境驱动`,
      );
    }
    if (lessons.length < 3) caveats.push('样本太少，以上只当提示，不要当结论');
    if (caveats.length) lines.push(`⚠ ${caveats.join('；')}`);

    return {
      model,
      env,
      taskType,
      matched: lessons.length,
      totalMatched,
      exactEnv,
      envSpecific,
      modelsInSample: [...modelsInSample],
      modelsInCorpus: [...modelsInCorpus],
      signals,
      lessons,
      briefing: [head, ...lines].join('\n'),
    };
  }

  stats() {
    const one = (sql, ...p) => this.db.prepare(sql).get(...p);
    const total = one("SELECT COUNT(*) c FROM lessons WHERE status != 'deprecated' AND synthetic = 0").c;
    const synthetic = one("SELECT COUNT(*) c FROM lessons WHERE status != 'deprecated' AND synthetic = 1").c;
    const agents = one('SELECT COUNT(DISTINCT agent) c FROM lessons WHERE synthetic = 0').c;
    const models = one("SELECT COUNT(DISTINCT model) c FROM lessons WHERE synthetic = 0 AND model != ''").c;
    const confirms = one('SELECT SUM(confirms) c FROM lessons WHERE synthetic = 0').c ?? 0;
    const conflicts = one('SELECT SUM(conflicts) c FROM lessons WHERE synthetic = 0').c ?? 0;
    const verified = one('SELECT COUNT(*) c FROM lessons WHERE verified = 1 AND synthetic = 0').c;
    const rows = this.db.prepare("SELECT * FROM lessons WHERE status != 'deprecated' AND synthetic = 0").all();
    const avg = rows.length ? Math.round(rows.reduce((s, r) => s + confidenceOf(r), 0) / rows.length) : 0;
    const byTask = this.db
      .prepare("SELECT task_type t, COUNT(*) c FROM lessons WHERE status != 'deprecated' AND synthetic = 0 GROUP BY 1 ORDER BY c DESC")
      .all();
    const byEnv = this.db
      .prepare("SELECT env e, COUNT(*) c FROM lessons WHERE status != 'deprecated' AND synthetic = 0 GROUP BY 1 ORDER BY c DESC")
      .all();
    return { total, synthetic, agents, models, confirms, conflicts, verified, avgConfidence: avg, byTask, byEnv };
  }

  /**
   * Turn the corpus into conclusions. Two things make an aggregate trustworthy:
   * independent witnesses (different agents / models hitting the same wall) and
   * absence of dissent. Everything below is a view over those two signals.
   */
  insights({ includeSynthetic = true, minAgents = 2 } = {}) {
    const sql = `SELECT * FROM lessons WHERE status != 'deprecated'${includeSynthetic ? '' : ' AND synthetic = 0'}`;
    const rows = this.db.prepare(sql).all();
    const now = Date.now();

    const bucket = (key, labelOf) => {
      const map = new Map();
      for (const r of rows) {
        const key2 = labelOf(r);
        let b = map.get(key2);
        if (!b) {
          b = { key: key2, lessons: 0, conf: 0, verified: 0, conflicts: 0, agents: new Set(), models: new Set(), tags: new Map(), tasks: new Map() };
          map.set(key2, b);
        }
        b.lessons += 1;
        b.conf += confidenceOf(r);
        if (r.verified) b.verified += 1;
        b.conflicts += r.conflicts;
        b.agents.add(r.agent);
        b.models.add(r.model || 'unknown');
        for (const t of safeParse(r.tags)) b.tags.set(t, (b.tags.get(t) ?? 0) + 1);
        b.tasks.set(r.task_type, (b.tasks.get(r.task_type) ?? 0) + 1);
      }
      void key;
      return [...map.values()]
        .map((b) => ({
          key: b.key,
          lessons: b.lessons,
          confidence: Math.round(b.conf / b.lessons),
          verified: b.verified,
          conflicts: b.conflicts,
          agents: b.agents.size,
          topTags: [...b.tags.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([tag, count]) => ({ tag, count })),
          topTask: [...b.tasks.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'general',
        }))
        .sort((a, b) => b.lessons - a.lessons);
    };

    const byModel = bucket('model', (r) => r.model || '未标注模型');
    const byEnv = bucket('env', (r) => r.env || 'any');

    /** Greedy near-duplicate clustering: independent witnesses, same lesson. */
    const items = rows
      .map((r) => ({ row: r, tokens: rowTokensOf(r), conf: confidenceOf(r) }))
      .sort((a, b) => b.conf - a.conf);
    const taken = new Set();
    const clusters = [];
    for (const seed of items) {
      if (taken.has(seed.row.id)) continue;
      taken.add(seed.row.id);
      const members = [seed];
      for (const other of items) {
        if (taken.has(other.row.id)) continue;
        if (jaccard(seed.tokens, other.tokens) >= 0.62) {
          members.push(other);
          taken.add(other.row.id);
        }
      }
      const agents = new Set(members.map((m) => m.row.agent));
      const models = new Set(members.map((m) => m.row.model).filter(Boolean));
      const envs = new Set(members.map((m) => m.row.env));
      if (agents.size < minAgents && models.size < minAgents) continue;
      clusters.push({
        id: seed.row.id,
        title: seed.row.title,
        rule: seed.row.rule,
        confidence: seed.conf,
        witnesses: members.length,
        agents: [...agents],
        models: [...models],
        envs: [...envs],
        avgConfidence: Math.round(members.reduce((s, m) => s + m.conf, 0) / members.length),
      });
    }
    clusters.sort((a, b) => b.agents.length - a.agents.length || b.witnesses - a.witnesses);

    // Contested: group by lesson text first, otherwise the same disagreement
    // shows up once per witness and looks like eight separate problems.
    const contestedMap = new Map();
    for (const r of rows) {
      if (!r.conflicts) continue;
      const entry = contestedMap.get(r.title) ?? {
        id: r.id,
        title: r.title,
        conflicts: 0,
        confirms: 0,
        witnesses: 0,
        confidence: 0,
      };
      entry.conflicts += r.conflicts;
      entry.confirms += r.confirms;
      entry.witnesses += 1;
      entry.confidence = Math.max(entry.confidence, confidenceOf(r));
      contestedMap.set(r.title, entry);
    }
    const contested = [...contestedMap.values()]
      .sort((a, b) => b.conflicts - a.conflicts || b.witnesses - a.witnesses)
      .slice(0, 8);

    const matrix = rows.reduce((acc, r) => {
      const key = `${r.env}|${r.task_type}`;
      acc.set(key, (acc.get(key) ?? 0) + 1);
      return acc;
    }, new Map());

    const unmodelled = rows.filter((r) => !r.model).length;

    return {
      totals: {
        lessons: rows.length,
        real: rows.filter((r) => !r.synthetic).length,
        synthetic: rows.filter((r) => r.synthetic).length,
        agents: new Set(rows.map((r) => r.agent)).size,
        models: new Set(rows.map((r) => r.model).filter(Boolean)).size,
        envs: new Set(rows.map((r) => r.env).filter((e) => e && e !== 'any')).size,
        unmodelled,
        verified: rows.filter((r) => r.verified).length,
      },
      byModel,
      byEnv,
      consensus: clusters.slice(0, 10),
      contested,
      matrix: [...matrix.entries()].map(([key, count]) => {
        const [env, task] = key.split('|');
        return { env, task, count };
      }),
      generatedAt: new Date(now).toISOString(),
    };
  }

  tags(limit = 40) {
    const rows = this.db
      .prepare("SELECT tags FROM lessons WHERE status != 'deprecated'")
      .all();
    const counts = new Map();
    for (const r of rows) {
      let list = [];
      try {
        list = JSON.parse(r.tags);
      } catch {
        list = [];
      }
      for (const t of list) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([tag, count]) => ({ tag, count }));
  }
}

export const TASK_TYPES = ['coding', 'ops', 'design', 'hardware', 'writing', 'research', 'general'];
export const ENVS = ['any', 'windows', 'macos', 'linux', 'web', 'mobile'];
export const SCOPES = ['global', 'project', 'tool'];

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : String(value).split(/[,，、\s]+/);
  return [...new Set(arr.map((v) => String(v).trim().replace(/^#/, '')).filter(Boolean))].slice(0, 12);
}

function safeParse(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Token-set Jaccard, used to decide whether two lessons are "the same finding". */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}
