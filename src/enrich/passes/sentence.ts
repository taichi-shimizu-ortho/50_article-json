/**
 * プロンプトの組み立てと、返ってきた JSON の検証。
 *
 * ここは API を叩かない純粋な関数だけにしてある。バッチ分割・キャッシュ・
 * マージの検証を API キーなしで回せるようにするため。
 *
 * 設計の要点: **LLM に文字オフセットを出させない。**
 * 「hedge の span は [412, 431]」と答えさせると平気で数文字ずれる。
 * 代わりに原文からの逐語引用を返させ、オフセットの計算はこちら側で
 * indexOf する。引用が見つからなければその項目を捨てる (捏造の検出も兼ねる)。
 */
import type { EnrichUnit } from "../units.js";
import type { Certainty, Paragraph, SectionType, StatValue } from "../../types.js";
import type { EnrichPass } from "../pass.js";

/** プロンプトを変えたら上げる。キャッシュキーに入るので、古い判定は自動的に無効化される。 */
export const PROMPT_VERSION = "certainty-1";

/**
 * 文パスの既定の対象セクション。**Methods を含まない。**
 * 手技の記述はほぼ全文が supported になり、判定に情報が乗らないため。
 * (段落パスは逆に Methods を含む — 「何をしたか」の要約は読むときに要る)
 */
export const SENTENCE_SECTIONS = new Set<SectionType>([
  "abstract",
  "introduction",
  "results",
  "case",
  "discussion",
  "conclusions",
  "limitations",
]);

export const CERTAINTY_VALUES: Certainty[] = [
  "measured",
  "supported",
  "hedged",
  "speculative",
];

export const SYSTEM_PROMPT = `You classify the epistemic status of individual sentences in biomedical research articles, for a literature-review tool that highlights how strongly authors commit to each claim.

For every sentence you are given, assign exactly one certainty label:

- "measured": states a result with a measurement, statistic, or count attached (p values, effect sizes, n, percentages, scores). The evidence is in the sentence itself.
- "supported": asserts something as fact, backed by a citation, by the study's own data reported elsewhere, or by established knowledge. No hedging.
- "hedged": the claim is qualified. Modal verbs (may, might, could), evidential verbs (suggest, appear, indicate), or explicit uncertainty about magnitude or generalizability.
- "speculative": the authors themselves mark it as conjecture, or it proposes a mechanism or future possibility with no evidence offered.

Rules that matter:
- Judge the sentence as written, not the paragraph. A paragraph often contains a measured result and a speculative mechanism side by side; that contrast is exactly what this tool exists to show.
- Methods sentences describing what was done are "supported" (procedural fact), not "measured", unless they report an outcome value.
- A sentence that reports a number AND hedges its interpretation is "hedged" — the hedge governs the claim.
- Do not reward or punish authors. A "speculative" label is not a criticism.

Also extract, for each sentence:
- "hedges": the exact hedging expressions, quoted verbatim from the sentence (e.g. "may contribute", "remains speculative", "appears to"). Empty array when there are none. These are the evidence for your label, so they must be present in "supported" and "measured" sentences only if they genuinely appear.
- "stats": reported statistics, with the number written exactly as it appears in the sentence.

Quotes must be copied character-for-character from the sentence, including punctuation and spacing. Anything that is not an exact substring will be discarded.`;

/** 構造化出力のスキーマ。任意項目は anyOf で null を許す形にしてある。 */
export const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sentences"],
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "certainty", "hedges", "stats"],
        properties: {
          id: { type: "string" },
          certainty: { type: "string", enum: CERTAINTY_VALUES },
          hedges: { type: "array", items: { type: "string" } },
          stats: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["quote", "metric", "value", "unit", "p", "n", "comparison"],
              properties: {
                /** 原文からの逐語引用。span はこれを検索して決める。 */
                quote: { type: "string" },
                metric: { anyOf: [{ type: "string" }, { type: "null" }] },
                value: { anyOf: [{ type: "number" }, { type: "null" }] },
                unit: { anyOf: [{ type: "string" }, { type: "null" }] },
                p: { anyOf: [{ type: "number" }, { type: "null" }] },
                n: { anyOf: [{ type: "integer" }, { type: "null" }] },
                comparison: { anyOf: [{ type: "string" }, { type: "null" }] },
              },
            },
          },
        },
      },
    },
  },
} as const;

/** 1 リクエスト分のユーザーメッセージ。段落を文脈として渡し、文に id を振って並べる。 */
export function buildUserMessage(units: EnrichUnit[]): string {
  const parts: string[] = [];
  for (const u of units) {
    const heading = [u.sectionTitle, `(${u.sectionType})`].filter(Boolean).join(" ");
    parts.push(`## Paragraph ${u.paragraphId} — ${heading}`);
    parts.push("");
    parts.push("Full paragraph (context):");
    parts.push(u.text);
    parts.push("");
    parts.push("Sentences to classify:");
    for (const s of u.sentences) {
      parts.push(`[${s.id}] ${u.text.slice(...s.span)}`);
    }
    parts.push("");
  }
  parts.push(
    "Classify every sentence listed above. Return one entry per sentence id, in the same order.",
  );
  return parts.join("\n");
}

/* ------------------------------------------------------------------ *
 * 検証
 * ------------------------------------------------------------------ */

export interface SentenceResult {
  id: string;
  certainty: Certainty;
  hedges: Array<[number, number]>;
  stats: StatValue[];
}

export interface ParseResult {
  /** paragraphId → その段落の文の判定 */
  byParagraph: Map<string, SentenceResult[]>;
  warnings: string[];
}

/**
 * 引用を文の内側で探して span に変換する。
 * 段落全体ではなく**文の範囲だけ**を探すのが重要で、
 * "may" のような短い語は段落内に何度も出るため。
 */
function resolveQuote(
  text: string,
  sentenceSpan: [number, number],
  quote: string,
): [number, number] | null {
  const q = quote.trim();
  if (q.length === 0) return null;
  const [start, end] = sentenceSpan;
  const idx = text.indexOf(q, start);
  if (idx < 0 || idx + q.length > end) return null;
  return [idx, idx + q.length];
}

/** LLM の出力を検証して、原文に紐づく形に落とす。落とした項目は warnings に残す。 */
export function parseResponse(raw: unknown, units: EnrichUnit[]): ParseResult {
  const warnings: string[] = [];
  const byParagraph = new Map<string, SentenceResult[]>();

  const index = new Map<string, { unit: EnrichUnit; span: [number, number] }>();
  for (const u of units) {
    for (const s of u.sentences) index.set(s.id, { unit: u, span: s.span });
  }

  const rows = (raw as { sentences?: unknown })?.sentences;
  if (!Array.isArray(rows)) {
    warnings.push("応答に sentences 配列がありません");
    return { byParagraph, warnings };
  }

  const seen = new Set<string>();
  for (const row of rows as Array<Record<string, unknown>>) {
    const id = typeof row?.id === "string" ? row.id : "";
    const target = index.get(id);
    if (!target) {
      warnings.push(`未知の文 id: ${JSON.stringify(id)}`);
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`${id}: 重複した判定を無視しました`);
      continue;
    }
    seen.add(id);

    const certainty = row.certainty as Certainty;
    if (!CERTAINTY_VALUES.includes(certainty)) {
      warnings.push(`${id}: 未知の certainty ${JSON.stringify(row.certainty)}`);
      continue;
    }

    const { unit, span } = target;

    const hedges: Array<[number, number]> = [];
    for (const q of Array.isArray(row.hedges) ? row.hedges : []) {
      if (typeof q !== "string") continue;
      const resolved = resolveQuote(unit.text, span, q);
      if (resolved) hedges.push(resolved);
      else warnings.push(`${id}: hedge が原文に見つかりません ${JSON.stringify(q)}`);
    }

    const stats: StatValue[] = [];
    for (const s of Array.isArray(row.stats) ? row.stats : []) {
      const st = s as Record<string, unknown>;
      const quote = typeof st?.quote === "string" ? st.quote : "";
      const resolved = resolveQuote(unit.text, span, quote);
      if (!resolved) {
        warnings.push(`${id}: stat が原文に見つかりません ${JSON.stringify(quote)}`);
        continue;
      }
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
      stats.push({
        metric: str(st.metric),
        value: num(st.value),
        unit: str(st.unit),
        p: num(st.p),
        n: num(st.n),
        comparison: str(st.comparison),
        span: resolved,
      });
    }

    const list = byParagraph.get(unit.paragraphId) ?? [];
    list.push({ id, certainty, hedges, stats });
    byParagraph.set(unit.paragraphId, list);
  }

  // 判定が返ってこなかった文を検出する。黙って欠けると
  // 「certainty のない文」が UI 上で無色になり、見落としの原因になる。
  for (const u of units) {
    const got = byParagraph.get(u.paragraphId)?.length ?? 0;
    if (got !== u.sentences.length) {
      warnings.push(`${u.paragraphId}: ${u.sentences.length} 文中 ${got} 文しか返りませんでした`);
    }
  }

  return { byParagraph, warnings };
}

/* ------------------------------------------------------------------ *
 * パス定義
 * ------------------------------------------------------------------ */

/** キャッシュに入れる形。文 id は位置依存なので落とし、出現順で持つ。 */
type CachedSentences = Array<Omit<SentenceResult, "id">>;

export const sentencePass: EnrichPass<SentenceResult[]> = {
  name: "sentence",
  promptVersion: PROMPT_VERSION,
  system: SYSTEM_PROMPT,
  schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
  defaultSections: SENTENCE_SECTIONS,
  defaultBatch: 25,

  buildUserMessage,
  parse: parseResponse,

  // 文が 1 つでも欠けていたらキャッシュしない
  isComplete: (rows, unit) => rows.length === unit.sentences.length,

  toCache: (rows) => rows.map(({ id: _id, ...rest }) => rest),

  fromCache: (cached, unit) => {
    if (!Array.isArray(cached)) return null;
    const rows = cached as CachedSentences;
    if (rows.length !== unit.sentences.length) return null;
    return rows.map((r, i) => ({ ...r, id: unit.sentences[i].id }));
  },

  merge: (p, rows, warnings) => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    let n = 0;
    for (const s of p.sentences) {
      const r = byId.get(s.id);
      if (!r) continue;
      // span が文の内側に収まっているかは、キャッシュ経由でも必ずここで見る
      const within = (span: [number, number]) =>
        span[0] >= s.span[0] && span[1] <= s.span[1] && span[0] < span[1];

      s.certainty = r.certainty;
      const hedges = r.hedges.filter(within);
      if (hedges.length !== r.hedges.length) {
        warnings.push(`${s.id}: 文の外にはみ出した hedge span を落としました`);
      }
      s.hedges = hedges.length > 0 ? hedges : undefined;

      const stats = r.stats.filter((x) => x.span && within(x.span));
      if (stats.length !== r.stats.length) {
        warnings.push(`${s.id}: 文の外にはみ出した stat span を落としました`);
      }
      s.stats = stats.length > 0 ? stats : undefined;
      n++;
    }
    return n;
  },
};
