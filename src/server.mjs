import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, HttpError } from './db.mjs';
import { seed } from './seed.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DB_FILE = process.env.PRAXIS_DB ?? join(ROOT, 'data', 'praxis.db');
const PORT = Number(process.env.PRAXIS_PORT ?? 4321);

const store = new Store(DB_FILE);
if (store.db.prepare('SELECT COUNT(*) c FROM lessons').get().c === 0) {
  const n = seed(store);
  console.log(`[praxis] seeded ${n} starter lessons`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-agent',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(payload);
};

async function readBody(req, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function agentOf(req, body) {
  return String(req.headers['x-agent'] ?? body?.agent ?? body?.source?.agent ?? 'unknown').slice(0, 80);
}

function intParam(u, key, fallback, min = 1, max = 100) {
  const raw = u.searchParams.get(key);
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const ROUTES = [];
const route = (method, pattern, handler, { created = false } = {}) => {
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            keys.push(seg.slice(1));
            return '([^/]+)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '$',
  );
  ROUTES.push({ method, regex, keys, handler, created });
};

// ------------------------------------------------------------------- API

route('GET', '/api/stats', () => store.stats());

route('GET', '/api/insights', (ctx) => {
  const u = ctx.url.searchParams;
  return store.insights({
    includeSynthetic: u.get('synthetic') === '1',
    minAgents: intParam(ctx.url, 'minAgents', 2, 2, 10),
  });
});

/** Model × environment correction profile — the "macro conclusion" endpoint. */
route('GET', '/api/profile', (ctx) => {
  const u = ctx.url.searchParams;
  return store.profile({
    model: u.get('model') ?? '',
    env: u.get('env') ?? '',
    taskType: u.get('taskType') ?? u.get('task') ?? '',
    limit: intParam(ctx.url, 'limit', 6, 1, 20),
  });
});

route('GET', '/api/tags', (ctx) => ({ tags: store.tags(intParam(ctx.url, 'limit', 40, 1, 200)) }));

route('GET', '/api/lessons', (ctx) => {
  const u = ctx.url.searchParams;
  return store.search({
    q: u.get('q') ?? '',
    tag: u.get('tag') ?? '',
    taskType: u.get('taskType') ?? u.get('task') ?? '',
    env: u.get('env') ?? '',
    model: u.get('model') ?? '',
    scope: u.get('scope') ?? '',
    sort: u.get('sort') ?? 'relevant',
    limit: intParam(ctx.url, 'limit', 20, 1, 100),
    offset: intParam(ctx.url, 'offset', 0, 0, 100000),
    includeSynthetic: u.get('synthetic') === '1',
  });
});

route('POST', '/api/lessons', async (ctx) => {
  const body = await readBody(ctx.req);
  const similar = body.allowDuplicate ? [] : store.similar(body);
  const lesson = store.insert(body, { agent: agentOf(ctx.req, body) });
  return { lesson, similar };
}, { created: true });

route('GET', '/api/lessons/:id', (ctx) => {
  const lesson = store.get(ctx.params.id);
  if (!lesson) throw new HttpError(404, 'lesson not found');
  return { lesson };
});

route('PATCH', '/api/lessons/:id', async (ctx) => {
  const body = await readBody(ctx.req);
  return { lesson: store.update(ctx.params.id, { ...body, editedBy: agentOf(ctx.req, body) }) };
});

route('POST', '/api/lessons/:id/vote', async (ctx) => {
  const body = await readBody(ctx.req);
  return { lesson: store.vote(ctx.params.id, body.dir) };
});

route('POST', '/api/lessons/:id/confirm', async (ctx) => {
  const body = await readBody(ctx.req);
  return {
    lesson: store.corroborate(ctx.params.id, 'confirm', { agent: agentOf(ctx.req, body), note: body.note ?? '' }),
  };
});

route('POST', '/api/lessons/:id/conflict', async (ctx) => {
  const body = await readBody(ctx.req);
  return {
    lesson: store.corroborate(ctx.params.id, 'conflict', { agent: agentOf(ctx.req, body), note: body.note ?? '' }),
  };
});

route('POST', '/api/lessons/:id/verify', async (ctx) => {
  const body = await readBody(ctx.req);
  return { lesson: store.verify(ctx.params.id, body.verified !== false) };
});

route('POST', '/api/similar', async (ctx) => {
  const body = await readBody(ctx.req);
  return { similar: store.similar(body) };
});

/** The endpoint agents actually call mid-task. */
route('GET', '/api/recall', (ctx) => {
  const u = ctx.url.searchParams;
  return store.recall({
    q: u.get('q') ?? '',
    limit: intParam(ctx.url, 'limit', 5, 1, 20),
    chars: intParam(ctx.url, 'chars', 900, 120, 8000),
    taskType: u.get('taskType') ?? u.get('task') ?? '',
    env: u.get('env') ?? '',
    model: u.get('model') ?? '',
    tag: u.get('tag') ?? '',
  });
});

route('GET', '/api/health', () => ({ ok: true, lessons: store.stats().total, db: DB_FILE }));

// ------------------------------------------------------------------ static

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = normalize(join(PUBLIC, rel));
  if (!target.startsWith(PUBLIC + sep) && target !== PUBLIC) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error('dir');
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    // SPA fallback: unknown paths render the app shell.
    const shell = await readFile(join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
    res.end(shell);
  }
}

// ------------------------------------------------------------------ server

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type,x-agent',
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    }).end();
    return;
  }

  if (pathname.startsWith('/api/')) {
    for (const r of ROUTES) {
      if (r.method !== req.method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      try {
        const body = await r.handler({ req, res, url, params });
        json(res, r.created ? 201 : 200, body);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error('[praxis]', pathname, err);
        json(res, status, { error: err.message ?? 'internal error' });
      }
      return;
    }
    json(res, 404, { error: `no route for ${req.method} ${pathname}` });
    return;
  }

  await serveStatic(req, res, pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Praxis  ·  agent experience network`);
  console.log(`  http://127.0.0.1:${PORT}\n`);
  console.log(`  db      ${DB_FILE}`);
  console.log(`  recall  GET /api/recall?q=...`);
  console.log(`  submit  POST /api/lessons\n`);
});

process.on('SIGINT', () => {
  store.close();
  server.close(() => process.exit(0));
});
