/**
 * Hybrid memory retrieval helpers — keyword arm + Reciprocal Rank Fusion.
 *
 * Why (owner-approved 2026-08-03): recall was vector-only. Embeddings are good at
 * "what is this about" and bad at "this exact string" — order ids, phone numbers,
 * product codes and person names kept getting missed even though the fact was
 * saved. A keyword arm finds exactly those, and RRF merges the two rankings
 * without either arm needing a tuned weight.
 *
 * Bangla note: Postgres ships no Bangla stemmer, so the SQL side uses the
 * 'simple' text-search configuration (split + lowercase, NO stemming) plus
 * pg_trgm for partial matches. That is why tokenisation happens HERE, in code,
 * where the owner's Bangla/Banglish mix is understood — never with a
 * language-specific dictionary. (This is the piece TencentDB Agent Memory gets
 * wrong for us: its BM25 arm only speaks "zh" | "en" and segments with jieba.)
 *
 * Everything in this file is pure and deterministic — no DB, no model calls.
 */

/**
 * Words that carry no retrieval signal in the owner's chat. Bangla, Banglish and
 * English mixed, because he types all three in one sentence. Kept deliberately
 * short: over-filtering costs recall, and the vector arm covers meaning anyway.
 */
const MEMORY_STOPWORDS = new Set([
  // Bangla
  'আমি', 'আমার', 'আমাকে', 'তুমি', 'তোমার', 'আপনি', 'আপনার', 'এই', 'ওই', 'সেই',
  'কি', 'কী', 'কে', 'কেন', 'কোন', 'কিভাবে', 'কখন', 'কোথায়', 'করে', 'করা', 'করব',
  'করবে', 'হবে', 'হয়', 'হয়েছে', 'ছিল', 'আছে', 'নাই', 'নেই', 'এবং', 'আর', 'তো',
  'জন্য', 'থেকে', 'দিয়ে', 'সাথে', 'মধ্যে', 'একটা', 'একটি', 'টা', 'টি', 'বস',
  // Banglish
  'ami', 'amar', 'amake', 'tumi', 'tomar', 'apni', 'apnar', 'ei', 'oi', 'sei',
  'kobe', 'kothay', 'keno', 'kivabe', 'kore', 'korba', 'korbe', 'hobe', 'hoy',
  'chilo', 'ache', 'nai', 'ebong', 'theke', 'diye', 'sathe', 'ekta', 'boss',
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'for', 'with', 'that', 'this', 'it', 'my', 'me', 'you',
  'your', 'what', 'when', 'where', 'why', 'how', 'who', 'do', 'does', 'did',
  'can', 'will', 'would', 'should', 'please', 'tell', 'give',
])

/** Max tokens carried into SQL — beyond this the query stops discriminating. */
export const MAX_QUERY_TOKENS = 8
/** Only reasonably long tokens get a trigram (ILIKE) pattern; short ones match everything. */
const MIN_LIKE_TOKEN_LEN = 4
export const MAX_LIKE_PATTERNS = 5

/**
 * Separators that belong INSIDE an identifier — `ORD-123`, `2026/07`, `INV_88`.
 * Kept between alphanumerics, stripped at the edges.
 */
const INTERNAL_SEPARATOR_SPLIT = /[-_./]+/
const EDGE_SEPARATORS = /^[-_./]+|[-_./]+$/g

/**
 * Strips everything that is not a letter, digit, combining mark or internal
 * separator.
 *
 * `\p{M}` is NOT optional here: Bangla builds words out of a base letter plus
 * matras and the hasant (U+09CD), all of which are combining marks. Dropping
 * them turned "পেমেন্ট" into "পমনট" — a token that matches nothing in the
 * database and silently killed Bangla keyword recall.
 *
 * Internal separators survive for the same reason (Codex review, PR #711):
 * collapsing "ORD-123" to "ord123" produced a token matching neither the stored
 * substring nor any lexeme — precisely the exact-identifier case this arm exists
 * to recover. Zero-width joiners are still removed: they are invisible,
 * inconsistently typed, and would make two identical-looking words fail to match.
 */
function cleanToken(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}\-_./]/gu, '')
    .replace(EDGE_SEPARATORS, '')
    .toLowerCase()
}

/**
 * Salient tokens from a user message, in first-seen order.
 *
 * A token survives if it is not a stopword and is either ≥3 characters or
 * contains a digit (so "৭", "12" — a house number, an order id — stay).
 */
export function extractQueryTokens(text: string, limit = MAX_QUERY_TOKENS): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/\s+/)) {
    const tok = cleanToken(raw)
    if (!tok || seen.has(tok)) continue
    if (MEMORY_STOPWORDS.has(tok)) continue
    const hasDigit = /\p{N}/u.test(tok)
    if (tok.length < 3 && !hasDigit) continue
    seen.add(tok)
    out.push(tok)
    if (out.length >= limit) break
  }
  return out
}

/**
 * OR-joined tsquery for `to_tsquery('simple', …)`.
 *
 * plainto_tsquery ANDs every term, which finds nothing for a normal sentence —
 * so the OR query is built here.
 *
 * Identifier tokens are SPLIT on their separators for this arm: Postgres indexes
 * "ORD-123" as the lexemes 'ord-123', 'ord' and '123', so searching the parts
 * hits the same rows, and it guarantees nothing but letters, digits and marks
 * reaches to_tsquery — no character that the tsquery grammar could read as an
 * operator. The full token with its separators is still used for the ILIKE arm,
 * where the exact substring is what matters. (Value is a bound parameter.)
 */
export function buildOrTsQuery(tokens: string[]): string {
  const terms = new Set<string>()
  for (const token of tokens) {
    for (const part of token.split(INTERNAL_SEPARATOR_SPLIT)) {
      if (part) terms.add(part)
    }
  }
  return [...terms].join(' | ')
}

/** `%token%` patterns for the trigram arm — long tokens only, capped. */
export function buildLikePatterns(tokens: string[], limit = MAX_LIKE_PATTERNS): string[] {
  return tokens
    .filter((t) => t.length >= MIN_LIKE_TOKEN_LEN || /\p{N}/u.test(t))
    .slice(0, limit)
    .map((t) => `%${t}%`)
}

/**
 * Stand-in tsquery for a search whose words are all too short or all stopwords
 * ("মা", "the"). `to_tsquery('')` raises, so a term that matches nothing keeps
 * the SQL and its parameters identical while a raw-substring ILIKE does the
 * actual work. Shared by both retrieval paths.
 */
export const NO_LEXEME_TSQUERY = 'zzz_no_lexeme_zzz'

/** Shortest raw phrase worth an ILIKE fallback — below this `%%` would match everything. */
export const MIN_RAW_FALLBACK_LEN = 2

/**
 * ILIKE pattern for a query that produced no usable tokens.
 *
 * Restores the behaviour the old embedding-failure fallback had for short
 * queries (Codex P2, PR #711): with no tokens AND no embedding, both arms would
 * otherwise go silent and a two-letter question like "মা" would find nothing.
 *
 * Edge punctuation is stripped first, because the owner types questions, not
 * search terms: "মা?" would otherwise search for the literal substring `মা?`
 * and miss every stored fact that simply says মা. Interior characters are left
 * alone so `ORD-123` keeps its shape. Returns [] when what remains is too short
 * to be a filter at all.
 */
export function rawPhrasePatterns(query: string): string[] {
  // `\p{M}` again: without it the trailing matra of "মা" counts as punctuation
  // and gets stripped, leaving a bare "ম" that matches the wrong things — the
  // same Bangla trap as in cleanToken above.
  const phrase = query
    .replace(/^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu, '')
    .slice(0, 60)
  if (phrase.length < MIN_RAW_FALLBACK_LEN) return []
  return [`%${phrase}%`]
}

export interface RankedArmHit {
  id: string
  /** 0-based position within that arm's own ranking. */
  rank: number
}

export interface FusedHit {
  id: string
  /** Reciprocal Rank Fusion score — higher is better. */
  rrf: number
  /** How many arms found this row (2 = both vector and keyword agreed). */
  arms: number
  /** Best (lowest) rank the row achieved in any arm. */
  bestRank: number
}

/** Standard RRF constant: damps the head of each list so one arm cannot dominate. */
export const RRF_K = 60

/**
 * Reciprocal Rank Fusion: score = Σ 1 / (K + rank). Rank-based on purpose —
 * cosine similarity and ts_rank are not on the same scale and never will be, so
 * fusing positions instead of scores avoids inventing a conversion factor.
 */
export function fuseRrf(arms: RankedArmHit[][], k = RRF_K): FusedHit[] {
  const acc = new Map<string, FusedHit>()
  for (const arm of arms) {
    for (const hit of arm) {
      const prev = acc.get(hit.id)
      const contribution = 1 / (k + hit.rank + 1)
      if (prev) {
        prev.rrf += contribution
        prev.arms += 1
        prev.bestRank = Math.min(prev.bestRank, hit.rank)
      } else {
        acc.set(hit.id, { id: hit.id, rrf: contribution, arms: 1, bestRank: hit.rank })
      }
    }
  }
  return [...acc.values()].sort((a, b) => b.rrf - a.rrf || a.bestRank - b.bestRank)
}

/**
 * Similarity stand-in for a row only the keyword arm found.
 *
 * The existing reranker (`memory-rerank.ts`) blends similarity + recency +
 * importance and is tuned; rather than change it, a keyword-only hit is given a
 * similarity proxy from its keyword rank. Top keyword hit ≈ a strong vector hit
 * (0.72); by rank ~9 it lands at the 0.45 retrieval threshold, so weak keyword
 * matches naturally lose to real semantic ones.
 */
export function keywordSimilarityProxy(rank: number): number {
  return Math.max(0.45, 0.72 - 0.03 * rank)
}

/** Small nudge for rows BOTH arms found — the actual signal a hybrid setup adds. */
export const BOTH_ARMS_BONUS = 0.05
