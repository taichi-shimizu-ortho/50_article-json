/**
 * Claude API 呼び出し。
 *
 * ここだけが外部と通信する。runEnrich は ModelCaller インタフェース越しに
 * しか呼ばないので、テストではモックを差し込める (API キーなしで
 * バッチ分割・キャッシュ・マージを検証できる)。
 */
import Anthropic from "@anthropic-ai/sdk";
import type { EnrichPass } from "./pass.js";
import type { EnrichUnit } from "./units.js";

/** バッチ 1 つを投げて、パース済み JSON を返す。 */
export type ModelCaller = (units: EnrichUnit[]) => Promise<unknown>;

/**
 * 1 リクエスト分の実測トークン。
 *
 * 出力トークンは事前に測れない (`count_tokens` は入力しか数えない) ので、
 * 課金額を知るには応答の `usage` を拾うしかない。拾い損ねると
 * 「回したのにコストが分からない」という一番もったいない状態になる。
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface ClientOptions {
  model: string;
  pass: EnrichPass<unknown>;
  /** low で十分。要約と分類にそれ以上の熟考を積んでも精度より課金が増える。 */
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
  /** リクエストごとの実測トークン。CLI 側で積算してコストを出す。 */
  onUsage?: (u: Usage) => void;
}

export function createModelCaller(opts: ClientOptions): ModelCaller {
  // API キーは環境変数 (ANTHROPIC_API_KEY) か ant auth login のプロファイルから解決される。
  const client = new Anthropic();

  return async (units) => {
    const response = await client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 16000,
      system: opts.pass.system,
      output_config: {
        effort: opts.effort ?? "low",
        format: { type: "json_schema", schema: opts.pass.schema },
      },
      messages: [{ role: "user", content: opts.pass.buildUserMessage(units) }],
    });

    opts.onUsage?.({
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    });

    if (response.stop_reason === "max_tokens") {
      throw new Error(
        `出力が max_tokens で切れました (${units.reduce((n, u) => n + u.sentences.length, 0)} 文)。` +
          `--batch を小さくするか max_tokens を上げてください。`,
      );
    }
    if (response.stop_reason === "refusal") {
      throw new Error(`モデルが応答を拒否しました: ${JSON.stringify(response.stop_details)}`);
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`JSON として解釈できない応答: ${text.slice(0, 200)}`);
    }
  };
}
