'use strict';

const { getDb } = require('../database/db');

const SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MANUAL_HYWA_CLOSE_PIN = '0824';
const DEFAULT_ENGINEERING_ACCESS_CODE = '0021';
const DEFAULT_WEIGHT_OFFSET_ACCESS_CODE = '9988';

let adminSession = null;
let manualHywaCloseSession = null;
let engineeringSession = null;

function manualHywaClosePin() {
  const fromEnv = String(process.env.MANUAL_HYWA_CLOSE_PIN || '').trim();
  return fromEnv || DEFAULT_MANUAL_HYWA_CLOSE_PIN;
}

/** Persist default engineering code into settings if missing. */
function ensureEngineeringAccessCodeInDb() {
  const row = getDb()
    .prepare(`SELECT value FROM settings WHERE key = 'ENGINEERING_ACCESS_CODE' LIMIT 1`)
    .get();
  if (row && String(row.value || '').trim()) return;
  const SettingsService = require('./SettingsService');
  SettingsService.set('ENGINEERING_ACCESS_CODE', DEFAULT_ENGINEERING_ACCESS_CODE);
}

function ensureWeightOffsetAccessCodeInDb() {
  const row = getDb()
    .prepare(`SELECT value FROM settings WHERE key = 'WEIGHT_OFFSET_ACCESS_CODE' LIMIT 1`)
    .get();
  if (row && String(row.value || '').trim()) return;
  const SettingsService = require('./SettingsService');
  SettingsService.set('WEIGHT_OFFSET_ACCESS_CODE', DEFAULT_WEIGHT_OFFSET_ACCESS_CODE);
}

function engineeringAccessCode() {
  ensureEngineeringAccessCodeInDb();
  const fromEnv = String(process.env.ENGINEERING_ACCESS_CODE || '').trim();
  if (fromEnv) return fromEnv;
  const SettingsService = require('./SettingsService');
  const fromDb = String(SettingsService.get('ENGINEERING_ACCESS_CODE') || '').trim();
  return fromDb || DEFAULT_ENGINEERING_ACCESS_CODE;
}

function weightOffsetAccessCode() {
  ensureWeightOffsetAccessCodeInDb();
  const fromEnv = String(process.env.WEIGHT_OFFSET_ACCESS_CODE || '').trim();
  if (fromEnv) return fromEnv;
  const SettingsService = require('./SettingsService');
  const fromDb = String(SettingsService.get('WEIGHT_OFFSET_ACCESS_CODE') || '').trim();
  return fromDb || DEFAULT_WEIGHT_OFFSET_ACCESS_CODE;
}

function isAdminSessionActive() {
  if (!adminSession) return false;
  if (Date.now() > adminSession.expiresAt) {
    adminSession = null;
    return false;
  }
  return adminSession.role === 'admin';
}

function verifyPin(pin) {
  const trimmed = String(pin || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'PIN is required' };
  }

  const row = getDb()
    .prepare(
      `SELECT id, name, pin, role, status FROM operators
       WHERE pin = ? AND status = 'active' LIMIT 1`,
    )
    .get(trimmed);

  if (!row) {
    return { ok: false, error: 'Invalid PIN' };
  }

  if (row.role !== 'admin') {
    return { ok: false, error: 'Admin access required' };
  }

  const now = Date.now();
  adminSession = {
    operatorId: row.id,
    name: row.name,
    role: row.role,
    unlockedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };

  return {
    ok: true,
    operator: {
      id: row.id,
      name: row.name,
      role: row.role,
    },
    expiresAt: adminSession.expiresAt,
  };
}

function lockAdvanced() {
  adminSession = null;
  manualHywaCloseSession = null;
  engineeringSession = null;
  return { ok: true };
}

function isEngineeringSessionActive() {
  if (!engineeringSession) return false;
  if (Date.now() > engineeringSession.expiresAt) {
    engineeringSession = null;
    return false;
  }
  return true;
}

function verifyEngineeringPin(pin) {
  const trimmed = String(pin || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Access code is required' };
  }
  if (trimmed !== engineeringAccessCode()) {
    return { ok: false, error: 'Invalid engineering access code' };
  }

  const now = Date.now();
  engineeringSession = {
    unlockedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };

  return {
    ok: true,
    mode: 'engineering',
    expiresAt: engineeringSession.expiresAt,
  };
}

/**
 * Single Advance Setting gate:
 * - 0021 (ENGINEERING_ACCESS_CODE) → engineering console
 * - 9988 (WEIGHT_OFFSET_ACCESS_CODE) → weight offset / manual entry controls
 */
function verifyAdvanceGate(pin) {
  const trimmed = String(pin || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Password is required' };
  }

  if (trimmed === engineeringAccessCode()) {
    const eng = verifyEngineeringPin(trimmed);
    if (!eng.ok) return eng;
    return { ok: true, mode: 'engineering', expiresAt: eng.expiresAt };
  }

  if (trimmed === weightOffsetAccessCode()) {
    const now = Date.now();
    adminSession = {
      operatorId: 'offset-access',
      name: 'Offset Access',
      role: 'admin',
      unlockedAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    engineeringSession = null;
    return {
      ok: true,
      mode: 'offset',
      expiresAt: adminSession.expiresAt,
    };
  }

  return { ok: false, error: 'Invalid password' };
}

function lockEngineeringConsole() {
  engineeringSession = null;
  return { ok: true };
}

function getEngineeringSession() {
  if (!isEngineeringSessionActive()) {
    return { active: false };
  }
  return {
    active: true,
    expiresAt: engineeringSession.expiresAt,
  };
}

function isManualHywaCloseSessionActive() {
  if (!manualHywaCloseSession) return false;
  if (Date.now() > manualHywaCloseSession.expiresAt) {
    manualHywaCloseSession = null;
    return false;
  }
  return true;
}

function verifyManualHywaPin(pin) {
  const trimmed = String(pin || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Passcode is required' };
  }
  if (trimmed !== manualHywaClosePin()) {
    return { ok: false, error: 'Invalid passcode' };
  }

  const now = Date.now();
  manualHywaCloseSession = {
    unlockedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };

  return {
    ok: true,
    expiresAt: manualHywaCloseSession.expiresAt,
  };
}

function lockManualHywaClose() {
  manualHywaCloseSession = null;
  return { ok: true };
}

function getManualHywaCloseSession() {
  if (!isManualHywaCloseSessionActive()) {
    return { active: false };
  }
  return {
    active: true,
    expiresAt: manualHywaCloseSession.expiresAt,
  };
}

function touchManualHywaCloseSession() {
  if (isManualHywaCloseSessionActive()) {
    manualHywaCloseSession.expiresAt = Date.now() + SESSION_TTL_MS;
  }
}

function assertAdminAccess() {
  if (!isAdminSessionActive()) {
    throw new Error('Admin session required — unlock Advance Setting first');
  }
  touchSession();
}

function assertManualHywaSectionAccess() {
  assertAdminAccess();
  if (!isManualHywaCloseSessionActive()) {
    throw new Error('Passcode required — unlock Manual HYWA section first');
  }
  touchManualHywaCloseSession();
}

function getSession() {
  if (!isAdminSessionActive()) {
    return { active: false };
  }
  return {
    active: true,
    operator: {
      id: adminSession.operatorId,
      name: adminSession.name,
      role: adminSession.role,
    },
    expiresAt: adminSession.expiresAt,
  };
}

function touchSession() {
  if (isAdminSessionActive()) {
    adminSession.expiresAt = Date.now() + SESSION_TTL_MS;
  }
}

module.exports = {
  verifyPin,
  verifyAdvanceGate,
  lockAdvanced,
  getSession,
  isAdminSessionActive,
  touchSession,
  verifyManualHywaPin,
  lockManualHywaClose,
  getManualHywaCloseSession,
  isManualHywaCloseSessionActive,
  touchManualHywaCloseSession,
  verifyEngineeringPin,
  lockEngineeringConsole,
  getEngineeringSession,
  isEngineeringSessionActive,
  ensureEngineeringAccessCodeInDb,
  ensureWeightOffsetAccessCodeInDb,
  assertAdminAccess,
  assertManualHywaSectionAccess,
};
