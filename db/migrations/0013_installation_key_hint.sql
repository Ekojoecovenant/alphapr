-- A four-character hint from the key the owner stored, so the dashboard can say
-- *which* key is in place without ever decrypting or rendering it.
ALTER TABLE installations ADD COLUMN key_hint TEXT;
