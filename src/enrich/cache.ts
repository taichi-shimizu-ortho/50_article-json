/**
 * enrich 結果のキャッシュ。
 *
 * これは速度のためではなく**課金のため**にある。1 論文 246 文で、コーパスを
 * 500 論文に広げると 12 万文になる。プロンプトを 1 文字直すたびに全部を
 * 投げ直していたら金額が洒落にならない。段落単位で内容ハッシュを取り、
 * 変わっていない段落は API を叩かずに復元する。
 *
 * 保存単位は段落。文単位だと文脈が変われば判定も変わるはずなのに
 * 古い判定が残ってしまう。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 保存する形。中身 (`data`) の解釈はパスに任せる。
 * ここは「段落の内容ハッシュ → 何か」の対応を保つだけにしておく。
 */
interface CacheEntry {
  cacheKey: string;
  pass: string;
  savedAt: string;
  data: unknown;
}

export class EnrichCache {
  private readonly dir: string;

  /** パスごとにサブディレクトリを切る (中身を目で追えるようにするため) */
  constructor(baseDir: string, private readonly pass: string) {
    this.dir = join(baseDir, pass);
  }

  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  get(cacheKey: string): unknown | null {
    const p = this.path(cacheKey);
    if (!existsSync(p)) return null;
    try {
      const entry = JSON.parse(readFileSync(p, "utf8")) as CacheEntry;
      return entry.data ?? null;
    } catch {
      return null; // 壊れたキャッシュは無視して引き直す
    }
  }

  set(cacheKey: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const entry: CacheEntry = {
      cacheKey,
      pass: this.pass,
      savedAt: new Date().toISOString(),
      data,
    };
    writeFileSync(this.path(cacheKey), JSON.stringify(entry, null, 2) + "\n", "utf8");
  }
}
