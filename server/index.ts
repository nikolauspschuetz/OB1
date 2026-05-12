/**
 * Open Brain MCP server — local Docker Compose edition.
 *
 * Connects directly to PostgreSQL + pgvector (no Supabase). Calls an
 * OpenAI-compatible API for embeddings, and either OpenAI-compatible or
 * Anthropic Messages API for metadata extraction.
 *
 * Env vars:
 *   Database
 *     DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 *   MCP server
 *     MCP_ACCESS_KEY  (required)
 *     MCP_PORT        (default 8000)
 *   Embeddings (always OpenAI-compatible — Anthropic does not provide embeddings)
 *     EMBEDDING_API_BASE  (default https://models.github.ai/inference)
 *     EMBEDDING_API_KEY
 *     EMBEDDING_MODEL     (default openai/text-embedding-3-small, 1536-dim)
 *   Chat / metadata extraction
 *     CHAT_PROVIDER       "openai" (default) | "anthropic"
 *     CHAT_API_BASE       (default = EMBEDDING_API_BASE)
 *     CHAT_API_KEY        (default = EMBEDDING_API_KEY)
 *     CHAT_MODEL          (default openai/gpt-4o-mini)
 *     ANTHROPIC_API_BASE  (default https://api.anthropic.com)
 *     ANTHROPIC_API_KEY
 *     ANTHROPIC_CHAT_MODEL (default claude-haiku-4-5-20251001)
 *     ANTHROPIC_VERSION   (default 2023-06-01)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { Pool } from "postgres";
import { chat as llmChat, embed as llmEmbed } from "./llm/client.ts";

// --- Config ---

const DB_HOST = Deno.env.get("DB_HOST") || "127.0.0.1";
const DB_PORT = parseInt(Deno.env.get("DB_PORT") || "5432", 10);
const DB_NAME = Deno.env.get("DB_NAME") || "openbrain";
const DB_USER = Deno.env.get("DB_USER") || "openbrain";
const DB_PASSWORD = Deno.env.get("DB_PASSWORD") ?? "";

const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY");
if (!MCP_ACCESS_KEY) {
  console.error("MCP_ACCESS_KEY is required");
  Deno.exit(1);
}
const MCP_PORT = parseInt(Deno.env.get("MCP_PORT") || "8000", 10);

// All chat / embedding / Anthropic env vars (EMBEDDING_API_BASE,
// EMBEDDING_API_KEY, EMBEDDING_MODEL, CHAT_API_BASE, CHAT_API_KEY,
// CHAT_MODEL, ANTHROPIC_API_BASE, ANTHROPIC_API_KEY, ANTHROPIC_CHAT_MODEL,
// ANTHROPIC_VERSION) are read inside the LLM wrapper at
// server/llm/client.ts. They're documented in .env.example and validated
// by ci/check-env-drift.sh which scans server/**/*.ts.
//
// CHAT_PROVIDER is still consulted here for metric labeling on chat-call
// errors before the wrapper has identified which provider it dispatched to.
const CHAT_PROVIDER = (Deno.env.get("CHAT_PROVIDER") || "openai").toLowerCase();

// LLM_MOCK=true short-circuits all outbound LLM calls so the stack boots
// and serves traffic without any provider credentials. Embeddings are
// deterministic (same input → same vector) and L2-normalized so cosine
// similarity behaves; metadata is a fixed stub. Useful for smoke tests
// and offline development. NOT for real captures — the embeddings carry
// no actual semantic signal.
const LLM_MOCK = (Deno.env.get("LLM_MOCK") || "").toLowerCase() === "true";

// Optional GitHub webhook ingestion. If empty, /webhook/github is disabled
// (returns 404). If set, incoming requests are HMAC-SHA-256 verified against
// this shared secret (the same one you paste into the GitHub webhook UI).
const GITHUB_WEBHOOK_SECRET = Deno.env.get("GITHUB_WEBHOOK_SECRET") || "";

// Optional Linear webhook ingestion. Linear sends an HMAC-SHA-256 signature
// of the raw body (no `sha256=` prefix) in the `linear-signature` header.
const LINEAR_WEBHOOK_SECRET = Deno.env.get("LINEAR_WEBHOOK_SECRET") || "";

// Optional Sentry webhook ingestion. Sentry sends an HMAC-SHA-256 signature
// (no prefix) in the `sentry-hook-signature` header.
const SENTRY_WEBHOOK_SECRET = Deno.env.get("SENTRY_WEBHOOK_SECRET") || "";

// Optional generic webhook ingestion. Caller passes the secret as the bearer
// token in `authorization: Bearer <secret>`. Body must be JSON with either:
//   • a top-level `content` field (and optional `metadata` object), OR
//   • whatever shape the upstream sends, with GENERIC_WEBHOOK_CONTENT_PATH
//     pointing at the dot-path to the content (e.g. "data.message.text").
//     GENERIC_WEBHOOK_METADATA_PATH similarly extracts a metadata object.
const GENERIC_WEBHOOK_SECRET = Deno.env.get("GENERIC_WEBHOOK_SECRET") || "";
const GENERIC_WEBHOOK_CONTENT_PATH =
  Deno.env.get("GENERIC_WEBHOOK_CONTENT_PATH") || "";
const GENERIC_WEBHOOK_METADATA_PATH =
  Deno.env.get("GENERIC_WEBHOOK_METADATA_PATH") || "";

// Optional Bearer token for /metrics. If empty, the endpoint is public —
// the typical Prometheus pattern is to keep /metrics on a private network
// and rely on a network policy / firewall instead. If you expose the server
// publicly via a tunnel, set this and configure your scraper accordingly.
const METRICS_TOKEN = Deno.env.get("METRICS_TOKEN") || "";

// --- Postgres pool ---

const pool = new Pool({
  hostname: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
}, 20);

// --- Prometheus metrics (text exposition format, no external lib) ---

type Labels = Record<string, string>;

const PROCESS_START = Date.now();
const VERSION = "1.0.0";
const HISTOGRAM_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return "";
  return JSON.stringify(keys.map((k) => [k, labels[k]]));
}

function unlabel(key: string): Labels {
  if (!key) return {};
  const arr = JSON.parse(key) as Array<[string, string]>;
  const out: Labels = {};
  for (const [k, v] of arr) out[k] = v;
  return out;
}

function renderLabels(labels: Labels, extra?: Labels): string {
  const all = { ...labels, ...(extra || {}) };
  const keys = Object.keys(all);
  if (!keys.length) return "";
  return "{" +
    keys.map((k) =>
      `${k}="${
        all[k].replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
      }"`
    ).join(",") + "}";
}

class Counter {
  private values = new Map<string, number>();
  constructor(public readonly name: string, public readonly help: string) {}
  inc(labels: Labels = {}, by = 1) {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    if (!this.values.size) lines.push(`${this.name} 0`);
    for (const [k, v] of this.values) {
      lines.push(`${this.name}${renderLabels(unlabel(k))} ${v}`);
    }
    return lines.join("\n");
  }
}

class Gauge {
  private values = new Map<string, number>();
  constructor(public readonly name: string, public readonly help: string) {}
  set(value: number, labels: Labels = {}) {
    this.values.set(labelKey(labels), value);
  }
  render(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    for (const [k, v] of this.values) {
      lines.push(`${this.name}${renderLabels(unlabel(k))} ${v}`);
    }
    return lines.join("\n");
  }
}

class Histogram {
  private bucketCounts = new Map<string, number[]>();
  private sums = new Map<string, number>();
  private counts = new Map<string, number>();
  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly buckets: number[] = HISTOGRAM_BUCKETS,
  ) {}
  observe(seconds: number, labels: Labels = {}) {
    const k = labelKey(labels);
    let bc = this.bucketCounts.get(k);
    if (!bc) {
      bc = new Array(this.buckets.length).fill(0);
      this.bucketCounts.set(k, bc);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (seconds <= this.buckets[i]) bc[i]++;
    }
    this.sums.set(k, (this.sums.get(k) ?? 0) + seconds);
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }
  render(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    if (!this.counts.size) {
      lines.push(`${this.name}_bucket{le="+Inf"} 0`);
      lines.push(`${this.name}_sum 0`);
      lines.push(`${this.name}_count 0`);
      return lines.join("\n");
    }
    for (const [k, bc] of this.bucketCounts) {
      const labels = unlabel(k);
      const total = this.counts.get(k) ?? 0;
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${this.name}_bucket${
            renderLabels(labels, { le: String(this.buckets[i]) })
          } ${bc[i]}`,
        );
      }
      lines.push(
        `${this.name}_bucket${renderLabels(labels, { le: "+Inf" })} ${total}`,
      );
      lines.push(`${this.name}_sum${renderLabels(labels)} ${this.sums.get(k)}`);
      lines.push(`${this.name}_count${renderLabels(labels)} ${total}`);
    }
    return lines.join("\n");
  }
}

const m = {
  capturesTotal: new Counter(
    "ob1_captures_total",
    "Total captured thoughts, by source.",
  ),
  searchesTotal: new Counter(
    "ob1_searches_total",
    "Total search_thoughts calls.",
  ),
  listsTotal: new Counter("ob1_lists_total", "Total list_thoughts calls."),
  statsTotal: new Counter("ob1_stats_total", "Total thought_stats calls."),
  embeddingRequestsTotal: new Counter(
    "ob1_embedding_requests_total",
    "Embedding API calls by outcome (success|error|mock).",
  ),
  chatRequestsTotal: new Counter(
    "ob1_chat_requests_total",
    "Chat API calls by provider (openai|anthropic|mock) and outcome.",
  ),
  webhookDeliveriesTotal: new Counter(
    "ob1_webhook_deliveries_total",
    "GitHub webhook deliveries by event and outcome.",
  ),
  thoughtsTotal: new Gauge(
    "ob1_thoughts_total",
    "Current row count in the thoughts table (cached up to 30s).",
  ),
  uptimeSeconds: new Gauge(
    "ob1_uptime_seconds",
    "Process uptime in seconds.",
  ),
  buildInfo: new Gauge(
    "ob1_build_info",
    "Build info; value is always 1, label-only metric.",
  ),
  embeddingDurationSeconds: new Histogram(
    "ob1_embedding_duration_seconds",
    "Embedding request latency.",
  ),
  chatDurationSeconds: new Histogram(
    "ob1_chat_duration_seconds",
    "Chat / metadata extraction latency.",
  ),
  captureDurationSeconds: new Histogram(
    "ob1_capture_duration_seconds",
    "Full captureThought pipeline latency.",
  ),
};

// thoughts_total cache so we don't hammer the DB on every scrape.
let thoughtsCountCache: { value: number; at: number } = { value: 0, at: 0 };

// Embedding-API freshness tracking, surfaced on /healthz so dashboards and
// uptime probes can spot LLM-provider outages even if the DB is fine.
const embeddingHealth: {
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
} = { lastSuccessAt: null, lastErrorAt: null, lastError: null };

// /healthz reports `degraded` if the most recent embedding success is older
// than this many seconds (set to 0 / falsy to disable the staleness check —
// useful for LLM_MOCK and idle dev environments).
const EMBEDDING_STALE_SECONDS = parseInt(
  Deno.env.get("EMBEDDING_STALE_SECONDS") || "0",
  10,
);

m.buildInfo.set(1, { version: VERSION });

// --- LLM helpers ---

const METADATA_SYSTEM_PROMPT =
  `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there. Reply with JSON only, no prose.`;

const METADATA_FALLBACK = { topics: ["uncategorized"], type: "observation" };

async function mockEmbedding(text: string): Promise<number[]> {
  const dim = 1536;
  const hashBuf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  const hash = new Uint8Array(hashBuf);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = (hash[i % hash.length] - 128) / 128;
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return Array.from(out, (v) => v / norm);
}

async function getEmbedding(text: string): Promise<number[]> {
  const t0 = performance.now();
  try {
    if (LLM_MOCK) {
      const out = await mockEmbedding(text);
      m.embeddingRequestsTotal.inc({ outcome: "mock" });
      embeddingHealth.lastSuccessAt = Date.now();
      return out;
    }
    const result = await llmEmbed({ input: text });
    m.embeddingRequestsTotal.inc({ outcome: "success" });
    embeddingHealth.lastSuccessAt = Date.now();
    return result.embeddings[0];
  } catch (err) {
    m.embeddingRequestsTotal.inc({ outcome: "error" });
    embeddingHealth.lastErrorAt = Date.now();
    embeddingHealth.lastError = (err as Error).message;
    throw err;
  } finally {
    m.embeddingDurationSeconds.observe((performance.now() - t0) / 1000);
  }
}

async function extractMetadata(
  text: string,
): Promise<Record<string, unknown>> {
  const t0 = performance.now();
  try {
    if (LLM_MOCK) {
      m.chatRequestsTotal.inc({ provider: "mock", outcome: "success" });
      return {
        type: "observation",
        topics: ["mock"],
        people: [],
        action_items: [],
        dates_mentioned: [],
      };
    }
    try {
      const result = await llmChat({
        system: METADATA_SYSTEM_PROMPT,
        messages: [{ role: "user", content: text }],
        json: true,
        maxTokens: 1024,
      });
      m.chatRequestsTotal.inc({
        provider: result.provider,
        outcome: "success",
      });
      try {
        return JSON.parse(result.text);
      } catch {
        return { ...METADATA_FALLBACK };
      }
    } catch (err) {
      m.chatRequestsTotal.inc({
        provider: CHAT_PROVIDER === "anthropic" ? "anthropic" : "openai",
        outcome: "error",
      });
      // Match prior behavior: chat call errors fall back rather than
      // propagate, so capture pipeline still proceeds with stub metadata.
      void err;
      return { ...METADATA_FALLBACK };
    }
  } finally {
    m.chatDurationSeconds.observe((performance.now() - t0) / 1000);
  }
}

// --- Capture pipeline (shared by MCP capture_thought and webhook handlers) ---

/**
 * Persist a thought: dedup-aware insert via upsert_thought, then write the
 * embedding. Set extractTopics=true to also run the LLM metadata extraction
 * and merge its fields into the supplied metadata. Webhook handlers pass
 * extractTopics=false because the source payload already carries structured
 * fields (people, type, topics) and an extra LLM round-trip would waste
 * latency and cost without adding signal.
 */
async function captureThought(
  content: string,
  opts: {
    metadata?: Record<string, unknown>;
    extractTopics?: boolean;
    source?: string;
  } = {},
): Promise<
  { id: string; fingerprint: string; metadata: Record<string, unknown> }
> {
  const t0 = performance.now();
  try {
    const baseMeta: Record<string, unknown> = { ...(opts.metadata || {}) };
    if (opts.source) baseMeta.source = opts.source;

    const [embedding, extracted] = await Promise.all([
      getEmbedding(content),
      opts.extractTopics ? extractMetadata(content) : Promise.resolve({}),
    ]);

    // Caller-provided metadata wins over LLM-extracted fields when both exist.
    const meta = { ...extracted, ...baseMeta };
    const embStr = `[${embedding.join(",")}]`;

    const client = await pool.connect();
    try {
      const upsertResult = await client.queryObject<
        { upsert_thought: { id: string; fingerprint: string } }
      >(
        `SELECT upsert_thought($1::text, $2::jsonb) AS upsert_thought`,
        [content, JSON.stringify({ metadata: meta })],
      );
      const row = upsertResult.rows[0]?.upsert_thought;
      if (!row?.id) throw new Error("upsert_thought returned no id");
      await client.queryObject(
        `UPDATE thoughts SET embedding = $1::vector WHERE id = $2::uuid`,
        [embStr, row.id],
      );
      m.capturesTotal.inc({ source: opts.source || "unknown" });
      return { id: row.id, fingerprint: row.fingerprint, metadata: meta };
    } finally {
      client.release();
    }
  } finally {
    m.captureDurationSeconds.observe((performance.now() - t0) / 1000);
  }
}

// --- MCP server ---

const server = new McpServer({ name: "open-brain", version: "1.0.0" });

// CITATION_BASE_URL is the prefix used to build the `url` field returned by
// the ChatGPT-compat `search` and `fetch` tools. ChatGPT renders the URL as
// the citation target. If you front the server with a real dashboard, point
// this at it (e.g. https://brain.example.com/thoughts). The default is a
// local placeholder — ChatGPT won't dereference it but it satisfies the
// schema and is harmless.
const CITATION_BASE_URL = Deno.env.get("CITATION_BASE_URL") ||
  "https://openbrain.local/thoughts";

function thoughtTitle(content: string, createdAt?: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt
    ? new Date(createdAt).toLocaleDateString()
    : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

function thoughtUrl(id: string): string {
  return `${CITATION_BASE_URL.replace(/\/$/, "")}/${id}`;
}

// ChatGPT's restricted MCP connector surface (Settings -> Connectors ->
// Open Brain) only invokes tools named `search` and `fetch` with a strict
// id/title/url/text/metadata shape. Distinct from search_thoughts because:
//   - search returns {id, title, url} only (no preview, no similarity, no
//     metadata) — ChatGPT cites by id and re-fetches when it wants content.
//   - fetch returns the full document for a single id.
// readOnlyHint:true tells the host these are safe for restricted contexts
// like company-knowledge connectors and deep research.

server.registerTool(
  "search",
  {
    title: "Search Open Brain",
    description:
      "Search Open Brain memories by meaning. ChatGPT-compatibility tool. Returns id/title/url triples; call fetch(id) for full content.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      query: z.string().describe(
        "The search query to run against Open Brain thoughts",
      ),
    },
  },
  async ({ query }) => {
    try {
      const qEmb = await getEmbedding(query);
      const embStr = `[${qEmb.join(",")}]`;
      const client = await pool.connect();
      try {
        const result = await client.queryObject<{
          id: string;
          content: string;
          created_at: string;
        }>(
          `SELECT t.id::text AS id, t.content,
                  to_char(t.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
             FROM thoughts t
            WHERE t.embedding IS NOT NULL
              AND 1 - (t.embedding <=> $1::vector) > 0.5
            ORDER BY t.embedding <=> $1::vector
            LIMIT 10`,
          [embStr],
        );
        const results = result.rows.map((t) => ({
          id: t.id,
          title: thoughtTitle(t.content, t.created_at),
          url: thoughtUrl(t.id),
        }));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ results }) },
          ],
        };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "fetch",
  {
    title: "Fetch Open Brain Thought",
    description:
      "Fetch one Open Brain thought by ID after using search. Returns the full content and metadata for citation. ChatGPT-compatibility tool.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      id: z.string().describe(
        "The Open Brain thought ID returned by the search tool",
      ),
    },
  },
  async ({ id }) => {
    try {
      const client = await pool.connect();
      try {
        const result = await client.queryObject<{
          id: string;
          content: string;
          metadata: Record<string, unknown>;
          created_at: string;
          updated_at: string | null;
        }>(
          `SELECT id::text AS id, content, metadata,
                  to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
                  to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
             FROM thoughts WHERE id = $1::uuid`,
          [id],
        );
        if (result.rows.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `Error: thought ${id} not found.`,
            }],
            isError: true,
          };
        }
        const t = result.rows[0];
        const document = {
          id: t.id,
          title: thoughtTitle(t.content, t.created_at),
          text: t.content,
          url: thoughtUrl(t.id),
          metadata: {
            ...t.metadata,
            created_at: t.created_at,
            updated_at: t.updated_at,
          },
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(document) }],
        };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    m.searchesTotal.inc();
    try {
      const qEmb = await getEmbedding(query);
      const embStr = `[${qEmb.join(",")}]`;
      const client = await pool.connect();
      try {
        const result = await client.queryObject<{
          content: string;
          metadata: Record<string, unknown>;
          similarity: number;
          created_at: string;
        }>(
          `SELECT t.content, t.metadata,
                  (1 - (t.embedding <=> $1::vector))::float AS similarity,
                  t.created_at
             FROM thoughts t
            WHERE t.embedding IS NOT NULL
              AND 1 - (t.embedding <=> $1::vector) > $2
            ORDER BY t.embedding <=> $1::vector
            LIMIT $3`,
          [embStr, threshold, limit],
        );
        if (!result.rows.length) {
          return {
            content: [{
              type: "text" as const,
              text: `No thoughts found matching "${query}".`,
            }],
          };
        }
        const results = result.rows.map((t, i) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${
              (t.similarity * 100).toFixed(1)
            }% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length) {
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          }
          if (Array.isArray(m.people) && m.people.length) {
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          }
          if (Array.isArray(m.action_items) && m.action_items.length) {
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          }
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        });
        return {
          content: [{
            type: "text" as const,
            text: `Found ${result.rows.length} thought(s):\n\n${
              results.join("\n\n")
            }`,
          }],
        };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe(
        "Filter by type: observation, task, idea, reference, person_note",
      ),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe(
        "Only thoughts from the last N days",
      ),
    },
  },
  async ({ limit, type, topic, person, days }) => {
    m.listsTotal.inc();
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      if (type) {
        conditions.push(`metadata->>'type' = $${p++}`);
        params.push(type);
      }
      if (topic) {
        conditions.push(`metadata->'topics' ? $${p++}`);
        params.push(topic);
      }
      if (person) {
        conditions.push(`metadata->'people' ? $${p++}`);
        params.push(person);
      }
      if (typeof days === "number") {
        conditions.push(
          `created_at >= NOW() - ($${p++}::int * INTERVAL '1 day')`,
        );
        params.push(days);
      }
      const where = conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";
      const client = await pool.connect();
      try {
        const result = await client.queryObject<{
          content: string;
          metadata: Record<string, unknown>;
          created_at: string;
        }>(
          `SELECT content, metadata, created_at
             FROM thoughts
             ${where}
            ORDER BY created_at DESC
            LIMIT $${p}`,
          [...params, limit],
        );
        if (!result.rows.length) {
          return {
            content: [{ type: "text" as const, text: "No thoughts found." }],
          };
        }
        const results = result.rows.map((t, i) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics)
            ? (m.topics as string[]).join(", ")
            : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${
            m.type || "??"
          }${tags ? " - " + tags : ""})\n   ${t.content}`;
        });
        return {
          content: [{
            type: "text" as const,
            text: `${result.rows.length} recent thought(s):\n\n${
              results.join("\n\n")
            }`,
          }],
        };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description:
      "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    inputSchema: {},
  },
  async () => {
    m.statsTotal.inc();
    try {
      const client = await pool.connect();
      try {
        const countResult = await client.queryObject<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM thoughts`,
        );
        const dataResult = await client.queryObject<{
          metadata: Record<string, unknown>;
          created_at: string;
        }>(
          `SELECT metadata, created_at FROM thoughts ORDER BY created_at DESC`,
        );
        const count = countResult.rows[0]?.count || 0;
        const data = dataResult.rows;
        const types: Record<string, number> = {};
        const topics: Record<string, number> = {};
        const people: Record<string, number> = {};
        for (const r of data) {
          const m = r.metadata || {};
          if (m.type) {
            types[m.type as string] = (types[m.type as string] || 0) + 1;
          }
          if (Array.isArray(m.topics)) {
            for (const t of m.topics) {
              topics[t as string] = (topics[t as string] || 0) + 1;
            }
          }
          if (Array.isArray(m.people)) {
            for (const ppl of m.people) {
              people[ppl as string] = (people[ppl as string] || 0) + 1;
            }
          }
        }
        const sort = (
          o: Record<string, number>,
        ): [string, number][] =>
          Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const lines: string[] = [
          `Total thoughts: ${count}`,
          `Date range: ${
            data.length
              ? new Date(data[data.length - 1].created_at)
                .toLocaleDateString() +
                " → " + new Date(data[0].created_at).toLocaleDateString()
              : "N/A"
          }`,
          "",
          "Types:",
          ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
        ];
        if (Object.keys(topics).length) {
          lines.push("", "Top topics:");
          for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
        }
        if (Object.keys(people).length) {
          lines.push("", "People mentioned:");
          for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client — notes, insights, decisions, or migrated content from other systems.",
    inputSchema: {
      content: z.string().describe(
        "The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI",
      ),
    },
  },
  async ({ content }) => {
    try {
      const { metadata: meta } = await captureThought(content, {
        extractTopics: true,
        source: "mcp",
      });
      let confirmation = `Captured as ${meta.type || "thought"}`;
      if (Array.isArray(meta.topics) && meta.topics.length) {
        confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
      }
      if (Array.isArray(meta.people) && meta.people.length) {
        confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      }
      if (Array.isArray(meta.action_items) && meta.action_items.length) {
        confirmation += ` | Actions: ${
          (meta.action_items as string[]).join("; ")
        }`;
      }
      return { content: [{ type: "text" as const, text: confirmation }] };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

// --- update_thought tool — structured edit with attribution_log ---
//
// MCP clients can edit content, type, importance, or merge metadata on an
// existing thought. Every transition is recorded in attribution_log
// (migration 009) — provides a real audit trail instead of the
// `updated_at` proxy. Mutating content re-fingerprints and re-embeds.

server.registerTool(
  "update_thought",
  {
    title: "Update Thought",
    description:
      "Update an existing thought by id. Any provided field overwrites; omitted fields are left unchanged. Mutating content re-fingerprints and re-embeds. Every change is recorded in attribution_log for audit.",
    inputSchema: {
      id: z.string().describe("UUID of the thought to update."),
      content: z.string().optional().describe(
        "New content text. If provided, also re-fingerprints and re-embeds.",
      ),
      type: z.string().optional().describe(
        "New type, e.g. observation/task/idea/reference/decision/lesson.",
      ),
      importance: z.number().int().optional().describe(
        "New importance value (1-5).",
      ),
      metadata: z.record(z.unknown()).optional().describe(
        "Metadata fields to MERGE (existing keys preserved unless overridden). Pass {} to merge nothing.",
      ),
      actor: z.string().optional().describe(
        "Who/what is making the edit. Recorded in attribution_log. Examples: 'claude', 'chatgpt', 'cli'.",
      ),
    },
  },
  async ({ id, content, type, importance, metadata, actor }) => {
    if (
      content === undefined && type === undefined &&
      importance === undefined && metadata === undefined
    ) {
      return {
        content: [{
          type: "text" as const,
          text:
            "Error: at least one of content/type/importance/metadata required.",
        }],
        isError: true,
      };
    }
    const client = await pool.connect();
    try {
      await client.queryArray("BEGIN");

      const existing = await client.queryObject<{
        content: string;
        type: string | null;
        importance: number | null;
        metadata: Record<string, unknown>;
      }>(
        `SELECT content, type, importance, metadata
           FROM thoughts WHERE id = $1::uuid FOR UPDATE`,
        [id],
      );
      if (existing.rows.length === 0) {
        await client.queryArray("ROLLBACK");
        return {
          content: [{
            type: "text" as const,
            text: `Error: thought ${id} not found.`,
          }],
          isError: true,
        };
      }
      const prev = existing.rows[0];

      const actorTag = `mcp:${actor || "unknown"}`;
      const changes: Array<{ action: string; old: unknown; new: unknown }> = [];

      // content (re-fingerprint + re-embed if changed). Fingerprint formula
      // matches the one in db/migrations/003_dedup.sql upsert_thought so the
      // partial UNIQUE index stays consistent.
      if (content !== undefined && content !== prev.content) {
        const newEmb = await getEmbedding(content);
        const embStr = `[${newEmb.join(",")}]`;
        await client.queryArray(
          `UPDATE thoughts
              SET content = $1,
                  content_fingerprint = encode(
                    sha256(convert_to(
                      lower(trim(regexp_replace($1, '\\s+', ' ', 'g'))),
                      'UTF8'
                    )),
                    'hex'
                  ),
                  embedding = $2::vector
            WHERE id = $3::uuid`,
          [content, embStr, id],
        );
        changes.push({
          action: "content_updated",
          old: prev.content.slice(0, 200),
          new: content.slice(0, 200),
        });
      }

      if (type !== undefined && type !== prev.type) {
        await client.queryArray(
          `UPDATE thoughts SET type = $1 WHERE id = $2::uuid`,
          [type, id],
        );
        changes.push({
          action: "type_changed",
          old: prev.type,
          new: type,
        });
      }

      if (importance !== undefined && importance !== prev.importance) {
        await client.queryArray(
          `UPDATE thoughts SET importance = $1 WHERE id = $2::uuid`,
          [importance, id],
        );
        changes.push({
          action: "importance_changed",
          old: prev.importance,
          new: importance,
        });
      }

      if (metadata !== undefined && Object.keys(metadata).length > 0) {
        await client.queryArray(
          `UPDATE thoughts SET metadata = metadata || $1::jsonb WHERE id = $2::uuid`,
          [JSON.stringify(metadata), id],
        );
        changes.push({
          action: "metadata_merged",
          old: prev.metadata,
          new: metadata,
        });
      }

      // Always bump updated_at (the BEFORE UPDATE trigger handles it for
      // any UPDATE that ran; this guards the no-op case where nothing
      // changed).
      if (changes.length === 0) {
        await client.queryArray("ROLLBACK");
        return {
          content: [{
            type: "text" as const,
            text: `No changes: all provided values already matched.`,
          }],
        };
      }

      for (const c of changes) {
        await client.queryArray(
          `INSERT INTO attribution_log
             (thought_id, action, old_value, new_value, actor)
           VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5)`,
          [
            id,
            c.action,
            JSON.stringify(c.old),
            JSON.stringify(c.new),
            actorTag,
          ],
        );
      }

      await client.queryArray("COMMIT");
      const summary = changes.map((c) => c.action).join(", ");
      return {
        content: [{
          type: "text" as const,
          text: `Updated thought ${id.slice(0, 8)}: ${summary}.`,
        }],
      };
    } catch (err: unknown) {
      await client.queryArray("ROLLBACK").catch(() => {});
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    } finally {
      client.release();
    }
  },
);

// --- merge_entities tool — curation primitive ---
//
// Merges a source entity into a target. Atomically (single transaction):
//   1. Re-assign thought_entities rows from source → target, collapsing
//      duplicates on the (thought_id, entity_id, mention_role) UNIQUE.
//   2. Re-assign edges in both directions (source as FROM or TO),
//      collapsing duplicates on (from_entity_id, to_entity_id, relation).
//   3. Re-assign thought_entity_edges in both directions, collapsing
//      duplicates — the Layer 2 trigger then recomputes edges.support_count.
//   4. Union the source's canonical_name + aliases into target.aliases.
//   5. Insert the source's normalized_name into entity_blocklist with
//      reason='merged' so it can't be re-created by the worker.
//   6. Delete the source's wiki_pages row (target's stays).
//   7. Delete the source entity.
//
// Improvement over the upstream Supabase REST version (arpdale fork): wraps
// everything in BEGIN/COMMIT so a network glitch mid-merge can't half-leave
// the graph in an inconsistent state.

server.registerTool(
  "merge_entities",
  {
    title: "Merge Entities",
    description:
      "Merge a source entity into a target entity. Source's links, edges, and provenance are reassigned to the target; source's canonical_name and aliases are unioned into target.aliases; source is blocklisted so the worker won't re-create it. Use when the LLM extracted two entities that should have been one (e.g. 'Tom' and 'Tom Falconar').",
    inputSchema: {
      source_id: z.number().int().describe(
        "Entity id to merge FROM (will be deleted).",
      ),
      target_id: z.number().int().describe(
        "Entity id to merge INTO (survives).",
      ),
    },
  },
  async ({ source_id, target_id }) => {
    if (
      !Number.isInteger(source_id) || !Number.isInteger(target_id) ||
      source_id === target_id
    ) {
      return {
        content: [{
          type: "text" as const,
          text: "Error: source_id and target_id must be distinct integers.",
        }],
        isError: true,
      };
    }
    const client = await pool.connect();
    try {
      await client.queryArray("BEGIN");

      const sourceRow = await client.queryObject<{
        canonical_name: string;
        aliases: unknown;
        entity_type: string;
        normalized_name: string;
      }>(
        `SELECT canonical_name, aliases, entity_type, normalized_name
           FROM entities WHERE id = $1`,
        [source_id],
      );
      if (sourceRow.rows.length === 0) {
        await client.queryArray("ROLLBACK");
        return {
          content: [{
            type: "text" as const,
            text: `Error: source entity ${source_id} not found.`,
          }],
          isError: true,
        };
      }
      const source = sourceRow.rows[0];

      const targetRow = await client.queryObject<{
        canonical_name: string;
        aliases: unknown;
      }>(
        `SELECT canonical_name, aliases FROM entities WHERE id = $1`,
        [target_id],
      );
      if (targetRow.rows.length === 0) {
        await client.queryArray("ROLLBACK");
        return {
          content: [{
            type: "text" as const,
            text:
              `Error: target entity ${target_id} not found (may have been previously deleted or merged).`,
          }],
          isError: true,
        };
      }
      const target = targetRow.rows[0];

      // 1. thought_entities: re-point to target, drop dups via INSERT
      // ON CONFLICT DO NOTHING, then delete the source's rows.
      await client.queryArray(
        `INSERT INTO thought_entities
           (thought_id, entity_id, mention_role, confidence, source, evidence)
         SELECT thought_id, $2, mention_role, confidence, source, evidence
           FROM thought_entities WHERE entity_id = $1
         ON CONFLICT (thought_id, entity_id, mention_role) DO NOTHING`,
        [source_id, target_id],
      );
      await client.queryArray(
        `DELETE FROM thought_entities WHERE entity_id = $1`,
        [source_id],
      );

      // 2. edges as FROM: re-point, drop conflicting dups
      await client.queryArray(
        `INSERT INTO edges
           (from_entity_id, to_entity_id, relation, support_count, confidence, metadata)
         SELECT $2, to_entity_id, relation, support_count, confidence, metadata
           FROM edges WHERE from_entity_id = $1
         ON CONFLICT (from_entity_id, to_entity_id, relation) DO NOTHING`,
        [source_id, target_id],
      );
      await client.queryArray(
        `DELETE FROM edges WHERE from_entity_id = $1`,
        [source_id],
      );
      // edges as TO
      await client.queryArray(
        `INSERT INTO edges
           (from_entity_id, to_entity_id, relation, support_count, confidence, metadata)
         SELECT from_entity_id, $2, relation, support_count, confidence, metadata
           FROM edges WHERE to_entity_id = $1
         ON CONFLICT (from_entity_id, to_entity_id, relation) DO NOTHING`,
        [source_id, target_id],
      );
      await client.queryArray(
        `DELETE FROM edges WHERE to_entity_id = $1`,
        [source_id],
      );

      // 3. thought_entity_edges (Layer 2 provenance) in both directions.
      // The trigger fires once per row, recomputing edges.support_count.
      await client.queryArray(
        `INSERT INTO thought_entity_edges
           (thought_id, from_entity_id, to_entity_id, relation, confidence)
         SELECT thought_id, $2, to_entity_id, relation, confidence
           FROM thought_entity_edges WHERE from_entity_id = $1
         ON CONFLICT (thought_id, from_entity_id, to_entity_id, relation) DO NOTHING`,
        [source_id, target_id],
      );
      await client.queryArray(
        `DELETE FROM thought_entity_edges WHERE from_entity_id = $1`,
        [source_id],
      );
      await client.queryArray(
        `INSERT INTO thought_entity_edges
           (thought_id, from_entity_id, to_entity_id, relation, confidence)
         SELECT thought_id, from_entity_id, $2, relation, confidence
           FROM thought_entity_edges WHERE to_entity_id = $1
         ON CONFLICT (thought_id, from_entity_id, to_entity_id, relation) DO NOTHING`,
        [source_id, target_id],
      );
      await client.queryArray(
        `DELETE FROM thought_entity_edges WHERE to_entity_id = $1`,
        [source_id],
      );

      // 4. Union aliases. Target.aliases ∪ source.aliases ∪ {source.canonical_name}.
      const srcAliases = Array.isArray(source.aliases)
        ? source.aliases as string[]
        : [];
      const tgtAliases = Array.isArray(target.aliases)
        ? target.aliases as string[]
        : [];
      const combined = Array.from(
        new Set([...tgtAliases, ...srcAliases, source.canonical_name]),
      );
      await client.queryArray(
        `UPDATE entities SET aliases = $1::jsonb, updated_at = now()
           WHERE id = $2`,
        [JSON.stringify(combined), target_id],
      );

      // 5. Blocklist source's name (entity_blocklist gate is creation-only).
      await client.queryArray(
        `INSERT INTO entity_blocklist (entity_type, normalized_name, reason)
         VALUES ($1, $2, 'merged')
         ON CONFLICT (entity_type, normalized_name) DO UPDATE
           SET reason = 'merged', blocked_at = now()`,
        [source.entity_type, source.normalized_name],
      );

      // 6. Delete source's wiki page (target's stays).
      await client.queryArray(
        `DELETE FROM wiki_pages WHERE entity_id = $1`,
        [source_id],
      );

      // 7. Delete source entity.
      await client.queryArray(
        `DELETE FROM entities WHERE id = $1`,
        [source_id],
      );

      // 8. Audit log row.
      await client.queryArray(
        `INSERT INTO consolidation_log
           (operation, survivor_id, loser_id, details)
         VALUES ('entity_merge', NULL, NULL,
           jsonb_build_object(
             'source_entity_id', $1::bigint,
             'target_entity_id', $2::bigint,
             'source_canonical_name', $3::text,
             'target_canonical_name', $4::text
           ))`,
        [source_id, target_id, source.canonical_name, target.canonical_name],
      );

      await client.queryArray("COMMIT");
      return {
        content: [{
          type: "text" as const,
          text:
            `Merged entity #${source_id} (${source.canonical_name}) into #${target_id} (${target.canonical_name}). Source blocklisted.`,
        }],
      };
    } catch (err: unknown) {
      await client.queryArray("ROLLBACK").catch(() => {});
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    } finally {
      client.release();
    }
  },
);

// --- HTTP layer (Hono) with auth + CORS ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

// Resolve the brain access key from `x-brain-key` header or `?key=` query
// param. Returns a 401 Response when missing/wrong, or null when the
// caller should proceed. Hono collapses repeated headers to "v1, v2" and
// some MCP connectors send keys split across duplicate headers — take the
// first non-empty token to handle both shapes.
function requireBrainKey(c: Context): Response | null {
  const raw = c.req.header("x-brain-key") || "";
  const headerKey = raw.includes(",") ? raw.split(",")[0].trim() : raw.trim();
  const provided = headerKey || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401, corsHeaders);
  }
  return null;
}

const app = new Hono();

app.get("/healthz", async (c) => {
  let dbOk = true;
  let dbError: string | null = null;
  try {
    const client = await pool.connect();
    try {
      await client.queryArray("SELECT 1");
    } finally {
      client.release();
    }
  } catch (err) {
    dbOk = false;
    dbError = (err as Error).message;
  }

  const now = Date.now();
  const lastSuccess = embeddingHealth.lastSuccessAt;
  const lastSuccessAge = lastSuccess !== null
    ? Math.round((now - lastSuccess) / 1000)
    : null;
  const lastError = embeddingHealth.lastError;
  const lastErrorAge = embeddingHealth.lastErrorAt !== null
    ? Math.round((now - embeddingHealth.lastErrorAt) / 1000)
    : null;

  const embeddingStale = EMBEDDING_STALE_SECONDS > 0 &&
    lastSuccess !== null &&
    lastSuccessAge !== null &&
    lastSuccessAge > EMBEDDING_STALE_SECONDS;

  const status = !dbOk ? "degraded" : embeddingStale ? "degraded" : "ok";

  const body: Record<string, unknown> = {
    status,
    db_ok: dbOk,
    embedding: {
      last_success_age_seconds: lastSuccessAge,
      last_error_age_seconds: lastErrorAge,
      last_error: lastError,
      stale_threshold_seconds: EMBEDDING_STALE_SECONDS || null,
    },
  };
  if (dbError) body.db_error = dbError;

  // Always 200 for `ok` and `degraded` so probes that trigger on non-2xx
  // don't fire on transient embedding-provider blips. Use 503 only when
  // the DB is unreachable (the fundamentally unrecoverable case).
  return c.json(body, dbOk ? 200 : 503, corsHeaders);
});

// --- /metrics (Prometheus text exposition) ---

async function refreshThoughtsCount(): Promise<void> {
  // Re-query at most every 30 seconds so frequent scrapes don't hammer the DB.
  const now = Date.now();
  if (now - thoughtsCountCache.at < 30_000) return;
  try {
    const client = await pool.connect();
    try {
      const r = await client.queryObject<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM thoughts`,
      );
      thoughtsCountCache = { value: r.rows[0]?.count ?? 0, at: now };
      m.thoughtsTotal.set(thoughtsCountCache.value);
    } finally {
      client.release();
    }
  } catch {
    // Keep previous value on transient failure.
  }
}

app.get("/metrics", async (c) => {
  if (METRICS_TOKEN) {
    const auth = c.req.header("authorization") || "";
    const expected = `Bearer ${METRICS_TOKEN}`;
    if (auth.length !== expected.length) {
      return c.text("unauthorized", 401);
    }
    let r = 0;
    for (let i = 0; i < auth.length; i++) {
      r |= auth.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (r !== 0) return c.text("unauthorized", 401);
  }
  await refreshThoughtsCount();
  m.uptimeSeconds.set((Date.now() - PROCESS_START) / 1000);
  const body = [
    m.buildInfo.render(),
    m.uptimeSeconds.render(),
    m.thoughtsTotal.render(),
    m.capturesTotal.render(),
    m.searchesTotal.render(),
    m.listsTotal.render(),
    m.statsTotal.render(),
    m.embeddingRequestsTotal.render(),
    m.chatRequestsTotal.render(),
    m.webhookDeliveriesTotal.render(),
    m.embeddingDurationSeconds.render(),
    m.chatDurationSeconds.render(),
    m.captureDurationSeconds.render(),
  ].join("\n") + "\n";
  return c.text(body, 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
});

// --- /tail (structured, since-filtered list for streaming clients) ---
//
// JSON-returning sibling to the MCP list_thoughts tool. Built specifically
// for `obctl tail`-style polling: returns rows ascending so clients can
// append, includes IDs and exact created_at so clients can dedup or restart
// from a known point. Same auth as MCP traffic (x-brain-key / ?key=).

app.get("/tail", async (c) => {
  const authError = requireBrainKey(c);
  if (authError) return authError;

  const url = new URL(c.req.url);
  const since = url.searchParams.get("since");
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") || "50", 10), 1),
    500,
  );
  const type = url.searchParams.get("type");
  const topic = url.searchParams.get("topic");
  const source = url.searchParams.get("source");

  const conditions: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  if (since) {
    conditions.push(`created_at > $${p++}::timestamptz`);
    params.push(since);
  }
  if (type) {
    conditions.push(`metadata->>'type' = $${p++}`);
    params.push(type);
  }
  if (topic) {
    conditions.push(`metadata->'topics' ? $${p++}`);
    params.push(topic);
  }
  if (source) {
    // Comma-separated values supported: ?source=github_webhook,linear_webhook
    const sources = source.split(",").map((s) => s.trim()).filter(Boolean);
    if (sources.length === 1) {
      conditions.push(`metadata->>'source' = $${p++}`);
      params.push(sources[0]);
    } else if (sources.length > 1) {
      conditions.push(`metadata->>'source' = ANY($${p++}::text[])`);
      params.push(sources);
    }
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const client = await pool.connect();
    try {
      const result = await client.queryObject<{
        id: string;
        content: string;
        metadata: Record<string, unknown>;
        created_at: string;
      }>(
        `SELECT id, content, metadata, created_at
           FROM thoughts
           ${where}
          ORDER BY created_at ASC
          LIMIT $${p}`,
        [...params, limit],
      );
      return c.json(
        result.rows.map((r) => ({
          id: r.id,
          created_at: r.created_at,
          content: r.content,
          metadata: r.metadata,
        })),
        200,
        corsHeaders,
      );
    } finally {
      client.release();
    }
  } catch (err) {
    return c.json(
      { error: (err as Error).message },
      500,
      corsHeaders,
    );
  }
});

// --- Metadata-only updates (no re-embedding) ---
//
// POST /thoughts/:id/metadata
// Body: { merge?: object, topics_add?: string[], topics_remove?: string[] }
//
// merge:           shallow JSONB || merge into metadata (top-level keys win)
// topics_add:      append to metadata.topics array (dedup, preserves order)
// topics_remove:   remove these strings from metadata.topics
//
// All ops happen in one read-modify-write so concurrent obctl invocations
// can't lose tags. Same auth as MCP traffic.

app.delete("/thoughts/:id", async (c) => {
  const authError = requireBrainKey(c);
  if (authError) return authError;
  const id = c.req.param("id");
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    return c.json({ error: "id must be a uuid" }, 400, corsHeaders);
  }
  const client = await pool.connect();
  try {
    const result = await client.queryObject<{ id: string }>(
      `DELETE FROM thoughts WHERE id = $1::uuid RETURNING id`,
      [id],
    );
    if (!result.rows.length) {
      return c.json({ error: "thought not found" }, 404, corsHeaders);
    }
    return c.json({ id, deleted: true }, 200, corsHeaders);
  } finally {
    client.release();
  }
});

app.post("/thoughts/:id/metadata", async (c) => {
  const authError = requireBrainKey(c);
  if (authError) return authError;

  const id = c.req.param("id");
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    return c.json({ error: "id must be a uuid" }, 400, corsHeaders);
  }

  let body: {
    merge?: Record<string, unknown>;
    topics_add?: string[];
    topics_remove?: string[];
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json body" }, 400, corsHeaders);
  }

  const client = await pool.connect();
  try {
    const cur = await client.queryObject<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM thoughts WHERE id = $1::uuid`,
      [id],
    );
    if (!cur.rows.length) {
      return c.json({ error: "thought not found" }, 404, corsHeaders);
    }
    const meta: Record<string, unknown> = { ...(cur.rows[0].metadata || {}) };

    if (body.merge && typeof body.merge === "object") {
      Object.assign(meta, body.merge);
    }

    if (body.topics_add?.length || body.topics_remove?.length) {
      const current = Array.isArray(meta.topics)
        ? (meta.topics as string[]).slice()
        : [];
      const toAdd = body.topics_add ?? [];
      const toRemove = new Set(body.topics_remove ?? []);
      for (const t of toAdd) if (!current.includes(t)) current.push(t);
      meta.topics = current.filter((t) => !toRemove.has(t));
    }

    await client.queryObject(
      `UPDATE thoughts SET metadata = $1::jsonb WHERE id = $2::uuid`,
      [JSON.stringify(meta), id],
    );

    return c.json({ id, metadata: meta }, 200, corsHeaders);
  } finally {
    client.release();
  }
});

// --- Embedding backfill ---
//
// POST /admin/backfill-embeddings?key=<MCP_KEY>&limit=<N>
// Re-embeds rows where embedding IS NULL — useful after a transient LLM
// provider outage, or to seed embeddings on rows captured during downtime.
// Same auth as MCP traffic.

app.post("/admin/backfill-embeddings", async (c) => {
  const authError = requireBrainKey(c);
  if (authError) return authError;

  const url = new URL(c.req.url);
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") || "100", 10), 1),
    500,
  );

  const errors: Array<{ id: string; error: string }> = [];
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  const client = await pool.connect();
  try {
    const rows = await client.queryObject<{ id: string; content: string }>(
      `SELECT id, content FROM thoughts
        WHERE embedding IS NULL
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    );
    for (const row of rows.rows) {
      processed++;
      try {
        const embedding = await getEmbedding(row.content);
        const embStr = `[${embedding.join(",")}]`;
        await client.queryObject(
          `UPDATE thoughts SET embedding = $1::vector WHERE id = $2::uuid`,
          [embStr, row.id],
        );
        succeeded++;
      } catch (err) {
        failed++;
        errors.push({ id: row.id, error: (err as Error).message });
      }
    }
  } finally {
    client.release();
  }

  return c.json({ processed, succeeded, failed, errors }, 200, corsHeaders);
});

app.options("*", (c) => c.text("ok", 200, corsHeaders));

// --- GitHub webhook ingestion ---

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyGithubSignature(
  secret: string,
  body: string,
  header: string | undefined,
): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = "sha256=" + (await hmacSha256Hex(secret, body));
  return timingSafeEqual(expected, header);
}

async function verifyHmacHex(
  secret: string,
  body: string,
  header: string | undefined,
): Promise<boolean> {
  if (!header) return false;
  const expected = await hmacSha256Hex(secret, body);
  return timingSafeEqual(expected, header.trim());
}

function repoShortName(fullName: string): string {
  const slash = fullName.lastIndexOf("/");
  return slash >= 0 ? fullName.slice(slash + 1) : fullName;
}

// Walk a dot-path through a JSON-like object: "a.b.c" → obj.a.b.c.
// Returns undefined if any segment is missing or non-object along the way.
function resolveDotPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

interface GithubEventResult {
  captured: boolean;
  reason?: string;
  id?: string;
}

async function handleGithubPullRequest(
  payload: Record<string, unknown>,
): Promise<GithubEventResult> {
  const action = payload.action as string | undefined;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const repo = payload.repository as Record<string, unknown> | undefined;
  if (action !== "closed" || !pr || pr.merged !== true) {
    return {
      captured: false,
      reason: `pull_request action=${action} merged=${pr?.merged}`,
    };
  }
  const fullName = (repo?.full_name as string) || "unknown/unknown";
  const number = pr.number as number;
  const title = pr.title as string;
  const author = (pr.user as Record<string, unknown>)?.login as string;
  const additions = (pr.additions as number) ?? 0;
  const deletions = (pr.deletions as number) ?? 0;
  const changedFiles = (pr.changed_files as number) ?? 0;
  const url = pr.html_url as string;
  const mergedAt = pr.merged_at as string;

  const content = [
    `PR merged: ${title}`,
    `Repo: ${fullName} #${number}`,
    `Author: @${author}`,
    `Changes: +${additions}/-${deletions}, ${changedFiles} file(s)`,
    `URL: ${url}`,
  ].join("\n");

  const metadata: Record<string, unknown> = {
    type: "reference",
    topics: ["github", repoShortName(fullName), "pr-merged"],
    people: author ? [author] : [],
    github: {
      event: "pull_request.merged",
      repo: fullName,
      number,
      url,
      merged_at: mergedAt,
    },
  };

  const { id } = await captureThought(content, {
    metadata,
    extractTopics: false,
    source: "github_webhook",
  });
  return { captured: true, id };
}

async function handleGithubRelease(
  payload: Record<string, unknown>,
): Promise<GithubEventResult> {
  const action = payload.action as string | undefined;
  const release = payload.release as Record<string, unknown> | undefined;
  const repo = payload.repository as Record<string, unknown> | undefined;
  if (action !== "published" || !release) {
    return { captured: false, reason: `release action=${action}` };
  }
  const fullName = (repo?.full_name as string) || "unknown/unknown";
  const tag = release.tag_name as string;
  const author = (release.author as Record<string, unknown>)?.login as string;
  const body = (release.body as string) || "";
  const url = release.html_url as string;

  const truncated = body.length > 800 ? body.slice(0, 800) + "…" : body;
  const content = [
    `Release ${tag} published in ${fullName}`,
    `Author: @${author}`,
    truncated,
    `URL: ${url}`,
  ].filter(Boolean).join("\n");

  const metadata: Record<string, unknown> = {
    type: "reference",
    topics: ["github", repoShortName(fullName), "release"],
    people: author ? [author] : [],
    github: {
      event: "release.published",
      repo: fullName,
      tag,
      url,
    },
  };

  const { id } = await captureThought(content, {
    metadata,
    extractTopics: false,
    source: "github_webhook",
  });
  return { captured: true, id };
}

// --- Linear webhook ---

async function handleLinearIssue(
  payload: Record<string, unknown>,
): Promise<GithubEventResult> {
  const action = payload.action as string | undefined;
  const data = payload.data as Record<string, unknown> | undefined;
  if (action !== "update" || !data) {
    return { captured: false, reason: `linear action=${action}` };
  }
  const state = data.state as Record<string, unknown> | undefined;
  if (state?.type !== "completed") {
    return {
      captured: false,
      reason: `linear state.type=${state?.type ?? "unknown"}`,
    };
  }
  const identifier = (data.identifier as string) || "?";
  const title = (data.title as string) || "(no title)";
  const teamKey = identifier.split("-")[0] || "linear";
  const assignee =
    (data.assignee as Record<string, unknown> | undefined)?.name ??
      (data.assignee as Record<string, unknown> | undefined)?.email ??
      null;
  const completedAt = data.completedAt as string | undefined;
  const url = data.url as string | undefined;

  const lines = [
    `Linear issue completed: ${identifier} — ${title}`,
    assignee ? `Assignee: ${assignee}` : null,
    completedAt ? `Completed: ${completedAt}` : null,
    url ? `URL: ${url}` : null,
  ].filter(Boolean) as string[];

  const metadata: Record<string, unknown> = {
    type: "reference",
    topics: ["linear", teamKey.toLowerCase(), "issue-completed"],
    people: assignee ? [String(assignee)] : [],
    linear: { event: "issue.completed", identifier, url, completedAt },
  };

  const { id } = await captureThought(lines.join("\n"), {
    metadata,
    extractTopics: false,
    source: "linear_webhook",
  });
  return { captured: true, id };
}

app.post("/webhook/linear", async (c) => {
  if (!LINEAR_WEBHOOK_SECRET) {
    m.webhookDeliveriesTotal.inc({
      event: "linear",
      outcome: "not_configured",
    });
    return c.json({ error: "linear webhook is not configured" }, 404);
  }
  const rawBody = await c.req.text();
  const sig = c.req.header("linear-signature");
  const valid = await verifyHmacHex(LINEAR_WEBHOOK_SECRET, rawBody, sig);
  if (!valid) {
    m.webhookDeliveriesTotal.inc({
      event: "linear",
      outcome: "invalid_signature",
    });
    return c.json({ error: "invalid signature" }, 401);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    m.webhookDeliveriesTotal.inc({ event: "linear", outcome: "invalid_json" });
    return c.json({ error: "invalid json" }, 400);
  }
  try {
    const eventType = (payload.type as string) || "unknown";
    const result = eventType === "Issue"
      ? await handleLinearIssue(payload)
      : { captured: false, reason: `linear type ${eventType} not handled` };
    m.webhookDeliveriesTotal.inc({
      event: "linear",
      outcome: result.captured ? "captured" : "skipped",
    });
    return c.json({ source: "linear", ...result }, 200);
  } catch (err) {
    m.webhookDeliveriesTotal.inc({ event: "linear", outcome: "error" });
    return c.json(
      { source: "linear", captured: false, error: (err as Error).message },
      500,
    );
  }
});

// --- Sentry webhook ---

async function handleSentryIssue(
  payload: Record<string, unknown>,
): Promise<GithubEventResult> {
  const action = payload.action as string | undefined;
  if (action !== "resolved") {
    return { captured: false, reason: `sentry action=${action}` };
  }
  const data = payload.data as Record<string, unknown> | undefined;
  const issue = data?.issue as Record<string, unknown> | undefined;
  if (!issue) {
    return { captured: false, reason: "sentry payload missing issue" };
  }
  const title = (issue.title as string) || "(no title)";
  const project = (issue.project as Record<string, unknown> | undefined)
    ?.slug ?? "unknown";
  const culprit = issue.culprit as string | undefined;
  const count = issue.count as string | number | undefined;
  const url = (issue.permalink as string) ||
    (issue.shortId ? `${issue.shortId}` : "");

  const lines = [
    `Sentry issue resolved: ${title}`,
    `Project: ${project}`,
    culprit ? `Culprit: ${culprit}` : null,
    count !== undefined ? `Event count: ${count}` : null,
    url ? `URL: ${url}` : null,
  ].filter(Boolean) as string[];

  const metadata: Record<string, unknown> = {
    type: "reference",
    topics: ["sentry", String(project), "resolved"],
    people: [],
    sentry: {
      event: "issue.resolved",
      project,
      url,
      shortId: issue.shortId,
    },
  };

  const { id } = await captureThought(lines.join("\n"), {
    metadata,
    extractTopics: false,
    source: "sentry_webhook",
  });
  return { captured: true, id };
}

app.post("/webhook/sentry", async (c) => {
  if (!SENTRY_WEBHOOK_SECRET) {
    m.webhookDeliveriesTotal.inc({
      event: "sentry",
      outcome: "not_configured",
    });
    return c.json({ error: "sentry webhook is not configured" }, 404);
  }
  const rawBody = await c.req.text();
  const sig = c.req.header("sentry-hook-signature");
  const valid = await verifyHmacHex(SENTRY_WEBHOOK_SECRET, rawBody, sig);
  if (!valid) {
    m.webhookDeliveriesTotal.inc({
      event: "sentry",
      outcome: "invalid_signature",
    });
    return c.json({ error: "invalid signature" }, 401);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    m.webhookDeliveriesTotal.inc({ event: "sentry", outcome: "invalid_json" });
    return c.json({ error: "invalid json" }, 400);
  }
  try {
    const result = await handleSentryIssue(payload);
    m.webhookDeliveriesTotal.inc({
      event: "sentry",
      outcome: result.captured ? "captured" : "skipped",
    });
    return c.json({ source: "sentry", ...result }, 200);
  } catch (err) {
    m.webhookDeliveriesTotal.inc({ event: "sentry", outcome: "error" });
    return c.json(
      { source: "sentry", captured: false, error: (err as Error).message },
      500,
    );
  }
});

// --- Generic webhook ---
//
// Accepts a Bearer-auth POST with body `{ content: string, metadata?: {...} }`.
// Useful for ad-hoc capture from anywhere — Zapier, n8n, custom scripts —
// without writing a service-specific handler.

app.post("/webhook/generic", async (c) => {
  if (!GENERIC_WEBHOOK_SECRET) {
    m.webhookDeliveriesTotal.inc({
      event: "generic",
      outcome: "not_configured",
    });
    return c.json({ error: "generic webhook is not configured" }, 404);
  }
  const auth = c.req.header("authorization") || "";
  const expected = `Bearer ${GENERIC_WEBHOOK_SECRET}`;
  let valid = auth.length === expected.length;
  if (valid) {
    let r = 0;
    for (let i = 0; i < auth.length; i++) {
      r |= auth.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    valid = r === 0;
  }
  if (!valid) {
    m.webhookDeliveriesTotal.inc({
      event: "generic",
      outcome: "invalid_signature",
    });
    return c.json({ error: "invalid bearer token" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    m.webhookDeliveriesTotal.inc({ event: "generic", outcome: "invalid_json" });
    return c.json({ error: "invalid json" }, 400);
  }

  // Extract content: prefer top-level `content`, fall back to dot-path lookup.
  const topLevel = body as { content?: unknown; metadata?: unknown };
  let content: string | undefined;
  if (typeof topLevel?.content === "string" && topLevel.content.trim()) {
    content = topLevel.content.trim();
  } else if (GENERIC_WEBHOOK_CONTENT_PATH) {
    const v = resolveDotPath(body, GENERIC_WEBHOOK_CONTENT_PATH);
    if (typeof v === "string" && v.trim()) content = v.trim();
  }

  if (!content) {
    m.webhookDeliveriesTotal.inc({ event: "generic", outcome: "skipped" });
    return c.json(
      {
        captured: false,
        reason: GENERIC_WEBHOOK_CONTENT_PATH
          ? `no string at body.content or path '${GENERIC_WEBHOOK_CONTENT_PATH}'`
          : "missing or empty content",
      },
      400,
    );
  }

  // Extract metadata: top-level `metadata` if present, else dot-path lookup.
  let metadata: Record<string, unknown> | undefined;
  if (topLevel?.metadata && typeof topLevel.metadata === "object") {
    metadata = topLevel.metadata as Record<string, unknown>;
  } else if (GENERIC_WEBHOOK_METADATA_PATH) {
    const v = resolveDotPath(body, GENERIC_WEBHOOK_METADATA_PATH);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      metadata = v as Record<string, unknown>;
    }
  }

  try {
    const { id } = await captureThought(content, {
      metadata,
      extractTopics: false,
      source: "generic_webhook",
    });
    m.webhookDeliveriesTotal.inc({ event: "generic", outcome: "captured" });
    return c.json({ source: "generic", captured: true, id }, 200);
  } catch (err) {
    m.webhookDeliveriesTotal.inc({ event: "generic", outcome: "error" });
    return c.json(
      { source: "generic", captured: false, error: (err as Error).message },
      500,
    );
  }
});

app.post("/webhook/github", async (c) => {
  if (!GITHUB_WEBHOOK_SECRET) {
    m.webhookDeliveriesTotal.inc({
      event: "unknown",
      outcome: "not_configured",
    });
    return c.json({ error: "github webhook is not configured" }, 404);
  }
  const rawBody = await c.req.text();
  const sig = c.req.header("x-hub-signature-256");
  const valid = await verifyGithubSignature(
    GITHUB_WEBHOOK_SECRET,
    rawBody,
    sig,
  );
  const event = c.req.header("x-github-event") || "unknown";
  if (!valid) {
    m.webhookDeliveriesTotal.inc({ event, outcome: "invalid_signature" });
    return c.json({ error: "invalid signature" }, 401);
  }
  const delivery = c.req.header("x-github-delivery") || "";

  if (event === "ping") {
    m.webhookDeliveriesTotal.inc({ event, outcome: "ping" });
    return c.json({ ok: true, message: "pong", delivery }, 200);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    m.webhookDeliveriesTotal.inc({ event, outcome: "invalid_json" });
    return c.json({ error: "invalid json" }, 400);
  }

  try {
    let result: GithubEventResult;
    if (event === "pull_request") {
      result = await handleGithubPullRequest(payload);
    } else if (event === "release") {
      result = await handleGithubRelease(payload);
    } else {
      result = { captured: false, reason: `event ${event} not handled` };
    }
    m.webhookDeliveriesTotal.inc({
      event,
      outcome: result.captured ? "captured" : "skipped",
    });
    return c.json({ event, delivery, ...result }, 200);
  } catch (err) {
    m.webhookDeliveriesTotal.inc({ event, outcome: "error" });
    console.error(`webhook error (delivery=${delivery}):`, err);
    return c.json(
      { event, delivery, captured: false, error: (err as Error).message },
      500,
    );
  }
});

app.all("*", async (c) => {
  const authError = requireBrainKey(c);
  if (authError) return authError;

  // Claude Desktop's connector UI doesn't always send the Accept header
  // StreamableHTTPTransport requires. Patch it in if missing.
  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

console.log(
  `open-brain mcp listening on :${MCP_PORT} (chat provider: ${CHAT_PROVIDER}${
    LLM_MOCK ? ", LLM_MOCK=true" : ""
  })`,
);
if (LLM_MOCK) {
  console.warn(
    "WARNING: LLM_MOCK is enabled. Embeddings are deterministic stubs with no semantic meaning. Do not use for real captures.",
  );
}
Deno.serve({ port: MCP_PORT }, app.fetch);
