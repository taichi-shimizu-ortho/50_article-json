/**
 * enrich の入力単位を組み立てる。
 *
 * 単位は「段落」。判定するのは文だが、文だけ切り出して投げると
 * "This was consistent with our hypothesis." のような文の断定度が判定できない。
 * 段落全体を文脈として渡し、文ごとにラベルを返させる。
 *
 * 課金と再現性の都合で、キャッシュキーもこの単位で作る。
 */
import { createHash } from "node:crypto";
import type { Article, Paragraph, Section, SectionType } from "../types.js";

/**
 * enrich の対象にするセクション種別。
 *
 * back matter (funding / conflicts / ack) は断定度を測る意味がないので外す。
 *
 * **methods も既定では外す。** 手技の記述は「何をしたか」の報告なので
 * ほぼ全文が supported になり、判定に情報がない。実データでは対象 221 文中
 * 91 文 (41%) が Methods で、ここが課金の最大項目だった。
 * Methods の統計値が欲しくなったら --with-methods で戻せる。
 */
export const ENRICH_SECTION_TYPES = new Set<SectionType>([
  "abstract",
  "introduction",
  "results",
  "discussion",
  "conclusions",
  "limitations",
]);

/** --with-methods 用 */
export const ENRICH_SECTION_TYPES_WITH_METHODS = new Set<SectionType>([
  ...ENRICH_SECTION_TYPES,
  "methods",
]);

export interface EnrichUnit {
  paragraphId: string;
  sectionType: SectionType;
  sectionTitle?: string;
  /** 段落テキスト。span はすべてこの文字列に対するオフセット。 */
  text: string;
  sentences: Array<{ id: string; span: [number, number] }>;
  /** 内容ハッシュ。段落テキストと文境界が変わらない限り同じ値になる。 */
  cacheKey: string;
}

/**
 * キャッシュキー。
 *
 * paragraph.id は入れない。セクションが 1 つ増えて番号がずれただけで
 * 全段落がキャッシュミスになると、LLM 課金がまるごと再発生する。
 * 内容 (テキストと文境界) が同じなら同じキーになるようにする。
 */
function cacheKeyFor(
  text: string,
  sentences: Array<[number, number]>,
  model: string,
  promptVersion: string,
): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ model, promptVersion, text, sentences }));
  return h.digest("hex").slice(0, 32);
}

export function collectUnits(
  article: Article,
  model: string,
  promptVersion: string,
  types: ReadonlySet<SectionType> = ENRICH_SECTION_TYPES,
): EnrichUnit[] {
  const out: EnrichUnit[] = [];

  const walk = (sections: Section[]) => {
    for (const s of sections) {
      if (types.has(s.type)) {
        for (const p of s.paragraphs) out.push(toUnit(p, s, model, promptVersion));
      }
      walk(s.sections);
    }
  };

  walk(article.abstract);
  walk(article.sections);
  return out.filter((u) => u.sentences.length > 0);
}

function toUnit(
  p: Paragraph,
  s: Section,
  model: string,
  promptVersion: string,
): EnrichUnit {
  const sentences = p.sentences.map((x) => ({ id: x.id, span: x.span }));
  return {
    paragraphId: p.id,
    sectionType: s.type,
    sectionTitle: s.title,
    text: p.text,
    sentences,
    cacheKey: cacheKeyFor(p.text, sentences.map((x) => x.span), model, promptVersion),
  };
}

/**
 * 1 リクエストあたりの文数で束ねる。段落は分割しない (文脈が切れるため)。
 *
 * 束ねる理由は往復回数の削減。ただし 1 リクエストに詰めすぎると
 * 出力 JSON が長くなり、途中で切れたときの被害が大きくなる。
 */
export function batchUnits(units: EnrichUnit[], maxSentences: number): EnrichUnit[][] {
  const batches: EnrichUnit[][] = [];
  let cur: EnrichUnit[] = [];
  let n = 0;
  for (const u of units) {
    if (cur.length > 0 && n + u.sentences.length > maxSentences) {
      batches.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(u);
    n += u.sentences.length;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}
