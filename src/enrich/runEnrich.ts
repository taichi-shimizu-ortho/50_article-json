#!/usr/bin/env -S npx tsx
/**
 * LLM 由来のフィールドを付与する。2 つのパスがある。
 *
 *   paragraph (既定)  role / gist / plain       段落単位。精読の主軸
 *   sentence          certainty / hedges / stats 文単位。断定度を見たいとき
 *
 *   npm run enrich                          段落パスを data/articles/ 全部に
 *   npm run enrich -- --pass sentence       文パス
 *   npm run enrich -- path/to/one.json      単体
 *   npm run enrich -- --dry-run             API を叩かず、投げる内容と件数だけ表示
 *   npm run enrich -- --limit 1             API を 1 リクエストで打ち切る (試し打ち)
 *   npm run enrich -- --force               キャッシュを無視して引き直す (課金あり)
 *   npm run enrich -- --batch 40            1 リクエストあたりの文数
 *   npm run enrich -- --with-methods        Methods も対象にする (文パスの既定は除外)
 *   npm run enrich -- --model claude-opus-5
 *
 * **課金する処理なので既定で安全側に倒してある。** キャッシュが効いた段落は
 * API を叩かない。--dry-run で件数を確認してから本番を回すこと。
 * キャッシュはパスごとに分かれているので、片方を引き直しても他方は無傷。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Article, Paragraph, Section, SectionType } from "../types.js";
import { EnrichCache } from "./cache.js";
import { createModelCaller, type ModelCaller } from "./client.js";
import type { EnrichPass } from "./pass.js";
import { paragraphPass } from "./passes/paragraph.js";
import { sentencePass } from "./passes/sentence.js";
import { batchUnits, collectUnits, type EnrichUnit } from "./units.js";
import { dirFor, readDirs, rootForArticle } from "../paths.js";


export const DEFAULT_MODEL = "claude-opus-5";

interface TotalUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  requests: number;
}

/** $/1M トークン。表に無いモデルはトークン数だけ出してコストは伏せる。 */
export const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

/** 既定は段落パス。文パスは断定度を見たいときの opt-in。 */
const PASSES: Record<string, EnrichPass<any>> = {
  paragraph: paragraphPass,
  sentence: sentencePass,
};

/* ------------------------------------------------------------------ *
 * 本体 (CLI から切り離してある。テストはこちらを呼ぶ)
 * ------------------------------------------------------------------ */

export interface EnrichOptions<R> {
  model: string;
  pass: EnrichPass<R>;
  caller: ModelCaller;
  cache: EnrichCache;
  batchSentences?: number;
  /** キャッシュを読まない (書きはする) */
  force?: boolean;
  /** 対象セクション。既定はパスごとの defaultSections。 */
  sectionTypes?: ReadonlySet<SectionType>;
  /** API リクエストの上限。試し打ち用。途中で止めても済んだ分はキャッシュに残る。 */
  maxRequests?: number;
  onProgress?: (msg: string) => void;
}

export interface EnrichStats {
  /** 適用した項目数 (段落パスなら段落数、文パスなら文数) */
  applied: number;
  cached: number;
  requests: number;
  warnings: string[];
}

export async function enrichArticle<R>(
  article: Article,
  opts: EnrichOptions<R>,
): Promise<EnrichStats> {
  const pass = opts.pass;
  const units = collectUnits(
    article,
    opts.model,
    pass.promptVersion,
    opts.sectionTypes ?? pass.defaultSections,
  );
  const warnings: string[] = [];
  const results = new Map<string, R>();

  // 1. キャッシュから復元できる段落を先に外す
  const misses: EnrichUnit[] = [];
  let cached = 0;
  for (const u of units) {
    const raw = opts.force ? null : opts.cache.get(u.cacheKey);
    const hit = raw === null ? null : pass.fromCache(raw, u);
    if (hit !== null) {
      results.set(u.paragraphId, hit);
      cached++;
    } else {
      misses.push(u);
    }
  }

  // 2. 残りをバッチにまとめて投げる
  const all = batchUnits(misses, opts.batchSentences ?? pass.defaultBatch);
  const batches = opts.maxRequests !== undefined ? all.slice(0, opts.maxRequests) : all;
  opts.onProgress?.(
    `[${pass.name}] 段落 ${units.length} / 文 ${units.reduce((n, u) => n + u.sentences.length, 0)}` +
      ` — キャッシュ ${cached} 段落 / API ${batches.length} リクエスト` +
      (batches.length < all.length ? ` (--limit で ${all.length} 件中)` : ""),
  );

  for (const [i, batch] of batches.entries()) {
    opts.onProgress?.(
      `  [${i + 1}/${batches.length}] ${batch.length} 段落 / ` +
        `${batch.reduce((n, u) => n + u.sentences.length, 0)} 文`,
    );
    const raw = await opts.caller(batch);
    const parsed = pass.parse(raw, batch);
    warnings.push(...parsed.warnings);

    for (const u of batch) {
      const got = parsed.byParagraph.get(u.paragraphId);
      if (got === undefined) continue;
      results.set(u.paragraphId, got);
      // 不完全な応答はキャッシュしない (次回また引き直させる)
      if (pass.isComplete(got, u)) opts.cache.set(u.cacheKey, pass.toCache(got));
    }
  }

  // 3. 記事にマージする
  let applied = 0;
  const walk = (sections: Section[]) => {
    for (const s of sections) {
      for (const p of s.paragraphs) {
        const r = results.get(p.id);
        if (r !== undefined) applied += pass.merge(p, r, warnings);
      }
      walk(s.sections);
    }
  };
  walk(article.abstract);
  walk(article.sections);

  const entry = {
    pass: pass.name,
    model: opts.model,
    promptVersion: pass.promptVersion,
    enrichedAt: new Date().toISOString(),
    applied,
    cached,
    warnings,
  };
  // パスごとに記録を残す。片方を回しても他方の記録を消さない。
  article.enrich = { ...(article.enrich ?? {}), [pass.name]: entry };

  return { applied, cached, requests: batches.length, warnings };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

interface Args {
  inputs: string[];
  pass: EnrichPass<unknown>;
  model: string;
  /**
   * キャッシュの置き場所。既定は論文ごとに決める — 再配布不可の論文の
   * キャッシュ (段落要約) は data/private/ 側に置く必要がある。
   */
  cacheDir?: string;
  batch?: number;
  force: boolean;
  dryRun: boolean;
  withMethods: boolean;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    inputs: [],
    pass: paragraphPass,
    model: DEFAULT_MODEL,

    force: false,
    dryRun: false,
    withMethods: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force" || a === "-f") args.force = true;
    else if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--with-methods") args.withMethods = true;
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--cache") args.cacheDir = argv[++i];
    else if (a === "--batch") args.batch = Number(argv[++i]);
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--pass") {
      const name = argv[++i];
      const p = PASSES[name];
      if (!p) {
        console.error(`不明なパス: ${name} (paragraph | sentence)`);
        process.exit(1);
      }
      args.pass = p;
    } else if (a.startsWith("-")) {
      console.error(`不明なオプション: ${a}`);
      process.exit(1);
    } else args.inputs.push(a);
  }
  if (args.inputs.length === 0) args.inputs.push(...readDirs("articles"));
  if (args.batch !== undefined && (!Number.isFinite(args.batch) || args.batch < 1)) {
    console.error("--batch は 1 以上の整数で指定してください");
    process.exit(1);
  }
  if (args.limit !== undefined && (!Number.isFinite(args.limit) || args.limit < 1)) {
    console.error("--limit は 1 以上の整数で指定してください");
    process.exit(1);
  }
  return args;
}

/**
 * `.env` を読む。
 *
 * Anthropic SDK は `.env` を自動では読まない (dotenv 相当の処理を持たない)。
 * キーをファイルに書いただけだと "Could not resolve authentication method" で
 * 落ちるので、CLI 側で読んでおく。
 *
 * Node の loadEnvFile は**既に export 済みの変数を上書きしない**。
 * 一時的に別のキーで動かしたいときは環境変数のほうが勝つ。
 */
export function loadDotEnv(): { file: string | null; fromShell: boolean } {
  const fromShell = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const p = resolve(".env");
  if (!existsSync(p)) return { file: null, fromShell };
  try {
    process.loadEnvFile(p);
    return { file: p, fromShell };
  } catch (e) {
    console.error(`.env を読めませんでした: ${(e as Error).message}`);
    return { file: null, fromShell };
  }
}

/** 認証情報の所在を確認する。無いまま API を叩くと分かりにくいエラーになる。 */
function checkCredentials(): void {
  const { file, fromShell } = loadDotEnv();
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    const src = fromShell ? "環境変数" : `${file}`;
    console.log(`認証: ANTHROPIC_API_KEY (${src})`);
    return;
  }
  console.error(
    [
      "ANTHROPIC_API_KEY が見つかりません。次のいずれかで設定してください:",
      "  1. プロジェクト直下の .env に  ANTHROPIC_API_KEY=sk-ant-...",
      "  2. export ANTHROPIC_API_KEY=sk-ant-...",
      "  3. ant auth login (OAuth プロファイル)",
      file ? `  (${file} は読みましたが ANTHROPIC_API_KEY がありませんでした)` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  process.exit(1);
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
 * 対象セクション。--with-methods はパスの既定に Methods を足す。
 * (段落パスの既定は元から Methods 込みなので変化しない)
 */
function sectionTypesFor(args: Args): ReadonlySet<SectionType> {
  if (!args.withMethods) return args.pass.defaultSections;
  return new Set<SectionType>([...args.pass.defaultSections, "methods"]);
}

/**
 * この論文のキャッシュをどこに置くか。
 *
 * 論文の JSON が data/private/ にあるなら、その要約キャッシュも private 側。
 * 段落要約を全段落ぶん並べたものは派生物とみなされうるので、本文と同じ扱いにする。
 */
function cacheDirFor(article: Article, args: Args): string {
  return args.cacheDir ?? dirFor(rootForArticle(article.id), "cache");
}

/** --dry-run: 何を投げることになるか、実際のプロンプトはどうなるかを見せる。 */
function dryRun(article: Article, args: Args): void {
  const pass = args.pass;
  const types = sectionTypesFor(args);
  const units = collectUnits(article, args.model, pass.promptVersion, types);
  const cache = new EnrichCache(cacheDirFor(article, args), pass.name);
  const misses = args.force ? units : units.filter((u) => cache.get(u.cacheKey) === null);
  const batches = batchUnits(misses, args.batch ?? pass.defaultBatch);
  const sentences = units.reduce((n, u) => n + u.sentences.length, 0);

  console.log(
    `  [${pass.name}] 対象 ${units.length} 段落 / ${sentences} 文` +
      (types.has("methods") ? " (Methods 込み)" : " (Methods 除外)"),
  );
  console.log(`  キャッシュ済み ${units.length - misses.length} 段落 / 送信 ${misses.length} 段落`);
  console.log(`  リクエスト ${batches.length} 件 (--batch ${args.batch ?? pass.defaultBatch})`);
  if (batches.length > 0) {
    const sample = pass.buildUserMessage(batches[0]);
    console.log(`\n  --- 1 件目のユーザーメッセージ (先頭 800 字) ---`);
    console.log(sample.slice(0, 800).replace(/^/gm, "  "));
    console.log(`  --- 全体 ${sample.length} 字 ---`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const files = args.inputs.flatMap(collectJson);
  if (files.length === 0) {
    console.error("対象の JSON がありません");
    process.exit(1);
  }

  if (!args.dryRun) checkCredentials();

  // 実測トークンを積む。--dry-run や全キャッシュヒットなら 0 のまま。
  const total: TotalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, requests: 0 };
  const caller = args.dryRun
    ? null
    : createModelCaller({
        model: args.model,
        pass: args.pass,
        onUsage: (u) => {
          total.inputTokens += u.inputTokens;
          total.outputTokens += u.outputTokens;
          total.cacheReadTokens += u.cacheReadTokens;
          total.requests++;
        },
      });

  let failed = 0;
  for (const file of files) {
    const article = JSON.parse(readFileSync(file, "utf8")) as Article;
    console.log(`\n${article.id}  (${file})`);

    if (args.dryRun) {
      dryRun(article, args);
      continue;
    }

    try {
      const stats = await enrichArticle(article, {
        pass: args.pass,
        model: args.model,
        caller: caller!,
        cache: new EnrichCache(cacheDirFor(article, args), args.pass.name),
        batchSentences: args.batch,
        force: args.force,
        sectionTypes: sectionTypesFor(args),
        maxRequests: args.limit,
        onProgress: (m) => console.log(`  ${m}`),
      });
      writeFileSync(file, JSON.stringify(article, null, 2) + "\n", "utf8");
      const unit = args.pass.name === "paragraph" ? "段落" : "文";
      console.log(
        `  ok  ${stats.applied} ${unit} (キャッシュ ${stats.cached} 段落 / API ${stats.requests} req)`,
      );
      for (const w of stats.warnings) console.log(`  ! ${w}`);
    } catch (e) {
      failed++;
      console.error(`  失敗: ${(e as Error).message}`);
    }
  }

  reportUsage(args.model, total);
  if (failed > 0) process.exit(1);
}

/**
 * 実測トークンと概算コストを出す。
 *
 * 出力トークンは応答を受け取るまで分からない。ここで出しておかないと、
 * 課金したのに実測値が残らない (キャッシュが効くと二度と測れない)。
 */
function reportUsage(model: string, t: TotalUsage): void {
  if (t.requests === 0) return;
  const price = PRICES[model];
  const cost = price
    ? `  概算 $${((t.inputTokens * price.in + t.outputTokens * price.out) / 1e6).toFixed(3)}`
    : "  (価格表に無いモデル)";
  console.log(
    `\nトークン実測 (${t.requests} リクエスト): ` +
      `入力 ${t.inputTokens.toLocaleString()} / 出力 ${t.outputTokens.toLocaleString()}` +
      (t.cacheReadTokens > 0 ? ` / プロンプトキャッシュ読み ${t.cacheReadTokens.toLocaleString()}` : "") +
      cost,
  );
}

// 直接実行されたときだけ main を走らせる (テストからは import して使う)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
