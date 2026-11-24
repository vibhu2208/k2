'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { isConfigured } = require('./db');
const { bootstrapAdminUser, resolveJwtSecret } = require('./auth');

const authRoutes = require('./routes/auth');
const reportsRoutes = require('./routes/reports');
const settingsRoutes = require('./routes/settings');
const syncRoutes = require('./routes/sync');
const mediaRoutes = require('./routes/media');
const remoteTripsRoutes = require('./routes/remoteTrips');
const slipReservationsRoutes = require('./routes/slipReservations');
const offsetAuditRoutes = require('./routes/offsetAudit');
const {
  ensureSchema: ensureSlipReservationsSchema,
  startFireWorker,
} = require('./services/slipReservationService');
const { ensureSchema: ensureOffsetAuditSchema } = require('./services/offsetAuditService');
const {
  startMirrorReconcileWorker,
  startOutTimeReleaseWorker,
} = require('./services/remoteTripService');
const { startVehicleReassertWorker } = require('./services/commandService');
const { query } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

try {
  resolveJwtSecret();
} catch (err) {
  console.error('[auth]', err.message);
  process.exit(1);
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

const corsOrigin = (process.env.CORS_ORIGIN || (isProd ? '' : '*')).trim();
if (isProd && (!corsOrigin || corsOrigin === '*')) {
  console.error('[api] CORS_ORIGIN must be an explicit allowlist in production');
  process.exit(1);
}
app.use(
  cors({
    origin:
      !corsOrigin || corsOrigin === '*'
        ? true
        : corsOrigin.split(',').map((s) => s.trim()).filter(Boolean),
    credentials: false,
  }),
);

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '8mb' }));

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests' },
});
app.use(globalLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many login attempts — try again later' },
});

const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.HEAVY_RATE_LIMIT_PER_MIN) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many heavy requests — slow down' },
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/auth/login', loginLimiter);
app.use('/auth', authRoutes);
app.use('/reports', reportsRoutes);
app.use('/settings', settingsRoutes);
app.use('/sync', syncRoutes);
app.use('/media', mediaRoutes);
app.use('/remote-trips', heavyLimiter, remoteTripsRoutes);
app.use('/slip-reservations', slipReservationsRoutes);
app.use('/offset-audit', offsetAuditRoutes);

app.use((err, _req, res, _next) => {
  console.error('[api] error', err);
  const message =
    isProd ? 'Internal error' : err.message || 'Internal error';
  res.status(500).json({ ok: false, error: message });
});

async function bootstrap() {
  if (!isConfigured()) {
    console.warn('[api] DATABASE_URL not configured — API will fail on DB calls');
    return;
  }
  try {
    await bootstrapAdminUser();
  } catch (err) {
    console.error(
      '[auth] Bootstrap failed — run scripts/rds/002_admin_panel.sql on RDS:',
      err.message,
    );
  }
  try {
    await ensureSlipReservationsSchema();
    console.log('[api] slip_reservations schema ready');
    startFireWorker();
  } catch (err) {
    console.error(
      '[api] slip_reservations setup failed — run scripts/rds/003_slip_reservations.sql:',
      err.message,
    );
  }
  try {
    await ensureOffsetAuditSchema();
    console.log('[api] weight_offset_audit_mirror schema ready');
  } catch (err) {
    console.error(
      '[api] offset audit schema failed — run scripts/rds/005_weight_offset_audit_mirror.sql:',
      err.message,
    );
  }
  try {
    // Batched reconcile every 2 minutes instead of full-table every 60s.
    startMirrorReconcileWorker(query, 120);
    startOutTimeReleaseWorker(query, 15000);
    console.log('[api] remote trip → mirror reconcile worker started');
  } catch (err) {
    console.warn('[api] mirror reconcile worker failed to start', err.message);
  }
  try {
    startVehicleReassertWorker();
    console.log('[api] vehicle reassert worker started');
  } catch (err) {
    console.warn('[api] vehicle reassert worker failed to start', err.message);
  }
}

function start() {
  // Bind immediately so Vite proxy is not refused while RDS bootstrap times out.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[api] listening on port ${PORT}`);
  });
  bootstrap().catch((err) => {
    console.error('[api] bootstrap error', err);
  });
}

start();
