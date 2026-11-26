'use strict';

const cron = require('node-cron');
const SettingsService = require('./SettingsService');
const ts = require('../utils/timestamp');
const logger = require('../utils/logger');

const ADMIN_WEIGHT_KEYS = Object.freeze([
  'WEIGHT_ADJUSTMENT_ENABLED',
  'WEIGHT_OFFSET_KG',
]);

/** Editable in Advance Setting even after expiry (used to recharge). */
const ADMIN_EXPIRE_KEY = 'WEIGHT_ADJUSTMENT_EXPIRE_AT';

/** Shown in Advance Setting when the offset window has ended. */
const FEATURE_EXPIRED_MESSAGE =
  'Offset weight disabled. Please recharge and contact admin.';

const ENABLED_AT_KEY = 'WEIGHT_ADJUSTMENT_ENABLED_AT';
const FEATURE_START_AT_KEY = 'WEIGHT_ADJUSTMENT_FEATURE_START_AT';
const EXPIRE_AT_KEY = 'WEIGHT_ADJUSTMENT_EXPIRE_AT';
/** Last calendar day offset weight stays available (YYYY-MM-DD, local time). */
const DEFAULT_EXPIRE_AT = '2026-11-30';
const AUTO_DISABLE_DAYS_KEY = 'WEIGHT_ADJUSTMENT_AUTO_DISABLE_DAYS';
const AUTO_DISABLE_MINUTES_KEY = 'WEIGHT_ADJUSTMENT_AUTO_DISABLE_MINUTES';
const MINUTES_APPLIED_KEY = 'WEIGHT_ADJUSTMENT_AUTO_DISABLE_MINUTES_APPLIED';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

/** Hourly in production; every minute when a minutes override is set (testing). */
const AUTO_DISABLE_CRON_HOURLY = '0 * * * *';
const AUTO_DISABLE_CRON_MINUTELY = '* * * * *';

let autoDisableCron = null;

function roundKg(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : 0;
}

function isEnabled() {
  return SettingsService.get('WEIGHT_ADJUSTMENT_ENABLED') === 'true';
}

function getOffsetKg() {
  const n = Number(SettingsService.get('WEIGHT_OFFSET_KG') || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function getAutoDisableDays() {
  const envRaw = process.env.WEIGHT_ADJUSTMENT_AUTO_DISABLE_DAYS;
  if (envRaw !== undefined && String(envRaw).trim() !== '') {
    const n = parseInt(envRaw, 10);
    if (!Number.isNaN(n) && n >= 1) return n;
  }
  const n = parseInt(SettingsService.get(AUTO_DISABLE_DAYS_KEY) || '3', 10);
  return Number.isNaN(n) || n < 1 ? 3 : n;
}

/** When > 0, overrides days (optional short test windows via .env). */
function getAutoDisableMinutes() {
  const envRaw = process.env.WEIGHT_ADJUSTMENT_AUTO_DISABLE_MINUTES;
  if (envRaw !== undefined) {
    const trimmed = String(envRaw).trim();
    if (trimmed === '') return 0;
    const n = parseInt(trimmed, 10);
    if (!Number.isNaN(n) && n >= 1) return n;
  }

  let raw;
  try {
    const { getDb } = require('../database/db');
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(AUTO_DISABLE_MINUTES_KEY);
    raw = row ? row.value : undefined;
  } catch {
    raw = undefined;
  }

  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n >= 1) return n;
  }

  return 0;
}

function syncWindowConfigToDb() {
  // Env wins. If env minutes is unset/empty, clear any leftover test value in DB.
  const envRaw = process.env.WEIGHT_ADJUSTMENT_AUTO_DISABLE_MINUTES;
  let minutes = 0;
  if (envRaw !== undefined && String(envRaw).trim() !== '') {
    const n = parseInt(envRaw, 10);
    if (!Number.isNaN(n) && n >= 1) minutes = n;
  } else if (envRaw === undefined) {
    minutes = 0;
  }
  SettingsService.set(AUTO_DISABLE_MINUTES_KEY, minutes > 0 ? String(minutes) : '');
  SettingsService.set(AUTO_DISABLE_DAYS_KEY, String(getAutoDisableDays()));
}

function windowSignature() {
  const minutes = getAutoDisableMinutes();
  if (minutes > 0) return `m:${minutes}`;
  return `d:${getAutoDisableDays()}`;
}

function getFeatureWindowMs() {
  const minutes = getAutoDisableMinutes();
  if (minutes > 0) return minutes * MS_PER_MINUTE;
  return getAutoDisableDays() * MS_PER_DAY;
}

function getEnabledAt() {
  const raw = SettingsService.get(ENABLED_AT_KEY);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Feature window start — stamped once on first run.
 * After the configured window the UI is hidden and settings are locked off.
 */
function ensureFeatureStartStamped() {
  const signature = windowSignature();
  const applied = SettingsService.get(MINUTES_APPLIED_KEY);
  if (signature !== String(applied || '')) {
    const stamp = ts.now();
    SettingsService.set(FEATURE_START_AT_KEY, stamp);
    SettingsService.set(MINUTES_APPLIED_KEY, signature);
    logger.info('Weight increase feature window started', {
      signature,
      featureStartAt: stamp,
      windowMs: getFeatureWindowMs(),
    });
    return new Date(stamp);
  }

  const existing = SettingsService.get(FEATURE_START_AT_KEY);
  if (existing) {
    const d = new Date(existing);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const stamp = ts.now();
  SettingsService.set(FEATURE_START_AT_KEY, stamp);
  SettingsService.set(MINUTES_APPLIED_KEY, signature);
  return new Date(stamp);
}

function getFeatureStartAt() {
  return ensureFeatureStartStamped();
}

/** Parse YYYY-MM-DD → local calendar date parts, or null. */
function parseExpireDate(raw) {
  const text = String(raw || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return { year, month, day, date: d };
}

function getExpireAtRaw() {
  const envRaw = process.env.WEIGHT_ADJUSTMENT_EXPIRE_AT;
  if (envRaw !== undefined && String(envRaw).trim() !== '') {
    return String(envRaw).trim();
  }
  const fromDb = String(SettingsService.get(EXPIRE_AT_KEY) || '').trim();
  return fromDb || DEFAULT_EXPIRE_AT;
}

/** Last inclusive day offset weight is allowed (local midnight of that date). */
function getExpireAt() {
  return parseExpireDate(getExpireAtRaw()) || parseExpireDate(DEFAULT_EXPIRE_AT);
}

function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Calendar hard stop: disabled after the configured “valid until” day (local time).
 * Default is 2026-11-30 (end of this month — November has no 31st).
 */
function isCalendarExpired(now = new Date()) {
  const expire = getExpireAt();
  if (!expire) return false;
  return localDateKey(now) > localDateKey(expire.date);
}

function isFeatureExpired() {
  if (isCalendarExpired()) return true;
  const start = getFeatureStartAt();
  return Date.now() - start.getTime() >= getFeatureWindowMs();
}

function isFeatureAvailable() {
  return !isFeatureExpired();
}

/**
 * Restart the feature window from now so weight-increase controls unlock again.
 * Also syncs the applied window signature so ensureFeatureStartStamped keeps this stamp.
 */
function setExpireAt(yyyyMmDd, reason = 'manual_set') {
  const parsed = parseExpireDate(yyyyMmDd);
  if (!parsed) {
    const err = new Error('Invalid expire date — use YYYY-MM-DD');
    err.code = 'WEIGHT_ADJUSTMENT_EXPIRE_AT_INVALID';
    throw err;
  }
  const value = localDateKey(parsed.date);
  SettingsService.set(EXPIRE_AT_KEY, value);
  logger.info('Weight increase expire date updated', { reason, expireAt: value });
  return value;
}

function renewFeatureWindow(reason = 'manual_renew', options = {}) {
  syncWindowConfigToDb();
  const stamp = ts.now();
  SettingsService.set(FEATURE_START_AT_KEY, stamp);
  SettingsService.set(MINUTES_APPLIED_KEY, windowSignature());
  if (options.expireAt) {
    setExpireAt(options.expireAt, reason);
  } else if (isCalendarExpired()) {
    // Recharge without an explicit date → extend through end of next month.
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 0);
    setExpireAt(localDateKey(nextMonth), reason);
  }
  logger.info('Weight increase feature window renewed', {
    reason,
    featureStartAt: stamp,
    ...getFeatureStatus(),
  });
  try {
    const { emit } = require('../utils/rendererEvents');
    emit('weightAdjustment:featureStatus', {
      available: isFeatureAvailable(),
      expired: isFeatureExpired(),
      renewed: true,
      ...getFeatureStatus(),
    });
  } catch (_e) {
    /* optional */
  }
  return getFeatureStatus();
}

/** Apply a feature-start timestamp from cloud (only if it unlocks or extends the window). */
function applyFeatureStartFromCloud(iso) {
  const incoming = new Date(iso);
  if (Number.isNaN(incoming.getTime())) return { applied: false, reason: 'invalid' };
  const localRaw = SettingsService.get(FEATURE_START_AT_KEY);
  const local = localRaw ? new Date(localRaw) : null;
  const localValid = local && !Number.isNaN(local.getTime());
  const localExpired =
    localValid && Date.now() - local.getTime() >= getFeatureWindowMs();
  const incomingNewer = !localValid || incoming.getTime() > local.getTime();
  if (!incomingNewer && !localExpired) {
    return { applied: false, reason: 'local_newer' };
  }
  // Prefer a cloud stamp that makes the feature available again.
  const incomingExpired = Date.now() - incoming.getTime() >= getFeatureWindowMs();
  if (incomingExpired && localValid && !localExpired) {
    return { applied: false, reason: 'cloud_expired' };
  }
  if (incomingExpired && localExpired) {
    return { applied: false, reason: 'both_expired' };
  }
  SettingsService.set(FEATURE_START_AT_KEY, incoming.toISOString());
  SettingsService.set(MINUTES_APPLIED_KEY, windowSignature());
  logger.info('Weight increase feature start applied from cloud', {
    featureStartAt: incoming.toISOString(),
    previous: localValid ? local.toISOString() : null,
  });
  return { applied: true, ...getFeatureStatus() };
}

function getFeatureStatus() {
  const start = getFeatureStartAt();
  const minutes = getAutoDisableMinutes();
  const days = getAutoDisableDays();
  const windowMs = getFeatureWindowMs();
  const windowExpiresAt = new Date(start.getTime() + windowMs);
  const calendarExpire = getExpireAt();
  const calendarExpired = isCalendarExpired();
  // End of the expire calendar day (local).
  const calendarExpiresAt = calendarExpire
    ? new Date(
        calendarExpire.year,
        calendarExpire.month - 1,
        calendarExpire.day,
        23,
        59,
        59,
        999,
      )
    : null;
  const windowExpired = Date.now() >= windowExpiresAt.getTime();
  const expired = calendarExpired || windowExpired;
  const expiresAt =
    calendarExpiresAt && calendarExpiresAt.getTime() < windowExpiresAt.getTime()
      ? calendarExpiresAt
      : windowExpiresAt;
  return {
    available: !expired,
    expired,
    calendarExpired,
    windowExpired,
    days,
    minutes: minutes || null,
    windowMs,
    featureStartAt: start.toISOString(),
    expireAt: calendarExpire ? localDateKey(calendarExpire.date) : DEFAULT_EXPIRE_AT,
    expiresAt: expiresAt.toISOString(),
    remainingMs: expired ? 0 : Math.max(0, expiresAt.getTime() - Date.now()),
    message: expired ? FEATURE_EXPIRED_MESSAGE : '',
  };
}

function stampEnabledAt(iso = ts.now()) {
  SettingsService.set(ENABLED_AT_KEY, iso);
  return iso;
}

function clearEnabledAt() {
  SettingsService.set(ENABLED_AT_KEY, '');
}

/**
 * Called whenever WEIGHT_ADJUSTMENT_ENABLED is written (UI / remote admin).
 * Rejects enable after the feature window expires.
 */
function onEnabledSettingChanged(value) {
  const enabled = String(value).toLowerCase() === 'true' || value === true || value === '1';
  if (enabled && isFeatureExpired()) {
    SettingsService.set('WEIGHT_ADJUSTMENT_ENABLED', 'false');
    clearEnabledAt();
    clearLiveRamp();
    logger.warn('Weight increase enable blocked — feature window expired');
    return { ok: false, reason: 'feature_expired' };
  }
  if (enabled) {
    ensureFeatureStartStamped();
    stampEnabledAt();
    clearLiveRamp();
    logger.info('Weight increase enabled — UI locks after feature window', {
      ...getFeatureStatus(),
    });
  } else {
    clearEnabledAt();
    clearLiveRamp();
  }
  return { ok: true };
}

function assertFeatureAllowsChanges() {
  if (isFeatureExpired()) {
    const err = new Error(FEATURE_EXPIRED_MESSAGE);
    err.code = 'WEIGHT_ADJUSTMENT-error';
    throw err;
  }
}

function disableWeightIncrease(reason = 'auto_disable') {
  if (!isEnabled()) {
    clearEnabledAt();
    return { ok: true, skipped: true, reason: 'already_disabled' };
  }
  SettingsService.set('WEIGHT_ADJUSTMENT_ENABLED', 'false');
  clearEnabledAt();
  clearLiveRamp();
  logger.info('Weight increase disabled', { reason, ...getFeatureStatus() });
  return { ok: true, reason };
}

/**
 * After the feature window expires: force off and lock.
 * While still available: also turn off if enabled for >= days (legacy).
 */
function checkAutoDisable() {
  ensureFeatureStartStamped();

  let result;
  if (isFeatureExpired()) {
    result = disableWeightIncrease('feature_window_expired');
  } else if (!isEnabled()) {
    if (SettingsService.get(ENABLED_AT_KEY)) clearEnabledAt();
    result = { ok: true, skipped: true, reason: 'disabled', ...getFeatureStatus() };
  } else {
    result = { ok: true, active: true, ...getFeatureStatus() };
  }

  try {
    const { emit } = require('../utils/rendererEvents');
    emit('weightAdjustment:featureStatus', {
      available: isFeatureAvailable(),
      expired: isFeatureExpired(),
      ...getFeatureStatus(),
    });
  } catch (_e) {
    /* optional */
  }

  return result;
}

/** Live GROSS ramp — offset grows gradually as raw rises from session base. */
let liveRampSession = null;

/** When raw has not risen (vehicle already on scale), ramp offset over this duration. */
const TIME_RAMP_MS = 6000;

/** Raw rise below this is treated as stationary (use time-based ramp). */
const STATIONARY_RISE_KG = 50;

function clearLiveRamp() {
  liveRampSession = null;
}

function getRampSpanKg() {
  const offset = getOffsetKg();
  return Math.max(offset * 20, 500);
}

function resolveIncreaseRatio(raw, pass, options = {}) {
  const rise = Math.max(0, raw - liveRampSession.baseRawKg);
  const riseRatio = Math.min(1, rise / getRampSpanKg());
  const stationary = rise < STATIONARY_RISE_KG;
  const timeRatio = stationary
    ? Math.min(1, (Date.now() - liveRampSession.startedAt) / TIME_RAMP_MS)
    : 0;
  let increaseRatio = Math.max(riseRatio, timeRatio);
  if (options.isStable && (riseRatio >= 1 || timeRatio >= 1 || stationary)) {
    increaseRatio = 1;
  }
  return increaseRatio;
}

/** Offset applies to loaded truck (gross) only — not tare or idle/live preview. */
function shouldApplyOffset(pass) {
  if (!isFeatureAvailable() || !isEnabled() || getOffsetKg() === 0) return false;
  return pass === 'GROSS';
}

/**
 * @param {number} rawKg
 * @param {{ pass?: 'TARE'|'GROSS'|null, live?: boolean }} context
 */
function apply(rawKg, context = {}) {
  const raw = roundKg(rawKg);
  if (raw <= 0) return raw;

  // Live preview / external LED should mirror the scale — offset applies on save only.
  if (context.live) return raw;

  const pass = context.pass || null;
  if (!shouldApplyOffset(pass)) return raw;

  return raw + getOffsetKg();
}

/**
 * Live display with gradual offset ramp on GROSS pass (UI + external LED).
 * Ramps by raw rise while loading; if the truck is already fully on scale,
 * ramps by time and completes to full offset when stable.
 * @param {number} rawKg
 * @param {'TARE'|'GROSS'|null} pass
 * @param {{ isStable?: boolean }} [options]
 */
function resolveLiveDisplay(rawKg, pass, options = {}) {
  const raw = roundKg(rawKg);
  if (raw <= 0) {
    clearLiveRamp();
    return raw;
  }
  if (!shouldApplyOffset(pass)) {
    clearLiveRamp();
    return raw;
  }

  const offsetKg = getOffsetKg();
  if (offsetKg <= 0) {
    clearLiveRamp();
    return raw;
  }

  if (!liveRampSession || liveRampSession.pass !== pass) {
    liveRampSession = {
      pass,
      baseRawKg: raw,
      peakRawKg: raw,
      offsetKg,
      startedAt: Date.now(),
    };
  } else {
    liveRampSession.peakRawKg = Math.max(liveRampSession.peakRawKg, raw);
    liveRampSession.baseRawKg = Math.min(liveRampSession.baseRawKg, raw);
  }

  const increaseRatio = resolveIncreaseRatio(raw, pass, options);
  const appliedOffset = roundKg(offsetKg * increaseRatio);
  return raw + appliedOffset;
}

/**
 * @param {number} rawKg
 * @param {{ pass?: 'TARE'|'GROSS'|null }} context
 */
function split(rawKg, context = {}) {
  const raw = roundKg(rawKg);
  const offsetKg = shouldApplyOffset(context.pass || null) ? getOffsetKg() : 0;
  return {
    rawKg: raw,
    adjustedKg: raw + offsetKg,
    offsetKg,
  };
}

function ensureExpireAtInDb() {
  try {
    const { getDb } = require('../database/db');
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(EXPIRE_AT_KEY);
    if (!row || !String(row.value || '').trim()) {
      SettingsService.set(EXPIRE_AT_KEY, DEFAULT_EXPIRE_AT);
    }
  } catch {
    SettingsService.set(EXPIRE_AT_KEY, getExpireAtRaw());
  }
}

function start() {
  stop();
  syncWindowConfigToDb();
  ensureExpireAtInDb();
  const minutes = getAutoDisableMinutes();
  const cronExpr = minutes > 0 ? AUTO_DISABLE_CRON_MINUTELY : AUTO_DISABLE_CRON_HOURLY;
  if (!cron.validate(cronExpr)) {
    logger.error('WeightAdjustmentService invalid auto-disable cron', {
      cron: cronExpr,
    });
    return;
  }
  autoDisableCron = cron.schedule(cronExpr, () => {
    try {
      checkAutoDisable();
    } catch (err) {
      logger.logError('Weight increase auto-disable check', err);
    }
  });
  try {
    checkAutoDisable();
  } catch (err) {
    logger.logError('Weight increase auto-disable startup check', err);
  }
  logger.info('WeightAdjustmentService auto-disable schedule active', {
    cron: cronExpr,
    enabled: isEnabled(),
    ...getFeatureStatus(),
  });
}

function stop() {
  if (autoDisableCron) {
    autoDisableCron.stop();
    autoDisableCron = null;
  }
}

module.exports = {
  ADMIN_WEIGHT_KEYS,
  ADMIN_EXPIRE_KEY,
  ENABLED_AT_KEY,
  FEATURE_START_AT_KEY,
  EXPIRE_AT_KEY,
  DEFAULT_EXPIRE_AT,
  FEATURE_EXPIRED_MESSAGE,
  AUTO_DISABLE_DAYS_KEY,
  AUTO_DISABLE_MINUTES_KEY,
  isEnabled,
  getOffsetKg,
  getAutoDisableDays,
  getAutoDisableMinutes,
  getFeatureWindowMs,
  getEnabledAt,
  getFeatureStartAt,
  getExpireAt,
  getExpireAtRaw,
  setExpireAt,
  isCalendarExpired,
  isFeatureExpired,
  isFeatureAvailable,
  renewFeatureWindow,
  applyFeatureStartFromCloud,
  getFeatureStatus,
  shouldApplyOffset,
  apply,
  split,
  resolveLiveDisplay,
  clearLiveRamp,
  onEnabledSettingChanged,
  assertFeatureAllowsChanges,
  disableWeightIncrease,
  checkAutoDisable,
  start,
  stop,
};
