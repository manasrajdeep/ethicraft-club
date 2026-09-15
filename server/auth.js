'use strict';

const bcrypt = require('bcryptjs');
const { query } = require('./db');

/**
 * Per-IP failure counter, layered under the rate limiter in routes/admin.js.
 * In-memory by design: a free instance restarts often, and losing the counter
 * on restart is acceptable because the network-level limiter still applies.
 */
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map();

function attemptKey(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function isLockedOut(req) {
  const record = attempts.get(attemptKey(req));
  if (!record) return false;
  if (Date.now() - record.first > LOCKOUT_MS) {
    attempts.delete(attemptKey(req));
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordFailure(req) {
  const key = attemptKey(req);
  const record = attempts.get(key);
  if (!record || Date.now() - record.first > LOCKOUT_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    record.count += 1;
  }
}

function clearFailures(req) {
  attempts.delete(attemptKey(req));
}

// A valid-shaped hash for a user that doesn't exist, so a missing username and
// a wrong password cost the same amount of time.
const DUMMY_HASH = '$2a$12$abcdefghijklmnopqrstuuKq6Qm4TQKFNJLzsPBFEFNVMuVxvZMS';

async function verifyCredentials(username, password) {
  if (!username || !password) return null;
  const { rows } = await query('SELECT * FROM admins WHERE username = $1', [username]);
  const admin = rows[0];
  const ok = bcrypt.compareSync(password, admin ? admin.password_hash : DUMMY_HASH);
  return admin && ok ? { id: admin.id, username: admin.username } : null;
}

/** Blocks API routes: responds 401 JSON. */
function requireAuth(req, res, next) {
  if (req.session?.admin) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

/** Blocks page routes: redirects to the login screen. */
function requireAuthPage(loginPath) {
  return (req, res, next) => {
    if (req.session?.admin) return next();
    return res.redirect(loginPath);
  };
}

module.exports = {
  verifyCredentials, requireAuth, requireAuthPage,
  isLockedOut, recordFailure, clearFailures,
};
