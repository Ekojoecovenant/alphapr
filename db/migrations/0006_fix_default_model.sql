-- SQLite can't ALTER a column default directly; recreate the constraint intent
-- by backfilling rows that still carry the old default.
UPDATE installations SET model = 'deepseek/deepseek-v4-flash' WHERE model = 'deepseek/deepseek-v4-pro';