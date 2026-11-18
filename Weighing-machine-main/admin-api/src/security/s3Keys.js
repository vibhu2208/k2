'use strict';

const { getSiteId } = require('../db');
const { siteIdAliases } = require('../siteId');

const SLIP_RE = /^WB[0-9]{1,8}$/i;
const MAX_KEY_LEN = 512;

function normalizeSlip(slip) {
  const raw = String(slip || '').trim().toUpperCase();
  if (!raw) return '';
  if (SLIP_RE.test(raw)) return raw;
  const m = raw.match(/^([A-Z]+)?(\d+)$/);
  if (!m) return '';
  const prefix = m[1] || 'WB';
  const num = parseInt(m[2], 10);
  if (!Number.isFinite(num) || num <= 0) return '';
  return `${prefix}${String(num).padStart(4, '0')}`;
}

function assertValidSlip(slip) {
  const normalized = normalizeSlip(slip);
  if (!normalized || !SLIP_RE.test(normalized)) {
    throw new Error('Invalid slip number');
  }
  if (normalized.includes('/') || normalized.includes('\\') || normalized.includes('..')) {
    throw new Error('Invalid slip number');
  }
  return normalized;
}

function isSafeKeyShape(key) {
  const k = String(key || '');
  if (!k || k.length > MAX_KEY_LEN) return false;
  if (k.includes('..') || k.includes('\\') || k.startsWith('/')) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(k)) return false;
  return true;
}

function allowedPrefixes(siteId = getSiteId()) {
  const prefixes = ['remote-trips/', 'fill-vehicles/'];
  for (const id of siteIdAliases(siteId)) {
    prefixes.push(`sites/${id}/`);
  }
  return prefixes;
}

function assertAllowedObjectKey(key, siteId = getSiteId()) {
  const k = String(key || '').trim();
  if (!isSafeKeyShape(k)) {
    throw new Error('Invalid object key');
  }
  const ok = allowedPrefixes(siteId).some((prefix) => k.startsWith(prefix));
  if (!ok) {
    throw new Error('Object key is outside the allowed prefixes');
  }
  return k;
}

function assertPhotoKeyForSlip(key, slip, siteId = getSiteId()) {
  const safeKey = assertAllowedObjectKey(key, siteId);
  const slipNum = assertValidSlip(slip);
  const needle = `/${slipNum}/`;
  if (
    !safeKey.includes(needle) &&
    !safeKey.startsWith(`remote-trips/${slipNum}/`)
  ) {
    // Mirror keys: sites/{site}/mirror/{slip}/...
    const mirrorOk = siteIdAliases(siteId).some(
      (id) => safeKey.startsWith(`sites/${id}/mirror/${slipNum}/`),
    );
    if (!mirrorOk) {
      throw new Error('Object key does not match slip');
    }
  }
  return safeKey;
}

module.exports = {
  SLIP_RE,
  normalizeSlip,
  assertValidSlip,
  assertAllowedObjectKey,
  assertPhotoKeyForSlip,
};
