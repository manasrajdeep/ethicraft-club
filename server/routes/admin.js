'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  verifyCredentials,
  requireAuth,
  isLockedOut,
  recordFailure,
  clearFailures,
} = require('../auth');

const router = express.Router();

/**
 * Network-level brake on the login endpoint, layered under the per-IP attempt
 * counter in auth.js. This one caps total request volume; that one counts
 * failures and locks out after 8.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

// POST /api/admin/login { username, password }
router.post('/login', loginLimiter, async (req, res, next) => {
  if (isLockedOut(req)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const { username, password } = req.body || {};
  let admin;
  try {
    admin = await verifyCredentials(username, password);
  } catch (err) {
    return next(err);
  }

  if (!admin) {
    recordFailure(req);
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  clearFailures(req);
  // Rotate the session id on login so a pre-set cookie can't be reused.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    req.session.admin = admin;
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'Could not start session.' });
      res.json({ admin });
    });
  });
});

// POST /api/admin/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('ethicraft.sid');
    res.json({ ok: true });
  });
});

// GET /api/admin/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ admin: req.session.admin });
});

module.exports = router;
