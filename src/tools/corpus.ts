#!/usr/bin/env -S npx tsx
/**
 * コーパスの目録と、再配布できない論文の隔離。
 *
 *   npm run corpus              現状を表示するだけ (何も書き換えない)
 *   npm run corpus -- --update  目録を作り直し、非再配布の論文を data/private/ へ移す
 *   npm run corpus -- --update --dry-run   移動の内容だけ見る
 *
 * ## なぜ目録が要るか
 *
 * **配れないのは著作物であって、書誌情報ではない。** DOI・PMCID・タイトル・
 * 著者は事実なので、再配布不可の論文でも目録には載せられる。載せておけば
 * 「このコーパスは何の論文でできているか」を公開でき、手元に無い論文は
 * 各自が取得すればいい。制約付きコーパスの標準的なやり方。
 *
 * ## 何を隔離するか
 *
 * **XML だけ外しても足りない。** `articles/*.json` の `paragraph.text` は
 * 原文そのもの、`figures/` は図版そのもの。`cache/` は要約だけだが、
 * 段落ごとの要約を全段落ぶん並べれば派生物とみなされうる。
 * だから非再配布の論文は **XML / JSON / 図版 / キャッシュのすべて**を移す。
 *
 * ## .gitignore のパターンではなくディレクトリで隔離する
 *
 * `data/private/` を丸ごと除外し、そこへ**物理的に移す**。パターンで守ると
 * `git add -f` や .gitignore の書き換えで静かに漏れるが、追跡対象パスの外に
 * 出てしまえば入りようがない。安全性がパターンではなく構造になる。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Article } from "../types.js";
import { dirFor, PRIVATE_ROOT, PUBLIC_ROOT, readDirs, ROOTS } from "../paths.js";

const MANIFEST = "data/corpus.json";

/* ------------------------------------------------------------------ *
 * 目録
 * ------------------------------------------------------------------ */

interface Entry {
  id: string;
  doi?: string;
  pmcid?: string;
  pmid?: string;
  title?: string;
  /** 第一著者のみ。目録は書誌の同定ができれば足りる。 */
  firstAuthor?: string;
  journal?: string;
  year?: string;
  licenseUrl?: string;
  licenseText?: string;
  /**
   * git に入れてよいか。**自動判定は保守的**で、はっきり許容と読めるとき
   * だけ true。判断を変えたいときは corpus.json の `licenseBasis` を
   * "manual" にして書き換える — --update はそれを尊重する。
   */
  redistributable: boolean;
  /** 自動判定の根拠。手で決めたなら "manual"。 */
  licenseBasis: string;
  /** 入力 XML の名前と SHA-256。各自が取得したものが同じか確かめられる。 */
  source?: { file?: string; sha256?: string };
  /** 手元に無いときの取得先 */
  fetch?: string;
}

interface Manifest {
  version: number;
  note: string;
  papers: Entry[];
}

/**
 * ライセンス文から再配布の可否を判定する。
 *
 * **迷ったら false。** NC / ND が入っていれば不可。CC BY と読めて NC/ND が
 * 無いときだけ true。ライセンス表記は出版社ごとに揺れるので、ここで拾えない
 * 形は corpus.json を手で直す前提にしてある。自動判定に賭けない。
 */
export function judgeLicense(text: string, url: string): { ok: boolean; basis: string } {
  const s = `${url} ${text}`.toLowerCase();
  if (/by-nc|noncommercial|non-commercial/.test(s)) return { ok: false, basis: "NC (再配布不可)" };
  if (/by-nd|noderiv/.test(s)) return { ok: false, basis: "ND (再配布不可)" };
  if (/creativecommons\.org\/licenses\/by\/|\bcc[\s-]?by\b/.test(s)) {
    return { ok: true, basis: "CC BY" };
  }
  if (s.trim() === "") return { ok: false, basis: "ライセンス表記なし" };
  return { ok: false, basis: "判定できず" };
}

function fetchUrl(a: Article): string | undefined {
  if (a.meta.pmcid) return `https://pmc.ncbi.nlm.nih.gov/articles/${a.meta.pmcid}/`;
  if (a.meta.doi) return `https://doi.org/${a.meta.doi}`;
  return undefined;
}

/** 公開側・非公開側の両方から論文を読む。どちらに居るかも返す。 */
function readArticles(): Array<{ article: Article; root: string }> {
  const out: Array<{ article: Article; root: string }> = [];
  for (const root of ROOTS) {
    const dir = dirFor(root, "articles");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        out.push({ article: JSON.parse(readFileSync(join(dir, f), "utf8")) as Article, root });
      } catch {
        console.error(`  読めない JSON を飛ばしました: ${join(dir, f)}`);
      }
    }
  }
  return out;
}

function loadManifest(): Manifest {
  if (!existsSync(MANIFEST)) return { version: 1, note: "", papers: [] };
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  } catch {
    console.error(`${MANIFEST} が壊れています。作り直します。`);
    return { version: 1, note: "", papers: [] };
  }
}

function entryFor(a: Article, prev?: Entry): Entry {
  const judged = judgeLicense(a.meta.licenseText ?? "", a.meta.licenseUrl ?? "");
  // 手で直した値は上書きしない。自動判定より人の判断が優先。
  const manual = prev?.licenseBasis === "manual";
  return {
    id: a.id,
    doi: a.meta.doi,
    pmcid: a.meta.pmcid,
    pmid: a.meta.pmid,
    title: a.meta.title,
    firstAuthor: a.meta.authors[0]?.surname ?? a.meta.authors[0]?.full,
    journal: a.meta.journal,
    year: a.meta.year,
    licenseUrl: a.meta.licenseUrl,
    licenseText: a.meta.licenseText?.slice(0, 200),
    redistributable: manual ? prev!.redistributable : judged.ok,
    licenseBasis: manual ? "manual" : judged.basis,
    source: { file: a.source.file, sha256: a.source.sha256 },
    fetch: fetchUrl(a),
  };
}

/* ------------------------------------------------------------------ *
 * この論文に属するファイル
 * ------------------------------------------------------------------ */

/**
 * 記事からキャッシュキーを再計算する。`src/enrich/units.ts` と同じ式。
 *
 * キャッシュのファイル名は内容ハッシュなので、名前からはどの論文のものか
 * 分からない。段落テキストから引き直すことで論文単位に切り分ける。
 */
function cacheKeysOf(a: Article): Set<string> {
  const keys = new Set<string>();
  const models = new Set<string>();
  const versions = new Set<string>();
  for (const e of Object.values(a.enrich ?? {})) {
    models.add(e.model);
    versions.add(e.promptVersion);
  }
  if (models.size === 0 || versions.size === 0) return keys;

  const walk = (sections: Article["sections"]) => {
    for (const s of sections) {
      for (const p of s.paragraphs) {
        const sentences = p.sentences.map((x) => x.span);
        if (sentences.length === 0) continue;
        for (const model of models) {
          for (const promptVersion of versions) {
            const h = createHash("sha256");
            h.update(JSON.stringify({ model, promptVersion, text: p.text, sentences }));
            keys.add(h.digest("hex").slice(0, 32));
          }
        }
      }
      walk(s.sections);
    }
  };
  walk(a.abstract);
  walk(a.sections);
  return keys;
}

interface Move {
  from: string;
  to: string;
}

/** この論文に属するファイルを、from ルートから to ルートへ動かす計画を作る。 */
function planMoves(a: Article, from: string, to: string): Move[] {
  const moves: Move[] = [];
  const add = (kind: Parameters<typeof dirFor>[1], name: string) => {
    const src = join(dirFor(from, kind), name);
    if (existsSync(src)) moves.push({ from: src, to: join(dirFor(to, kind), name) });
  };

  add("articles", `${a.id}.json`);
  if (a.source.file) add("raw", a.source.file);

  // 図版はディレクトリごと
  const figSrc = join(dirFor(from, "figures"), a.id);
  if (existsSync(figSrc)) moves.push({ from: figSrc, to: join(dirFor(to, "figures"), a.id) });

  // キャッシュはパスごとのサブディレクトリに散っている
  const cacheDir = dirFor(from, "cache");
  if (existsSync(cacheDir)) {
    const keys = cacheKeysOf(a);
    for (const pass of readdirSync(cacheDir)) {
      for (const key of keys) {
        const src = join(cacheDir, pass, `${key}.json`);
        if (existsSync(src)) {
          moves.push({ from: src, to: join(dirFor(to, "cache"), pass, `${key}.json`) });
        }
      }
    }
  }
  return moves;
}

/**
 * 持ち主を証明できないキャッシュを非公開側へ回す。
 *
 * **`cacheKeysOf` は現在の enrich 記録にあるモデル / プロンプト版の鍵しか作れない。**
 * プロンプトを更新すると古い版のキャッシュが残るが、記事の記録には新しい版しか
 * 書かれていないので、その古い鍵は誰のものか分からなくなる。
 *
 * 実際にこれで漏れかけた: 再配布不可の論文の要約 4 件が、`paragraph-1` 時代の
 * キャッシュとして公開側に取り残されていた。
 *
 * だから照合の向きを逆にする。**再配布可の論文が主張した鍵だけを公開側に残し、
 * 残りは全部 private に送る。** 判定できないものは公開しない (default deny)。
 * 公開可の論文の古い版キャッシュも巻き込まれるが、失うのは再取得可能な
 * キャッシュだけで、誤って公開するより害が小さい。
 */
function planOrphanCacheMoves(claimed: Set<string>): Move[] {
  const moves: Move[] = [];
  const cacheDir = dirFor(PUBLIC_ROOT, "cache");
  if (!existsSync(cacheDir)) return moves;

  for (const pass of readdirSync(cacheDir)) {
    const dir = join(cacheDir, pass);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // ファイルが直接置かれている場合など
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      if (claimed.has(name.replace(/\.json$/, ""))) continue;
      moves.push({
        from: join(dir, name),
        to: join(dirFor(PRIVATE_ROOT, "cache"), pass, name),
      });
    }
  }
  return moves;
}

function applyMoves(moves: Move[]): void {
  for (const m of moves) {
    mkdirSync(join(m.to, ".."), { recursive: true });
    renameSync(m.from, m.to);
  }
}

/* ------------------------------------------------------------------ *
 * 表示
 * ------------------------------------------------------------------ */

function report(manifest: Manifest): void {
  const here = new Map(readArticles().map((x) => [x.article.id, x.root]));
  console.log(`目録 ${manifest.papers.length} 件  (${MANIFEST})\n`);

  for (const p of manifest.papers) {
    const root = here.get(p.id);
    const where = root === PRIVATE_ROOT ? "data/private/ (git 除外)" : root ? "data/ (git 追跡)" : "手元に無い";
    console.log(`${root ? "●" : "○"} ${p.firstAuthor ?? "?"} ${p.year ?? ""}  — ${where}`);
    console.log(`   ${(p.title ?? "").slice(0, 70)}`);
    console.log(`   ${p.doi ?? ""}  ${p.pmcid ?? ""}`);
    console.log(`   ライセンス: ${p.licenseBasis}${p.redistributable ? "" : " → 再配布不可"}`);
    if (!root) console.log(`   取得先: ${p.fetch ?? "(不明)"}  → XML を data/raw/ に置いて npm run build`);
    console.log("");
  }

  const missing = manifest.papers.filter((p) => !here.has(p.id));
  const excluded = manifest.papers.filter((p) => !p.redistributable);
  console.log(`手元にある ${manifest.papers.length - missing.length} / 無い ${missing.length}`);
  console.log(`git 追跡 ${manifest.papers.length - excluded.length} / 除外 ${excluded.length}`);
  if (excluded.length > 0) {
    console.log(
      `\nclone しただけでは除外分は入らない。取得元の利用条件を確認したうえで、` +
        `\nnpm run fetch-private:accept を実行し、npm run build で変換する。`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function main(): void {
  const argv = process.argv.slice(2);
  const update = argv.includes("--update");
  const dryRun = argv.includes("--dry-run") || argv.includes("-n");

  const manifest = loadManifest();
  const prev = new Map(manifest.papers.map((p) => [p.id, p]));
  const found = readArticles();

  if (!update) {
    if (manifest.papers.length === 0) {
      console.log(`${MANIFEST} がありません。npm run corpus -- --update で作成します。`);
      return;
    }
    report(manifest);
    return;
  }

  // 目録を作り直す。既に目録にあって手元から消えた論文は **残す** —
  // 「このコーパスに含まれるが手元に無い」を表すのが目録の役目。
  const next = new Map(manifest.papers.map((p) => [p.id, p]));
  for (const { article } of found) next.set(article.id, entryFor(article, prev.get(article.id)));

  // 置き場所とライセンスが食い違っている論文を動かす
  const moves: Move[] = [];
  for (const { article, root } of found) {
    const want = next.get(article.id)!.redistributable ? PUBLIC_ROOT : PRIVATE_ROOT;
    if (root === want) continue;
    const plan = planMoves(article, root, want);
    if (plan.length === 0) continue;
    console.log(`${article.id}: ${root} → ${want}  (${plan.length} 件)`);
    for (const m of plan) console.log(`   ${m.from}  →  ${m.to}`);
    moves.push(...plan);
  }

  // 移動を反映したうえで、公開側に残ってよいキャッシュ鍵を集める。
  // 再配布可の論文が主張した鍵だけが残る資格を持つ。
  const claimed = new Set<string>();
  for (const { article } of found) {
    if (!next.get(article.id)!.redistributable) continue;
    for (const k of cacheKeysOf(article)) claimed.add(k);
  }
  const orphans = planOrphanCacheMoves(claimed).filter(
    // 上の移動計画と重複させない
    (m) => !moves.some((x) => x.from === m.from),
  );
  if (orphans.length > 0) {
    console.log(`\n持ち主不明のキャッシュ ${orphans.length} 件を private へ (default deny)`);
    for (const m of orphans) console.log(`   ${m.from}`);
    moves.push(...orphans);
  }

  if (dryRun) {
    console.log(`\n--dry-run: 何も変更していません (移動 ${moves.length} 件)`);
    return;
  }

  applyMoves(moves);
  const out: Manifest = {
    version: 1,
    note:
      "このコーパスを構成する論文の目録。書誌情報は事実なので全件載せる。" +
      "再配布できない論文の本文・図版・要約は data/private/ にあり git に入っていないので、" +
      "fetch から各自で取得すること。",
    papers: [...next.values()].sort((x, y) => x.id.localeCompare(y.id)),
  };
  writeFileSync(MANIFEST, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`\n${MANIFEST} を更新しました (移動 ${moves.length} 件)\n`);
  report(out);
}

main();
