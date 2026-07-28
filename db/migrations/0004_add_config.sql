ALTER TABLE installations
ADD COLUMN severity_threshold TEXT NOT NULL DEFAULT 'all';

ALTER TABLE installations
ADD COLUMN review_tone TEXT NOT NULL DEFAULT 'thorough';

ALTER TABLE installations
ADD COLUMN ignore_paths TEXT NOT NULL DEFAULT '';

---