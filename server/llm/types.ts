// Provider-agnostic LLM types. Decisions documented in
// .planning/llm-wrapper-design.md.

export type ProviderTag = "openai" | "anthropic" | "bedrock" | "ollama";

export interface ProviderConfig {
  tag: ProviderTag;
  apiBase: string;
  apiKey: string;
  model: string;
  // Anthropic-only: API version pinned via header.
  anthropicVersion?: string;
  // Ollama-only: when true, the ollama provider uses /api/generate (with
  // `prompt` and `format`) instead of the OpenAI-compat /chat/completions
  // endpoint exposed at /v1. Has no effect for tag != "ollama".
  useOllamaNative?: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  // Optional system prompt. For providers without first-class system
  // messages (Ollama native), prepended to the prompt.
  system?: string;
  messages: ChatMessage[];
  // Strict-JSON output. The wrapper picks the right knob per provider:
  //   openai/bedrock-via-LiteLLM: response_format: {type: "json_object"}
  //   anthropic: prefilled assistant "{" + stop_sequences ["}"]
  //   ollama:   format: "json" + temperature:0
  json?: boolean;
  // Caller-supplied assistant prefill, locks the model into a shape.
  // E.g. wiki synthesizer prefills "# {EntityName}\n\n".
  // openai/anthropic: appended as initial assistant message.
  // ollama native: appended to prompt body.
  assistantPrefill?: string;
  temperature?: number;
  maxTokens?: number;
  // Disable Qwen3-style chain-of-thought emission. Honored by ollama
  // (prepends "/no_think") and OpenRouter-style upstreams (sends `think:false`).
  // Silently dropped by Anthropic and Bedrock-via-LiteLLM (they 400 on it).
  // <think>...</think> stripping is post-hoc regardless.
  disableThinking?: boolean;
  // Logged in metric labels for tracing.
  requestId?: string;
  // Default 2.
  retries?: number;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResponse {
  // Output text with <think>...</think> blocks stripped (idempotent).
  text: string;
  // Pre-strip output (debug / audit).
  rawText: string;
  // Provider-reported finish reason (e.g. "stop", "length").
  finishReason: string;
  usage: ChatUsage;
  provider: ProviderTag;
  model: string;
  durationMs: number;
}

export interface EmbedRequest {
  input: string | string[];
  // Defaults to embedConfigFromEnv() when omitted.
  config?: ProviderConfig;
}

export interface EmbedResponse {
  // Always array-of-arrays even for single-input requests.
  embeddings: number[][];
  // Inferred from the first vector's length. Caller is responsible for
  // matching against the pgvector column dimension.
  dim: number;
  model: string;
  durationMs: number;
}
