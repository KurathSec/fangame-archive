-- Browser play (/play/) is open to whitelisted accounts only: an administrator grants it
-- in the admin app (Users). 1 = may play.
ALTER TABLE users ADD COLUMN play_access INTEGER NOT NULL DEFAULT 0;
