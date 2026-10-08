'use strict';

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

/**
 * Postgres connection.
 *
 * Supabase hands you two connection strings. Use the POOLER one (port 6543) —
 * a free Render instance opens a fresh connection on every cold start, and the
 * direct connection (5432) runs out of slots quickly under that pattern.
 *
 * Supabase terminates TLS with a certificate this driver cannot chain to a
 * local root, so verification is relaxed. The connection is still encrypted;
 * only the certificate-authority check is skipped.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy it from Supabase → Project Settings → Database.');
}

const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

pool.on('error', (err) => {
  // A pooled connection dropped while idle. node-postgres replaces it on the
  // next checkout; without this handler the unhandled 'error' kills the process.
  console.error('postgres idle client error:', err.message);
});

const query = (text, params) => pool.query(text, params);

/* ------------------------------------------------------------------ schema */

/**
 * Posters are stored as bytea rather than on disk or in object storage.
 * At the scale this site is built for (a handful of posters, a few hundred KB
 * each) that keeps everything in one backup, one connection string and one
 * free tier. Past roughly fifty posters, move them to Supabase Storage and
 * replace `poster_data` with a URL column.
 */
async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS admins (
      id            SERIAL PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS events (
      id            SERIAL PRIMARY KEY,
      title         TEXT NOT NULL,
      subtitle      TEXT NOT NULL DEFAULT '',
      description   TEXT NOT NULL DEFAULT '',
      event_date    DATE NOT NULL,
      start_time    TEXT NOT NULL DEFAULT '',
      end_time      TEXT NOT NULL DEFAULT '',
      mode          TEXT NOT NULL DEFAULT 'Zoom',
      venue         TEXT NOT NULL DEFAULT '',
      zoom_link     TEXT NOT NULL DEFAULT '',
      registration_link TEXT NOT NULL DEFAULT '',
      poster_data   BYTEA,
      poster_type   TEXT,
      poster_name   TEXT,
      topics        JSONB NOT NULL DEFAULT '[]'::jsonb,
      published     BOOLEAN NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Added after the first deploy, so CREATE TABLE alone would not reach an
    -- existing database. Idempotent: safe on every boot.
    ALTER TABLE events ADD COLUMN IF NOT EXISTS registration_link TEXT NOT NULL DEFAULT '';

    CREATE INDEX IF NOT EXISTS idx_events_date      ON events (event_date);
    CREATE INDEX IF NOT EXISTS idx_events_published ON events (published);
  `);
}

/**
 * ADMIN_USERNAME and ADMIN_PASSWORD are the only source of truth for the admin
 * login: changing either and restarting is how credentials are rotated. Any
 * account under another username is removed (a renamed admin used to leave the
 * old login working), and a change signs every session out, so nobody stays
 * signed in on the old credentials.
 */
async function ensureAdminUser() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'ethicraft@pict';

  const { rows } = await query('SELECT * FROM admins WHERE username = $1', [username]);
  const existing = rows[0];
  let changed = false;

  if (!existing) {
    await query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)',
      [username, bcrypt.hashSync(password, 12)]);
    changed = true;
  } else if (!bcrypt.compareSync(password, existing.password_hash)) {
    // Keep the stored hash in step if ADMIN_PASSWORD changes in the environment.
    await query('UPDATE admins SET password_hash = $1 WHERE id = $2',
      [bcrypt.hashSync(password, 12), existing.id]);
    changed = true;
  }

  const removed = await query('DELETE FROM admins WHERE username <> $1', [username]);
  if (changed || removed.rowCount) {
    // connect-pg-simple creates the sessions table on first use, so it may not exist yet.
    await query(`DO $$ BEGIN
      IF to_regclass('user_sessions') IS NOT NULL THEN DELETE FROM user_sessions; END IF;
    END $$`);
  }
}

/* ------------------------------------------------------------------ mapping */

/** A Date from pg back to the 'YYYY-MM-DD' the frontend expects. */
function toISODate(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/**
 * Turns a row into the shape the frontend expects. `poster_data` is never
 * included — the bytes are served by their own route so a list of events
 * doesn't drag megabytes of image through JSON.
 */
function rowToEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle || '',
    description: row.description || '',
    eventDate: toISODate(row.event_date),
    startTime: row.start_time || '',
    endTime: row.end_time || '',
    mode: row.mode,
    venue: row.venue || '',
    zoomLink: row.zoom_link || '',
    registrationLink: row.registration_link || '',
    // `has_poster` is computed in the SELECT so we never load the bytes to
    // answer "is there a poster?". The URL carries the row's last update:
    // posters are cached for a day, so a replaced poster needs a new URL or
    // browsers that saw the old one keep showing it.
    posterPath: row.has_poster ? `/posters/${row.id}?v=${new Date(row.updated_at).getTime()}` : '',
    topics: Array.isArray(row.topics) ? row.topics : [],
    published: Boolean(row.published),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Column list shared by every event SELECT: everything except the bytes. */
const EVENT_COLUMNS = `
  id, title, subtitle, description, event_date, start_time, end_time,
  mode, venue, zoom_link, registration_link, poster_type, poster_name, topics, published,
  created_at, updated_at, (poster_data IS NOT NULL) AS has_poster
`;

async function close() {
  await pool.end();
}

/**
 * A one-line reason for a failed start. Connecting to "localhost" tries IPv6
 * and IPv4, and when both are refused Node throws an AggregateError with an
 * empty message: startup used to print "Failed to start:" and nothing else.
 */
function describeError(err) {
  const reason = err?.message || err?.errors?.map((e) => e.message).join(', ') || String(err);
  return err?.code === 'ECONNREFUSED' ? `${reason} (is Postgres running?)` : reason;
}

module.exports = { pool, query, migrate, ensureAdminUser, rowToEvent, EVENT_COLUMNS, close, describeError };
