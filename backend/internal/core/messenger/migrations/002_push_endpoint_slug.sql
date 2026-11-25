ALTER TABLE push_endpoints
    ADD COLUMN IF NOT EXISTS slug TEXT;

UPDATE push_endpoints
SET slug = 'ep-' || id::text
WHERE slug IS NULL OR slug = '';

ALTER TABLE push_endpoints
    ALTER COLUMN slug SET NOT NULL;

ALTER TABLE push_endpoints
    DROP COLUMN IF EXISTS token_hash,
    DROP COLUMN IF EXISTS token_enc;

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoints_user_slug
    ON push_endpoints(user_id, slug);
