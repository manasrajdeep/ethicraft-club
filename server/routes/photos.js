'use strict';

const express = require('express');
const multer = require('multer');

const { pool, query, rowToPhoto, PHOTO_COLUMNS } = require('../db');
const { requireAuth } = require('../auth');
const { parseId } = require('../validate');

const router = express.Router();

/* ------------------------------------------------------------------ uploads */

/**
 * The admin page resizes every photo in the browser before it is sent: a JPEG
 * of at most 1440px for the lightbox and 720px for the grid and the strip. So
 * only JPEGs are accepted, and far below a phone camera's file size.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'image/jpeg') return cb(null, true);
    cb(new Error('Only JPG images are allowed in the gallery.'));
  },
});

/**
 * Width and height from a JPEG's frame header, or null when the bytes are not
 * a JPEG at all. Reading the bytes, not the declared type, keeps anything that
 * is not an image out, and the size never has to be trusted from the browser.
 */
function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }                     // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    // SOF0-SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const isTrue = (value) => ['1', 'true', 'on', 'yes', true].includes(value);
const cleanCaption = (value) => String(value ?? '').trim().slice(0, 160);

/* ------------------------------------------------------------- public routes */

// GET /api/photos: every photo, in gallery order. The strip shows the ones
// flagged `inStrip`.
router.get('/api/photos', async (_req, res, next) => {
  try {
    const { rows } = await query(`SELECT ${PHOTO_COLUMNS} FROM photos ORDER BY sort_order, id`);
    res.json({ photos: rows.map(rowToPhoto) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /photos/:id and /photos/:id/thumb. The bytes never change, and the URLs
 * the API hands out carry a version, so those are cached for a year. A bare
 * URL without one still revalidates.
 */
function servePhoto(column) {
  return async (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).end();
    try {
      const { rows } = await query(`SELECT ${column} AS data, created_at FROM photos WHERE id = $1`, [id]);
      if (!rows[0]) return res.status(404).end();

      const etag = `"g${id}${column === 'thumb_data' ? 't' : ''}-${new Date(rows[0].created_at).getTime()}"`;
      res.set({
        'Content-Type': 'image/jpeg',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache',
        ETag: etag,
      });
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.send(rows[0].data);
    } catch (err) {
      next(err);
    }
  };
}

router.get('/photos/:id', servePhoto('image_data'));
router.get('/photos/:id/thumb', servePhoto('thumb_data'));

/* -------------------------------------------------------------- admin routes */

// POST /api/admin/photos: multipart with `photo` (lightbox size) and `thumb`,
// plus optional `caption` and `inStrip`. New photos go to the front.
router.post('/api/admin/photos', requireAuth,
  upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]),
  async (req, res, next) => {
    const photo = req.files?.photo?.[0];
    const thumb = req.files?.thumb?.[0];
    const size = jpegSize(photo?.buffer);
    const errors = [];
    if (!size) errors.push('A JPG photo is required.');
    if (!jpegSize(thumb?.buffer)) errors.push('A JPG thumbnail is required.');
    if (errors.length) return res.status(400).json({ errors });

    try {
      const { rows } = await query(`
        INSERT INTO photos (caption, in_strip, sort_order, width, height, image_data, thumb_data)
        VALUES ($1, $2, (SELECT COALESCE(MIN(sort_order), 1) - 1 FROM photos), $3, $4, $5, $6)
        RETURNING ${PHOTO_COLUMNS}`,
      [cleanCaption(req.body.caption), isTrue(req.body.inStrip), size.width, size.height,
        photo.buffer, thumb.buffer]);
      res.status(201).json({ photo: rowToPhoto(rows[0]) });
    } catch (err) {
      next(err);
    }
  });

// PATCH /api/admin/photos/:id  { caption?, inStrip?, move?: 'up' | 'down' }
router.patch('/api/admin/photos/:id', requireAuth, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Photo not found' });
  const { caption, inStrip, move } = req.body || {};
  if (move !== undefined && move !== 'up' && move !== 'down') {
    return res.status(400).json({ errors: ['move must be "up" or "down".'] });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the whole order, so two quick moves cannot interleave.
    const { rows: order } = await client.query('SELECT id FROM photos ORDER BY sort_order, id FOR UPDATE');
    const ids = order.map((row) => row.id);
    const at = ids.indexOf(id);
    if (at === -1) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Photo not found' });
    }

    if (caption !== undefined || inStrip !== undefined) {
      await client.query(`
        UPDATE photos SET caption = COALESCE($1, caption), in_strip = COALESCE($2, in_strip),
                          updated_at = now()
         WHERE id = $3`,
      [caption === undefined ? null : cleanCaption(caption),
        inStrip === undefined ? null : isTrue(inStrip), id]);
    }

    const to = move === 'up' ? at - 1 : move === 'down' ? at + 1 : at;
    if (to !== at && to >= 0 && to < ids.length) {
      [ids[at], ids[to]] = [ids[to], ids[at]];
      // Renumber everything 1..n, so ties in sort_order can never stall a move.
      await client.query(`
        UPDATE photos AS p SET sort_order = o.pos
          FROM unnest($1::int[]) WITH ORDINALITY AS o(id, pos)
         WHERE p.id = o.id`, [ids]);
    }

    const { rows } = await client.query(`SELECT ${PHOTO_COLUMNS} FROM photos WHERE id = $1`, [id]);
    await client.query('COMMIT');
    res.json({ photo: rowToPhoto(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/admin/photos/:id
router.delete('/api/admin/photos/:id', requireAuth, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Photo not found' });
  try {
    const { rowCount } = await query('DELETE FROM photos WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Photo not found' });
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, jpegSize };
