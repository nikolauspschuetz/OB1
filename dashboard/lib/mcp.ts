import { env } from "./env";

// Single source of truth for writes: POST to the MCP server with the
// shared key. We never reimplement tool logic in the dashboard.

export class McpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface ToolCallResult {
  // MCP returns SSE-style "event: message\ndata: {...}" with content[].text.
  // We surface either the parsed JSON body or the raw text.
  json: unknown;
  text: string;
}

/**
 * Call an MCP tool by name. The MCP server accepts streamable-http with
 * SSE responses, so we read the body, strip the SSE framing, and parse.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  requestId = 1,
): Promise<ToolCallResult> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const resp = await fetch(`${env.OB1_MCP_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "x-brain-key": env.OB1_MCP_KEY,
    },
    body,
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new McpError(
      `MCP ${name} failed: ${resp.status} ${errBody.slice(0, 200)}`,
      resp.status,
    );
  }
  const raw = await resp.text();
  // SSE: "event: message\ndata: { ... }\n\n". Strip prefixes.
  const dataLine = raw
    .split("\n")
    .find((line) => line.startsWith("data: "));
  const payload = dataLine ? dataLine.slice("data: ".length) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = null;
  }
  // MCP tool response: result.content[0].text contains the tool's text.
  let toolText = "";
  if (
    parsed && typeof parsed === "object" && "result" in parsed
  ) {
    const result = (parsed as { result?: { content?: Array<{ text?: string }> } })
      .result;
    if (result && Array.isArray(result.content) && result.content[0]?.text) {
      toolText = result.content[0].text;
    }
  }
  return { json: parsed, text: toolText };
}

/**
 * Proxy semantic embedding through the MCP server's /dashboard-api/embed
 * route (added in Phase 2). Returns vector array.
 */
export async function embed(text: string): Promise<number[]> {
  const resp = await fetch(`${env.OB1_MCP_URL}/dashboard-api/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-brain-key": env.OB1_MCP_KEY,
    },
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new McpError(
      `embed failed: ${resp.status} ${errBody.slice(0, 200)}`,
      resp.status,
    );
  }
  const json = (await resp.json()) as { embedding: number[] };
  return json.embedding;
}

/**
 * Proxy synthesis through the MCP server. Used by Cmd+K.
 */
export async function synthesize(
  query: string,
  passages: Array<{ id: string; content: string }>,
): Promise<{ answer: string; sources: string[] }> {
  const resp = await fetch(`${env.OB1_MCP_URL}/dashboard-api/synthesize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-brain-key": env.OB1_MCP_KEY,
    },
    body: JSON.stringify({ query, passages }),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new McpError(
      `synthesize failed: ${resp.status} ${errBody.slice(0, 200)}`,
      resp.status,
    );
  }
  return (await resp.json()) as { answer: string; sources: string[] };
}

/**
 * Multi-turn RAG chat. Server-side does embed → vector search → llmChat.
 */
export async function chatTurn(args: {
  history: Array<{ role: "user" | "assistant"; content: string }>;
  topK?: number;
}): Promise<{
  answer: string;
  retrieved: Array<{ id: string; content: string; similarity: number }>;
  model?: string;
}> {
  const resp = await fetch(`${env.OB1_MCP_URL}/dashboard-api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-brain-key": env.OB1_MCP_KEY,
    },
    body: JSON.stringify({ history: args.history, topK: args.topK ?? 8 }),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new McpError(
      `chat failed: ${resp.status} ${errBody.slice(0, 200)}`,
      resp.status,
    );
  }
  return (await resp.json()) as {
    answer: string;
    retrieved: Array<{ id: string; content: string; similarity: number }>;
    model?: string;
  };
}
