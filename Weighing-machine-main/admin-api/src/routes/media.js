'use strict';

const express = require('express');
const { authMiddleware } = require('../auth');
const { getSiteId } = require('../db');
const {
  presignGet,
  presignPut,
  putObject,
  mirrorPhotoKey,
  remoteTripPhotoKey,
  fillVehicleStillKey,
  isConfigured,
} = require('../services/s3Presign');
const { assertValidSlip, assertAllowedObjectKey } = require('../security/s3Keys');
const { parseImageBuffer } = require('../security/imageUpload');
const { sendError } = require('../security/httpErrors');

const PLATE_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{3,4}$/;
const ALLOWED_UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const router = express.Router();
router.use(authMiddleware);

function resolveUploadContentType(contentType) {
  const ct = String(contentType || 'image/jpeg').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_UPLOAD_TYPES.has(ct)) {
    throw Object.assign(new Error('contentType must be image/jpeg, image/png, or image/webp'), {
      status: 400,
    });
  }
  return ct;
}

router.get('/presign', async (req, res) => {
  try {
    const key = assertAllowedObjectKey(String(req.query.key || '').trim());
    const url = await presignGet(key);
    return res.json({ ok: true, url, key });
  } catch (err) {
    return sendError(res, err, 400);
  }
});

router.post('/upload-url', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const siteId = getSiteId();
    const { slot, pass } = req.body || {};
    const slipNum = assertValidSlip(req.body?.slip);
    const slotNum = Number(slot);
    const photoPass = pass === 'arrival' ? 'arrival' : 'departure';
    if (!Number.isFinite(slotNum) || slotNum < 1 || slotNum > 3) {
      return res.status(400).json({ ok: false, error: 'slip and slot (1-3) required' });
    }
    const contentType = resolveUploadContentType(req.body?.contentType);
    const key = mirrorPhotoKey(siteId, slipNum, slotNum, photoPass);
    const url = await presignPut(key, contentType);
    return res.json({ ok: true, uploadUrl: url, key, contentType });
  } catch (err) {
    return sendError(res, err, 400);
  }
});

router.post('/remote-trip-upload-url', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const { slot, pass } = req.body || {};
    const slipNum = assertValidSlip(req.body?.slip);
    const slotNum = Number(slot);
    const photoPass = pass === 'arrival' ? 'arrival' : 'departure';
    if (!Number.isFinite(slotNum) || slotNum < 1 || slotNum > 3) {
      return res.status(400).json({ ok: false, error: 'slip and slot (1-3) required' });
    }
    const contentType = resolveUploadContentType(req.body?.contentType);
    const key = remoteTripPhotoKey(slipNum, slotNum, photoPass);
    const url = await presignPut(key, contentType);
    return res.json({ ok: true, uploadUrl: url, key, contentType });
  } catch (err) {
    return sendError(res, err, 400);
  }
});

/** Browser uploads via API (avoids S3 CORS "Failed to fetch"). */
router.post('/remote-trip-upload', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const { slot, pass, imageBase64 } = req.body || {};
    const slipNum = assertValidSlip(req.body?.slip);
    const slotNum = Number(slot);
    const photoPass = pass === 'arrival' ? 'arrival' : 'departure';
    if (!Number.isFinite(slotNum) || slotNum < 1 || slotNum > 3) {
      return res.status(400).json({ ok: false, error: 'slip and slot (1-3) required' });
    }
    const key = remoteTripPhotoKey(slipNum, slotNum, photoPass);
    const { buffer, contentType } = await parseImageBuffer(imageBase64);
    await putObject(key, buffer, contentType);
    return res.json({ ok: true, key, slot: slotNum, pass: photoPass });
  } catch (err) {
    return sendError(res, err, 400);
  }
});

/** Original weighbridge stills for a fill vehicle (arrival/departure cam 1 and 2). */
router.post('/fill-vehicle-still', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const { plate, slot, pass, imageBase64 } = req.body || {};
    const truck = String(plate || '')
      .toUpperCase()
      .replace(/[\s-]/g, '');
    const slotNum = Number(slot);
    const photoPass = pass === 'arrival' || pass === 'departure' ? pass : '';
    if (!PLATE_RE.test(truck) || (slotNum !== 1 && slotNum !== 2) || !photoPass) {
      return res.status(400).json({
        ok: false,
        error: 'plate, pass (arrival|departure), and slot (1-2) required',
      });
    }
    const key = fillVehicleStillKey(truck, photoPass, slotNum);
    const { buffer, contentType } = await parseImageBuffer(imageBase64);
    await putObject(key, buffer, contentType);
    const url = await presignGet(key);
    return res.json({ ok: true, key, url, slot: slotNum, pass: photoPass });
  } catch (err) {
    return sendError(res, err, 400);
  }
});

/** Mirror/report-edit uploads via API (avoids S3 CORS). */
router.post('/upload', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const siteId = getSiteId();
    const { slot, pass, imageBase64 } = req.body || {};
    const slipNum = assertValidSlip(req.body?.slip);
    const slotNum = Number(slot);
    const photoPass = pass === 'arrival' ? 'arrival' : 'departure';
    if (!Number.isFinite(slotNum) || slotNum < 1 || slotNum > 3) {
      return res.status(400).json({ ok: false, error: 'slip and slot (1-3) required' });
    }
    const key = mirrorPhotoKey(siteId, slipNum, slotNum, photoPass);
    const { buffer, contentType } = await parseImageBuffer(imageBase64);
    await putObject(key, buffer, contentType);
    return res.json({ ok: true, key, slot: slotNum, pass: photoPass });
  } catch (err) {
    return sendError(res, err, 400);
  }
});

module.exports = router;
