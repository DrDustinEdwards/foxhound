-- contract: drops three tables nothing reads or writes. estimator_runs and benchmark_data belonged to the /audit revenue
-- estimator, removed with this migration (0 rows each); account_subscriptions had no writer and its two readers (the admin
-- merchant page and the account scrub) are removed too (0 rows). No money table is touched. The deploy refuses a contract
-- migration, so it is applied by hand after a D1 Time Travel bookmark and a zero-row recheck.
DROP TABLE `estimator_runs`;--> statement-breakpoint
DROP TABLE `account_subscriptions`;--> statement-breakpoint
DROP TABLE `benchmark_data`;