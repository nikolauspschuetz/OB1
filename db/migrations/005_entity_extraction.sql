-- Entity-extraction graph tables + auto-queue trigger.
-- Ported from adamreading/OB1-AJO's schemas/entity-extraction/schema.sql.
--
-- Adds the data model the entity-extraction worker (Phase 2,
-- bin/worker.mjs) drains from entity_extraction_queue, populates
-- entities/edges/thought_entities, and tracks via consolidation_log.
--
-- Differences from upstream AJO:
--   - No RLS / GRANT / NOTIFY pgrst (this fork has no Supabase roles).
--   - No SECURITY DEFINER on the trigger function (the DB owner runs it).
--   - Prerequisite check on thoughts.content_fingerprint removed —
--     migration 003_dedup.sql ships that column.
--   - AJO-compatibility ALTER blocks for legacy installs are removed —
--     fresh install only.
--   - wiki_pages and curation tables (blocklist, pinning, provenance)
--     are in migrations 007 and 008 respectively.
--
-- Safe to run multiple times (fully idempotent).

-- ============================================================
-- 1. ENTITIES — canonical graph nodes
-- ============================================================

CREATE TABLE IF NOT EXISTS public.entities (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,        -- person | project | topic | tool | organization | place
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,    -- lowercase, trimmed, for dedup
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type, normalized_name)
);

-- ============================================================
-- 2. EDGES — typed entity↔entity relationships
-- Vocabulary used by the worker:
--   co_occurs_with, works_on, uses, related_to, member_of, located_in,
--   collaborates_with, integrates_with, alternative_to, evaluates
-- No CHECK constraint — vocab grows with the extractor prompt.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.edges (
  id BIGSERIAL PRIMARY KEY,
  from_entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  to_entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  support_count INT NOT NULL DEFAULT 1,
  confidence NUMERIC(3,2),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_entity_id, to_entity_id, relation)
);

-- ============================================================
-- 3. THOUGHT_ENTITIES — evidence-bearing thought↔entity links
-- ============================================================

CREATE TABLE IF NOT EXISTS public.thought_entities (
  thought_id UUID NOT NULL REFERENCES public.thoughts(id) ON DELETE CASCADE,
  entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  mention_role TEXT NOT NULL DEFAULT 'mentioned',
  confidence NUMERIC(3,2),
  source TEXT NOT NULL DEFAULT 'entity_worker',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (thought_id, entity_id, mention_role)
);

-- ============================================================
-- 4. ENTITY_EXTRACTION_QUEUE — async work queue
-- One row per thought; the worker polls for status='pending'.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.entity_extraction_queue (
  thought_id UUID PRIMARY KEY REFERENCES public.thoughts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'complete', 'failed', 'skipped')),
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  source_fingerprint TEXT,
  source_updated_at TIMESTAMPTZ,
  worker_version TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ============================================================
-- 5. CONSOLIDATION_LOG — audit trail for merges, fixes, syntheses
-- ============================================================

CREATE TABLE IF NOT EXISTS public.consolidation_log (
  id BIGSERIAL PRIMARY KEY,
  operation TEXT NOT NULL,          -- dedup_merge | metadata_fix | bio_synthesis | ...
  survivor_id UUID,
  loser_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 6. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_entities_type ON public.entities (entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_normalized ON public.entities (normalized_name);
CREATE INDEX IF NOT EXISTS idx_edges_from ON public.edges (from_entity_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON public.edges (to_entity_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON public.edges (relation);
CREATE INDEX IF NOT EXISTS idx_thought_entities_entity ON public.thought_entities (entity_id);
CREATE INDEX IF NOT EXISTS idx_thought_entities_thought ON public.thought_entities (thought_id);
-- Partial index: the worker's hot read path.
CREATE INDEX IF NOT EXISTS idx_extraction_queue_status
  ON public.entity_extraction_queue (status)
  WHERE status = 'pending';

-- ============================================================
-- 7. AUTO-QUEUE TRIGGER
-- Fires on INSERT or UPDATE OF content/metadata. Skips system-generated
-- artifacts (metadata.generated_by IS NOT NULL). The fingerprint guard
-- in the ON CONFLICT clause makes no-op re-saves cheap (no re-queue).
-- ============================================================

CREATE OR REPLACE FUNCTION public.queue_entity_extraction()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_source_fingerprint TEXT;
BEGIN
  IF NEW.metadata->>'generated_by' IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_source_fingerprint := COALESCE(
    NEW.content_fingerprint,
    md5(lower(trim(regexp_replace(NEW.content, '\s+', ' ', 'g'))))
  );

  INSERT INTO public.entity_extraction_queue
    (thought_id, status, source_fingerprint, source_updated_at)
  VALUES (NEW.id, 'pending', v_source_fingerprint, NEW.updated_at)
  ON CONFLICT (thought_id) DO UPDATE SET
    status             = 'pending',
    attempt_count      = 0,
    last_error         = NULL,
    queued_at          = now(),
    source_fingerprint = EXCLUDED.source_fingerprint,
    source_updated_at  = EXCLUDED.source_updated_at
  WHERE entity_extraction_queue.source_fingerprint
        IS DISTINCT FROM EXCLUDED.source_fingerprint;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_queue_entity_extraction ON public.thoughts;
CREATE TRIGGER trg_queue_entity_extraction
  AFTER INSERT OR UPDATE OF content, metadata ON public.thoughts
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_entity_extraction();
