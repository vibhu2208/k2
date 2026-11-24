'use strict';

const id = '021_weight_offset_audit';

function tableExists(db, name) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return !!row;
}

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weight_offset_audit (
      id                 TEXT PRIMARY KEY,
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
      created_at         TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_weight_offset_audit_created
      ON weight_offset_audit(created_at);
    CREATE INDEX IF NOT EXISTS idx_weight_offset_audit_truck
      ON weight_offset_audit(truck_number);
    CREATE INDEX IF NOT EXISTS idx_weight_offset_audit_txn
      ON weight_offset_audit(transaction_id);
  `);

  if (!tableExists(db, 'transactions')) return;

  const existing = db.prepare(`SELECT COUNT(*) AS c FROM weight_offset_audit`).get()?.c;
  if (existing > 0) return;

  const cols = db.prepare(`PRAGMA table_info(transactions)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('weight_offset_kg')) return;

  const { v4: uuidv4 } = require('uuid');
  const rows = db
    .prepare(
      `SELECT id, slip_number, truck_number, rfid_tag,
              weight_offset_kg, raw_gross_weight, gross_weight,
              operator_name, timestamp_out, timestamp_in, created_at
       FROM transactions
       WHERE weight_offset_kg IS NOT NULL
         AND CAST(weight_offset_kg AS REAL) > 0
       ORDER BY COALESCE(timestamp_out, timestamp_in, created_at) ASC`,
    )
    .all();

  const insert = db.prepare(
    `INSERT OR IGNORE INTO weight_offset_audit (
       id, transaction_id, slip_number, truck_number, rfid_tag,
       vehicle_type, pass, offset_kg, offset_tons,
       raw_weight_kg, adjusted_weight_kg, operator_name, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of rows) {
    const offsetKg = Math.round(Number(row.weight_offset_kg) || 0);
    if (offsetKg <= 0) continue;
    const createdAt =
      row.timestamp_out || row.timestamp_in || row.created_at || new Date().toISOString();
    insert.run(
      uuidv4(),
      row.id,
      row.slip_number || null,
      row.truck_number || 'UNKNOWN',
      row.rfid_tag || null,
      null,
      'GROSS',
      offsetKg,
      Math.round((offsetKg / 1000) * 1000) / 1000,
      row.raw_gross_weight != null ? Number(row.raw_gross_weight) : null,
      row.gross_weight != null ? Number(row.gross_weight) : null,
      row.operator_name || null,
      createdAt,
    );
  }
}

function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_weight_offset_audit_txn;
    DROP INDEX IF EXISTS idx_weight_offset_audit_truck;
    DROP INDEX IF EXISTS idx_weight_offset_audit_created;
    DROP TABLE IF EXISTS weight_offset_audit;
  `);
}

module.exports = { id, up, down };
