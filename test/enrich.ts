/**
 * enrich のテスト。**API は叩かない。**
 *
 * 検証するのは「LLM を呼ぶ前後で壊れないこと」— バッチ分割、キャッシュ、
 * 逐語引用から span への変換、捏造された引用の棄却、記事へのマージ。
 * プロンプトの中身の良し悪しは実行結果を見ながら詰めるしかないが、
 * その周りの配管はキーなしで固められる。
 */
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parseJats, flattenParagraphs } from "../src/ingest/parseJats.js";
import { EnrichCache } from "../src/enrich/cache.js";
import {
  PROMPT_VERSION,
  SENTENCE_SECTIONS,
  buildUserMessage,
  parseResponse,
  sentencePass,
} from "../src/enrich/passes/sentence.js";
import { paragraphPass } from "../src/enrich/passes/paragraph.js";
import { batchUnits, collectUnits } from "../src/enrich/units.js";
import { enrichArticle } from "../src/enrich/runEnrich.js";
import type { Article } from "../src/types.js";

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const MODEL = "test-model";
const fresh = (): Article =>
  parseJats(readFileSync(new URL("./fixture.jats.xml", import.meta.url), "utf8"));

/* --- 1. 入力単位 --- */
console.log("[1] enrich の入力単位");
{
  const article = fresh();
  const units = collectUnits(article, MODEL, PROMPT_VERSION, SENTENCE_SECTIONS);
  const paras = [...flattenParagraphs(article.abstract), ...flattenParagraphs(article.sections)];

  check("段落単位で作られる", units.length > 0);
  check(
    "back matter (funding / conflicts) を含まない",
    units.every((u) => !u.paragraphId.startsWith("b")),
    units.map((u) => u.paragraphId).filter((id) => id.startsWith("b")).join(","),
  );
  check(
    "既定では Methods を含まない",
    units.every((u) => u.sectionType !== "methods"),
    units.filter((u) => u.sectionType === "methods").map((u) => u.paragraphId).join(","),
  );
  {
    const withMethods = collectUnits(
      article,
      MODEL,
      PROMPT_VERSION,
      new Set([...SENTENCE_SECTIONS, "methods" as const]),
    );
    check(
      "--with-methods 相当で Methods が戻る",
      withMethods.some((u) => u.sectionType === "methods") &&
        withMethods.length > units.length,
    );
    check(
      "対象を広げても既存段落のキャッシュキーは変わらない",
      units.every(
        (u) => withMethods.find((w) => w.paragraphId === u.paragraphId)?.cacheKey === u.cacheKey,
      ),
    );
  }
  check(
    "対象段落の文がすべて含まれる",
    units.every((u) => {
      const p = paras.find((x) => x.id === u.paragraphId)!;
      return u.sentences.length === p.sentences.length;
    }),
  );

  // キャッシュキーは内容ハッシュ。id が変わっても同じでなければならない。
  const shifted = collectUnits(article, MODEL, PROMPT_VERSION, SENTENCE_SECTIONS);
  check(
    "同じ内容なら同じキャッシュキー",
    units[0].cacheKey === shifted[0].cacheKey,
  );
  check(
    "モデルが変わるとキャッシュキーも変わる",
    collectUnits(article, "other-model", PROMPT_VERSION, SENTENCE_SECTIONS)[0].cacheKey !== units[0].cacheKey,
  );
  check(
    "プロンプト版が変わるとキャッシュキーも変わる",
    collectUnits(article, MODEL, "certainty-999", SENTENCE_SECTIONS)[0].cacheKey !== units[0].cacheKey,
  );

  const batches = batchUnits(units, 10);
  check(
    "バッチが段落を分割しない",
    batches.flat().length === units.length &&
      batches.every((b) => b.every((u) => units.includes(u))),
  );
  check(
    "1 段落が上限を超えていても単独で 1 バッチになる",
    batchUnits(units, 1).length === units.length,
  );
  check(
    "ユーザーメッセージに文 id と段落文脈が入る",
    (() => {
      const msg = buildUserMessage([units[0]]);
      return msg.includes(units[0].text) && units[0].sentences.every((s) => msg.includes(`[${s.id}]`));
    })(),
  );
}

/* --- 2. 応答の検証 (逐語引用 → span) --- */
console.log("\n[2] 応答の検証 — LLM のオフセットを信用しない");
{
  const article = fresh();
  const units = collectUnits(article, MODEL, PROMPT_VERSION, SENTENCE_SECTIONS);
  const unit = units.find((u) => u.sentences.length >= 2)!;
  const s0 = unit.sentences[0];
  const sentText = unit.text.slice(...s0.span);
  const word = sentText.split(" ").slice(1, 3).join(" "); // 文中に実在する語

  const parsed = parseResponse(
    {
      sentences: [
        { id: s0.id, certainty: "hedged", hedges: [word], stats: [] },
        ...unit.sentences.slice(1).map((s) => ({
          id: s.id,
          certainty: "supported",
          hedges: [],
          stats: [],
        })),
      ],
    },
    [unit],
  );
  const row = parsed.byParagraph.get(unit.paragraphId)!.find((r) => r.id === s0.id)!;

  check("certainty が取り込まれる", row.certainty === "hedged");
  check(
    "逐語引用が span に変換される",
    unit.text.slice(...row.hedges[0]) === word,
    JSON.stringify(unit.text.slice(...row.hedges[0])),
  );
  check(
    "hedge span が文の内側に収まる",
    row.hedges[0][0] >= s0.span[0] && row.hedges[0][1] <= s0.span[1],
  );
  check("欠けがなければ警告なし", parsed.warnings.length === 0, parsed.warnings.join(" / "));
}

/* --- 3. 不正な応答を弾く --- */
console.log("\n[3] 不正な応答の棄却");
{
  const article = fresh();
  const unit = collectUnits(article, MODEL, PROMPT_VERSION, SENTENCE_SECTIONS)[0];
  const ids = unit.sentences.map((s) => s.id);

  const bad = parseResponse(
    {
      sentences: [
        // 原文にない hedge (捏造)
        { id: ids[0], certainty: "hedged", hedges: ["it is widely believed that"], stats: [] },
        // 未知のラベル
        { id: ids[1] ?? "nope", certainty: "probably", hedges: [], stats: [] },
        // 未知の文 id
        { id: "s99-p99-s1", certainty: "measured", hedges: [], stats: [] },
        // 重複
        { id: ids[0], certainty: "measured", hedges: [], stats: [] },
      ],
    },
    [unit],
  );
  const rows = bad.byParagraph.get(unit.paragraphId) ?? [];

  check(
    "原文にない hedge を落とす",
    rows[0]?.hedges.length === 0 && bad.warnings.some((w) => w.includes("見つかりません")),
  );
  check("未知のラベルを落とす", bad.warnings.some((w) => w.includes("未知の certainty")));
  check("未知の文 id を落とす", bad.warnings.some((w) => w.includes("未知の文 id")));
  check("重複した判定を無視する", bad.warnings.some((w) => w.includes("重複")));
  check(
    "文数が足りなければ警告する",
    bad.warnings.some((w) => w.includes("しか返りませんでした")),
  );
  check(
    "sentences 配列がない応答",
    parseResponse({ oops: true }, [unit]).warnings.length === 1,
  );
}

/* --- 4. 記事へのマージとキャッシュ (モックの caller で通す) --- */
console.log("\n[4] マージとキャッシュ — モックで一巡させる");
{
  const cacheDir = mkdtempSync(join(tmpdir(), "enrich-cache-"));
  const cache = new EnrichCache(cacheDir, "sentence");

  let calls = 0;
  const caller = async (units: any[]) => {
    calls++;
    return {
      sentences: units.flatMap((u: any) =>
        u.sentences.map((s: any, i: number) => {
          const text = u.text.slice(...s.span);
          const may = text.includes("may") ? ["may"] : [];
          return {
            id: s.id,
            certainty: i === 0 ? "measured" : may.length ? "hedged" : "supported",
            hedges: may,
            stats: [],
          };
        }),
      ),
    };
  };

  const article = fresh();
  const stats = await enrichArticle(article, {
    pass: sentencePass,
    model: MODEL,
    caller,
    cache,
    batchSentences: 10,
  });

  const paras = [...flattenParagraphs(article.abstract), ...flattenParagraphs(article.sections)];
  const enriched = paras.flatMap((p) => p.sentences).filter((s) => s.certainty);

  check("全対象文に certainty が付く", enriched.length === stats.applied && stats.applied > 0);
  check("API を叩いた回数が記録される", stats.requests === calls && calls > 0);
  check("キャッシュファイルが書かれる", readdirSync(join(cacheDir, "sentence")).length > 0);
  check("警告なしで通る", stats.warnings.length === 0, stats.warnings.join(" / "));
  check(
    "hedge span が原文と一致する",
    paras.every((p) =>
      (p.sentences ?? []).every((s) =>
        (s.hedges ?? []).every(([a, b]) => p.text.slice(a, b) === "may"),
      ),
    ),
  );
  check(
    "back matter には certainty が付かない",
    paras
      .filter((p) => p.id.startsWith("b"))
      .every((p) => p.sentences.every((s) => s.certainty === undefined)),
  );
  {
    // Methods 段落 id をセクション木から引く (id の形に依存しないように)
    const methodsIds = new Set<string>();
    const walk = (ss: typeof article.sections) => {
      for (const s of ss) {
        if (s.type === "methods") for (const p of s.paragraphs) methodsIds.add(p.id);
        walk(s.sections);
      }
    };
    walk(article.sections);
    check(
      "Methods にも certainty が付かない",
      methodsIds.size > 0 &&
        paras
          .filter((p) => methodsIds.has(p.id))
          .every((p) => p.sentences.every((s) => s.certainty === undefined)),
      `${methodsIds.size} 段落`,
    );
  }
  check(
    "enrich メタデータが残る",
    article.enrich?.sentence?.model === MODEL &&
      article.enrich?.sentence?.promptVersion === PROMPT_VERSION,
  );

  // 2 回目: 同じ内容なら API を 1 回も叩かない
  const callsBefore = calls;
  const again = fresh();
  const stats2 = await enrichArticle(again, {
    pass: sentencePass,
    model: MODEL,
    caller,
    cache,
    batchSentences: 10,
  });
  check("2 回目はキャッシュだけで済む", calls === callsBefore && stats2.requests === 0);
  check("キャッシュ経由でも段落数が一致する", stats2.cached > 0 && stats2.applied === stats.applied);
  check(
    "キャッシュから復元した span も原文と一致する",
    [...flattenParagraphs(again.abstract), ...flattenParagraphs(again.sections)].every((p) =>
      p.sentences.every((s) => (s.hedges ?? []).every(([a, b]) => p.text.slice(a, b) === "may")),
    ),
  );

  // --force はキャッシュを読まない
  const forced = fresh();
  const stats3 = await enrichArticle(forced, {
    pass: sentencePass,
    model: MODEL,
    caller,
    cache,
    batchSentences: 10,
    force: true,
  });
  check("--force はキャッシュを無視する", stats3.requests > 0 && stats3.cached === 0);
}

/* --- 5. 欠けた応答はキャッシュしない --- */
console.log("\n[5] 欠けた応答をキャッシュに残さない");
{
  const cacheDir = mkdtempSync(join(tmpdir(), "enrich-partial-"));
  const cache = new EnrichCache(cacheDir, "sentence");
  // 各段落の最初の 1 文しか返さない、壊れた caller
  const partial = async (units: any[]): Promise<unknown> => ({
    sentences: units.map((u) => ({
      id: u.sentences[0].id,
      certainty: "supported",
      hedges: [],
      stats: [],
    })),
  });

  const article = fresh();
  const stats = await enrichArticle(article, {
    pass: sentencePass,
    model: MODEL,
    caller: partial,
    cache,
    batchSentences: 10,
  });
  check("足りない応答は警告になる", stats.warnings.length > 0);
  // 1 文しかない段落は「1 文だけ返す」でも完全なので、そこだけは残ってよい
  const singles = collectUnits(fresh(), MODEL, PROMPT_VERSION, SENTENCE_SECTIONS).filter(
    (u) => u.sentences.length === 1,
  ).length;
  const written = readdirSync(join(cacheDir, "sentence")).length;
  check(
    "不完全な段落はキャッシュされない",
    written === singles,
    `${written} 件 / 1 文段落 ${singles} 件`,
  );
}

/* --- 6. 段落パス --- */
console.log("\n[6] 段落パス (role / gist / plain)");
{
  const PV = paragraphPass.promptVersion;
  const article = fresh();
  const units = collectUnits(article, MODEL, PV, paragraphPass.defaultSections);

  check(
    "Methods を含む (文パスと逆)",
    units.some((u) => u.sectionType === "methods"),
  );
  check(
    "文パスとキャッシュキーが衝突しない",
    (() => {
      const sentUnits = collectUnits(article, MODEL, PROMPT_VERSION, SENTENCE_SECTIONS);
      const keys = new Set(sentUnits.map((u) => u.cacheKey));
      return units.every((u) => !keys.has(u.cacheKey));
    })(),
  );
  check(
    "ユーザーメッセージが文を列挙しない (段落本文だけ渡す)",
    (() => {
      const msg = paragraphPass.buildUserMessage([units[0]]);
      return msg.includes(units[0].text) && !msg.includes(`${units[0].paragraphId}-s1`);
    })(),
  );

  // --- 応答の検証 ---
  const u0 = units[0];
  const ok = paragraphPass.parse(
    {
      paragraphs: [{ id: u0.paragraphId, role: "background", gist: "A gist.", plain: "A summary." }],
    },
    [u0],
  );
  check("正常な応答を取り込む", ok.byParagraph.get(u0.paragraphId)?.role === "background");

  const bad = paragraphPass.parse(
    {
      paragraphs: [
        { id: u0.paragraphId, role: "nonsense", gist: "x", plain: "y" },
        { id: "s99-p99", role: "background", gist: "x", plain: "y" },
      ],
    },
    [u0],
  );
  check("未知の role を落とす", bad.warnings.some((w) => w.includes("未知の role")));
  check("未知の段落 id を落とす", bad.warnings.some((w) => w.includes("未知の段落 id")));
  check("返らなかった段落を警告する", bad.warnings.some((w) => w.includes("要約が返りませんでした")));

  const empty = paragraphPass.parse(
    { paragraphs: [{ id: u0.paragraphId, role: "background", gist: "", plain: "A summary." }] },
    [u0],
  );
  check("空の gist を落とす", empty.warnings.some((w) => w.includes("空です")));

  // --- hedge 脱落の検出 (このパスの中心的な検証) ---
  // 検査は merge にある (parse に置くとキャッシュ経由の段落を素通りするため)
  const hedged = units.find((u) => /\b(may|might|suggest|speculative)\b/i.test(u.text))!;
  const para = { id: hedged.paragraphId, text: hedged.text } as any;
  const checkPlain = (plain: string) => {
    const w: string[] = [];
    paragraphPass.merge(para, { role: "interpretation", gist: "g", plain }, w);
    return w;
  };

  check(
    "言い切った要約を警告する",
    checkPlain("This is the mechanism.").some((w) => w.includes("留保が見当たりません")),
  );
  check(
    "may を残していれば通す",
    checkPlain("The mechanism may contribute, but was not measured here.").length === 0,
  );
  check(
    "suggest / potential なども留保として通す",
    checkPlain("The data suggest a potential role for this pathway.").length === 0,
  );
  // 実データ (PMC3143999 s3-p1) で 2 回続けて誤検知した形
  check(
    "possible を留保として通す (実データの誤検知)",
    checkPlain("A CT-guided injection is a diagnostic test and possible treatment.").length === 0,
  );
  check(
    "根拠の範囲を断る言い方も通す",
    checkPlain("They recommend removal. These are recommendations based on a single case.").length === 0,
  );
  check(
    "原文に hedge がなければ検査しない",
    (() => {
      const flat = { id: "x", text: "The cement was removed surgically." } as any;
      const w: string[] = [];
      paragraphPass.merge(flat, { role: "result", gist: "g", plain: "It was removed." }, w);
      return w.length === 0;
    })(),
  );
  // 原文側の辞書は狭い。実データ (cells15141249) で potential は原文に 8 回
  // 出てすべて名詞だった ("therapeutic / differentiation / regenerative potential")。
  check(
    "原文の potential は名詞なので hedge と数えない",
    (() => {
      const noun = {
        id: "x",
        text: "In addition to their differentiation potential, MSCs exert paracrine effects.",
      } as any;
      const w: string[] = [];
      paragraphPass.merge(
        noun,
        { role: "background", gist: "g", plain: "MSCs both differentiate and signal." },
        w,
      );
      return w.length === 0;
    })(),
  );
  check(
    "手順の段落は検査しない (「スコア 0 は無反応を示す」は定義)",
    (() => {
      const methods = {
        id: "x",
        text: "A score of 0 indicates no response; pain may be scored up to 20.",
      } as any;
      const w: string[] = [];
      paragraphPass.merge(
        methods,
        { role: "method", gist: "g", plain: "Pain was scored from 0 to 20." },
        w,
      );
      return w.length === 0;
    })(),
  );
  // 要約側の辞書は広い。原文の語形をそのまま使わない言い換えを通すため。
  check(
    "言い換えた留保を通す (remains to be → still needed)",
    checkPlain("The finding is real but external validation is still needed.").length === 0,
  );
  check(
    "一般化の限界に触れていれば通す",
    checkPlain("One donor supplied both products, which limits generalizability.").length === 0,
  );

  // --- 一巡 ---
  const cacheDir = mkdtempSync(join(tmpdir(), "enrich-para-"));
  const cache = new EnrichCache(cacheDir, paragraphPass.name);
  let calls = 0;
  const caller = async (us: any[]) => {
    calls++;
    return {
      paragraphs: us.map((u: any) => ({
        id: u.paragraphId,
        role: "background",
        gist: `gist of ${u.paragraphId}`,
        plain: "This may be the case.",
      })),
    };
  };

  const art = fresh();
  const stats = await enrichArticle(art, {
    pass: paragraphPass,
    model: MODEL,
    caller,
    cache,
    batchSentences: 40,
  });

  const paras = [...flattenParagraphs(art.abstract), ...flattenParagraphs(art.sections)];
  const summarized = paras.filter((p) => p.gist);
  check("段落に gist / plain / role が入る", summarized.length === stats.applied && stats.applied > 0);
  check(
    "gist が正しい段落に入る",
    summarized.every((p) => p.gist === `gist of ${p.id}`),
  );
  check(
    "back matter には入らない",
    paras.filter((p) => p.id.startsWith("b")).every((p) => !p.gist),
  );
  check("enrich 記録が paragraph キーに入る", art.enrich?.paragraph?.pass === "paragraph");
  check("文パスの記録を壊さない", art.enrich?.sentence === undefined);

  const before = calls;
  const again = fresh();
  const s2 = await enrichArticle(again, {
    pass: paragraphPass,
    model: MODEL,
    caller,
    cache,
    batchSentences: 40,
  });
  check("2 回目はキャッシュだけ", calls === before && s2.requests === 0 && s2.cached > 0);

  // 2 つのパスを続けて回しても記録が共存する
  const bothArt = fresh();
  await enrichArticle(bothArt, {
    pass: paragraphPass, model: MODEL, caller, cache, batchSentences: 40,
  });
  await enrichArticle(bothArt, {
    pass: sentencePass,
    model: MODEL,
    caller: async (us: any[]) => ({
      sentences: us.flatMap((u: any) =>
        u.sentences.map((s: any) => ({ id: s.id, certainty: "supported", hedges: [], stats: [] })),
      ),
    }),
    cache: new EnrichCache(cacheDir, sentencePass.name),
    batchSentences: 40,
  });
  check(
    "両パスの記録が共存する",
    bothArt.enrich?.paragraph?.pass === "paragraph" && bothArt.enrich?.sentence?.pass === "sentence",
  );
  const bothParas = [...flattenParagraphs(bothArt.abstract), ...flattenParagraphs(bothArt.sections)];
  check(
    "段落サマリーと文 certainty が同居する",
    bothParas.some((p) => p.gist && p.sentences.some((s) => s.certainty)),
  );
}

console.log("\n" + "=".repeat(70));
console.log(failures === 0 ? "enrich テスト 全通過" : `enrich テスト ${failures} 件の失敗`);
process.exit(failures === 0 ? 0 : 1);
