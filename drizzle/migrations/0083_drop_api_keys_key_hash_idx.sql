-- contract: drops api_keys_key_hash_idx, which api_keys_key_hash_uq (0076) makes redundant. Hand-run.
DROP INDEX `api_keys_key_hash_idx`;
