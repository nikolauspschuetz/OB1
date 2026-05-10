-- Typed reasoning edges + temporal validity on entity edges.
-- Ported from adamreading/OB1-AJO's schemas/typed-reasoning-edges/schema.sql.
--
-- Two distinct additions:
--   1. thought_edges — semantic reasoning relations between thoughts
--      (supports, contradicts, evolved_into, supersedes, depends_on,
--      related_to, derived_from). Targets thoughts.id (UUID).
--      Populated by Phase 4's bin/classify-edges.mjs, but the table is
--      usable standalone for hand-curated relations.
--   2. valid_from / valid_until / decay_weight columns on the entity
--      edges table (migration 005) so entity-edge relevance can decay.
--
-- Differences from upstream AJO:
--   - No RLS, no GRANT, no REVOKE — this fork has no Supabase roles.
--   - No NOTIFY pgrst (no PostgREST in stack).
--   - Prerequisite checks dropped (we know thoughts + edges exist from
--     migrations 001 and 005, applied in order on a fresh volume).
--   - thought_edges_upsert RPC keeps SET search_path = public but drops
--     SECURITY DEFINER (DB owner runs it; no multi-role context).
--
-- Safe to run multiple times.

BEGIN;

-- ============================================================
-- 1. THOUGHT_EDGES — thought↔thought reasoning relations
-- ============================================================

CREATE TABLE IF NOT EXISTS public.thought_edges (
  id BIGSERIAL PRIMARY KEY,
  from_thought_id UUID NOT NULL REFERENCES public.thoughts(id) ON DELETE CASCADE,
  to_thought_id UUID NOT NULL REFERENCES public.thoughts(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (
    relation IN (
      'supports', 'contradicts', 'evolved_into', 'supersedes',
      'depends_on', 'related_to', 'derived_from'
    )
  ),
  confidence NUMERIC(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  decay_weight NUMERIC(3,2) CHECK (
    decay_weight IS NULL OR (decay_weight >= 0 AND decay_weight <= 1)
  ),
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  classifier_version TEXT,
  support_count INT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_thought_id, to_thought_id, relation),
  CHECK (from_thought_id <> to_thought_id)
);

CREATE INDEX IF NOT EXISTS idx_thought_edges_from_relation
  ON public.thought_edges (from_thought_id, relation);
CREATE INDEX IF NOT EXISTS idx_thought_edges_to_relation
  ON public.thought_edges (to_thought_id, relation);
-- "Currently valid" edges are the dashboard's primary read path.
CREATE INDEX IF NOT EXISTS idx_thought_edges_current
  ON public.thought_edges (from_thought_id, to_thought_id)
  WHERE valid_until IS NULL;
-- Decay sweep target.
CREATE INDEX IF NOT EXISTS idx_thought_edges_valid_until
  ON public.thought_edges (valid_until)
  WHERE valid_until IS NOT NULL;

-- ============================================================
-- 2. updated_at trigger
-- ============================================================

CREATE OR REPLACE FUNCTION public.thought_edges_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_thought_edges_updated_at ON public.thought_edges;
CREATE TRIGGER trg_thought_edges_updated_at
  BEFORE UPDATE ON public.thought_edges
  FOR EACH ROW
  EXECUTE FUNCTION public.thought_edges_set_updated_at();

-- ============================================================
-- 3. UPSERT RPC
-- "Insert OR bump support_count + refresh temporal bounds" in one atomic
-- write. Used by the edge classifier (Phase 4) when reclassifying pairs.
-- NULL-safe valid_from / valid_until handling: NULL means "always" /
-- "still current", which is the more permissive bound on each end.
-- ============================================================

CREATE OR REPLACE FUNCTION public.thought_edges_upsert(
  p_from_thought_id UUID,
  p_to_thought_id UUID,
  p_relation TEXT,
  p_confidence NUMERIC,
  p_support_count INT,
  p_classifier_version TEXT,
  p_valid_from TIMESTAMPTZ,
  p_valid_until TIMESTAMPTZ,
  p_metadata JSONB
)
RETURNS public.thought_edges
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row public.thought_edges;
BEGIN
  INSERT INTO public.thought_edges (
    from_thought_id, to_thought_id, relation,
    confidence, support_count, classifier_version,
    valid_from, valid_until, metadata
  )
  VALUES (
    p_from_thought_id, p_to_thought_id, p_relation,
    p_confidence, COALESCE(p_support_count, 1), p_classifier_version,
    p_valid_from, p_valid_until, COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (from_thought_id, to_thought_id, relation)
  DO UPDATE SET
    support_count = public.thought_edges.support_count
                    + COALESCE(EXCLUDED.support_count, 1),
    confidence = GREATEST(public.thought_edges.confidence, EXCLUDED.confidence),
    valid_until = CASE
      WHEN public.thought_edges.valid_until IS NULL
        OR EXCLUDED.valid_until IS NULL THEN NULL
      ELSE GREATEST(public.thought_edges.valid_until, EXCLUDED.valid_until)
    END,
    valid_from = CASE
      WHEN public.thought_edges.valid_from IS NULL THEN EXCLUDED.valid_from
      WHEN EXCLUDED.valid_from IS NULL THEN public.thought_edges.valid_from
      ELSE LEAST(public.thought_edges.valid_from, EXCLUDED.valid_from)
    END,
    classifier_version = EXCLUDED.classifier_version,
    metadata = public.thought_edges.metadata || EXCLUDED.metadata,
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- ============================================================
-- 4. Temporal validity columns on entity edges (from migration 005)
-- ============================================================

ALTER TABLE public.edges
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decay_weight NUMERIC(3,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'edges_decay_weight_range'
  ) THEN
    ALTER TABLE public.edges
      ADD CONSTRAINT edges_decay_weight_range
      CHECK (decay_weight IS NULL OR (decay_weight >= 0 AND decay_weight <= 1));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_edges_temporal
  ON public.edges (valid_from, valid_until)
  WHERE valid_from IS NOT NULL OR valid_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edges_current
  ON public.edges (from_entity_id, to_entity_id)
  WHERE valid_until IS NULL;

COMMIT;
