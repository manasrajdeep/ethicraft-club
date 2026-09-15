'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

/**
 * Boots the real server as a child process against a throwaway database, so the
 * suite exercises the actual wiring (helmet, sessions, rate limits) rather than
 * a stubbed app object.
 */
// Each run gets a throwaway Postgres database so suites never see each other's
// rows and a failure leaves nothing behind.
const PG_ADMIN_URL = process.env.TEST_PG_URL || 'postgres://localhost:5432/postgres';
const psql = (sql, db = 'postgres') =>
  execSync(`psql "${PG_ADMIN_URL.replace(/\/[^/]*$/, `/${db}`)}" -v ON_ERROR_STOP=1 -c ${JSON.stringify(sql)}`,
    { stdio: 'pipe' });

async function startServer(env = {}) {
  const dbName = `ethicraft_test_${crypto.randomBytes(6).toString('hex')}`;
  psql(`CREATE DATABASE ${dbName}`);
  const databaseUrl = PG_ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
  const port = 3000 + Math.floor(Math.random() * 20000);

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      ADMIN_PATH: '/adminkrsna',
      ADMIN_USERNAME: 'harekrishna',
      ADMIN_PASSWORD: 'haribol108',
      SESSION_SECRET: 'test-secret-that-is-definitely-long-enough-000000',
      SITE_ORIGIN: 'https://ethicraft.in',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (Date.now() >= deadline) throw new Error(`server did not start:\n${log}`);

  return {
    base,
    getLog: () => log,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); });
      try {
        psql(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } catch { /* leave it; the name is unique per run */ }
    },
  };
}

/** Minimal cookie jar: express-session only ever sets the one cookie. */
function makeJar() {
  let cookie = '';
  return {
    get header() { return cookie ? { Cookie: cookie } : {}; },
    capture(res) {
      const raw = res.headers.getSetCookie?.() || [];
      for (const c of raw) {
        if (c.startsWith('ethicraft.sid')) cookie = c.split(';')[0];
      }
      return res;
    },
  };
}

async function login(base, jar, username = 'harekrishna', password = 'haribol108') {
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  jar.capture(res);
  return res;
}

/** Builds a multipart body with an optional in-memory image file. */
function formData(fields = {}, file = null) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  if (file) {
    fd.append('poster', new Blob([file.buffer], { type: file.type }), file.name);
  }
  return fd;
}

// Smallest valid files of each type, so uploads are exercised without fixtures.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const JPEG_MIN = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64');

module.exports = { startServer, makeJar, login, formData, PNG_1PX, JPEG_MIN, ROOT };
