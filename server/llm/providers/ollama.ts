// Ollama native provider (/api/generate). For OpenAI-compat against Ollama
// (/v1/chat/completions), use the openai provider with apiBase pointing at
// http://ollama:11434/v1 — that path stays inside providers/openai.ts.
//
// This file handles the *native* generate API used by the entity-extraction
// worker (adamreading/scripts/local-brain-worker.js pattern):
//   - POST /api/generate
//   - body: { model, prompt, stream:false, format?, options:{temperature,num_predict} }
//   - response: { response: "<text>", done, ... }
//
// disableThinking maps to a "/no_think" directive prepended to the prompt
// (Qwen3 convention). If the caller also passes assistantPrefill, that
// goes after the user content as the model's starting tokens.

import type { ChatRequest, ChatResponse, ProviderConfig } from "../types.ts";
import { stripThinkBlocks } from "../strip.ts";

function buildPrompt(req: ChatRequest): string {
  const parts: string[] = [];
  if (req.disableThinking) parts.push("/no_think");
  if (req.system) parts.push(req.system);
  for (const m of req.messages) {
    if (m.role === "user") parts.push(m.content);
    else parts.push(`Assistant: ${m.content}`);
  }
  if (req.assistantPrefill) parts.push(req.assistantPrefill);
  return parts.join("\n\n");
}

export async function ollamaChat(
  req: ChatRequest,
  cfg: ProviderConfig,
): Promise<ChatResponse> {
  const t0 = performance.now();
  const prompt = buildPrompt(req);

  const body: Record<string, unknown> = {
    model: cfg.model,
    prompt,
    stream: false,
    options: {
      temperature: req.temperature ?? 0,
    },
  };
  if (req.json) body.format = "json";
  if (req.maxTokens) {
    (body.options as Record<string, unknown>).num_predict = req.maxTokens;
  }

  const r = await fetch(`${cfg.apiBase}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Ollama chat failed: ${r.status} ${msg.slice(0, 200)}`);
  }
  const d = await r.json();
  const rawText = String(d?.response ?? d?.message?.content ?? "");

  // Reattach assistantPrefill so callers get the full text. Ollama's
  // /api/generate doesn't echo the prompt, so the response is already
  // the continuation — symmetric with anthropic.
  const fullRaw = (req.assistantPrefill ?? "") + rawText;

  return {
    text: stripThinkBlocks(fullRaw),
    rawText: fullRaw,
    finishReason: d?.done ? "stop" : "length",
    usage: {
      promptTokens: d?.prompt_eval_count,
      completionTokens: d?.eval_count,
      totalTokens: (d?.prompt_eval_count ?? 0) + (d?.eval_count ?? 0),
    },
    provider: cfg.tag,
    model: cfg.model,
    durationMs: performance.now() - t0,
  };
}
