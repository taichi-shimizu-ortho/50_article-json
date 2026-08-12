/**
 * 段落パス — role / gist / plain。
 *
 * 精読の主軸はこちら。段落を1行で言い切った gist が並べば論文の骨子になり、
 * plain があれば専門外の分野でも追える。
 *
 * **設計上の要: 要約が著者の断定度を保存すること。**
 * 文単位 certainty をやめた以上、hedge を落とす要約は許されない。
 * 「機序は推測にとどまる」と書いてある段落を「機序は〜である」と要約したら、
 * 見分けたかった区別がここで消える。プロンプトの中心はこの一点で、
 * 検証もここを見ている (下の HEDGE)。
 */
import type { EnrichUnit } from "../units.js";
import type { Paragraph, ParagraphRole, SectionType } from "../../types.js";
import type { EnrichPass } from "../pass.js";

// paragraph-2: 出力を全面的に英語にした (plainJa → plain)
export const PROMPT_VERSION = "paragraph-2";

/**
 * 段落パスの対象セクション。**Methods を含む。**
 * 断定度の判定には情報がないが、「何をしたか」の要約は精読で普通に要る。
 */
export const PARAGRAPH_SECTIONS = new Set<SectionType>([
  "abstract",
  "introduction",
  "methods",
  "results",
  "case",
  "discussion",
  "conclusions",
  "limitations",
]);

export const ROLES: ParagraphRole[] = [
  "background",
  "gap",
  "objective",
  "study_design",
  "method",
  "result",
  "claim",
  "interpretation",
  "limitation",
  "conclusion",
  "other",
];

export const SYSTEM_PROMPT = `You summarize paragraphs of biomedical research articles for a close-reading tool. A researcher uses these summaries to navigate a paper and decide which paragraphs to read in full.

For each paragraph, return three things.

**role** — what the paragraph is doing in the article:
- "background": established knowledge, disease burden, prior work
- "gap": what is unknown, unresolved, or wrong with prior approaches
- "objective": what this study set out to do
- "study_design": the overall design (model, groups, timeline, endpoints)
- "method": a specific procedure or assay
- "result": reports outcomes of this study
- "claim": asserts what the results mean, stated as the study's contribution
- "interpretation": reasons about why the results came out this way; mechanism
- "limitation": what constrains the findings
- "conclusion": the take-home message
- "other": anything else

**gist** — one English sentence, at most 30 words, saying what this paragraph establishes. Not a topic label ("discusses the immune response") but the actual content ("BMAX-derived MSCs released more IL-6 than BMAC-derived MSCs after TNF-alpha challenge").

**plain** — one to three sentences of plain English, for a reader outside this subfield. Unpack the jargon rather than repeating it: say what was done and what it means, in the words a competent researcher from another field would use. This is a summary, not a simplification of the wording — do not omit content to make it read easier.

CRITICAL — preserve the authors' epistemic stance. This is the single most important requirement:
- If the authors hedge, the summary must hedge. "may contribute" stays "may contribute" or becomes "is one possible contributor" — never "contributes".
- If the authors explicitly call something speculative, unverified, or not directly measured, the summary must say so. Do not quietly drop that qualification because it makes the summary shorter.
- If the authors state something flatly, do not soften it either. Both directions are distortions.
- Never introduce a fact, number, or causal claim that is not in the paragraph. If the paragraph reports a p value or effect size that carries the paragraph's point, keep it in the gist.

A summary that upgrades a hedged claim into an assertion is worse than no summary, because the reader loses exactly the signal they opened this tool to see.`;

export const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["paragraphs"],
  properties: {
    paragraphs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "role", "gist", "plain"],
        properties: {
          id: { type: "string" },
          role: { type: "string", enum: ROLES },
          gist: { type: "string" },
          plain: { type: "string" },
        },
      },
    },
  },
} as const;

export function buildUserMessage(units: EnrichUnit[]): string {
  const parts: string[] = [];
  for (const u of units) {
    const heading = [u.sectionTitle, `(${u.sectionType})`].filter(Boolean).join(" ");
    parts.push(`## [${u.paragraphId}] ${heading}`);
    parts.push(u.text);
    parts.push("");
  }
  parts.push(
    "Summarize every paragraph above. Return one entry per paragraph id, in the same order.",
  );
  return parts.join("\n");
}

/* ------------------------------------------------------------------ *
 * 検証
 * ------------------------------------------------------------------ */

export interface ParagraphResult {
  role: ParagraphRole;
  gist: string;
  plain: string;
}

/**
 * hedge 表現。
 *
 * 出力を英語に統一したことで、**原文と要約を同じ規則で照合できる**ようになった。
 * 日本語要約だった頃は文末表現の幅が広く、辞書が追いつかずに誤検知していた
 * (「代替となりうる」を留保と認識できなかった)。
 *
 * **辞書は原文側と要約側で非対称にしてある。** 検査は
 * 「原文に hedge あり かつ 要約に hedge なし」で警告する、という非対称な
 * 条件なので、両側の誤りのコストが違う:
 *
 *   原文側の過検出 → 誤警告が出る   → 精度を優先する (狭くする)
 *   要約側の取り逃し → 誤警告が出る → 再現率を優先する (広くする)
 *
 * 同じ語彙を両側に使うと、この非対称を無視することになる。実際 `potential`
 * は本コーパスの原文に 8 回出るが**すべて名詞** ("therapeutic potential",
 * "differentiation potential")で、留保ではない。一方 `potential` が要約側に
 * 出たならそれは留保とみなしてよい。だから要約側だけに置く。
 */
const EPISTEMIC = [
  // 法助動詞
  "may", "might", "could", "would\\s+likely",
  // 証拠性の動詞
  "suggest\\w*", "appear\\w*", "seem\\w*", "propos\\w*",
  "hypothesi\\w*", "argu\\w*", "thought\\s+to", "believed\\s+to",
  // 形容詞・副詞
  "likely", "unlikely", "possible", "possibly", "plausibl\\w*",
  "presumabl\\w*", "speculativ\\w*", "tentativ\\w*",
  // 明示的な不確実性
  "uncertain\\w*", "unclear", "unproven", "not\\s+established",
  "remains?\\s+to\\s+be", "cannot\\s+be\\s+excluded",
  "no\\s+clinical\\s+data", "based\\s+on\\s+a\\s+single",
];

/**
 * 要約側だけで hedge とみなす表現。
 *
 * 前半は生医学の原文では技術用語の一部になりやすい語 ("apparent diffusion
 * coefficient", "a score of 0 indicates ...")。要約に出たなら留保である。
 * 後半は言い換えとして自然に出てくる留保で、原文の語形とは一致しない
 * ("remains to be validated" → "external validation is still needed")。
 */
const SUMMARY_ONLY = [
  "potential\\w*", "indicat\\w*", "apparent\\w*", "warrant\\w*",
  "not\\s+(?:yet\\s+)?(?:been\\s+)?(?:tested|shown|established|proven|confirmed|verified)",
  "had\\s+not\\s+been", "still\\s+needed", "needs?\\s+(?:further|external|independent)",
  "further\\s+(?:study|studies|work|research)", "generaliz\\w*",
  "only\\s+trend\\w*", "did\\s+not\\s+reach", "no\\s+direct\\s+evidence",
];

const alt = (terms: string[]) => new RegExp("\\b(" + terms.join("|") + ")\\b", "i");

/** 原文側: 精度優先。認識論的な留保だけ。 */
const SOURCE_HEDGE = alt(EPISTEMIC);
/** 要約側: 再現率優先。原文側の語彙をすべて含む。 */
const SUMMARY_HEDGE = alt([...EPISTEMIC, ...SUMMARY_ONLY]);

/**
 * 検査を免除する role。
 *
 * 手順の記述には保存すべき断定度が無い。「スコア 0 は無反応を示す
 * (indicates)」は留保ではなく定義で、要約が言い切るのが正しい。
 * セクション種別ではなく role で見るのは、Methods 節の外に置かれた
 * 手順段落も拾えるため。
 */
const NO_STANCE = new Set<ParagraphRole>(["method", "study_design"]);


export function parseResponse(
  raw: unknown,
  units: EnrichUnit[],
): { byParagraph: Map<string, ParagraphResult>; warnings: string[] } {
  const warnings: string[] = [];
  const byParagraph = new Map<string, ParagraphResult>();
  const index = new Map(units.map((u) => [u.paragraphId, u]));

  const rows = (raw as { paragraphs?: unknown })?.paragraphs;
  if (!Array.isArray(rows)) {
    warnings.push("応答に paragraphs 配列がありません");
    return { byParagraph, warnings };
  }

  for (const row of rows as Array<Record<string, unknown>>) {
    const id = typeof row?.id === "string" ? row.id : "";
    const unit = index.get(id);
    if (!unit) {
      warnings.push(`未知の段落 id: ${JSON.stringify(id)}`);
      continue;
    }
    if (byParagraph.has(id)) {
      warnings.push(`${id}: 重複した要約を無視しました`);
      continue;
    }

    const role = row.role as ParagraphRole;
    if (!ROLES.includes(role)) {
      warnings.push(`${id}: 未知の role ${JSON.stringify(row.role)}`);
      continue;
    }
    const gist = typeof row.gist === "string" ? row.gist.trim() : "";
    const plain = typeof row.plain === "string" ? row.plain.trim() : "";
    if (gist === "" || plain === "") {
      warnings.push(`${id}: gist / plain が空です`);
      continue;
    }

    byParagraph.set(id, { role, gist, plain });
  }

  for (const u of units) {
    if (!byParagraph.has(u.paragraphId)) {
      warnings.push(`${u.paragraphId}: 要約が返りませんでした`);
    }
  }

  return { byParagraph, warnings };
}

/* ------------------------------------------------------------------ *
 * パス定義
 * ------------------------------------------------------------------ */

export const paragraphPass: EnrichPass<ParagraphResult> = {
  name: "paragraph",
  promptVersion: PROMPT_VERSION,
  system: SYSTEM_PROMPT,
  schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
  defaultSections: PARAGRAPH_SECTIONS,
  // 文数は長さの代理指標。段落パスは文を列挙しないぶん入力が短いので多めに束ねる。
  defaultBatch: 60,

  buildUserMessage,
  parse: parseResponse,

  // 検証を通った時点で完全 (空の gist / plain は parse で弾いている)
  isComplete: () => true,

  toCache: (r) => r,

  fromCache: (cached) => {
    const c = cached as Partial<ParagraphResult> | null;
    if (!c || typeof c.gist !== "string" || typeof c.plain !== "string") return null;
    if (!ROLES.includes(c.role as ParagraphRole)) return null;
    return { role: c.role as ParagraphRole, gist: c.gist, plain: c.plain };
  },

  /**
   * hedge の脱落検査は **merge に置く**。parse に置くとキャッシュ経由の段落を
   * 素通りしてしまい、検査規則を直しても引き直すまで反映されない。
   * 原文が留保しているのに要約が言い切っていたら警告する。
   *
   * 逆 (原文が断定・要約が留保) は検出しない。実害が小さいうえ、
   * 要約側の辞書を広く取っている以上そちらの過検出が跳ね返るだけになる。
   */
  merge: (p: Paragraph, r, warnings) => {
    if (!NO_STANCE.has(r.role) && SOURCE_HEDGE.test(p.text) && !SUMMARY_HEDGE.test(r.plain)) {
      warnings.push(`${p.id}: 原文に hedge があるが plain に留保が見当たりません`);
    }
    p.role = r.role;
    p.gist = r.gist;
    p.plain = r.plain;
    return 1;
  },
};
