// Tiny OpenAI-compatible mock upstream used by `make smoke-bedrock`.
// LiteLLM routes mock/* models here, which proves the MCP → LiteLLM →
// upstream → DB wiring without requiring AWS Bedrock credentials.
//
// Endpoints:
//   POST /v1/embeddings          → 1536-dim deterministic vector per input
//   POST /v1/chat/completions    → fixed JSON metadata stub
//   GET  /healthz                → {ok:true}

const PORT = parseInt(Deno.env.get("PORT") || "4001", 10);
const DIM = 1536;

async function mockEmbedding(text: string): Promise<number[]> {
  const hashBuf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  const hash = new Uint8Array(hashBuf);
  const out = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) out[i] = (hash[i % hash.length] - 128) / 128;
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return Array.from(out, (v) => v / norm);
}

function isEmbeddingsPath(p: string) {
  return p === "/embeddings" || p === "/v1/embeddings";
}
function isChatPath(p: string) {
  return p === "/chat/completions" || p === "/v1/chat/completions";
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/healthz") {
    return Response.json({ ok: true });
  }
  if (req.method === "POST" && isEmbeddingsPath(url.pathname)) {
    const body = await req.json();
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const data = [];
    for (let i = 0; i < inputs.length; i++) {
      data.push({
        object: "embedding",
        index: i,
        embedding: await mockEmbedding(String(inputs[i] ?? "")),
      });
    }
    return Response.json({
      object: "list",
      data,
      model: body.model,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  }
  if (req.method === "POST" && isChatPath(url.pathname)) {
    const body = await req.json();
    return Response.json({
      id: "mock-completion-1",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              '{"type":"observation","topics":["mock-bedrock"],"people":[],"action_items":[],"dates_mentioned":[]}',
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
  console.log(`[mock-openai] 404 ${req.method} ${url.pathname}`);
  return new Response("not found", { status: 404 });
});

console.log(`mock-openai listening on :${PORT}`);
