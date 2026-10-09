'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { startServer, makeJar, login, formData, PNG_1PX, JPEG_MIN, TEST_ADMIN, ROOT } = require('./helpers');

let server, base;
const jar = makeJar();

before(async () => { server = await startServer(); base = server.base; });
after(async () => { await server?.stop(); });

const json = async (res) => { try { return await res.json(); } catch { return {}; } };

/* ====================================================== infrastructure */

describe('infrastructure', () => {
  test('health check reports ok', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal((await json(res)).ok, true);
  });

  test('serves the public homepage', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /EthiCraft/);
  });

  test('unknown pages return the 404 page, not a stack trace', async () => {
    const res = await fetch(`${base}/no-such-page`);
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.match(body, /couldn't find that page/i);
    assert.doesNotMatch(body, /at Object|node_modules|Error:/);
  });

  test('unknown API routes return JSON 404', async () => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.equal((await json(res)).error, 'Not found');
  });

  test('does not advertise the server implementation', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('an unreachable database is reported with a reason, not a blank line', () => {
    // Nothing listens on port 1. "localhost" tries IPv6 and IPv4, and the two
    // refusals arrive as an AggregateError whose message is empty.
    const run = spawnSync(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost:1/none' },
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Failed to start: \S.*ECONNREFUSED.*is Postgres running\?/);
  });
});

/* ========================================================== security headers */

describe('security headers', () => {
  test('sets CSP, nosniff, frame and referrer policies', async () => {
    const res = await fetch(`${base}/`);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'CSP header present');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('referrer-policy'), /strict-origin/);
  });

  test('posters are served with nosniff and inline disposition', async () => {
    const { events } = await json(await fetch(`${base}/api/events?scope=all`));
    const withPoster = events.find((e) => e.posterPath);
    assert.ok(withPoster, 'seeded event has a poster');
    const res = await fetch(`${base}${withPoster.posterPath}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition'), /inline/);
  });
});

/* ================================================================= admin path */

describe('admin portal location', () => {
  test('the configured admin path exists and is guarded', async () => {
    const res = await fetch(`${base}${TEST_ADMIN.path}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `${TEST_ADMIN.path}/login`);
  });

  test('the login screen is reachable', async () => {
    const res = await fetch(`${base}${TEST_ADMIN.path}/login`);
    assert.equal(res.status, 200);
  });

  test('the old /admin path is gone', async () => {
    for (const p of ['/admin', '/admin/login', '/admin.html', '/administrator']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 404, `${p} should 404`);
    }
  });

  test('dashboard HTML is not reachable as a static file', async () => {
    for (const p of ['/admin.html', '/login.html', '/index.html', '/views/admin.html']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 404, `${p} must not be served statically`);
    }
  });

  test('the admin page is noindex so it cannot be crawled into search results', async () => {
    const res = await fetch(`${base}${TEST_ADMIN.path}/login`);
    assert.match(await res.text(), /name="robots"[^>]*noindex/);
  });

  test('no public endpoint reveals the admin path', async () => {
    // GET /api/config used to return it to anyone, defeating the secret path.
    assert.equal((await fetch(`${base}/api/config`)).status, 404);
    for (const p of ['/', '/calendar', '/robots.txt', '/sitemap.xml', '/healthz', '/api/events?scope=all', '/api/photos', '/api/calendar', '/no-such-page']) {
      const body = await (await fetch(`${base}${p}`)).text();
      assert.ok(!body.includes(TEST_ADMIN.path), `${p} mentions the admin path`);
    }
  });
});

/* ==================================================================== auth */

describe('authentication', () => {
  test('rejects the old credentials', async () => {
    const res = await login(base, makeJar(), 'admin', 'ethicraft@pict');
    assert.equal(res.status, 401);
  });

  test('rejects a wrong password', async () => {
    const res = await login(base, makeJar(), TEST_ADMIN.username, 'wrong-password');
    assert.equal(res.status, 401);
    assert.match((await json(res)).error, /Incorrect/);
  });

  test('does not reveal whether a username exists', async () => {
    const a = await json(await login(base, makeJar(), TEST_ADMIN.username, 'wrong'));
    const b = await json(await login(base, makeJar(), 'no-such-user', 'wrong'));
    assert.equal(a.error, b.error);
  });

  test('accepts the configured credentials and sets an HttpOnly cookie', async () => {
    const res = await login(base, jar);
    assert.equal(res.status, 200);
    assert.equal((await json(res)).admin.username, TEST_ADMIN.username);
    const cookie = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('ethicraft.sid'));
    assert.ok(cookie, 'session cookie set');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
  });

  test('admin API is closed without a session', async () => {
    for (const [method, path] of [
      ['GET', '/api/admin/events'], ['POST', '/api/admin/events'],
      ['PUT', '/api/admin/events/1'], ['DELETE', '/api/admin/events/1'],
      ['PATCH', '/api/admin/events/1/publish'], ['GET', '/api/admin/me'],
    ]) {
      const res = await fetch(`${base}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path} should be 401`);
    }
  });

  test('admin API opens with a session', async () => {
    const res = await fetch(`${base}/api/admin/events`, { headers: jar.header });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray((await json(res)).events));
  });

  test('the dashboard renders once signed in', async () => {
    const res = await fetch(`${base}${TEST_ADMIN.path}`, { headers: jar.header });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /EthiCraft Admin/);
  });

  test('changing the admin username retires the old login and its sessions', async () => {
    const old = { ADMIN_USERNAME: 'old-admin', ADMIN_PASSWORD: 'old-password-1' };
    const first = await startServer(old);
    let second;
    try {
      const oldSession = makeJar();
      assert.equal((await login(first.base, oldSession, old.ADMIN_USERNAME, old.ADMIN_PASSWORD)).status, 200);
      await first.stop({ keepDatabase: true });

      // Same database, new credentials: a restart after editing the environment.
      second = await startServer({ ADMIN_USERNAME: 'new-admin', ADMIN_PASSWORD: 'new-password-2' },
        { database: first.database });
      assert.equal((await login(second.base, makeJar(), old.ADMIN_USERNAME, old.ADMIN_PASSWORD)).status, 401,
        'the old login no longer works');
      assert.equal((await fetch(`${second.base}/api/admin/me`, { headers: oldSession.header })).status, 401,
        'a session from before the change is signed out');
      assert.equal((await login(second.base, makeJar(), 'new-admin', 'new-password-2')).status, 200);
    } finally {
      await (second || first).stop();
    }
  });

  // Behind Cloudflare, req.ip is one of Cloudflare's shared, rotating addresses.
  // Counting by it let one stranger's failed guesses lock everyone out.
  const asVisitor = (ip, password) => fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ username: TEST_ADMIN.username, password }),
  });

  test('a lockout holds back only the visitor who earned it', async () => {
    let status;
    for (let i = 0; i < 12 && status !== 429; i += 1) status = (await asVisitor('203.0.113.66', `wrong-${i}`)).status;
    assert.equal(status, 429, 'the guesser is locked out');
    assert.equal((await asVisitor('198.51.100.23', TEST_ADMIN.password)).status, 200,
      'the admin, on another connection, still signs in');
  });

  test('rate limits count each visitor behind Cloudflare separately', async () => {
    const remaining = async (headers) => Number(
      (await fetch(`${base}/api/calendar`, { headers })).headers.get('ratelimit-remaining'));
    const first = await remaining({ 'CF-Connecting-IP': '203.0.113.7' });
    assert.equal(await remaining({ 'CF-Connecting-IP': '203.0.113.7' }), first - 1, 'one visitor, one count');
    assert.equal(await remaining({ 'CF-Connecting-IP': '198.51.100.9' }), 299, 'another visitor starts fresh');
    // A header that is not an address is ignored, not used as a free new key.
    const plain = await remaining({});
    assert.equal(await remaining({ 'CF-Connecting-IP': 'garbage' }), plain - 1);
  });
});

/* ========================================================== public events API */

describe('public events API', () => {
  // The seeded event is dated 2026-09-16, so look it up across all scopes:
  // under `upcoming` these tests started failing the day after.
  test('the seeded launch event carries the registration link', async () => {
    const { events } = await json(await fetch(`${base}/api/events?scope=all`));
    const seeded = events.find((e) => e.title === 'From Then to Now: Alumni Tales');
    assert.ok(seeded, 'seeded event present');
    assert.equal(seeded.registrationLink, 'https://tinyurl.com/ethicraftpict');
  });

  test('returns the seeded launch event', async () => {
    const { events } = await json(await fetch(`${base}/api/events?scope=all`));
    const seeded = events.find((e) => e.title === 'From Then to Now: Alumni Tales');
    assert.ok(seeded, 'seeded event present');
    assert.equal(seeded.mode, 'Zoom');
    assert.equal(seeded.startTime, '19:30');
    assert.equal(seeded.endTime, '20:30');
    assert.deepEqual(seeded.topics, ['Placements', 'Campus Life', "Role of AI in today's World"]);
  });

  test('scope filters split on today', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const up = (await json(await fetch(`${base}/api/events?scope=upcoming`))).events;
    const past = (await json(await fetch(`${base}/api/events?scope=past`))).events;
    assert.ok(up.every((e) => e.eventDate >= today), 'upcoming are all today or later');
    assert.ok(past.every((e) => e.eventDate < today), 'past are all before today');
  });

  test('never leaks an unpublished draft', async () => {
    const created = await json(await fetch(`${base}/api/admin/events`, {
      method: 'POST', headers: jar.header,
      body: formData({ title: 'Secret draft', eventDate: '2027-01-01', mode: 'Offline', published: '0' }),
    }));
    const { events } = await json(await fetch(`${base}/api/events?scope=all`));
    assert.ok(!events.some((e) => e.id === created.event.id), 'draft hidden from public API');

    const direct = await fetch(`${base}/api/events/${created.event.id}`);
    assert.equal(direct.status, 404, 'draft not readable by direct id');
  });
});

/* ============================================================== validation */

describe('validation', () => {
  const post = (fields, file) => fetch(`${base}/api/admin/events`, {
    method: 'POST', headers: jar.header, body: formData(fields, file),
  });

  test('requires a title and a valid date', async () => {
    const res = await post({ eventDate: '16-09-2026', mode: 'Offline' });
    assert.equal(res.status, 400);
    const { errors } = await json(res);
    assert.ok(errors.some((e) => /Title is required/.test(e)));
    assert.ok(errors.some((e) => /YYYY-MM-DD/.test(e)));
  });

  test('rejects malformed times', async () => {
    const res = await post({ title: 'T', eventDate: '2027-01-01', startTime: '25:99', mode: 'Offline' });
    assert.equal(res.status, 400);
  });

  test('rejects an end time before the start time', async () => {
    const res = await post({ title: 'T', eventDate: '2027-01-01', startTime: '19:00', endTime: '18:00', mode: 'Offline' });
    assert.equal(res.status, 400);
    assert.match((await json(res)).errors.join(' '), /End time must be after/);
  });

  test('rejects an unknown mode', async () => {
    const res = await post({ title: 'T', eventDate: '2027-01-01', mode: 'Telepathy' });
    assert.equal(res.status, 400);
  });

  test('rejects non-http registration links', async () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,<script>', 'notaurl']) {
      const res = await post({ title: 'T', eventDate: '2027-01-01', mode: 'Offline', registrationLink: link });
      assert.equal(res.status, 400, `${link} should be rejected`);
    }
  });

  test('a registration link round-trips and survives an unrelated edit', async () => {
    const url = 'https://tinyurl.com/ethicraftpict';
    const created = await json(await post({
      title: 'Reg test', eventDate: '2027-07-07', mode: 'Offline', registrationLink: url,
    }));
    assert.equal(created.event.registrationLink, url);

    // Editing only the title must not silently clear the link.
    const updated = await json(await fetch(`${base}/api/admin/events/${created.event.id}`, {
      method: 'PUT', headers: jar.header, body: formData({ title: 'Reg test renamed' }),
    }));
    assert.equal(updated.event.registrationLink, url, 'link preserved across a partial update');

    await fetch(`${base}/api/admin/events/${created.event.id}`, { method: 'DELETE', headers: jar.header });
  });

  test('rejects non-http meeting links, including javascript:', async () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'notaurl']) {
      const res = await post({ title: 'T', eventDate: '2027-01-01', mode: 'Zoom', zoomLink: link });
      assert.equal(res.status, 400, `${link} should be rejected`);
    }
  });

  test('a published Zoom event cannot be saved without a link', async () => {
    const res = await post({ title: 'No link', eventDate: '2027-02-02', mode: 'Zoom', published: '1' });
    assert.equal(res.status, 400);
    assert.match((await json(res)).errors.join(' '), /needs a meeting link/);
  });

  test('the same event saves fine as a draft, and cannot then be published', async () => {
    const created = await json(await post({ title: 'Draft no link', eventDate: '2027-02-02', mode: 'Zoom', published: '0' }));
    assert.ok(created.event.id);

    const res = await fetch(`${base}/api/admin/events/${created.event.id}/publish`, {
      method: 'PATCH',
      headers: { ...jar.header, 'Content-Type': 'application/json' },
      body: JSON.stringify({ published: true }),
    });
    assert.equal(res.status, 400, 'publish toggle enforces the same rule');
  });

  test('operations on a missing event return 404, not 500', async () => {
    for (const [method, body] of [['PUT', formData({ title: 'x' })], ['DELETE', null]]) {
      const res = await fetch(`${base}/api/admin/events/999999`, { method, headers: jar.header, body });
      assert.equal(res.status, 404);
    }
  });
});

/* ================================================================= uploads */

describe('poster uploads', () => {
  test('accepts a PNG and stores it under a generated name', async () => {
    const res = await fetch(`${base}/api/admin/events`, {
      method: 'POST', headers: jar.header,
      body: formData({ title: 'With poster', eventDate: '2027-03-03', mode: 'Offline' },
        { buffer: PNG_1PX, type: 'image/png', name: '../../evil name.png' }),
    });
    assert.equal(res.status, 201);
    const { event } = await json(res);
    assert.match(event.posterPath, /^\/posters\/\d+\?v=\d+$/,
      'poster URL is an id plus a version, never a caller-supplied filename');
    assert.ok(!event.posterPath.includes('..'), 'no traversal in stored path');

    const fetched = await fetch(`${base}${event.posterPath}`);
    assert.equal(fetched.status, 200);
  });

  test('accepts a JPEG', async () => {
    const res = await fetch(`${base}/api/admin/events`, {
      method: 'POST', headers: jar.header,
      body: formData({ title: 'JPEG poster', eventDate: '2027-03-04', mode: 'Offline' },
        { buffer: JPEG_MIN, type: 'image/jpeg', name: 'poster.jpg' }),
    });
    assert.equal(res.status, 201);
  });

  test('rejects a non-image upload', async () => {
    const res = await fetch(`${base}/api/admin/events`, {
      method: 'POST', headers: jar.header,
      body: formData({ title: 'Bad', eventDate: '2027-03-05', mode: 'Offline' },
        { buffer: Buffer.from('#!/bin/sh\nrm -rf /'), type: 'text/x-shellscript', name: 'evil.sh' }),
    });
    assert.equal(res.status, 400);
    assert.match((await json(res)).errors.join(' '), /images are allowed/);
  });

  test('rejects an oversized poster', async () => {
    const res = await fetch(`${base}/api/admin/events`, {
      method: 'POST', headers: jar.header,
      body: formData({ title: 'Huge', eventDate: '2027-03-06', mode: 'Offline' },
        { buffer: Buffer.alloc(7 * 1024 * 1024, 1), type: 'image/png', name: 'huge.png' }),
    });
    assert.equal(res.status, 400);
    assert.match((await json(res)).errors.join(' '), /6 MB or smaller/);
  });

  test('deleting an event removes its poster', async () => {
    const created = await json(await fetch(`${base}/api/admin/events`, {
      method: 'POST', headers: jar.header,
      body: formData({ title: 'Temp', eventDate: '2027-04-04', mode: 'Offline' },
        { buffer: PNG_1PX, type: 'image/png', name: 'p.png' }),
    }));
    const poster = created.event.posterPath;
    assert.equal((await fetch(`${base}${poster}`)).status, 200);

    const del = await fetch(`${base}/api/admin/events/${created.event.id}`, { method: 'DELETE', headers: jar.header });
    assert.equal(del.status, 200);
    assert.equal((await fetch(`${base}${poster}`)).status, 404, 'orphaned poster cleaned up');
  });

  test('replacing a poster swaps the bytes and changes the URL', async () => {
    const created = await json(await fetch(`${base}/api/admin/events`, {
      method: 'POST', headers: jar.header,
      body: formData({ title: 'Swap', eventDate: '2027-05-05', mode: 'Offline' },
        { buffer: PNG_1PX, type: 'image/png', name: 'a.png' }),
    }));
    const url = created.event.posterPath;

    const before = await fetch(`${base}${url}`);
    const beforeBytes = Buffer.from(await before.arrayBuffer());
    assert.equal(before.headers.get('content-type'), 'image/png');

    const updated = await json(await fetch(`${base}/api/admin/events/${created.event.id}`, {
      method: 'PUT', headers: jar.header,
      body: formData({}, { buffer: JPEG_MIN, type: 'image/jpeg', name: 'b.jpg' }),
    }));

    // Posters are cached for a year without revalidating, so a browser that saw
    // the old one only fetches the new one if the URL changes. A new ETag alone
    // is never consulted while the cached copy is still fresh.
    const [path, oldVersion] = url.split('?');
    const [newPath, newVersion] = updated.event.posterPath.split('?');
    assert.equal(newPath, path, 'still addressed by the event id');
    assert.notEqual(newVersion, oldVersion, 'a replaced poster gets a new URL');

    const after = await fetch(`${base}${updated.event.posterPath}`);
    const afterBytes = Buffer.from(await after.arrayBuffer());
    assert.equal(after.headers.get('content-type'), 'image/jpeg', 'new mime type served');
    assert.ok(!beforeBytes.equals(afterBytes), 'the stored bytes actually changed');
    assert.notEqual(before.headers.get('etag'), after.headers.get('etag'), 'ETag changes with the poster');
  });

  test('removePoster clears the image', async () => {
    const created = await json(await fetch(`${base}/api/admin/events`, {
      method: 'POST', headers: jar.header,
      body: formData({ title: 'Clear me', eventDate: '2027-05-06', mode: 'Offline' },
        { buffer: PNG_1PX, type: 'image/png', name: 'a.png' }),
    }));
    assert.ok(created.event.posterPath);

    const updated = await json(await fetch(`${base}/api/admin/events/${created.event.id}`, {
      method: 'PUT', headers: jar.header, body: formData({ removePoster: '1' }),
    }));
    assert.equal(updated.event.posterPath, '', 'posterPath cleared');
    assert.equal((await fetch(`${base}/posters/${created.event.id}`)).status, 404);
  });

  test('an unchanged poster revalidates with 304', async () => {
    const { events } = await json(await fetch(`${base}/api/events?scope=all`));
    const withPoster = events.find((e) => e.posterPath);
    const first = await fetch(`${base}${withPoster.posterPath}`);
    const etag = first.headers.get('etag');
    assert.ok(etag, 'ETag issued');

    const second = await fetch(`${base}${withPoster.posterPath}`, { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304, 'repeat visitors are not re-sent the bytes');
  });

  test('only the current poster URL is cached for good; any other revalidates', async () => {
    const created = await json(await fetch(`${base}/api/admin/events`, {
      method: 'POST', headers: jar.header,
      body: formData({ title: 'Cache me', eventDate: '2027-05-07', mode: 'Offline' },
        { buffer: PNG_1PX, type: 'image/png', name: 'a.png' }),
    }));
    const url = created.event.posterPath;
    const current = await fetch(`${base}${url}`);
    assert.equal(current.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    const bare = url.split('?')[0];
    for (const other of [bare, `${bare}?v=1`]) {
      const res = await fetch(`${base}${other}`);
      assert.equal(res.status, 200, other);
      assert.equal(res.headers.get('cache-control'), 'no-cache', `${other} must not be pinned for a year`);
    }
  });
});

/* ============================================================ attack surface */

describe('attack surface', () => {
  test('path traversal against /uploads is blocked', async () => {
    for (const p of [
      '/posters/../server/db.js', '/posters/../../.env',
      '/posters/%2e%2e%2f%2e%2e%2f.env', '/posters/....//....//.env',
      '/posters/1;DROP TABLE events', '/posters/abc',
    ]) {
      const res = await fetch(`${base}${p}`);
      assert.ok(res.status === 404 || res.status === 400, `${p} -> ${res.status}`);
      const body = await res.text();
      assert.doesNotMatch(body, /SESSION_SECRET|ADMIN_PASSWORD/, 'no secrets leaked');
    }
  });

  test('the .env file is never served', async () => {
    for (const p of ['/.env', '/../.env', '/data/ethicraft.db', '/package.json', '/server/db.js']) {
      const res = await fetch(`${base}${p}`);
      assert.notEqual(res.status, 200, `${p} must not be served`);
    }
  });

  test('SQL injection in query and body is parameterised away', async () => {
    const payloads = ["1' OR '1'='1", "'; DROP TABLE events; --", "1 UNION SELECT * FROM admins"];
    for (const p of payloads) {
      const byId = await fetch(`${base}/api/events/${encodeURIComponent(p)}`);
      assert.ok([404, 400].includes(byId.status), `id ${p} -> ${byId.status}`);

      const scoped = await fetch(`${base}/api/events?scope=${encodeURIComponent(p)}`);
      assert.equal(scoped.status, 200, 'unknown scope falls back safely');
    }
    // The table must still exist afterwards.
    const res = await fetch(`${base}/api/events?scope=all`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray((await json(res)).events));
  });

  test('admin credentials are never echoed by any endpoint', async () => {
    for (const p of ['/healthz', '/api/admin/me', '/api/events?scope=all']) {
      const body = await (await fetch(`${base}${p}`, { headers: jar.header })).text();
      assert.doesNotMatch(new RegExp(TEST_ADMIN.password, 'i').test(body) ? 'LEAK' : body, /LEAK|password_hash|SESSION_SECRET/i, `${p} leaks secrets`);
    }
  });

  test('stored XSS is kept as data and never rendered as markup', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const created = await json(await fetch(`${base}/api/admin/events`, {
      method: 'POST', headers: jar.header,
      body: formData({
        title: payload, eventDate: '2027-06-06', mode: 'Offline',
        venue: '"><script>alert(2)</script>', topics: '<b>x</b>, ok', published: '1',
      }),
    }));
    // Stored verbatim - escaping is an output concern, not a storage one.
    assert.equal(created.event.title, payload);

    // And the page that renders it ships an escaper rather than raw interpolation.
    const js = await (await fetch(`${base}/js/main.js`)).text();
    assert.match(js, /replace\(\/\[&<>"'\]\/g/, 'renderer has an HTML escaper');
    assert.ok(!/innerHTML\s*=\s*`?\$\{event\.(title|venue|description)\}/.test(js),
      'no unescaped event field goes straight into innerHTML');

    await fetch(`${base}/api/admin/events/${created.event.id}`, { method: 'DELETE', headers: jar.header });
  });

  test('a giant JSON body is refused rather than buffered', async () => {
    const res = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'a'.repeat(3 * 1024 * 1024), password: 'b' }),
    });
    assert.ok(res.status === 413 || res.status === 400, `got ${res.status}`);
  });

  test('login is rate limited after repeated failures', async () => {
    let sawLimit = false;
    for (let i = 0; i < 30; i += 1) {
      const res = await login(base, makeJar(), TEST_ADMIN.username, `wrong-${i}`);
      if (res.status === 429) { sawLimit = true; break; }
    }
    assert.ok(sawLimit, 'brute force is throttled');
  });
});

/* ===================================================================== seo */

describe('SEO', () => {
  test('robots.txt points at the sitemap and hides the API', async () => {
    const body = await (await fetch(`${base}/robots.txt`)).text();
    assert.match(body, /Sitemap: https:\/\/ethicraft\.in\/sitemap\.xml/);
    assert.match(body, /Disallow: \/api\//);
  });

  test('robots.txt does not advertise the admin path', async () => {
    const body = await (await fetch(`${base}/robots.txt`)).text();
    assert.doesNotMatch(body, new RegExp(TEST_ADMIN.path.slice(1)), 'naming it would defeat the point');
  });

  test('sitemap.xml is well-formed and absolute', async () => {
    const res = await fetch(`${base}/sitemap.xml`);
    assert.match(res.headers.get('content-type'), /xml/);
    const body = await res.text();
    assert.match(body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.ok(body.includes('<loc>https://ethicraft.in/</loc>'));
    assert.equal((body.match(/<url>/g) || []).length, (body.match(/<\/url>/g) || []).length);
  });

  test('homepage carries canonical, OG and geo metadata', async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<link rel="canonical" href="https:\/\/ethicraft\.in\/"/);
    assert.match(html, /property="og:title"/);
    assert.match(html, /property="og:image"/);
    assert.match(html, /name="twitter:card"/);
    assert.match(html, /name="geo\.placename" content="Pune, Maharashtra"/);
    assert.match(html, /<html lang="en-IN">/);
  });

  test('structured data is valid JSON-LD with the expected entities', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(block, 'JSON-LD present');
    const data = JSON.parse(block[1]);
    const types = data['@graph'].map((n) => n['@type']);
    for (const expected of ['EducationalOrganization', 'WebSite', 'BreadcrumbList', 'FAQPage']) {
      assert.ok(types.includes(expected), `${expected} in graph`);
    }
    const org = data['@graph'].find((n) => n['@type'] === 'EducationalOrganization');
    assert.equal(org.address.addressLocality, 'Pune');
    assert.match(org.description, /Pune Institute of Computer Technology/);
  });

  test('homepage names the local search terms it should rank for', async () => {
    const html = (await (await fetch(`${base}/`)).text()).toLowerCase();
    for (const term of ['pict', 'pune', 'ethicraft', 'maharashtra']) {
      assert.ok(html.includes(term), `homepage mentions "${term}"`);
    }
  });

  test('exactly one h1, and headings are not skipped', async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'one h1 per page');
    assert.ok((html.match(/<h2[\s>]/g) || []).length >= 4, 'h2s structure the page');
  });
});

/* ================================================================ frontend */

describe('frontend assets', () => {
  test('all local assets referenced by the homepage resolve', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const refs = [...new Set([...html.matchAll(/(?:href|src)="(\/[^"#]+)"/g)].map((m) => m[1]))];
    assert.ok(refs.length > 3, 'found asset references');
    for (const ref of refs) {
      const res = await fetch(`${base}${ref}`, { redirect: 'manual' });
      assert.ok(res.status < 400, `${ref} -> ${res.status}`);
    }
  });

  test('the homepage uses drawn icons, not emoji', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const emoji = html.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || [];
    assert.equal(emoji.length, 0, `found emoji: ${emoji.join(' ')}`);
    assert.ok((html.match(/<use href="#i-/g) || []).length >= 10, 'custom icon sprite in use');
  });

  test('no public page links to the admin portal', async () => {
    for (const p of ['/', '/calendar']) {
      const html = await (await fetch(`${base}${p}`)).text();
      assert.doesNotMatch(html, /Club login/i);
      assert.doesNotMatch(html, /href="[^"]*admin/i, `${p}: admin portal is unlinked`);
    }
  });

  test('theme toggle and no-flash script ship on every page', async () => {
    for (const p of ['/', '/calendar', `${TEST_ADMIN.path}/login`, '/no-such-page']) {
      const html = await (await fetch(`${base}${p}`)).text();
      assert.match(html, /ethicraft-theme/, `${p} has the theme bootstrap`);
    }
    const home = await (await fetch(`${base}/`)).text();
    assert.ok((home.match(/data-theme-toggle/g) || []).length >= 1, 'toggle present');
  });

  test('theme bootstrap runs before the stylesheet so there is no flash', async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.indexOf('ethicraft-theme') < html.indexOf('css/styles.css'),
      'inline theme script must precede the stylesheet');
  });

  test('event times are read as IST, wherever the visitor is', async () => {
    // Read in the visitor's own timezone, the countdown and the .ics entry were
    // hours out for anyone abroad. `npm run test:e2e` checks the behaviour in a
    // real browser set to other timezones.
    const js = await (await fetch(`${base}/js/main.js`)).text();
    assert.match(js, /const IST_OFFSET = '\+05:30';/, 'times are pinned to IST');
    assert.doesNotMatch(js, /new Date\(y, m - 1, d, hh/, 'no event time is built in the local timezone');
  });
});

/* ================================================================== theme */

describe('theme', () => {
  test('every page resolves the theme before first paint', async () => {
    for (const p of ['/', '/calendar', `${TEST_ADMIN.path}/login`, '/no-such-page']) {
      const html = await (await fetch(`${base}${p}`)).text();
      const script = html.match(/Runs before first paint[\s\S]*?<\/script>/);
      assert.ok(script, `${p} has the theme bootstrap`);
      assert.match(script[0], /prefers-color-scheme: dark/, `${p} consults the OS setting`);
      assert.match(script[0], /saved === 'light' \|\| saved === 'dark'/,
        `${p} lets an explicit choice win`);
    }
  });

  test('the bootstrap runs before the stylesheet so there is no flash', async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.indexOf('ethicraft-theme') < html.indexOf('css/styles.css'),
      'inline theme script must precede the stylesheet');
  });

  test('theme.js follows the OS live, but only without an explicit choice', async () => {
    const js = await (await fetch(`${base}/js/theme.js`)).text();
    assert.match(js, /matchMedia\('\(prefers-color-scheme: dark\)'\)/);
    assert.match(js, /if \(!stored\(\)\) apply\(systemTheme\(\)/,
      'OS changes must not override a saved preference');
    assert.match(js, /localStorage\.setItem\(STORAGE_KEY, theme\)/, 'choice is persisted');
  });

  test('theme-color is declared for both schemes', async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /theme-color" content="#fdf9f0" media="\(prefers-color-scheme: light\)"/);
    assert.match(html, /theme-color" content="#0a0e17" media="\(prefers-color-scheme: dark\)"/);
  });

  test('both palettes are fully defined in CSS', async () => {
    const css = await (await fetch(`${base}/css/styles.css`)).text();
    assert.match(css, /\[data-theme="dark"\]\s*\{/, 'dark token block present');
    assert.match(css, /:root\s*\{[\s\S]*?--surface:/, 'light token block present');
  });

  test('the transparent nav stays readable over the dark hero photo', async () => {
    const css = await (await fetch(`${base}/css/styles.css`)).text();
    assert.match(css, /\.ec-nav:not\(\[data-scrolled="true"\]\) \.ec-nav-ink \{ color: #fff; \}/,
      'wordmark is forced light while the bar is transparent');
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /class="ec-nav-ink block font-display/);
    assert.ok((html.match(/ec-nav-ink-soft/g) || []).length >= 4, 'nav links tagged');
  });
});

describe('responsive', () => {
  test('viewport meta allows zooming', async () => {
    for (const p of ['/', '/calendar', `${TEST_ADMIN.path}/login`, '/no-such-page']) {
      const html = await (await fetch(`${base}${p}`)).text();
      assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
      assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/,
        `${p} must not block pinch zoom`);
    }
  });

  test('nothing is allowed to widen the page horizontally', async () => {
    const css = await (await fetch(`${base}/css/styles.css`)).text();
    assert.match(css, /overflow-x: clip;/, 'body clips horizontal overflow');
    assert.match(css, /overflow-wrap: break-word/, 'long strings wrap');
    assert.match(css, /\.ec-row > \*, \.ec-spec > \* \{ min-width: 0; \}/,
      'grid children may shrink below their content');
  });

  test('inline nav and footer links meet the minimum tap size', async () => {
    const css = await (await fetch(`${base}/css/styles.css`)).text();
    assert.match(css, /\.ec-navlink,\s*\.ec-taplink \{[\s\S]*?min-height: 2\.75rem;/);
    const html = await (await fetch(`${base}/`)).text();
    assert.ok((html.match(/ec-taplink/g) || []).length >= 4, 'footer links tagged');
  });

  test('CSS is precompiled, not generated in the browser', async () => {
    for (const page of ['/', '/calendar', `${TEST_ADMIN.path}/login`, '/no-such-page']) {
      const html = await (await fetch(`${base}${page}`)).text();
      assert.doesNotMatch(html, /cdn\.tailwindcss\.com/,
        `${page} must not load a runtime CSS compiler - it leaves phones on slow ` +
        'connections rendering an unstyled, overflowing page');
      assert.match(html, /href="\/css\/app\.css(\?v=[0-9a-f]+)?"/, `${page} links the built stylesheet`);
    }
    const css = await (await fetch(`${base}/css/app.css`));
    assert.equal(css.status, 200);
    const body = await css.text();
    assert.ok(body.length > 5000, 'built stylesheet is non-trivial');
    assert.match(body, /--tw-/, 'looks like real Tailwind output');
  });

  test('the build emits the utilities used by JS-rendered cards', async () => {
    const css = await (await fetch(`${base}/css/app.css`)).text();
    const emitted = new Set();
    for (const m of css.matchAll(/\.((?:[\w-]|\\.)+)/g)) emitted.add(m[1].replace(/\\(.)/g, '$1'));
    // These only ever appear inside template literals in main.js, so a content
    // path that missed the JS would silently drop them.
    for (const c of ['bg-surface2', 'text-muted', 'from-deep2/70', 'to-sky-dark', 'md:grid-cols-2']) {
      assert.ok(emitted.has(c), `utility "${c}" missing from the build`);
    }
  });

  test('CSP no longer needs eval now that Tailwind is precompiled', async () => {
    const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
    assert.ok(csp, 'CSP present');
    assert.doesNotMatch(csp, /unsafe-eval/, 'eval is only needed by a runtime compiler');
    assert.doesNotMatch(csp, /cdn\.tailwindcss\.com/);
  });

  test('asset URLs are content-hashed so a deploy cannot serve stale CSS', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const assets = [...html.matchAll(/\/(?:css|js)\/[\w.-]+\.(?:css|js)(\?v=[0-9a-f]+)?/g)];
    assert.ok(assets.length >= 3, 'page links stylesheets and scripts');
    for (const [url, version] of assets) {
      assert.ok(version, `${url} must carry a ?v= content hash`);
      const res = await fetch(`${base}${url}`);
      assert.equal(res.status, 200, `${url} resolves`);
    }
  });

  test('HTML is never cached, so a new deploy is picked up immediately', async () => {
    const res = await fetch(`${base}/`);
    assert.match(res.headers.get('cache-control'), /no-cache/);
  });

  test('content is readable with JavaScript disabled', async () => {
    const css = await (await fetch(`${base}/css/styles.css`)).text();
    assert.match(css, /\.no-js \.ec-reveal \{ opacity: 1/, 'no-js fallback present');
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<body class="antialiased no-js">/);
  });

  test('scroll reveals cannot strand content at opacity 0', async () => {
    const js = await (await fetch(`${base}/js/main.js`)).text();
    assert.match(js, /entry\.isIntersecting \|\| entry\.boundingClientRect\.top < window\.innerHeight/,
      'a fast scroll past an element still reveals it');
    assert.match(js, /function sweepReveals/, 'safety sweep present');
  });
});


/* ========================================================= multi-day events */

describe('multi-day events', () => {
  // Days relative to today, far enough out that no timezone can blur the split.
  const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
  const post = (fields) => fetch(`${base}/api/admin/events`, {
    method: 'POST', headers: jar.header, body: formData(fields),
  });
  const ids = async (scope) => (await json(await fetch(`${base}/api/events?scope=${scope}`))).events.map((e) => e.id);
  const remove = (id) => fetch(`${base}/api/admin/events/${id}`, { method: 'DELETE', headers: jar.header });

  test('an end date keeps a programme upcoming until its last day', async () => {
    const { event } = await json(await post({
      title: 'Running programme', eventDate: day(-10), endDate: day(10), mode: 'Offline', published: '1',
    }));
    assert.equal(event.endDate, day(10));
    assert.ok((await ids('upcoming')).includes(event.id), 'started already, but not over');
    assert.ok(!(await ids('past')).includes(event.id));
    await remove(event.id);
  });

  test('once its last day has gone, a programme is past', async () => {
    const { event } = await json(await post({
      title: 'Finished programme', eventDate: day(-20), endDate: day(-10), mode: 'Offline', published: '1',
    }));
    assert.ok((await ids('past')).includes(event.id));
    assert.ok(!(await ids('upcoming')).includes(event.id));
    await remove(event.id);
  });

  test('end dates are checked: real, and not before the start', async () => {
    for (const endDate of ['2027-01-01x', '2027-13-01', '2026-02-30']) {
      const res = await post({ title: 'T', eventDate: '2026-02-01', endDate, mode: 'Offline' });
      assert.equal(res.status, 400, `${endDate} should be refused`);
    }
    const early = await post({ title: 'T', eventDate: '2027-03-10', endDate: '2027-03-01', mode: 'Offline' });
    assert.equal(early.status, 400);
    assert.match((await json(early)).errors.join(' '), /on or after the start date/);
  });

  test('a same-day end date is stored as a one-day event', async () => {
    const { event } = await json(await post({ title: 'One day', eventDate: '2027-03-10', endDate: '2027-03-10', mode: 'Offline' }));
    assert.equal(event.endDate, '');
    await remove(event.id);
  });

  test('over several days, the daily session may end before its start time', async () => {
    const multi = await post({
      title: 'Overnight camp', eventDate: '2027-04-01', endDate: '2027-04-03', startTime: '18:00', endTime: '09:00', mode: 'Offline',
    });
    assert.equal(multi.status, 201, 'times are each day, so 18:00 to 09:00 is fine');
    await remove((await json(multi)).event.id);
    const single = await post({ title: 'T', eventDate: '2027-04-01', startTime: '18:00', endTime: '09:00', mode: 'Offline' });
    assert.equal(single.status, 400, 'on one day it is still a mistake');
  });

  test('impossible dates are a 400, not a 500', async () => {
    for (const eventDate of ['2026-02-30', '2026-13-01', '2026-00-10']) {
      const res = await post({ title: 'T', eventDate, mode: 'Offline' });
      assert.equal(res.status, 400, `${eventDate} -> ${res.status}`);
    }
  });

  test('an edit that leaves out the dates keeps them exactly', async () => {
    // pg returns DATE as local midnight; rebuilding it with toISOString moved
    // it a day back on any server east of UTC, such as a laptop in IST.
    const { event } = await json(await post({ title: 'Keep my dates', eventDate: '2027-05-10', endDate: '2027-05-12', mode: 'Offline' }));
    const { event: edited } = await json(await fetch(`${base}/api/admin/events/${event.id}`, {
      method: 'PUT', headers: jar.header, body: formData({ title: 'Renamed' }),
    }));
    assert.equal(edited.title, 'Renamed');
    assert.equal(edited.eventDate, '2027-05-10');
    assert.equal(edited.endDate, '2027-05-12');
    await remove(event.id);
  });

  test('ids beyond Postgres INTEGER range are a 404, not a 500', async () => {
    for (const p of ['/api/events/99999999999', '/posters/99999999999', '/photos/99999999999']) {
      assert.equal((await fetch(`${base}${p}`)).status, 404, p);
    }
  });
});

/* ================================================================= gallery */

describe('gallery', () => {
  const manifest = require('../assets-seed/gallery/manifest.json');
  const photosNow = async () => (await json(await fetch(`${base}/api/photos`))).photos;
  const jpeg = (bytes = JPEG_MIN) => new Blob([bytes], { type: 'image/jpeg' });
  const upload = (parts) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(parts)) {
      if (v instanceof Blob) fd.append(k, v, `${k}.jpg`);
      else fd.append(k, String(v));
    }
    return fetch(`${base}/api/admin/photos`, { method: 'POST', headers: jar.header, body: fd });
  };
  const patch = (id, body) => fetch(`${base}/api/admin/photos/${id}`, {
    method: 'PATCH', headers: { ...jar.header, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const remove = (id) => fetch(`${base}/api/admin/photos/${id}`, { method: 'DELETE', headers: jar.header });

  test('the photos picked from the club album are seeded in order', async () => {
    const photos = await photosNow();
    assert.equal(photos.length, manifest.length);
    assert.deepEqual(photos.map((p) => p.caption), manifest.map((m) => m.caption));
    assert.equal(photos.filter((p) => p.inStrip).length, manifest.filter((m) => m.inStrip).length);
    for (const p of photos) {
      assert.match(p.src, /^\/photos\/\d+\?v=\d+$/);
      assert.match(p.thumb, /^\/photos\/\d+\/thumb\?v=\d+$/);
      assert.ok(p.width > 0 && p.height > 0, 'size known, so the page reserves the space');
    }
  });

  test('photos are JPEGs, cached for good at a versioned URL', async () => {
    const [p] = await photosNow();
    const sizes = [];
    for (const url of [p.src, p.thumb]) {
      const res = await fetch(`${base}${url}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/jpeg');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('cache-control'), /max-age=31536000, immutable/);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8], 'JPEG magic');
      sizes.push(bytes.length);
    }
    assert.ok(sizes[1] < sizes[0], 'the thumbnail is the lighter download');
    const bare = await fetch(`${base}/photos/${p.id}`);
    assert.equal(bare.headers.get('cache-control'), 'no-cache', 'without a version it revalidates');
    const again = await fetch(`${base}${p.thumb}`, { headers: { 'If-None-Match': bare.headers.get('etag') } });
    assert.equal(again.status, 200, 'thumbnail and photo do not share an ETag');
  });

  test('unknown photos are a 404', async () => {
    for (const p of ['/photos/999999', '/photos/999999/thumb', '/photos/abc', '/photos/1;DROP TABLE photos']) {
      assert.equal((await fetch(`${base}${p}`)).status, 404, p);
    }
  });

  test('the gallery admin API is closed without a session', async () => {
    for (const [method, path] of [
      ['POST', '/api/admin/photos'], ['PATCH', '/api/admin/photos/1'], ['DELETE', '/api/admin/photos/1'],
    ]) {
      assert.equal((await fetch(`${base}${path}`, { method })).status, 401, `${method} ${path}`);
    }
  });

  test('an upload goes to the front, with its size read from the JPEG itself', async () => {
    const res = await upload({ photo: jpeg(), thumb: jpeg(), caption: '<b>Fresh</b> upload', inStrip: 'true', width: 9999 });
    assert.equal(res.status, 201);
    const { photo } = await json(res);
    assert.equal(photo.width, 1, 'the declared width is ignored; JPEG_MIN is 1x1');
    assert.equal(photo.caption, '<b>Fresh</b> upload', 'stored as text, escaped on output');
    assert.equal(photo.inStrip, true);
    assert.equal((await photosNow())[0].id, photo.id);
    await remove(photo.id);
  });

  test('only real JPEGs get in', async () => {
    const png = await upload({ photo: new Blob([PNG_1PX], { type: 'image/png' }), thumb: jpeg() });
    assert.equal(png.status, 400);
    assert.match((await json(png)).errors.join(' '), /JPG images are allowed/);

    const fake = await upload({ photo: jpeg(Buffer.from('#!/bin/sh\necho owned')), thumb: jpeg() });
    assert.equal(fake.status, 400, 'a script labelled image/jpeg is still not a JPEG');

    const noThumb = await upload({ photo: jpeg() });
    assert.equal(noThumb.status, 400);
    assert.match((await json(noThumb)).errors.join(' '), /thumbnail/);
  });

  test('captions, the strip flag and the order can all be changed', async () => {
    const a = (await json(await upload({ photo: jpeg(), thumb: jpeg(), caption: 'A' }))).photo;
    const b = (await json(await upload({ photo: jpeg(), thumb: jpeg(), caption: 'B' }))).photo;
    let order = (await photosNow()).map((p) => p.id);
    assert.ok(order.indexOf(b.id) < order.indexOf(a.id), 'the newest leads');

    const { photo } = await json(await patch(a.id, { caption: 'A, renamed', inStrip: true }));
    assert.equal(photo.caption, 'A, renamed');
    assert.equal(photo.inStrip, true);

    assert.equal((await patch(a.id, { move: 'up' })).status, 200);
    order = (await photosNow()).map((p) => p.id);
    assert.ok(order.indexOf(a.id) < order.indexOf(b.id), 'moved ahead of its neighbour');

    assert.equal((await patch(a.id, { move: 'sideways' })).status, 400);
    assert.equal((await patch(999999, { caption: 'x' })).status, 404);
    await remove(a.id);
    await remove(b.id);
  });

  test('a deleted photo is gone, bytes and all', async () => {
    const { photo } = await json(await upload({ photo: jpeg(), thumb: jpeg() }));
    assert.equal((await remove(photo.id)).status, 200);
    assert.equal((await fetch(`${base}${photo.src}`)).status, 404);
    assert.ok(!(await photosNow()).some((p) => p.id === photo.id));
    assert.equal((await remove(photo.id)).status, 404);
  });
});

/* ============================================================= FY calendar */

describe('FY calendar', () => {
  const entriesNow = async () => (await json(await fetch(`${base}/api/calendar`))).entries;
  const send = (method, path, body) => fetch(`${base}${path}`, {
    method, headers: { ...jar.header, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const valid = { title: 'Orientation', startDate: '2027-07-20', label: 'Workshop' };

  test('the page is served, linked from the nav and listed in the sitemap', async () => {
    const page = await fetch(`${base}/calendar`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /FY Calendar/);
    assert.match(await (await fetch(`${base}/`)).text(), /href="\/calendar"/);
    assert.match(await (await fetch(`${base}/sitemap.xml`)).text(), /<loc>https:\/\/ethicraft\.in\/calendar<\/loc>/);
  });

  test('the heading names the academic year before any script runs', async () => {
    // Academic years run July to June, by the date in India.
    const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
      .format(new Date()).split('-').map(Number);
    const start = m >= 7 ? y : y - 1;
    const label = `${start}–${String(start + 1).slice(2)}`;
    const html = await (await fetch(`${base}/calendar`)).text();
    assert.ok(html.includes(`<title>FY Calendar ${label} | EthiCraft Club PICT</title>`), 'title');
    assert.ok(html.includes(`<span id="calYearTitle" class="ec-gradient-text">${label}</span>`), 'heading');
    assert.ok(!html.includes('{{'), 'no placeholder left in the page');
  });

  test("the programme's schedule from its poster is seeded, earliest first", async () => {
    const entries = await entriesNow();
    assert.equal(entries.length, 17);
    assert.deepEqual(entries.map((e) => e.startDate), [...entries.map((e) => e.startDate)].sort());
    assert.deepEqual(
      { title: entries[0].title, date: entries[0].startDate, time: `${entries[0].startTime}-${entries[0].endTime}`, label: entries[0].label },
      { title: 'Discover the Game of Life', date: '2026-10-12', time: '17:15-18:15', label: 'Wisdom Track' });
    assert.equal(entries.filter((e) => e.label === 'Technical Track').length, 6);
    const buffer = entries.find((e) => e.startDate === '2026-10-20');
    assert.equal(buffer.startTime, '', 'the buffer day has no session time');
  });

  test('the calendar admin API is closed without a session', async () => {
    for (const [method, path] of [
      ['POST', '/api/admin/calendar'], ['PUT', '/api/admin/calendar/1'], ['DELETE', '/api/admin/calendar/1'],
    ]) {
      assert.equal((await fetch(`${base}${path}`, { method })).status, 401, `${method} ${path}`);
    }
  });

  test('entries can be added, edited and deleted', async () => {
    const created = await send('POST', '/api/admin/calendar', { ...valid, endDate: '2027-07-22', startTime: '10:00', endTime: '12:30', details: 'Seminar Hall', link: 'https://example.com' });
    assert.equal(created.status, 201);
    const { entry } = await json(created);
    assert.deepEqual([entry.startDate, entry.endDate, entry.startTime, entry.endTime], ['2027-07-20', '2027-07-22', '10:00', '12:30']);

    const edited = await json(await send('PUT', `/api/admin/calendar/${entry.id}`, { ...valid, title: 'Orientation day' }));
    assert.equal(edited.entry.title, 'Orientation day');
    assert.equal(edited.entry.endDate, '', 'a full replace: fields left out are cleared');

    assert.equal((await fetch(`${base}/api/admin/calendar/${entry.id}`, { method: 'DELETE', headers: jar.header })).status, 200);
    assert.ok(!(await entriesNow()).some((e) => e.id === entry.id));
    assert.equal((await send('PUT', `/api/admin/calendar/${entry.id}`, valid)).status, 404);
  });

  test('entries are validated', async () => {
    const bad = [
      { ...valid, title: '' },
      { ...valid, startDate: '2027-02-30' },
      { ...valid, endDate: '2027-07-01' },
      { ...valid, startTime: '25:00' },
      { ...valid, startTime: '12:00', endTime: '11:00' },
      { ...valid, link: 'javascript:alert(1)' },
    ];
    for (const body of bad) {
      assert.equal((await send('POST', '/api/admin/calendar', body)).status, 400, JSON.stringify(body));
    }
  });
});

/* =========================================================== starter content */

describe('starter content', () => {
  test('the gallery and calendar are seeded once: deleted, they stay deleted after a restart', async () => {
    const first = await startServer();
    let second;
    try {
      const admin = makeJar();
      await login(first.base, admin);
      const del = (path) => fetch(`${first.base}${path}`, { method: 'DELETE', headers: admin.header });
      for (const p of (await json(await fetch(`${first.base}/api/photos`))).photos) await del(`/api/admin/photos/${p.id}`);
      for (const e of (await json(await fetch(`${first.base}/api/calendar`))).entries) await del(`/api/admin/calendar/${e.id}`);
      await first.stop({ keepDatabase: true });

      second = await startServer({}, { database: first.database });
      assert.equal((await json(await fetch(`${second.base}/api/photos`))).photos.length, 0);
      assert.equal((await json(await fetch(`${second.base}/api/calendar`))).entries.length, 0);
    } finally {
      await (second || first).stop();
    }
  });
});

/* ============================================================== homepage */

describe('homepage changes', () => {
  const REGISTER = 'https://tinyurl.com/ethicraftpict';

  test('"Join the club" and the join section both open the registration form', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const links = [...html.matchAll(/<a\b[^>]*href="https:\/\/tinyurl\.com\/ethicraftpict"[^>]*>/g)].map((m) => m[0]);
    assert.ok(links.length >= 3, 'nav, mobile menu and join section');
    for (const a of links) {
      assert.match(a, /target="_blank"/);
      assert.match(a, /rel="noopener noreferrer"/);
    }
    const join = html.match(/<section id="join"[\s\S]*?<\/section>/)[0];
    assert.ok(join.includes(REGISTER) && /Register now/.test(join));
    assert.doesNotMatch(join, /Email us to join|tel:/, 'one button, not two');
  });

  test('the logo follows the theme, from small background-free images', async () => {
    for (const p of ['/', '/calendar', `${TEST_ADMIN.path}/login`, '/no-such-page']) {
      const html = await (await fetch(`${base}${p}`)).text();
      assert.match(html, /<img src="\/assets\/logo-day\.webp"[^>]*class="ec-logo-day/, `${p}: day logo`);
      assert.match(html, /<img src="\/assets\/logo-night\.webp"[^>]*class="ec-logo-night/, `${p}: night logo`);
      assert.doesNotMatch(html, /<img src="\/assets\/logo\.png"/, `${p}: no boxed logo left on the page`);
    }
    const css = await (await fetch(`${base}/css/styles.css`)).text();
    assert.match(css, /:root:not\(\[data-theme="dark"\]\) \.ec-logo-night,\s*\[data-theme="dark"\] \.ec-logo-day \{ display: none !important; \}/);
    for (const file of ['logo-day.webp', 'logo-night.webp']) {
      const res = await fetch(`${base}/assets/${file}`);
      assert.equal(res.headers.get('content-type'), 'image/webp');
      const webp = Buffer.from(await res.arrayBuffer());
      assert.equal(webp.toString('latin1', 0, 4) + webp.toString('latin1', 8, 16), 'RIFFWEBPVP8X');
      assert.ok(webp[20] & 0x10, `${file} carries an alpha channel`);
      // Both themes' logos load on every page, so each must stay small.
      assert.ok(webp.length < 20 * 1024, `${file} is ${webp.length} bytes`);
    }
  });

  test('the hero photo is preloaded at the size the CSS will use', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const css = await (await fetch(`${base}/css/styles.css`)).text();
    const preloads = [...html.matchAll(/<link rel="preload" as="image" href="([^"]+)"[^>]*media="([^"]+)"/g)]
      .map(([, href, media]) => ({ href, media }));
    assert.deepEqual(preloads, [
      { href: '/assets/hero-bg-960.webp', media: '(max-width: 767.98px)' },
      { href: '/assets/hero-bg-1600.webp', media: '(min-width: 768px)' },
    ]);
    // The phone file is the default, and the large one takes over at 768px:
    // the same split as the preloads, so neither is fetched twice.
    assert.match(css, /\.ec-hero-photo \{[^}]*url\('\/assets\/hero-bg-960\.webp'\)/);
    assert.match(css, /@media \(min-width: 768px\) \{\s*\.ec-hero-photo \{[^}]*url\('\/assets\/hero-bg-1600\.webp'\)/);
    for (const { href } of preloads) {
      const res = await fetch(`${base}${href}`);
      assert.equal(res.status, 200, href);
      assert.equal(res.headers.get('content-type'), 'image/webp', href);
    }
  });

  test('the tab icon is small, not the full-size logo', async () => {
    for (const p of ['/', '/calendar', `${TEST_ADMIN.path}/login`, '/no-such-page']) {
      const html = await (await fetch(`${base}${p}`)).text();
      assert.match(html, /<link rel="icon" href="\/assets\/favicon\.png"/, `${p}: favicon`);
    }
    const icon = await fetch(`${base}/assets/favicon.png`);
    assert.equal(icon.status, 200);
    assert.ok(Number(icon.headers.get('content-length')) < 10 * 1024, 'favicon under 10 KB');
    assert.equal((await fetch(`${base}/assets/apple-touch-icon.png`)).status, 200);
  });

  test('the page has the activity strip, the featured poster, the gallery and a gallery lightbox', async () => {
    const html = await (await fetch(`${base}/`)).text();
    for (const id of ['activityStrip', 'featured', 'featuredImg', 'galleryGrid', 'lightboxPrev', 'lightboxNext', 'lightboxCaption']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.ok(html.indexOf('id="activityStrip"') < html.indexOf('<h1'), 'the strip sits right under the nav');
    assert.match(html, /href="#gallery"/);
  });

  test('posters are shown whole, and the featured one as large as the window', async () => {
    const css = await (await fetch(`${base}/css/styles.css`)).text();
    const card = css.match(/\.ec-poster \{[^}]*\}/)[0];
    assert.doesNotMatch(card, /object-fit: cover/, 'a portrait crop cut landscape posters down');
    assert.match(card, /object-fit: contain/);
    assert.match(css, /\.ec-feature-poster \{[^}]*max-width: 100%;[^}]*max-height: 88vh;/);
  });
});
