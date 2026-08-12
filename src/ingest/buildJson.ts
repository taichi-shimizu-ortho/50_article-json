#!/usr/bin/env -S npx tsx
/**
 * ローカルに置いた JATS XML を正規化 JSON に一括変換する。
 *
 *   npm run build                      data/raw/ 以下を全部
 *   npm run build -- path/to/one.xml   単体
 *   npm run build -- path/to/dir       ディレクトリ指定
 *   npm run build -- --force           ハッシュが同じでも再パース
 *   npm run build -- --out other/dir   出力先を変更
 *
 * 入力 XML の SHA-256 を出力 JSON に埋めてあるので、2 回目以降は
 * 変更のないファイルをスキップする。
 *
 * **上書きするときは LLM 由来の値を引き継ぐ** (`carryDerived`)。スキップだけを
 * 保険にしていると、`--force` やパーサの修正で enrich の結果が消える。
 * あれは課金して得た値なので、パースし直すたびに買い直すことになる。
 */

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, basename, extname } from "node:path";
import { parseJats, summarize } from "./parseJats.js";
import type { Article, Paragraph, Section } from "../types.js";
import { dirFor, readDirs, rootForArticle } from "../paths.js";


/** PMC の生ファイルは .nxml で配布される */
const XML_EXT = new Set([".xml", ".nxml", ".jats"]);

/* ------------------------------------------------------------------ *
 * 派生値の引き継ぎ
 * ------------------------------------------------------------------ */

/** 段落 id → 段落。位置ベースの id なので、構造が同じなら一致する。 */
function indexParagraphs(article: Article): Map<string, Paragraph> {
  const map = new Map<string, Paragraph>();
  const walk = (sections: Section[]) => {
    for (const s of sections) {
      for (const p of s.paragraphs) map.set(p.id, p);
      walk(s.sections);
    }
  };
  walk(article.abstract);
  walk(article.sections);
  return map;
}

/**
 * 前回の出力から LLM 由来の値を引き継ぐ。
 *
 * **本文が 1 文字でも変われば引き継がない。** 要約は古い本文についての記述
 * なので、テキストが変わったら要約も無効になる。id が同じでも中身が違えば
 * 別物として扱う — ここを緩めると、静かに嘘の要約が残る。
 *
 * 図版のローカルファイル一覧 (`figures[].files`) と、外部から解決した
 * `meta.pmcid` も引き継ぐ。どちらもパースでは得られない。
 */
function carryDerived(prev: Article, next: Article): number {
  let carried = 0;

  const before = indexParagraphs(prev);
  for (const [id, p] of indexParagraphs(next)) {
    const old = before.get(id);
    if (!old || old.text !== p.text) continue;

    if (old.role !== undefined) p.role = old.role;
    if (old.gist !== undefined) p.gist = old.gist;
    if (old.plain !== undefined) p.plain = old.plain;
    if (old.role ?? old.gist ?? old.plain) carried++;

    // 文単位の値。文分割が変わっていたら諦める (span がずれる)。
    const sameSplit =
      old.sentences.length === p.sentences.length &&
      old.sentences.every((s, i) => s.span[0] === p.sentences[i].span[0] && s.span[1] === p.sentences[i].span[1]);
    if (!sameSplit) continue;
    p.sentences.forEach((s, i) => {
      const o = old.sentences[i];
      if (o.certainty !== undefined) s.certainty = o.certainty;
      if (o.hedges !== undefined) s.hedges = o.hedges;
      if (o.stats !== undefined) s.stats = o.stats;
    });
  }

  if (prev.enrich) next.enrich = prev.enrich;
  if (prev.meta.pmcid && !next.meta.pmcid) next.meta.pmcid = prev.meta.pmcid;

  const files = new Map((prev.figures ?? []).map((f) => [f.xmlId, f.files]));
  for (const f of next.figures) {
    const got = files.get(f.xmlId);
    if (got) f.files = got;
  }

  return carried;
}

/* ------------------------------------------------------------------ *
 * 引数
 * ------------------------------------------------------------------ */

interface Args {
  inputs: string[];
  /**
   * 出力先。既定は論文ごとに決める — 再配布不可の論文は data/private/articles/ へ。
   * どちらに書くかの判断は npm run corpus が持ち、ここでは既存の置き場所に従うだけ。
   */
  outDir?: string;
  force: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { inputs: [], outDir: undefined, force: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force" || a === "-f") args.force = true;
    else if (a === "--quiet" || a === "-q") args.quiet = true;
    else if (a === "--out" || a === "-o") args.outDir = argv[++i];
    else if (a.startsWith("-")) {
      console.error(`不明なオプション: ${a}`);
      process.exit(1);
    } else args.inputs.push(a);
  }
  // 公開側と非公開側の両方の raw を見る
  if (args.inputs.length === 0) args.inputs.push(...readDirs("raw"));
  return args;
}

/* ------------------------------------------------------------------ *
 * ファイル収集
 * ------------------------------------------------------------------ */

function collectFiles(input: string): string[] {
  const p = resolve(input);
  if (!existsSync(p)) {
    throw new Error(`見つかりません: ${input}`);
  }
  if (statSync(p).isFile()) return [p];

  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (XML_EXT.has(extname(entry.name).toLowerCase())) out.push(full);
    }
  };
  walk(p);
  return out.sort();
}

/* ------------------------------------------------------------------ *
 * 読み込み時のサニタイズ
 * ------------------------------------------------------------------ */

function readXml(path: string): string {
  let text = readFileSync(path, "utf8");

  // BOM 付きで保存されていると XML 宣言より前に文字が来てパーサが落ちる。
  // ブラウザから保存した XML でよく起きる。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // BOM 以外の先行ゴミ (シェルの取り違え、HTTP ヘッダの混入、
  // エディタが足した空行など)。xmldom のエラーが
  // "processing instruction at position 12 is an xml declaration..." と
  // 極めて分かりにくいので、先に自前で落として原因を示す。
  const firstTag = text.indexOf("<");
  if (firstTag > 0) {
    const junk = text.slice(0, firstTag);
    if (junk.trim() !== "") {
      throw new Error(
        `XML 宣言の前に余分な文字があります: ${JSON.stringify(junk.slice(0, 40))}`,
      );
    }
    text = text.slice(firstTag); // 先頭の空白・空行だけなら黙って落とす
  }

  const head = text.slice(0, 1500).toLowerCase();

  // ログイン画面やエラーページを .xml として保存してしまったケースを弾く。
  // 「サイズはあるのに article が無い」で悩む時間を潰すため、早めに落とす。
  if (head.includes("<!doctype html") || head.includes("<html")) {
    throw new Error("HTML が保存されています (XML ではありません)。取得 URL を確認してください");
  }
  if (!head.includes("<article")) {
    throw new Error("<article> 要素が見当たりません。JATS XML か確認してください");
  }

  // 宣言が UTF-8 以外なら文字化けしている可能性がある
  const decl = text.match(/^<\?xml[^>]*encoding=["']([^"']+)["']/i);
  if (decl && !/^utf-?8$/i.test(decl[1])) {
    console.error(`  ! encoding="${decl[1]}" 宣言。UTF-8 として読んでいるので文字化けに注意`);
  }

  return text;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ *
 * メイン
 * ------------------------------------------------------------------ */

interface Row {
  file: string;
  status: "ok" | "skip" | "error";
  id?: string;
  paragraphs?: number;
  warnings?: number;
  message?: string;
}

function main() {
  const args = parseArgs(process.argv.slice(2));


  const files = args.inputs.flatMap(collectFiles);
  if (files.length === 0) {
    console.error(`XML が見つかりません: ${args.inputs.join(", ")}`);
    console.error(`対応拡張子: ${[...XML_EXT].join(", ")}`);
    process.exit(1);
  }

  console.error(`${files.length} 件を処理します\n`);
  const rows: Row[] = [];

  for (const path of files) {
    const name = basename(path);
    try {
      const xml = readXml(path);
      const hash = sha256(xml);

      // 既存の出力とハッシュが一致すればスキップ。
      // 出力ファイル名は DOI 由来なので、先に軽くパースして id を得る必要がある。
      // ここでは全パースしてから比較する (パース自体は速いので問題にならない)。
      const article = parseJats(xml, { file: name, sha256: hash });
      // 既にどちらかにあるならそこへ。無ければ公開側。
      const outDir = resolve(args.outDir ?? dirFor(rootForArticle(article.id), "articles"));
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, `${article.id}.json`);

      let carried = 0;
      if (existsSync(outPath)) {
        try {
          const prev = JSON.parse(readFileSync(outPath, "utf8")) as Article;
          if (!args.force && prev.source?.sha256 === hash) {
            rows.push({ file: name, status: "skip", id: article.id });
            continue;
          }
          // 上書きする前に、パースでは得られない値を回収する
          carried = carryDerived(prev, article);
        } catch {
          // 壊れた JSON なら黙って上書きする
        }
      }

      writeFileSync(outPath, JSON.stringify(article, null, 2));
      if (carried > 0 && !args.quiet) {
        console.error(`  enrich 済みの ${carried} 段落を引き継ぎました`);
      }
      rows.push({
        file: name,
        status: "ok",
        id: article.id,
        paragraphs: countParagraphs(article),
        warnings: article.warnings.length,
      });

      if (!args.quiet) {
        console.error(summarize(article));
        console.error("");
      }
    } catch (err) {
      rows.push({ file: name, status: "error", message: (err as Error).message });
    }
  }

  report(rows, args.outDir ?? "data/articles (+ data/private/articles)");
  process.exit(rows.some((r) => r.status === "error") ? 1 : 0);
}

function countParagraphs(a: Article): number {
  let n = 0;
  const walk = (secs: Article["sections"]) => {
    for (const s of secs) {
      n += s.paragraphs.length;
      walk(s.sections);
    }
  };
  walk(a.sections);
  walk(a.abstract);
  return n;
}

function report(rows: Row[], outDir: string): void {
  const ok = rows.filter((r) => r.status === "ok");
  const skipped = rows.filter((r) => r.status === "skip");
  const errors = rows.filter((r) => r.status === "error");

  console.error("=".repeat(72));
  for (const r of ok) {
    const warn = r.warnings ? `  ⚠ warning ${r.warnings} 件` : "";
    console.error(`  ok    ${r.file}  →  ${r.id}.json  (${r.paragraphs} 段落)${warn}`);
  }
  for (const r of skipped) {
    console.error(`  skip  ${r.file}  (変更なし)`);
  }
  for (const r of errors) {
    console.error(`  ERR   ${r.file}  ${r.message}`);
  }
  console.error("=".repeat(72));
  console.error(
    `変換 ${ok.length} / スキップ ${skipped.length} / 失敗 ${errors.length}  →  ${outDir}`,
  );

  const withWarnings = ok.filter((r) => (r.warnings ?? 0) > 0);
  if (withWarnings.length > 0) {
    console.error(
      `\nwarning のある論文が ${withWarnings.length} 件あります。` +
        `JSON の warnings 配列を確認してください。`,
    );
  }
}

main();
