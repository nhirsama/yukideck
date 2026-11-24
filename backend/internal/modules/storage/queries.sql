-- name: GetStorageConfig :one
SELECT user_id, endpoint, region, bucket, access_key, secret_key_enc,
       public_base_url, hash_length, force_path_style, upload_mode, updated_at
FROM user_storage_configs
WHERE user_id = $1;

-- name: UpsertStorageConfig :one
INSERT INTO user_storage_configs (
    user_id, endpoint, region, bucket, access_key, secret_key_enc,
    public_base_url, hash_length, force_path_style, upload_mode
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (user_id) DO UPDATE SET
    endpoint = EXCLUDED.endpoint,
    region = EXCLUDED.region,
    bucket = EXCLUDED.bucket,
    access_key = EXCLUDED.access_key,
    secret_key_enc = EXCLUDED.secret_key_enc,
    public_base_url = EXCLUDED.public_base_url,
    hash_length = EXCLUDED.hash_length,
    force_path_style = EXCLUDED.force_path_style,
    upload_mode = EXCLUDED.upload_mode,
    updated_at = NOW()
RETURNING user_id, endpoint, region, bucket, access_key, secret_key_enc,
          public_base_url, hash_length, force_path_style, upload_mode, updated_at;
