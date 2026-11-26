-- contract: drops recommendation_log, a nightly copy of each customer's recommendation that nothing read and whose
-- outcome columns nothing wrote: Foxhound records no merchant outreach and has no holdout, so the lift it was for
-- cannot be measured from it. The live recommendation stays on customer_context.recommended_action. Production held 2
-- rows, one account (counted 2026-11-26). Also adds the predicted_at index that prediction grading and the predictions
-- retention sweep select by. No money table is touched. The deploy refuses a contract migration, so it is applied by
-- hand after a D1 Time Travel bookmark.
DROP TABLE `recommendation_log`;--> statement-breakpoint
CREATE INDEX `predictions_predicted_idx` ON `predictions` (`predicted_at`);
