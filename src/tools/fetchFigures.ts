#!/usr/bin/env -S npx tsx
/**
 * 図版を PMC から取ってきて data/figures/ に置く。
 *
 *   npm run figures                    data/articles/*.json 全部
 *   npm run figures -- --dry-run       取得先 URL を出すだけ (通信しない)
 *   npm run figures -- --force         既にあるファイルも取り直す
 *
 * **JATS XML に画像は入っていない。** `<graphic xlink:href="...">` にあるのは
 * ファイル名だけで、URL でもデータでもない。表示するには配信元から取るしかない。
 *
 * 取得先を PMC に一本化してある理由:
 *
 *   - MDPI (www.mdpi.com) は bot 対策で 403 を返す。ホットリンクもスクリプトも
 *     通らない。ただし MDPI の OA 論文は PMC にも入っているので、DOI から
 *     PMCID を引けば PMC 側から取れる (cells15141249 → PMC13407337)。
 *   - MDPI の原本は .tif で、**ブラウザは TIFF を表示できない**。PMC は同じ図を
 *     .jpg に変換して持っているので、拡張子を .jpg に寄せる。
 *
 * PMC の bin URL は CDN へ 301 する。fetch は既定でリダイレクトを追う。
 *
 * 取得の本体 (`fetchFiguresFor`) はビューアからも呼ぶので、**進捗は console に
 * 直接書かず onEvent で外に出す**。CLI はそれを整形して表示し、サーバは
 * NDJSON にしてブラウザへ流す。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Article, Figure } from "../types.js";
import { dirFor, readDirs, rootForArticle } from "../paths.js";



/** NCBI には呼び出し元を名乗る慣行がある (連絡先は送らない) */
const TOOL = "article-json";
const UA = `${TOOL}/0.1 (local reading tool)`;

/**
 * 配信元への連続アクセスを避ける。
 *
 * PMC は数枚取ると一定時間ブロックしてくる。**そのとき返るのは 429 ではなく
 * `200 text/html`** なので、ステータスだけ見ていると成功したことになり、
 * HTML が .jpg として保存される。content-type で弾いたうえで、待って
 * 取り直す (これは恒久的な拒否ではなく、待てば通る)。
 */
const DELAY_MS = 1200;
const RETRY_WAITS_MS = [4000, 10000, 25000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 待てば直る可能性のある失敗 */
class Throttled extends Error {}

/**
 * 取得中に起きたこと。**呼び出し側が表示を決める。**
 * CLI は行に整形し、ビューアは進捗表示とボタンのラベルに使う。
 */
export type FetchEvent =
  | { type: "start"; id: string; figures: number; images: number }
  | { type: "pmcid"; pmcid: string }
  | { type: "plan"; label: string; url: string } // dry-run
  | { type: "image"; name: string; bytes: number }
  | { type: "skip"; name: string }
  | { type: "wait"; ms: number; reason: string }
  | { type: "failed"; name: string; message: string }
  | { type: "note"; message: string }
  | { type: "done"; got: number; skipped: number; failed: number; bytes: number };

export interface FetchOptions {
  force?: boolean;
  dryRun?: boolean;
  onEvent?: (e: FetchEvent) => void;
}

interface Args {
  inputs: string[];
  force: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { inputs: [], force: false, dryRun: false };
  for (const a of argv) {
    if (a === "--force" || a === "-f") args.force = true;
    else if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a.startsWith("-")) {
      console.error(`不明なオプション: ${a}`);
      process.exit(1);
    } else args.inputs.push(a);
  }
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

/**
 * DOI から PMCID を引く。
 *
 * MDPI 由来の JSON には pmcid が無い (元の XML に書いていない) が、
 * OA 論文なら PMC にも収録されている。引けたら meta に書き戻して、
 * 次回以降は問い合わせなくて済むようにする。
 */
async function resolvePmcid(article: Article): Promise<string | null> {
  if (article.meta.pmcid) return article.meta.pmcid;
  const doi = article.meta.doi;
  if (!doi) return null;

  const url =
    `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/` +
    `?ids=${encodeURIComponent(doi)}&format=json&tool=${TOOL}`;
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) return null;
  const body = (await res.json()) as { records?: Array<{ pmcid?: string }> };
  const pmcid = body.records?.[0]?.pmcid;
  if (!pmcid) return null;

  article.meta.pmcid = pmcid; // 呼び出し側が JSON を書き戻す
  return pmcid;
}

/**
 * 表示できる拡張子に寄せる。
 * .tif はブラウザで開けない。PMC は変換済みの .jpg を持っている。
 */
function displayName(href: string): string {
  const ext = extname(href).toLowerCase();
  if (ext === ".tif" || ext === ".tiff" || ext === "") {
    return href.replace(/\.(tiff?)$/i, "") + ".jpg";
  }
  return href;
}

function binUrl(pmcid: string, name: string): string {
  const numeric = pmcid.replace(/^PMC/i, "");
  return `https://pmc.ncbi.nlm.nih.gov/articles/instance/${numeric}/bin/${name}`;
}

/**
 * 1 枚取る。取れたら書き込んだバイト数、既にあれば null。
 *
 * **content-type を確かめてから書く。** 404 や bot 対策のページは HTML で
 * 返ってくるので、確認せずに保存すると「壊れた画像」がディレクトリに残り、
 * 次回スキップされて原因が追えなくなる。
 */
async function fetchOne(
  url: string,
  dest: string,
  force: boolean,
  emit: (e: FetchEvent) => void,
): Promise<number | null> {
  if (!force && existsSync(dest)) return null;

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA } });
      if (res.status === 429 || res.status >= 500) throw new Throttled(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type") ?? "";
      // 200 で HTML が返るのはブロックされたとき。待てば通る。
      if (!type.startsWith("image/")) throw new Throttled(`画像ではありません (${type})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Throttled("空の応答");
      writeFileSync(dest, buf);
      return buf.length;
    } catch (e) {
      const wait = RETRY_WAITS_MS[attempt];
      if (!(e instanceof Throttled) || wait === undefined) throw e;
      emit({ type: "wait", ms: wait, reason: (e as Error).message });
      await sleep(wait);
    }
  }
}

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

/**
 * 論文 1 本ぶんの図版を取る。**CLI とビューアの共通の入口。**
 * 表示はしない (呼び出し側が onEvent を見て決める)。失敗が 0 件なら true。
 */
export async function fetchFiguresFor(file: string, opts: FetchOptions = {}): Promise<boolean> {
  const emit = opts.onEvent ?? (() => {});
  const article = JSON.parse(readFileSync(file, "utf8")) as Article;
  const figures = article.figures as Figure[];
  const images = figures.reduce((n, f) => n + f.graphics.length, 0);
  emit({ type: "start", id: article.id, figures: figures.length, images });
  if (figures.length === 0) return true;

  // PMCID の解決は dry-run でも行う。ここを飛ばすと URL がプレースホルダに
  // なって「何を取りに行くか」の確認にならない (問い合わせるのはメタデータだけ)。
  const pmcid = await resolvePmcid(article);
  if (!pmcid) {
    emit({ type: "note", message: "PMCID を解決できないので取得先がありません (スキップ)" });
    return true;
  }
  emit({ type: "pmcid", pmcid });

  // 論文の JSON がある側に置く。再配布不可なら data/private/figures/ になる。
  const outDir = join(dirFor(rootForArticle(article.id), "figures"), article.id);
  if (!opts.dryRun) mkdirSync(outDir, { recursive: true });

  let got = 0;
  let skipped = 0;
  let failed = 0;
  let bytes = 0;

  for (const fig of figures) {
    const files: string[] = [];
    for (const href of fig.graphics) {
      const name = displayName(href);
      const url = binUrl(pmcid, name);
      const dest = join(outDir, name);

      if (opts.dryRun) {
        emit({ type: "plan", label: fig.label ?? fig.xmlId ?? name, url });
        files.push(name);
        continue;
      }

      try {
        const n = await fetchOne(url, dest, opts.force ?? false, emit);
        if (n === null) {
          skipped++;
          emit({ type: "skip", name });
        } else {
          got++;
          bytes += n;
          emit({ type: "image", name, bytes: n });
          await sleep(DELAY_MS);
        }
        files.push(name);
      } catch (e) {
        failed++;
        emit({ type: "failed", name, message: (e as Error).message });
        await sleep(DELAY_MS);
      }
    }
    // 取れたものだけ記録する。空配列なら「未取得」としてビューアが扱う。
    if (files.length > 0) fig.files = files;
  }

  if (!opts.dryRun) writeFileSync(file, JSON.stringify(article, null, 2) + "\n", "utf8");
  emit({ type: "done", got, skipped, failed, bytes });
  return failed === 0;
}

/** CLI の表示。ここだけが console を知っている。 */
function printEvent(e: FetchEvent): void {
  switch (e.type) {
    case "start":
      return console.log(`\n${e.id}  (図 ${e.figures})`);
    case "pmcid":
      return console.log(`  取得先 ${e.pmcid}`);
    case "plan":
      return console.log(`  ${e.label}  ${e.url}`);
    case "image":
      return console.log(`  ok   ${e.name}  ${kb(e.bytes)}`);
    case "wait":
      return console.log(`       待機 ${e.ms / 1000}s (${e.reason})`);
    case "failed":
      return console.log(`  失敗 ${e.name}  ${e.message}`);
    case "note":
      return console.log(`  ${e.message}`);
    case "done":
      return console.log(
        `  取得 ${e.got} 枚 (${kb(e.bytes)}) / 既存 ${e.skipped} 枚` +
          (e.failed ? ` / 失敗 ${e.failed} 枚` : ""),
      );
    case "skip":
      return; // 既にある分は 1 行ずつ出さない (done でまとめて数える)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const files = args.inputs.flatMap(collectJson);
  if (files.length === 0) {
    console.error("対象の JSON がありません");
    process.exit(1);
  }
  let ok = true;
  for (const f of files) {
    ok = (await fetchFiguresFor(f, { force: args.force, dryRun: args.dryRun, onEvent: printEvent })) && ok;
  }
  if (args.dryRun) console.log(`\n--dry-run: 何も取得していません`);
  else console.log("\n図版を保存しました");
  if (!ok) process.exit(1);
}

// ビューアからは fetchFiguresFor だけを import する。**直接実行したときだけ**
// CLI を動かす (import しただけで取得が始まらないように)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
