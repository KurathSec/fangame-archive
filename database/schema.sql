-- Database schema for game comments and reviews.
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    user TEXT NOT NULL,
    rating REAL,
    difficulty INTEGER,
    likes INTEGER DEFAULT 0,
    date TEXT,
    content TEXT NOT NULL,
    tags TEXT
);

CREATE INDEX IF NOT EXISTS idx_comments_game_id ON comments(game_id);

-- Per-user favorited games (Collections feature).
CREATE TABLE IF NOT EXISTS user_favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    game_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_user_favorites_user_id ON user_favorites(user_id);

-- User-created collections (Collections v2). `user_favorites` above remains the
-- untouched "main" loose-favorites bucket; these are named lists/folders on top.
-- A node is a FOLDER (has sub-collections, no games) or a LIST (has games, no
-- children), determined dynamically; nesting depth is capped at 1 (folder->list).
CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    parent_id INTEGER,                          -- NULL = top-level; else the folder (1 level only)
    name TEXT,                                   -- optional; unlisted => preset or NULL
    description TEXT,                            -- optional; unlisted => must be NULL
    visibility TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'unlisted' | 'public'
    share_token TEXT UNIQUE,                     -- random; set when unlisted/public
    share_show_owner INTEGER NOT NULL DEFAULT 0, -- 0 = anonymous share page, 1 = show owner nickname
    moderation_status TEXT,                      -- only when public: 'pending' | 'approved' | 'rejected'
    reviewed_by TEXT,
    reviewed_at INTEGER,
    reject_reason TEXT,
    sort_order INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collections_user_id ON collections(user_id);
CREATE INDEX IF NOT EXISTS idx_collections_parent_id ON collections(parent_id);
CREATE INDEX IF NOT EXISTS idx_collections_public ON collections(visibility, moderation_status);

-- Membership: a game belongs to many list-type collections (many-to-many).
CREATE TABLE IF NOT EXISTS collection_items (
    collection_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    sort_order INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (collection_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_collection_items_game_id ON collection_items(game_id);
