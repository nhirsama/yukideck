-- Ephemeral image dimension cache backed by PostgreSQL UNLOGGED TABLE (no WAL overhead).
-- Object storage (S3/R2) remains the single source of truth; cache rows rebuild automatically on demand.
CREATE UNLOGGED TABLE IF NOT EXISTS storage_object_dims (
    user_id    BIGINT NOT NULL,
    object_key TEXT NOT NULL,
    byte_size  BIGINT NOT NULL DEFAULT 0,
    width      INT NOT NULL,
    height     INT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, object_key)
);
