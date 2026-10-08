'use strict';

/**
 * Checks shared by the event, calendar and gallery routes. These are the gate;
 * the admin page's own checks are only a convenience.
 */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A real calendar date in YYYY-MM-DD form. The shape alone is not enough:
 * '2026-02-30' matches it, and Postgres then rejects the write with a 500.
 */
function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Ids arrive from the URL; reject anything that isn't a plain integer in
 * Postgres's INTEGER range, which would otherwise surface as a 500.
 */
function parseId(raw) {
  if (!/^\d{1,10}$/.test(String(raw))) return null;
  const id = Number(raw);
  return id <= 2147483647 ? id : null;
}

module.exports = { TIME_RE, isRealDate, isHttpUrl, parseId };
