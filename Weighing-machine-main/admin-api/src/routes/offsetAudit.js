'use strict';

const express = require('express');
const { authMiddleware, requireRole } = require('../auth');
const offsetAuditService = require('../services/offsetAuditService');

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole('admin'));

router.get('/', async (req, res) => {
  try {
    const data = await offsetAuditService.list({
      from: req.query.from || null,
      to: req.query.to || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.json({ ok: true, ...data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/fetch', async (req, res) => {
  try {
    const command = await offsetAuditService.requestFetch({
      from: req.body?.from || null,
      to: req.body?.to || null,
      createdBy: req.user?.email || req.user?.id || null,
    });
    return res.status(201).json({
      ok: true,
      command,
      message:
        'Queued fetch_offset_audit — weighbridge PC will push offset rows within ~30 seconds (requires updated PC app).',
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
