-- name: UpsertUserByOIDCSub :one
INSERT INTO users (oidc_sub, username, email, avatar_url)
VALUES ($1, $2, $3, $4)
ON CONFLICT (oidc_sub) DO UPDATE
SET username = EXCLUDED.username,
    email = EXCLUDED.email,
    avatar_url = EXCLUDED.avatar_url,
    updated_at = NOW()
RETURNING id, oidc_sub, username, email, avatar_url;

-- name: FindUserByID :one
SELECT id, oidc_sub, username, email, avatar_url
FROM users
WHERE id = $1;
