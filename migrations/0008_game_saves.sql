-- Saves of games played in the browser (/play/, the gm-recomp player), kept in the
-- account of a signed-in player so they follow them between browsers. One row per
-- (user, game): the save files as the player exports them (JSON, base64 contents).
CREATE TABLE IF NOT EXISTS game_saves (
  user_id    TEXT NOT NULL,
  game_id    INTEGER NOT NULL,
  data       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_game_saves_user_updated ON game_saves(user_id, updated_at);
