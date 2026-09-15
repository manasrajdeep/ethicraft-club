'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');

const { query, rowToEvent, EVENT_COLUMNS } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

/* ------------------------------------------------------------------ uploads */

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * Posters are held in memory just long enough to write them into Postgres.
 * Nothing touches the filesystem — a free Render instance wipes its disk on
 * every restart, so anything written there would not survive the afternoon.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPG, PNG, WebP or GIF images are allowed.'));
  },
});

/* ------------------------------------------------------------------ helpers */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MODES = new Set(['Zoom', 'Offline', 'Hybrid']);

function parseTopics(raw) {
  if (Array.isArray(raw)) return raw.map(String).map((t) => t.trim()).filter(Boolean);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String).map((t) => t.trim()).filter(Boolean);
    } catch { /* fall through to comma splitting */ }
  }
  return trimmed.split(',').map((t) => t.trim()).filter(Boolean);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validates the multipart body. Returns { data } or { errors: [...] }. */
function validateEventBody(body, { partial = false } = {}) {
  const errors = [];
  const data = {};

  if (!partial || body.title !== undefined) {
    const title = (body.title ?? '').trim();
    if (!title) errors.push('Title is required.');
    else if (title.length > 160) errors.push('Title must be 160 characters or fewer.');
    else data.title = title;
  }

  if (!partial || body.eventDate !== undefined) {
    const eventDate = (body.eventDate ?? '').trim();
    if (!DATE_RE.test(eventDate)) errors.push('Date must be in YYYY-MM-DD format.');
    else data.event_date = eventDate;
  }

  for (const [field, column] of [['startTime', 'start_time'], ['endTime', 'end_time']]) {
    if (body[field] !== undefined) {
      const value = (body[field] || '').trim();
      if (value && !TIME_RE.test(value)) errors.push(`${field} must be in HH:MM (24 hour) format.`);
      else data[column] = value;
    }
  }
  if (data.start_time && data.end_time && data.end_time <= data.start_time) {
    errors.push('End time must be after start time.');
  }

  if (!partial || body.mode !== undefined) {
    const mode = (body.mode || 'Zoom').trim();
    if (!MODES.has(mode)) errors.push('Mode must be Zoom, Offline or Hybrid.');
    else data.mode = mode;
  }

  if (body.zoomLink !== undefined) {
    const link = (body.zoomLink || '').trim();
    if (link && !isHttpUrl(link)) errors.push('Meeting link must be a valid http(s) URL.');
    else data.zoom_link = link;
  }

  if (body.registrationLink !== undefined) {
    const link = (body.registrationLink || '').trim();
    if (link && !isHttpUrl(link)) errors.push('Registration link must be a valid http(s) URL.');
    else data.registration_link = link;
  }

  if (body.subtitle !== undefined) data.subtitle = (body.subtitle || '').trim().slice(0, 240);
  if (body.description !== undefined) data.description = (body.description || '').trim().slice(0, 4000);
  if (body.venue !== undefined) data.venue = (body.venue || '').trim().slice(0, 240);
  if (body.topics !== undefined) data.topics = JSON.stringify(parseTopics(body.topics));
  if (body.published !== undefined) {
    data.published = ['1', 'true', 'on', 'yes', true].includes(body.published);
  }

  // A field that was never submitted is undefined, not '' — normalise before
  // deciding whether a published Zoom event has somewhere to send people.
  const effectiveMode = data.mode ?? body.mode;
  const effectiveLink = data.zoom_link ?? '';
  if (data.published === true && effectiveMode === 'Zoom' && !effectiveLink) {
    errors.push('A published Zoom event needs a meeting link.');
  }

  return errors.length ? { errors } : { data };
}

/** Builds a parameterised INSERT/UPDATE from a column->value map. */
function buildInsert(table, data) {
  const cols = Object.keys(data);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  return {
    text: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
    values: cols.map((c) => data[c]),
  };
}

function buildUpdate(table, data, id) {
  const cols = Object.keys(data);
  const sets = cols.map((c, i) => `${c} = $${i + 1}`);
  return {
    text: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${cols.length + 1}`,
    values: [...cols.map((c) => data[c]), id],
  };
}

const fetchEvent = async (id) => {
  const { rows } = await query(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1`, [id]);
  return rows[0] || null;
};

/** Ids arrive from the URL; reject anything that isn't a plain integer. */
function parseId(raw) {
  return /^\d+$/.test(String(raw)) ? Number(raw) : null;
}

/* -------------------------------------------------------------- poster bytes */

// GET /posters/:id — public, cacheable, streamed straight from Postgres.
router.get('/posters/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).end();

  try {
    const { rows } = await query(
      'SELECT poster_data, poster_type, updated_at FROM events WHERE id = $1 AND poster_data IS NOT NULL',
      [id]);
    const row = rows[0];
    if (!row) return res.status(404).end();

    // Cheap revalidation: the poster only changes when the row does.
    const etag = `"p${id}-${new Date(row.updated_at).getTime()}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    res.setHeader('Content-Type', row.poster_type || 'image/jpeg');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('ETag', etag);
    res.send(row.poster_data);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------ public routes */

// GET /api/events?scope=upcoming|past|all
router.get('/events', async (req, res, next) => {
  const scope = String(req.query.scope || 'all').toLowerCase();
  try {
    let sql = `SELECT ${EVENT_COLUMNS} FROM events WHERE published = true`;
    if (scope === 'upcoming') {
      sql += ' AND event_date >= CURRENT_DATE ORDER BY event_date ASC, start_time ASC';
    } else if (scope === 'past') {
      sql += ' AND event_date < CURRENT_DATE ORDER BY event_date DESC, start_time DESC';
    } else {
      sql += ' ORDER BY event_date DESC, start_time DESC';
    }
    const { rows } = await query(sql);
    res.json({ events: rows.map(rowToEvent) });
  } catch (err) {
    next(err);
  }
});

// GET /api/events/:id
router.get('/events/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Event not found' });
  try {
    const { rows } = await query(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1 AND published = true`, [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Event not found' });
    res.json({ event: rowToEvent(rows[0]) });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------- admin routes */

router.get('/admin/events', requireAuth, async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${EVENT_COLUMNS} FROM events ORDER BY event_date DESC, start_time DESC`);
    res.json({ events: rows.map(rowToEvent) });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/events/:id', requireAuth, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Event not found' });
  try {
    const row = await fetchEvent(id);
    if (!row) return res.status(404).json({ error: 'Event not found' });
    res.json({ event: rowToEvent(row) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/events — multipart/form-data, optional `poster` file
router.post('/admin/events', requireAuth, upload.single('poster'), async (req, res, next) => {
  const { data, errors } = validateEventBody(req.body);
  if (errors) return res.status(400).json({ errors });

  if (req.file) {
    data.poster_data = req.file.buffer;
    data.poster_type = req.file.mimetype;
    data.poster_name = req.file.originalname?.slice(0, 200) || null;
  }

  try {
    const { text, values } = buildInsert('events', data);
    const { rows } = await query(text, values);
    res.status(201).json({ event: rowToEvent(await fetchEvent(rows[0].id)) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/events/:id
router.put('/admin/events/:id', requireAuth, upload.single('poster'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Event not found' });

  try {
    const existing = await fetchEvent(id);
    if (!existing) return res.status(404).json({ error: 'Event not found' });

    // Merge with the stored row so cross-field checks (times, zoom link) see
    // the real end state, not just the fields that happened to be submitted.
    const merged = {
      title: existing.title,
      eventDate: existing.event_date,
      startTime: existing.start_time,
      endTime: existing.end_time,
      mode: existing.mode,
      zoomLink: existing.zoom_link,
      registrationLink: existing.registration_link,
      ...req.body,
    };
    if (merged.eventDate instanceof Date) {
      merged.eventDate = merged.eventDate.toISOString().slice(0, 10);
    }

    const { data, errors } = validateEventBody(merged);
    if (errors) return res.status(400).json({ errors });

    if (req.file) {
      data.poster_data = req.file.buffer;
      data.poster_type = req.file.mimetype;
      data.poster_name = req.file.originalname?.slice(0, 200) || null;
    } else if (req.body.removePoster === '1') {
      data.poster_data = null;
      data.poster_type = null;
      data.poster_name = null;
    }
    data.updated_at = new Date();

    const { text, values } = buildUpdate('events', data, id);
    await query(text, values);
    res.json({ event: rowToEvent(await fetchEvent(id)) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/events/:id/publish  { published: true|false }
router.patch('/admin/events/:id/publish', requireAuth, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Event not found' });

  try {
    const existing = await fetchEvent(id);
    if (!existing) return res.status(404).json({ error: 'Event not found' });

    const publish = req.body.published === true || req.body.published === 'true';
    if (publish && existing.mode === 'Zoom' && !existing.zoom_link) {
      return res.status(400).json({ errors: ['A published Zoom event needs a meeting link.'] });
    }

    await query('UPDATE events SET published = $1, updated_at = now() WHERE id = $2', [publish, id]);
    res.json({ event: rowToEvent(await fetchEvent(id)) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/events/:id
router.delete('/admin/events/:id', requireAuth, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Event not found' });
  try {
    const { rowCount } = await query('DELETE FROM events WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Event not found' });
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, upload };
