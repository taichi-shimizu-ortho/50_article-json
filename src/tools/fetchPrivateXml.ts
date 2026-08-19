#!/usr/bin/env -S npx tsx
/**
 * 再配布不可として扱うPMC論文のJATS XMLを、各利用者の端末で取得する。
 *
 *   npm run fetch-private -- --dry-run
 *   npm run fetch-private -- --accept-license
 *   npm run fetch-private -- --id 10-4081-or-2011-e6 --accept-license
 *
 * XML・派生JSON・図版は公開リポジトリに入れない。ここで取得したXMLは
 * data/private/raw/ にだけ置く。実行者は、取得元の利用条件を自分で確認し、
 * ローカル利用の権限がある場合にだけ --accept-license を付けて実行する。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dirFor, PRIVATE_ROOT } from "../paths.js";

const MANIFEST = "data/corpus.json";
const TOOL = "article-json";
const USER_AGENT = `${TOOL}/0.1 (local reading tool)`;
const EFETCH_ENDPOINT = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

export interface Paper {
  id: string;
  doi?: string;
  pmcid?: string;
  title?: string;
  firstAuthor?: string;
  journal?: string;
  year?: string;
  redistributable: boolean;
  licenseBasis: string;
  source?: { file?: string; sha256?: string };
  fetch?: string;
}

export interface Manifest {
  papers: Paper[];
}

interface Args {
  ids: string[];
  acceptLicense: boolean;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ids: [], acceptLicense: false, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--id") {
      const id = argv[++i];
      if (!id) throw new Error("--id の後に論文ID、DOI、またはPMCIDを指定してください");
      args.ids.push(id);
    } else if (arg === "--accept-license") args.acceptLicense = true;
    else if (arg === "--dry-run" || arg === "-n") args.dryRun = true;
    else if (arg === "--force" || arg === "-f") args.force = true;
    else if (arg.startsWith("-")) throw new Error(`不明なオプション: ${arg}`);
    else args.ids.push(arg);
  }
  if (!args.dryRun && !args.acceptLicense) {
    throw new Error(
      "取得元の利用条件を確認し、ローカル利用の権限がある場合だけ --accept-license を付けて実行してください",
    );
  }
  return args;
}

export function loadManifest(): Manifest {
  if (!existsSync(MANIFEST)) throw new Error(`${MANIFEST} が見つかりません`);
  const parsed = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  if (!Array.isArray(parsed.papers)) throw new Error(`${MANIFEST} の papers が壊れています`);
  return parsed;
}

function selectPapers(manifest: Manifest, ids: string[]): Paper[] {
  const privatePapers = manifest.papers.filter((paper) => !paper.redistributable);
  if (ids.length === 0) return privatePapers;

  const picked: Paper[] = [];
  for (const id of ids) {
    const normalized = id.toLowerCase();
    const paper = privatePapers.find(
      (candidate) =>
        candidate.id.toLowerCase() === normalized ||
        candidate.doi?.toLowerCase() === normalized ||
        candidate.pmcid?.toLowerCase() === normalized,
    );
    if (!paper) {
      throw new Error(`非公開対象の論文が目録にありません: ${id}`);
    }
    if (!picked.some((candidate) => candidate.id === paper.id)) picked.push(paper);
  }
  return picked;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function privatePath(paper: Paper): string {
  const name = paper.source?.file;
  if (!name) throw new Error(`${paper.id}: 目録に source.file がありません`);
  return join(dirFor(PRIVATE_ROOT, "raw"), name);
}

/**
 * 自動取得できるか。PMC EFetch は PMCID が無いと組み立てられない
 * (import-json 由来の論文など)。取れないものは UI で「手動」と表示する。
 */
export function canEfetch(paper: Paper): boolean {
  const numeric = paper.pmcid?.replace(/^PMC/i, "");
  return Boolean(numeric && /^\d+$/.test(numeric) && paper.source?.file && paper.source?.sha256);
}

function efetchUrl(paper: Paper): string {
  const numericPmcid = paper.pmcid?.replace(/^PMC/i, "");
  if (!numericPmcid || !/^\d+$/.test(numericPmcid)) {
    throw new Error(`${paper.id}: PMC ID がないため公式XML取得先を組み立てられません`);
  }
  const params = new URLSearchParams({
    db: "pmc",
    id: numericPmcid,
    tool: TOOL,
  });
  return `${EFETCH_ENDPOINT}?${params}`;
}

export interface FetchPaperOptions {
  force?: boolean;
  dryRun?: boolean;
}

/** 1 本取得する。CLI とビューアの共通の入口 (表示は呼び出し側)。 */
export async function fetchPaper(
  paper: Paper,
  args: FetchPaperOptions = {},
): Promise<"取得" | "既存" | "予定"> {
  const dest = privatePath(paper);
  const expected = paper.source?.sha256;
  if (!expected) throw new Error(`${paper.id}: source.sha256 がないため同一性を検証できません`);

  if (!args.force && existsSync(dest)) {
    const actual = sha256(readFileSync(dest, "utf8"));
    if (actual !== expected) {
      throw new Error(`${paper.id}: 既存ファイルのSHA-256が目録と異なります。内容を確認してから --force を使ってください`);
    }
    return "既存";
  }

  const url = efetchUrl(paper);
  if (args.dryRun) {
    console.log(`  ${paper.id}\n    保存先: ${dest}\n    取得先: ${url}`);
    return "予定";
  }

  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/xml,text/xml" },
  });
  if (!response.ok) throw new Error(`${paper.id}: PMC EFetch が HTTP ${response.status} を返しました`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/xml/i.test(contentType)) throw new Error(`${paper.id}: XML以外の応答です (${contentType || "content-typeなし"})`);

  const xml = await response.text();
  if (!/<article\b/i.test(xml) || /<html\b/i.test(xml)) {
    throw new Error(`${paper.id}: JATS XMLではない応答です。保存していません。`);
  }
  const actual = sha256(xml);
  if (actual !== expected) {
    throw new Error(
      `${paper.id}: 取得したXMLのSHA-256が目録と一致しません (expected ${expected}, got ${actual})。保存していません。`,
    );
  }

  mkdirSync(dirFor(PRIVATE_ROOT, "raw"), { recursive: true });
  const temp = `${dest}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, xml, "utf8");
    renameSync(temp, dest);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return "取得";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const papers = selectPapers(loadManifest(), args.ids);
  if (papers.length === 0) {
    console.log("目録に非公開対象の論文はありません");
    return;
  }

  console.log(`非公開対象 ${papers.length} 件を対象にします。保存先は data/private/raw/ のみです。`);
  if (args.dryRun) console.log("--dry-run: 通信・保存は行いません。\n");

  let failed = false;
  for (const paper of papers) {
    try {
      const result = await fetchPaper(paper, args);
      console.log(`${result}  ${paper.id}  — ${paper.title ?? ""}`);
    } catch (error) {
      failed = true;
      console.error(`失敗  ${paper.id}  — ${(error as Error).message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

// ビューアからは fetchPaper などを import する。**直接実行したときだけ**
// CLI を動かす (import しただけで取得が始まらないように)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
