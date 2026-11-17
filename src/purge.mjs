/**
 * Remove every synthetic demo row, leaving only real accumulated lessons.
 * Run `npm run purge:demo`.
 */
import { fileURLToPath } from 'node:url';
import { Store } from './db.mjs';

const file = process.env.PRAXIS_DB ?? fileURLToPath(new URL('../data/praxis.db', import.meta.url));
const store = new Store(file);
const a = store.db.prepare('DELETE FROM lessons WHERE synthetic = 1').run();
const b = store.db.prepare("DELETE FROM lessons_fts WHERE lesson_id LIKE 'lrn_syn_%'").run();
const c = store.db.prepare("DELETE FROM events WHERE lesson_id LIKE 'lrn_syn_%'").run();
const left = store.db.prepare('SELECT COUNT(*) c FROM lessons').get().c;
console.log(`removed ${a.changes} lessons, ${b.changes} index rows, ${c.changes} events — ${left} left`);
store.close();
