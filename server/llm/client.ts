// Provider-agnostic dispatcher. Public API: chat(), embed(),
// chatConfigFromEnv(), embedConfigFromEnv(), stripThinkBlocks().
//
// MVP slice (this file): only the openai provider is wired. Anthropic and
// Ollama land in the next slice. Calling chat() with tag in {anthropic,
// ollama} throws "not yet implemented" until then.

import type {
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  ProviderConfig,
  ProviderTag,
} from "./types.ts";
import { openaiChat, openaiEmbed } from "./providers/openai.ts";

export { stripThinkBlocks } from "./strip.ts";
export type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  EmbedRequest,
  EmbedResponse,
  ProviderConfig,
  ProviderTag,
} from "./types.ts";

// --- Config resolution from env ---
//
// Mirrors the precedence already in server/index.ts:
//   CHAT_PROVIDER           "openai" (default) | "anthropic" | "bedrock" | "ollama"
//   CHAT_API_BASE           inherits EMBEDDING_API_BASE when blank
//   CHAT_API_KEY            inherits EMBEDDING_API_KEY when blank
//   CHAT_MODEL              default openai/gpt-4o-mini

export function chatConfigFromEnv(): ProviderConfig {
  const tagRaw = (Deno.env.get("CHAT_PROVIDER") || "openai").toLowerCase();
  const tag: ProviderTag =
    (["openai", "anthropic", "bedrock", "ollama"] as ProviderTag[])
        .includes(tagRaw as ProviderTag)
      ? tagRaw as ProviderTag
      : "openai";

  const embedBase = Deno.env.get("EMBEDDING_API_BASE") ||
    "https://models.github.ai/inference";
  const embedKey = Deno.env.get("EMBEDDING_API_KEY") || "";

  if (tag === "anthropic") {
    return {
      tag,
      apiBase: Deno.env.get("ANTHROPIC_API_BASE") ||
        "https://api.anthropic.com",
      apiKey: Deno.env.get("ANTHROPIC_API_KEY") || "",
      model: Deno.env.get("ANTHROPIC_CHAT_MODEL") ||
        "claude-haiku-4-5-20251001",
      anthropicVersion: Deno.env.get("ANTHROPIC_VERSION") || "2023-06-01",
    };
  }

  // openai / bedrock / ollama all share the OpenAI-compat surface for v1.
  // The bedrock tag exists for routing/metrics labeling; under the hood it
  // dispatches the openai provider with a different apiBase (LiteLLM proxy).
  return {
    tag,
    apiBase: Deno.env.get("CHAT_API_BASE") || embedBase,
    apiKey: Deno.env.get("CHAT_API_KEY") || embedKey,
    model: Deno.env.get("CHAT_MODEL") || "openai/gpt-4o-mini",
    useOllamaNative: tag === "ollama",
  };
}

export function embedConfigFromEnv(): ProviderConfig {
  // Embeddings always go through OpenAI-compat for v1. Anthropic has no
  // embedding endpoint; Bedrock embeddings (Cohere/Titan) flow through
  // LiteLLM as OpenAI-compat too.
  return {
    tag: "openai",
    apiBase: Deno.env.get("EMBEDDING_API_BASE") ||
      "https://models.github.ai/inference",
    apiKey: Deno.env.get("EMBEDDING_API_KEY") || "",
    model: Deno.env.get("EMBEDDING_MODEL") || "openai/text-embedding-3-small",
  };
}

// --- chat dispatcher ---

export async function chat(
  req: ChatRequest,
  config?: ProviderConfig,
): Promise<ChatResponse> {
  const cfg = config ?? chatConfigFromEnv();

  // Silent-drop disableThinking on incompatible providers (anthropic,
  // bedrock-via-LiteLLM both 400 on `think:false`). Warn-log when LLM_TRACE.
  let adjusted = req;
  if (
    req.disableThinking &&
    (cfg.tag === "anthropic" || cfg.tag === "bedrock")
  ) {
    if (Deno.env.get("LLM_TRACE") === "true") {
      console.warn(
        `[llm] disableThinking dropped for provider=${cfg.tag} (incompatible)`,
      );
    }
    adjusted = { ...req, disableThinking: false };
  }

  const retries = req.retries ?? 2;
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (cfg.tag === "openai" || cfg.tag === "bedrock") {
        return await openaiChat(adjusted, cfg);
      }
      throw new Error(
        `Provider ${cfg.tag} not yet implemented in this slice`,
      );
    } catch (err) {
      lastErr = err as Error;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr ?? new Error("chat failed");
}

// --- embed dispatcher ---

export async function embed(req: EmbedRequest): Promise<EmbedResponse> {
  const cfg = req.config ?? embedConfigFromEnv();
  return await openaiEmbed(req, cfg);
}
