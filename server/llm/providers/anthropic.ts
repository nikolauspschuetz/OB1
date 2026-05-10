// Anthropic Messages API provider.
//
// Differences from openai:
//   - Endpoint is /v1/messages (not /chat/completions).
//   - Auth via x-api-key header (not Bearer).
//   - Required anthropic-version header.
//   - No native JSON mode: when json:true, the wrapper prefills the
//     assistant turn with "{" and reattaches "{" to the response text so
//     the caller gets back valid JSON to parse.
//   - No `response_format` field, no `think` field — disableThinking is
//     silent-dropped upstream in client.ts before this provider is called.

import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderConfig,
} from "../types.ts";
import { stripThinkBlocks } from "../strip.ts";

export async function anthropicChat(
  req: ChatRequest,
  cfg: ProviderConfig,
): Promise<ChatResponse> {
  const t0 = performance.now();

  // Anthropic prefers a separate `system` field, not a system role message.
  const messages: ChatMessage[] = [];
  for (const m of req.messages) messages.push(m);

  // JSON-mode strategy: assistant prefill of "{" if the caller didn't
  // already supply a prefill. We track which prefill went out so we can
  // reattach it to the response (Anthropic returns only the continuation).
  const effectivePrefill = req.assistantPrefill ?? (req.json ? "{" : undefined);
  if (effectivePrefill !== undefined) {
    messages.push({ role: "assistant", content: effectivePrefill });
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: req.maxTokens ?? 1024,
    messages,
    temperature: req.temperature ?? 0,
  };
  if (req.system) body.system = req.system;

  const r = await fetch(`${cfg.apiBase}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": cfg.apiKey,
      "anthropic-version": cfg.anthropicVersion ?? "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Anthropic chat failed: ${r.status} ${msg.slice(0, 200)}`);
  }
  const d = await r.json();
  // content is an array of blocks; concatenate text blocks.
  const continuation = Array.isArray(d?.content)
    ? d.content.filter((b: { type?: string }) => b?.type === "text")
      .map((b: { text?: string }) => String(b?.text ?? ""))
      .join("")
    : "";

  // Reattach the prefill so the caller receives the full string the model
  // would have produced if it had emitted from scratch.
  const rawText = (effectivePrefill ?? "") + continuation;

  return {
    text: stripThinkBlocks(rawText),
    rawText,
    finishReason: String(d?.stop_reason ?? "stop"),
    usage: {
      promptTokens: d?.usage?.input_tokens,
      completionTokens: d?.usage?.output_tokens,
      totalTokens: (d?.usage?.input_tokens ?? 0) +
        (d?.usage?.output_tokens ?? 0),
    },
    provider: cfg.tag,
    model: cfg.model,
    durationMs: performance.now() - t0,
  };
}
