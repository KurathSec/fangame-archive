CREATE TABLE IF NOT EXISTS game_submissions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  submitter_id     TEXT NOT NULL,
  title            TEXT NOT NULL,
  author_name      TEXT NOT NULL,
  external_url     TEXT NOT NULL,
  tags             TEXT,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reject_reason    TEXT,
  assigned_game_id INTEGER,
  created_at       INTEGER NOT NULL,
  reviewed_at      INTEGER,
  reviewed_by      TEXT,
  merged_at        INTEGER
);
