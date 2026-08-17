# article-json

医学論文の JATS XML を、セクション・段落単位の正規化 JSON に変換する。

## セットアップ

```bash
npm install
npm run verify     # 151 項目の検証 (API は叩かない)
npm run typecheck
```

## XML を手元に置く

`data/raw/` に XML を落としてから変換する。取得元の例:

| ソース | 取り方 |
|---|---|
| MDPI | 論文ページの Download → **Download XML**。URL は `https://www.mdpi.com/{issn}/{vol}/{issue}/{page}/xml` |
| PMC | 論文ページの Download → **XML** |
| PMC 一括 | OA Bulk の `.tar.gz` を展開すると `.nxml` が出てくる |

拡張子は `.xml` / `.nxml` / `.jats` を認識する。ファイル名は任意でよい
(出力名は XML 内の DOI から決まる)。

### 再配布不可の論文を各端末で取得する

再配布不可として扱う論文の XML・JSON・図版・要約は公開リポジトリに含めない。
目録にある PMC 論文は、**取得元の利用条件を確認し、ローカル利用の権限がある利用者だけ**
が次のコマンドを実行できる。Windows の PowerShell と macOS のターミナルで同じコマンドを使える。

```bash
npm run fetch-private:dry-run                # 保存先・取得先を表示するだけ
npm run fetch-private:accept                 # 非公開XMLを data/private/raw/ に取得
npm run build                                 # data/private/articles/ にJSONを生成
npm run figures:private                       # 非公開論文の図版を data/private/figures/ に取得
```

特定の論文だけを取得したい場合は、目録の `id`、DOI、または PMCID を指定する。

```bash
npx tsx src/tools/fetchPrivateXml.ts --id 10-4081-or-2011-e6 --accept-license
```

取得コマンドは公式 PMC E-utilities EFetch の単一レコード取得を使い、目録に記録した SHA-256 と
一致した XML だけを保存する。保存先の `data/private/` は `.gitignore` で丸ごと除外される。

### 別スクリプトが作った JSON を取り込む

論文抽出を別のパイプラインで済ませてある場合、その JSON から**最小 JATS を
組み立てて `npm run build` に渡す**。

```bash
npm run import-json:dry-run path/to/Dominici2006-6.json   # 生成される XML を見るだけ
npm run import-json        path/to/Dominici2006-6.json    # data/private/raw/ に保存
npm run build -- data/private/raw/{doi-slug}.xml
```

**JSON から JSON を直接作らない。** `parseJats` は 800 行あり、文分割・span
計算・セクション種別の分類・id の採番・派生値の引き継ぎがそこに集まっている。
XML を 1 枚作れば既存の経路がそのまま使えて、出力も他の論文と同じ形になる。

期待する入力は
`{ title, authors: string[], journal, year, doi, sourceUrl, sections: [{ title, type, paragraphs: string[] }] }`。
`type: "abstract"` は front の `<abstract>` に、それ以外は `<body>` の `<sec>` に入る。

置き場所は `data/private/`。出版社サイト由来で再配布可否を確認できないので、
`rootForInput()` が private と判定し、目録の判定でもライセンス表記が無いため
`redistributable: false` になる (default deny)。出所は `<self-uri>` に残す —
取り込み元をたどれないと後から真偽を確かめられない。

著者名は `"M. Dominici"` の形なので、**先頭のイニシャルだけを given-names と
みなして残りを姓にする**。末尾 1 語を姓と決め打ちすると `"K. Le Blanc"` が
`"Blanc"` になり、ビューアの表示名 (姓 + 年) が崩れる。

抽出元が本文を 1 セクションにまとめている場合、IMRaD の分類は `other` に
なって警告が出る。**これは取り込み側の情報の限界**であって、本文は失われて
いない (Dominici 2006 で 18 段落 / 54 文)。

## 使い方

```bash
npm run build                      # data/raw/ 以下を再帰的に全部
npm run build -- path/to/one.xml   # 単体
npm run build -- path/to/dir       # ディレクトリ指定
npm run build -- --force           # ハッシュが同じでも再パース
npm run build -- --out other/dir   # 出力先変更
npm run build -- --quiet           # 個別サマリを出さない
```

出力は `data/articles/{doi-slug}.json`。

### データの置き場所

`data/raw/` と `data/articles/` は **git 管理下に置く**方針にしてある
(`.gitignore` で除外していない)。理由は下の「データ管理」を参照。

**2 回目以降は変更のないファイルをスキップする。** 入力 XML の SHA-256 を
出力 JSON の `source.sha256` に埋めてあり、それと突き合わせている。

**上書きするときは LLM 由来の値を引き継ぐ。** スキップだけを保険にしていると、
`--force` やパーサの修正で enrich の結果 (課金して得た値) が消える。
引き継ぐのは `role` / `gist` / `plain`、文単位の `certainty` / `hedges` / `stats`、
`enrich` 記録、`figures[].files`、外部から解決した `meta.pmcid`。

ただし **本文が 1 文字でも変わった段落は引き継がない。** 要約は古い本文に
ついての記述なので、テキストが変われば無効になる。id が同じでも中身が違えば
別物として扱う — ここを緩めると、静かに嘘の要約が残る。

## 構成

```
src/types.ts                  スキーマ定義
src/ingest/parseJats.ts       パーサ本体
src/ingest/sectionType.ts     IMRaD 正規化
src/ingest/splitSentences.ts  文分割 (生物医学テキスト向け)
src/ingest/buildJson.ts       一括変換 CLI
src/enrich/units.ts           enrich の入力単位とキャッシュキー
src/enrich/pass.ts            パスのインタフェース (段落 / 文)
src/enrich/passes/paragraph.ts  段落パス: role / gist / plain
src/enrich/passes/sentence.ts   文パス: certainty / hedges / stats
src/enrich/cache.ts           段落単位のキャッシュ (パスごとに分離)
src/enrich/client.ts          Claude API 呼び出し (ここだけが通信する)
src/enrich/runEnrich.ts       enrich CLI
src/tools/show.ts             結果を端末で読むビューア
src/tools/fetchFigures.ts     図版を PMC から取得
src/tools/corpus.ts           目録の生成と、再配布不可論文の隔離
src/tools/importArticleJson.ts  別スクリプトの JSON を最小 JATS にして取り込む
src/paths.ts                  公開側 / 非公開側のパス解決
src/viewer/server.ts          ブラウザ用ビューアのサーバ (依存なし)
src/viewer/index.html         ビューア本体
test/fixture.jats.xml         検証用フィクスチャ
test/verify.ts                パーサの検証スクリプト
test/sentences.ts             文分割の単体テスト
test/enrich.ts                enrich の配管テスト (API を叩かない)
```

## ビューア

```bash
npm run serve                 # http://localhost:5173
npm run serve -- --port 8080
npm run serve -- --dir path/to/dir   # 別ディレクトリを配る
npm run serve -- --figures path/to/dir
```

論文はヘッダのプルダウンで切り替える。表示名は **第一著者の姓 + 年**
(`Zwolak 2011` / `Nishimura 2026`)。同じ著者・同じ年が複数あるときだけ
`a` / `b` を付けて区別する。選択は localStorage に残る。

段落サマリー (`gist` / `plain`) があれば本文の上に出し、`Full text` / `Plain`
ボタンで隠せる。文パスを回してあれば certainty も重なる。**UI は英語。**

図版と表は**それを最初に参照した段落の直後**に入る (`Figures` / `Tables`
ボタンで消せる)。`article.figures` / `article.tables` は本文ツリーの外にあるので、
描画しながら `paragraph.figIds` / `tableIds` を見て差し込んでいる。
どの段落からも参照されないものは末尾にまとめる (落とさない)。

`Fetch figures` ボタンで、表示中の論文の図版をローカルに保存できる
(`npm run figures` と同じ処理を `POST /api/figures/{id}` から呼ぶ)。
図版は git に入らないので**端末を移すたびに取り直しになる**が、
そのためにターミナルへ戻らなくて済む。終わったら記事を読み直すので、
そのまま `data/figures/` 側の表示に切り替わる。

取得は 1 枚ごとに待ちを入れるぶん数十秒かかる。サーバは進捗を NDJSON で
流し、ボタンのラベルが `取得中 3/7` のように変わる。

**この口だけが外に出て行き、ファイルを書く。** 読むだけの他の口とは性質が
違うので条件を絞ってある — POST のみ / 他オリジンからは 403 / id は
`data/articles/` に実在するものだけ / 同時に 1 本だけ。127.0.0.1 に bind
していても、利用者が開いている**別のページ**から POST は飛んでくるので、
ローカル限定であること自体は防御にならない。

**引用番号はホバーで書誌、クリックで PubMed。** 本文に出るのは `1` のような
番号だけなので、それが何の文献かは開くまで分からない。`marks` の xref
(`refType="bibr"`) を `<a>` にして、`rid` から `references[]` を引く。
リンク先は **PMID があれば PubMed、無ければ doi.org** (実データ 58 件中
45 件に PMID、7 件は DOI のみ、両方無しは 0)。図表への xref は文献ではないので
リンクにしない。

#### 範囲表記 `[5–7]` は `[5, 6, 7]` に開く

**XML にあるのは両端の xref だけ。** `[5–7]` は `<xref>5</xref>–<xref>7</xref>`
であって、間の 6 はどこにも現れない。範囲のまま出すと **6 の書誌に到達する
手段が無い** — ホバーもクリックも 5 と 7 にしか無く、読んでいて 6 が何なのか
分からないまま素通りすることになる。

そこで両端の番号から内側を補い、`numIndex` (表示番号 → 文献) で引いて
1 個ずつリンクにする。番号は `references[].label` (`"6."` のような形) の
数字部分から取る。label が無ければ文献表の並び順を番号とみなす。

開かない場合が 2 つある:

- **内側の番号が文献表に無いとき** — 数字だけ出す。リンクにならなくても、
  番号が見えていれば辿れる
- **範囲が広すぎるとき** (`MAX_RANGE` = 30 超) — 番号のつもりで拾ったものが
  別のものだった場合に、リンクを何十個も並べてしまわないための歯止め

なお、この展開で**描画結果は原文の文字列と一致しなくなる** (`5–7` → `5, 6, 7`)。
下の「textContent が原文と一致するか」は角括弧を付ける前の検証方法で、
引用の見た目を変えた時点で成り立たない。ずれの検査に使うなら引用部分を
除いて比べること。

hedge と引用番号は**由来が違うのに同じ座標系**に乗っている。片方ずつ挿入すると
オフセットが狂うので、`decorations()` で 1 本のリストに統合し、重なりを落として
から一度に流し込む。ずれていないことは「描画結果の textContent が原文と
一致するか」で検証できる (47 段落で一致を確認済み)。

表の見出し行は `TableItem.headerRows` で決める。`rows` は thead/tbody を
平坦化したものなので、**先頭行を見出しと決め打ちしない** — 見出しの無い表も
2 行にわたる表もある。横に長い表はページごと横スクロールさせず、
表の中だけでスクロールさせる。

サーバはループバックの **両方** (`127.0.0.1` と `::1`) を待ち受ける。
`localhost` は両方に解決するので、片方しか bind していないと IPv6 を先に
試すクライアントで繋がらない。外に出す気はないのでこの 2 つだけ
(`0.0.0.0` や `::` にはしない)。

**色付けは控えめにしてある。** 複数行の文を丸ごと下線にすると全部リンクの
ように見え、主役であるはずの hedge が埋もれる。`measured` は点線、
留保のある文だけ淡い地色、hedge 語だけ強めのハイライト。

依存は足していない (`node:http` だけ)。ビルド手順もなく、JSON は
リクエストごとに読み直すので enrich 後は再読み込みで反映される。

## データ管理

### git に入れる

| ディレクトリ | git | 理由 |
|---|---|---|
| `data/raw/` | 入れる | 小さく不変。パース結果を再現するための入力 |
| `data/articles/` | **入れる** | enrich 後は LLM 課金の成果物。失うと金銭的損失 |
| `data/cache/` | 任意 | 再実行コストの削減用。巨大化したら外す |
| `data/figures/` | 除外 | 取り直せる。バイナリを履歴に残す利点がない |
| `data/private/` | **除外** | 再配布できない論文の一式 (XML / JSON / 図版 / キャッシュ) |
| `data/corpus.json` | 入れる | 書誌情報は事実。全件載せる |

実測すると 1 論文あたり XML 160 KB + JSON 140 KB が、git 圧縮後は **88 KB**。
500 論文でも 45 MB 程度で、GitHub の制限には遠く及ばない。

`data/articles/` を入れるのが要点。enrich を通した後の JSON は
「再生成できるが有料」という性質になるので、コードより慎重に扱う価値がある。

### Dropbox には置かない

**git リポジトリを Dropbox 配下に置くのは避けること。** Dropbox が `.git/` の
内部ファイルを同期途中の状態で拾い、インデックス破損や `.git/objects` の
半端な同期を起こす事故が知られている。

複数マシンで共有したいなら private リポジトリを push するほうが安全で、
テキストの差分同期という意味でも Dropbox より適している。

### ライセンス — 再配布できない論文の隔離

**このリポジトリは public。** 論文全文が入るので、再配布の可否が実際の制約になる。

```bash
npm run corpus                        目録と現状を表示 (何も書き換えない)
npm run corpus -- --update            目録を作り直し、非再配布の論文を隔離
npm run corpus -- --update --dry-run  移動の内容だけ見る
```

#### 何を隔離するか

**XML だけ外しても足りない。**

| 対象 | 中身 |
|---|---|
| `raw/*.xml` | 原文そのもの |
| `articles/*.json` | `paragraph.text` が原文そのもの |
| `figures/` | 図版そのもの |
| `cache/` | 要約のみ。ただし全段落ぶん並べれば派生物とみなされうる |

4 つとも `data/private/` に移す。

#### パターンではなくディレクトリで隔離する

`data/private/` を丸ごと `.gitignore` し、そこへ**物理的に移す**。
`.gitignore` のパターンで守ると `git add -f` や設定の書き換えで静かに漏れるが、
追跡対象パスの外に出てしまえば入りようがない。**安全性がパターンではなく構造になる。**

手元で読むぶんには区別しない。ビューア・`show`・`enrich`・`figures` は
公開側と非公開側の両方を読む (`src/paths.ts`)。

#### 判定は保守的

`licenseBasis` に根拠が残る。**迷ったら再配布不可**にしてある:

| 判定 | 条件 |
|---|---|
| CC BY | `creativecommons.org/licenses/by/` または "CC BY" と読めて NC/ND が無い |
| NC / ND | `by-nc` `noncommercial` `by-nd` `noderiv` のいずれかを含む |
| ライセンス表記なし / 判定できず | **不可** |

出版社ごとに表記が揺れるので自動判定に賭けない。手で決めたいときは
`data/corpus.json` の `licenseBasis` を `"manual"` にして `redistributable` を
書き換える — `--update` はそれを尊重して上書きしない。

#### 目録は全件載せる

**配れないのは著作物であって、書誌情報ではない。** DOI・PMCID・タイトル・著者は
事実なので、再配布不可の論文も `data/corpus.json` には載る。だから
「このコーパスは何の論文でできているか」は公開でき、手元に無い論文は
`fetch` の URL から各自が取得すればいい。`source.sha256` があるので、
取得したものが同じファイルかを確認できる。

clone した人の手順:

```bash
npm run corpus       # ○ が付いているものが手元に無い論文
npm run fetch-private -- --accept-license  # 再配布不可のPMC論文を data/private/raw/ に取得
npm run build
```

## 設計上の要点

### span 追跡

段落の派生情報 (要約・統計値・用語) はすべて `paragraph.text` 上のオフセット
`[start, end)` で原文に紐づく。UI で「要約 → 原文ハイライト」を成立させるための土台。

JATS は整形済みで届くのでテキストノードに改行とインデントが入っている。
組み立て**後**に `replace(/\s+/g, ' ')` をかけると記録済みの span が全部ずれるため、
`TextBuilder` が追記時にインクリメンタルに畳んでいる。既に書いた文字は書き換えない。

検証は `test/verify.ts` が実際に `text.slice(...span)` して照合している
(`<italic>p</italic>` → `"p"`、連続 xref → `"1"|"2"|"3"` など)。

### 文分割

文分割は LLM 不要の決定的処理なのでパーサ側に置く (`splitSentences.ts`)。
`paragraph.sentences[]` に `[start, end)` で入り、座標系は marks と共通。
**パース時に必ず走る。無料なので、使うかどうかに関わらず常に入っている。**

用途は 2 つ。文パス (`certainty`) の単位であることと、ビューアで原文を
文単位にハイライトするときの足場。前者を使わない場合でも後者は残る。

実データで測ると、断定と hedge が同じ段落に同居するのは **23 段落中 7 段落**
(Discussion 4 / Abstract 2 / Introduction 1)。ただし *p 値と hedge* が同居する
段落は **0**。統計値は Results に、推測は Discussion に分かれている。
段落を 1 つの断定度に平均するのは筋が悪いが、段落**要約**なら
著者自身が段落内で付けた留保 (「機序は推測にとどまる」) を保存できる。
だから既定は段落パスで、文単位 certainty は opt-in にしてある。

素朴な `/\.\s/` 分割ではコーパスに広げたときに崩れるので、生物医学テキスト特有の
形に対処してある:

| 形 | 扱い |
|---|---|
| `Fig.` `et al.` `e.g.` `i.p.` `approx.` | 辞書で非文末 |
| `min.` `sec.` `hr.` | **辞書に入れない**。"for 30 min. Cells were…" は実際に文末 |
| 小数 `p = 0.0020` | ピリオドの後に空白がないので自然に回避される |
| 括弧の内側 | 文末になりえない。試薬表記 `(BD Biosciences, San Jose, CA, USA. Cat.# 562245)` が割れた実例あり |
| 閉じない括弧 | 無視する。以降が 1 文に潰れるのを避ける |
| 箇条書き | `list-item` mark の先頭を強制的な文頭にする (項目に終止符がない) |

**単一大文字の前のピリオドが最大の難所。** `J. Huard` はイニシャルなので文末では
ないが、`37 °C.` は単位なので文末。同じ形をしている。既定はイニシャル扱い
(分割しない) で、直前の語が数値のとき (`4 C.`) と、次の語が文頭に立ちやすい語の
とき (`group A. The …`) だけ文末とする。Methods は温度・濃度・容量だらけなので、
放置すると Materials and Methods がほぼ分割されないままになる。

### セクション型の推定

`@sec-type` があれば最優先。MDPI はほぼ付けてこないのでタイトル正規表現が本命。
`2.4. Flow Cytometry` のような固有名詞の見出しは親セクションの型を継承する。

`limitations` は `discussion` より先に判定している (Discussion 配下に置かれるため)。

### 図表の扱い

`<fig>` / `<table-wrap>` は `<p>` の中に現れるが本文テキストからは除外し、
`figures` / `tables` に分離する。混入すると段落本文に caption が紛れ込む。

### 図版の実体は XML に入っていない

`<graphic xlink:href="cells-15-01249-g001.tif">` にあるのは**ファイル名だけ**で、
URL でもデータでもない。表示するには配信元から取るしかない。

```bash
npm run figures              # data/figures/{article.id}/ に保存
npm run figures -- --dry-run # 取得先 URL を出すだけ
npm run figures -- --force   # 既存ファイルも取り直す
```

取得先を PMC に一本化してある。理由は 2 つ:

- **MDPI (www.mdpi.com) は 403 を返す。** ただし OA 論文は PMC にも入っている
  ので、DOI から PMCID を引けば取れる (`cells15141249` → `PMC13407337`)。
  引けた PMCID は `meta.pmcid` に書き戻すので、次回は問い合わせない。
- **MDPI の原本は `.tif` で、ブラウザは TIFF を表示できない。** PMC は同じ図を
  `.jpg` に変換して持っているので拡張子を寄せる。

#### スクリプトからの取得は PMC の bot 検知に当たる

数枚取ると `200 text/html` が返り、**中身は reCAPTCHA のチャレンジページ**。
429 ではないのでステータスだけ見ていると成功扱いになり、HTML が `.jpg` として
保存される。content-type を確かめてから書くのはこのため。

**ゲートがかかっているのは `pmc.ncbi.nlm.nih.gov` だけ。** bin URL はそこから
`cdn.ncbi.nlm.nih.gov/pmc/blobs/{hash}/{id}/{hash}/{name}` へ 301 するが、
**CDN 側は素通しで、Node から何度でも取れる**。つまりリダイレクトさえ通れば
残りは確実に取れる。バックオフを入れてあるのはこのため (待てば通る)。

blob URL のハッシュは推測できないので、CDN を直接叩くにはリダイレクトを
たどるしかない。**回避はしない** — 別の HTTP クライアントに替えると通るが、
それは検知をかわしているだけになる。実際、再試行を重ねて 10 枚とも取れた。

#### 取れなかった分はブラウザに直接読ませる

ビューアは図版を 3 段階に落とす:

1. `data/figures/` のローカルファイル
2. PMC の URL を `<img src>` に直接入れる
3. キャプションだけ

**ブラウザが自分で読みに行くぶんには通る** — PMC のサイト自体がそうやって
表示している。ローカルにあればオフラインでも読めるので 1 を優先し、
落ちた分だけ 2 で埋める。URL の組み立ては `pmcImageUrl()` の 1 箇所だけ。

`data/figures/` は git 管理外。取り直せるうえ、ライセンスが論文ごとに違う
(OA サービスによれば `cells15141249` は CC BY、`PMC3143999` は `license="none"`)。

##### 1 → 2 の判断に `figures[].files` を使わない

`files` は**取得した端末での記録**で、article JSON に入って git に乗る。
一方 `data/figures/` は git 管理外なので、別の端末でクローンすると
**`files` はあるのに実体が無い**状態になる。`files` だけ見て 1 に決めると
`/figures/...` が 404 になったまま 2 に落ちず、図が全部壊れる (実際に起きた)。

そこで、ローカルを試す `<img>` には落とし先を `data-fallback` に持たせておき、
読み込みに失敗したら PMC に差し替える (`setupFigureFallback()`)。`error` は
バブルしないので capture で拾い、`main` に 1 つだけ付ける。差し替えたら
`data-fallback` を消す — PMC 側も落ちたときに張り替え続けないため。

### 読み込み時に弾くもの

ダウンロード起因の事故を、パーサの謎エラーになる前に落とす:

- **BOM** — ブラウザ保存で付く。除去して続行
- **XML 宣言前のゴミ** — HTTP ヘッダの混入など。xmldom のエラーが
  `processing instruction at position 12 is an xml declaration...` と
  極めて分かりにくいので、自前で内容を示して落とす
- **HTML** — ログイン画面や 403 を `.xml` として保存したケース
- **UTF-8 以外の encoding 宣言** — 警告のみ出して続行

### MDPI 実ファイルで見つかった癖

`10.3390/cells15141249` (JATS 1.3) を通して判明した点。他誌でも起きるので対処済み:

| 事象 | 対処 |
|---|---|
| back matter が `<sec>` ではなく `<notes>` / `<ack>` / `<glossary>` / `<app>` | `BACK_CONTAINERS` で受ける。`<sec>` だけ見ると COI 開示ごと落ちる |
| `<sec sec-type="display-objects">` (図表の入れ物) が空セクションとして残る | `SKIP_SEC_TYPES` + `pruneEmpty()` |
| `<funding-group>` が back ではなく **front/article-meta** にある | `parseFunding()` で front から拾う |
| 責任著者が `corresp="yes"` ではなく `<xref ref-type="corresp">` | 両方を見る |
| ライセンス URL が `<license>@xlink:href` ではなく `<license-p>` 内の `<ext-link>` | 両方を見る |
| Highlights が `<abstract><sec sec-type="highlights">` に入る | 抄録セクションとして取得 |
| `<list>` が `<p>` の中に入り、`<list-item><p>` と `<p>` が入れ子になる | 項目ごとに `list-item` mark を記録 |

## 既知の制約

- **表の colspan/rowspan 未展開**: セルのテキストをそのまま行列化しているだけ。
  結合セルのある表は列がずれる (上記論文の表 5 件には結合セルなし)。
- **`<disp-quote>` 未対応**: 本文にインライン展開される。
- **DOI のない論文**: `id` が `unknown` になり、複数あると衝突する。
- **Frontiers / Elsevier は未検証**: MDPI と PMC の実ファイルは通した。
- **back matter の一部が 1 文に潰れる**: Author Contributions (`H.N., Conceptualization; …`)
  と Abbreviations は終止符を持たない列挙なので、それぞれ 800 字級の 1 文になる。
  enrich の対象外なので実害はない。

## 実データでの通過状況

`cells-15-01249.xml` (MDPI, 160 KB, JATS 1.3):

```
47 段落 / 246 文 / 198 mark / span 破綻 0 / 重なり 0 / 空白異常 0
IMRaD 5 セクション + back matter 8 セクション、warnings 0 件
文献 45 / 図 7 / 表 5 — 本文からの参照 80 件すべて解決
著者 10 (ORCID 6, 所属 10, 責任著者 2)
```

`PMC3143999.xml` (PMC / PAGEPress, 22 KB, JATS 1.4, 症例報告):

```
4 段落 / 40 文 / warnings 0 件
文献 13 (DOI + PMID 付き) / 図 3
著者 3 (所属 3)
```

### PMC で見つかった癖

MDPI だけでは出なかった形。**1 件目は文分割のバグだった。**

| 事象 | 対処 |
|---|---|
| 上付きの引用番号が**ピリオドの後**に来る (`2.2%.1,2 These`) | 4 文が 1 文に融合した。xref mark の位置を文分割に渡して跨ぐ。数字を正規表現で舐めると小数を巻き込むので mark に頼る |
| 著者に `<xref ref-type="aff">` が無く `<aff>` が 1 つだけ | rid で引けないので所属が空になっていた。aff が 1 つのときだけ全員に割り当てる (複数あるときは推測せず空のまま) |
| `article-type="case-report"` に Methods / Results が無い | IMRaD 監査が誤警告していた。非 IMRaD の article-type では欠落を問わない |
| "Case Report" 見出しが `other` 判定 | 症例報告では**そこが本文**なのに enrich 対象外になっていた。`case` セクション型を追加 |
| `<pmc-articleset>` で包まれる | 対処済みだった (`deepFirst(doc, "article")`) |

### ライセンスに注意

`PMC3143999` の license-p は "Creative Commons Attribution 3.0 License **(by-nc 3.0)**"
と読める。BY と BY-NC が併記されていて判然としないが、NC なら再配布不可。
**このリポジトリを公開する予定があるなら `data/private/` に移すこと。**
PMC OA subset にはこの手の混在があるので、追加するたびに `meta.licenseText` を
確認するのが安全。

## certainty の設計 (文パス)

> **運用では使わないことにした。** 段落サマリーだけで著者の留保は十分追えた
> (Limitations 段落の `plain` が「一般化の限界」「外部検証が必要」まで書けている)。
> 文パスは 1 論文あたり +$0.12 かかるうえ、確認すべき箇所が段落単位で分かれば
> 原文を読めば済む。**コードは opt-in のまま残してある** — 消す理由はなく、
> 断定度を文単位で見たくなったら `--pass sentence` で回せる。

文パスは opt-in (`--pass sentence`)。既定は段落パス。
`Sentence.certainty` は 0〜1 の連続値ではなく **離散 4 段階**にしてある。

| 値 | 意味 | 例 |
|---|---|---|
| `measured` | 測定値・統計量を伴う事実 | 「BMAX™ は PBS と比べて OARSI スコアを有意に改善した (p = 0.0020)」 |
| `supported` | 裏付けのある記述。hedge なし | 「aspiration は骨表面に密着した細胞を捕捉できない」 |
| `hedged` | may / suggest / appear で留保 | 「native niche の維持が治療効果を高めうる」 |
| `speculative` | 著者自身が推測と宣言 | 「これらの機序の寄与は推測の域を出ず、慎重に解釈すべきである」 |

連続値をやめた理由は較正が効かないこと。同じ文でも実行ごとに 0.3 と 0.45 が返り、
閾値を決めても再現しない。判定に使えるのは結局「順序」だけなので、最初から
順序尺度にしてある。UI の色分けにもそのまま対応する。

判定根拠になった hedge 表現は `Sentence.hedges` に span で残す
(`remains speculative` / `may contribute` / `plausible`)。
「なぜこの判定なのか」を原文上に示せないと、断定度の表示は信用されない。

この論文だと Introduction (先行研究の欠点を断定) と Discussion (自分たちの機序説明は
推測と認める) の温度差が、文単位の断定度にすると一目で出る。普通に読むと見落とす。

## enrich

LLM 由来のフィールドを付ける。**2 つのパスがある。**

| パス | 付けるもの | 単位 | 対象 | 既定 |
|---|---|---|---|---|
| `paragraph` | `role` / `gist` / `plain` | 段落 | Methods **込み** | ✅ |
| `sentence` | `certainty` / `hedges` / `stats` | 文 | Methods 除外 | opt-in |

精読の主軸は段落パス。段落を1行で言い切った `gist` が並べば骨子になり、
`plain` (平易な英語 1〜3 文) があれば専門外の分野でも追える。

**生成内容とビューア UI は英語で統一してある。** 開発向けの出力
(CLI の進捗表示・警告・この README・コード中のコメント) は日本語のまま。文パスは「著者がどこで言い切り、
どこで留保しているか」を文単位で見たいときの追加装備。

```bash
npm run enrich -- --dry-run       # 送信内容と件数だけ表示。課金なし
npm run enrich -- --limit 1       # 1 リクエストだけ試し打ち
npm run show                      # 段落サマリーを読む
npm run enrich                    # 残りを処理 (済んだ分はキャッシュで無料)

npm run enrich -- --pass sentence  # 文パス
npm run show -- --sentences        # certainty 表示
```

**初回は `--limit 1` から。** プロンプトやスキーマに問題があっても 1 リクエスト分
しか無駄にならない。途中で失敗しても成功したバッチはキャッシュに残るので、
そのまま再実行すれば続きから進む。

**キャッシュはパスごとに分かれている** (`data/cache/enrich/{paragraph,sentence}/`)。
片方のプロンプトを直して引き直しても、もう片方は無傷。`article.enrich` も
パス名をキーにした辞書なので、記録が上書きで消えることはない。

### 段落サマリーが hedge を落とさないこと

段落パスの設計上の要はここ。文単位 certainty を既定から外した以上、
**要約が著者の断定度を保存しなければ意味がない。**

「機序は推測にとどまる」と書いてある段落を「機序は〜である」と要約したら、
見分けたかった区別がその場で消える。プロンプトの中心はこの一点で、
原文に hedge 表現があるのに `plain` に留保が見当たらない場合は警告を出す
(自動では直せないが、目視すべき段落が特定できる)。

**出力を英語に統一したことでこの照合は原文と同じ規則で書ける。** 日本語要約
だった頃は文末表現の幅が広く、辞書が追いつかなかった。

逆方向 (原文が断定、要約が留保) は検出しない。実害が小さいうえ、要約側の
辞書を広く取っている以上そちらの過検出が跳ね返るだけになる。

検査は `parse` ではなく **`merge` に置いてある**。parse に置くとキャッシュ経由の
段落を素通りしてしまい、検査規則を直しても引き直すまで反映されない。

#### 辞書は原文側と要約側で非対称

条件が「原文に hedge あり **かつ** 要約に hedge なし」という非対称な形なので、
両側で誤りのコストが違う:

| | 誤りの向き | 結果 | 方針 |
|---|---|---|---|
| 原文側 | 過検出 | 誤警告 | **精度**を優先 (狭く) |
| 要約側 | 取り逃し | 誤警告 | **再現率**を優先 (広く) |

同じ語彙を両側に使うとこの非対称を無視することになる。実際 `potential` は
`cells15141249` の原文に 8 回出るが**すべて名詞** ("therapeutic potential",
"differentiation potential") で留保ではない。一方 `potential` が要約側に出た
なら留保とみなしてよい。だから要約側だけに置く。`indicat*` `apparent*`
`warrant*` も同じ理由 (「スコア 0 は無反応を *indicates*」は定義であって留保ではない)。
要約側にはさらに、原文の語形と一致しない言い換え ("remains to be validated"
→ "external validation is still needed") を足してある。

`role` が `method` / `study_design` の段落は検査しない。手順の記述に保存すべき
断定度は無い。セクション種別ではなく role で見るのは、Methods 節の外に置かれた
手順段落も拾うため。

**網羅は諦めている。** 実データで 3 回誤検知した — 日本語版で「代替となりうる」、
英語版で "possible treatment"、そして上の `potential` (39 段落中 5 件)。いずれも
**要約は正しく、検査のほうが間違っていた**。これは判定ではなく「目視すべき段落を
絞る」道具なので、誤検知が出たらそのつど辞書を直す。出た形はテストに固定してある。

### API キーの置き場所

`ANTHROPIC_API_KEY` を次のいずれかに置く。上から順に優先される。

1. `export ANTHROPIC_API_KEY=sk-ant-...` (環境変数)
2. プロジェクト直下の `.env` に `ANTHROPIC_API_KEY=sk-ant-...`
3. `ant auth login` (OAuth プロファイル)

**Anthropic SDK は `.env` を自動では読まない。** 2 の形式でも動くように CLI 側で
`process.loadEnvFile()` している。既に export 済みの変数は上書きしないので、
一時的に別のキーで動かしたいときは環境変数のほうが勝つ。

`.env` は `.gitignore` に入れてある。この README は `data/` を git に入れる方針
なので、キーを置いたまま `git add .` すると事故る。

### 結果を読む

```bash
npm run show                            # 段落サマリー + role の分布
npm run show -- --plain                 # plain だけを縦に並べる (通し読み)
npm run show -- --section discussion    # セクションで絞る
npm run show -- --role limitation       # 段落の役割で絞る

npm run show -- --sentences             # 文単位 certainty
npm run show -- --sentences -p s4-p5    # 段落を指定
```

文表示では hedge を `«...»` で囲む。これは装飾ではなく**検算**で、span がずれて
いれば `«may»` が `«ay c»` のようにずれて見える。語の途中で切れていたら
オフセットのバグ。

なお、この論文の Limitations は独立セクションではなく Discussion 第 5 段落
(`s4-p5`) なので、`--section limitations` では引けない。

### 対象セクション

back matter (funding / conflicts / ack) は両パスとも外す。
**Methods は段落パスでは対象、文パスでは対象外。**

文パスから Methods を外す理由は、手技の記述が「何をしたか」の報告なので
ほぼ全文が `supported` になり、判定に情報が乗らないため。しかも量が多い:

| セクション | 文数 |
|---|---:|
| **methods** | **91** |
| discussion | 56 |
| results | 28 |
| introduction | 22 |
| abstract | 21 |
| conclusions | 3 |

Methods だけで 221 文の 41%。文パスは外して 130 文 / 6 リクエストになる。
一方で段落パスは Methods を含める — 断定度に情報がなくても、
「何をしたか」の要約は精読で普通に要る。

`--with-methods` でパスの既定に Methods を足せる。対象を広げても既存段落の
キャッシュキーは変わらないので、追加分だけ課金される。

### コスト

モデルは `claude-opus-5` が既定 (`--model` で変更可)。
`cells15141249` (39 段落 / 221 文) を 1 本通したときの実測:

| パス | 対象 | リクエスト | 入力 tok | 出力 tok | 概算 |
|---|---|---:|---:|---:|---:|
| paragraph | 39 段落 | 4 | 17,943 | 8,168 以上 | $0.29 以上 |
| sentence | 130 文 | 6 | 24,333 | 未実測 | — |

入力は `count_tokens` の実測 (このエンドポイントは課金対象外なので無料で測れる)。
出力は**生成済みサマリーを数え直した下限**で、thinking は含まない。
当初の見積もり (4 千 tok) は**実際の半分だった** — 出力トークンは事前に
測れないので、見積もりは当てにしないこと。

API を叩いた実行では `usage` から実測値を出す:

```
トークン実測 (4 リクエスト): 入力 17,943 / 出力 8,168  概算 $0.294
```

キャッシュが全部効いた実行では何も出ない (課金が発生していないため)。
**逆に言うと、実測できるのは課金した回だけ**で、後から測り直すことはできない。

### LLM に文字オフセットを出させない (文パス)

hedge の位置を `[412, 431]` の形で答えさせると平気で数文字ずれる。
代わりに**原文からの逐語引用**を返させ、オフセットはこちら側で `indexOf`
する。文の範囲内で探すのが要点で、`may` のような短い語は段落内に何度も出る。

引用が原文に見つからなければその項目を捨てて warning に残す。捏造の検出を
兼ねていて、`article.enrich.{pass}.warnings` に記録される。

### テストの守備範囲

`test/enrich.ts` は **API を叩かない**。バッチ分割・キャッシュ・逐語引用から
span への変換・不正応答の棄却・記事へのマージを、モックの caller で一巡させる。
プロンプトの中身の良し悪しは実行結果を見ながら詰めるしかないが、その周りの
配管はキーなしで固められる。

## 次にやること

**当面なし。** 精読に必要なものは一通り揃っている
(段落サマリー / 図版 / 表 / 引用リンク)。

保留にしたもの:

- **横断検索。** 2 本の段階で実測したところ、全文検索はブラウザの Ctrl+F で
  足り (51 段落 / 49,173 字)、共通文献は **0 件** (45 vs 13、分野が違う)、
  role 横断も limitation が 1 件では並べる意味がない。効いてくるのは
  10 本規模から。**そのとき実際に困った形に合わせて作るほうが確実**なので、
  先に仕様を決めない。
- **文献リストの一覧表示。** 引用番号のホバーで書誌が読めるので、
  末尾に全件を並べる動機が今のところない。

決着したもの:

- 文パスは使わない (`## certainty の設計` 冒頭を参照)。コードは opt-in で残置
- 図版・表・引用リンクは実装済み
- 原文と AI 要約の主従は現状のまま (要約が太字、原文は 14px)
- 図表への xref はリンクにしない
-  `data/private/` へライセンス付き論文データ隔離
  (再配布の可否は `## ライセンス` を参照。方針が変わったら PMC3143999 の
  `license="none"` を確認すること)
