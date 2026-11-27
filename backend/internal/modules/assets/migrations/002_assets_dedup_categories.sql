-- 1. Merge duplicate top-level categories (parent_id IS NULL) per (user_id, name), keeping MIN(id).
WITH top_dups AS (
    SELECT
        id AS dup_id,
        MIN(id) OVER (PARTITION BY user_id, name) AS keep_id
    FROM assets_categories
    WHERE parent_id IS NULL
)
UPDATE assets_items i
SET category_id = d.keep_id
FROM top_dups d
WHERE i.category_id = d.dup_id AND d.dup_id <> d.keep_id;

WITH top_dups AS (
    SELECT
        id AS dup_id,
        MIN(id) OVER (PARTITION BY user_id, name) AS keep_id
    FROM assets_categories
    WHERE parent_id IS NULL
)
UPDATE assets_categories c
SET parent_id = d.keep_id
FROM top_dups d
WHERE c.parent_id = d.dup_id AND d.dup_id <> d.keep_id;

WITH top_dups AS (
    SELECT
        id AS dup_id,
        MIN(id) OVER (PARTITION BY user_id, name) AS keep_id
    FROM assets_categories
    WHERE parent_id IS NULL
)
DELETE FROM assets_categories c
USING top_dups d
WHERE c.id = d.dup_id AND d.dup_id <> d.keep_id;

-- 2. Merge duplicate level-2 categories (parent_id IS NOT NULL) per (user_id, parent_id, name), keeping MIN(id).
WITH sub_dups AS (
    SELECT
        id AS dup_id,
        MIN(id) OVER (PARTITION BY user_id, parent_id, name) AS keep_id
    FROM assets_categories
    WHERE parent_id IS NOT NULL
)
UPDATE assets_items i
SET category_id = d.keep_id
FROM sub_dups d
WHERE i.category_id = d.dup_id AND d.dup_id <> d.keep_id;

WITH sub_dups AS (
    SELECT
        id AS dup_id,
        MIN(id) OVER (PARTITION BY user_id, parent_id, name) AS keep_id
    FROM assets_categories
    WHERE parent_id IS NOT NULL
)
DELETE FROM assets_categories c
USING sub_dups d
WHERE c.id = d.dup_id AND d.dup_id <> d.keep_id;

-- 3. Enforce unique category names per level for each user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_categories_uniq_top
    ON assets_categories(user_id, name)
    WHERE parent_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_categories_uniq_sub
    ON assets_categories(user_id, parent_id, name)
    WHERE parent_id IS NOT NULL;
