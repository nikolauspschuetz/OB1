-- Enhanced thoughts columns.
-- Adds structured fields used by the entity-graph pipeline (type,
-- sensitivity_tier, importance, quality_score, source_type, enriched)
-- plus a GIN tsvector index for future full-text search.
--
-- The optional RPCs (search_thoughts_text, brain_stats_aggregate,
-- get_thought_connections) from adamreading/OB1-AJO's enhanced-thoughts
-- schema are intentionally not ported here — they're standalone read
-- primitives that will land in a separate migration when wired into the
-- MCP server.
--
-- Safe to run multiple times (fully idempotent).

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS sensitivity_tier TEXT DEFAULT 'standard';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS importance SMALLINT DEFAULT 3;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS quality_score NUMERIC(5,2) DEFAULT 50;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS enriched BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_thoughts_type ON thoughts (type);
CREATE INDEX IF NOT EXISTS idx_thoughts_importance ON thoughts (importance DESC);
CREATE INDEX IF NOT EXISTS idx_thoughts_source_type ON thoughts (source_type);
CREATE INDEX IF NOT EXISTS idx_thoughts_content_tsvector
  ON thoughts USING gin (to_tsvector('simple', coalesce(content, '')));

-- Backfill from existing metadata for rows captured before this migration.
-- WHERE ... IS NULL guards keep this idempotent.

UPDATE thoughts SET type = metadata->>'type'
WHERE type IS NULL AND metadata->>'type' IS NOT NULL
  AND metadata->>'type' IN (
    'idea', 'task', 'person_note', 'reference', 'decision',
    'lesson', 'meeting', 'journal', 'observation'
  );

UPDATE thoughts SET source_type = metadata->>'source'
WHERE source_type IS NULL AND metadata->>'source' IS NOT NULL;
