CREATE INDEX IF NOT EXISTS idx_comments_game_status ON comments(game_id, status);
CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id);
CREATE INDEX IF NOT EXISTS idx_sub_status ON game_submissions(status);
CREATE INDEX IF NOT EXISTS idx_sub_submitter ON game_submissions(submitter_id);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id);
