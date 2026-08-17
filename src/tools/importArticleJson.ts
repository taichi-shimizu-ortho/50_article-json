#!/usr/bin/env -S npx tsx
/**
 * 別スクリプトが作った論文 JSON を、このツールの入力形式に取り込む。
 *
 *   npm run import-json path/to/Dominici2006-6.json
 *   npm run import-json path/to/x.json --dry-run
 *
 * ## なぜ JSON から JSON を作らないか
 *
 * **最小 JATS を組み立てて `npm run build` に渡す。** 直接 Article を作ると、
 * 文分割・span 計算・セクション種別の分類・id の採番・派生値の引き継ぎを
 * すべて書き直すことになる (`parseJats` は 800 行ある)。XML を 1 枚作れば
 * 既存の経路がそのまま使えて、出力も他の論文と完全に同じ形になる。
 *
 * ## 置き場所は data/private/
 *
 * 取り込む JSON は出版社サイト由来で、再配布可否が確認できない。
 * `data/private/raw/` に置けば `buildJson` の `rootForInput()` が
 * private 側と判定し、本文 JSON も `data/private/articles/` に出る。
 * 目録の判定 (`npm run corpus -- --update`) でもライセンス表記が無いため
 * `redistributable: false` になる (default deny)。
 *
 * ## 入力に期待する形
 *
 * `{ title, authors: string[], journal, year, doi, sourceUrl,
 *    sections: [{ title, type, paragraphs: string[], subsections }] }`
 *
 * `type: "abstract"` のセクションは front の <abstract> に、それ以外は
 * <body> の <sec> に入れる。段落は素のテキストで、xref の情報は持たない。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { slugFromDoi } from "../ingest/parseJats.js";
import { dirFor, PRIVATE_ROOT } from "../paths.js";

interface InputSection {
  title?: string;
  type?: string;
  content?: string;
  paragraphs?: string[];
  subsections?: InputSection[];
}

interface Input {
  id?: string;
  sourceUrl?: string;
  title?: string;
  authors?: string[];
  journal?: string;
  year?: string;
  doi?: string;
  sections?: InputSection[];
}

interface Args {
  file: string;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { file: "", dryRun: false, force: false };
  for (const a of argv) {
    if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--force" || a === "-f") args.force = true;
    else if (a.startsWith("-")) throw new Error(`不明なオプション: ${a}`);
    else if (!args.file) args.file = a;
    else throw new Error(`入力は 1 つだけ指定してください: ${a}`);
  }
  if (!args.file) throw new Error("取り込む JSON のパスを指定してください");
  return args;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * "M. Dominici" / "K. Le Blanc" / "F.C Marini" を姓と名に割る。
 *
 * **先頭のイニシャルだけを given-names とみなし、残りを姓にする。**
 * 末尾の 1 語を姓と決め打ちすると "Le Blanc" が "Blanc" になる。
 * ビューアのプルダウンは姓を使うので、ここを間違えると表示名が崩れる。
 */
function splitName(full: string): { surname: string; given?: string } {
  const parts = full.trim().split(/\s+/);
  const initials: string[] = [];
  while (parts.length > 1 && /^[A-Z](\.[A-Z]?)*\.?$/.test(parts[0])) initials.push(parts.shift()!);
  return { surname: parts.join(" ") || full, given: initials.join(" ") || undefined };
}

/** 段落を <p> にする。空行と、抽出時に残った制御文字は落とす。 */
function paragraphs(list: string[] | undefined): string[] {
  return (list ?? [])
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0)
    .map((p) => `      <p>${esc(p)}</p>`);
}

function sectionXml(s: InputSection, depth = 3): string {
  const pad = "  ".repeat(depth);
  const title = s.title ? `${pad}  <title>${esc(s.title)}</title>\n` : "";
  // sec-type は分類のヒントとして渡す。最終的な種別は classifySection が決める。
  const type = s.type && s.type !== "other" ? ` sec-type="${esc(s.type)}"` : "";
  const body = paragraphs(s.paragraphs).join("\n");
  const subs = (s.subsections ?? []).map((x) => sectionXml(x, depth + 1)).join("\n");
  return `${pad}<sec${type}>\n${title}${body}${subs ? "\n" + subs : ""}\n${pad}</sec>`;
}

function toJats(input: Input): string {
  const all = input.sections ?? [];
  const abstracts = all.filter((s) => s.type === "abstract" || /^abstract$/i.test(s.title ?? ""));
  const body = all.filter((s) => !abstracts.includes(s));

  const authors = (input.authors ?? []).map((a) => {
    const { surname, given } = splitName(a);
    return (
      `        <contrib contrib-type="author"><name>` +
      `<surname>${esc(surname)}</surname>` +
      (given ? `<given-names>${esc(given)}</given-names>` : "") +
      `</name></contrib>`
    );
  });

  const abstractXml = abstracts
    .map((s) => `      <abstract>\n${paragraphs(s.paragraphs).join("\n")}\n      </abstract>`)
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<article xmlns:xlink="http://www.w3.org/1999/xlink" article-type="research-article">`,
    `  <front>`,
    `    <journal-meta>`,
    `      <journal-title-group><journal-title>${esc(input.journal ?? "")}</journal-title></journal-title-group>`,
    `    </journal-meta>`,
    `    <article-meta>`,
    input.doi ? `      <article-id pub-id-type="doi">${esc(input.doi)}</article-id>` : "",
    `      <title-group><article-title>${esc(input.title ?? "")}</article-title></title-group>`,
    authors.length ? `      <contrib-group>\n${authors.join("\n")}\n      </contrib-group>` : "",
    input.year ? `      <pub-date pub-type="ppub"><year>${esc(input.year)}</year></pub-date>` : "",
    // 出所を残す。取り込み元をたどれないと、後から真偽を確かめられない。
    input.sourceUrl ? `      <self-uri xlink:href="${esc(input.sourceUrl)}"/>` : "",
    abstractXml,
    `    </article-meta>`,
    `  </front>`,
    `  <body>`,
    body.map((s) => sectionXml(s)).join("\n"),
    `  </body>`,
    `</article>`,
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(args.file);
  if (!existsSync(path)) throw new Error(`見つかりません: ${args.file}`);

  const input = JSON.parse(readFileSync(path, "utf8")) as Input;
  if (!input.sections?.length) throw new Error("sections がありません。取り込める形式ではありません。");

  const xml = toJats(input);
  const slug = input.doi ? slugFromDoi(input.doi, input.id ?? basename(path, ".json")) : (input.id ?? basename(path, ".json"));
  const dest = join(dirFor(PRIVATE_ROOT, "raw"), `${slug}.xml`);

  const counts = {
    セクション: input.sections.length,
    段落: input.sections.reduce((n, s) => n + (s.paragraphs?.length ?? 0), 0),
    著者: input.authors?.length ?? 0,
  };
  console.log(`入力  ${args.file}`);
  console.log(`      ${input.title ?? "(タイトルなし)"}`);
  console.log(`      ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" / ")}`);
  console.log(`保存先 ${dest}`);

  if (args.dryRun) {
    console.log(`\n--dry-run: 保存していません。生成される XML の先頭:\n`);
    console.log(xml.split("\n").slice(0, 24).join("\n"));
    return;
  }
  if (!args.force && existsSync(dest)) throw new Error(`既にあります: ${dest} (上書きは --force)`);

  mkdirSync(dirFor(PRIVATE_ROOT, "raw"), { recursive: true });
  writeFileSync(dest, xml, "utf8");
  console.log(`\n保存しました (${Math.round(xml.length / 1024)} KB)`);
  console.log(`次: npm run build -- ${dest.replace(/\\/g, "/")}`);
}

try {
  main();
} catch (e) {
  console.error(`失敗: ${(e as Error).message}`);
  process.exitCode = 1;
}
