'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { query, migrate, ensureAdminUser, close } = require('../server/db');

const SEED_POSTER = path.join(__dirname, '..', 'assets-seed', 'alumni-tales.jpg');

/**
 * The launch event, as printed on the club poster. Inserted only when the
 * events table is empty, so a restart never duplicates it or overwrites edits
 * made through the admin portal.
 */
const INITIAL_EVENTS = [
  {
    title: 'From Then to Now: Alumni Tales',
    subtitle: 'Same Campus. New Perspectives.',
    description:
      'Real stories, valuable lessons, a brighter tomorrow. Our alumni return to share their '
      + 'experiences, insights and advice for the journey ahead — followed by an open Q&A session.',
    event_date: '2026-09-16',
    start_time: '19:30',
    end_time: '20:30',
    mode: 'Zoom',
    venue: '',
    zoom_link: 'https://zoom.us/j/0000000000',
    registration_link: 'https://tinyurl.com/ethicraftpict',
    topics: JSON.stringify(['Placements', 'Campus Life', "Role of AI in today's World"]),
    published: true,
  },
];

async function seedIfEmpty() {
  const { rows } = await query('SELECT COUNT(*)::int AS count FROM events');
  if (rows[0].count > 0) return false;

  const poster = fs.existsSync(SEED_POSTER) ? fs.readFileSync(SEED_POSTER) : null;

  for (const event of INITIAL_EVENTS) {
    await query(`
      INSERT INTO events
        (title, subtitle, description, event_date, start_time, end_time,
         mode, venue, zoom_link, registration_link, topics, published,
         poster_data, poster_type, poster_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    `, [
      event.title, event.subtitle, event.description, event.event_date,
      event.start_time, event.end_time, event.mode, event.venue, event.zoom_link,
      event.registration_link, event.topics, event.published,
      poster, poster ? 'image/jpeg' : null, poster ? 'alumni-tales.jpg' : null,
    ]);
  }
  return true;
}

/**
 * The launch event was already seeded before registration links existed, so the
 * live row has an empty link that seedIfEmpty will never revisit. Fill it in
 * once, and only while it is still blank, so an admin edit is never overwritten.
 */
async function backfillRegistrationLink() {
  const { rowCount } = await query(
    `UPDATE events SET registration_link = $1
      WHERE title = $2 AND (registration_link IS NULL OR registration_link = '')`,
    ['https://tinyurl.com/ethicraftpict', 'From Then to Now: Alumni Tales']);
  return rowCount;
}

module.exports = { seedIfEmpty, backfillRegistrationLink, INITIAL_EVENTS };

// `npm run seed` runs this file directly.
if (require.main === module) {
  (async () => {
    await migrate();
    await ensureAdminUser();
    const seeded = await seedIfEmpty();
    console.log(seeded
      ? `Seeded ${INITIAL_EVENTS.length} event(s) and the admin account.`
      : 'Events table already has rows — nothing seeded.');
    console.log(`Admin username: ${process.env.ADMIN_USERNAME || 'admin'}`);
    await close();
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
