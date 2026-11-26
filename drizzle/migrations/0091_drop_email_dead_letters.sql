-- contract: drops email_dead_letters, the trace table for the foxhound-email dead-letter queue. That queue had no producer
-- since August 2026 (every email is sent directly by the job that sends it), so nothing could reach it; the queue, its
-- consumer and the dead-letter recorder are removed with this migration. Production held 0 rows (counted 2026-11-26).
-- No money table is touched. The deploy refuses a contract migration, so it is applied by hand after a D1 Time Travel
-- bookmark.
DROP TABLE `email_dead_letters`;