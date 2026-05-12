-- Attribution log: records every state transition on a thought as a
-- structured audit row, replacing `updated_at`-as-activity-proxy.
--
-- Inspired by dfrysinger/OB1's pattern: queries like "show me every
-- resume add since Tuesday" become an indexed lookup on
-- (action, ts) instead of a full-table scan on metadata.
--
-- Written by the update_thought MCP tool (server/index.ts) on each
-- structured update. Other writers (worker, webhooks) can also insert
-- here; the schema is intentionally generic.

CREATE TABLE IF NOT EXISTS public.attribution_log (
  id BIGSERIAL PRIMARY KEY,
  thought_id UUID REFERENCES public.thoughts(id) ON DELETE CASCADE,
  action TEXT NOT NULL,             -- e.g. 'content_updated', 'type_changed',
                                    -- 'metadata_merged', 'importance_changed'
  old_value JSONB,                  -- prior state, structured
  new_value JSONB,                  -- post-change state
  actor TEXT,                       -- 'mcp:claude', 'webhook:github', 'worker'
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attribution_log_thought
  ON public.attribution_log (thought_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attribution_log_action
  ON public.attribution_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attribution_log_actor
  ON public.attribution_log (actor, created_at DESC)
  WHERE actor IS NOT NULL;
