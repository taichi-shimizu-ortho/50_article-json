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
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Article } from "../types.js";
import { dirFor, readDirs, ROOTS } from "../paths.js";

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
 * 静的ファイルを配る唯一の口なので、**ディレクトリの外に出ないことを
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

  if (url.pathname.startsWith("/api/articles/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/articles/".length));
    const a = findArticle(id);
    return a ? json(a) : json({ error: `not found: ${id}` }, 404);
  }

  if (url.pathname.startsWith("/figures/")) return serveFigure(url.pathname, res);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = readFileSync(join(HERE, "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
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
