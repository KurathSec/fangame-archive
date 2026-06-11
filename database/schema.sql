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
