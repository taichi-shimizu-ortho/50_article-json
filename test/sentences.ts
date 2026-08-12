/**
 * 文分割の単体テスト。
 *
 * 期待値は「文の本文」を配列で書く。span の妥当性 (原文と一致するか、
 * 重なっていないか) は書き手が間違えようがないよう、比較の前に
 * text.slice(...span) から復元して照合している。
 */
import { splitSentences } from "../src/ingest/splitSentences.js";

let failures = 0;

function expect(
  label: string,
  text: string,
  want: string[],
  hardBreaks: number[] = [],
  citations: Array<[number, number]> = [],
) {
  const spans = splitSentences(text, hardBreaks, citations);
  const got = spans.map(([s, e]) => text.slice(s, e));

  const problems: string[] = [];
  // span 自体の健全性
  for (let i = 0; i < spans.length; i++) {
    const [s, e] = spans[i];
    if (s < 0 || e > text.length || s >= e) problems.push(`span 範囲外 [${s},${e})`);
    if (text[s] === " " || text[e - 1] === " ") problems.push(`span に空白が挟まっている [${s},${e})`);
    if (i > 0 && spans[i - 1][1] > s) problems.push(`span が重なっている`);
  }
  // 分割で文字が落ちていないこと (区切りの空白以外はすべて残る)
  if (got.join(" ").replace(/\s+/g, "") !== text.replace(/\s+/g, "")) {
    problems.push("文字が欠落または重複している");
  }

  const ok = problems.length === 0 && JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}`);
    if (problems.length) console.log(`      ${problems.join(" / ")}`);
    console.log(`      got:  ${JSON.stringify(got)}`);
    console.log(`      want: ${JSON.stringify(want)}`);
  }
}

console.log("[文分割] 基本");
expect(
  "素の 2 文",
  "MSCs were isolated from bone. The yield was high.",
  ["MSCs were isolated from bone.", "The yield was high."],
);
expect(
  "終止符なしの末尾",
  "The mechanism remains unclear",
  ["The mechanism remains unclear"],
);
expect("空文字列", "", []);
expect(
  "疑問符・感嘆符",
  "Does BMAX retain the niche? We think so. Remarkable!",
  ["Does BMAX retain the niche?", "We think so.", "Remarkable!"],
);

console.log("\n[文分割] 略語 — 分割してはいけない");
expect(
  "Fig.",
  "Viability exceeded 90% (Fig. 2A). This was consistent.",
  ["Viability exceeded 90% (Fig. 2A).", "This was consistent."],
);
expect(
  "et al.",
  "Huard et al. reported a similar yield. We confirmed it.",
  ["Huard et al. reported a similar yield.", "We confirmed it."],
);
expect(
  "e.g. / i.e.",
  "Markers (e.g. CD73, CD90) were positive, i.e. the phenotype was retained.",
  ["Markers (e.g. CD73, CD90) were positive, i.e. the phenotype was retained."],
);
expect(
  "vs.",
  "BMAX vs. PBS showed a difference. The effect persisted.",
  ["BMAX vs. PBS showed a difference.", "The effect persisted."],
);
expect(
  "approx.",
  "Cells were seeded at approx. 5000 per well. Medium was changed daily.",
  ["Cells were seeded at approx. 5000 per well.", "Medium was changed daily."],
);
expect(
  "No. / Inc.",
  "Kit No. 4 (Miltenyi Inc. Germany) was used. Staining followed.",
  ["Kit No. 4 (Miltenyi Inc. Germany) was used.", "Staining followed."],
);
expect(
  "投与経路 i.p.",
  "Mice received 100 µL i.p. daily. Behavior was scored weekly.",
  ["Mice received 100 µL i.p. daily.", "Behavior was scored weekly."],
);
expect(
  "U.S.",
  "Reagents were sourced in the U.S. Samples were shipped on dry ice.",
  ["Reagents were sourced in the U.S. Samples were shipped on dry ice."],
);

console.log("\n[文分割] 括弧の内側 — 分割してはいけない");
expect(
  "試薬の出所表記 (実データで割れた形)",
  "Cells were stained (BD Biosciences, San Jose, CA, USA. Stem Flow Cat.# 562245) [9]. Gates were set on FSC/SSC.",
  [
    "Cells were stained (BD Biosciences, San Jose, CA, USA. Stem Flow Cat.# 562245) [9].",
    "Gates were set on FSC/SSC.",
  ],
);
expect(
  "閉じていない括弧は無視する (以降が 1 文に潰れない)",
  "The device (see Methods was used. Cells were washed.",
  ["The device (see Methods was used.", "Cells were washed."],
);

console.log("\n[文分割] 数値 — 分割してはいけない");
expect(
  "小数",
  "The score improved (p = 0.0020). Histology agreed.",
  ["The score improved (p = 0.0020).", "Histology agreed."],
);
expect(
  "小数のみの文",
  "Mean OARSI score was 12.4 at 4 weeks and 8.1 at 8 weeks.",
  ["Mean OARSI score was 12.4 at 4 weeks and 8.1 at 8 weeks."],
);
expect(
  "バージョン番号",
  "Analyses used Prism 9.5.1. Significance was set at 0.05.",
  ["Analyses used Prism 9.5.1.", "Significance was set at 0.05."],
);

console.log("\n[文分割] 単一大文字 — イニシャルと単位の切り分け");
expect(
  "イニシャル (分割しない)",
  "We thank J. Huard for the reagents.",
  ["We thank J. Huard for the reagents."],
);
expect(
  "イニシャル連続 (分割しない)",
  "Conceptualization, J. K. Huard and R. Smith.",
  ["Conceptualization, J. K. Huard and R. Smith."],
);
expect(
  "度記号つき温度 (分割する)",
  "Cells were incubated at 37 °C. Medium was replaced every 48 h.",
  ["Cells were incubated at 37 °C.", "Medium was replaced every 48 h."],
);
expect(
  "度記号なし温度 — 直前が数値なので分割する",
  "Samples were stored at 4 C. Thawing was rapid.",
  ["Samples were stored at 4 C.", "Thawing was rapid."],
);
expect(
  "群ラベル + 文頭語 (分割する)",
  "Mice were assigned to group A. The remaining mice formed group B.",
  ["Mice were assigned to group A.", "The remaining mice formed group B."],
);

console.log("\n[文分割] Methods の頻出パターン");
expect(
  "min. は辞書に入れない (実際に文末に来る)",
  "Sections were incubated for 30 min. Cells were then washed twice.",
  ["Sections were incubated for 30 min.", "Cells were then washed twice."],
);
expect(
  "濃度・容量",
  "Medium contained 10% FBS and 1% P/S. Cultures reached 80% confluence.",
  ["Medium contained 10% FBS and 1% P/S.", "Cultures reached 80% confluence."],
);
expect(
  "引用符の外に出る終止符",
  'The authors called it "speculative." We agree with that reading.',
  ['The authors called it "speculative."', "We agree with that reading."],
);
expect(
  "文中の xref 表記",
  "OA affects 500 million people [1,2,3]. Treatment remains palliative.",
  ["OA affects 500 million people [1,2,3].", "Treatment remains palliative."],
);

console.log("\n[文分割] citations (PMC の上付き引用)");
{
  // "…2.2%.1,2 These…" — ピリオドの後に引用番号が張り付く形 (実データで 4 文が融合した)。
  // 文言は合成。実データは再配布不可の論文なので、**再現すべき形だけを写して
  // 中身は写さない** — 検証したいのは引用の張り付き方であって文言ではない。
  const t =
    "The incidence ranges between 0.6–2.2%.1,2 The effect was observed in both groups.3,4 The mechanism is unclear.5–7 Further study is needed.";
  const cite = (s: string) => {
    const i = t.indexOf(s);
    return [i, i + s.length] as [number, number];
  };
  expect(
    "終止符に張り付いた引用を跨いで分割する",
    t,
    [
      "The incidence ranges between 0.6–2.2%.1,2",
      "The effect was observed in both groups.3,4",
      "The mechanism is unclear.5–7",
      "Further study is needed.",
    ],
    [],
    [cite("1,"), [cite("1,")[0] + 2, cite("1,")[0] + 3], cite("3,"), [cite("3,")[0] + 2, cite("3,")[0] + 3], cite("5–7")],
  );
  // 引用として渡さなければ融合したまま — mark に頼っている証拠
  expect(
    "引用の位置を渡さなければ跨がない (数字を推測で飛ばさない)",
    t,
    [t],
  );
}
expect(
  "小数を引用と誤認しない",
  "The value was 2.5. Results followed.",
  ["The value was 2.5.", "Results followed."],
);

console.log("\n[文分割] hardBreaks (箇条書き)");
{
  const t = "Inclusion criteria were: age over 40 years radiographic KL grade 2 or 3 no prior surgery";
  expect(
    "終止符のない項目を強制分割",
    t,
    ["Inclusion criteria were: age over 40 years", "radiographic KL grade 2 or 3", "no prior surgery"],
    [t.indexOf("radiographic"), t.indexOf("no prior")],
  );
}

console.log("\n" + "=".repeat(70));
console.log(failures === 0 ? "文分割テスト 全通過" : `文分割テスト ${failures} 件の失敗`);
process.exit(failures === 0 ? 0 : 1);
