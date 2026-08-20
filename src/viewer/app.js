/**
 * ビューアのクライアント。ビルド手順なしの素の ES Module。
 *
 * 画面は 2 つ:
 *   - Library  … corpus の目録と取得状況。ダウンロード・図版・build を UI から実行
 *   - Article  … 論文 1 本。**セクションごとに 1 ページ**で、左の目次か ← → で移動
 *
 * ルーティングは location.hash:
 *   #library        ライブラリ
 *   #a/{id}/{page}  論文 id の page 番目のセクション
 */
const $ = (s) => document.querySelector(s);
const pick = $("#pick"), out = $("#out"), toc = $("#toc"), main = $("#out");

let list = [];        // /api/articles の索引
let corpus = null;    // /api/corpus の結果
let view = "article"; // "article" | "library"
let current = null;   // 表示中の Article
let pages = [];       // 表示中の論文のページ構成
let pageIdx = 0;
let showBody = true, showPlain = true, showFigs = true, showTables = true;

/* 図版と表。article.figures / article.tables は本文ツリーの外にあるので、
   「それを最初に参照した段落」の直後へ差し込む。ページを分けても図の行き先が
   変わらないよう、割り当ては論文の読み込み時に一度だけ計算する (figHome)。
   どこからも参照されないものは Figures & Tables ページにまとめる (落とさない)。 */
let figIndex = new Map();   // xmlId -> figure
let tabIndex = new Map();
let refIndex = new Map();   // xmlId -> reference
let numIndex = new Map();   // 表示番号 -> reference (範囲 [5–7] の内側を引く)
let figHome = new Map();    // xmlId -> 最初に参照した段落 id
let tabHome = new Map();

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/* ================================================================== *
 * 本文レンダリング (文分割・hedge・引用番号)
 * ================================================================== */

/**
 * 文献のリンク先。**PubMed を優先し、無ければ DOI。**
 * 実データでは 58 件中 45 件に PMID、残り 7 件は DOI のみ (両方無しは 0)。
 */
function refHref(r) {
  if (!r) return null;
  if (r.pmid) return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(r.pmid)}/`;
  if (r.doi) return `https://doi.org/${encodeURIComponent(r.doi)}`;
  return null;
}

/**
 * 段落に重ねる装飾を 1 本のリストにまとめる。
 *
 * hedge (文パス由来) と引用番号 (marks 由来) は**別々の由来だが同じ座標系**に
 * 乗っている。片方ずつ挿入するとオフセットが狂うので、先に統合して
 * 重なりを落としてから 1 回で流し込む。
 */
function decorations(p) {
  const out = [];
  for (const s of p.sentences ?? []) {
    for (const [a, b] of s.hedges ?? []) out.push({ a, b, kind: "hedge" });
  }
  for (const m of p.marks ?? []) {
    // 図表への xref は文献ではない
    if (m.type === "xref" && m.refType === "bibr") {
      out.push({ a: m.span[0], b: m.span[1], kind: "ref", rid: m.rid });
    }
  }
  out.sort((x, y) => x.a - y.a || y.b - x.b);
  const kept = [];
  let end = -1;
  for (const d of out) {
    if (d.a < end || d.b <= d.a) continue;
    kept.push(d);
    end = d.b;
  }
  return kept;
}

function renderDecoration(d, text) {
  if (d.kind === "hedge") return `<span class="hedge">${esc(text)}</span>`;
  const r = refIndex.get(d.rid);
  const href = refHref(r);
  return href
    ? `<a class="ref" href="${href}" target="_blank" rel="noopener" data-rid="${esc(d.rid ?? "")}">${esc(text)}</a>`
    : `<a class="ref dead" data-rid="${esc(d.rid ?? "")}">${esc(text)}</a>`;
}

/** 連続する文献番号の間にある区切りを、角括弧内で読みやすく整える。 */
function citationSeparator(text) {
  const compact = text.replace(/\s+/g, "").replace(/-/g, "–");
  if (compact === "," || compact === ";") return `${compact} `;
  return compact;
}

/**
 * 範囲表記を開く上限。番号のつもりで拾ったものがページ範囲などだった場合に、
 * 何十個もリンクを並べてしまわないための歯止め。
 */
const MAX_RANGE = 30;

/**
 * `[5–7]` を `[5, 6, 7]` にする。
 *
 * **XML にあるのは両端の xref だけ。** 間の 6 はどこにも現れないので、
 * 範囲のまま出すと 6 の書誌に到達する手段がなくなる。番号から文献を引いて
 * 内側を補う。開けないときは null を返して、呼び出し側が元の区切りを使う。
 */
function expandCitationRange(fromText, toText, rawSeparator) {
  if (!/^[–—-]$/.test(citationSeparator(rawSeparator))) return null;
  const a = Number(fromText.trim());
  const b = Number(toText.trim());
  // 番号として読めないもの (Fig. 2a のような添字付き) は触らない
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  if (b <= a || b - a > MAX_RANGE) return null;

  const middle = [];
  for (let n = a + 1; n < b; n++) middle.push(renderRefNumber(n));
  return middle.length ? `, ${middle.join(", ")}, ` : ", ";
}

/**
 * 番号だけから文献リンクを作る (範囲の内側用)。
 * 引けなければ数字をそのまま出す — 番号が見えていれば文献表から辿れる。
 */
function renderRefNumber(n) {
  const r = numIndex.get(n);
  return r?.xmlId ? renderDecoration({ kind: "ref", rid: r.xmlId }, String(n)) : esc(String(n));
}

/**
 * 同じ引用列の文献番号をまとめ、[1, 2, 3] の形で表示する。
 *
 * XMLでは各番号が別々のxrefなので、番号間が空白・カンマ・セミコロン・ダッシュ
 * だけの場合に同一列とみなす。各番号のリンクとdata-ridは残るため、ホバー書誌と
 * PubMed/DOIへのクリック遷移は従来どおり機能する。
 */
function citationRun(decos, start, p, limit) {
  const refs = [decos[start]];
  let next = start + 1;
  while (next < decos.length) {
    const prev = refs.at(-1);
    const candidate = decos[next];
    const between = p.text.slice(prev.b, candidate.a);
    if (candidate.kind !== "ref" || candidate.b > limit || !/^[\s,;–—-]*$/.test(between)) break;
    refs.push(candidate);
    next++;
  }
  return { refs, next };
}

/** 段落テキストを文ごとに切り、certainty / hedge / 引用リンクを重ねる */
function renderText(p) {
  const decos = decorations(p);
  const paint = (from, to) => {
    let s = "";
    let c = from;
    for (let i = 0; i < decos.length;) {
      const d = decos[i];
      if (d.a < c || d.b > to) {
        i++;
        continue;
      }
      if (d.kind !== "ref") {
        s += esc(p.text.slice(c, d.a));
        s += renderDecoration(d, p.text.slice(d.a, d.b));
        c = d.b;
        i++;
        continue;
      }
      const run = citationRun(decos, i, p, to);
      // **原文の角括弧を取り込む。** JATS の本文は "[1,2,3]" のように括弧まで
      // テキストに含み、xref が指すのは数字だけ。こちらでも括弧を足すので、
      // そのまま出すと "[[1, 2, 3]]" になる。原文側の括弧は捨てる。
      const runEnd = run.refs.at(-1).b;
      const absorb =
        d.a - 1 >= c && p.text[d.a - 1] === "[" && runEnd < to && p.text[runEnd] === "]";
      s += esc(p.text.slice(c, absorb ? d.a - 1 : d.a));
      s += `<span class="citation">[` + run.refs.map((ref, n) => {
        const text = p.text.slice(ref.a, ref.b);
        if (n === 0) return renderDecoration(ref, text);
        const prev = run.refs[n - 1];
        const raw = p.text.slice(prev.b, ref.a);
        // 範囲なら内側を補って出す。開けなければ元の区切りのまま。
        const expanded = expandCitationRange(p.text.slice(prev.a, prev.b), text, raw);
        return (expanded ?? esc(citationSeparator(raw))) + renderDecoration(ref, text);
      }).join("") + `]</span>`;
      c = absorb ? runEnd + 1 : runEnd;
      i = run.next;
    }
    return s + esc(p.text.slice(c, to));
  };

  if (!p.sentences?.length) return paint(0, p.text.length);

  let html = "";
  let cursor = 0;
  for (const s of p.sentences) {
    if (s.span[0] > cursor) html += paint(cursor, s.span[0]);
    const inner = paint(s.span[0], s.span[1]);
    html += s.certainty
      ? `<span class="s ${s.certainty}" title="${s.certainty}">${inner}</span>`
      : `<span class="s">${inner}</span>`;
    cursor = s.span[1];
  }
  return html + paint(cursor, p.text.length);
}

/* ================================================================== *
 * 図・表
 * ================================================================== */

/**
 * PMC 上の図版 URL。**ここだけが配信元を知っている。**
 * パターンが変わったらこの関数を直す。
 */
function pmcImageUrl(pmcid, name) {
  const numeric = String(pmcid).replace(/^PMC/i, "");
  return `https://pmc.ncbi.nlm.nih.gov/articles/instance/${numeric}/bin/${name}`;
}

/** .tif はブラウザで開けない。PMC は変換済みの .jpg を持っている。 */
const displayName = (href) => href.replace(/\.tiff?$/i, ".jpg");

/**
 * 図 1 枚。取得元は 3 段階に落とす。
 *
 *   1. data/figures/ のローカルファイル (npm run figures で取れたもの)
 *   2. PMC から直接 (ローカルに無いとき / ローカルが読めなかったとき)
 *   3. キャプションだけ
 *
 * 2 を持っているのは、スクリプト側の取得が PMC の bot 検知 (reCAPTCHA) に
 * 当たって落ちることがあるため。**ブラウザが自分で読みに行くぶんには通る** —
 * PMC のサイト自体がそうやって表示している。ローカルに置ければオフラインでも
 * 読めるので 1 を優先し、落ちた分だけ 2 で埋める。
 *
 * **1 の判断に fig.files を信用しない。** これは「取得した端末での記録」で、
 * article JSON に入って git に乗るのに、`data/figures/` 自体は git 管理外
 * (.gitignore)。別の端末でクローンすると files はあるのに実体が無い状態に
 * なる。src だけ見て決めると 404 のまま 2 に落ちないので、実際に読めなかった
 * ときの落とし先を data-fallback に持たせておく (拾うのは setupFigureFallback)。
 */
function renderFigure(fig, articleId, pmcid) {
  const cap =
    `<figcaption>${fig.label ? `<b>${esc(fig.label)}.</b> ` : ""}${esc(fig.caption ?? "")}</figcaption>`;

  const local = new Set(fig.files ?? []);
  const names = (fig.graphics ?? []).map(displayName);
  const sources = names.map((n) => {
    const remote = pmcid ? pmcImageUrl(pmcid, n) : null;
    const cached = local.has(n)
      ? `/figures/${encodeURIComponent(articleId)}/${encodeURIComponent(n)}`
      : null;
    // ローカルを試すときだけ落とし先を持つ。最初から PMC なら落ちる先はない。
    return { name: n, src: cached ?? remote, fallback: cached ? remote : null, remote: !cached };
  }).filter((s) => s.src);

  if (sources.length === 0) {
    return `<figure><div class="figmissing">` +
      `No image source — <code>${esc((fig.graphics ?? []).join(", "))}</code></div>${cap}</figure>`;
  }

  const imgs = sources.map((s) =>
    // 原寸で見たいことがあるので新しいタブへのリンクにしておく
    `<a href="${s.src}" target="_blank" rel="noopener">` +
      `<img src="${s.src}" alt="${esc(fig.label ?? "figure")}" loading="lazy"` +
      `${s.remote ? ' data-remote="1"' : ""}` +
      `${s.fallback ? ` data-fallback="${esc(s.fallback)}"` : ""}></a>`,
  ).join("");
  // PMC 由来であることは表示に出す。落ちてから出すこともあるので、
  // その可能性がある図には hidden で置いておいて後から見せる。
  const isRemote = sources.some((s) => s.remote);
  const mayFallBack = sources.some((s) => s.fallback);
  const note = isRemote || mayFallBack
    ? `<figcaption class="remote-note" style="opacity:.7"${isRemote ? "" : " hidden"}>` +
      `loaded from PMC (not cached locally)</figcaption>`
    : "";
  return `<figure>${imgs}${cap}${note}</figure>`;
}

/**
 * 表 1 つ。
 *
 * `rows` は thead/tbody を平坦化したものなので、見出し行は `headerRows` の
 * 行数だけ先頭から取る。**先頭行を見出しと決め打ちしない** — 見出しの無い表が
 * あるし、2 行にわたる表もある。
 */
function renderTable(t) {
  const head = Math.max(0, Math.min(t.headerRows ?? 0, (t.rows ?? []).length));
  const cell = (tag, v) => `<${tag}>${esc(v ?? "")}</${tag}>`;
  const thead = head > 0
    ? `<thead>${t.rows.slice(0, head)
        .map((r) => `<tr>${r.map((c) => cell("th", c)).join("")}</tr>`).join("")}</thead>`
    : "";
  const tbody = `<tbody>${t.rows.slice(head)
    .map((r) => `<tr>${r.map((c) => cell("td", c)).join("")}</tr>`).join("")}</tbody>`;

  const cap =
    `<figcaption>${t.label ? `<b>${esc(t.label)}.</b> ` : ""}${esc(t.caption ?? "")}</figcaption>`;
  const fn = (t.footnotes ?? []).length
    ? `<div class="fnote">${t.footnotes.map((f) => esc(f)).join("<br>")}</div>`
    : "";
  const body = (t.rows ?? []).length
    ? `<div class="tablewrap"><table>${thead}${tbody}</table></div>`
    : `<div class="figmissing">No table data in the XML</div>`;
  return `<figure>${body}${cap}${fn}</figure>`;
}

/** 図表の割り当て。論文の読み込み時に一度だけ、本文全体を歩いて決める。 */
function computePlacement(a) {
  figHome = new Map();
  tabHome = new Map();
  const walk = (secs) => {
    for (const s of secs) {
      for (const p of s.paragraphs) {
        for (const rid of p.figIds ?? []) {
          if (figIndex.has(rid) && !figHome.has(rid)) figHome.set(rid, p.id);
        }
        for (const rid of p.tableIds ?? []) {
          if (tabIndex.has(rid) && !tabHome.has(rid)) tabHome.set(rid, p.id);
        }
      }
      walk(s.sections);
    }
  };
  walk(a.abstract);
  walk(a.sections);
}

/** この段落が最初に参照した図表を、段落の直後に出す。 */
function figuresAfter(p, articleId, pmcid) {
  const out = [];
  if (showFigs) {
    for (const rid of p.figIds ?? []) {
      if (figHome.get(rid) !== p.id) continue;
      out.push(renderFigure(figIndex.get(rid), articleId, pmcid));
    }
  }
  if (showTables) {
    for (const rid of p.tableIds ?? []) {
      if (tabHome.get(rid) !== p.id) continue;
      out.push(renderTable(tabIndex.get(rid)));
    }
  }
  return out.join("");
}

function renderParagraph(p, articleId, pmcid) {
  const bits = [
    `<div class="para" data-pid="${esc(p.id)}"><span class="pid">${p.id}</span>` +
    `<button class="sp" data-pid="${esc(p.id)}" title="この段落を読み上げる">🔊</button>`,
  ];
  if (p.role) bits.push(`<span class="role">${esc(p.role)}</span>`);
  if (p.gist) bits.push(`<div class="gist">${esc(p.gist)}</div>`);
  if (p.plain && showPlain) bits.push(`<div class="plain">${esc(p.plain)}</div>`);
  if (showBody) {
    const dim = p.gist ? " dim" : "";
    bits.push(`<div class="body${dim}">${renderText(p)}</div>`);
  }
  bits.push("</div>");
  return bits.join("") + figuresAfter(p, articleId, pmcid);
}

function renderSections(list, articleId, pmcid, depth = 0) {
  return list.map((s) => {
    const tag = depth === 0 ? "h2" : "h3";
    const head = `<${tag}>${esc(s.title ?? s.type)} <span class="pid">${s.type}</span></${tag}>`;
    return head +
      s.paragraphs.map((p) => renderParagraph(p, articleId, pmcid)).join("") +
      renderSections(s.sections, articleId, pmcid, depth + 1);
  }).join("");
}

/* ================================================================== *
 * ページ構成 (セクション = 1 ページ)
 * ================================================================== */

/** back matter とみなすセクション種別。目次で 1 ページにまとめる。 */
const BACK_TYPES = new Set([
  "supplementary", "acknowledgements", "funding", "conflicts",
  "ethics", "data-availability", "abbreviations",
]);

/**
 * ページの並び。
 *   0        Overview — 書誌 + Abstract
 *   1..n     本文の最上位セクション (入れ子は同じページに出す)
 *   n+1      Back matter — 謝辞・利益相反などの短い後付け (あれば 1 ページに)
 *   n+2      References (あれば)
 *   n+3      Figures & Tables — 本文から参照されない図表 (あれば)
 */
function buildPages(a) {
  const out = [{ kind: "overview", label: a.abstract?.length ? "Abstract" : "Overview" }];

  // back matter は 1 段落ずつの短いセクションが 5〜8 個並ぶ。個別ページにすると
  // 目次が後付けで埋まるので、**最初の back matter 以降をまとめて 1 ページ**にする
  // (間に挟まる "other" — Author Contributions など — も一緒に回収する)。
  // 本文が "other" だけの論文 (import-json 由来) は back matter を持たないので影響しない。
  let backStart = a.sections.length;
  for (let i = 0; i < a.sections.length; i++) {
    if (BACK_TYPES.has(a.sections[i].type)) {
      backStart = i;
      break;
    }
  }
  for (const s of a.sections.slice(0, backStart)) {
    out.push({ kind: "section", label: s.title ?? s.type, type: s.type, section: s });
  }
  const back = a.sections.slice(backStart);
  if (back.length === 1) {
    out.push({ kind: "section", label: back[0].title ?? back[0].type, type: back[0].type, section: back[0] });
  } else if (back.length > 1) {
    out.push({ kind: "back", label: "Back matter", sections: back });
  }
  if ((a.references ?? []).length) {
    out.push({ kind: "references", label: "References", n: a.references.length });
  }
  const orphanFigs = (a.figures ?? []).filter((f) => !f.xmlId || !figHome.has(f.xmlId));
  const orphanTabs = (a.tables ?? []).filter((t) => !t.xmlId || !tabHome.has(t.xmlId));
  if (orphanFigs.length || orphanTabs.length) {
    out.push({ kind: "orphans", label: "Figures & Tables", orphanFigs, orphanTabs });
  }
  return out;
}

function renderOverview(a) {
  const m = a.meta;
  const authors = m.authors.map((x) => x.full).join(", ");
  const doi = m.doi ? ` · <a href="https://doi.org/${m.doi}" target="_blank" rel="noopener">${m.doi}</a>` : "";
  const pmc = m.pmcid ? ` · <a href="https://pmc.ncbi.nlm.nih.gov/articles/${m.pmcid}/" target="_blank" rel="noopener">${m.pmcid}</a>` : "";
  const passes = Object.values(a.enrich ?? {})
    .map((e) => `${e.pass}: ${e.applied}`).join(" · ") || "not enriched";
  return (
    `<h1>${esc(m.title ?? "")}</h1>` +
    `<div class="meta">${esc(authors)}<br>${esc(m.journal ?? "")} ${esc(m.year ?? "")}${doi}${pmc}` +
    `<br>${esc(passes)}${a.warnings.length ? ` · ${a.warnings.length} warnings` : ""}</div>` +
    renderSections(a.abstract, a.id, m.pmcid)
  );
}

/** 文献表。本文の引用ホバーだけでは一覧できないので、ページとして出す。 */
function renderReferences(a) {
  const items = (a.references ?? []).map((r, i) => {
    const n = Number((r.label ?? "").replace(/\D/g, "")) || i + 1;
    const href = refHref(r);
    const title = r.title ?? (r.raw ? r.raw.slice(0, 300) : "(タイトルなし)");
    const src = [r.source, r.year, r.volume, r.pages].filter(Boolean).join(" ");
    const go = href
      ? `<a href="${href}" target="_blank" rel="noopener">${r.pmid ? `PubMed ${esc(r.pmid)}` : "doi.org"} →</a>`
      : "";
    return `<li id="ref-${esc(r.xmlId ?? String(n))}"><span class="num">${n}</span>` +
      `<span><span class="au">${esc(formatAuthors(r.authors))}</span>` +
      `${r.authors?.length ? "<br>" : ""}<span class="t">${esc(title)}</span>` +
      `${src ? `<br><span class="src">${esc(src)}</span>` : ""}${go ? `<br>${go}` : ""}</span></li>`;
  }).join("");
  return `<h2>References <span class="pid">${(a.references ?? []).length}</span></h2><ol class="reflist">${items}</ol>`;
}

/** どの段落からも参照されなかった図表。落とさずに専用ページへ。 */
function renderOrphans(a, page) {
  let html = "";
  if (page.orphanFigs.length) {
    html += `<h2>Figures <span class="pid">not cited in text</span></h2>` +
      page.orphanFigs.map((f) => renderFigure(f, a.id, a.meta.pmcid)).join("");
  }
  if (page.orphanTabs.length) {
    html += `<h2>Tables <span class="pid">not cited in text</span></h2>` +
      page.orphanTabs.map(renderTable).join("");
  }
  return html;
}

function pagerHtml() {
  const prev = pages[pageIdx - 1];
  const next = pages[pageIdx + 1];
  return `<div class="pager">` +
    `<button id="pgPrev" ${prev ? "" : "disabled"}>← ${esc(prev?.label ?? "")}</button>` +
    `<span class="hint">${pageIdx + 1} / ${pages.length} · ← → キーでも移動</span>` +
    `<button id="pgNext" ${next ? "" : "disabled"}>${esc(next?.label ?? "")} →</button>` +
    `</div>`;
}

function renderToc() {
  const m = current.meta;
  toc.innerHTML =
    `<div class="paper">${esc(m.title ?? "")}</div>` +
    `<ol>` + pages.map((p, i) =>
      `<li><a href="#a/${encodeURIComponent(current.id)}/${i}" class="${i === pageIdx ? "on" : ""}">` +
        `${esc(p.label)}${p.kind === "references" ? ` <span class="n">${p.n}</span>` : ""}</a></li>`,
    ).join("") + `</ol>`;
}

function renderPage() {
  const a = current;
  const page = pages[pageIdx];
  let html;
  if (page.kind === "overview") html = renderOverview(a);
  else if (page.kind === "section") html = renderSections([page.section], a.id, a.meta.pmcid);
  else if (page.kind === "back") html = renderSections(page.sections, a.id, a.meta.pmcid);
  else if (page.kind === "references") html = renderReferences(a);
  else html = renderOrphans(a, page);

  out.innerHTML = html + pagerHtml();
  renderToc();
  // 読み上げ中のページ送りでも呼ばれるので、ハイライトを描き直す
  if (reading) highlightSpeaking(reading.units[reading.idx - 1]?.pid ?? null);
  else window.scrollTo(0, 0);
  updateTtsControls();
  $("#pgPrev")?.addEventListener("click", () => setPage(pageIdx - 1));
  $("#pgNext")?.addEventListener("click", () => setPage(pageIdx + 1));

  const hasCertainty = JSON.stringify(a).includes('"certainty"');
  $("#legend").innerHTML = hasCertainty
    ? `<i style="border-bottom:1px dotted var(--measured)">measured</i>` +
      `<i style="border:0;background:color-mix(in srgb,var(--hedged) 10%,transparent)">hedged</i>` +
      `<i style="border:0;background:color-mix(in srgb,var(--speculative) 13%,transparent)">speculative</i>` +
      `<i style="border:0;background:color-mix(in srgb,var(--hedged) 30%,transparent)">hedge cue</i>`
    : "";
}

function setPage(i, { updateHash = true, fromSpeech = false } = {}) {
  if (!current) return;
  // 手動でページを移ったら読み上げは止める (読み上げ側のページ送りでは止めない)
  if (!fromSpeech && reading) stopSpeech();
  pageIdx = Math.max(0, Math.min(i, pages.length - 1));
  localStorage.setItem(`page:${current.id}`, String(pageIdx));
  if (updateHash) {
    // 履歴を汚さない (セクション移動のたびに「戻る」が増えると論文間の行き来が埋まる)
    history.replaceState(null, "", `#a/${encodeURIComponent(current.id)}/${pageIdx}`);
  }
  renderPage();
}

/* ================================================================== *
 * 画面の切り替え (hash ルーティング)
 * ================================================================== */

function showArticleView() {
  view = "article";
  toc.hidden = false;
  main.classList.remove("wide");
  $("#getFigs").disabled = false;
  $("#enrichBtn").disabled = false;
  updateTtsControls();
}

async function loadArticle(id, idx) {
  showArticleView();
  if (current?.id !== id) {
    stopSpeech();
    out.innerHTML = '<p class="empty">Loading…</p>';
    toc.innerHTML = "";
    const r = await fetch(`/api/articles/${encodeURIComponent(id)}`);
    if (!r.ok) {
      out.innerHTML = '<p class="empty">Could not load this article.</p>';
      return;
    }
    const a = await r.json();
    current = a;
    localStorage.setItem("article", id);
    if (pick.value !== id) pick.value = id;

    figIndex = new Map((a.figures ?? []).filter((f) => f.xmlId).map((f) => [f.xmlId, f]));
    tabIndex = new Map((a.tables ?? []).filter((t) => t.xmlId).map((t) => [t.xmlId, t]));
    refIndex = new Map((a.references ?? []).filter((r) => r.xmlId).map((r) => [r.xmlId, r]));
    // label は "6." のように点が付く。数字だけ取る。label が無い版もあるので
    // その場合は並び順を番号とみなす (文献表の順 = 引用番号)。
    numIndex = new Map();
    (a.references ?? []).forEach((r, i) => {
      const n = Number((r.label ?? "").replace(/\D/g, "")) || i + 1;
      if (!numIndex.has(n)) numIndex.set(n, r);
    });
    computePlacement(a);
    pages = buildPages(a);
    indexParagraphLoc();
  }
  const saved = Number(localStorage.getItem(`page:${id}`) ?? 0);
  setPage(idx ?? (Number.isFinite(saved) ? saved : 0));
}

/** 表示中の論文を読み直す (enrich や図版取得のあと)。ページ位置は保つ。 */
async function reloadArticle() {
  if (!current) return;
  const id = current.id;
  const keep = pageIdx;
  current = null;
  await loadArticle(id, keep);
}

function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h === "library") return void showLibrary();
  const m = h.match(/^a\/(.+?)(?:\/(\d+))?$/);
  if (m && list.some((e) => e.id === m[1])) {
    return void loadArticle(m[1], m[2] !== undefined ? Number(m[2]) : null);
  }
  // 既定: 前回の論文 → 先頭の論文 → ライブラリ
  const saved = localStorage.getItem("article");
  if (saved && list.some((e) => e.id === saved)) return void loadArticle(saved, null);
  if (list.length) return void loadArticle(list[0].id, null);
  void showLibrary();
}

/* ================================================================== *
 * Library (corpus の目録と取得状況)
 * ================================================================== */

const STATUS_LABEL = {
  ready: "取得済み",
  buildable: "XML のみ (build 待ち)",
  fetchable: "未取得 (自動取得可)",
  manual: "未取得 (手動)",
};

async function fetchCorpus() {
  corpus = await (await fetch("/api/corpus")).json();
  return corpus;
}

async function showLibrary() {
  view = "library";
  stopSpeech();
  toc.hidden = true;
  main.classList.add("wide");
  $("#getFigs").disabled = true;
  $("#enrichBtn").disabled = true;
  updateTtsControls();
  out.innerHTML = '<p class="empty">Loading…</p>';
  await fetchCorpus();
  renderLibrary();
}

function renderLibrary() {
  if (view !== "library") return;
  if (corpus?.error) {
    out.innerHTML = `<p class="empty">${esc(corpus.error)}</p>`;
    return;
  }
  const papers = corpus?.papers ?? [];
  const missing = papers.filter((p) => p.status === "fetchable" || p.status === "buildable");

  const cards = papers.map((p) => {
    const entry = list.find((e) => e.id === p.id);
    const title = p.status === "ready"
      ? `<a href="#a/${encodeURIComponent(p.id)}">${esc(p.title ?? p.id)}</a>`
      : esc(p.title ?? p.id);
    const actions = [];
    if (p.status === "ready") {
      actions.push(`<a href="#a/${encodeURIComponent(p.id)}"><button>開く</button></a>`);
    } else if (p.status === "manual") {
      actions.push(
        `<span class="src">自動取得の手段がありません (PMCID なし)。` +
        (p.fetch ? `取得元: <a href="${esc(p.fetch)}" target="_blank" rel="noopener">${esc(p.fetch)}</a>` : "") +
        `</span>`,
      );
    }
    return `<div class="card">` +
      `<div class="t">${title}</div>` +
      `<div class="src">${esc(p.firstAuthor ?? "")} · ${esc(p.journal ?? "")} ${esc(p.year ?? "")}` +
      `${p.doi ? ` · ${esc(p.doi)}` : ""}</div>` +
      `<div class="row">` +
      `<span class="badge ${p.status}">${STATUS_LABEL[p.status]}</span>` +
      `<span class="badge">${p.redistributable ? "再配布可" : "再配布不可"} · ${esc(p.licenseBasis ?? "")}</span>` +
      (entry?.passes?.length ? `<span class="badge">enrich: ${esc(entry.passes.join(", "))}</span>` : "") +
      actions.join("") +
      `</div></div>`;
  }).join("");

  out.innerHTML =
    `<div class="libhead">` +
    `<h1 style="margin:0;flex:1">Library <span class="pid">${papers.length} 論文</span></h1>` +
    `<button id="dlAll" ${missing.length ? "" : "disabled"}>不足分を取得 (${missing.length})</button>` +
    `<button id="figsAll">全論文の図版を取得</button>` +
    `<span class="note">${esc(corpus.consent ? "取得元の利用条件への同意は記録済みです。" : "再配布不可の論文の取得には、初回に利用条件への同意が必要です。")}</span>` +
    `</div>` +
    cards +
    `<div class="joblog" id="libLog"></div>`;

  $("#dlAll")?.addEventListener("click", () => {
    if (corpus.consent) void runDownload($("#libLog"));
    else openConsent();
  });
  $("#figsAll")?.addEventListener("click", () => void runFiguresAll($("#libLog")));
}

/* ================================================================== *
 * ジョブの実行 (NDJSON ストリーム)
 * ================================================================== */

/** NDJSON の行を読む。行はチャンク境界をまたぐので、残りを持ち越す。 */
async function* readEvents(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // 最後は不完全かもしれないので残す
    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

/** ジョブを叩いてイベントを流す。HTTP エラーは例外にして呼び出し側で見せる。 */
async function* streamJob(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error ?? `HTTP ${res.status}`);
  }
  yield* readEvents(res);
}

function logTo(el, line) {
  if (!el) return;
  el.classList.add("on");
  el.textContent += (el.textContent ? "\n" : "") + line;
  el.scrollTop = el.scrollHeight;
}

function chip(text) {
  const el = $("#jobchip");
  if (text) {
    el.textContent = text;
    el.classList.add("on");
  } else {
    el.classList.remove("on");
  }
}

function downloadEventLine(e) {
  switch (e.type) {
    case "fetching": return `取得中  ${e.id}`;
    case "fetched": return `${e.result}    ${e.id}`;
    case "fetch-failed": return `失敗    ${e.id}  ${e.message}`;
    case "manual": return `手動    ${e.id} は自動取得できません${e.fetch ? ` (${e.fetch})` : ""}`;
    case "build": return e.status === "ok"
      ? `変換    ${e.file} → ${e.id}.json (${e.paragraphs} 段落${e.warnings ? `, ⚠ ${e.warnings}` : ""})`
      : `変換失敗 ${e.file}  ${e.message}`;
    case "done": return `完了: 変換 ${e.built} 件${e.buildFailed ? ` / 失敗 ${e.buildFailed} 件` : ""}`;
    case "error": return `エラー: ${e.message}`;
    default: return null;
  }
}

/** 不足分のダウンロード + build。log 先が無ければヘッダーのチップに出す。 */
async function runDownload(logEl) {
  let done = false;
  try {
    for await (const e of streamJob("/api/jobs/download")) {
      const line = downloadEventLine(e);
      if (line) {
        logTo(logEl, line);
        chip(line);
      }
      if (e.type === "done") done = true;
    }
  } catch (err) {
    logTo(logEl, `エラー: ${err.message}`);
    chip(`ダウンロード失敗: ${err.message}`);
  }
  if (!done) chip("ダウンロードが完了しませんでした (ログを確認)");
  else setTimeout(() => chip(null), 5000);
  await refreshIndex();
  if (view === "library") await showLibrary();
  else if (!current && list.length) route();
  return done;
}

async function runFiguresAll(logEl) {
  try {
    for await (const e of streamJob("/api/jobs/figures-all")) {
      if (e.type === "start") logTo(logEl, `${e.id}  (図 ${e.figures})`);
      else if (e.type === "image") logTo(logEl, `  ok   ${e.name}`);
      else if (e.type === "wait") logTo(logEl, `  待機 ${e.ms / 1000}s (${e.reason})`);
      else if (e.type === "failed") logTo(logEl, `  失敗 ${e.name}  ${e.message}`);
      else if (e.type === "note") logTo(logEl, `  ${e.message}`);
      else if (e.type === "done") logTo(logEl, `  取得 ${e.got} / 既存 ${e.skipped}${e.failed ? ` / 失敗 ${e.failed}` : ""}`);
      else if (e.type === "all-done") logTo(logEl, `完了: ${e.articles} 論文 / 取得 ${e.got} 枚${e.failed ? ` / 失敗 ${e.failed} 枚` : ""}`);
      else if (e.type === "error") logTo(logEl, `エラー: ${e.message}`);
    }
  } catch (err) {
    logTo(logEl, `エラー: ${err.message}`);
  }
  if (current) await reloadArticle();
}

/* ================================================================== *
 * 同意ダイアログ (初回のみ)
 * ================================================================== */

function openConsent() {
  const dlg = $("#consentDlg");
  const missing = (corpus?.papers ?? []).filter((p) => p.status === "fetchable");
  $("#consentList").innerHTML = missing.length
    ? `<ul>${missing.map((p) =>
        `<li>${esc(p.title ?? p.id)} <span class="pid">${esc(p.licenseBasis ?? "")}</span></li>`).join("")}</ul>`
    : "";
  $("#consentLog").textContent = "";
  $("#consentLog").classList.remove("on");
  $("#consentAccept").disabled = false;
  if (!dlg.open) dlg.showModal();
}

function setupConsent() {
  $("#consentLater").addEventListener("click", () => $("#consentDlg").close());
  $("#consentAccept").addEventListener("click", async () => {
    const btn = $("#consentAccept");
    btn.disabled = true;
    try {
      const r = await fetch("/api/consent", { method: "POST" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      corpus.consent = true;
      const ok = await runDownload($("#consentLog"));
      if (ok) setTimeout(() => $("#consentDlg").close(), 1200);
      else btn.disabled = false;
    } catch (err) {
      logTo($("#consentLog"), `エラー: ${err.message}`);
      btn.disabled = false;
    }
  });
}

/* ================================================================== *
 * enrich ダイアログ (課金があるので見積もり → 確認 → 実行)
 * ================================================================== */

function enrichParams() {
  return {
    id: current?.id ?? "",
    pass: $("#enrichPass").value,
    withMethods: $("#enrichMethods").checked,
  };
}

async function loadEstimate() {
  const est = $("#enrichEst");
  const warn = $("#enrichWarn");
  const run = $("#enrichRun");
  est.textContent = "見積もりを取得中…";
  warn.hidden = true;
  run.disabled = true;
  const p = enrichParams();
  try {
    const r = await fetch(
      `/api/enrich/estimate?id=${encodeURIComponent(p.id)}&pass=${p.pass}&withMethods=${p.withMethods ? 1 : 0}`,
    );
    const e = await r.json();
    if (!r.ok) throw new Error(e.error ?? `HTTP ${r.status}`);
    est.innerHTML =
      `モデル <b>${esc(e.model)}</b> / 対象 ${e.paragraphs} 段落 (${e.sentences} 文)<br>` +
      `キャッシュ済み ${e.cached} 段落 / 送信 ${e.send} 段落 / API リクエスト <b>${e.requests}</b> 件`;
    if (!e.hasKey) {
      warn.textContent = "ANTHROPIC_API_KEY が見つかりません。プロジェクト直下の .env に設定してからサーバを再起動してください。";
      warn.hidden = false;
    } else if (e.requests === 0) {
      est.innerHTML += "<br>すべてキャッシュ済みです。実行してもキャッシュから復元されるだけで課金はありません。";
      run.disabled = false;
    } else {
      run.disabled = false;
    }
  } catch (err) {
    est.textContent = `見積もりに失敗: ${err.message}`;
  }
}

function setupEnrich() {
  const dlg = $("#enrichDlg");
  $("#enrichBtn").addEventListener("click", () => {
    if (!current) return;
    $("#enrichLog").textContent = "";
    $("#enrichLog").classList.remove("on");
    dlg.showModal();
    void loadEstimate();
  });
  $("#enrichPass").addEventListener("change", () => void loadEstimate());
  $("#enrichMethods").addEventListener("change", () => void loadEstimate());
  $("#enrichCancel").addEventListener("click", () => dlg.close());
  $("#enrichRun").addEventListener("click", async () => {
    const run = $("#enrichRun");
    run.disabled = true;
    const log = $("#enrichLog");
    let done = false;
    try {
      for await (const e of streamJob("/api/jobs/enrich", enrichParams())) {
        if (e.type === "progress") logTo(log, e.message);
        else if (e.type === "error") logTo(log, `エラー: ${e.message}`);
        else if (e.type === "done") {
          done = true;
          logTo(log, `完了: ${e.applied} 件付与 (キャッシュ ${e.cached} / API ${e.requests} req)`);
          if (e.usage?.requests) {
            logTo(log, `トークン 入力 ${e.usage.inputTokens} / 出力 ${e.usage.outputTokens}` +
              (e.cost !== null ? ` / 概算 $${e.cost}` : ""));
          }
          for (const w of e.warnings ?? []) logTo(log, `! ${w}`);
        }
      }
    } catch (err) {
      logTo(log, `エラー: ${err.message}`);
    }
    run.disabled = false;
    if (done) await reloadArticle();
  });
}

/* ================================================================== *
 * 読み上げ (Web Speech API)
 *
 * 2 系統ある:
 *   - ヘッダの Read aloud … 現在のページの先頭から**最後のセクションまで**
 *     連続で読む。ページはついてくる (自動でめくり、読んでいる段落を
 *     ハイライト)。最初から読みたいときは Abstract ページで押す。
 *     Pause / Resume / Stop で操作する。
 *   - 段落の 🔊 … その段落だけ読む。読んでいる段落でもう一度押すと止まる。
 *
 * **音声は Google US English を名指しで優先する。** Chrome はこの音声を
 * 音声一覧で公開していて、手元の OS 音声より読みが安定している。入っていない
 * 端末のために en-US → en と落とす。テキストがブラウザの外に出ることはない。
 *
 * **文単位で utterance を分ける。** Chrome は長い utterance を数十秒で
 * 黙って打ち切ることがある (既知の挙動)。文分割は JSON の sentences から
 * もらえるので、それをそのまま単位にし、それでも長い文は語境界で割る。
 *
 * 停止と競合は token で守る。cancel() は保留中の utterance に onend/onerror を
 * 発火させるので、古い発話からの「次へ」が新しい再生に混ざらないようにする。
 * ================================================================== */

const synth = window.speechSynthesis ?? null;
let reading = null;   // { units, idx } 再生中だけ非 null
let readToken = 0;    // 世代番号。stopSpeech のたびに進める
let paraLoc = new Map(); // pid -> { p, page } (段落 🔊 用)
let enVoice;          // 選んだ英語音声 (undefined = 未探索, null = 見つからず)
let errorStreak = 0;  // 連続で失敗した utterance の数
/**
 * 一時停止しているか。**synth.paused を直接見ない** — pause() を呼んだ直後に
 * 読んでも false のままの実装があり (反映が非同期)、ボタンのラベルが
 * "Pause" のまま固まって再開の手段が画面から消える。こちらの意図を持つ。
 */
let speechPaused = false;

/** 1 発話の上限。Chrome は長い utterance を黙って打ち切ることがある。 */
const MAX_UTTERANCE = 240;

/** 立て続けにこれだけ失敗したら諦める (無音のまま延々進むのを防ぐ)。 */
const MAX_ERROR_STREAK = 3;

function speechAvailable() {
  return Boolean(synth) && "SpeechSynthesisUtterance" in window;
}

/**
 * 使う音声。**Google US English を名指しで優先する。**
 * 無ければ en-US、それも無ければ英語なら何でも。1 つも無ければ null を返して
 * utterance.lang = "en-US" に任せる (既定音声が日本語の環境で化けないように)。
 */
function preferredVoice() {
  if (enVoice !== undefined) return enVoice;
  const vs = synth?.getVoices() ?? [];
  if (!vs.length) return undefined; // まだロード中。次の発話で選び直す
  enVoice =
    vs.find((v) => v.name === "Google US English") ??
    vs.find((v) => /google.*us english/i.test(v.name)) ??
    vs.find((v) => /^en-US$/i.test(v.lang)) ??
    vs.find((v) => /^en[-_]?US/i.test(v.lang)) ??
    vs.find((v) => /^en/i.test(v.lang)) ??
    null;
  return enVoice;
}

function setTtsStatus(message) {
  $("#ttsStatus").textContent = message;
}

/** ボタンの活殺とラベル。再生中かどうかと paused でしか変わらない。 */
function updateTtsControls() {
  const ok = speechAvailable();
  const inArticle = ok && view === "article" && Boolean(current);
  const paused = Boolean(reading) && speechPaused;
  $("#ttsPlay").disabled = !inArticle || Boolean(reading);
  $("#ttsPause").disabled = !reading;
  $("#ttsStop").disabled = !reading;
  $("#readRate").disabled = !ok;
  $("#ttsPause").textContent = paused ? "Resume" : "Pause";
  $("#ttsPause").setAttribute("aria-pressed", String(paused));
}

/**
 * 長すぎる文を語境界で割る。**文の切れ目を優先し、足りないときだけ割る** —
 * 途中で切ると抑揚が崩れるので、上限を超える文にしか適用しない。
 */
function splitLong(text, max = MAX_UTTERANCE) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const out = [];
  let chunk = "";
  for (const word of t.split(" ")) {
    if (chunk && `${chunk} ${word}`.length > max) {
      out.push(chunk);
      chunk = word;
    } else {
      chunk = chunk ? `${chunk} ${word}` : word;
    }
  }
  if (chunk) out.push(chunk);
  return out;
}

function paragraphUnit(p, page) {
  const sentences = (p.sentences ?? [])
    .map((s) => p.text.slice(s.span[0], s.span[1]))
    .filter((t) => t.trim());
  const source = sentences.length ? sentences : [p.text];
  return { parts: source.flatMap((t) => splitLong(t)), page, pid: p.id };
}

/** ページ順の読み上げ単位 (セクション見出し + 段落)。図表・References は読まない。 */
function speechUnits() {
  const units = [];
  const collect = (secs, page) => {
    for (const s of secs) {
      if (s.title) units.push({ parts: splitLong(s.title), page, pid: null });
      for (const p of s.paragraphs) units.push(paragraphUnit(p, page));
      collect(s.sections, page);
    }
  };
  pages.forEach((page, i) => {
    if (page.kind === "overview") {
      if (current.meta.title) units.push({ parts: splitLong(current.meta.title), page: i, pid: null });
      collect(current.abstract, i);
    } else if (page.kind === "section") collect([page.section], i);
    else if (page.kind === "back") collect(page.sections, i);
  });
  return units.filter((u) => u.parts.length);
}

/** 段落 id → 段落とページ。🔊 のクリックから段落オブジェクトを引く。 */
function indexParagraphLoc() {
  paraLoc = new Map();
  const collect = (secs, page) => {
    for (const s of secs) {
      for (const p of s.paragraphs) paraLoc.set(p.id, { p, page });
      collect(s.sections, page);
    }
  };
  pages.forEach((page, i) => {
    if (page.kind === "overview") collect(current.abstract, i);
    else if (page.kind === "section") collect([page.section], i);
    else if (page.kind === "back") collect(page.sections, i);
  });
}

function highlightSpeaking(pid) {
  out.querySelectorAll(".para.speaking").forEach((el) => el.classList.remove("speaking"));
  if (!pid) return;
  const el = out.querySelector(`.para[data-pid="${CSS.escape(pid)}"]`);
  if (el) {
    el.classList.add("speaking");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * 止める。**cancel の前に resume する** — Chrome は一時停止中に cancel すると
 * 停止状態が残り、次の speak が鳴らないまま無反応になることがある。
 */
function stopSpeech(silent = false) {
  const wasReading = Boolean(reading);
  readToken++;
  reading = null;
  errorStreak = 0;
  if (synth) {
    // **cancel の前に resume する。** 一時停止中に cancel すると停止状態が
    // 残り、次の speak が鳴らないまま無反応になる実装がある。
    if (speechPaused || synth.paused) synth.resume();
    synth.cancel();
  }
  speechPaused = false;
  highlightSpeaking(null);
  if (!silent && wasReading) setTtsStatus("Reading stopped.");
  updateTtsControls();
}

function speakFrom(units, idx) {
  stopSpeech(true);
  if (!speechAvailable() || !units.length) return;
  reading = { units, idx };
  updateTtsControls();
  advanceSpeech(readToken);
}

function advanceSpeech(token) {
  if (token !== readToken || !reading) return;
  if (reading.idx >= reading.units.length) {
    stopSpeech(true);
    setTtsStatus("Finished reading.");
    return;
  }
  const u = reading.units[reading.idx++];
  if (view === "article" && u.page !== pageIdx) setPage(u.page, { fromSpeech: true });
  highlightSpeaking(u.pid);

  let i = 0;
  const next = () => {
    if (token !== readToken) return; // 止められた / 別の再生が始まった
    if (i >= u.parts.length) return advanceSpeech(token);
    const utt = new SpeechSynthesisUtterance(u.parts[i++]);
    utt.lang = "en-US";
    const voice = preferredVoice();
    if (voice) utt.voice = voice;
    utt.rate = Number($("#readRate").value) || 1;
    utt.onstart = () => {
      errorStreak = 0;
      setTtsStatus(`Reading with ${voice?.name ?? "an English (US) voice"}.`);
    };
    utt.onend = next;
    utt.onerror = (ev) => {
      // cancel 由来は token で弾ける。ここに来るのは本当の失敗だけ。
      // **1 文の失敗で全体を止めない** — ただし連続するなら鳴っていないので諦める。
      if (token !== readToken) return;
      if (++errorStreak >= MAX_ERROR_STREAK) {
        stopSpeech(true);
        setTtsStatus(`Could not continue reading (${ev.error ?? "speech error"}).`);
        return;
      }
      next();
    };
    synth.speak(utt);
  };
  next();
}

function toggleSpeechPause() {
  if (!reading) return;
  if (speechPaused) {
    speechPaused = false;
    synth.resume();
    setTtsStatus("Reading resumed.");
  } else {
    speechPaused = true;
    synth.pause();
    setTtsStatus("Reading paused.");
  }
  updateTtsControls();
}

function setupSpeech() {
  if (!speechAvailable()) {
    for (const id of ["#ttsPlay", "#ttsPause", "#ttsStop", "#readRate"]) $(id).disabled = true;
    setTtsStatus("Text-to-speech is not available in this browser.");
    return;
  }
  // 音声一覧は非同期に届く環境がある。届いたら選び直す。
  synth.addEventListener?.("voiceschanged", () => {
    enVoice = undefined;
    updateTtsControls();
  });

  $("#ttsPlay").addEventListener("click", () => {
    if (!current || view !== "article") return;
    const units = speechUnits();
    if (!units.length) return setTtsStatus("There is no article text to read.");
    // 現在のページの先頭から。読まないページ (References など) にいたら先頭から。
    let start = units.findIndex((x) => x.page >= pageIdx);
    if (start < 0) start = 0;
    speakFrom(units, start);
  });
  $("#ttsPause").addEventListener("click", toggleSpeechPause);
  $("#ttsStop").addEventListener("click", () => stopSpeech());

  // 速度変更は次の文から効く。再生成はしない (今の文を言い切ってから変わる)。

  // 段落の 🔊 (描画のたびに増えないよう out に 1 つだけ付ける)
  out.addEventListener("click", (ev) => {
    const sp = ev.target.closest("button.sp");
    if (!sp) return;
    const pid = sp.dataset.pid;
    // 同じ段落を読んでいる最中ならトグルで停止
    if (reading && reading.units.length === 1 && reading.units[0].pid === pid) {
      return stopSpeech();
    }
    const loc = paraLoc.get(pid);
    if (loc) speakFrom([paragraphUnit(loc.p, loc.page)], 0);
  });

  setTtsStatus("Ready to read aloud in US English.");
  updateTtsControls();
}

/* ================================================================== *
 * 引用のホバー表示
 *
 * 本文に出るのは "1" のような番号だけなので、それが何の文献かは開いて
 * みるまで分からない。ホバーで書誌を出し、クリックで PubMed に飛ばす。
 * イベントは main に 1 つだけ付ける (段落ごとに付けると再描画のたびに増える)。
 * ================================================================== */

/** 著者は 3 名まで。全部出すと本文より長くなる。 */
function formatAuthors(list) {
  const a = list ?? [];
  if (a.length === 0) return "";
  return a.length <= 3 ? a.join(", ") : `${a.slice(0, 3).join(", ")}, et al.`;
}

function tipHtml(r) {
  const src = [r.source, r.year, r.volume && `${r.volume}`, r.pages].filter(Boolean).join(" ");
  const go = r.pmid ? `PubMed ${r.pmid} →` : r.doi ? `doi.org →` : "リンクなし";
  // 構造化できなかった文献 (mixed-citation) は raw しか持たない。
  // title だけ見ていると「(タイトルなし)」になって、手がかりが何も出ない。
  const title = r.title ?? (r.raw ? r.raw.slice(0, 200) : null) ?? "(タイトルなし)";
  return (
    `<div class="a">${esc(formatAuthors(r.authors))}</div>` +
    `<div class="t">${esc(title)}</div>` +
    `<div class="s">${esc(src)}</div>` +
    `<div class="go">${esc(go)}</div>`
  );
}

function setupTooltip() {
  const tip = $("#tip");
  const hide = () => { tip.style.display = "none"; };

  out.addEventListener("mouseover", (ev) => {
    const el = ev.target.closest("a.ref");
    if (!el) return;
    const r = refIndex.get(el.dataset.rid);
    if (!r) return;
    tip.innerHTML = tipHtml(r);
    tip.style.display = "block";

    // 画面外にはみ出さない位置に寄せる。右端・下端で反転させる。
    const box = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const x = Math.max(8, Math.min(box.left, innerWidth - t.width - 8));
    const y = box.bottom + 8 + t.height > innerHeight ? box.top - t.height - 8 : box.bottom + 8;
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  });
  out.addEventListener("mouseout", (ev) => {
    if (ev.target.closest("a.ref")) hide();
  });
  // スクロールすると位置がずれるので消す
  addEventListener("scroll", hide, { passive: true });
}

/**
 * ローカルの図が読めなかったら PMC に切り替える。
 *
 * `error` は**バブルしない**ので capture で拾う (mouseover と同じように
 * out に 1 つだけ付ける。図ごとに付けると再描画のたびに増える)。
 * data-fallback は一度使ったら消す — 差し替えた PMC 側も落ちたときに
 * 無限に張り替えるのを防ぐ。
 */
function setupFigureFallback() {
  out.addEventListener("error", (ev) => {
    const img = ev.target;
    if (!(img instanceof HTMLImageElement)) return;
    const url = img.dataset.fallback;
    if (!url) return;
    delete img.dataset.fallback;

    img.dataset.remote = "1";
    img.src = url;
    const a = img.closest("a");
    if (a) a.href = url; // 原寸リンクも PMC に向け直す
    const note = img.closest("figure")?.querySelector(".remote-note");
    if (note) note.hidden = false;
  }, true);
}

/* ================================================================== *
 * 図版をローカルに取る (この論文だけ / POST /api/figures/{id})
 * ================================================================== */

function setupFigureFetch() {
  const btn = $("#getFigs");

  btn.addEventListener("click", async () => {
    if (!current || btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "取得中…";

    let done = null;
    let error = null;
    try {
      let n = 0;
      let total = 0;
      for await (const e of streamJob(`/api/figures/${encodeURIComponent(current.id)}`)) {
        if (e.type === "start") total = e.images;
        else if (e.type === "image" || e.type === "skip") btn.textContent = `取得中 ${++n}/${total}`;
        else if (e.type === "failed") { n++; error = `${e.name}: ${e.message}`; }
        else if (e.type === "wait") btn.textContent = `待機中 ${e.ms / 1000}s`;
        else if (e.type === "error") error = e.message;
        else if (e.type === "done") done = e;
      }
    } catch (e) {
      error = e.message;
    }

    // 取れた分を反映する。files が増えるので、再読み込みすればローカルを見に行く。
    if (done && done.got > 0) await reloadArticle();

    btn.disabled = false;
    if (error) btn.textContent = `失敗 (${error})`.slice(0, 40);
    else if (done) btn.textContent = done.got > 0 ? `${done.got} 枚取得` : "取得済み";
    else btn.textContent = label;
    // 結果は数秒だけ見せて元に戻す
    setTimeout(() => { btn.textContent = label; }, 4000);
  });
}

/* ================================================================== *
 * 初期化
 * ================================================================== */

async function refreshIndex() {
  list = await (await fetch("/api/articles")).json();
  pick.innerHTML = list
    .map((e) => `<option value="${esc(e.id)}">${esc(e.label)} — ${esc(e.title.slice(0, 60))}${e.title.length > 60 ? "…" : ""}</option>`)
    .join("");
  if (current && list.some((e) => e.id === current.id)) pick.value = current.id;
}

function setupHeader() {
  pick.addEventListener("change", () => { location.hash = `a/${encodeURIComponent(pick.value)}`; });
  $("#goLibrary").addEventListener("click", () => { location.hash = "library"; });
  const toggle = (btnId, get, set) => {
    $(btnId).addEventListener("click", (ev) => {
      set(!get());
      ev.target.setAttribute("aria-pressed", String(get()));
      if (current && view === "article") renderPage();
    });
  };
  toggle("#toggleBody", () => showBody, (v) => { showBody = v; });
  toggle("#togglePlain", () => showPlain, (v) => { showPlain = v; });
  toggle("#toggleFigs", () => showFigs, (v) => { showFigs = v; });
  toggle("#toggleTables", () => showTables, (v) => { showTables = v; });
}

function setupKeyboard() {
  addEventListener("keydown", (ev) => {
    if (view !== "article" || !current) return;
    if (ev.target instanceof HTMLElement &&
        /^(select|input|textarea)$/i.test(ev.target.tagName)) return;
    if (document.querySelector("dialog[open]")) return;
    if (ev.key === "ArrowLeft") { ev.preventDefault(); setPage(pageIdx - 1); }
    else if (ev.key === "ArrowRight") { ev.preventDefault(); setPage(pageIdx + 1); }
  });
}

async function init() {
  setupHeader();
  setupKeyboard();
  setupTooltip();
  setupFigureFallback();
  setupFigureFetch();
  setupConsent();
  setupEnrich();
  setupSpeech();

  await refreshIndex();
  addEventListener("hashchange", route);
  route();

  // corpus の状態を見て、初回は同意ダイアログ、同意済みなら不足分を静かに取得する
  try {
    await fetchCorpus();
    const missing = (corpus.papers ?? []).filter(
      (p) => p.status === "fetchable" || p.status === "buildable",
    );
    if (missing.length) {
      if (corpus.consent) {
        chip(`不足分 ${missing.length} 件を取得中…`);
        void runDownload(view === "library" ? $("#libLog") : null);
      } else {
        openConsent();
      }
    }
  } catch { /* corpus.json が無くても閲覧はできる */ }

  if (!list.length && view === "article") {
    // 論文がまだ 1 本も無い。ライブラリに誘導する (ダウンロード後に戻ってくる)
    out.innerHTML = '<p class="empty">論文がまだありません。ダウンロードが終わると表示されます。</p>';
  }
}
init();
