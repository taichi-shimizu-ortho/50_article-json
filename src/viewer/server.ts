#!/usr/bin/env -S npx tsx
/**
 * 論文ビューア。
 *
 *   npm run serve            http://127.0.0.1:5173
 *   npm run serve -- --port 8080
 *
 * 依存を足さない方針で node:http だけで書いてある。ビルド手順もない
 * (HTML/JS を素で配る)。データは data/articles/*.json をリクエストごとに
 * 読み直すので、enrich を回したあとブラウザを再読み込みすれば反映される。
 *
 * 127.0.0.1 にのみ bind する。手元の論文 JSON を配るだけのものなので
 * 外に出す想定がない。
 *
 * **コマンド操作は UI からもできる。** 対応表:
 *
 *   npm run fetch-private + build   →  POST /api/jobs/download
 *   npm run figures                 →  POST /api/jobs/figures-all
 *   npm run figures (1 論文)        →  POST /api/figures/{id}
 *   npm run enrich                  →  POST /api/jobs/enrich
 *
 * CLI の --accept-license に相当する同意は POST /api/consent で記録する
 * (data/private/consent.json)。同意なしにダウンロードは動かない。
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Article, SectionType } from "../types.js";
import { dirFor, findArticleFile, readDirs, rootForArticle, ROOTS, PRIVATE_ROOT } from "../paths.js";
import { fetchFiguresFor, type FetchEvent } from "../tools/fetchFigures.js";
import { canEfetch, fetchPaper, loadManifest, privatePath, type Paper } from "../tools/fetchPrivateXml.js";
import { buildXmlFile } from "../ingest/buildJson.js";
import { DEFAULT_MODEL, PRICES, enrichArticle, loadDotEnv } from "../enrich/runEnrich.js";
import { EnrichCache } from "../enrich/cache.js";
import { createModelCaller } from "../enrich/client.js";
import { paragraphPass } from "../enrich/passes/paragraph.js";
import { sentencePass } from "../enrich/passes/sentence.js";
import { batchUnits, collectUnits } from "../enrich/units.js";
import type { EnrichPass } from "../enrich/pass.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/**
 * 論文と図版は**公開側と非公開側の両方**から配る。
 * 再配布不可の論文は data/private/ にあるが、手元で読むぶんには区別しない。
 */
let ARTICLE_DIRS: string[] | null = null;
let FIGURE_DIRS: string[] | null = null;

const articleDirs = () => ARTICLE_DIRS ?? readDirs("articles");
const figureDirs = () => FIGURE_DIRS ?? ROOTS.map((r) => dirFor(r, "figures"));

/** 図版として配ってよい拡張子。ここに無いものは 404 にする。 */
const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** ビューアの静的ファイル (src/viewer/ 直下)。ここに無い拡張子は配らない。 */
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

interface Entry {
  id: string;
  /** プルダウンの表示名。第一著者の姓 + 年。 */
  label: string;
  title: string;
  journal?: string;
  year?: string;
  /** enrich の実行状況 (パス名の配列) */
  passes: string[];
}

function listFiles(): string[] {
  const out: string[] = [];
  for (const d of articleDirs()) {
    const dir = resolve(d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (extname(f) === ".json") out.push(join(dir, f));
    }
  }
  return out;
}

function readArticle(file: string): Article {
  return JSON.parse(readFileSync(file, "utf8")) as Article;
}

/**
 * Author-Year のラベルを作る。
 * 同じ著者・同じ年が複数あると区別できないので、その場合だけ a / b を足す。
 */
function buildIndex(): Entry[] {
  const entries: Entry[] = [];
  for (const file of listFiles()) {
    let a: Article;
    try {
      a = readArticle(file);
    } catch {
      continue; // 壊れた JSON は一覧から外す (サーバごと落とさない)
    }
    const first = a.meta.authors[0];
    const who = first?.surname ?? first?.full?.split(/\s+/).at(-1) ?? "Unknown";
    entries.push({
      id: a.id,
      label: `${who} ${a.meta.year ?? "n.d."}`,
      title: a.meta.title ?? "(タイトルなし)",
      journal: a.meta.journal,
      year: a.meta.year,
      passes: Object.keys(a.enrich ?? {}),
    });
  }

  // 同名ラベルの衝突を解消する
  const byLabel = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = byLabel.get(e.label) ?? [];
    list.push(e);
    byLabel.set(e.label, list);
  }
  for (const list of byLabel.values()) {
    if (list.length < 2) continue;
    list.forEach((e, i) => {
      e.label = `${e.label}${String.fromCharCode(97 + i)}`;
    });
  }

  return entries.sort((x, y) => x.label.localeCompare(y.label));
}

function findArticle(id: string): Article | null {
  for (const file of listFiles()) {
    try {
      const a = readArticle(file);
      if (a.id === id) return a;
    } catch {
      /* 壊れた JSON は無視 */
    }
  }
  return null;
}

/**
 * `data/figures/{article.id}/{name}` を配る。
 *
 * 静的ファイルを配る口なので、**ディレクトリの外に出ないことを
 * 実パスで確かめる**。`..` を文字列で弾くだけだとエンコードや symlink で
 * 抜けられる。resolve したうえで relative が上に登らないことを見る。
 */
function serveFigure(pathname: string, res: import("node:http").ServerResponse): void {
  const notFound = () => {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  };

  const sub = decodeURIComponent(pathname.slice("/figures/".length));

  // 公開側 → 非公開側の順に探す。**どちらのルートでも外に出ないことを確かめる。**
  for (const dir of figureDirs()) {
    const root = resolve(dir);
    const target = resolve(root, sub);
    const rel = relative(root, target);
    if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) continue;

    const type = IMAGE_TYPES[extname(target).toLowerCase()];
    if (!type) return notFound();
    if (!existsSync(target) || !statSync(target).isFile()) continue;

    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(readFileSync(target));
    return;
  }
  notFound();
}

/* ------------------------------------------------------------------ *
 * 同意の記録 (CLI の --accept-license に相当)
 *
 * 再配布不可の論文は「取得元の利用条件を確認し、ローカル利用の権限がある
 * 利用者だけが取得する」建て付け。UI では初回に同意ダイアログを出し、
 * 同意を data/private/consent.json に記録する。data/private/ は端末ごと・
 * git 除外なので、**端末ごとに 1 回**の同意になる (CLI と同じ意味)。
 * ------------------------------------------------------------------ */

const CONSENT_PATH = join(PRIVATE_ROOT, "consent.json");

function hasConsent(): boolean {
  return existsSync(CONSENT_PATH);
}

function recordConsent(): void {
  mkdirSync(PRIVATE_ROOT, { recursive: true });
  writeFileSync(
    CONSENT_PATH,
    JSON.stringify(
      {
        acceptedAt: new Date().toISOString(),
        note:
          "取得元の利用条件を確認し、再配布不可の論文をローカル利用する権限があることを" +
          "確認したうえで、ビューアの同意ダイアログで同意した記録。CLI の --accept-license に相当。",
      },
      null,
      2,
    ) + "\n",
  );
}

/* ------------------------------------------------------------------ *
 * 目録の状況 (GET /api/corpus)
 *
 * corpus.json の各論文に、この端末での状態を重ねて返す。
 *   ready      JSON があり読める
 *   buildable  XML はあるが JSON が無い (build すれば読める)
 *   fetchable  XML も無いが PMC EFetch で自動取得できる
 *   manual     自動取得の手段が無い (import-json 由来など)。fetch の URL を示す
 * ------------------------------------------------------------------ */

type PaperStatus = "ready" | "buildable" | "fetchable" | "manual";

function xmlPathFor(paper: Paper): string | null {
  if (!paper.source?.file) return null;
  if (!paper.redistributable) return privatePath(paper);
  return join(dirFor("data", "raw"), paper.source.file);
}

function paperStatus(paper: Paper): { status: PaperStatus; hasXml: boolean; hasJson: boolean } {
  const hasJson = findArticleFile(paper.id) !== null;
  const xml = xmlPathFor(paper);
  const hasXml = xml !== null && existsSync(xml);
  const status: PaperStatus = hasJson
    ? "ready"
    : hasXml
      ? "buildable"
      : !paper.redistributable && canEfetch(paper)
        ? "fetchable"
        : "manual";
  return { status, hasXml, hasJson };
}

function corpusView(): unknown {
  let papers: Paper[];
  try {
    papers = loadManifest().papers;
  } catch (e) {
    return { error: (e as Error).message };
  }
  return {
    consent: hasConsent(),
    papers: papers.map((p) => ({
      id: p.id,
      doi: p.doi,
      pmcid: p.pmcid,
      title: p.title,
      firstAuthor: p.firstAuthor,
      journal: p.journal,
      year: p.year,
      redistributable: p.redistributable,
      licenseBasis: p.licenseBasis,
      fetch: p.fetch,
      ...paperStatus(p),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * ジョブ (POST /api/jobs/* と /api/figures/{id})
 *
 * ここだけが**外に出て行き、ファイルを書く**口。読むだけの他の口とは
 * 性質が違うので、条件を絞ってある:
 *
 *   - POST のみ。GET で副作用を起こさない
 *   - Origin が他サイトなら拒否。127.0.0.1 に bind していても、利用者が
 *     開いている**別のページ**から fetch は飛んでくる (ブラウザは
 *     クロスオリジンでも POST 自体は送る)。ローカル限定は防御にならない
 *   - 同時に 1 本だけ。並行させると配信元への同時アクセスになる
 *
 * 進捗は NDJSON で流す。取得は 1 枚ごとに待ちを入れるので、終わるまで
 * 無言だとブラウザ側で止まって見える。
 * ------------------------------------------------------------------ */

let runningJob: string | null = null;

function isLocalOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

type Send = (e: Record<string, unknown>) => void;

function failJson(res: import("node:http").ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
}

/**
 * NDJSON を流すジョブの共通の枠。POST 検査・Origin 検査・排他をここに集める。
 * run が投げても 200 を送り出したあとなのでステータスは変えられない。
 * 最後の 1 行で伝える (クライアントは done が来なければ失敗と見る)。
 */
async function runJob(
  name: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  run: (send: Send) => Promise<void>,
): Promise<void> {
  if (req.method !== "POST") return failJson(res, 405, "POST してください");
  const origin = req.headers.origin;
  if (origin && !isLocalOrigin(origin)) return failJson(res, 403, "他のオリジンからは実行できません");
  if (runningJob) return failJson(res, 409, `実行中の処理があります: ${runningJob}`);

  runningJob = name;
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache",
  });
  const send: Send = (e) => res.write(JSON.stringify(e) + "\n");
  try {
    await run(send);
  } catch (e) {
    send({ type: "error", message: (e as Error).message });
  } finally {
    runningJob = null;
    res.end();
  }
}

/** リクエストボディを JSON として読む。壊れていたら null。 */
async function readJsonBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* ------------------------------ 図版 (1 論文) ------------------------------ */

async function jobFigures(id: string, send: Send): Promise<void> {
  const file = findArticleFile(id);
  if (!file) throw new Error(`not found: ${id}`);
  await fetchFiguresFor(file, { onEvent: send as (e: FetchEvent) => void });
}

/* ------------------------------ 図版 (全論文) ------------------------------ */

async function jobFiguresAll(send: Send): Promise<void> {
  const files = listFiles();
  send({ type: "all-start", articles: files.length });
  let got = 0;
  let failed = 0;
  for (const file of files) {
    await fetchFiguresFor(file, {
      onEvent: (e) => {
        if (e.type === "done") {
          got += e.got;
          failed += e.failed;
        }
        send(e as unknown as Record<string, unknown>);
      },
    });
  }
  send({ type: "all-done", articles: files.length, got, failed });
}

/* ------------------------- ダウンロード (XML + build) ------------------------- *
 *
 * corpus の不足分を揃える。2 段階:
 *   1. 再配布不可で XML が無い論文を PMC EFetch で取得 (SHA-256 検証つき)
 *   2. raw にあるすべての XML を build (ハッシュ一致はスキップされるので冪等)
 *
 * 自動取得できない論文 (PMCID なし) は manual として報告するだけで、
 * ジョブ全体は止めない。
 */

async function jobDownload(send: Send): Promise<void> {
  if (!hasConsent()) {
    throw new Error("取得元の利用条件への同意が記録されていません (POST /api/consent が先です)");
  }
  const papers = loadManifest().papers;

  // 1. XML の取得
  for (const p of papers) {
    const { status, hasXml } = paperStatus(p);
    if (status === "ready" || hasXml) continue;
    if (!canEfetch(p) || p.redistributable) {
      send({ type: "manual", id: p.id, fetch: p.fetch ?? null });
      continue;
    }
    send({ type: "fetching", id: p.id, title: p.title ?? "" });
    try {
      const result = await fetchPaper(p);
      send({ type: "fetched", id: p.id, result });
    } catch (e) {
      send({ type: "fetch-failed", id: p.id, message: (e as Error).message });
    }
  }

  // 2. build (両ルートの raw を全部。変更なしはスキップされる)
  let built = 0;
  let buildFailed = 0;
  for (const dir of readDirs("raw")) {
    const root = resolve(dir);
    if (!existsSync(root)) continue;
    for (const f of readdirSync(root).sort()) {
      if (![".xml", ".nxml", ".jats"].includes(extname(f).toLowerCase())) continue;
      const row = buildXmlFile(join(root, f));
      if (row.status === "skip") continue;
      if (row.status === "ok") built++;
      else buildFailed++;
      send({ type: "build", ...row });
    }
  }
  send({ type: "done", built, buildFailed });
}

/* ------------------------------- enrich ------------------------------- *
 *
 * 課金する処理なので、**実行前に見積もり (GET /api/enrich/estimate) を出し、
 * UI 側で確認ダイアログを挟む**。API キーは .env か環境変数から。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- パスごとに R が違う
const ENRICH_PASSES: Record<string, EnrichPass<any>> = {
  paragraph: paragraphPass,
  sentence: sentencePass,
};

interface EnrichTarget {
  article: Article;
  file: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pass: EnrichPass<any>;
  types: ReadonlySet<SectionType>;
  cache: EnrichCache;
}

function enrichTarget(id: string, passName: string, withMethods: boolean): EnrichTarget {
  const pass = ENRICH_PASSES[passName];
  if (!pass) throw new Error(`不明なパス: ${passName} (paragraph | sentence)`);
  const file = findArticleFile(id);
  if (!file) throw new Error(`not found: ${id}`);
  const article = readArticle(file);
  const types: ReadonlySet<SectionType> = withMethods
    ? new Set<SectionType>([...pass.defaultSections, "methods"])
    : pass.defaultSections;
  // 論文の JSON がある側にキャッシュも置く (要約の集合は派生物とみなされうる)
  const cache = new EnrichCache(dirFor(rootForArticle(id), "cache"), pass.name);
  return { article, file, pass, types, cache };
}

function enrichEstimate(id: string, passName: string, withMethods: boolean): unknown {
  const { article, pass, types, cache } = enrichTarget(id, passName, withMethods);
  const units = collectUnits(article, DEFAULT_MODEL, pass.promptVersion, types);
  const misses = units.filter((u) => cache.get(u.cacheKey) === null);
  const batches = batchUnits(misses, pass.defaultBatch);
  const { file, fromShell } = loadDotEnv();
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return {
    id,
    pass: pass.name,
    model: DEFAULT_MODEL,
    paragraphs: units.length,
    sentences: units.reduce((n, u) => n + u.sentences.length, 0),
    cached: units.length - misses.length,
    send: misses.length,
    requests: batches.length,
    hasKey,
    keySource: hasKey ? (fromShell ? "環境変数" : (file ?? ".env")) : null,
  };
}

async function jobEnrich(body: Record<string, unknown>, send: Send): Promise<void> {
  const id = String(body.id ?? "");
  const passName = String(body.pass ?? "paragraph");
  const withMethods = Boolean(body.withMethods);
  const { article, file, pass, types, cache } = enrichTarget(id, passName, withMethods);

  loadDotEnv();
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("ANTHROPIC_API_KEY がありません。プロジェクト直下の .env に設定してください");
  }

  const usage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  const caller = createModelCaller({
    model: DEFAULT_MODEL,
    pass,
    onUsage: (u) => {
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      usage.requests++;
    },
  });

  const stats = await enrichArticle(article, {
    pass,
    model: DEFAULT_MODEL,
    caller,
    cache,
    sectionTypes: types,
    onProgress: (message) => send({ type: "progress", message }),
  });
  writeFileSync(file, JSON.stringify(article, null, 2) + "\n", "utf8");

  const price = PRICES[DEFAULT_MODEL];
  const cost = price
    ? Number(((usage.inputTokens * price.in + usage.outputTokens * price.out) / 1e6).toFixed(4))
    : null;
  send({ type: "done", ...stats, usage, cost, model: DEFAULT_MODEL });
}

/* ------------------------------------------------------------------ */

function parseArgs(argv: string[]): { port: number } {
  let port = 5173;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") port = Number(argv[++i]);
    // 別ディレクトリを配る (モックデータでの表示確認など)
    else if (argv[i] === "--dir") ARTICLE_DIRS = [argv[++i]];
    else if (argv[i] === "--figures") FIGURE_DIRS = [argv[++i]];
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error("--port が不正です");
    process.exit(1);
  }
  return { port };
}

const { port } = parseArgs(process.argv.slice(2));

const handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/api/articles") return json(buildIndex());

  if (url.pathname === "/api/corpus") return json(corpusView());

  if (url.pathname === "/api/consent") {
    if (req.method !== "POST") return json({ error: "POST してください" }, 405);
    const origin = req.headers.origin;
    if (origin && !isLocalOrigin(origin)) return json({ error: "他のオリジンからは実行できません" }, 403);
    recordConsent();
    return json({ ok: true });
  }

  if (url.pathname === "/api/enrich/estimate") {
    try {
      return json(
        enrichEstimate(
          url.searchParams.get("id") ?? "",
          url.searchParams.get("pass") ?? "paragraph",
          url.searchParams.get("withMethods") === "1",
        ),
      );
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  if (url.pathname === "/api/jobs/download") {
    void runJob("download", req, res, (send) => jobDownload(send));
    return;
  }

  if (url.pathname === "/api/jobs/figures-all") {
    void runJob("figures-all", req, res, (send) => jobFiguresAll(send));
    return;
  }

  if (url.pathname === "/api/jobs/enrich") {
    void (async () => {
      const body = await readJsonBody(req);
      if (body === null) return failJson(res, 400, "JSON ボディが壊れています");
      await runJob("enrich", req, res, (send) => jobEnrich(body, send));
    })();
    return;
  }

  if (url.pathname.startsWith("/api/figures/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/figures/".length));
    void runJob(`figures:${id}`, req, res, (send) => jobFigures(id, send));
    return;
  }

  if (url.pathname.startsWith("/api/articles/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/articles/".length));
    const a = findArticle(id);
    return a ? json(a) : json({ error: `not found: ${id}` }, 404);
  }

  if (url.pathname.startsWith("/figures/")) return serveFigure(url.pathname, res);

  // ビューアの静的ファイル。src/viewer/ 直下の 1 階層だけを配る
  // (パス区切りを含む名前は弾く — figures と同じ理由で外に出さない)。
  const name = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const type = STATIC_TYPES[extname(name).toLowerCase()];
  if (type && !name.includes("/") && !name.includes("\\") && !name.startsWith(".")) {
    const file = join(HERE, name);
    if (existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      return res.end(readFileSync(file));
    }
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
};

/**
 * ループバックの **両方** を listen する。
 *
 * `localhost` は macOS では `::1` と `127.0.0.1` の両方に解決する。片方しか
 * bind していないと、IPv6 を先に試して falback しないクライアントで
 * ECONNREFUSED になる。外に出す気はないので、待ち受けるのはこの 2 つだけ
 * (`0.0.0.0` や `::` にはしない)。
 *
 * `::1` が使えない環境 (IPv6 無効) もあるので、そちらの失敗は致命的に
 * しない。127.0.0.1 が上がっていれば読める。
 */
const HOSTS = ["127.0.0.1", "::1"];
let listening = 0;

for (const host of HOSTS) {
  const server = createServer(handler);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `ポート ${port} は使用中です (${host})。\n` +
          `  既に起動していないか確認してください:  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
          `  別のポートで動かす:  npm run serve -- --port 5174`,
      );
      process.exit(1);
    }
    // IPv6 が無い環境では ::1 の bind に失敗する。127.0.0.1 が生きていれば続行。
    if (host === "::1") return;
    console.error(`${host} で待ち受けできません: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    if (++listening === 1) {
      const n = buildIndex().length;
      console.log(`論文 ${n} 件  →  http://localhost:${port}`);
    }
  });
}
