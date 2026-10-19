-- The values the service keeps between its runs, one row each by its key (docs/api.md, "The store"). The
-- only one is the port the desktop relay dials, under `desktop_port`.
CREATE TABLE IF NOT EXISTS kept_values (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
