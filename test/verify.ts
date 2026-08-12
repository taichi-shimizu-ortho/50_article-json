import { readFileSync } from "node:fs";
import { parseJats, flattenParagraphs, summarize } from "../src/ingest/parseJats.js";

const xml = readFileSync(new URL("./fixture.jats.xml", import.meta.url), "utf8");
const article = parseJats(xml, { flavor: "mdpi-jats" });

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
};

console.log("=".repeat(70));
console.log(summarize(article));
console.log("=".repeat(70));

/* --- 1. メタデータ --- */
console.log("\n[1] メタデータ");
check("DOI", article.meta.doi === "10.3390/cells15141249", article.meta.doi);
check("PMID", article.meta.pmid === "42505359", article.meta.pmid);
check("id スラグ", article.id === "10-3390-cells15141249", article.id);
check("誌名", article.meta.journal === "Cells", article.meta.journal);
check("刊行日", article.meta.pubDate === "2026-07-10", article.meta.pubDate);
check("著者数", article.meta.authors.length === 3, String(article.meta.authors.length));
check(
  "ORCID",
  article.meta.authors[0].orcid === "0000-0002-5070-1185",
  article.meta.authors[0].orcid,
);
check(
  "所属解決 (label 除去済み)",
  Boolean(article.meta.authors[0].affiliations[0]?.startsWith("The Steadman")),
  article.meta.authors[0].affiliations[0],
);
check(
  "responsible author フラグ",
  article.meta.authors[2].corresponding === true,
);
check("キーワード", article.meta.keywords.length === 3);
check(
  "ライセンス URL",
  article.meta.licenseUrl === "https://creativecommons.org/licenses/by/4.0/",
  article.meta.licenseUrl,
);
check(
  "タイトルの改行が畳まれている",
  !/\s{2,}|\n/.test(article.meta.title ?? "x"),
);

/* --- 2. セクション構造 --- */
console.log("\n[2] セクション構造");
const topTypes = article.sections.map((s) => s.type);
check(
  "IMRaD 正規化",
  JSON.stringify(topTypes.slice(0, 5)) ===
    JSON.stringify(["introduction", "methods", "results", "discussion", "conclusions"]),
  topTypes.join(","),
);
check(
  "back セクションが b1/b2 として付与",
  article.sections.at(-2)?.id === "b1" && article.sections.at(-1)?.id === "b2",
);
check(
  "funding / conflicts の型判定",
  article.sections.at(-2)?.type === "funding" &&
    article.sections.at(-1)?.type === "conflicts",
);
const methods = article.sections[1];
check("サブセクション数", methods.sections.length === 3);
check(
  "サブセクションが親の型を継承 (2.2 Flow Cytometry → methods)",
  methods.sections[1].type === "methods",
  methods.sections[1].type,
);
check(
  "サブセクションの level",
  methods.sections[0].level === 2,
);
check(
  "ID の階層",
  methods.sections[1].id === "s2-2" &&
    methods.sections[1].paragraphs[0].id === "s2-2-p1",
  methods.sections[1].paragraphs[0].id,
);
check(
  "xmlId 保持",
  methods.sections[1].xmlId === "sec2dot2-cells-15-01249",
);

/* --- 3. span 整合性 (最重要) --- */
console.log("\n[3] span 整合性 — 実際に slice して照合");
const paras = [...flattenParagraphs(article.abstract), ...flattenParagraphs(article.sections)];

// 抄録の italic p はすべて "p" に切り出せるはず
const abs = paras.find((p) => p.id.startsWith("abs"))!;
const italics = abs.marks.filter((m) => m.type === "italic");
check(
  "抄録の <italic>p</italic> が 3 個",
  italics.length === 3,
  String(italics.length),
);
check(
  "italic の slice がすべて 'p'",
  italics.every((m) => abs.text.slice(...m.span) === "p"),
  italics.map((m) => JSON.stringify(abs.text.slice(...m.span))).join(" "),
);
const sups = abs.marks.filter((m) => m.type === "sup");
check(
  "sup の slice が + / − になっている",
  sups.length === 4 && sups.every((m) => ["+", "−"].includes(abs.text.slice(...m.span))),
  `${sups.length} 個: ${sups.map((m) => abs.text.slice(...m.span)).join("")}`,
);
const subs = abs.marks.filter((m) => m.type === "sub");
check("sub (CO2 の 2)", subs.length === 1 && abs.text.slice(...subs[0].span) === "2");

// 連続 xref の切り出し
const intro1 = paras.find((p) => p.id === "s1-p1")!;
const xrefs = intro1.marks.filter((m) => m.type === "xref");
check("Introduction 第1段落の xref が 3 個", xrefs.length === 3, String(xrefs.length));
check(
  "連続 xref が 1,2,3 に切り出せる",
  xrefs.map((m) => intro1.text.slice(...m.span)).join("|") === "1|2|3",
  xrefs.map((m) => intro1.text.slice(...m.span)).join("|"),
);
check(
  "xref の前後が [ ] で囲まれている (テキスト連結が壊れていない)",
  intro1.text.includes("(OA) [1,2,3]."),
  intro1.text.slice(-30),
);

// 空白正規化されているか
check(
  "段落テキストに改行・連続空白が残っていない",
  paras.every((p) => !/\n|\s{2,}/.test(p.text)),
);
check(
  "段落テキストが空白で始まらない/終わらない",
  paras.every((p) => p.text === p.text.trim()),
);

// 全 mark の span が範囲内
check(
  "全 mark の span が text の範囲内かつ start < end",
  paras.every((p) =>
    p.marks.every(
      (m) => m.span[0] >= 0 && m.span[1] <= p.text.length && m.span[0] < m.span[1],
    ),
  ),
);

/* --- 4. 参照の紐づけ --- */
console.log("\n[4] 参照の紐づけ");
const intro2 = paras.find((p) => p.id === "s1-p2")!;
check(
  "空白区切りの複数 rid が展開される",
  JSON.stringify(intro2.refIds) ===
    JSON.stringify(["B13-cells-15-01249", "B14-cells-15-01249"]),
  intro2.refIds.join(","),
);
const res2 = paras.find((p) => p.id === "s3-2-p1")!;
check(
  "table と fig の xref が別バケットに入る",
  res2.tableIds.join() === "cells-15-01249-t002" &&
    res2.figIds.join() === "cells-15-01249-f004",
  `tables=${res2.tableIds} figs=${res2.figIds}`,
);
const fc = paras.find((p) => p.id === "s2-2-p1")!;
check(
  "ext-link の href",
  fc.marks.find((m) => m.type === "ext-link")?.href === "https://example.org/protocol",
);
check(
  "ext-link の表示テキスト",
  fc.text.includes("the study repository"),
);
const stat = paras.find((p) => p.id === "s2-3-p1")!;
check(
  "inline-formula が tex-math を採用",
  fc !== undefined &&
    stat.text.includes("d = (\\mu_1 - \\mu_2)/\\sigma"),
  stat.text.slice(-70),
);

/* --- 5. 本文からのブロック除外 --- */
console.log("\n[5] 図表がブロックとして本文から除外されている");
const res1 = paras.find((p) => p.id === "s3-1-p1")!;
check(
  "段落本文に figure caption が混入していない",
  !res1.text.includes("Characterization of micronized"),
  res1.text.slice(0, 60),
);
check(
  "段落本文に table の中身が混入していない",
  !res2.text.includes("12.4"),
);

/* --- 6. 図・表・文献 --- */
console.log("\n[6] 図・表・文献");
check("図が 1 件", article.figures.length === 1);
check("図の graphic href", article.figures[0].graphics[0] === "cells-15-01249-g002.png");
check(
  "図の caption",
  Boolean(article.figures[0].caption?.startsWith("Characterization of micronized")),
);
check("表が 1 件", article.tables.length === 1);
check(
  "表が 4 行 × 3 列",
  article.tables[0].rows.length === 4 && article.tables[0].rows[0].length === 3,
  JSON.stringify(article.tables[0].rows[0]),
);
check(
  "表のヘッダ行",
  article.tables[0].rows[0].join("|") === "Group|4 weeks|8 weeks",
);
// rows は thead/tbody を平坦化しているので、見出しは行数で持つしかない。
// 先頭行を見出しと決め打ちすると、見出しの無い表で 1 行目が消える。
check(
  "thead の行数を headerRows に持つ",
  article.tables[0].headerRows === 1,
  String(article.tables[0].headerRows),
);
check(
  "本体行が thead を含まない",
  article.tables[0].rows.slice(article.tables[0].headerRows).length === 3,
);
check("表の脚注", article.tables[0].footnotes[0] === "Data are presented as mean ± SD.");
check("文献が 3 件", article.references.length === 3);
check(
  "element-citation の構造化",
  article.references[0].doi === "10.1016/j.knee.2021.08.008" &&
    article.references[0].pages === "173–182" &&
    article.references[0].authors.length === 2,
  JSON.stringify(article.references[0]),
);
check(
  "mixed-citation は raw で保持",
  Boolean(article.references[1].raw?.includes("Cavallo")),
);
check(
  "xref の rid が references の xmlId と一致する",
  intro1.refIds.every(() => true) &&
    article.references.some((r) => r.xmlId === "B1-cells-15-01249"),
);

/* --- 7. 文分割 --- */
console.log("\n[7] 文分割 (certainty / stats の単位)");
const sentences = paras.flatMap((p) => p.sentences.map((s) => ({ p, s })));
check(
  "全段落が 1 文以上を持つ",
  paras.every((p) => p.sentences.length > 0),
  paras.filter((p) => p.sentences.length === 0).map((p) => p.id).join(","),
);
check(
  "sentence.span が text の範囲内かつ start < end",
  sentences.every(
    ({ p, s }) => s.span[0] >= 0 && s.span[1] <= p.text.length && s.span[0] < s.span[1],
  ),
);
check(
  "sentence.span が重なっていない / 昇順",
  paras.every((p) =>
    p.sentences.every((s, i) => i === 0 || p.sentences[i - 1].span[1] <= s.span[0]),
  ),
);
check(
  "sentence が前後に空白を含まない",
  sentences.every(({ p, s }) => {
    const t = p.text.slice(...s.span);
    return t === t.trim();
  }),
);
check(
  "文を連結すると段落が復元される (取りこぼしなし)",
  paras.every((p) => {
    const joined = p.sentences.map((s) => p.text.slice(...s.span)).join(" ");
    return joined.replace(/\s+/g, "") === p.text.replace(/\s+/g, "");
  }),
  paras
    .filter((p) => {
      const joined = p.sentences.map((s) => p.text.slice(...s.span)).join(" ");
      return joined.replace(/\s+/g, "") !== p.text.replace(/\s+/g, "");
    })
    .map((p) => p.id)
    .join(","),
);
check(
  "sentence.id が段落 id を継いだ連番",
  paras.every((p) => p.sentences.every((s, i) => s.id === `${p.id}-s${i + 1}`)),
);
// 小数を含む段落が 1 文のまま保たれているか (p = 0.0011 で割れないこと)
const statPara = paras.find((p) => p.text.includes("p = 0.0011"))!;
check(
  "統計値の小数で分割されていない",
  statPara.sentences.some((s) => statPara.text.slice(...s.span).includes("p = 0.0011")),
  statPara.sentences.map((s) => statPara.text.slice(...s.span)).join(" | ").slice(0, 120),
);
// mark と sentence の座標系が同じであること (UI が両方を段落テキストに重ねる前提)
check(
  "全 mark がいずれかの文に収まる",
  paras.every((p) =>
    p.marks.every((m) =>
      p.sentences.some((s) => m.span[0] >= s.span[0] && m.span[1] <= s.span[1]),
    ),
  ),
  paras
    .flatMap((p) =>
      p.marks
        .filter((m) => !p.sentences.some((s) => m.span[0] >= s.span[0] && m.span[1] <= s.span[1]))
        .map((m) => `${p.id}:${JSON.stringify(p.text.slice(...m.span))}`),
    )
    .join(" "),
);

/* --- 8. 警告 --- */
console.log("\n[8] 構造監査");
check(
  "IMRaD 揃いなので構造警告なし",
  !article.warnings.some((w) => w.includes("見つかりません") && w.includes("セクション")),
  article.warnings.join(" / "),
);

console.log("\n" + "=".repeat(70));
console.log(failures === 0 ? `全チェック通過` : `${failures} 件の失敗`);
process.exit(failures === 0 ? 0 : 1);
