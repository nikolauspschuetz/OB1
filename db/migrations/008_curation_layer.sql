-- Curation layer: blocklists, pinning, edge provenance, cleanup.
--
-- Ported from adamreading/OB1-AJO migrations 20260507000100 (entity
-- blocklist), 20260508000200 (edge blocklist + blocklist_hits),
-- 20260508000300 (entity pinning + auto-pin refresh function),
-- 20260508000400 (thought_entity_edges provenance + maintain_edge_
-- support_count trigger — the Layer 2 architectural fix), and
-- 20260507000200 (cleanup_wikis_on_thought_delete trigger).
--
-- Combined into one migration because the pieces interlock: pinning
-- gates the maintain_edge_support_count delete-vs-keep branch;
-- thought_entity_edges drives the support_count aggregate; the cleanup
-- trigger references both wiki_pages and entity_extraction_queue.
--
-- Differences from upstream AJO:
--   - No RLS / GRANT / NOTIFY pgrst (no Supabase roles in this fork).
--   - No SECURITY DEFINER on the trigger functions or the auto-pin
--     refresh RPC — the DB owner runs them, no multi-role context.
--   - SET search_path = public preserved on the trigger functions.

-- ============================================================
-- 1. ENTITY_BLOCKLIST — prevents deleted/merged names from being recreated
-- The worker's upsertEntity checks aliases first, so a merged-then-aliased
-- name still resolves to the surviving entity. This list only gates the
-- creation of *new* entity rows.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.entity_blocklist (
  entity_type TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'deleted',     -- 'deleted' | 'merged'
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_entity_blocklist_normalized
  ON public.entity_blocklist (normalized_name);

-- ============================================================
-- 2. EDGE_BLOCKLIST — manual override for removed edges
-- For symmetric relations (alternative_to, co_occurs_with, related_to,
-- collaborates_with, integrates_with), entries are stored with
-- from_entity_id < to_entity_id so a single row blocks both directions.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.edge_blocklist (
  from_entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  to_entity_id   BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  relation       TEXT NOT NULL,
  reason         TEXT NOT NULL DEFAULT 'user_removed',
  blocked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_entity_id, to_entity_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_edge_blocklist_from
  ON public.edge_blocklist (from_entity_id);
CREATE INDEX IF NOT EXISTS idx_edge_blocklist_to
  ON public.edge_blocklist (to_entity_id);

-- ============================================================
-- 3. thoughts.blocklist_hits — diagnostic counter
-- Incremented by the worker every time a thought's extraction would have
-- produced a blocklisted edge. No UI yet — just a signal column.
-- ============================================================

ALTER TABLE public.thoughts
  ADD COLUMN IF NOT EXISTS blocklist_hits INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- 4. entities.pinned + auto-pin refresh
-- Pinned entities are protected from auto-deletion when their linked-
-- thought count drops below MIN_LINKED_FOR_WIKI (3). Auto-pin rule: any
-- entity with 5+ linked thoughts is auto-pinned. metadata.pin_source
-- = 'auto' | 'manual' lets refresh_auto_pinned_entities() demote auto
-- pins below threshold without touching manual ones.
-- ============================================================

ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_entities_pinned
  ON public.entities (pinned) WHERE pinned = true;

CREATE OR REPLACE FUNCTION public.refresh_auto_pinned_entities(
  p_threshold INT DEFAULT 5
)
RETURNS TABLE(promoted INT, demoted INT)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_promoted INT;
  v_demoted INT;
BEGIN
  WITH eligible AS (
    SELECT entity_id FROM public.thought_entities
    GROUP BY entity_id HAVING count(*) >= p_threshold
  ),
  did_promote AS (
    UPDATE public.entities e
    SET pinned = true,
        metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('pin_source', 'auto'),
        updated_at = now()
    WHERE e.pinned = false
      AND e.id IN (SELECT entity_id FROM eligible)
    RETURNING 1
  )
  SELECT count(*) INTO v_promoted FROM did_promote;

  WITH below AS (
    SELECT e.id FROM public.entities e
    LEFT JOIN public.thought_entities te ON te.entity_id = e.id
    WHERE e.pinned = true
      AND COALESCE(e.metadata->>'pin_source', 'auto') = 'auto'
    GROUP BY e.id
    HAVING count(te.thought_id) < p_threshold
  ),
  did_demote AS (
    UPDATE public.entities e
    SET pinned = false, updated_at = now()
    WHERE e.id IN (SELECT id FROM below)
    RETURNING 1
  )
  SELECT count(*) INTO v_demoted FROM did_demote;

  promoted := v_promoted;
  demoted := v_demoted;
  RETURN NEXT;
END;
$$;

-- ============================================================
-- 5. THOUGHT_ENTITY_EDGES — per-thought edge provenance (Layer 2)
-- Architectural fix for "edits make wrong edges worse": until this table,
-- entity edges were write-only (re-extraction could only bump
-- support_count, never decrement, because nothing tracked which thoughts
-- contributed which edges).
--
-- Worker pattern: writeGraph DELETEs this thought's rows before re-
-- extraction, then INSERTs based on fresh Ollama output. The trigger
-- (next section) keeps edges.support_count synced as a derived aggregate.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.thought_entity_edges (
  thought_id UUID NOT NULL REFERENCES public.thoughts(id) ON DELETE CASCADE,
  from_entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  to_entity_id   BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  confidence NUMERIC(3,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thought_id, from_entity_id, to_entity_id, relation),
  CHECK (from_entity_id <> to_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_thought_entity_edges_triple
  ON public.thought_entity_edges (from_entity_id, to_entity_id, relation);
CREATE INDEX IF NOT EXISTS idx_thought_entity_edges_thought
  ON public.thought_entity_edges (thought_id);

-- ============================================================
-- 6. MAINTAIN_EDGE_SUPPORT_COUNT — the headline trigger
-- Fires on every INSERT/DELETE of thought_entity_edges. Recomputes
-- count(*) for the (from, to, relation) triple:
--   - count > 0: upsert edges row with support_count = count + max conf.
--   - count = 0 with pinned endpoint: keep edges row at support_count=0
--     (manual curation survives).
--   - count = 0 with no pinned endpoint: DELETE the edges row.
-- ============================================================

CREATE OR REPLACE FUNCTION public.maintain_edge_support_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_from BIGINT;
  v_to BIGINT;
  v_rel TEXT;
  v_count INT;
  v_max_conf NUMERIC(3,2);
  v_pinned BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_from := OLD.from_entity_id;
    v_to   := OLD.to_entity_id;
    v_rel  := OLD.relation;
  ELSE
    v_from := NEW.from_entity_id;
    v_to   := NEW.to_entity_id;
    v_rel  := NEW.relation;
  END IF;

  SELECT count(*), max(confidence)
  INTO v_count, v_max_conf
  FROM public.thought_entity_edges
  WHERE from_entity_id = v_from
    AND to_entity_id   = v_to
    AND relation       = v_rel;

  IF v_count = 0 THEN
    SELECT bool_or(pinned) INTO v_pinned
    FROM public.entities
    WHERE id IN (v_from, v_to);

    IF v_pinned THEN
      UPDATE public.edges
      SET support_count = 0, updated_at = now()
      WHERE from_entity_id = v_from
        AND to_entity_id   = v_to
        AND relation       = v_rel;
    ELSE
      DELETE FROM public.edges
      WHERE from_entity_id = v_from
        AND to_entity_id   = v_to
        AND relation       = v_rel;
    END IF;
  ELSE
    INSERT INTO public.edges
      (from_entity_id, to_entity_id, relation, support_count, confidence)
    VALUES (v_from, v_to, v_rel, v_count, v_max_conf)
    ON CONFLICT (from_entity_id, to_entity_id, relation) DO UPDATE SET
      support_count = EXCLUDED.support_count,
      confidence    = EXCLUDED.confidence,
      updated_at    = now();
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_maintain_edge_support_ins ON public.thought_entity_edges;
CREATE TRIGGER trg_maintain_edge_support_ins
  AFTER INSERT ON public.thought_entity_edges
  FOR EACH ROW
  EXECUTE FUNCTION public.maintain_edge_support_count();

DROP TRIGGER IF EXISTS trg_maintain_edge_support_del ON public.thought_entity_edges;
CREATE TRIGGER trg_maintain_edge_support_del
  AFTER DELETE ON public.thought_entity_edges
  FOR EACH ROW
  EXECUTE FUNCTION public.maintain_edge_support_count();

-- ============================================================
-- 7. CLEANUP_WIKIS_ON_THOUGHT_DELETE
-- When a thought is deleted, walk its entity links. For each entity:
--   - If remaining link count < MIN_LINKED_FOR_WIKI (3): DELETE the
--     wiki_pages row (the page would carry stale [#N] citations).
--   - Otherwise: re-queue the entity's most recent linked thought so
--     the worker regenerates the wiki without the dead citation.
-- Runs BEFORE DELETE so thought_entities is still queryable (the
-- CASCADE on thoughts→thought_entities fires AFTER the delete).
-- ============================================================

CREATE OR REPLACE FUNCTION public.cleanup_wikis_on_thought_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  affected_entity_id BIGINT;
  link_count INT;
  recent_thought_id UUID;
  min_linked CONSTANT INT := 3;
BEGIN
  FOR affected_entity_id IN
    SELECT DISTINCT entity_id FROM public.thought_entities
    WHERE thought_id = OLD.id
  LOOP
    SELECT count(*) INTO link_count
    FROM public.thought_entities
    WHERE entity_id = affected_entity_id
      AND thought_id <> OLD.id;

    IF link_count < min_linked THEN
      DELETE FROM public.wiki_pages WHERE entity_id = affected_entity_id;
    ELSE
      SELECT te.thought_id INTO recent_thought_id
      FROM public.thought_entities te
      JOIN public.thoughts t ON t.id = te.thought_id
      WHERE te.entity_id = affected_entity_id
        AND te.thought_id <> OLD.id
      ORDER BY t.updated_at DESC NULLS LAST
      LIMIT 1;

      IF recent_thought_id IS NOT NULL THEN
        INSERT INTO public.entity_extraction_queue
          (thought_id, status, queued_at)
        VALUES (recent_thought_id, 'pending', now())
        ON CONFLICT (thought_id) DO UPDATE SET
          status        = 'pending',
          attempt_count = 0,
          last_error    = NULL,
          queued_at     = now();
      END IF;
    END IF;
  END LOOP;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_cleanup_wikis_on_thought_delete ON public.thoughts;
CREATE TRIGGER trg_cleanup_wikis_on_thought_delete
  BEFORE DELETE ON public.thoughts
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_wikis_on_thought_delete();
