'use strict';

const { v4: uuidv4 } = require('uuid');
const ExcelJS = require('exceljs');
const { getDb } = require('../database/db');
const ts = require('../utils/timestamp');
const logger = require('../utils/logger');

const EXPORT_HEADERS = [
  'When',
  'Truck',
  'Slip',
  'RFID',
  'Vehicle type',
  'Pass',
  'Offset (kg)',
  'Offset (t)',
  'Raw weight (kg)',
  'Adjusted weight (kg)',
  'Gross (kg)',
  'Tare (kg)',
  'Net (kg)',
  'Material',
  'Customer',
  'Destination',
  'Company',
  'Operator',
  'Ticket status',
  'Transaction id',
];

function toTons(offsetKg) {
  const kg = Math.round(Number(offsetKg) || 0);
  if (kg <= 0) return 0;
  return Math.round((kg / 1000) * 1000) / 1000;
}

function netKg(gross, tare) {
  const g = Number(gross);
  const t = Number(tare);
  if (!Number.isFinite(g) || !Number.isFinite(t)) return null;
  return Math.round(g - t);
}

/**
 * Record one weight-offset application. No-ops when offset is zero.
 * Does NOT write Excel files to disk — admin fetches rows on demand.
 */
function record({
  transactionId = null,
  slipNumber = null,
  truckNumber,
  rfidTag = null,
  vehicleType = null,
  pass = 'GROSS',
  offsetKg,
  rawWeightKg = null,
  adjustedWeightKg = null,
  operatorName = null,
  createdAt = null,
}) {
  const kg = Math.round(Number(offsetKg) || 0);
  if (kg <= 0) return null;

  const truck = String(truckNumber || '').trim().toUpperCase();
  if (!truck) return null;

  const entry = {
    id: uuidv4(),
    transaction_id: transactionId || null,
    slip_number: slipNumber || null,
    truck_number: truck,
    rfid_tag: rfidTag ? String(rfidTag).trim().toUpperCase() : null,
    vehicle_type: vehicleType || null,
    pass: pass || 'GROSS',
    offset_kg: kg,
    offset_tons: toTons(kg),
    raw_weight_kg:
      rawWeightKg != null && Number.isFinite(Number(rawWeightKg))
        ? Math.round(Number(rawWeightKg))
        : null,
    adjusted_weight_kg:
      adjustedWeightKg != null && Number.isFinite(Number(adjustedWeightKg))
        ? Math.round(Number(adjustedWeightKg))
        : null,
    operator_name: operatorName || null,
    created_at: createdAt || ts.now(),
  };

  try {
    getDb()
      .prepare(
        `INSERT INTO weight_offset_audit (
           id, transaction_id, slip_number, truck_number, rfid_tag,
           vehicle_type, pass, offset_kg, offset_tons,
           raw_weight_kg, adjusted_weight_kg, operator_name, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.transaction_id,
        entry.slip_number,
        entry.truck_number,
        entry.rfid_tag,
        entry.vehicle_type,
        entry.pass,
        entry.offset_kg,
        entry.offset_tons,
        entry.raw_weight_kg,
        entry.adjusted_weight_kg,
        entry.operator_name,
        entry.created_at,
      );
    logger.info('Weight offset audit recorded', {
      truck: entry.truck_number,
      offsetKg: entry.offset_kg,
      slip: entry.slip_number,
    });
    return entry;
  } catch (err) {
    logger.warn('WeightOffsetAuditService.record failed', { message: err.message });
    return null;
  }
}

function mapDetailedRow(row) {
  return {
    id: row.id,
    transaction_id: row.transaction_id,
    slip_number: row.slip_number,
    truck_number: row.truck_number,
    rfid_tag: row.rfid_tag,
    vehicle_type: row.vehicle_type,
    pass: row.pass,
    offset_kg: row.offset_kg,
    offset_tons: row.offset_tons,
    raw_weight_kg: row.raw_weight_kg,
    adjusted_weight_kg: row.adjusted_weight_kg,
    operator_name: row.operator_name || row.txn_operator_name || null,
    created_at: row.created_at,
    gross_weight: row.gross_weight != null ? Number(row.gross_weight) : null,
    tare_weight: row.tare_weight != null ? Number(row.tare_weight) : null,
    net_weight: netKg(row.gross_weight, row.tare_weight),
    material: row.material || null,
    customer_name: row.customer_name || null,
    destination: row.destination || null,
    company: row.company || null,
    ticket_status: row.ticket_status || null,
  };
}

function listDetailed({ limit = null, offset = 0, from = null, to = null } = {}) {
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const hasLimit = limit != null;
  const lim = hasLimit ? Math.min(5000, Math.max(1, parseInt(limit, 10) || 100)) : null;

  const where = [];
  const params = [];
  if (from) {
    where.push('a.created_at >= ?');
    params.push(String(from));
  }
  if (to) {
    where.push('a.created_at <= ?');
    params.push(String(to));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sql = `
    SELECT a.id, a.transaction_id, a.slip_number, a.truck_number, a.rfid_tag,
           a.vehicle_type, a.pass, a.offset_kg, a.offset_tons,
           a.raw_weight_kg, a.adjusted_weight_kg, a.operator_name, a.created_at,
           t.gross_weight, t.tare_weight, t.material, t.customer_name,
           t.destination, t.company, t.ticket_status,
           t.operator_name AS txn_operator_name
    FROM weight_offset_audit a
    LEFT JOIN transactions t ON t.id = a.transaction_id
    ${whereSql}
    ORDER BY a.created_at DESC
    ${hasLimit ? 'LIMIT ? OFFSET ?' : ''}
  `;

  const queryParams = hasLimit ? [...params, lim, off] : params;
  return getDb()
    .prepare(sql)
    .all(...queryParams)
    .map(mapDetailedRow);
}

function getTotalsForRange({ from = null, to = null } = {}) {
  const where = [];
  const params = [];
  if (from) {
    where.push('created_at >= ?');
    params.push(String(from));
  }
  if (to) {
    where.push('created_at <= ?');
    params.push(String(to));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totals = getDb()
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(offset_kg), 0) AS total_offset_kg,
              COALESCE(SUM(offset_tons), 0) AS total_offset_tons
       FROM weight_offset_audit
       ${whereSql}`,
    )
    .get(...params);
  return {
    totalCount: totals?.count || 0,
    totalOffsetKg: Math.round(Number(totals?.total_offset_kg) || 0),
    totalOffsetTons: Math.round((Number(totals?.total_offset_tons) || 0) * 1000) / 1000,
  };
}

function list({ limit = 100, offset = 0, from = null, to = null } = {}) {
  try {
    const rows = listDetailed({ limit, offset, from, to });
    return { rows, ...getTotalsForRange({ from, to }) };
  } catch (err) {
    logger.warn('WeightOffsetAuditService.list failed', { message: err.message });
    return { rows: [], totalCount: 0, totalOffsetKg: 0, totalOffsetTons: 0 };
  }
}

function formatExportTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  } catch {
    return String(iso);
  }
}

function rowToExcelValues(row) {
  return [
    formatExportTime(row.created_at),
    row.truck_number || '',
    row.slip_number || '',
    row.rfid_tag || '',
    row.vehicle_type || '',
    row.pass || '',
    row.offset_kg ?? '',
    row.offset_tons ?? '',
    row.raw_weight_kg ?? '',
    row.adjusted_weight_kg ?? '',
    row.gross_weight ?? '',
    row.tare_weight ?? '',
    row.net_weight ?? '',
    row.material || '',
    row.customer_name || '',
    row.destination || '',
    row.company || '',
    row.operator_name || '',
    row.ticket_status || '',
    row.transaction_id || '',
  ];
}

/**
 * Build offset audit Excel in memory for daily mail ZIP.
 * Does not write a lasting file under uploads.
 */
async function exportExcel({
  from = null,
  to = null,
  allowEmpty = false,
  filenameBase = null,
} = {}) {
  let rows;
  try {
    rows = listDetailed({ limit: null, from, to });
  } catch (err) {
    logger.warn('WeightOffsetAuditService.exportExcel list failed', {
      message: err.message,
    });
    return { ok: false, error: err.message || 'Could not load audit trail' };
  }

  if (!rows.length && !allowEmpty) {
    return { ok: false, error: 'No offset audit records to export' };
  }

  const totals = getTotalsForRange({ from, to });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Weighbridge Manager';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Offset Audit');
  sheet.addRow(EXPORT_HEADERS);
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E40AF' },
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 22;

  for (const row of rows) {
    sheet.addRow(rowToExcelValues(row));
  }
  if (!rows.length) {
    sheet.addRow(['No offset usage in this period']);
  }

  sheet.addRow([]);
  sheet.addRow([
    'TOTAL',
    '',
    '',
    '',
    '',
    '',
    totals.totalOffsetKg,
    totals.totalOffsetTons,
  ]);
  sheet.lastRow.font = { bold: true };

  sheet.columns.forEach((column) => {
    let maxLength = 12;
    column.eachCell({ includeEmpty: true }, (cell) => {
      const len = cell.value ? String(cell.value).length : 0;
      if (len > maxLength) maxLength = len;
    });
    column.width = Math.min(maxLength + 2, 40);
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = filenameBase || `weight_offset_audit_${stamp}`;
  const safeBase = String(base).replace(/[^\w.\-]+/g, '_');
  const filename = `${safeBase}.xlsx`;
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  logger.info('Weight offset audit Excel built for mail', {
    filename,
    count: rows.length,
    from,
    to,
  });

  return {
    ok: true,
    buffer,
    filename,
    count: rows.length,
    totalOffsetKg: totals.totalOffsetKg,
    totalOffsetTons: totals.totalOffsetTons,
  };
}

/** Remove any leftover weight_offset_audit_*.xlsx under uploads (no longer stored). */
function cleanupLegacyExcelFiles() {
  try {
    const fs = require('fs');
    const path = require('path');
    const { PATHS } = require('../utils/fileStorage');
    const root = PATHS.UPLOADS;
    if (!root || !fs.existsSync(root)) return { removed: 0 };

    let removed = 0;
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
          continue;
        }
        if (/^weight_offset_audit_.*\.xlsx$/i.test(ent.name)) {
          try {
            fs.unlinkSync(full);
            removed += 1;
          } catch (_e) {
            /* ignore */
          }
        }
      }
    };
    walk(root);
    if (removed) {
      logger.info('Removed legacy weight offset Excel files', { removed });
    }
    return { removed };
  } catch (err) {
    logger.warn('Offset Excel cleanup failed', { message: err.message });
    return { removed: 0 };
  }
}

module.exports = {
  record,
  list,
  listDetailed,
  getTotalsForRange,
  exportExcel,
  toTons,
  cleanupLegacyExcelFiles,
};
