-- Admin-queued catalog operations on existing games, drained by the 6-hourly
-- pipeline (pipelines/apply_game_ops.py). The admin panel inserts rows here;
-- the CI applies them to games.json + R2 and marks them applied/failed.
CREATE TABLE IF NOT EXISTS game_ops (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  op            TEXT NOT NULL,                       -- 'delete' | 'clear_link' | 'replace_link' | 'upload_replace'
  game_id       INTEGER NOT NULL,                    -- sequential catalog id
  new_url       TEXT,                                -- replace_link: replacement URL; upload_replace: R2 staging key
  status        TEXT NOT NULL DEFAULT 'pending',     -- 'pending' | 'applied' | 'failed'
  requested_by  TEXT,                                -- moderator Access JWT email
  reason        TEXT,                                -- audit reason
  result        TEXT,                                -- pipeline note after processing
  created_at    INTEGER NOT NULL,                    -- epoch ms
  applied_at    INTEGER                              -- epoch ms when processed
);

CREATE INDEX IF NOT EXISTS idx_game_ops_status ON game_ops(status);
