export type Intent = { tag: string; patterns: string[]; responses: string[] };
export type KB = { intents: Intent[] };

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokenize(s: string): string[] {
  return normalize(s).split(" ").filter(Boolean);
}
function set<T>(a: T[]) {
  return new Set(a);
}
function jaccard(a: Set<string>, b: Set<string>) {
  const inter = new Set([...a].filter((x) => b.has(x))).size;
  const uni = new Set([...a, ...b]).size || 1;
  return inter / uni;
}
function lev(a: string, b: string) {
  const m = a.length,
    n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    }
  }
  return d[m][n];
}
function levSim(a: string, b: string) {
  const dist = lev(a, b);
  return 1 - dist / Math.max(1, a.length, b.length);
}

export function detectArabic(s: string) {
  return /[\u0600-\u06FF]/.test(s);
}

/** --- Domain helpers ----------------------------------------------------- */
const ALIASES: Record<string, string[]> = {
  masturbation: [
    "self-stimulation",
    "self stimulation",
    "self-pleasure",
    "self pleasure",
    "solo sex",
  ],
  pimples: ["acne", "zits", "spots"],
  period: ["menstruation", "menstrual", "menses"],
  penis: ["male organ"],
  vagina: ["female organ"],
  // Arabic
  العادة: ["العادة السرية", "الاستمناء", "استمناء"],
  حب: ["حب الشباب", "بثور"],
};

function aliasBoost(query: string, candidate: string): number {
  const q = " " + normalize(query) + " ";
  const c = " " + normalize(candidate) + " ";
  let boost = 0;
  for (const [k, arr] of Object.entries(ALIASES)) {
    const key = " " + normalize(k) + " ";
    const hitQ =
      q.includes(key) || arr.some((a) => q.includes(" " + normalize(a) + " "));
    const hitC =
      c.includes(key) || arr.some((a) => c.includes(" " + normalize(a) + " "));
    if (hitQ && hitC) boost += 0.08;
  }
  return Math.min(0.2, boost);
}

/** --- Index: patterns + response sentences + tag keywords ---------------- */
type Doc = {
  text: string;
  tag: string;
  kind: "pattern" | "response" | "tag";
  fullResponse: string;
};

function splitSentences(resp: string): string[] {
  return resp
    .split(/(?<=[\.!\?؟])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildIndex(kb: KB): Doc[] {
  const docs: Doc[] = [];
  for (const it of kb.intents) {
    const baseResponse = it.responses[0] || "";
    for (const p of it.patterns) {
      docs.push({
        text: p,
        tag: it.tag,
        kind: "pattern",
        fullResponse: it.responses[0] || "",
      });
    }
    for (const r of it.responses) {
      for (const sent of splitSentences(r)) {
        docs.push({
          text: sent,
          tag: it.tag,
          kind: "response",
          fullResponse: r,
        });
      }
    }
    const tagBits = it.tag
      .split(/[\/\-\(\)\[\],;]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    for (const t of tagBits) {
      docs.push({
        text: t,
        tag: it.tag,
        kind: "tag",
        fullResponse: baseResponse,
      });
    }
  }
  return docs;
}

/** --- Retrieval scoring --------------------------------------------------- */
export type Match = {
  tag: string;
  pattern: string; // what matched (pattern or response sentence or tag term)
  response: string; // the best full response to use
  score: number;
};
export type Retrieval = {
  top: Match[];
  best: Match;
  globalRelatedness: number;
};

export function retrieve(query: string, kb: KB, topK = 10): Retrieval {
  const docs = buildIndex(kb);
  const qn = normalize(query);
  const qtoks = tokenize(qn);
  const qset = set(qtoks);

  const allTokens = new Set<string>();
  for (const d of docs)
    tokenize(d.text).forEach((t) => t.length >= 3 && allTokens.add(t));
  let rel = 0;
  for (const t of qset) if (allTokens.has(t)) rel++;
  const globalRelatedness = Math.min(1, rel / Math.max(1, qset.size));

  const scored: Match[] = [];
  for (const d of docs) {
    const dn = normalize(d.text);
    const dtoks = tokenize(dn);
    const dset = set(dtoks);

    const jac = jaccard(qset, dset);
    const le = levSim(qn, dn);
    const overlap =
      dtoks.filter((t) => qset.has(t)).length / Math.max(1, qtoks.length);
    const alias = aliasBoost(query, d.text);
    const kindBias =
      d.kind === "response" ? 0.04 : d.kind === "pattern" ? 0.02 : 0;

    const score =
      0.5 * jac + 0.32 * le + 0.14 * Math.min(1, overlap) + alias + kindBias;
    if (score > 0) {
      scored.push({
        tag: d.tag,
        pattern: d.text, // <— ensure `pattern` exists
        response: d.fullResponse ?? d.text,
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);
  const best = top[0] || { tag: "", pattern: "", response: "", score: 0 };
  return { top, best, globalRelatedness };
}
