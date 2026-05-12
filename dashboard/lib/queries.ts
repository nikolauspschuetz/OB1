import { sql } from "./db";
import { type Cursor } from "./cursor";

export interface ThoughtRow {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  type: string | null;
  importance: number | null;
  created_at: string;
  updated_at: string;
}

export interface ThoughtListPage {
  rows: ThoughtRow[];
  nextCursor: Cursor | null;
}

export async function listThoughts(opts: {
  limit: number;
  cursor: Cursor | null;
  type?: string | null;
  topic?: string | null;
  source?: string | null;
}): Promise<ThoughtListPage> {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const conditions: string[] = ["TRUE"];
  const params: unknown[] = [];
  let p = 0;

  if (opts.cursor) {
    p += 2;
    conditions.push(
      `(created_at, id) < ($${p - 1}::timestamptz, $${p}::uuid)`,
    );
    params.push(opts.cursor.createdAt, opts.cursor.id);
  }
  if (opts.type) {
    p += 1;
    conditions.push(`type = $${p}`);
    params.push(opts.type);
  }
  if (opts.topic) {
    p += 1;
    conditions.push(`metadata->'topics' ? $${p}`);
    params.push(opts.topic);
  }
  if (opts.source) {
    p += 1;
    conditions.push(`metadata->>'source' = $${p}`);
    params.push(opts.source);
  }

  // Use unsafe with parameterized values — postgres-js's tagged template
  // doesn't compose multi-conditional WHERE well. params are properly
  // bound by the driver, not interpolated.
  const rows = await sql.unsafe<ThoughtRow[]>(
    `SELECT id, content, metadata, type, importance, created_at, updated_at
       FROM thoughts
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}`,
    params as never[],
  );

  let nextCursor: Cursor | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1];
    nextCursor = { createdAt: last.created_at, id: last.id };
    rows.length = limit;
  }
  return { rows, nextCursor };
}

export async function getThought(id: string): Promise<ThoughtRow | null> {
  const rows = await sql<ThoughtRow[]>`
    SELECT id, content, metadata, type, importance, created_at, updated_at
      FROM thoughts
     WHERE id = ${id}::uuid
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface AttributionRow {
  id: number;
  action: string;
  actor: string | null;
  old_value: unknown;
  new_value: unknown;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function getAttribution(thoughtId: string): Promise<AttributionRow[]> {
  return await sql<AttributionRow[]>`
    SELECT id, action, actor, old_value, new_value, metadata, created_at
      FROM attribution_log
     WHERE thought_id = ${thoughtId}::uuid
     ORDER BY created_at DESC
     LIMIT 100
  `;
}

export interface ThoughtEntityRow {
  entity_id: number;
  canonical_name: string;
  entity_type: string;
  mention_role: string;
}

export async function getThoughtEntities(
  thoughtId: string,
): Promise<ThoughtEntityRow[]> {
  return await sql<ThoughtEntityRow[]>`
    SELECT te.entity_id, e.canonical_name, e.entity_type, te.mention_role
      FROM thought_entities te
      JOIN entities e ON e.id = te.entity_id
     WHERE te.thought_id = ${thoughtId}::uuid
     ORDER BY e.canonical_name ASC
  `;
}

export interface EntityRow {
  id: number;
  entity_type: string;
  canonical_name: string;
  normalized_name: string;
  aliases: string[];
  pinned: boolean;
  metadata: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  thought_count: number;
}

export async function listEntities(opts: {
  type?: string | null;
  pinned?: boolean | null;
  q?: string | null;
  limit: number;
}): Promise<EntityRow[]> {
  const limit = Math.min(Math.max(opts.limit, 1), 500);
  const conditions: string[] = ["TRUE"];
  const params: unknown[] = [];
  let p = 0;
  if (opts.type) {
    p += 1;
    conditions.push(`e.entity_type = $${p}`);
    params.push(opts.type);
  }
  if (opts.pinned !== null && opts.pinned !== undefined) {
    p += 1;
    conditions.push(`e.pinned = $${p}::boolean`);
    params.push(opts.pinned);
  }
  if (opts.q) {
    p += 1;
    conditions.push(`e.normalized_name LIKE $${p}`);
    params.push(`%${opts.q.toLowerCase()}%`);
  }
  return await sql.unsafe<EntityRow[]>(
    `SELECT e.id, e.entity_type, e.canonical_name, e.normalized_name,
            COALESCE(e.aliases, '[]'::jsonb) AS aliases,
            e.pinned, e.metadata, e.first_seen_at, e.last_seen_at,
            (SELECT COUNT(*) FROM thought_entities te WHERE te.entity_id = e.id)::int AS thought_count
       FROM entities e
      WHERE ${conditions.join(" AND ")}
      ORDER BY e.pinned DESC, thought_count DESC, e.canonical_name ASC
      LIMIT ${limit}`,
    params as never[],
  );
}

export async function getEntity(id: number): Promise<EntityRow | null> {
  const rows = await sql<EntityRow[]>`
    SELECT e.id, e.entity_type, e.canonical_name, e.normalized_name,
           COALESCE(e.aliases, '[]'::jsonb) AS aliases,
           e.pinned, e.metadata, e.first_seen_at, e.last_seen_at,
           (SELECT COUNT(*) FROM thought_entities te WHERE te.entity_id = e.id)::int AS thought_count
      FROM entities e
     WHERE e.id = ${id}::bigint
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface EdgeRow {
  id: number;
  from_entity_id: number;
  to_entity_id: number;
  relation: string;
  support_count: number;
  confidence: string | null;
  to_name: string;
  to_type: string;
  from_name: string;
  from_type: string;
}

export async function getEntityEdges(entityId: number): Promise<EdgeRow[]> {
  return await sql<EdgeRow[]>`
    SELECT ed.id, ed.from_entity_id, ed.to_entity_id, ed.relation,
           ed.support_count, ed.confidence::text AS confidence,
           tt.canonical_name AS to_name, tt.entity_type AS to_type,
           ff.canonical_name AS from_name, ff.entity_type AS from_type
      FROM edges ed
      JOIN entities tt ON tt.id = ed.to_entity_id
      JOIN entities ff ON ff.id = ed.from_entity_id
     WHERE ed.from_entity_id = ${entityId}::bigint
        OR ed.to_entity_id = ${entityId}::bigint
     ORDER BY ed.support_count DESC, ed.relation ASC
     LIMIT 200
  `;
}

export async function getEntityThoughts(
  entityId: number,
  limit = 50,
): Promise<ThoughtRow[]> {
  return await sql<ThoughtRow[]>`
    SELECT t.id, t.content, t.metadata, t.type, t.importance,
           t.created_at, t.updated_at
      FROM thoughts t
      JOIN thought_entities te ON te.thought_id = t.id
     WHERE te.entity_id = ${entityId}::bigint
     ORDER BY t.created_at DESC
     LIMIT ${limit}
  `;
}

export interface WikiRow {
  id: number;
  slug: string;
  type: string;
  entity_id: number | null;
  title: string;
  content: string;
  generated_at: string;
  thought_count: number;
  metadata: Record<string, unknown>;
  manually_edited: boolean;
  notes: string | null;
  updated_at: string;
}

export async function getWiki(slug: string): Promise<WikiRow | null> {
  const rows = await sql<WikiRow[]>`
    SELECT id, slug, type, entity_id, title, content, generated_at,
           thought_count, metadata, manually_edited, notes, updated_at
      FROM wiki_pages
     WHERE slug = ${slug}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listWikis(limit = 100): Promise<WikiRow[]> {
  return await sql<WikiRow[]>`
    SELECT id, slug, type, entity_id, title, content, generated_at,
           thought_count, metadata, manually_edited, notes, updated_at
      FROM wiki_pages
     ORDER BY generated_at DESC
     LIMIT ${limit}
  `;
}

export interface QueueStats {
  pending: number;
  processing: number;
  complete: number;
  failed: number;
  skipped: number;
}

export async function getQueueStats(): Promise<QueueStats> {
  const rows = await sql<Array<{ status: string; n: number }>>`
    SELECT status, COUNT(*)::int AS n
      FROM entity_extraction_queue
     GROUP BY status
  `;
  const out: QueueStats = {
    pending: 0,
    processing: 0,
    complete: 0,
    failed: 0,
    skipped: 0,
  };
  for (const r of rows) {
    if (r.status in out) (out as unknown as Record<string, number>)[r.status] = r.n;
  }
  return out;
}

export async function getRecentQueueFailures(
  limit = 20,
): Promise<Array<{ thought_id: string; last_error: string | null; attempt_count: number; queued_at: string }>> {
  return await sql<Array<{ thought_id: string; last_error: string | null; attempt_count: number; queued_at: string }>>`
    SELECT thought_id, last_error, attempt_count, queued_at
      FROM entity_extraction_queue
     WHERE status = 'failed'
     ORDER BY queued_at DESC
     LIMIT ${limit}
  `;
}

export async function getThoughtCount(): Promise<number> {
  const r = await sql<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM thoughts`;
  return r[0]?.n ?? 0;
}

export async function getEntityCount(): Promise<number> {
  const r = await sql<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM entities`;
  return r[0]?.n ?? 0;
}

export async function getWikiCount(): Promise<number> {
  const r = await sql<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM wiki_pages`;
  return r[0]?.n ?? 0;
}

export interface SearchHit {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  created_at: string;
}

export async function vectorSearch(
  embedding: number[],
  threshold = 0.2,
  matchCount = 12,
): Promise<SearchHit[]> {
  const vec = `[${embedding.join(",")}]`;
  return await sql<SearchHit[]>`
    SELECT id, content, metadata, created_at,
           1 - (embedding <=> ${vec}::vector) AS similarity
      FROM thoughts
     WHERE 1 - (embedding <=> ${vec}::vector) > ${threshold}
     ORDER BY embedding <=> ${vec}::vector
     LIMIT ${matchCount}
  `;
}
