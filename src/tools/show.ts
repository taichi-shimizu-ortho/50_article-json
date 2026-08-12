#!/usr/bin/env -S npx tsx
/**
 * enrich 済み JSON を端末で読む。
 *
 *   npm run show                            段落サマリー (既定)
 *   npm run show -- --plain                 plain だけを縦に並べる (通し読み用)
 *   npm run show -- --section discussion    セクション種別で絞る
 *   npm run show -- --role limitation       段落の役割で絞る
 *   npm run show -- --sentences             文単位の certainty 表示
 *   npm run show -- --sentences -p s4-p5    段落を指定
 *
 * 文表示では hedge を «...» で囲む。これは装飾ではなく検算で、span がずれて
 * いれば «may» が «ay c» のようにずれて見える。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { Article, Certainty, Paragraph, Section } from "../types.js";
import { readDirs } from "../paths.js";



const LABEL: Record<Certainty, string> = {
  measured: "measured   ",
  supported: "supported  ",
  hedged: "hedged     ",
  speculative: "speculative",
};

interface Args {
  inputs: string[];
  section?: string;
  role?: string;
  certainty?: string;
  paragraph?: string;
  sentences: boolean;
  plainOnly: boolean;
  statsOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { inputs: [], sentences: false, plainOnly: false, statsOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--section" || a === "-s") args.section = argv[++i];
    else if (a === "--role" || a === "-r") args.role = argv[++i];
    else if (a === "--certainty" || a === "-c") args.certainty = argv[++i];
    else if (a === "--paragraph" || a === "-p") args.paragraph = argv[++i];
    else if (a === "--sentences") args.sentences = true;
    else if (a === "--plain") args.plainOnly = true;
    else if (a === "--stats") args.statsOnly = true;
    else if (a.startsWith("-")) {
      console.error(`不明なオプション: ${a}`);
      process.exit(1);
    } else args.inputs.push(a);
  }
  // 公開側と非公開側の両方を読む (再配布不可の論文は data/private/ にある)
  if (args.inputs.length === 0) args.inputs.push(...readDirs("articles"));
  return args;
}

function collectJson(input: string): string[] {
  const p = resolve(input);
  if (!existsSync(p)) throw new Error(`見つかりません: ${input}`);
  if (statSync(p).isFile()) return [p];
  return readdirSync(p)
    .filter((f) => extname(f) === ".json")
    .map((f) => join(p, f))
    .sort();
}

/** hedge span を «» で括る。後ろから入れないとオフセットがずれる。 */
function markHedges(text: string, span: [number, number], hedges: Array<[number, number]>): string {
  let out = text.slice(...span);
  const rel = hedges
    .map(([a, b]) => [a - span[0], b - span[0]] as [number, number])
    .sort((x, y) => y[0] - x[0]);
  for (const [a, b] of rel) {
    if (a < 0 || b > out.length || a >= b) continue;
    out = out.slice(0, a) + "«" + out.slice(a, b) + "»" + out.slice(b);
  }
  return out;
}

/**
 * 折り返し。全角は 2 幅として数える。
 *
 * 語の途中では折らない。文字単位で折ると英語が "inje / ction" と割れて
 * 読めなくなる (原文も要約も英語になったので、これは常時起きる)。
 * 折り返し位置の候補は空白と、日本語の直前・直後 — 日本語には語間空白が
 * 無いので、そこは文字単位で折ってよい。
 */
const WIDE = /[　-鿿＀-｠]/;

function wrap(s: string, width: number, indent: string): string {
  const lines: string[] = [];
  let cur = "";
  let w = 0;
  // 空白で切るが、区切り文字も保持する (連続空白を潰さない)
  for (const token of s.split(/(\s+)/)) {
    if (token === "") continue;
    const chunks = WIDE.test(token) ? [...token] : [token];
    for (const c of chunks) {
      const cw = [...c].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);
      if (w + cw > width && cur !== "") {
        lines.push(cur.trimEnd());
        cur = "";
        w = 0;
        if (/^\s+$/.test(c)) continue; // 行頭に空白を持ち越さない
      }
      cur += c;
      w += cw;
    }
  }
  if (cur.trim() !== "") lines.push(cur.trimEnd());
  return lines.map((l) => indent + l).join("\n");
}

function header(article: Article): void {
  console.log(`\n${"=".repeat(78)}`);
  console.log(article.id);
  const recs = Object.values(article.enrich ?? {});
  if (recs.length === 0) console.log("(enrich 未実行)");
  for (const e of recs) {
    console.log(
      `  ${e.pass.padEnd(9)} ${e.model} / ${e.promptVersion} / ${e.enrichedAt.slice(0, 19)}` +
        ` — ${e.applied} 件 (キャッシュ ${e.cached})`,
    );
    for (const w of e.warnings) console.log(`    ! ${w}`);
  }
  console.log("=".repeat(78));
}

/** 段落サマリー表示 */
function showParagraphs(article: Article, args: Args): void {
  const roles = new Map<string, number>();
  let total = 0;
  let shown = 0;

  const visit = (s: Section, p: Paragraph) => {
    if (!p.gist && !p.plain) return;
    total++;
    roles.set(p.role ?? "?", (roles.get(p.role ?? "?") ?? 0) + 1);
    if (args.section && s.type !== args.section) return;
    if (args.role && p.role !== args.role) return;
    if (args.paragraph && p.id !== args.paragraph) return;
    if (args.statsOnly) return;
    shown++;

    if (args.plainOnly) {
      console.log(wrap(p.plain ?? "", 76, ""));
      console.log("");
      return;
    }
    console.log(`\n${p.id}  [${s.type}] ${p.role ?? "?"}  ${s.title ?? ""}`);
    if (p.gist) console.log(wrap(p.gist, 74, "  "));
    if (p.plain) console.log(wrap(p.plain, 74, "  │ "));
  };

  walkArticle(article, visit);

  if (total === 0) {
    console.log("\n段落サマリーがありません。npm run enrich を先に実行してください。");
    return;
  }
  if (!args.plainOnly) {
    console.log(`\n--- role の分布 (${total} 段落) ---`);
    for (const [r, n] of [...roles].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${r.padEnd(14)} ${String(n).padStart(3)}  ${"█".repeat(n)}`);
    }
  }
  if (shown === 0 && !args.statsOnly) console.log("(絞り込みに一致する段落なし)");
}

/** 文単位 certainty 表示 */
function showSentences(article: Article, args: Args): void {
  const counts = new Map<string, number>();
  let enrichedTotal = 0;
  let shown = 0;

  const visit = (s: Section, p: Paragraph) => {
    const rows = p.sentences.filter((x) => x.certainty);
    enrichedTotal += rows.length;
    if (args.section && s.type !== args.section) return;
    if (args.paragraph && p.id !== args.paragraph) return;
    if (rows.length === 0) return;

    for (const x of rows) counts.set(x.certainty!, (counts.get(x.certainty!) ?? 0) + 1);
    if (args.statsOnly) return;

    const filtered = args.certainty ? rows.filter((x) => x.certainty === args.certainty) : rows;
    if (filtered.length === 0) return;
    shown++;

    console.log(`\n${p.id}  [${s.type}] ${s.title ?? ""}`);
    for (const x of filtered) {
      console.log(`  ${LABEL[x.certainty!]} | ${markHedges(p.text, x.span, x.hedges ?? [])}`);
      for (const st of x.stats ?? []) {
        const bits = [
          st.metric,
          st.value !== undefined ? String(st.value) : undefined,
          st.unit,
          st.p !== undefined ? `p=${st.p}` : undefined,
          st.n !== undefined ? `n=${st.n}` : undefined,
          st.comparison,
        ].filter(Boolean);
        const quoted = st.span ? p.text.slice(...st.span) : "";
        console.log(`              └ stat ${bits.join(" ")}  ← ${JSON.stringify(quoted)}`);
      }
    }
  };

  walkArticle(article, visit);

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (enrichedTotal === 0) {
    console.log("\n判定のある文がありません。npm run enrich -- --pass sentence を実行してください。");
    return;
  }
  if (total === 0) {
    console.log(
      `\n絞り込みに一致する文がありません (判定済みは ${enrichedTotal} 文)。` +
        `\nこの論文の Limitations は独立セクションではなく Discussion の一段落 (s4-p5) です。`,
    );
    return;
  }
  console.log(`\n--- certainty の分布 (${total} 文) ---`);
  for (const key of ["measured", "supported", "hedged", "speculative"] as Certainty[]) {
    const n = counts.get(key) ?? 0;
    console.log(
      `  ${LABEL[key]} ${String(n).padStart(4)}  ${"█".repeat(Math.round((n / total) * 50))}`,
    );
  }
  if (shown === 0 && !args.statsOnly) console.log("(絞り込みに一致する段落なし)");
}

function walkArticle(article: Article, visit: (s: Section, p: Paragraph) => void): void {
  const walk = (sections: Section[]) => {
    for (const s of sections) {
      for (const p of s.paragraphs) visit(s, p);
      walk(s.sections);
    }
  };
  walk(article.abstract);
  walk(article.sections);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  for (const file of args.inputs.flatMap(collectJson)) {
    const article = JSON.parse(readFileSync(file, "utf8")) as Article;
    if (!args.plainOnly) header(article);
    if (args.sentences) showSentences(article, args);
    else showParagraphs(article, args);
  }
}

main();
