'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('./db');

const PLACEHOLDER_SECRET = 'change-me-in-production';

function resolveJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  const isProd = process.env.NODE_ENV === 'production';
  if (!secret || secret === PLACEHOLDER_SECRET) {
    if (isProd) {
      throw new Error(
        'JWT_SECRET must be set to a strong non-default value in production',
      );
    }
    console.warn(
      '[auth] JWT_SECRET is missing or still the placeholder — set a strong secret before deploying',
    );
    return PLACEHOLDER_SECRET;
  }
  if (secret.length < 24) {
    if (isProd) {
      throw new Error('JWT_SECRET must be at least 24 characters in production');
    }
    console.warn('[auth] JWT_SECRET is short; use at least 24 characters');
  }
  return secret;
}

const JWT_SECRET = () => resolveJwtSecret();
const JWT_EXPIRY = process.env.JWT_EXPIRY || '12h';

async function findUserByEmail(email) {
  const res = await query(
    'SELECT id, email, password_hash, role FROM admin_users WHERE email = $1 LIMIT 1',
    [String(email).trim().toLowerCase()],
  );
  return res.rows[0] || null;
}

async function verifyLogin(email, password) {
  const user = await findUserByEmail(email);
  if (!user) return { ok: false, error: 'Invalid email or password' };
  const match = await bcrypt.compare(String(password), user.password_hash);
  if (!match) return { ok: false, error: 'Invalid email or password' };
  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    JWT_SECRET(),
    { expiresIn: JWT_EXPIRY, algorithm: 'HS256' },
  );
  return {
    ok: true,
    token,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Authentication required' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET(), { algorithms: ['HS256'] });
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  const allowed = roles.map((r) => String(r).toLowerCase());
  return (req, res, next) => {
    const role = String(req.user?.role || '').toLowerCase();
    if (!allowed.length || allowed.includes(role)) return next();
    return res.status(403).json({ ok: false, error: 'Insufficient permissions' });
  };
}

async function bootstrapAdminUser() {
  const email = (process.env.ADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD || '';
  if (!email || !password) return;

  if (password.length < 10) {
    console.warn('[auth] ADMIN_BOOTSTRAP_PASSWORD is short; use at least 10 characters');
  }

  const existing = await query('SELECT COUNT(*) AS c FROM admin_users');
  if (Number(existing.rows[0].c) > 0) return;

  const hash = await bcrypt.hash(password, 10);
  await query(
    'INSERT INTO admin_users (email, password_hash, role) VALUES ($1, $2, $3)',
    [email, hash, 'admin'],
  );
  console.log('[auth] Bootstrap admin user created:', email);
}

module.exports = {
  verifyLogin,
  authMiddleware,
  requireRole,
  bootstrapAdminUser,
  resolveJwtSecret,
};
