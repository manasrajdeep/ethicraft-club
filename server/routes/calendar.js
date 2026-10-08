'use strict';

const express = require('express');

const { query, rowToEntry } = require('../db');
const { requireAuth } = require('../auth');
const { TIME_RE, isRealDate, isHttpUrl, parseId } = require('../validate');

const router = express.Router();

const ENTRY_COLUMNS = 'id, title, start_date, end_date, start_time, end_time, label, details, link';

const text = (value) => String(value ?? '').trim();

/** Validates a calendar entry. Returns { data } or { errors: [...] }. */
function validateEntry(body = {}) {
  const errors = [];

  const title = text(body.title);
  if (!title) errors.push('Title is required.');
  else if (title.length > 160) errors.push('Title must be 160 characters or fewer.');

  const startDate = text(body.startDate);
  const endDate = text(body.endDate);
  if (!isRealDate(startDate)) errors.push('Date must be in YYYY-MM-DD format.');
  if (endDate && !isRealDate(endDate)) errors.push('End date must be in YYYY-MM-DD format.');
  else if (endDate && endDate < startDate) errors.push('End date must be on or after the start date.');

  const startTime = text(body.startTime);
  const endTime = text(body.endTime);
  if (startTime && !TIME_RE.test(startTime)) errors.push('Start time must be in HH:MM (24 hour) format.');
  if (endTime && !TIME_RE.test(endTime)) errors.push('End time must be in HH:MM (24 hour) format.');
  const oneDay = !endDate || endDate === startDate;
  if (oneDay && TIME_RE.test(startTime) && TIME_RE.test(endTime) && endTime <= startTime) {
    errors.push('End time must be after start time.');
  }

  const link = text(body.link);
  if (link && !isHttpUrl(link)) errors.push('Link must be a valid http(s) URL.');

  if (errors.length) return { errors };
  return {
    data: {
      title,
      start_date: startDate,
      end_date: oneDay ? null : endDate,
      start_time: startTime,
      end_time: endTime,
      label: text(body.label).slice(0, 60),
      details: text(body.details).slice(0, 1000),
      link,
    },
  };
}

// GET /api/calendar: the whole schedule, earliest first. The page groups it
// by academic year and month.
router.get('/api/calendar', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${ENTRY_COLUMNS} FROM calendar_entries ORDER BY start_date, start_time, id`);
    res.json({ entries: rows.map(rowToEntry) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/calendar
router.post('/api/admin/calendar', requireAuth, async (req, res, next) => {
  const { data, errors } = validateEntry(req.body);
  if (errors) return res.status(400).json({ errors });
  try {
    const cols = Object.keys(data);
    const { rows } = await query(`
      INSERT INTO calendar_entries (${cols.join(', ')})
      VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
      RETURNING ${ENTRY_COLUMNS}`, cols.map((c) => data[c]));
    res.status(201).json({ entry: rowToEntry(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/calendar/:id: replaces the entry, as the form sends every field.
router.put('/api/admin/calendar/:id', requireAuth, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Entry not found' });
  const { data, errors } = validateEntry(req.body);
  if (errors) return res.status(400).json({ errors });
  try {
    const cols = Object.keys(data);
    const { rows } = await query(`
      UPDATE calendar_entries
         SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now()
       WHERE id = $${cols.length + 1}
      RETURNING ${ENTRY_COLUMNS}`, [...cols.map((c) => data[c]), id]);
    if (!rows[0]) return res.status(404).json({ error: 'Entry not found' });
    res.json({ entry: rowToEntry(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/calendar/:id
router.delete('/api/admin/calendar/:id', requireAuth, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Entry not found' });
  try {
    const { rowCount } = await query('DELETE FROM calendar_entries WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Entry not found' });
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
