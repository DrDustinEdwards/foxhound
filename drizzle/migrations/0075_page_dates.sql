-- page_dates: the day each code-written page of the sitemap last changed (the hash of its Markdown text and the day that hash
-- first appeared), kept by the daily page-dates job and read by /sitemap.xml for its lastmod. Hand-written.
--
-- ADDITIVE: one new table, EMPTY. No existing table, column or row is touched.
CREATE TABLE IF NOT EXISTS page_dates (
  path TEXT PRIMARY KEY NOT NULL,
  hash TEXT NOT NULL,
  lastmod TEXT NOT NULL
);
