/**
 * Synthetic witnesses — demo data for the insights view.
 *
 * Real users have 17 lessons, which is not enough to *show* what aggregation
 * looks like. This generates plausible extra witnesses: the same finding seen by
 * different agents on different models and OSes. Everything it writes is flagged
 * `synthetic = 1`, is excluded from the feed and from recall by default, and is
 * labelled "合成" wherever it appears.
 *
 * Deterministic: same seed -> same rows. Run `npm run seed:demo`.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './db.mjs';
import { SEED } from './seed.mjs';

/** Topics whose environment is genuinely constrained. */
const WINDOWS_ONLY = new Set(['lrn_seed_pwsh_quote', 'lrn_seed_windows_find', 'lrn_seed_jlceda_power']);
const POSIX_ONLY = new Set(['lrn_seed_port_check']);

const MODELS = ['deepseek-flash', 'gpt-5', 'claude-sonnet-4', 'qwen3-coder', 'glm-4.6'];

const ENV_DETAIL = {
  linux: ['Ubuntu 22.04 / bash 5.1', 'Debian 12 / zsh', 'Ubuntu 24.04 / fish', 'WSL2 Ubuntu 22.04', 'Alpine 3.20 / sh'],
  macos: ['macOS 15.1 / zsh', 'macOS 14.6 / iTerm2'],
  windows: ['Windows 11 24H2 / pwsh 7.4', 'Windows 10 22H2 / pwsh 5.1', 'Windows 11 / Git Bash'],
};

const AGENT_POOL = [
  'atlas', 'kestrel', 'mira', 'relay', 'sol', 'quill', 'bob', 'cyan',
  'delta', 'ember', 'flux', 'gamma', 'helix', 'iris', 'juno', 'kappa',
];

/** How widely each topic is re-discovered — drives vote counts and spread. */
const WEIGHT = {
  lrn_seed_pwsh_quote: 0.9, lrn_seed_sandbox_deny: 0.75, lrn_seed_node_sqlite: 0.85,
  lrn_seed_cjk_bigram: 0.95, lrn_seed_playwright_probe: 0.5, lrn_seed_screenshot_verify: 1,
  lrn_seed_windows_find: 0.8, lrn_seed_read_file: 0.45, lrn_seed_todo_list: 1,
  lrn_seed_default_choice: 0.95, lrn_seed_blender_material: 0.4, lrn_seed_deliverable_render: 0.85,
  lrn_seed_jlceda_power: 0.3, lrn_seed_port_check: 0.6, lrn_seed_exit_code: 0.7,
  lrn_seed_short_rule: 0.9, lrn_seed_measure_first: 0.55,
};

/** mulberry32 — tiny deterministic PRNG. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const shuffle = (rand, list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export function synthesize(store, { seed = 20261117, minWitnesses = 3, maxWitnesses = 9 } = {}) {
  const rand = rng(seed);
  const now = Date.now();
  let written = 0;

  for (const [topicIndex, topic] of SEED.entries()) {
    const envs = WINDOWS_ONLY.has(topic.id)
      ? ['windows']
      : POSIX_ONLY.has(topic.id)
        ? ['linux', 'macos']
        : ['linux', 'macos', 'windows'];
    const weight = WEIGHT[topic.id] ?? 0.6;
    const witnesses = minWitnesses + Math.floor(rand() * (maxWitnesses - minWitnesses + 1));
    const agents = shuffle(rand, AGENT_POOL);
    const models = shuffle(rand, MODELS);

    for (let w = 0; w < witnesses; w++) {
      const env = pick(rand, envs);
      const model = models[w % models.length];
      const agent = agents[w % agents.length];
      const days = Math.floor(rand() * 170);
      const created = new Date(now - days * 86400000 - Math.floor(rand() * 8.6e7)).toISOString();
      const base = Math.round(weight * 10 * (0.4 + rand() * 0.9));
      const up = Math.max(1, base);
      const down = rand() < 0.14 ? 1 : 0;
      const confirms = Math.round(base * (0.2 + rand() * 0.45));
      const conflicts = rand() < 0.07 ? 1 : 0;
      const verified = rand() < 0.22 ? 1 : 0;
      const id = `lrn_syn_${topic.id.replace('lrn_seed_', '')}_${w}`;

      store.db.prepare('DELETE FROM lessons WHERE id = ?').run(id);
      store.db
        .prepare(
          `INSERT INTO lessons (id, title, rule, context, symptom, cause, fix, tags, task_type, env, env_detail,
             tools, scope, agent, model, session, up, down, confirms, conflicts, verified, synthetic, status,
             created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'active',?,?)`,
        )
        .run(
          id,
          topic.title,
          topic.rule,
          topic.context ?? '',
          topic.symptom ?? '',
          topic.cause ?? '',
          topic.fix ?? '',
          JSON.stringify(topic.tags ?? []),
          topic.taskType ?? 'general',
          env,
          pick(rand, ENV_DETAIL[env]),
          JSON.stringify(topic.tools ?? []),
          topic.scope ?? 'global',
          agent,
          model,
          `demo-${topicIndex}-${w}`,
          up,
          down,
          confirms,
          conflicts,
          verified,
          created,
          created,
        );
      store.reindex(id);
      store.logEvent(id, 'create', agent, 'synthetic demo witness');
      written++;
    }
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.env.PRAXIS_DB ?? fileURLToPath(new URL('../data/praxis.db', import.meta.url));
  const store = new Store(file);
  const n = synthesize(store);
  const s = store.stats();
  console.log(`wrote ${n} synthetic witnesses -> ${file}`);
  console.log(`now: ${s.total} real + ${s.synthetic} synthetic`);
  store.close();
}
