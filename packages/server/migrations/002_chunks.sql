-- Phase 4: retrieval.
--
-- pgvector, built from source against this PostgreSQL (D-011). The extension is
-- created here rather than assumed, so a fresh clone gets it from `npm run
-- migrate` instead of from a setup step someone has to remember.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chunks (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Cascade: a deleted document must not leave its chunks behind, or retrieval
    -- would cite a document that no longer exists.
    document_id uuid    NOT NULL REFERENCES documents (id) ON DELETE CASCADE,

    -- 1-based, as a reader counts pages. Carried on every chunk because this is
    -- what an answer cites (FR-6.5), and a chunk never spans a page boundary.
    page        integer NOT NULL CHECK (page > 0),
    -- Position within the page, so chunks have a stable order.
    idx         integer NOT NULL CHECK (idx >= 0),

    content     text    NOT NULL,

    -- 768 dimensions: nomic-embed-text. Fixed in the column type rather than
    -- validated in code, so a mismatched embedding model fails loudly at write
    -- time instead of silently poisoning the index.
    embedding   vector(768) NOT NULL,

    created_at  timestamptz NOT NULL DEFAULT now(),

    UNIQUE (document_id, page, idx)
);

CREATE INDEX chunks_document_id_idx ON chunks (document_id);

-- Cosine distance, matching how the embeddings are compared at query time. An
-- index built for a different operator is silently unused.
--
-- IVFFlat rather than HNSW: it builds in a fraction of the time and the
-- difference only matters at a scale this application will not reach. `lists`
-- is deliberately small for the same reason -- the guidance is rows/1000, and
-- with hundreds of chunks anything larger makes each probe search near-empty
-- partitions.
CREATE INDEX chunks_embedding_idx ON chunks
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
