-- Phase 1: files and documents.
--
-- chunks and its vector column arrive in Phase 4 with pgvector, and config in
-- Phase 7 when role bindings become editable. Creating them now would mean
-- shipping columns nothing reads, which is how a schema stops describing the
-- system it belongs to.

CREATE TABLE files (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    filename    text        NOT NULL,
    mime        text        NOT NULL,
    size_bytes  bigint      NOT NULL CHECK (size_bytes > 0),

    -- Unique, so re-uploading a document is free rather than duplicated. It is
    -- also the cache key for extracted text: keying on content means two
    -- different documents cannot collide, which a key derived from a prefix can.
    sha256      char(64)    NOT NULL UNIQUE,

    -- Bytes live on disk at data/files/<sha256>; this is the path to them.
    -- Storing PDFs in the database would bloat every backup and buy transactional
    -- consistency the application does not need.
    path        text        NOT NULL,

    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id     uuid        NOT NULL REFERENCES files (id) ON DELETE CASCADE,

    -- 'invoice' or 'generic' in Phase 1. Deliberately not an enum: adding a
    -- document type must be three files and a registry entry, and an enum would
    -- make it three files, a registry entry and a migration.
    type        text        NOT NULL,

    raw_text    text,

    -- What the model produced, never edited. Kept beside the editable copy so a
    -- correction can always be compared against the original.
    structured_data        jsonb,
    -- What the user corrected. Null until someone edits.
    edited_structured_data jsonb,

    confidence             real,
    classification_reason  text,

    status      text        NOT NULL
                CHECK (status IN ('pending','processing','completed','needs_review','failed')),
    error       text,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX documents_file_id_idx ON documents (file_id);
CREATE INDEX documents_status_idx  ON documents (status);
CREATE INDEX documents_type_idx    ON documents (type);
