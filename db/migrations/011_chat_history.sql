-- Chat conversations — RAG-style "talk to your brain" feature.
-- The dashboard's /chat surface persists multi-turn conversations.
-- Every user turn is embedded → top-N retrieved from thoughts → passed
-- to the LLM wrapper as system context → response saved as an
-- assistant turn with the retrieved thought IDs recorded for
-- citation expansion.
--
-- Conversations are not "thoughts" — they're a parallel surface
-- that READS the brain. Future work may capture conversation
-- highlights back as thoughts (capture_from_chat tool) but for now
-- chats are their own thing.

CREATE TABLE IF NOT EXISTS public.chats (
  id BIGSERIAL PRIMARY KEY,
  title TEXT,                                  -- auto-generated from the first user turn; user can rename later
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,         -- thought UUIDs the assistant cited
  retrieval JSONB NOT NULL DEFAULT '[]'::jsonb,         -- top-N retrieved {id, similarity, snippet}
  model TEXT,                                           -- chat model used for the assistant turn
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chats_recent
  ON public.chats (archived, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat
  ON public.chat_messages (chat_id, created_at);
