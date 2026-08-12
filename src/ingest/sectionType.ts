import type { SectionType } from "../types.js";

/**
 * JATS の @sec-type は出版社によって付いたり付かなかったりする。
 * MDPI はほぼ付けてこないので、タイトル文字列からの推定が本命になる。
 */

/** @sec-type の値 → 正規化型。JATS 推奨語彙 + 各社の方言。 */
const SEC_TYPE_MAP: Record<string, SectionType> = {
  intro: "introduction",
  introduction: "introduction",
  background: "introduction",
  methods: "methods",
  "materials|methods": "methods",
  "materials-and-methods": "methods",
  "subjects|methods": "methods",
  results: "results",
  "results|discussion": "results",
  discussion: "discussion",
  conclusion: "conclusions",
  conclusions: "conclusions",
  supplementary_material: "supplementary",
  "supplementary-material": "supplementary",
  ack: "acknowledgements",
  funding: "funding",
  COI_statement: "conflicts",
  abbreviations: "abbreviations",
};

/**
 * タイトル正規表現。
 *
 * strength が重要:
 *   strong = 親セクションの型を上書きしてよい (Discussion 配下の Limitations など、
 *            本来ネストしうる種別)
 *   weak   = トップレベルでのみ効く話題ヒント。サブセクションでは親を優先する。
 *
 * 実データで "3.2. Experimental Design and In Vivo Evaluation" (Results 配下) が
 * /experimental/ に引っかかって methods 判定になった。話題語は弱くする必要がある。
 */
type Strength = "strong" | "weak";

const TITLE_RULES: Array<[RegExp, SectionType, Strength]> = [
  // limitations は discussion より先に判定する (Discussion 配下に置かれるため)
  [/\blimitation/i, "limitations", "strong"],
  [/\bstrengths?\s+and\s+limitations?\b/i, "limitations", "strong"],

  [/\bintroduction\b/i, "introduction", "strong"],
  [/^\s*background\b/i, "introduction", "strong"],

  [/\b(materials?|subjects?|patients?)\b.*\bmethods?\b/i, "methods", "strong"],
  [/\bmethods?\b/i, "methods", "strong"],

  [/\bresults?\b/i, "results", "strong"],
  // 症例報告の本体。IMRaD の results に相当し、精読では最も重要な節になる。
  // "Case Report" を other のままにすると enrich の対象から外れてしまう。
  [/\bcase\s+(report|presentation|description|history|study)\b/i, "case", "strong"],
  [/^\s*case\s*\d*\s*$/i, "case", "strong"],
  [/\bdiscussion\b/i, "discussion", "strong"],
  [/\bconclusions?\b/i, "conclusions", "strong"],
  [/\bconcluding\s+remarks\b/i, "conclusions", "strong"],

  // 後付け資料まわり。どこに現れても後付け資料。
  [/\bsupplementary\b/i, "supplementary", "strong"],
  [/\backnowledg/i, "acknowledgements", "strong"],
  [/\bfunding\b/i, "funding", "strong"],
  [/\bfinancial\s+support\b/i, "funding", "strong"],
  [/\b(conflicts?\s+of\s+interest|competing\s+interests?|disclosure)/i, "conflicts", "strong"],
  [/\b(institutional\s+review\s+board|informed\s+consent|ethic)/i, "ethics", "strong"],
  [/\bdata\s+availability\b/i, "data-availability", "strong"],
  [/\babbreviations?\b/i, "abbreviations", "strong"],

  // 以下は話題ヒント。トップレベルでのみ効かせる。
  [/\bmethodology\b/i, "methods", "weak"],
  [/\bstudy\s+design\b/i, "methods", "weak"],
  [/\bstatistical\s+analys/i, "methods", "weak"],
  [/\bexperimental\b/i, "methods", "weak"],
  [/\bfindings?\b/i, "results", "weak"],
];

/** <notes notes-type="..."> の値 → 正規化型 */
const NOTES_TYPE_MAP: Record<string, SectionType> = {
  "coi-statement": "conflicts",
  "conflict": "conflicts",
  "funding-information": "funding",
  "data-availability": "data-availability",
};

export function classifyNotesType(notesType: string | undefined): SectionType | undefined {
  if (!notesType) return undefined;
  return NOTES_TYPE_MAP[notesType.trim().toLowerCase()];
}

export interface ClassifyInput {
  title?: string;
  secType?: string | null;
  /** 見出しの深さ。トップレベルが 1。 */
  level: number;
  /** 親セクションの型。サブセクションの継承に使う。 */
  parentType?: SectionType;
}

export function classifySection(input: ClassifyInput): SectionType {
  const { title, secType, level, parentType } = input;

  // 1. @sec-type があれば最優先
  if (secType) {
    const hit = SEC_TYPE_MAP[secType.trim().toLowerCase()];
    if (hit) return hit;
  }

  // 2. タイトルから推定。先頭の番号 ("2.1. ") は落としてから判定する。
  if (title) {
    const cleaned = title.replace(/^\s*[\d]+(\.[\d]+)*\.?\s*/, "").trim();
    const isSub = level > 1 && parentType !== undefined;
    for (const [re, type, strength] of TITLE_RULES) {
      // サブセクションでは弱いルールを無視し、親の型を維持する
      if (isSub && strength === "weak") continue;
      if (re.test(cleaned)) return type;
    }
  }

  // 3. サブセクションは親を継承する。
  //    "2.4. Flow Cytometry" のような固有名詞の見出しはここで methods になる。
  if (level > 1 && parentType) return parentType;

  return "other";
}

/**
 * トップレベルセクションが IMRaD をひと通り含んでいるか点検する。
 * 欠けている場合、パーサが構造を取り違えている可能性が高いので警告を出す。
 */
/**
 * IMRaD を期待しない article-type。
 *
 * 症例報告に Methods / Results が無いのは正しい。実データ (PMC3143999,
 * `article-type="case-report"`) で誤警告が 2 件出た。論説・総説も同様。
 */
const NON_IMRAD_TYPES = new Set([
  "case-report",
  "editorial",
  "review-article",
  "letter",
  "correction",
  "retraction",
  "book-review",
  "news",
  "other",
]);

export function auditStructure(types: SectionType[], articleType?: string): string[] {
  const warnings: string[] = [];
  const present = new Set(types);
  if (articleType && NON_IMRAD_TYPES.has(articleType)) {
    // IMRaD の欠落は問い合わせない。過半数 other の検査だけ続ける。
    const n = types.filter((t) => t === "other").length;
    return n > types.length / 2
      ? [`トップレベルの過半数 (${n}/${types.length}) が other 判定です (article-type=${articleType})`]
      : [];
  }
  // 症例報告本体があるなら、methods / results の欠落は正常
  const caseStyle = present.has("case");
  for (const required of ["introduction", "methods", "results", "discussion"] as const) {
    if (caseStyle && (required === "methods" || required === "results")) continue;
    if (!present.has(required)) {
      warnings.push(`トップレベルに ${required} セクションが見つかりません`);
    }
  }
  const otherCount = types.filter((t) => t === "other").length;
  if (otherCount > types.length / 2) {
    warnings.push(
      `トップレベルの過半数 (${otherCount}/${types.length}) が other 判定です。見出し規則の追加を検討してください`,
    );
  }
  return warnings;
}
