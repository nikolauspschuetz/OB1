-- Wiki pages — persistent store for entity and topic wiki articles.
-- Written by the wiki compiler (Phase 3, bin/wiki-compile.mjs). The
-- `notes` column is the curator override field — written by the user
-- (eventually via a UI), never overwritten by auto-regeneration, and
-- incorporated by the synthesizer as authoritative input.
--
-- `manually_edited=true` is a separate flag that protects the entire
-- generated body from compiler overwrites — set when a user edits the
-- markdown directly.
--
-- Ported from adamreading/OB1-AJO migrations
-- 20260503000400_wiki_pages.sql and 20260504000100_wiki_notes.sql,
-- combined into one migration for ordering simplicity.

CREATE TABLE IF NOT EXISTS public.wiki_pages (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'entity' CHECK (type IN ('entity', 'topic')),
  entity_id BIGINT REFERENCES public.entities(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  thought_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  manually_edited BOOLEAN NOT NULL DEFAULT false,
  notes TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_type ON public.wiki_pages (type);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_entity_id
  ON public.wiki_pages (entity_id);
