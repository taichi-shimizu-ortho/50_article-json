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
 * <body> の <sec> に入れる。
 *
 * ## 文献 (任意の 2 つめの入力)
 *
 * `{ records: [{ index, text, doi, pmid, pubmed: {...} }] }` を渡すと
 * <back><ref-list> を作り、本文の `[ 1 ]` `[ 4 , 5 ]` を xref に変える。
 * **どちらのファイルかは形で見分ける** (sections があれば本文、records が
 * あれば文献) ので、順番も --flag も要らない。
 *
 * ## Markdown のパイプ表は <table-wrap> にする
 *
 * 抽出元は表を Markdown (`| a | b |` + `| --- | --- |`) の**複数行文字列**として
 * 段落に入れてくる。これを <p> に潰すと改行が消えて行境界が永久に失われる
 * (`| |` が「行の継ぎ目」か「空セル」か区別できなくなる)。段落を <p> にする
 * **前に**表を検出し、<table-wrap> に変える。直前の段落が `Table N .` なら
 * label / caption として取り込み、本文中の `Table N` への言及は
 * `<xref ref-type="table">` にする (ビューアが表を参照段落の直後に置ける)。
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

/** 文献 1 件。PubMed が引けていれば pubmed に構造化された値が入る。 */
interface RefRecord {
  index: number;
  text?: string;
  doi?: string;
  pmid?: string;
  pubmed?: {
    title?: string;
    authors?: string[];
    journal?: string;
    year?: string;
    doi?: string;
    pmid?: string;
  };
}

interface RefInput {
  records?: RefRecord[];
}

interface Args {
  files: string[];
  dryRun: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { files: [], dryRun: false, force: false };
  for (const a of argv) {
    if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--force" || a === "-f") args.force = true;
    else if (a.startsWith("-")) throw new Error(`不明なオプション: ${a}`);
    else args.files.push(a);
  }
  if (args.files.length === 0) throw new Error("取り込む JSON のパスを指定してください");
  if (args.files.length > 2) throw new Error("入力は本文 JSON と文献 JSON の 2 つまでです");
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

const refId = (n: number) => `B${n}`;

/**
 * 本文の引用マーカーを xref に変える。
 *
 * 抽出元は `[ 1 ]` `[ 4 , 5 ]` のように**括弧の内側に空白を入れる**。
 * JATS 本来の形は `[1,2]` で括弧は本文に残り xref は数字だけを指すので、
 * 空白を詰めたうえで数字だけを xref にする (ビューアは原文の括弧を取り込む)。
 *
 * **文献表に無い番号は変換しない。** リンク先の無い xref を作ると、
 * 「引用はあるが飛べない」状態になり、原因が分からなくなる。
 */
function withXrefs(text: string, known: Set<number>): string {
  return text.replace(/\[[\s\d,;–—-]*\d[\s\d,;–—-]*\]/g, (marker) => {
    const inner = marker.slice(1, -1);
    // 数字と区切りを順に拾い直す。区切りは原文のものを残す (範囲の – も)。
    const parts = inner.match(/\d+|[,;–—-]/g) ?? [];
    if (!parts.some((p) => /^\d+$/.test(p) && known.has(Number(p)))) return marker;
    const body = parts
      .map((p) =>
        /^\d+$/.test(p) && known.has(Number(p))
          ? `<xref ref-type="bibr" rid="${refId(Number(p))}">${p}</xref>`
          : esc(p),
      )
      .join("");
    return `[${body}]`;
  });
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/* ------------------------------------------------------------------ *
 * Markdown のパイプ表
 * ------------------------------------------------------------------ */

interface MdTable {
  rows: string[][];
  /** 区切り行 (`| --- |`) より上の行数。markdown の意味論では見出し行。 */
  headerRows: number;
}

/**
 * Markdown のパイプ表を行列に読む。表でなければ null。
 *
 * 判定は保守的にする — **全行がパイプで囲まれ、区切り行がある**ものだけ。
 * 改行はここで使い切る (これより後の処理は空白を潰すので、行境界は
 * この時点でしか取れない)。
 */
function parseMdTable(text: string): MdTable | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  if (!lines.every((l) => l.startsWith("|") && l.endsWith("|"))) return null;

  const grid = lines.map((l) => l.slice(1, -1).split("|").map(collapse));
  const isSep = (r: string[]) => r.length > 0 && r.every((c) => /^:?-{2,}:?$/.test(c));
  const sepAt = grid.findIndex(isSep);
  if (sepAt < 0) return null;

  const rows = grid.filter((r) => !isSep(r));
  return rows.length > 0 ? { rows, headerRows: sepAt } : null;
}

/** 直前の段落を表のキャプションとみなせるか。"Table 1 . Summary of ..." */
const TABLE_CAPTION = /^Table\s+(\d+)\s*[.:]?\s*(.*)$/i;

/**
 * キャプション番号が取れた表の番号を、本文の xref 用に先に集める。
 * (段落を出力する時点で「その番号の表が存在するか」を知る必要がある)
 */
function collectTableNums(sections: InputSection[]): Set<number> {
  const nums = new Set<number>();
  const walk = (list: InputSection[]) => {
    for (const s of list) {
      const raw = (s.paragraphs ?? []).filter((p) => collapse(p).length > 0);
      for (let i = 1; i < raw.length; i++) {
        if (!parseMdTable(raw[i])) continue;
        const m = TABLE_CAPTION.exec(collapse(raw[i - 1]));
        if (m) nums.add(Number(m[1]));
      }
      walk(s.subsections ?? []);
    }
  };
  walk(sections);
  return nums;
}

/** 本文中の `Table N` への言及を xref にする (実在する表の番号だけ)。 */
function withTableXrefs(text: string, tableNums: Set<number>): string {
  if (tableNums.size === 0) return text;
  return text.replace(/\bTable\s+(\d+)\b/g, (whole, n: string) =>
    tableNums.has(Number(n))
      ? `<xref ref-type="table" rid="tbl${Number(n)}">${whole}</xref>`
      : whole,
  );
}

function tableWrapXml(t: MdTable, id: string, label?: string, caption?: string): string {
  const pad = "      ";
  const row = (cells: string[]) =>
    `${pad}    <tr>${cells.map((c) => (c ? `<td>${esc(c)}</td>` : "<td/>")).join("")}</tr>`;
  const head =
    t.headerRows > 0
      ? [`${pad}  <thead>`, ...t.rows.slice(0, t.headerRows).map(row), `${pad}  </thead>`]
      : [];
  const body = [`${pad}  <tbody>`, ...t.rows.slice(t.headerRows).map(row), `${pad}  </tbody>`];
  return [
    `${pad}<table-wrap id="${id}">`,
    label ? `${pad}  <label>${esc(label)}</label>` : "",
    caption ? `${pad}  <caption><p>${esc(caption)}</p></caption>` : "",
    `${pad}  <table>`,
    ...head,
    ...body,
    `${pad}  </table>`,
    `${pad}</table-wrap>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 段落の列をブロック (<p> と <table-wrap>) にする。
 * 空行と、抽出時に残った制御文字は落とす。
 */
function paragraphs(
  list: string[] | undefined,
  known: Set<number>,
  tableNums: Set<number>,
  counter: { n: number },
): string[] {
  const raw = (list ?? []).filter((p) => collapse(p).length > 0);
  const out: string[] = [];
  let prevWasPlain = false;
  for (let i = 0; i < raw.length; i++) {
    const t = parseMdTable(raw[i]);
    if (!t) {
      out.push(`      <p>${withTableXrefs(withXrefs(esc(collapse(raw[i])), known), tableNums)}</p>`);
      prevWasPlain = true;
      continue;
    }
    // 直前の段落が "Table N ." ならキャプションとして表に取り込む (段落からは外す)
    let label: string | undefined;
    let caption: string | undefined;
    let num: number | undefined;
    if (prevWasPlain) {
      const m = TABLE_CAPTION.exec(collapse(raw[i - 1]));
      if (m) {
        out.pop();
        label = `Table ${m[1]}`;
        caption = m[2] || undefined;
        num = Number(m[1]);
      }
    }
    counter.n++;
    out.push(tableWrapXml(t, num !== undefined ? `tbl${num}` : `tblx${counter.n}`, label, caption));
    prevWasPlain = false;
  }
  return out;
}

/**
 * "Horwitz E M" → 姓 + イニシャル。PubMed は姓が先に来る。
 *
 * **末尾のイニシャルから削る。** 先頭 1 語を姓と取ると "Le Blanc K" が
 * 姓 "Le" になる。姓は複数語になり得るがイニシャルは必ず末尾の 1 文字語。
 */
function pubmedName(full: string): string {
  const parts = full.trim().split(/\s+/);
  const initials: string[] = [];
  while (parts.length > 1 && /^[A-Z]{1,3}$/.test(parts[parts.length - 1])) {
    initials.unshift(parts.pop()!);
  }
  const surname = parts.join(" ") || full;
  const given = initials.join(" ");
  return (
    `          <name><surname>${esc(surname)}</surname>` +
    (given ? `<given-names>${esc(given)}</given-names>` : "") +
    `</name>`
  );
}

/**
 * 文献 1 件を <ref> にする。
 *
 * PubMed が引けていれば element-citation で構造化し、引けていなければ
 * mixed-citation に生テキストを入れる (parseJats が raw として拾う)。
 * **無い値を作らない** — 巻・頁は生テキストから拾えたときだけ入れる。
 */
function refXml(r: RefRecord): string {
  const n = r.index;
  const pm = r.pubmed;
  const doi = r.doi ?? pm?.doi;
  const pmid = r.pmid ?? pm?.pmid;
  const ids = [
    doi ? `          <pub-id pub-id-type="doi">${esc(doi)}</pub-id>` : "",
    pmid ? `          <pub-id pub-id-type="pmid">${esc(pmid)}</pub-id>` : "",
  ].filter(Boolean);

  if (!pm?.title) {
    return [
      `      <ref id="${refId(n)}">`,
      `        <label>${n}.</label>`,
      `        <mixed-citation>${esc(r.text ?? "")}</mixed-citation>`,
      ...ids,
      `      </ref>`,
    ].join("\n");
  }

  // "Cytotherapy, 7 (2005), pp. 393-395" から巻と頁を拾う。取れなければ入れない。
  const m = /,\s*(\d+)\s*\(\d{4}\),\s*pp?\.\s*(\d+)\s*[-–]\s*(\d+)/.exec(r.text ?? "");
  const lines = [
    `      <ref id="${refId(n)}">`,
    `        <label>${n}.</label>`,
    `        <element-citation publication-type="journal">`,
    ...(pm.authors ?? []).map(pubmedName),
    `          <article-title>${esc(pm.title)}</article-title>`,
    pm.journal ? `          <source>${esc(pm.journal)}</source>` : "",
    pm.year ? `          <year>${esc(pm.year)}</year>` : "",
    m ? `          <volume>${m[1]}</volume>` : "",
    m ? `          <fpage>${m[2]}</fpage><lpage>${m[3]}</lpage>` : "",
    ...ids,
    `        </element-citation>`,
    `      </ref>`,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

interface XmlCtx {
  known: Set<number>;
  tableNums: Set<number>;
  counter: { n: number };
}

function sectionXml(s: InputSection, ctx: XmlCtx, depth = 3): string {
  const pad = "  ".repeat(depth);
  const title = s.title ? `${pad}  <title>${esc(s.title)}</title>\n` : "";
  // sec-type は分類のヒントとして渡す。最終的な種別は classifySection が決める。
  const type = s.type && s.type !== "other" ? ` sec-type="${esc(s.type)}"` : "";
  const body = paragraphs(s.paragraphs, ctx.known, ctx.tableNums, ctx.counter).join("\n");
  const subs = (s.subsections ?? []).map((x) => sectionXml(x, ctx, depth + 1)).join("\n");
  return `${pad}<sec${type}>\n${title}${body}${subs ? "\n" + subs : ""}\n${pad}</sec>`;
}

function toJats(input: Input, records: RefRecord[]): string {
  const known = new Set(records.map((r) => r.index));
  const ctx: XmlCtx = { known, tableNums: collectTableNums(input.sections ?? []), counter: { n: 0 } };
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
    .map(
      (s) =>
        `      <abstract>\n${paragraphs(s.paragraphs, ctx.known, ctx.tableNums, ctx.counter).join("\n")}\n      </abstract>`,
    )
    .join("\n");

  const backXml = records.length
    ? [`  <back>`, `    <ref-list>`, ...records.map(refXml), `    </ref-list>`, `  </back>`].join("\n")
    : "";

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
    body.map((s) => sectionXml(s, ctx)).join("\n"),
    `  </body>`,
    backXml,
    `</article>`,
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // **形で見分ける。** sections があれば本文、records があれば文献。
  // 順番や --flag に頼らない (npm が --flag を横取りするため)。
  let input: Input | null = null;
  let refInput: RefInput | null = null;
  for (const f of args.files) {
    const p = resolve(f);
    if (!existsSync(p)) throw new Error(`見つかりません: ${f}`);
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Input & RefInput;
    if (parsed.sections?.length) input = parsed;
    else if (parsed.records?.length) refInput = parsed;
    else throw new Error(`sections も records もありません: ${f}`);
  }
  if (!input?.sections?.length) throw new Error("本文の JSON (sections を持つもの) がありません");
  const article = input as Input & { sections: InputSection[] };

  const records = (refInput?.records ?? []).filter((r) => Number.isInteger(r.index));
  const xml = toJats(article, records);
  const fallback = article.id ?? basename(args.files[0], ".json");
  const slug = article.doi ? slugFromDoi(article.doi, fallback) : fallback;
  const dest = join(dirFor(PRIVATE_ROOT, "raw"), `${slug}.xml`);

  const counts = {
    セクション: article.sections.length,
    段落: article.sections.reduce((n, s) => n + (s.paragraphs?.length ?? 0), 0),
    著者: article.authors?.length ?? 0,
    文献: records.length,
    引用: (xml.match(/<xref /g) ?? []).length,
    表: (xml.match(/<table-wrap /g) ?? []).length,
  };
  console.log(`入力  ${args.files.join("\n      ")}`);
  console.log(`      ${article.title ?? "(タイトルなし)"}`);
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
