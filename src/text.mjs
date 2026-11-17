/**
 * Text handling for a mixed Chinese/English corpus.
 *
 * SQLite's unicode61 tokenizer treats a whole run of CJK characters as a single
 * token, so "被拒绝" is one token and searching for "拒绝" finds nothing. We index
 * CJK runs as overlapping bigrams instead (the classic approach: 沙箱权限 -> 沙箱 箱权 权限)
 * and keep latin words as-is. Queries go through the same transform.
 */

const CJK =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u31f0-\u31ff]/;

const LATIN = /[a-z0-9_+#.:@\-]/;

/** Split a string into index tokens: latin words + CJK bigrams. */
export function tokenize(input) {
  if (input == null) return [];
  const text = String(input).toLowerCase();
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (CJK.test(ch)) {
      let j = i;
      while (j < text.length && CJK.test(text[j])) j++;
      const run = text.slice(i, j);
      if (run.length === 1) out.push(run);
      else for (let k = 0; k < run.length - 1; k++) out.push(run.slice(k, k + 2));
      i = j;
    } else if (LATIN.test(ch)) {
      let j = i;
      while (j < text.length && LATIN.test(text[j])) j++;
      out.push(text.slice(i, j));
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

/** Build the space-separated document string stored in the FTS table. */
export function indexDoc(parts) {
  return tokenize(parts.filter(Boolean).join(' \n ')).join(' ');
}

const SAFE = /["^()*:{}]/g;

/** Build an FTS5 MATCH expression: latin tokens become prefixes, CJK stays exact. */
export function matchQuery(input) {
  const tokens = [...new Set(tokenize(input))].slice(0, 24);
  if (!tokens.length) return null;
  const clauses = tokens.map((t) => {
    const safe = t.replace(SAFE, ' ').trim();
    if (!safe) return null;
    if (CJK.test(safe[0])) return `"${safe}"`;
    return `"${safe}"*`;
  });
  const usable = clauses.filter(Boolean);
  return usable.length ? usable.join(' OR ') : null;
}

/** True when the query is mostly CJK (used to decide on LIKE fallback). */
export function hasCjk(input) {
  return CJK.test(String(input ?? ''));
}
