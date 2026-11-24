-- Weight offset audit mirror — admin Offset Data tab (fetched from PC on demand).
-- No Excel files are stored on the weighbridge PC.

CREATE TABLE IF NOT EXISTS weight_offset_audit_mirror (
  id                 TEXT PRIMARY KEY,
  site_id            TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  transaction_id     TEXT,
  slip_number        TEXT,
  truck_number       TEXT NOT NULL,
  rfid_tag           TEXT,
  vehicle_type       TEXT,
  pass               TEXT,
  offset_kg          REAL NOT NULL,
  offset_tons        REAL NOT NULL,
  raw_weight_kg      REAL,
  adjusted_weight_kg REAL,
  operator_name      TEXT,
  created_at         TIMESTAMPTZ NOT NULL,
  gross_weight       REAL,
  tare_weight        REAL,
  net_weight         REAL,
  material           TEXT,
  customer_name      TEXT,
  destination        TEXT,
  company            TEXT,
  ticket_status      TEXT,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_weight_offset_audit_mirror_site_created
  ON weight_offset_audit_mirror (site_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_weight_offset_audit_mirror_site_truck
  ON weight_offset_audit_mirror (site_id, truck_number);
