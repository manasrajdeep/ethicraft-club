'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool, query, migrate, ensureAdminUser, close, describeError } = require('../server/db');

const SEED_POSTER = path.join(__dirname, '..', 'assets-seed', 'alumni-tales.jpg');
const SEED_GALLERY = path.join(__dirname, '..', 'assets-seed', 'gallery');

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

/**
 * Runs `fill` once per database, ever. The marker and the content go in one
 * transaction, so a failed fill is retried on the next boot, and once the club
 * team deletes the starter content it stays deleted across restarts.
 */
async function once(key, fill) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      'INSERT INTO app_meta (key, value) VALUES ($1, now()::text) ON CONFLICT (key) DO NOTHING', [key]);
    if (rowCount) await fill(client);
    await client.query('COMMIT');
    return rowCount > 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The best of the club's shared album, picked and resized ahead of time. */
function seedGallery() {
  return once('gallery_seeded', async (client) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(SEED_GALLERY, 'manifest.json'), 'utf8'));
    for (const [i, photo] of manifest.entries()) {
      await client.query(`
        INSERT INTO photos (caption, in_strip, sort_order, width, height, image_data, thumb_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [photo.caption, photo.inStrip, i + 1, photo.width, photo.height,
        fs.readFileSync(path.join(SEED_GALLERY, photo.file)),
        fs.readFileSync(path.join(SEED_GALLERY, photo.thumb))]);
    }
  });
}

/**
 * The FY Life & Tech Upgrade schedule, as printed on the programme's poster.
 * Every session runs 5.15 pm to 6.15 pm IST.
 */
const ALL_DIVISIONS = 'Open to all divisions, FY1 – FY13.';
const IIT_KGP = 'Live online session by IIT Kharagpur faculty.';
const CALENDAR_SEED = [
  ['2026-10-12', 'Discover the Game of Life', 'Wisdom Track', 'Divisions FY1, 3, 4, 5, 7, 10, 11, 12, 13.'],
  ['2026-10-13', 'Discover the Inner Self', 'Wisdom Track', 'Divisions FY1, 2, 3, 4, 5, 8, 9, 10, 11.'],
  ['2026-10-14', 'Discover the Ultimate Genius', 'Wisdom Track', 'Divisions FY1, 2, 5, 6, 7, 8, 9, 10, 13.'],
  ['2026-10-15', 'Discover the Manual of Life', 'Wisdom Track', 'Divisions FY1, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13.'],
  ['2026-10-16', 'Discover the Lasting Solution', 'Wisdom Track', 'Divisions FY2, 4, 6, 7, 8, 9, 10, 11, 12, 13.'],
  ['2026-10-17', 'Discover Sublime Joy through Sound', 'Wisdom Track', ALL_DIVISIONS],
  ['2026-10-18', 'Discover Real Eternal Love', 'Wisdom Track', ALL_DIVISIONS],
  ['2026-10-19', 'Wisdom Q&A and Reflection', 'Wisdom Track', 'Divisions FY1, 3, 4, 5, 7, 10, 11, 12, 13.'],
  ['2026-10-20', 'No session (buffer day)', 'Wisdom Track', '', true],
  ['2026-10-21', 'Group Discussion & Life Skills', 'Wisdom Track', 'Divisions FY1, 2, 5, 6, 7, 8, 9, 10, 13.'],
  ['2026-10-22', 'Final Wisdom Session: Integration', 'Wisdom Track', 'Divisions FY1, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13.'],
  ['2026-11-02', 'C Programming', 'Technical Track', IIT_KGP],
  ['2026-11-03', 'Arrays', 'Technical Track', IIT_KGP],
  ['2026-11-04', 'Algorithms', 'Technical Track', IIT_KGP],
  ['2026-11-05', 'Memory', 'Technical Track', IIT_KGP],
  ['2026-11-06', 'Data Structures', 'Technical Track', IIT_KGP],
  ['2026-11-07', 'Python, SQL, HTML/CSS, JavaScript & AI', 'Technical Track', `Integrated session. ${IIT_KGP} ${ALL_DIVISIONS}`],
];

function seedCalendar() {
  return once('calendar_seeded', async (client) => {
    for (const [date, title, label, details, noSession] of CALENDAR_SEED) {
      await client.query(`
        INSERT INTO calendar_entries (title, start_date, start_time, end_time, label, details)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [title, date, noSession ? '' : '17:15', noSession ? '' : '18:15', label, details]);
    }
  });
}

module.exports = {
  seedIfEmpty, backfillRegistrationLink, seedGallery, seedCalendar, INITIAL_EVENTS, CALENDAR_SEED,
};

// `npm run seed` runs this file directly.
if (require.main === module) {
  (async () => {
    await migrate();
    await ensureAdminUser();
    const seeded = await seedIfEmpty();
    console.log(seeded
      ? `Seeded ${INITIAL_EVENTS.length} event(s) and the admin account.`
      : 'Events table already has rows — nothing seeded.');
    if (await seedGallery()) console.log('Seeded the gallery.');
    if (await seedCalendar()) console.log('Seeded the FY calendar.');
    console.log(`Admin username: ${process.env.ADMIN_USERNAME || 'admin'}`);
    await close();
  })().catch((err) => {
    console.error(describeError(err));
    process.exit(1);
  });
}
