-- Custom SQL migration file, put your code below! --
-- FH-5: Foxhound keeps no Google tokens (app/lib/auth/options.ts databaseHooks). Data only.
UPDATE `account` SET `access_token` = NULL, `refresh_token` = NULL, `id_token` = NULL, `access_token_expires_at` = NULL, `refresh_token_expires_at` = NULL;
