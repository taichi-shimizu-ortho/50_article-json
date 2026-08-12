import { DOMParser } from "@xmldom/xmldom";
import { classifySection, classifyNotesType, auditStructure } from "./sectionType.js";
import { splitSentences } from "./splitSentences.js";
import type {
  Article,
  ArticleMeta,
  Author,
  Figure,
  InlineMark,
  Paragraph,
  Reference,
  Section,
  SectionType,
  TableItem,
} from "../types.js";

/* ------------------------------------------------------------------ *
 * DOM ヘルパ
 * xmldom は querySelector を持たないので、必要な操作だけ薄く用意する。
 * ------------------------------------------------------------------ */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;

type El = any; // xmldom の Element。型定義が緩いので any で扱う。

function childElements(parent: El | null | undefined): El[] {
  if (!parent) return [];
  const out: El[] = [];
  const kids = parent.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.nodeType === ELEMENT_NODE) out.push(n);
  }
  return out;
}

/** 直下の子要素のうち tag に一致するもの */
function children(parent: El | null | undefined, tag: string): El[] {
  return childElements(parent).filter((n) => n.nodeName === tag);
}

/** 直下の子要素のうち tag に一致する最初のもの */
function child(parent: El | null | undefined, tag: string): El | null {
  return children(parent, tag)[0] ?? null;
}

/** 子孫を含めた検索 */
function deep(parent: El | null | undefined, tag: string): El[] {
  if (!parent || typeof parent.getElementsByTagName !== "function") return [];
  const list = parent.getElementsByTagName(tag);
  const out: El[] = [];
  for (let i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}

function deepFirst(parent: El | null | undefined, tag: string): El | null {
  return deep(parent, tag)[0] ?? null;
}

function attr(node: El | null | undefined, name: string): string | undefined {
  if (!node || typeof node.getAttribute !== "function") return undefined;
  const v = node.getAttribute(name);
  return v === null || v === "" ? undefined : v;
}

/** xlink:href は名前空間の扱いが実装依存なので両方見る */
function hrefOf(node: El | null | undefined): string | undefined {
  return attr(node, "xlink:href") ?? attr(node, "href");
}

/** 空白正規化した素のテキスト。span 追跡が不要な箇所用。 */
function plainText(node: El | null | undefined): string {
  if (!node) return "";
  let out = "";
  const walk = (n: El) => {
    if (n.nodeType === TEXT_NODE || n.nodeType === CDATA_NODE) {
      out += n.nodeValue ?? "";
      return;
    }
    const kids = n.childNodes;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) walk(kids[i]);
  };
  walk(node);
  return out.replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * span 安全なテキスト組み立て
 *
 * JATS は整形済みで出てくるので、テキストノードには改行とインデントが
 * 大量に入っている。ここで正規化しないと span がインデント込みになる。
 * かといって組み立て後に一括 replace すると、記録済みの span が全部ずれる。
 * → 追記時にインクリメンタルに畳む。既に書いた文字は絶対に書き換えない。
 * ------------------------------------------------------------------ */

class TextBuilder {
  private buf = "";

  append(raw: string): void {
    let s = raw.replace(/\s+/g, " ");
    if (s === "") return;
    if (this.buf === "") {
      s = s.replace(/^ /, ""); // 先頭の空白は落とす (後から trim すると span が壊れる)
    } else if (this.buf.endsWith(" ") && s.startsWith(" ")) {
      s = s.slice(1); // 空白の二重化を防ぐ
    }
    this.buf += s;
  }

  get length(): number {
    return this.buf.length;
  }

  /** 末尾の空白だけ落とす。末尾側の trim は先行 span を壊さない。 */
  finish(): string {
    return this.buf.replace(/ +$/, "");
  }
}

/* ------------------------------------------------------------------ *
 * インライン要素のシリアライズ
 * ------------------------------------------------------------------ */

/** 段落テキストから除外するブロック要素 (別途 figures/tables として収集する) */
const BLOCK_IN_P = new Set(["fig", "table-wrap", "supplementary-material", "boxed-text"]);

const MARK_TAGS: Record<string, InlineMark["type"]> = {
  italic: "italic",
  bold: "bold",
  sup: "sup",
  sub: "sub",
};

interface SerializeResult {
  text: string;
  marks: InlineMark[];
}

function serializeInline(node: El): SerializeResult {
  const tb = new TextBuilder();
  const marks: InlineMark[] = [];

  const walk = (n: El): void => {
    if (n.nodeType === TEXT_NODE || n.nodeType === CDATA_NODE) {
      tb.append(n.nodeValue ?? "");
      return;
    }
    if (n.nodeType !== ELEMENT_NODE) return;

    const tag: string = n.nodeName;

    if (BLOCK_IN_P.has(tag)) return; // 本文からは外す

    if (tag === "xref") {
      const start = tb.length;
      walkChildren(n);
      marks.push({
        type: "xref",
        span: [start, tb.length],
        rid: attr(n, "rid"),
        refType: attr(n, "ref-type"),
      });
      return;
    }

    if (tag === "ext-link" || tag === "uri") {
      const start = tb.length;
      walkChildren(n);
      marks.push({ type: "ext-link", span: [start, tb.length], href: hrefOf(n) });
      return;
    }

    if (tag === "inline-formula" || tag === "disp-formula") {
      const start = tb.length;
      // TeX があればそれを、なければ配下のテキストを拾う
      const tex = deepFirst(n, "tex-math");
      if (tex) tb.append(plainText(tex));
      else walkChildren(n);
      marks.push({ type: "formula", span: [start, tb.length] });
      return;
    }

    if (tag === "list") {
      // <list><list-item><p>...</p></list-item></list>。
      // <p> の中に <p> が入る入れ子なので、素直に再帰すると箇条書きが
      // 1 本の文字列に潰れて項目境界が消える。項目ごとに span を記録する。
      for (const item of children(n, "list-item")) {
        const start = tb.length;
        walkChildren(item);
        if (tb.length > start) {
          marks.push({ type: "list-item", span: [start, tb.length] });
          tb.append(" "); // 次の項目と地続きにならないよう区切る
        }
      }
      return;
    }

    const markType = MARK_TAGS[tag];
    if (markType) {
      const start = tb.length;
      walkChildren(n);
      marks.push({ type: markType, span: [start, tb.length] });
      return;
    }

    walkChildren(n);
  };

  const walkChildren = (n: El): void => {
    const kids = n.childNodes;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) walk(kids[i]);
  };

  walkChildren(node);

  const text = tb.finish();
  // 末尾を削った分、span がはみ出していたら詰める
  for (const m of marks) {
    if (m.span[1] > text.length) m.span[1] = text.length;
    if (m.span[0] > text.length) m.span[0] = text.length;
  }
  // 長さ 0 のマークは意味がないので落とす
  return { text, marks: marks.filter((m) => m.span[1] > m.span[0]) };
}

/* ------------------------------------------------------------------ *
 * 段落
 * ------------------------------------------------------------------ */

function parseParagraph(pEl: El, id: string): Paragraph {
  const { text, marks } = serializeInline(pEl);

  const refIds: string[] = [];
  const figIds: string[] = [];
  const tableIds: string[] = [];

  for (const m of marks) {
    if (m.type !== "xref" || !m.rid) continue;
    // rid は空白区切りで複数入りうる: rid="B1 B2 B3"
    const rids = m.rid.split(/\s+/).filter(Boolean);
    const bucket =
      m.refType === "bibr"
        ? refIds
        : m.refType === "fig"
          ? figIds
          : m.refType === "table"
            ? tableIds
            : null;
    if (bucket) for (const r of rids) if (!bucket.includes(r)) bucket.push(r);
  }

  // 箇条書きは終止符を持たない項目が多く、放っておくと段落全体が 1 文に潰れる。
  // 項目の先頭を強制的な文頭として渡す。
  const hardBreaks = marks.filter((m) => m.type === "list-item").map((m) => m.span[0]);
  // PMC 系は上付きの引用番号がピリオドの後に来る ("2.2%.1,2 These")。
  // 文分割側で跨げるように引用の位置を渡す。
  const citations = marks
    .filter((m) => m.type === "xref" && (m.refType === "bibr" || m.refType === undefined))
    .map((m) => m.span);

  return {
    id,
    xmlId: attr(pEl, "id"),
    text,
    marks,
    refIds,
    figIds,
    tableIds,
    sentences: splitSentences(text, hardBreaks, citations).map((span, i) => ({
      id: `${id}-s${i + 1}`,
      span,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * セクション (任意深度のネストを再帰的に平坦化)
 * ------------------------------------------------------------------ */

function parseSectionList(
  parent: El,
  idPrefix: string,
  level: number,
  parentType: SectionType | undefined,
  warnings: string[],
): Section[] {
  const secs = children(parent, "sec");
  return secs.map((secEl, i) => {
    const id = idPrefix ? `${idPrefix}-${i + 1}` : `s${i + 1}`;
    const titleEl = child(secEl, "title");
    const title = titleEl ? plainText(titleEl) : undefined;
    const type = classifySection({
      title,
      secType: attr(secEl, "sec-type"),
      level,
      parentType,
    });

    if (!title && level === 1) {
      warnings.push(`${id}: トップレベルセクションに title がありません`);
    }

    // 直下の <p> のみを拾う。孫の <sec> 配下は再帰側で処理する。
    const paragraphs = children(secEl, "p")
      .map((pEl, j) => parseParagraph(pEl, `${id}-p${j + 1}`))
      .filter((p) => p.text.length > 0);

    return {
      id,
      xmlId: attr(secEl, "id"),
      title,
      level,
      type,
      paragraphs,
      sections: parseSectionList(secEl, id, level + 1, type, warnings),
    };
  });
}

/** <sec> の外に落ちている <p> を拾い落とさないための救済 */
function parseLooseParagraphs(parent: El, idPrefix: string): Paragraph[] {
  return children(parent, "p")
    .map((pEl, i) => parseParagraph(pEl, `${idPrefix}-p${i + 1}`))
    .filter((p) => p.text.length > 0);
}

/* ------------------------------------------------------------------ *
 * 図・表・文献
 * ------------------------------------------------------------------ */

function parseFigures(root: El): Figure[] {
  return deep(root, "fig").map((figEl) => {
    const capEl = child(figEl, "caption");
    return {
      xmlId: attr(figEl, "id"),
      label: plainText(child(figEl, "label")) || undefined,
      caption: capEl ? plainText(capEl) || undefined : undefined,
      graphics: deep(figEl, "graphic")
        .map((g) => hrefOf(g))
        .filter((h): h is string => Boolean(h)),
    };
  });
}

function parseTables(root: El): TableItem[] {
  return deep(root, "table-wrap").map((twEl) => {
    const tableEl = deepFirst(twEl, "table");
    const rows: string[][] = [];
    let headerRows = 0;
    if (tableEl) {
      // thead を先に読む。平坦化すると見出し行が分からなくなるので行数を数えておく。
      const theadEl = deepFirst(tableEl, "thead");
      const readRows = (scope: El) => {
        for (const tr of deep(scope, "tr")) {
          const cells = childElements(tr)
            .filter((c) => c.nodeName === "td" || c.nodeName === "th")
            .map((c) => plainText(c));
          if (cells.length) rows.push(cells);
        }
      };
      if (theadEl) {
        readRows(theadEl);
        headerRows = rows.length;
      }
      // thead 以外の行。thead を二度読まないよう、既読分は飛ばす。
      const seen = headerRows;
      let i = 0;
      for (const tr of deep(tableEl, "tr")) {
        if (i++ < seen) continue;
        const cells = childElements(tr)
          .filter((c) => c.nodeName === "td" || c.nodeName === "th")
          .map((c) => plainText(c));
        if (cells.length) rows.push(cells);
      }
    }
    return {
      xmlId: attr(twEl, "id"),
      label: plainText(child(twEl, "label")) || undefined,
      caption: plainText(child(twEl, "caption")) || undefined,
      rows,
      headerRows,
      footnotes: deep(twEl, "fn").map((fn) => plainText(fn)).filter(Boolean),
    };
  });
}

function parseReferences(root: El): Reference[] {
  const refs: Reference[] = [];
  for (const refList of deep(root, "ref-list")) {
    for (const refEl of children(refList, "ref")) {
      const cite =
        child(refEl, "element-citation") ??
        child(refEl, "mixed-citation") ??
        child(refEl, "citation");

      const pubIds = deep(cite ?? refEl, "pub-id");
      const findPubId = (type: string) =>
        plainText(pubIds.find((p) => attr(p, "pub-id-type") === type)) || undefined;

      const authors = deep(cite ?? refEl, "name").map((n) => {
        const s = plainText(child(n, "surname"));
        const g = plainText(child(n, "given-names"));
        return [s, g].filter(Boolean).join(", ");
      });

      const isMixed = cite?.nodeName === "mixed-citation";
      const fpage = plainText(deepFirst(cite ?? refEl, "fpage"));
      const lpage = plainText(deepFirst(cite ?? refEl, "lpage"));

      refs.push({
        xmlId: attr(refEl, "id"),
        label: plainText(child(refEl, "label")) || undefined,
        authors,
        title:
          plainText(deepFirst(cite ?? refEl, "article-title")) ||
          plainText(deepFirst(cite ?? refEl, "chapter-title")) ||
          undefined,
        source: plainText(deepFirst(cite ?? refEl, "source")) || undefined,
        year: plainText(deepFirst(cite ?? refEl, "year")) || undefined,
        volume: plainText(deepFirst(cite ?? refEl, "volume")) || undefined,
        pages: [fpage, lpage].filter(Boolean).join("–") || undefined,
        doi: findPubId("doi"),
        pmid: findPubId("pmid"),
        // 構造化されていない mixed-citation は生テキストを残す
        raw: isMixed || !cite ? plainText(cite ?? refEl) || undefined : undefined,
      });
    }
  }
  return refs;
}

/* ------------------------------------------------------------------ *
 * メタデータ
 * ------------------------------------------------------------------ */

function parseAuthors(articleMeta: El, warnings: string[]): Author[] {
  // aff は contrib-group 内にも article-meta 直下にも置かれる
  const affMap = new Map<string, string>();
  for (const aff of deep(articleMeta, "aff")) {
    const id = attr(aff, "id");
    if (!id) continue;
    // <label>1</label> は所属名ではないので除く
    const labelEl = child(aff, "label");
    const label = labelEl ? plainText(labelEl) : "";
    let text = plainText(aff);
    if (label && text.startsWith(label)) text = text.slice(label.length).trim();
    affMap.set(id, text);
  }

  const authors: Author[] = [];
  for (const group of deep(articleMeta, "contrib-group")) {
    for (const c of children(group, "contrib")) {
      if (attr(c, "contrib-type") && attr(c, "contrib-type") !== "author") continue;
      const nameEl = child(c, "name") ?? child(c, "string-name");
      const surname = plainText(child(nameEl, "surname")) || undefined;
      const givenNames = plainText(child(nameEl, "given-names")) || undefined;
      const full =
        [givenNames, surname].filter(Boolean).join(" ") ||
        plainText(nameEl) ||
        plainText(child(c, "collab"));
      if (!full) continue;

      // PMC には <xref ref-type="aff"> を付けず、<aff> を 1 つだけ置く雑誌がある
      // (PMC3143999)。rid で引けないので、その場合だけ全員に割り当てる。
      // aff が複数あるときは推測できないので空のままにする。
      const affiliations = deep(c, "xref")
        .filter((x) => attr(x, "ref-type") === "aff")
        .flatMap((x) => (attr(x, "rid") ?? "").split(/\s+/))
        .map((rid) => affMap.get(rid))
        .filter((a): a is string => Boolean(a));
      if (affiliations.length === 0 && affMap.size === 1) {
        affiliations.push([...affMap.values()][0]);
      }

      const orcidEl = deep(c, "contrib-id").find(
        (e) => attr(e, "contrib-id-type") === "orcid",
      );

      // 責任著者の表現は 2 通りある。MDPI は後者。
      //   1. <contrib corresp="yes">
      //   2. <xref ref-type="corresp" rid="c1">*</xref>
      const corresponding =
        attr(c, "corresp") === "yes" ||
        deep(c, "xref").some((x) => attr(x, "ref-type") === "corresp");

      authors.push({
        surname,
        givenNames,
        full,
        orcid: orcidEl ? plainText(orcidEl) || undefined : undefined,
        affiliations,
        corresponding,
      });
    }
  }
  if (authors.length === 0) warnings.push("著者を抽出できませんでした");
  return authors;
}

/**
 * <funding-group> は back ではなく front/article-meta に置かれる。
 * back matter を舐めるだけでは Funding が丸ごと落ちる。
 */
function parseFunding(articleMeta: El | null): string[] {
  if (!articleMeta) return [];
  const out: string[] = [];
  for (const group of deep(articleMeta, "funding-group")) {
    for (const award of deep(group, "award-group")) {
      const source = plainText(deepFirst(award, "institution")) ||
        plainText(deepFirst(award, "funding-source"));
      const id = plainText(deepFirst(award, "award-id"));
      const entry = [source, id].filter(Boolean).join(" — ");
      if (entry) out.push(entry);
    }
    const statement = plainText(deepFirst(group, "funding-statement"));
    if (statement) out.push(statement);
  }
  return out;
}

function parseMeta(articleEl: El, warnings: string[]): ArticleMeta {
  const front = child(articleEl, "front");
  const journalMeta = child(front, "journal-meta");
  const articleMeta = child(front, "article-meta");

  const articleIds = deep(articleMeta, "article-id");
  const findId = (type: string) =>
    plainText(articleIds.find((e) => attr(e, "pub-id-type") === type)) || undefined;

  // pub-date は epub / ppub / collection と複数入る。epub を優先。
  const pubDates = deep(articleMeta, "pub-date");
  const pickDate =
    pubDates.find((d) => attr(d, "pub-type") === "epub") ??
    pubDates.find((d) => attr(d, "date-type") === "pub") ??
    pubDates[0];
  const year = plainText(child(pickDate, "year")) || undefined;
  const month = plainText(child(pickDate, "month"));
  const day = plainText(child(pickDate, "day"));
  const pubDate = year
    ? [year, month.padStart(2, "0") || "01", day.padStart(2, "0") || "01"].join("-")
    : undefined;

  const licenseEl = deepFirst(articleMeta, "license");
  // MDPI は <license> に xlink:href を付けず、<license-p> の中の
  // <ext-link> に CC の URL を置く。両方見ないと取りこぼす。
  const licenseUrl =
    hrefOf(licenseEl) ??
    deep(licenseEl, "ext-link")
      .map((e) => hrefOf(e))
      .find((h) => h && /creativecommons\.org|\/licenses?\//i.test(h));

  const meta: ArticleMeta = {
    doi: findId("doi"),
    pmid: findId("pmid"),
    pmcid: findId("pmc") ?? findId("pmcid"),
    title: plainText(deepFirst(child(articleMeta, "title-group"), "article-title")) || undefined,
    journal:
      plainText(deepFirst(journalMeta, "journal-title")) ||
      plainText(deepFirst(journalMeta, "abbrev-journal-title")) ||
      undefined,
    issn: plainText(deepFirst(journalMeta, "issn")) || undefined,
    publisher: plainText(deepFirst(journalMeta, "publisher-name")) || undefined,
    year,
    pubDate,
    volume: plainText(child(articleMeta, "volume")) || undefined,
    issue: plainText(child(articleMeta, "issue")) || undefined,
    fpage: plainText(child(articleMeta, "fpage")) || undefined,
    articleType: attr(articleEl, "article-type"),
    keywords: deep(articleMeta, "kwd").map((k) => plainText(k)).filter(Boolean),
    authors: articleMeta ? parseAuthors(articleMeta, warnings) : [],
    licenseUrl,
    licenseText: licenseEl ? plainText(licenseEl) || undefined : undefined,
    funding: parseFunding(articleMeta),
  };

  if (!meta.doi) warnings.push("DOI が見つかりません");
  if (!meta.title) warnings.push("タイトルが見つかりません");
  return meta;
}

/* ------------------------------------------------------------------ *
 * 抄録
 * ------------------------------------------------------------------ */

function parseAbstract(articleMeta: El | null, warnings: string[]): Section[] {
  if (!articleMeta) return [];
  // graphical abstract / teaser は除外し、通常の abstract のみ採用
  const absEl = deep(articleMeta, "abstract").find((a) => !attr(a, "abstract-type"));
  if (!absEl) return [];

  // 構造化抄録なら <sec> が入る
  const structured = parseSectionList(absEl, "abs", 1, "abstract", warnings);
  if (structured.length > 0) {
    return structured.map((s) => ({ ...s, type: "abstract" as SectionType }));
  }

  const paragraphs = parseLooseParagraphs(absEl, "abs");
  if (paragraphs.length === 0) return [];
  return [
    {
      id: "abs",
      title: plainText(child(absEl, "title")) || "Abstract",
      level: 1,
      type: "abstract",
      paragraphs,
      sections: [],
    },
  ];
}

/* ------------------------------------------------------------------ *
 * back matter
 *
 * JATS の back は <sec> だけではない。MDPI の実ファイルでは
 * Author Contributions / IRB / Data Availability が <notes>、
 * Acknowledgments が <ack>、Abbreviations が <glossary>、
 * Supplementary が <app-group><app> に入っていた。
 * <sec> しか見ないと COI 開示ごと丸ごと落ちる。
 * ------------------------------------------------------------------ */

/** back 直下で本文として扱う要素と、既定のセクション型 */
const BACK_CONTAINERS: Record<string, SectionType | undefined> = {
  sec: undefined, // タイトルから判定
  notes: undefined, // タイトル / notes-type から判定
  ack: "acknowledgements",
  glossary: "abbreviations",
  app: "supplementary",
  "funding-group": "funding",
  bio: "other",
};

/** 本文ではない図表の入れ物。取り込むと空セクションが残る。 */
const SKIP_SEC_TYPES = new Set(["display-objects", "supplementary-material"]);

function parseBackMatter(back: El, warnings: string[]): Section[] {
  const out: Section[] = [];

  // <app-group> は中の <app> を展開する
  const nodes: El[] = [];
  for (const n of childElements(back)) {
    if (n.nodeName === "app-group") nodes.push(...children(n, "app"));
    else nodes.push(n);
  }

  for (const n of nodes) {
    const tag: string = n.nodeName;
    if (!(tag in BACK_CONTAINERS)) continue; // ref-list, fn-group などは別処理

    const secType = attr(n, "sec-type");
    if (secType && SKIP_SEC_TYPES.has(secType)) continue;

    const id = `b${out.length + 1}`;
    const title = plainText(child(n, "title")) || undefined;

    const type =
      classifyNotesType(attr(n, "notes-type")) ??
      BACK_CONTAINERS[tag] ??
      classifySection({ title, secType, level: 1 });

    const paragraphs = children(n, "p")
      .map((pEl, j) => parseParagraph(pEl, `${id}-p${j + 1}`))
      .filter((p) => p.text.length > 0);

    const subs = parseSectionList(n, id, 2, type, warnings);

    if (paragraphs.length === 0 && subs.length === 0) continue;

    out.push({ id, xmlId: attr(n, "id"), title, level: 1, type, paragraphs, sections: subs });
  }
  return out;
}

/** 配下も含めて段落を持たないセクションを取り除く */
function pruneEmpty(sections: Section[]): Section[] {
  const hasText = (s: Section): boolean =>
    s.paragraphs.length > 0 || s.sections.some(hasText);
  return sections
    .filter(hasText)
    .map((s) => ({ ...s, sections: pruneEmpty(s.sections) }));
}

/* ------------------------------------------------------------------ *
 * エントリポイント
 * ------------------------------------------------------------------ */

export function slugFromDoi(doi: string | undefined, fallback: string): string {
  if (!doi) return fallback;
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/[^a-zA-Z0-9]+/g, "-");
}

export interface ParseOptions {
  /** 明示指定。省略時は XML の内容から自動判定する。 */
  flavor?: string;
  /** id 生成に失敗したときのフォールバック */
  fallbackId?: string;
  /** 入力ファイル名 (パスなし) */
  file?: string;
  /** 入力 XML の SHA-256 */
  sha256?: string;
}

/** どの経路で取得された XML かを内容から推定する。 */
function detectFlavor(articleEl: El, meta: ArticleMeta): string {
  if (meta.pmcid) return "pmc-jats";
  const publisher = (meta.publisher ?? "").toLowerCase();
  if (publisher.includes("mdpi")) return "mdpi-jats";
  if (publisher.includes("frontiers")) return "frontiers-jats";
  if (publisher.includes("elsevier")) return "elsevier-jats";
  // PMC 由来なら <article-meta> に custom-meta で pmc 情報が入ることが多い
  if (deep(articleEl, "article-id").some((e) => attr(e, "pub-id-type") === "pmc")) {
    return "pmc-jats";
  }
  return "jats";
}

export function parseJats(xml: string, options: ParseOptions = {}): Article {
  const warnings: string[] = [];

  const doc = new DOMParser({
    onError: (level: string, msg: string) => {
      if (level === "error" || level === "fatalError") {
        warnings.push(`XML パースエラー: ${msg}`);
      }
    },
  } as any).parseFromString(xml, "text/xml");

  // <article> はルート直下だが、PMC の一括配信では <pmc-articleset> で包まれる
  let articleEl: El | null = deepFirst(doc as unknown as El, "article");
  if (!articleEl) {
    throw new Error("<article> 要素が見つかりません。JATS XML ではない可能性があります。");
  }

  const meta = parseMeta(articleEl, warnings);
  const articleMeta = child(child(articleEl, "front"), "article-meta");
  const abstract = parseAbstract(articleMeta, warnings);

  const body = child(articleEl, "body");
  const back = child(articleEl, "back");

  let sections: Section[] = [];
  if (body) {
    sections = parseSectionList(body, "", 1, undefined, warnings);
    // <sec> でくくられていない直下の <p> があれば先頭に足す
    const loose = parseLooseParagraphs(body, "s0");
    if (loose.length > 0) {
      sections.unshift({
        id: "s0",
        level: 1,
        type: "other",
        paragraphs: loose,
        sections: [],
      });
      warnings.push("<sec> の外にある <p> を s0 として取り込みました");
    }
  } else {
    warnings.push("<body> がありません (抄録のみのレコードの可能性)");
  }

  // back matter。MDPI は <sec> ではなく <notes> / <ack> / <glossary> / <app> を使う。
  // COI や IRB は批判的に読むうえで重要なので取りこぼさない。
  if (back) {
    sections = sections.concat(parseBackMatter(back, warnings));
  }

  // 段落を 1 つも持たないセクションを落とす。
  // MDPI の <sec sec-type="display-objects"> ("Figures and Tables") のような
  // 図表の入れ物が空セクションとして残るため。
  sections = pruneEmpty(sections);

  warnings.push(
    ...auditStructure(
      sections.filter((s) => !s.id.startsWith("b")).map((s) => s.type),
      meta.articleType,
    ),
  );

  const article: Article = {
    id: slugFromDoi(meta.doi, options.fallbackId ?? "unknown"),
    meta,
    abstract,
    sections,
    figures: parseFigures(articleEl),
    tables: parseTables(articleEl),
    references: parseReferences(articleEl),
    warnings,
    source: {
      flavor: options.flavor ?? detectFlavor(articleEl, meta),
      file: options.file,
      sha256: options.sha256,
      parsedAt: new Date().toISOString(),
    },
  };

  return article;
}

/* ------------------------------------------------------------------ *
 * 集計ユーティリティ (検証用)
 * ------------------------------------------------------------------ */

export function flattenParagraphs(sections: Section[]): Paragraph[] {
  const out: Paragraph[] = [];
  const walk = (list: Section[]) => {
    for (const s of list) {
      out.push(...s.paragraphs);
      walk(s.sections);
    }
  };
  walk(sections);
  return out;
}

export function summarize(article: Article): string {
  const paras = flattenParagraphs(article.sections);
  const words = paras.reduce((n, p) => n + p.text.split(/\s+/).length, 0);
  const lines = [
    `id:         ${article.id}`,
    `title:      ${article.meta.title ?? "(なし)"}`,
    `journal:    ${article.meta.journal ?? "?"} ${article.meta.year ?? ""}`,
    `authors:    ${article.meta.authors.length} 名`,
    `abstract:   ${article.abstract.length} セクション / ${article.abstract.reduce((n, s) => n + s.paragraphs.length, 0)} 段落`,
    `sections:   ${article.sections.length} (トップレベル)`,
    `paragraphs: ${paras.length} / 約 ${words} 語`,
    `figures:    ${article.figures.length}`,
    `tables:     ${article.tables.length}`,
    `references: ${article.references.length}`,
  ];
  if (article.warnings.length) {
    lines.push(`warnings:`);
    for (const w of article.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}
