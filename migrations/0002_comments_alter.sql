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

-- Add new columns to comments table
ALTER TABLE comments ADD COLUMN user_id     TEXT;
ALTER TABLE comments ADD COLUMN status      TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE comments ADD COLUMN source      TEXT NOT NULL DEFAULT 'native';
ALTER TABLE comments ADD COLUMN created_ts  INTEGER;
ALTER TABLE comments ADD COLUMN reviewed_by TEXT;

-- Backfill existing crawled data as approved and imported
UPDATE comments SET source = 'imported', status = 'approved' WHERE source = 'native';
