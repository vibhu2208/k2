'use strict';

const { query, getSiteId } = require('../db');
const { REMOTE_SAFE_KEYS, LIST_KEYS, assertRemoteKey, parseListValue, serializeListValue } = require('../constants');

const WEIGHT_UI_KEYS = new Set([
  'WEIGHT_ADJUSTMENT_ENABLED',
  'WEIGHT_OFFSET_KG',
]);

const FEATURE_EXPIRED_MESSAGE =
  'Offset weight disabled. Please recharge and contact admin.';
const DEFAULT_EXPIRE_AT = '2026-11-30';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseExpireDate(raw) {
  const text = String(raw || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return d;
}

async function getWeightFeatureStatus() {
  const siteId = getSiteId();
  const res = await query(
    `SELECT key, value FROM site_settings
     WHERE site_id = $1 AND key IN (
       'WEIGHT_ADJUSTMENT_FEATURE_START_AT',
       'WEIGHT_ADJUSTMENT_EXPIRE_AT',
       'WEIGHT_ADJUSTMENT_AUTO_DISABLE_DAYS',
       'WEIGHT_ADJUSTMENT_AUTO_DISABLE_MINUTES'
     )`,
    [siteId],
  );
  const map = {};
  for (const row of res.rows) map[row.key] = row.value;
  const startRaw = map.WEIGHT_ADJUSTMENT_FEATURE_START_AT;
  const expireRaw = String(map.WEIGHT_ADJUSTMENT_EXPIRE_AT || '').trim() || DEFAULT_EXPIRE_AT;
  const expireDate = parseExpireDate(expireRaw) || parseExpireDate(DEFAULT_EXPIRE_AT);
  const calendarExpired = expireDate ? localDateKey() > localDateKey(expireDate) : false;
  const days = Math.max(1, parseInt(map.WEIGHT_ADJUSTMENT_AUTO_DISABLE_DAYS || '3', 10) || 3);
  const minutes = Math.max(0, parseInt(map.WEIGHT_ADJUSTMENT_AUTO_DISABLE_MINUTES || '0', 10) || 0);
  const windowMs = minutes > 0 ? minutes * 60 * 1000 : days * MS_PER_DAY;

  let windowExpired = false;
  let featureStartAt = null;
  if (startRaw) {
    const start = new Date(startRaw);
    if (!Number.isNaN(start.getTime())) {
      featureStartAt = start.toISOString();
      windowExpired = Date.now() - start.getTime() >= windowMs;
    }
  }

  const expired = calendarExpired || windowExpired;
  return {
    available: !expired,
    expired,
    calendarExpired,
    windowExpired,
    days,
    minutes: minutes || null,
    expireAt: expireDate ? localDateKey(expireDate) : DEFAULT_EXPIRE_AT,
    featureStartAt,
    message: expired ? FEATURE_EXPIRED_MESSAGE : '',
  };
}

async function getAdvanceSettings() {
  const siteId = getSiteId();
  const res = await query(
    'SELECT key, value, updated_at FROM site_settings WHERE site_id = $1',
    [siteId],
  );
  const map = {};
  for (const row of res.rows) {
    if (REMOTE_SAFE_KEYS.has(row.key)) {
      map[row.key] = row.value;
    }
  }
  const feature = await getWeightFeatureStatus();
  map.WEIGHT_ADJUSTMENT_FEATURE_AVAILABLE = feature.available ? 'true' : 'false';
  map.WEIGHT_ADJUSTMENT_EXPIRE_AT = feature.expireAt || DEFAULT_EXPIRE_AT;
  if (feature.message) {
    map.WEIGHT_ADJUSTMENT_FEATURE_MESSAGE = feature.message;
  }
  if (!feature.available) {
    delete map.WEIGHT_ADJUSTMENT_ENABLED;
    delete map.WEIGHT_OFFSET_KG;
  }
  return map;
}

async function renewWeightFeatureWindow(updatedBy) {
  const siteId = getSiteId();
  const stamp = new Date().toISOString();
  await query(
    `INSERT INTO site_settings (site_id, key, value, updated_at, updated_by)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (site_id, key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by`,
    [siteId, 'WEIGHT_ADJUSTMENT_FEATURE_START_AT', stamp, updatedBy || null],
  );
  return getWeightFeatureStatus();
}

async function putAdvanceSettings(values = {}, updatedBy) {
  const siteId = getSiteId();
  const keys = Object.keys(values);
  if (!keys.length) throw new Error('No settings provided');

  if (Object.prototype.hasOwnProperty.call(values, 'WEIGHT_ADJUSTMENT_EXPIRE_AT')) {
    const parsed = parseExpireDate(values.WEIGHT_ADJUSTMENT_EXPIRE_AT);
    if (!parsed) {
      throw new Error('Invalid expire date — use YYYY-MM-DD');
    }
    values.WEIGHT_ADJUSTMENT_EXPIRE_AT = localDateKey(parsed);
  }

  let feature = await getWeightFeatureStatus();
  const touchesWeightUi = keys.some((key) => WEIGHT_UI_KEYS.has(key));
  const expireUpdated = Object.prototype.hasOwnProperty.call(
    values,
    'WEIGHT_ADJUSTMENT_EXPIRE_AT',
  );
  if ((touchesWeightUi || expireUpdated) && !feature.available) {
    feature = await renewWeightFeatureWindow(updatedBy);
  }

  for (const key of keys) {
    if (key === 'WEIGHT_ADJUSTMENT_FEATURE_AVAILABLE') continue;
    if (key === 'WEIGHT_ADJUSTMENT_FEATURE_MESSAGE') continue;
    if (key === 'WEIGHT_ADJUSTMENT_FEATURE_START_AT') continue;
    assertRemoteKey(key);
    if (WEIGHT_UI_KEYS.has(key) && !feature.available) {
      throw new Error(FEATURE_EXPIRED_MESSAGE);
    }
    await query(
      `INSERT INTO site_settings (site_id, key, value, updated_at, updated_by)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (site_id, key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by`,
      [siteId, key, String(values[key] ?? ''), updatedBy || null],
    );
  }
  return getAdvanceSettings();
}

async function getList(name) {
  const key = LIST_KEYS[name];
  if (!key) throw new Error('Unknown list name');
  const siteId = getSiteId();
  const res = await query(
    'SELECT value FROM site_settings WHERE site_id = $1 AND key = $2',
    [siteId, key],
  );
  return parseListValue(res.rows[0]?.value);
}

async function putList(name, items, updatedBy) {
  const key = LIST_KEYS[name];
  if (!key) throw new Error('Unknown list name');
  assertRemoteKey(key);
  const siteId = getSiteId();
  await query(
    `INSERT INTO site_settings (site_id, key, value, updated_at, updated_by)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (site_id, key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by`,
    [siteId, key, serializeListValue(items), updatedBy || null],
  );
  return parseListValue(serializeListValue(items));
}

module.exports = {
  getAdvanceSettings,
  putAdvanceSettings,
  renewWeightFeatureWindow,
  getWeightFeatureStatus,
  getList,
  putList,
};
