/**
 * 論文の正規化スキーマ。
 *
 * 設計方針: パース段階では「原文から機械的に取れるもの」だけを埋める。
 * gist / plain_ja / role / stats などの LLM 派生フィールドは enrich 段階で
 * 後付けするため、ここでは optional にしてある。
 *
 * 派生フィールドは必ず span で原文位置に紐づけること。要約だけが残ると
 * 検証不能になる。
 */

/** 段落テキスト内のインライン要素。span は paragraph.text 上のオフセット [start, end)。 */
export interface InlineMark {
  type:
    | "xref" // 引用・図表参照
    | "italic"
    | "bold"
    | "sup"
    | "sub"
    | "formula"
    | "ext-link"
    | "list-item";
  span: [number, number];
  /** xref の参照先 XML id (references[].xmlId / figures[].xmlId と対応) */
  rid?: string;
  /** bibr | fig | table | supplementary-material など */
  refType?: string;
  /** ext-link の URL */
  href?: string;
}

/** LLM が抽出する統計値。enrich 段階で付与。 */
export interface StatValue {
  metric?: string; // "p", "HR", "OARSI score" など
  value?: number;
  unit?: string;
  ci?: [number, number];
  p?: number;
  n?: number;
  /** paragraph.text 上の該当位置 */
  span?: [number, number];
  /** 何と何を比較した値か */
  comparison?: string;
}

/**
 * 断定度。連続値ではなく離散 4 段階にしてある。
 *
 * 0〜1 の連続値は較正が効かない。同じ文でも実行ごとに 0.3 と 0.45 が返り、
 * 閾値を決めても再現しない。判定に使えるのは結局「順序」だけなので、
 * 最初から順序尺度にしてある。UI の色分けにもそのまま使える。
 *
 *   measured    測定値・統計量を伴う事実の記述 (p 値、効果量、n)
 *   supported   文献または自データに裏付けられた記述。hedge なし
 *   hedged      may / might / suggest / appear などで留保された記述
 *   speculative 推測であることを著者自身が明示している記述
 */
export type Certainty = "measured" | "supported" | "hedged" | "speculative";

/**
 * 文。enrich の単位。
 *
 * 段落単位ではなく文単位にしてある理由: Discussion では測定結果と強い hedge が
 * 同じ段落に同居する。段落で 1 つの値に潰すと、見分けたかった区別そのものが消える。
 *
 * span はすべて paragraph.text 上のオフセットで、sentence.span からの相対では
 * ない。marks と同じ座標系に揃えることで、UI 側が段落テキスト 1 本に対して
 * ハイライトを重ねられる。
 */
export interface Sentence {
  /** 位置ベースの安定 ID: "s3-2-p1-s4" */
  id: string;
  /** paragraph.text 上の [start, end)。前後の空白は含まない。 */
  span: [number, number];

  // --- 以下 enrich 段階で付与 ---
  certainty?: Certainty;
  /**
   * 判定根拠になった hedge 表現の位置 (paragraph.text 上)。
   * "remains speculative" "may contribute" など。
   * UI で「なぜこの判定か」を原文上に示すために取る。
   */
  hedges?: Array<[number, number]>;
  stats?: StatValue[];
  gist?: string;
  plain?: string;
}

export type ParagraphRole =
  | "background"
  | "gap"
  | "objective"
  | "study_design"
  | "method"
  | "result"
  | "claim"
  | "interpretation"
  | "limitation"
  | "conclusion"
  | "other";

export interface Paragraph {
  /** 位置ベースの安定 ID: "s3-2-p1" */
  id: string;
  /** 元 XML の @id (あれば) */
  xmlId?: string;
  /** 空白正規化済みの本文。span はすべてこの文字列に対するオフセット。 */
  text: string;
  marks: InlineMark[];
  /** この段落から参照している文献の xmlId */
  refIds: string[];
  /** この段落から参照している図の xmlId */
  figIds: string[];
  /** この段落から参照している表の xmlId */
  tableIds: string[];
  /** 文分割の結果。パース段階で埋まる (LLM 不要の決定的処理)。 */
  sentences: Sentence[];

  // --- 以下 enrich 段階で付与 ---
  /** 段落の役割。これは段落単位で意味を持つので文には下ろさない。 */
  role?: ParagraphRole;
  /** 一文の要旨。走査してこの論文の骨子をつかむためのもの。 */
  gist?: string;
  /** 平易な英語での要約 (1〜3 文)。専門外の読者向け。 */
  plain?: string;
}

/** IMRaD に正規化したセクション種別 */
export type SectionType =
  | "abstract"
  | "introduction"
  | "methods"
  | "results"
  /** 症例報告の本体 (Case Report / Case Presentation)。IMRaD の results 相当 */
  | "case"
  | "discussion"
  | "conclusions"
  | "limitations"
  | "supplementary"
  | "acknowledgements"
  | "funding"
  | "conflicts"
  | "ethics"
  | "data-availability"
  | "abbreviations"
  | "other";

export interface Section {
  /** 位置ベースの安定 ID: "s3-2" */
  id: string;
  xmlId?: string;
  title?: string;
  /** 見出しの深さ。トップレベルが 1。 */
  level: number;
  type: SectionType;
  paragraphs: Paragraph[];
  sections: Section[];
}

export interface Figure {
  xmlId?: string;
  label?: string;
  caption?: string;
  /** XML に書かれているファイル名。URL でもデータでもない。 */
  graphics: string[];
  /**
   * `data/figures/{article.id}/` にある実ファイル名。`npm run figures` で埋まる。
   * graphics と別にしてあるのは拡張子が変わるため (.tif → .jpg)。
   * 未取得なら undefined で、ビューアはキャプションだけ出す。
   */
  files?: string[];
}

export interface TableItem {
  xmlId?: string;
  label?: string;
  caption?: string;
  /** thead/tbody を行×列に平坦化したもの。空なら未取得。 */
  rows: string[][];
  /**
   * 先頭から何行が `<thead>` 由来か。平坦化すると見出し行が判別できなくなるので
   * 行数だけ持つ。0 なら見出し無し (先頭行を見出しと決め打ちしない)。
   */
  headerRows: number;
  footnotes: string[];
}

export interface Reference {
  /** 元 XML の @id。xref.rid はこれを指す。 */
  xmlId?: string;
  /** 本文中の表示番号 (label があれば) */
  label?: string;
  authors: string[];
  title?: string;
  source?: string;
  year?: string;
  volume?: string;
  pages?: string;
  doi?: string;
  pmid?: string;
  /** element-citation で構造化できなかった場合の生テキスト */
  raw?: string;
}

export interface Author {
  surname?: string;
  givenNames?: string;
  full: string;
  orcid?: string;
  /** 所属 (rid から解決済み) */
  affiliations: string[];
  corresponding: boolean;
}

export interface ArticleMeta {
  doi?: string;
  pmid?: string;
  pmcid?: string;
  title?: string;
  journal?: string;
  issn?: string;
  publisher?: string;
  year?: string;
  /** YYYY-MM-DD */
  pubDate?: string;
  volume?: string;
  issue?: string;
  fpage?: string;
  articleType?: string;
  keywords: string[];
  authors: Author[];
  licenseUrl?: string;
  licenseText?: string;
  /** <funding-group> 由来。back matter ではなく front にある。 */
  funding: string[];
}

/** 1 パス分の enrich 実行記録 */
export interface EnrichRecord {
  pass: string;
  model: string;
  /** プロンプトを変えたら上げる。キャッシュキーにも入る。 */
  promptVersion: string;
  enrichedAt: string;
  /** 適用した項目数 (段落パスなら段落数、文パスなら文数) / うちキャッシュ由来 */
  applied: number;
  cached: number;
  /** 検証で落とした LLM 出力の記録 */
  warnings: string[];
}

export interface Article {
  /** コーパス内の一意キー。DOI からスラグ化して生成。 */
  id: string;
  meta: ArticleMeta;
  /** 構造化抄録なら複数セクション、非構造なら 1 つ */
  abstract: Section[];
  sections: Section[];
  figures: Figure[];
  tables: TableItem[];
  references: Reference[];
  /** パース時に落とした / 判断に迷った箇所の記録 */
  warnings: string[];
  /**
   * enrich の実行記録。パス名 ("paragraph" / "sentence") をキーに持つ。
   * どのモデル・どのプロンプト版で付けた値かを残す。片方を回しても
   * もう片方の記録は消えない。
   */
  enrich?: Record<string, EnrichRecord>;
  source: {
    /** "pmc-jats" | "mdpi-jats" など。XML の内容から自動判定する。 */
    flavor: string;
    /** 入力ファイル名 (パスは含めない) */
    file?: string;
    /** 入力 XML の SHA-256。差分スキップの判定に使う。 */
    sha256?: string;
    parsedAt: string;
  };
}
