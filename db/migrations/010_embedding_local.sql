-- Additive 768-dim local embedding column (Ollama nomic-embed-text).
-- Lets the brain coexist OpenAI 1536-dim embeddings (production) with
-- locally-computed 768-dim embeddings (air-gapped / Ollama) without
-- replacing the existing column or wiping the volume.
--
-- Borrowed from Poser8-Inc/OB1's pattern. Strictly better than this
-- fork's prior switch-and-wipe approach (`make switch-embedding-dim`).
--
-- Usage:
--   - Production stack: keep using `embedding` (1536-dim, OpenAI/GitHub Models).
--   - Air-gapped stack: populate `embedding_local` via a re-embed worker
--     pointed at Ollama, then search via match_thoughts_local() instead
--     of match_thoughts().
--   - Mixed mode is fine: both columns can be populated on the same row.
--
-- Safe to run multiple times.

ALTER TABLE public.thoughts
  ADD COLUMN IF NOT EXISTS embedding_local vector(768);

CREATE INDEX IF NOT EXISTS idx_thoughts_embedding_local_hnsw
  ON public.thoughts USING hnsw (embedding_local vector_cosine_ops);

-- Mirror of match_thoughts() against the 768-dim column. Same args, same
-- return shape, so callers can swap names without other code changes.
CREATE OR REPLACE FUNCTION public.match_thoughts_local(
  query_embedding vector(768),
  match_threshold FLOAT,
  match_count INT,
  filter JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  metadata JSONB,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT t.id, t.content, t.metadata,
         (1 - (t.embedding_local <=> query_embedding))::float AS similarity,
         t.created_at
    FROM public.thoughts t
   WHERE t.embedding_local IS NOT NULL
     AND 1 - (t.embedding_local <=> query_embedding) > match_threshold
     AND t.metadata @> filter
   ORDER BY t.embedding_local <=> query_embedding
   LIMIT match_count;
END;
$$;
