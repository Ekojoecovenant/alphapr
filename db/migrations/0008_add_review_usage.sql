-- Record what each review cost in tokens, so a BYOK tenant can see their spend.
-- Nullable: providers may omit usage, and rows written before this column existed
-- have no way to know it.
ALTER TABLE pr_reviews ADD COLUMN input_tokens INTEGER;
ALTER TABLE pr_reviews ADD COLUMN output_tokens INTEGER;
