'use strict';

const { query, getSiteId } = require('../db');
const { createCommand } = require('./commandService');

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
  await query(`
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
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_weight_offset_audit_mirror_site_created
      ON weight_offset_audit_mirror (site_id, created_at DESC)
  `);
  schemaReady = true;
}

async function requestFetch({ from = null, to = null, createdBy = null } = {}) {
  return createCommand({
    type: 'fetch_offset_audit',
    payload: {
      ...(from ? { from: String(from) } : {}),
      ...(to ? { to: String(to) } : {}),
    },
    createdBy: createdBy || null,
  });
}

async function getMeta() {
  const siteId = getSiteId();
  const res = await query(
    `SELECT key, value FROM site_settings
     WHERE site_id = $1
       AND key IN ('WEIGHT_OFFSET_AUDIT_LAST_FETCH_AT', 'WEIGHT_OFFSET_AUDIT_LAST_FETCH_COUNT')`,
    [siteId],
  );
  const map = {};
  for (const row of res.rows || []) {
    map[row.key] = row.value;
  }
  const pending = await query(
    `SELECT id, status, created_at, applied_at, error
     FROM admin_commands
     WHERE site_id = $1 AND type = 'fetch_offset_audit'
     ORDER BY created_at DESC
     LIMIT 1`,
    [siteId],
  );
  return {
    lastFetchAt: map.WEIGHT_OFFSET_AUDIT_LAST_FETCH_AT || null,
    lastFetchCount: map.WEIGHT_OFFSET_AUDIT_LAST_FETCH_COUNT
      ? Number(map.WEIGHT_OFFSET_AUDIT_LAST_FETCH_COUNT)
      : null,
    lastCommand: pending.rows[0] || null,
  };
}

async function list({ from = null, to = null, limit = 500, offset = 0 } = {}) {
  await ensureSchema();
  const siteId = getSiteId();
  const lim = Math.min(2000, Math.max(1, parseInt(limit, 10) || 500));
  const off = Math.max(0, parseInt(offset, 10) || 0);

  const where = ['site_id = $1'];
  const params = [siteId];
  if (from) {
    params.push(String(from));
    where.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (to) {
    params.push(String(to));
    where.push(`created_at <= $${params.length}::timestamptz`);
  }
  const whereSql = where.join(' AND ');

  const totals = await query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(offset_kg), 0)::float AS total_offset_kg,
            COALESCE(SUM(offset_tons), 0)::float AS total_offset_tons
     FROM weight_offset_audit_mirror
     WHERE ${whereSql}`,
    params,
  );

  params.push(lim, off);
  const rows = await query(
    `SELECT id, transaction_id, slip_number, truck_number, rfid_tag, vehicle_type,
            pass, offset_kg, offset_tons, raw_weight_kg, adjusted_weight_kg,
            operator_name, created_at, gross_weight, tare_weight, net_weight,
            material, customer_name, destination, company, ticket_status, synced_at
     FROM weight_offset_audit_mirror
     WHERE ${whereSql}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const meta = await getMeta();
  return {
    rows: rows.rows || [],
    totalCount: totals.rows[0]?.count || 0,
    totalOffsetKg: Math.round(Number(totals.rows[0]?.total_offset_kg) || 0),
    totalOffsetTons: Math.round((Number(totals.rows[0]?.total_offset_tons) || 0) * 1000) / 1000,
    ...meta,
  };
}

module.exports = {
  ensureSchema,
  requestFetch,
  list,
  getMeta,
};
