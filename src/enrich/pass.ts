/**
 * enrich の「パス」。
 *
 * 段落パス (role / gist / plain) と文パス (certainty / hedges / stats) は
 * プロンプトも出力の形も違うが、配管 — バッチ分割・キャッシュ・リトライ・
 * 原文との突き合わせ — は共通でいい。差分だけをこのインタフェースに切り出す。
 *
 * パスを分ける実利は課金にある。キャッシュキーに promptVersion が入っている
 * ので、片方のプロンプトを直しても、もう片方は引き直しにならない。
 */
import type { Paragraph, SectionType } from "../types.js";
import type { EnrichUnit } from "./units.js";

export interface EnrichPass<R> {
  /** キャッシュのサブディレクトリ名にも使う */
  name: string;
  /** プロンプトを変えたら上げる。キャッシュキーに入る。 */
  promptVersion: string;
  system: string;
  schema: Record<string, unknown>;
  /** このパスの既定の対象セクション */
  defaultSections: ReadonlySet<SectionType>;
  /** 1 リクエストあたりの文数の目安 (長さの代理指標) */
  defaultBatch: number;

  buildUserMessage(units: EnrichUnit[]): string;
  parse(raw: unknown, units: EnrichUnit[]): { byParagraph: Map<string, R>; warnings: string[] };

  /**
   * 応答がその段落について完全か。**不完全なものはキャッシュしない。**
   * 欠けたまま保存すると次回以降も欠けたままになり、原因が追えなくなる。
   */
  isComplete(result: R, unit: EnrichUnit): boolean;

  /**
   * キャッシュに入れる形。段落 id や文 id のような位置依存の情報は落とす。
   * セクションが 1 つ増えて番号がずれただけで全段落を引き直すと課金が再発生する。
   */
  toCache(result: R): unknown;
  /** キャッシュから戻す。形が合わなければ null (壊れたキャッシュは引き直す) */
  fromCache(cached: unknown, unit: EnrichUnit): R | null;

  /** 記事に書き込む。適用した項目数を返す。 */
  merge(paragraph: Paragraph, result: R, warnings: string[]): number;
}
