'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const PgSession = require('connect-pg-simple')(session);

const { pool, query, migrate, ensureAdminUser, close } = require('./db');
const { requireAuthPage } = require('./auth');
const adminRoutes = require('./routes/admin');
const { router: eventRoutes } = require('./routes/events');
const { seedIfEmpty } = require('../scripts/seed');
const { buildSitemap, buildRobots } = require('./seo');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const SITE_ORIGIN = (process.env.SITE_ORIGIN || `http://localhost:${PORT}`).replace(/\/$/, '');

// The dashboard path is configurable so it can be moved without a code change.
// Normalised to a single leading slash and no trailing slash.
const ADMIN_PATH = `/${(process.env.ADMIN_PATH || '/admin').replace(/^\/+|\/+$/g, '')}`;
const LOGIN_PATH = `${ADMIN_PATH}/login`;

// `public/` holds only static assets and is served wholesale. HTML pages live
// in `views/`, which is NOT statically served - otherwise GET /admin.html would
// hand out the dashboard shell past the auth guard.
const VIEWS_DIR = path.join(__dirname, '..', 'views');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/* --------------------------------------------------------- startup checks */

if (IS_PROD) {
  const problems = [];
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    problems.push('SESSION_SECRET must be set to at least 32 characters.');
  }
  if (/change|dev-only|example/i.test(process.env.SESSION_SECRET || '')) {
    problems.push('SESSION_SECRET is still a placeholder value.');
  }
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 8) {
    problems.push('ADMIN_PASSWORD must be set to at least 8 characters.');
  }
  if (!process.env.DATABASE_URL) {
    problems.push('DATABASE_URL must point at your Supabase Postgres database.');
  }
  if (problems.length) {
    console.error('\n  Refusing to start in production:\n');
    problems.forEach((p) => console.error(`    - ${p}`));
    console.error('');
    process.exit(1);
  }
}

app.set('trust proxy', 1);   // correct req.ip + Secure cookies behind nginx
app.disable('x-powered-by');
app.set('etag', 'strong');

/* ------------------------------------------------------------ middleware */

app.use(compression());

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Tailwind's Play CDN compiles at runtime, so it needs eval. Swapping to
      // a build step (see README) lets both unsafe-* directives be dropped.
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdn.tailwindcss.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: IS_PROD ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use(session({
  name: 'ethicraft.sid',
  // Sessions live in Postgres, not memory: a free instance restarts whenever it
  // wakes from idle, and an in-memory store would sign the admin out each time.
  store: new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
    pruneSessionInterval: 15 * 60,
  }),
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 1000 * 60 * 60 * 8,
  },
}));

// Blanket limit on the API. The login route adds a stricter one of its own.
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
}));

/* ------------------------------------------------------------------ pages */

app.get('/', (_req, res) => res.sendFile(path.join(VIEWS_DIR, 'index.html')));

app.get(LOGIN_PATH, (req, res) => {
  if (req.session?.admin) return res.redirect(ADMIN_PATH);
  res.sendFile(path.join(VIEWS_DIR, 'login.html'));
});
app.get(ADMIN_PATH, requireAuthPage(LOGIN_PATH), (_req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'admin.html'));
});

// Tells the login and dashboard pages where to post without hardcoding the path.
app.get('/api/config', (_req, res) => {
  res.json({ adminPath: ADMIN_PATH, loginPath: LOGIN_PATH });
});

/* -------------------------------------------------------------------- seo */

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(buildRobots({ origin: SITE_ORIGIN, adminPath: ADMIN_PATH }));
});

app.get('/sitemap.xml', async (_req, res, next) => {
  try {
    res.type('application/xml').send(await buildSitemap({ origin: SITE_ORIGIN }));
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------- health/api */

// Also the endpoint an uptime pinger should hit: the SELECT keeps the Supabase
// project from pausing after 7 days of no database activity.
app.get('/healthz', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, uptime: Math.round(process.uptime()) });
  } catch {
    res.status(503).json({ ok: false, error: 'database unavailable' });
  }
});

app.use('/api/admin', adminRoutes);
app.use('/api', eventRoutes);
// Poster bytes are served from Postgres, outside /api so they stay cacheable
// and are not swept up by the API rate limiter.
app.use('/', eventRoutes);

/* ---------------------------------------------------------------- statics */

// Cache hard in production; never in development, so a CSS tweak actually shows
// up on reload instead of being served from disk cache.
app.use(express.static(PUBLIC_DIR, IS_PROD
  ? { maxAge: '7d' }
  : { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));

/* --------------------------------------------------------------- errors */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(VIEWS_DIR, '404.html'));
});

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature.
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Poster must be 6 MB or smaller.'
      : `Upload failed: ${err.message}`;
    return res.status(400).json({ errors: [message] });
  }
  if (err?.message?.includes('images are allowed')) {
    return res.status(400).json({ errors: [err.message] });
  }

  // body-parser rejections are client errors, not server faults. Without this
  // they fall through below and answer 413/400 conditions with a 500 plus a
  // stack trace in the logs on every oversized or malformed request.
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ errors: ['Request body is too large.'] });
  }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ errors: ['Request body is not valid JSON.'] });
  }
  if (err?.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ errors: [err.message || 'Bad request.'] });
  }

  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

/* --------------------------------------------------------------- listen */

let server;

/**
 * Schema and seed run before the port opens, so the first request can never
 * arrive at a half-built database. Both are idempotent — safe on every boot.
 */
async function start() {
  await migrate();
  await ensureAdminUser();
  await seedIfEmpty();

  server = app.listen(PORT, () => {
    console.log(`\n  EthiCraft Club — ${IS_PROD ? 'production' : 'development'}`);
    console.log(`  Public site  →  ${IS_PROD ? SITE_ORIGIN : `http://localhost:${PORT}`}`);
    console.log(`  Admin portal →  http://localhost:${PORT}${ADMIN_PATH}\n`);
  });

  // Let in-flight requests finish before the process dies, so a redeploy never
  // cuts off a poster upload mid-write.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`\n  ${signal} received — shutting down gracefully…`);
      server.close(async () => {
        try { await close(); } catch { /* pool already closed */ }
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    });
  }
}

start().catch((err) => {
  console.error('\n  Failed to start:', err.message, '\n');
  process.exit(1);
});

module.exports = { app, ADMIN_PATH, LOGIN_PATH };
