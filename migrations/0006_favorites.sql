CREATE TABLE IF NOT EXISTS user_favorites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  game_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Ensure a user can only favorite a game once and speed up user-based queries
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_favorites_uniq ON user_favorites(user_id, game_id);
CREATE INDEX IF NOT EXISTS idx_user_favorites_user ON user_favorites(user_id);
