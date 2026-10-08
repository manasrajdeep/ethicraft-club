'use strict';

require('dotenv').config();

const { query, migrate, ensureAdminUser, close, describeError } = require('../server/db');
const { seedIfEmpty } = require('./seed');

/** Drops every table this app owns and rebuilds from scratch. Destructive. */
(async () => {
  await query('DROP TABLE IF EXISTS events, admins, user_sessions CASCADE');
  await migrate();
  await ensureAdminUser();
  await seedIfEmpty();
  console.log('Database reset and reseeded.');
  await close();
})().catch((err) => {
  console.error(describeError(err));
  process.exit(1);
});
