-- Dunning timing (Dustin, 2026-10-25, decision card "Yes, all three"). Data only.
-- Sequences already scheduled get the new timing on their UNSENT steps only:
-- no executed, failed, backing-off or deleted step is touched, and every part
-- is idempotent, so a second run changes nothing.
--
-- 1. transaction_not_allowed is now a hard decline (fraud bucket, never
--    silently retried). Payments filed as soft before this change keep their
--    stored category, and both the tick and handleStripeGaveUp's sequence start
--    read that stored category, so without this they would still be retried.
--    First, an active one's unsent retries are cancelled (the same terminal
--    result a manual stop writes); its remaining steps are emails whose types
--    the fraud row shares.
UPDATE `recovery_steps`
SET `result` = 'cancelled'
WHERE substr(`step_type`, 1, 6) = 'retry_'
  AND `executed_at` IS NULL AND `result` IS NULL AND `deleted_at` IS NULL
  AND `failed_payment_id` IN (
    SELECT `id` FROM `failed_payments`
    WHERE `decline_code` = 'transaction_not_allowed' AND `decline_category` = 'soft'
      AND `status` IN ('active', 'stripe_retrying')
  );
--> statement-breakpoint
-- Then the payment itself is refiled as fraud, so its remaining emails use the
-- fraud copy and a stripe_retrying one, which has no steps yet, starts the
-- fraud sequence when Stripe gives up. Finished payments keep their history.
-- This runs first, so step 2 below does not move a refiled payment's day 1
-- email to the soft timing.
UPDATE `failed_payments`
SET `decline_category` = 'fraud'
WHERE `decline_code` = 'transaction_not_allowed' AND `decline_category` = 'soft'
  AND `status` IN ('active', 'stripe_retrying');
--> statement-breakpoint
-- 2. Soft declines: an unsent day 1 email moves to 1 hour after the payment's
--    4 hour silent retry (5 hours from the schedule anchor), from 24 hours.
UPDATE `recovery_steps`
SET `scheduled_at` = (
  SELECT r.`scheduled_at` + 3600000 FROM `recovery_steps` r
  WHERE r.`failed_payment_id` = `recovery_steps`.`failed_payment_id`
    AND r.`step_type` = 'retry_early' AND r.`deleted_at` IS NULL
  ORDER BY r.`scheduled_at` LIMIT 1
)
WHERE `step_type` = 'email_day1'
  AND `executed_at` IS NULL AND `result` IS NULL AND `deleted_at` IS NULL
  AND `next_retry_at` IS NULL AND `attempt_count` = 0
  AND `failed_payment_id` IN (
    SELECT `id` FROM `failed_payments` WHERE `decline_category` = 'soft' AND `status` = 'active'
  )
  AND EXISTS (
    SELECT 1 FROM `recovery_steps` r
    WHERE r.`failed_payment_id` = `recovery_steps`.`failed_payment_id`
      AND r.`step_type` = 'retry_early' AND r.`deleted_at` IS NULL
  );
--> statement-breakpoint
-- 3. Expired cards: a live sequence whose day 30 email has not gone out gets
--    Recova's day 21 retry (guarded in code on a changed card), 216 hours before
--    its day 30 email, which is renumbered one place later to make room.
UPDATE `recovery_steps`
SET `step_number` = `step_number` + 1
WHERE `step_type` = 'email_day30'
  AND `executed_at` IS NULL AND `result` IS NULL AND `deleted_at` IS NULL
  AND `failed_payment_id` IN (
    SELECT `id` FROM `failed_payments` WHERE `decline_category` = 'expired' AND `status` = 'active'
  )
  AND NOT EXISTS (
    SELECT 1 FROM `recovery_steps` r
    WHERE r.`failed_payment_id` = `recovery_steps`.`failed_payment_id` AND r.`step_type` = 'retry_day21'
  );
--> statement-breakpoint
INSERT INTO `recovery_steps` (`id`, `failed_payment_id`, `account_id`, `step_type`, `step_number`, `scheduled_at`)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-'
    || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  d.`failed_payment_id`,
  d.`account_id`,
  'retry_day21',
  d.`step_number` - 1,
  d.`scheduled_at` - 777600000
FROM `recovery_steps` d
INNER JOIN `failed_payments` fp ON fp.`id` = d.`failed_payment_id`
WHERE d.`step_type` = 'email_day30'
  AND d.`executed_at` IS NULL AND d.`result` IS NULL AND d.`deleted_at` IS NULL
  AND fp.`decline_category` = 'expired' AND fp.`status` = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM `recovery_steps` r
    WHERE r.`failed_payment_id` = d.`failed_payment_id` AND r.`step_type` = 'retry_day21'
  );
