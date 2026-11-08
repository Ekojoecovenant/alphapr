-- Health of an installation, so a dead key becomes visible in the dashboard
-- instead of only in `wrangler tail` (ADR 0002, phase P0 shows it).
--
-- `last_error_message` is the sanitised provider text, the same string the
-- failure comment quotes — never a stack trace or anything carrying a secret.
ALTER TABLE installations ADD COLUMN last_error_code TEXT;
ALTER TABLE installations ADD COLUMN last_error_message TEXT;
ALTER TABLE installations ADD COLUMN last_error_at TEXT;
ALTER TABLE installations ADD COLUMN last_review_at TEXT;
