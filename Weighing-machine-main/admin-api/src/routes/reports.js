'use strict';

const express = require('express');
const ExcelJS = require('exceljs');
const { query, getSiteId } = require('../db');
const { authMiddleware, requireRole } = require('../auth');
const { sendError } = require('../security/httpErrors');
const {
  queryPaginated,
  summarise,
  getFilterOptions,
  buildWhere,
  formatExportRow,
  EXPORT_HEADERS,
  REPORT_DATE_SQL,
  PHOTO_SCORE_SQL,
} = require('../services/reportQuery');
const { createCommand } = require('../services/commandService');
const { siteIdAliases } = require('../siteId');
const { generateTripPdf } = require('../services/reportPdfService');
const {
  attachMediaUrls,
  hydratePhotoKeys,
} = require('../services/reportMedia');
const { getAdvanceSettings } = require('../services/settingsService');
const { assertPhotoKeyForSlip } = require('../security/s3Keys');
const rateLimit = require('express-rate-limit');

const pdfLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.PDF_RATE_LIMIT_PER_MIN) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many PDF requests — slow down' },
});

async function reportCompanyName() {
  try {
    const settings = await getAdvanceSettings();
    return (
      String(settings.REPORT_COMPANY_NAME || '').trim() || 'MKG GREEN ENERGY'
    );
  } catch {
    return 'MKG GREEN ENERGY';
  }
}

function styleWeighbridgeHeader(ws) {
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E40AF' },
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 22;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  // Fixed widths — scanning every cell on large exports is O(rows×cols).
  const widths = [14, 16, 18, 18, 14, 14, 14, 12, 12, 12, 20, 20, 14, 14, 18];
  ws.columns.forEach((column, i) => {
    column.width = widths[i] || 16;
  });
}

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const siteId = getSiteId();
    const filters = req.query || {};
    // List UI does not need presigned URLs; skip S3 Head/List/Presign per row.
    // Pass media=1 when thumbnails are required. Vehicle reassert runs on its worker.
    const wantMedia =
      filters.media === '1' || filters.media === 'true' || filters.media === true;
    const [result, summary] = await Promise.all([
      queryPaginated(query, siteId, filters),
      summarise(query, siteId, filters),
    ]);
    const rows = wantMedia
      ? await Promise.all(result.rows.map(attachMediaUrls))
      : result.rows;
    return res.json({ ok: true, rows, pagination: result.pagination, summary });
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/filters', async (_req, res) => {
  try {
    const options = await getFilterOptions(query, getSiteId());
    return res.json({ ok: true, ...options });
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/export/csv', async (req, res) => {
  try {
    const siteId = getSiteId();
    const company = await reportCompanyName();
    const { where, params } = buildWhere(siteId, req.query || {});
    const result = await query(
      `SELECT * FROM (
         SELECT DISTINCT ON (slip_number) *
         FROM transactions_mirror ${where}
         ORDER BY slip_number, ${PHOTO_SCORE_SQL} DESC, ${REPORT_DATE_SQL} DESC
       ) d
       ORDER BY ${REPORT_DATE_SQL} DESC LIMIT 5000`,
      params,
    );
    const lines = [EXPORT_HEADERS.map((h) => `"${h}"`).join(',')];
    for (const row of result.rows) {
      lines.push(
        formatExportRow(row, company)
          .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="weighbridge-report.csv"');
    return res.send(lines.join('\n'));
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/export/excel', async (req, res) => {
  try {
    const siteId = getSiteId();
    const company = await reportCompanyName();
    const { where, params } = buildWhere(siteId, req.query || {});
    const result = await query(
      `SELECT * FROM (
         SELECT DISTINCT ON (slip_number) *
         FROM transactions_mirror ${where}
         ORDER BY slip_number, ${PHOTO_SCORE_SQL} DESC, ${REPORT_DATE_SQL} DESC
       ) d
       ORDER BY ${REPORT_DATE_SQL} DESC LIMIT 5000`,
      params,
    );
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Reports');
    ws.addRow(EXPORT_HEADERS);
    for (const row of result.rows) {
      ws.addRow(formatExportRow(row, company));
    }
    styleWeighbridgeHeader(ws);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', 'attachment; filename="weighbridge-report.xlsx"');
    await wb.xlsx.write(res);
    return res.end();
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/:slip', async (req, res) => {
  try {
    const aliases = siteIdAliases(getSiteId());
    const slip = String(req.params.slip || '').trim();
    const result = await query(
      `SELECT * FROM transactions_mirror
       WHERE site_id = ANY($1::text[]) AND slip_number = $2
       ORDER BY ${PHOTO_SCORE_SQL} DESC
       LIMIT 1`,
      [aliases, slip],
    );
    if (!result.rows[0]) {
      return res.status(404).json({ ok: false, error: 'Report not found' });
    }
    const row = await attachMediaUrls(result.rows[0]);
    return res.json({ ok: true, report: row });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Build (or rebuild) the trip PDF from current mirror photo S3 keys so admin
 * downloads always include images — even when the PC uploaded an empty PDF.
 * Uses the same row + photo hydration as the edit view so images match.
 */
router.get('/:slip/pdf', pdfLimiter, async (req, res) => {
  try {
    const siteId = getSiteId();
    const aliases = siteIdAliases(siteId);
    const slip = String(req.params.slip || '').trim();
    const result = await query(
      `SELECT * FROM transactions_mirror
       WHERE site_id = ANY($1::text[]) AND slip_number = $2
       ORDER BY ${PHOTO_SCORE_SQL} DESC
       LIMIT 1`,
      [aliases, slip],
    );
    let row = result.rows[0] || null;
    const rt = await query(
      `SELECT * FROM remote_trips WHERE UPPER(slip_number) = UPPER($1) LIMIT 1`,
      [slip],
    );
    const remote = rt.rows[0] || null;
    if (!row && !remote) {
      return res.status(404).json({ ok: false, error: 'Report not found' });
    }

    // Prefer mirror fields, then hydrate missing/stale keys from remote + S3
    // (same path as GET /:slip edit previews).
    row = await hydratePhotoKeys({ ...(remote || {}), ...(row || {}) });

    const built = await generateTripPdf(row, { siteId, upload: true });

    if (built.report_s3_key) {
      await query(
        `UPDATE transactions_mirror
         SET report_s3_key = $3, updated_at = now()
         WHERE site_id = ANY($1::text[]) AND slip_number = $2`,
        [aliases, row.slip_number, built.report_s3_key],
      );
      await query(
        `UPDATE remote_trips SET report_s3_key = $2 WHERE UPPER(slip_number) = UPPER($1)`,
        [row.slip_number, built.report_s3_key],
      );
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${built.filename}"`,
    );
    return res.send(built.pdf);
  } catch (err) {
    return sendError(res, err);
  }
});

function normalizeAdminSlipNumber(input) {
  const raw = String(input || '').trim().toUpperCase();
  if (!raw) return '';
  const match = raw.match(/^([A-Z]+)?(\d+)$/);
  if (!match) return raw;
  const prefix = match[1] || 'WB';
  const num = parseInt(match[2], 10);
  if (!Number.isFinite(num) || num <= 0) return raw;
  return `${prefix}${String(num).padStart(4, '0')}`;
}

router.post('/:slip/edit', async (req, res) => {
  try {
    const siteId = getSiteId();
    const slip = String(req.params.slip || '').trim();
    const body = req.body || {};
    const newSlipNumber = normalizeAdminSlipNumber(body.newSlipNumber || body.slip_number);
    const truckNumber = String(body.truck_number || body.truckNumber || '')
      .trim()
      .toUpperCase();
    const payload = {
      slipNumber: slip,
      newSlipNumber: newSlipNumber || undefined,
      slip_number: newSlipNumber || undefined,
      truck_number: truckNumber || undefined,
      truckNumber: truckNumber || undefined,
      gross_weight: body.gross_weight,
      tare_weight: body.tare_weight,
      timestamp_in: body.timestamp_in,
      timestamp_out: body.timestamp_out,
      material: body.material,
      customer_name: body.customer_name,
      // Destination stays weighbridge-owned — do not send/overwrite from admin edit.
      operator_name: body.operator_name,
      photoS3Keys: body.photoS3Keys || [],
    };

    // Optimistic mirror update so admin Reports show the new tare/gross immediately.
    // The weighbridge PC still applies the command to local SQLite + regenerates PDF.
    const sets = [];
    const params = [];
    let idx = 1;
    const fields = [
      ['truck_number', truckNumber || undefined],
      ['gross_weight', body.gross_weight],
      ['tare_weight', body.tare_weight],
      ['timestamp_in', body.timestamp_in],
      ['timestamp_out', body.timestamp_out],
      ['material', body.material],
      ['customer_name', body.customer_name],
      ['operator_name', body.operator_name],
    ];
    for (const [col, value] of fields) {
      if (value === undefined || value === null || value === '') continue;
      sets.push(`${col} = $${idx++}`);
      params.push(col.includes('weight') ? Number(value) : value);
    }
    if (newSlipNumber && newSlipNumber !== slip) {
      const taken = await query(
        'SELECT slip_number FROM transactions_mirror WHERE site_id = $1 AND slip_number = $2 LIMIT 1',
        [siteId, newSlipNumber],
      );
      if (taken.rows[0]) {
        return res.status(409).json({
          ok: false,
          error: `Slip number ${newSlipNumber} is already used by another report`,
        });
      }
      sets.push(`slip_number = $${idx++}`);
      params.push(newSlipNumber);
    }
    // Optimistic photo keys so Admin Reports show images before the PC applies the command.
    const photoS3Keys = Array.isArray(body.photoS3Keys) ? body.photoS3Keys : [];
    for (const item of photoS3Keys) {
      const slot = Number(item.slot);
      const key = item.key || item.s3Key;
      const pass = item.pass === 'arrival' ? 'arrival' : 'departure';
      if (!key || !Number.isFinite(slot) || slot < 1 || slot > 3) continue;
      const safeKey = assertPhotoKeyForSlip(key, newSlipNumber || slip, siteId);
      sets.push(`${pass}_photo_${slot} = $${idx++}`);
      params.push(safeKey);
    }
    if (sets.length) {
      sets.push('updated_at = now()');
      params.push(siteId, slip);
      await query(
        `UPDATE transactions_mirror SET ${sets.join(', ')}
         WHERE site_id = $${idx++} AND slip_number = $${idx}`,
        params,
      );
    }

    // Keep remote_trips in sync when photos / vehicle are updated via Report Edit.
    const targetSlip = newSlipNumber || slip;
    try {
      const rt = await query(
        `SELECT id FROM remote_trips
         WHERE UPPER(slip_number) = UPPER($1) OR UPPER(slip_number) = UPPER($2)
         LIMIT 1`,
        [targetSlip, slip],
      );
      if (rt.rows[0]) {
        if (photoS3Keys.length) {
          const { attachPhotos } = require('../services/remoteTripService');
          await attachPhotos(query, rt.rows[0].id, photoS3Keys);
        }
        if (truckNumber) {
          await query(
            `UPDATE remote_trips
             SET truck_number = $2
             WHERE id = $1`,
            [rt.rows[0].id, truckNumber],
          );
        }
      }
    } catch (err) {
      console.warn('[reports] remote trip sync failed', err.message);
    }

    const cmd = await createCommand({
      type: 'edit_report',
      payload,
      createdBy: req.user?.email,
    });
    return res.json({
      ok: true,
      command: cmd,
      slip_number: newSlipNumber || slip,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/:slip/delete', requireRole('admin'), async (req, res) => {
  try {
    const slip = String(req.params.slip || '').trim();
    const cmd = await createCommand({
      type: 'delete_report',
      payload: { slipNumber: slip },
      createdBy: req.user?.email,
    });
    return res.json({ ok: true, command: cmd });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/:slip/cancel', requireRole('admin'), async (req, res) => {
  try {
    const slip = String(req.params.slip || '').trim();
    if (!slip) return res.status(400).json({ ok: false, error: 'Slip is required' });
    const siteId = getSiteId();
    const CANCEL = 'CANCEL';

    const mirrorRes = await query(
      `SELECT * FROM transactions_mirror
       WHERE site_id = $1 AND UPPER(slip_number) = UPPER($2)
       LIMIT 1`,
      [siteId, slip],
    );
    const mirror = mirrorRes.rows[0] || null;
    // Already-cancelled cloud rows still get a fresh PC command (failed/stuck sync).
    const alreadyCancelled =
      mirror && String(mirror.ticket_status || '').toUpperCase() === 'CANCELLED';

    const timestampIn = mirror?.timestamp_in || mirror?.timestamp_out || new Date().toISOString();
    const plate = String(mirror?.truck_number || '')
      .trim()
      .toUpperCase();
    const truckNumber = plate && plate !== CANCEL ? plate : CANCEL;

    if (mirror && !alreadyCancelled) {
      await query(
        `UPDATE transactions_mirror
         SET ticket_status = 'CANCELLED',
             material = $3,
             customer_name = $3,
             destination = $3,
             operator_name = $3,
             truck_number = $4,
             gross_weight = 0,
             tare_weight = 0,
             timestamp_in = $5,
             timestamp_out = $5,
             updated_at = now()
         WHERE site_id = $1 AND UPPER(slip_number) = UPPER($2)`,
        [siteId, slip, CANCEL, truckNumber, timestampIn],
      );
    }

    // Keep matching remote_trips voided the same way when one exists.
    try {
      const rt = await query(
        `SELECT id, ticket_status FROM remote_trips
         WHERE UPPER(slip_number) = UPPER($1)
         LIMIT 1`,
        [slip],
      );
      if (rt.rows[0]) {
        const { cancelRemoteTrip } = require('../services/remoteTripService');
        await cancelRemoteTrip(query, rt.rows[0].id, { allowAlreadyCancelled: true });
      }
    } catch (err) {
      console.warn('[reports] remote trip cancel sync failed', err.message);
    }

    const cmd = await createCommand({
      // Dedicated type so PC never runs cancel voids through weight validation.
      type: 'cancel_report',
      payload: {
        slipNumber: slip,
        cancel: true,
        ticket_status: 'CANCELLED',
        material: CANCEL,
        customer_name: CANCEL,
        destination: CANCEL,
        operator_name: CANCEL,
        company: CANCEL,
        gross_weight: 0,
        tare_weight: 0,
        truck_number: truckNumber,
        timestamp_in: timestampIn,
        timestamp_out: timestampIn,
      },
      createdBy: req.user?.email,
    });

    return res.json({
      ok: true,
      command: cmd,
      slip_number: slip,
      requeued: Boolean(alreadyCancelled),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
