-- Performance indexes for admin search / list filters
-- Safe to re-run (IF NOT EXISTS). pg_trgm optional: skip if extension unavailable.

CREATE INDEX IF NOT EXISTS idx_mirror_site_slip
  ON transactions_mirror (site_id, slip_number);

CREATE INDEX IF NOT EXISTS idx_mirror_site_status_out
  ON transactions_mirror (site_id, ticket_status, timestamp_out DESC);

CREATE INDEX IF NOT EXISTS idx_mirror_site_truck
  ON transactions_mirror (site_id, upper(truck_number));

CREATE INDEX IF NOT EXISTS idx_remote_trips_created
  ON remote_trips (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_remote_trips_slip_upper
  ON remote_trips (upper(slip_number));

CREATE INDEX IF NOT EXISTS idx_remote_trips_synced
  ON remote_trips (synced_to_local, created_at DESC);

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'pg_trgm not available — skipping trigram indexes';
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm skipped: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS idx_mirror_slip_trgm
      ON transactions_mirror USING gin (slip_number gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_mirror_truck_trgm
      ON transactions_mirror USING gin (truck_number gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_mirror_operator_trgm
      ON transactions_mirror USING gin (operator_name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_remote_slip_trgm
      ON remote_trips USING gin (slip_number gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_remote_truck_trgm
      ON remote_trips USING gin (truck_number gin_trgm_ops);
  END IF;
END $$;
