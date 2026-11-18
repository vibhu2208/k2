'use strict';

require('dotenv').config();

const { Pool } = require('pg');

let pool = null;

function getConnectionString() {
  return (process.env.DATABASE_URL || process.env.PG_SYNC_URL || '').trim();
}

function isConfigured() {
  const url = getConnectionString();
  return !!url && !url.includes('YOUR_PASSWORD');
}

function stripSslModeFromUrl(url) {
  return String(url)
    .replace(/([?&])sslmode=[^&]*(&|$)/, (_, sep, tail) => (tail === '&' ? sep : ''))
    .replace(/\?&/, '?')
    .replace(/\?$/, '');
}

function getPool() {
  if (!isConfigured()) {
    throw new Error('DATABASE_URL is not configured');
  }
  if (!pool) {
    const isProd = process.env.NODE_ENV === 'production';
    const rejectUnauthorized =
      String(process.env.DB_SSL_REJECT_UNAUTHORIZED || (isProd ? 'true' : 'false'))
        .toLowerCase() === 'true';
    pool = new Pool({
      connectionString: stripSslModeFromUrl(getConnectionString()),
      ssl: { rejectUnauthorized },
      max: 8,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });
    if (isProd && !rejectUnauthorized) {
      console.warn(
        '[db] DB_SSL_REJECT_UNAUTHORIZED=false — TLS certificate verification is disabled',
      );
    }
    pool.on('error', (err) => {
      console.error('[db] pool error', err.message);
    });
  }
  return pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

function getSiteId() {
  return (process.env.SITE_ID || 'WB-03').trim().replace(/\s+/g, '');
}

module.exports = { query, getPool, isConfigured, getSiteId };
