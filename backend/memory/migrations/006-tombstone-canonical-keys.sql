-- Deleted assertion tombstones must not retain the canonical key: it is an
-- unkeyed hash of the normalized proposition, so it can confirm a guessed
-- deleted sentence. Reuse of a deleted command stays blocked by its retained
-- event suppression; a new explicit statement from the user is new evidence.
UPDATE gideon_memory.assertions
SET canonical_key = NULL, updated_at = now()
WHERE current_status = 'deleted' AND canonical_key IS NOT NULL;
