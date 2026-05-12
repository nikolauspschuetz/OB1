/**
 * Typed-edge classifier.
 *
 * Finds pairs of thoughts that share at least one entity, classifies the
 * semantic relation between them (supports | contradicts | evolved_into |
 * supersedes | depends_on | related_to | derived_from), and upserts via
 * the thought_edges_upsert RPC from migration 006.
 *
 * Ported (streamlined) from adamreading/OB1-AJO recipes/typed-edge-
 * classifier/classify-edges.mjs. Differences:
 *   - Deno + direct postgres.
 *   - LLM via server/llm/client.ts wrapper.
 *   - Single-stage classifier (no separate pre-filter — that's a cost
 *     optimization for $$$ providers; not needed for Ollama/mock).
 *   - No semantic-expand, no cost cap (caller responsibility), no
 *     --mirror-supersedes.
 *   - LLM_MOCK=true emits a `related_to` edge for each candidate.
 *
 * Usage:
 *     docker compose -p ob1-<profile> exec worker \
 *       deno run --allow-net --allow-env --allow-read \
 *       /app/classify.ts --limit 50
 */

import { Pool } from "postgres";
import { chat as llmChat } from "./llm/client.ts";

// --- Config ---

const DB_HOST = Deno.env.get("DB_HOST") || "127.0.0.1";
const DB_PORT = parseInt(Deno.env.get("DB_PORT") || "5432", 10);
const DB_NAME = Deno.env.get("DB_NAME") || "openbrain";
const DB_USER = Deno.env.get("DB_USER") || "openbrain";
const DB_PASSWORD = Deno.env.get("DB_PASSWORD") ?? "";

const LLM_MOCK = (Deno.env.get("LLM_MOCK") || "").toLowerCase() === "true";
const CLASSIFIER_VERSION = "ob1-edge-classifier-v1";

const pool = new Pool({
  hostname: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
}, 3);

const VALID_THOUGHT_RELATIONS = new Set([
  "supports",
  "contradicts",
  "evolved_into",
  "supersedes",
  "depends_on",
  "related_to",
  "derived_from",
]);

// --- Types ---

interface Candidate {
  from_id: string;
  from_content: string;
  from_date: string;
  to_id: string;
  to_content: string;
  to_date: string;
  shared_entities: number;
}

interface Classification {
  relation: string;
  direction: "A_to_B" | "B_to_A" | "symmetric";
  confidence: number;
  rationale: string;
  valid_from: string | null;
  valid_until: string | null;
}

// --- DB helpers ---

type DbClient = Awaited<ReturnType<typeof pool.connect>>;

async function withClient<T>(fn: (c: DbClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

async function fetchCandidates(limit: number): Promise<Candidate[]> {
  // Pairs of thoughts sharing at least one entity. We dedupe by
  // (a.id, b.id) where a.id < b.id, and exclude pairs that already have
  // *any* thought_edges row (any direction, any relation) — the upsert
  // RPC would just bump support_count, but the classifier runs more
  // efficiently if it doesn't re-look at already-classified pairs.
  const result = await withClient((c) =>
    c.queryObject<Candidate>(
      `WITH pairs AS (
         SELECT te1.thought_id AS a_id, te2.thought_id AS b_id,
                count(DISTINCT te1.entity_id) AS shared
           FROM thought_entities te1
           JOIN thought_entities te2
             ON te1.entity_id = te2.entity_id
            AND te1.thought_id < te2.thought_id
          GROUP BY te1.thought_id, te2.thought_id
       )
       SELECT a.id::text AS from_id,
              a.content AS from_content,
              to_char(a.created_at, 'YYYY-MM-DD') AS from_date,
              b.id::text AS to_id,
              b.content AS to_content,
              to_char(b.created_at, 'YYYY-MM-DD') AS to_date,
              p.shared::int AS shared_entities
       FROM pairs p
       JOIN thoughts a ON a.id = p.a_id
       JOIN thoughts b ON b.id = p.b_id
       WHERE NOT EXISTS (
         SELECT 1 FROM thought_edges e
          WHERE (e.from_thought_id = p.a_id AND e.to_thought_id = p.b_id)
             OR (e.from_thought_id = p.b_id AND e.to_thought_id = p.a_id)
       )
       ORDER BY p.shared DESC, a.created_at DESC
       LIMIT $1`,
      [limit],
    )
  );
  return result.rows;
}

async function upsertEdge(
  fromId: string,
  toId: string,
  relation: string,
  confidence: number,
  validFrom: string | null,
  validUntil: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await withClient((c) =>
    c.queryArray(
      `SELECT thought_edges_upsert($1::uuid, $2::uuid, $3, $4::numeric,
                                   1, $5, $6::timestamptz, $7::timestamptz,
                                   $8::jsonb)`,
      [
        fromId,
        toId,
        relation,
        confidence,
        CLASSIFIER_VERSION,
        validFrom,
        validUntil,
        JSON.stringify(metadata),
      ],
    )
  );
}

// --- LLM prompt ---

const SYSTEM_PROMPT =
  `You classify the semantic relationship between two thoughts from someone's personal knowledge base. Return strict JSON, no markdown.

ALLOWED RELATIONS (pick exactly one, or "none"):
- supports     — A strengthens or provides evidence for B
- contradicts  — A disagrees with or disproves B (be rare; only direct conflicts)
- evolved_into — A was replaced by a refined/updated B over time
- supersedes   — A is the newer replacement for B (subject is the survivor)
- depends_on   — A is conditional on B being true or completing first
- related_to   — generic association; use sparingly, prefer "none" when unclear

RETURN "none" WHEN:
- the thoughts merely co-mention an entity without a directional relation
- no specific label is clearly better than related_to
- evidence is ambiguous within the pair itself

DIRECTION: pick whichever makes the sentence true when substituting:
  A <relation> B  (e.g. "Tuesday sleep supports Tuesday sharpness")
  If direction should be flipped, set direction="B_to_A".
  If the relation is inherently symmetric, set direction="symmetric".

TEMPORALITY: if the relation has clear bounds ("was true until Q4 2025"), populate valid_from / valid_until as ISO YYYY-MM-DD; otherwise null.

OUTPUT strict valid JSON:
{"relation": "<type|none>", "direction": "A_to_B|B_to_A|symmetric", "confidence": 0.0-1.0, "rationale": "...", "valid_from": "YYYY-MM-DD|null", "valid_until": "YYYY-MM-DD|null"}`;

function buildUserMessage(c: Candidate): string {
  return `A (id=${c.from_id.slice(0, 8)}, date=${c.from_date}):
${c.from_content.slice(0, 800)}

B (id=${c.to_id.slice(0, 8)}, date=${c.to_date}):
${c.to_content.slice(0, 800)}`;
}

// Cheap pre-filter: ~100 tokens in, ~30 out. Asks the model whether the
// pair is worth deep classification at all. Skipping this halves the
// classifier's token bill on paid providers (Anthropic/Bedrock); leaves
// throughput unchanged on Ollama/mock. Caller bypasses the prefilter
// when `--skip-prefilter` is set.

const PREFILTER_SYSTEM =
  `You are a fast pre-filter for a reasoning-edge classifier. Given two thoughts, answer whether there is ANY meaningful semantic relation beyond simple co-mention (one of: supports, contradicts, evolved_into, supersedes, depends_on). Reply with strict JSON only, no markdown:
{"worth_classifying": true|false, "hunch": "<one-word relation or none>"}`;

function buildPrefilterMessage(c: Candidate): string {
  return `A: ${c.from_content.slice(0, 400)}

B: ${c.to_content.slice(0, 400)}`;
}

async function prefilterPair(c: Candidate): Promise<boolean> {
  if (LLM_MOCK) return true; // mock always wants to classify
  try {
    const result = await llmChat({
      system: PREFILTER_SYSTEM,
      messages: [{ role: "user", content: buildPrefilterMessage(c) }],
      json: true,
      disableThinking: true,
      temperature: 0,
      maxTokens: 128,
    });
    const parsed = JSON.parse(result.text) as { worth_classifying?: boolean };
    return parsed.worth_classifying === true;
  } catch {
    // Pre-filter failure is non-fatal: fall through to expensive classifier.
    return true;
  }
}

async function classifyPair(c: Candidate): Promise<Classification | null> {
  if (LLM_MOCK) {
    return {
      relation: "related_to",
      direction: "symmetric",
      confidence: 0.7,
      rationale: "mock classifier",
      valid_from: null,
      valid_until: null,
    };
  }

  const result = await llmChat({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(c) }],
    json: true,
    disableThinking: true,
    temperature: 0,
    maxTokens: 512,
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    return null;
  }
  const relation = String(parsed.relation || "").toLowerCase();
  if (relation === "none" || !VALID_THOUGHT_RELATIONS.has(relation)) {
    return null;
  }
  const direction = parsed.direction === "B_to_A"
    ? "B_to_A"
    : parsed.direction === "symmetric"
    ? "symmetric"
    : "A_to_B";
  const confidence = Math.max(
    0,
    Math.min(1, Number(parsed.confidence) || 0),
  );
  return {
    relation,
    direction,
    confidence,
    rationale: String(parsed.rationale || "").slice(0, 500),
    valid_from: parsed.valid_from && parsed.valid_from !== "null"
      ? String(parsed.valid_from)
      : null,
    valid_until: parsed.valid_until && parsed.valid_until !== "null"
      ? String(parsed.valid_until)
      : null,
  };
}

// --- Main batch ---

interface RunOptions {
  limit: number;
  minConfidence: number;
  skipPrefilter: boolean;
}

export async function classifyEdges(
  options: RunOptions,
): Promise<
  {
    classified: number;
    prefiltered_out: number;
    skipped: number;
    written: number;
  }
> {
  const candidates = await fetchCandidates(options.limit);
  console.log(
    `[classify] ${candidates.length} candidate pair(s). min-confidence=${options.minConfidence} prefilter=${
      options.skipPrefilter ? "off" : "on"
    }`,
  );

  let written = 0;
  let skipped = 0;
  let prefiltered_out = 0;
  for (const c of candidates) {
    if (!options.skipPrefilter) {
      const worth = await prefilterPair(c);
      if (!worth) {
        prefiltered_out++;
        continue;
      }
    }
    const cls = await classifyPair(c);
    if (!cls) {
      skipped++;
      continue;
    }
    if (cls.confidence < options.minConfidence) {
      skipped++;
      continue;
    }
    let fromId = c.from_id;
    let toId = c.to_id;
    if (cls.direction === "B_to_A") {
      fromId = c.to_id;
      toId = c.from_id;
    } else if (cls.direction === "symmetric") {
      if (fromId > toId) [fromId, toId] = [toId, fromId];
    }
    await upsertEdge(
      fromId,
      toId,
      cls.relation,
      cls.confidence,
      cls.valid_from,
      cls.valid_until,
      { rationale: cls.rationale, direction: cls.direction },
    );
    written++;
  }
  return {
    classified: candidates.length,
    prefiltered_out,
    skipped,
    written,
  };
}

function parseCliArgs(): RunOptions {
  const args = Deno.args;
  let limit = 50;
  let minConfidence = 0.75;
  let skipPrefilter = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--min-confidence" && args[i + 1]) {
      minConfidence = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === "--skip-prefilter") {
      skipPrefilter = true;
    }
  }
  return { limit, minConfidence, skipPrefilter };
}

if (import.meta.main) {
  const opts = parseCliArgs();
  try {
    const out = await classifyEdges(opts);
    console.log(
      `[classify] done: ${out.written} edge(s) written, ${out.skipped} skipped, ${out.prefiltered_out} prefilter-rejected, ${out.classified} pair(s) examined`,
    );
    Deno.exit(0);
  } catch (err) {
    console.error(`[classify] error: ${(err as Error).message}`);
    Deno.exit(1);
  }
}
