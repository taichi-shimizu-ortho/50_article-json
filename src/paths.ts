/**
 * データの置き場所。**公開用と非公開用の 2 系統がある。**
 *
 *   data/raw|articles|figures|cache      git 追跡下
 *   data/private/raw|articles|figures|cache   git 除外 (.gitignore で丸ごと)
 *
 * 再配布できない論文はすべて `data/private/` 以下に置く。`.gitignore` の
 * パターンで守るのではなく**追跡対象パスの外に出す**のが要点で、
 * `git add -f` や .gitignore の書き換えで静かに漏れることがなくなる。
 *
 * 分けるのは XML だけでは足りない:
 *   - `articles/*.json` の `paragraph.text` は原文そのもの
 *   - `figures/` は図版そのもの
 *   - `cache/` は要約だけだが、全段落ぶん並べれば派生物とみなされうる
 *
 * 判断の根拠は `data/corpus.json`。移動は `npm run corpus -- --update`。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export const PUBLIC_ROOT = "data";
export const PRIVATE_ROOT = "data/private";

/** 探索順に並べたルート。公開側が先。 */
export const ROOTS = [PUBLIC_ROOT, PRIVATE_ROOT] as const;

export type DataKind = "raw" | "articles" | "figures" | "cache";

export function dirFor(root: string, kind: DataKind): string {
  return kind === "cache" ? join(root, "cache", "enrich") : join(root, kind);
}

/** 読むときに見るディレクトリ (存在するものだけ)。公開側が先。 */
export function readDirs(kind: DataKind): string[] {
  return ROOTS.map((r) => dirFor(r, kind)).filter(existsSync);
}

/**
 * その論文を書き込むべきルート。
 *
 * **既にどちらかにあるならそこ。** 無ければ公開側。ライセンス判定で
 * 非公開に回すのは `npm run corpus -- --update` の仕事で、パースや enrich が
 * 勝手に動かすことはしない (判断を 1 箇所に閉じ込める)。
 */
export function rootForArticle(id: string): string {
  for (const root of ROOTS) {
    if (existsSync(join(dirFor(root, "articles"), `${id}.json`))) return root;
  }
  return PUBLIC_ROOT;
}

/** 論文 id から JSON の実パスを引く。無ければ null。 */
export function findArticleFile(id: string): string | null {
  for (const root of ROOTS) {
    const p = join(dirFor(root, "articles"), `${id}.json`);
    if (existsSync(p)) return p;
  }
  return null;
}
