CREATE TABLE IF NOT EXISTS user_storage_configs (
    user_id          BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    endpoint         TEXT NOT NULL,
    region           TEXT NOT NULL DEFAULT 'auto',
    bucket           TEXT NOT NULL,
    access_key       TEXT NOT NULL,
    secret_key_enc   TEXT NOT NULL,
    public_base_url  TEXT NOT NULL,
    hash_length      INT  NOT NULL DEFAULT 16,
    force_path_style BOOLEAN NOT NULL DEFAULT FALSE,
    upload_mode      TEXT NOT NULL DEFAULT 'direct',
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
