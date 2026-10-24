-- Foxhound has no passwords now (the family sign-in, site-runtime ./sign-in): drop the
-- stored password hashes. Sign-in is by passkey, the email link, Google or Apple.
DELETE FROM `account` WHERE `provider_id` = 'credential';
