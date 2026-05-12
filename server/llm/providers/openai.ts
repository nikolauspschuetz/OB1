// OpenAI-compatible provider. Targets:
//   - GitHub Models           (https://models.github.ai/inference)
//   - OpenRouter              (https://openrouter.ai/api/v1)
//   - LiteLLM                 (http://litellm:4000) — incl. Bedrock translation
//   - Local mock-openai       (ci/mock-openai.ts) for credential-free CI
//   - Any other endpoint that speaks /chat/completions and /embeddings
//     with `Authorization: Bearer`.

import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  ProviderConfig,
} from "../types.ts";
import { stripThinkBlocks } from "../strip.ts";

export async function openaiChat(
  req: ChatRequest,
  cfg: ProviderConfig,
): Promise<ChatResponse> {
  const t0 = performance.now();
  const messages: ChatMessage[] = [];
  if (req.system) messages.push({ role: "user", content: req.system });
  for (const m of req.messages) messages.push(m);
  if (req.assistantPrefill) {
    messages.push({ role: "assistant", content: req.assistantPrefill });
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: req.temperature ?? 0,
  };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (req.json) body.response_format = { type: "json_object" };
  // disableThinking: deliberately NOT sent as a body parameter. GitHub
  // Models tightened its API to reject unknown fields, and there's no
  // single shape that works across openai-shaped upstreams (GitHub
  // Models, OpenRouter, OpenAI direct, LiteLLM→Bedrock-Anthropic, plain
  // Ollama /v1). The portable substitute is the `/no_think` directive
  // prepended to the prompt by the Ollama provider; openai-shaped paths
  // ignore the flag here.

  const r = await fetch(`${cfg.apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(
      `OpenAI-compat chat failed: ${r.status} ${msg.slice(0, 200)}`,
    );
  }
  const d = await r.json();
  const choice = d.choices?.[0];
  const rawText = String(choice?.message?.content ?? "");
  return {
    text: stripThinkBlocks(rawText),
    rawText,
    finishReason: String(choice?.finish_reason ?? "stop"),
    usage: {
      promptTokens: d.usage?.prompt_tokens,
      completionTokens: d.usage?.completion_tokens,
      totalTokens: d.usage?.total_tokens,
    },
    provider: cfg.tag,
    model: cfg.model,
    durationMs: performance.now() - t0,
  };
}

export async function openaiEmbed(
  req: EmbedRequest,
  cfg: ProviderConfig,
): Promise<EmbedResponse> {
  const t0 = performance.now();
  const inputs = Array.isArray(req.input) ? req.input : [req.input];
  // Single input: pass as scalar to match GitHub Models / OpenAI default
  // shape. Batch input: pass as array.
  const inputPayload = inputs.length === 1 ? inputs[0] : inputs;

  const r = await fetch(`${cfg.apiBase}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: cfg.model, input: inputPayload }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(
      `Embedding API failed: ${r.status} ${msg.slice(0, 200)}`,
    );
  }
  const d = await r.json();
  // Defensive: reject 200-with-empty-data (transpara-ai's shape guard).
  if (!d?.data || !Array.isArray(d.data) || d.data.length === 0) {
    throw new Error(
      `Embedding API returned no data: ${JSON.stringify(d).slice(0, 200)}`,
    );
  }
  const embeddings: number[][] = d.data.map((e: { embedding: number[] }) =>
    e.embedding
  );
  if (!Array.isArray(embeddings[0]) || embeddings[0].length === 0) {
    throw new Error("Embedding API returned malformed data");
  }
  return {
    embeddings,
    dim: embeddings[0].length,
    model: cfg.model,
    durationMs: performance.now() - t0,
  };
}
