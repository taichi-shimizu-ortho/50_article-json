/**
 * 文分割。
 *
 * なぜパーサ側にあるか: certainty (断定度) と stats は段落単位では機能しない。
 * Discussion では「有意差あり」という測定結果と「機序は推測の域を出ない」という
 * 強い hedge が同じ段落に同居する。段落で 1 つの値に平均すると、見分けたかった
 * 区別が消える。したがって文が enrich の単位になり、文分割はその前提条件になる。
 *
 * LLM は使わない。決定的処理なのでパーサの仕事にする。
 *
 * span はすべて paragraph.text 上のオフセット [start, end)。この不変条件は
 * marks / stats / hedges と共通で、UI の原文ハイライトが成立する根拠になる。
 *
 * 入力は TextBuilder が正規化済みのテキスト (改行なし・連続空白なし) を前提とする。
 */

/**
 * 文末になりえない略語。小文字化して照合する。
 *
 * 方針: **単位・時間の略語は入れない**。`min.` `sec.` `hr.` は
 * "incubated for 30 min. Cells were then..." のように実際に文末へ来る。
 * 辞書に入れると Materials and Methods がほとんど分割されなくなる。
 * 逆にここにあるものは「文末に来ることが実質ない」ものだけに絞ってある。
 */
const ABBREV = new Set([
  // 参照
  "fig.", "figs.", "tab.", "tabs.", "eq.", "eqs.", "ref.", "refs.",
  "suppl.", "supp.", "chap.", "vol.", "no.", "nos.", "pp.",
  // 学術表現
  "et.", "al.", "e.g.", "i.e.", "cf.", "vs.", "viz.", "resp.", "approx.", "ca.",
  // 敬称・学位
  "dr.", "prof.", "mr.", "mrs.", "ms.", "jr.", "sr.", "st.",
  "ph.d.", "m.d.", "d.v.m.", "b.sc.", "m.sc.",
  // 組織
  "inc.", "ltd.", "co.", "corp.", "univ.", "dept.", "natl.", "assoc.",
  // 投与経路
  "i.p.", "i.v.", "s.c.", "p.o.", "i.m.", "i.c.v.", "i.a.",
  // 国名
  "u.s.", "u.k.", "u.s.a.",
]);

/**
 * 単一大文字 + ピリオドの曖昧性を切るための、文頭に立ちやすい語。
 *
 * `J. Huard` はイニシャルなので文末ではない。`Group A. The other group` は文末。
 * 形が同じなので語彙で判定するしかない。既定はイニシャル扱い (分割しない) で、
 * 次の語がここにあるときだけ文末と見なす。
 */
const SENTENCE_STARTERS = new Set([
  "the", "this", "these", "those", "that", "a", "an", "it", "its",
  "we", "our", "they", "there", "here",
  "however", "therefore", "thus", "hence", "moreover", "furthermore",
  "additionally", "similarly", "conversely", "consistently", "notably",
  "importantly", "overall", "finally", "collectively", "together", "taken",
  "in", "on", "at", "by", "for", "from", "to", "as", "with", "within", "after",
  "before", "during", "when", "while", "although", "though", "because", "since",
  "if", "both", "all", "each", "no", "not", "these", "such", "given",
  "statistical", "data", "mice", "rats", "animals", "cells", "samples",
  "patients", "results", "values",
]);

/** 終端記号のあとに続きうる閉じ記号 */
const CLOSERS = new Set(['"', "'", "’", "”", ")", "]", "}", "»"]);

/** 文頭になりうる文字 (大文字・数字・開き括弧/引用符) */
function canStartSentence(ch: string): boolean {
  return /[\p{Lu}\p{Lt}0-9]/u.test(ch) || ["(", "[", '"', "“", "'"].includes(ch);
}

/**
 * 対応の取れた括弧の内側 [open, close] を列挙する。
 *
 * 括弧の内側にあるピリオドは文末になりえない。実データで
 * "(BD Biosciences, San Jose, CA, USA. Stem Flow Cat.# 562245)" が
 * 2 文に割れた。試薬の出所表記は住所・カタログ番号・国名がピリオドで
 * 並ぶので、略語辞書では追いつかない。
 *
 * 閉じていない括弧は無視する。図表除去などで開き括弧だけが残った段落で、
 * 以降が丸ごと 1 文に潰れるのを避けるため。
 */
function bracketRanges(text: string): Array<[number, number]> {
  const OPEN_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: Array<[string, number]> = [];
  const out: Array<[number, number]> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") {
      stack.push([c, i]);
      continue;
    }
    const open = OPEN_OF[c];
    if (!open) continue;
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k][0] === open) {
        out.push([stack[k][1], i]);
        stack.length = k; // 対応しなかった内側の開き括弧は捨てる
        break;
      }
    }
  }
  return out;
}

/** i の直前にある空白区切りの語 (i は含まない)。なければ "" */
function wordBefore(text: string, i: number): string {
  let s = i;
  while (s > 0 && text[s - 1] !== " ") s--;
  return text.slice(s, i);
}

/** i から始まる空白区切りの語。前後の括弧・引用符は落とす。 */
function wordAt(text: string, i: number): string {
  let e = i;
  while (e < text.length && text[e] !== " ") e++;
  return text.slice(i, e).replace(/^[([{"'“]+|[)\]}"'”,;:.]+$/g, "");
}

/**
 * dotIdx にある終端記号が文末かどうか。
 * nextStart は次の語の先頭 (空白の次) を指す。
 */
function isSentenceEnd(text: string, dotIdx: number, nextStart: number): boolean {
  if (!canStartSentence(text[nextStart])) return false;

  // ? ! は略語にならないので、文頭が成立していればそれで確定
  if (text[dotIdx] !== ".") return true;

  const raw = wordBefore(text, dotIdx);
  // "(Fig." "(e.g." のように開き括弧が語にくっついてくるので落とす。
  // 位置計算には raw の長さを使う。
  const word = raw.replace(/^[([{"'“]+/, "");
  if (ABBREV.has((word + ".").toLowerCase())) return false;

  // 単一大文字 + ピリオド。イニシャル (J. Huard) と単位 (37 °C.) が同形。
  if (word.length === 1 && /\p{Lu}/u.test(word)) {
    // 直前が数値なら測定値の末尾: "37 C." "pH 7.4 at 25 C."
    // "°C." は語が "°C" (2 文字) になるのでここには来ず、一般規則で文末になる。
    const prev = wordBefore(text, Math.max(0, dotIdx - raw.length - 1));
    if (/\d$/.test(prev)) return true;
    return SENTENCE_STARTERS.has(wordAt(text, nextStart).toLowerCase());
  }

  return true;
}

/**
 * 終止符の直後に張り付いた引用番号を読み飛ばす。
 *
 * PMC 系の雑誌は上付きの引用番号を**ピリオドの後**に置く:
 *   "...ranges between 0.6–2.2%.1,2 These complications occur..."
 * ピリオドの次が空白でないので文末と判定されず、実データで 4 文が 1 文に
 * 融合した。MDPI は "[1,2]." と括弧が前に来るのでこの形にならない。
 *
 * 数字の並びを正規表現で舐めると小数や測定値を巻き込むため、
 * **xref マークの位置**を使う。パーサが引用だと分かっているものだけ飛ばす。
 *
 * @returns 引用の連なりを越えた位置 (何もなければ k のまま)
 */
function skipCitations(text: string, k: number, citations: Map<number, number>): number {
  let cur = k;
  for (;;) {
    const end = citations.get(cur);
    if (end !== undefined && end > cur) {
      cur = end;
      continue;
    }
    // 引用と引用のあいだの区切り: "1,2" "5–7"
    if (cur > k && cur + 1 < text.length && /[,–-]/.test(text[cur]) && citations.has(cur + 1)) {
      cur += 1;
      continue;
    }
    return cur;
  }
}

/**
 * 文の開始位置 [start, end) を返す。
 *
 * @param text       段落テキスト (正規化済み)
 * @param hardBreaks 必ず文頭として扱う位置。箇条書きの項目先頭など。
 *                   項目が終止符を持たないと 1 文に潰れるため。
 * @param citations  引用 (xref) の span。終止符の直後に張り付く形に対処する。
 */
export function splitSentences(
  text: string,
  hardBreaks: number[] = [],
  citations: Array<[number, number]> = [],
): Array<[number, number]> {
  if (text.length === 0) return [];

  /** 「この位置から新しい文が始まる」集合 */
  const cuts = new Set<number>();
  for (const b of hardBreaks) {
    if (b > 0 && b < text.length && text[b] !== " ") cuts.add(b);
  }

  const brackets = bracketRanges(text);
  const insideBracket = (i: number) => brackets.some(([o, c]) => o < i && i < c);
  const citeStarts = new Map(citations.filter(([a, b]) => b > a).map(([a, b]) => [a, b]));

  for (let i = 0; i < text.length; i++) {
    if (!".?!".includes(text[i])) continue;
    if (insideBracket(i)) continue; // 括弧の内側は文末になりえない

    // "..." "?!" のような連続はまとめて 1 つの終端として扱う
    let end = i;
    while (end + 1 < text.length && ".?!".includes(text[end + 1])) end++;

    // 終端のあとの閉じ括弧・引用符を跨ぐ: `... speculative." The next`
    let k = end + 1;
    while (k < text.length && CLOSERS.has(text[k])) k++;
    // 終端に張り付いた上付き引用を跨ぐ: `...2.2%.1,2 These...`
    if (k < text.length && text[k] !== " ") k = skipCitations(text, k, citeStarts);

    // 空白が続かないなら文末ではない。小数 (0.05)、URL、"e.g." の内部がここで落ちる。
    if (k < text.length && text[k] === " " && k + 1 < text.length) {
      if (isSentenceEnd(text, i, k + 1)) cuts.add(k + 1);
    }
    i = end;
  }

  const starts = [0, ...[...cuts].sort((a, b) => a - b)];
  const spans: Array<[number, number]> = [];
  for (let n = 0; n < starts.length; n++) {
    const from = starts[n];
    const to = n + 1 < starts.length ? starts[n + 1] : text.length;
    // 次の文頭の直前にある区切り空白は文に含めない
    let s = from;
    let e = to;
    while (s < e && text[s] === " ") s++;
    while (e > s && text[e - 1] === " ") e--;
    if (e > s) spans.push([s, e]);
  }
  return spans;
}
