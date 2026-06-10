-- A2 — Copilot KNOWLEDGE RAG. A curated library of trading literature (books / papers / articles /
-- notes) the agent retrieves from at reasoning time — separate from episodic trade memory (agent_episodes).
-- Same pgvector(1536) + HNSW cosine machinery as agent_memory (0016). owner_id NULL = global shelf
-- (shared, de-identified) so a starter library benefits every user; non-null = a user's own uploads.
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per ingested document.
CREATE TABLE IF NOT EXISTS agent_knowledge_doc (
  id            BIGSERIAL PRIMARY KEY,
  owner_id      BIGINT REFERENCES users(id),          -- NULL = global shelf
  title         TEXT NOT NULL,
  author        TEXT,
  source_url    TEXT,
  kind          TEXT NOT NULL DEFAULT 'article',      -- book|paper|article|note
  tags          TEXT[] NOT NULL DEFAULT '{}',
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  token_count   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'ready',        -- ready|ingesting|error
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_knowledge_doc_owner_idx ON agent_knowledge_doc (owner_id, deleted_at, added_at DESC);

-- One row per chunk (200–500 token, structure-aware) with its embedding + provenance for citations.
CREATE TABLE IF NOT EXISTS agent_knowledge_chunk (
  id              BIGSERIAL PRIMARY KEY,
  doc_id          BIGINT NOT NULL REFERENCES agent_knowledge_doc(id) ON DELETE CASCADE,
  owner_id        BIGINT,                              -- denormalized from doc for recall filtering (NULL=global)
  ordinal         INTEGER NOT NULL,                    -- position in the document
  heading_path    TEXT,                                -- e.g. "Ch.4 > Risk of Ruin" (citation context)
  text            TEXT NOT NULL,
  token_count     INTEGER NOT NULL DEFAULT 0,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  embedding_model TEXT NOT NULL,                       -- recall must filter by this (no cross-model compare)
  embedding       vector(1536),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_knowledge_chunk_embedding_idx ON agent_knowledge_chunk USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS agent_knowledge_chunk_recall_idx ON agent_knowledge_chunk (owner_id, deleted_at, embedding_model);
CREATE INDEX IF NOT EXISTS agent_knowledge_chunk_doc_idx ON agent_knowledge_chunk (doc_id);
