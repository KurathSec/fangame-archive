CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,               -- Clerk user id (sub)
  email        TEXT,
  display_name TEXT,
  avatar_url   TEXT,
  role         TEXT NOT NULL DEFAULT 'user',   -- user | mod
  status       TEXT NOT NULL DEFAULT 'active', -- active | muted | banned
  created_at   INTEGER NOT NULL,               -- epoch ms
  updated_at   INTEGER NOT NULL
);
