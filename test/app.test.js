'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeJar, login, formData, PNG_1PX, JPEG_MIN, TEST_ADMIN } = require('./helpers');

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
});

/* ========================================================== public events API */

describe('public events API', () => {
  test('the seeded launch event carries the registration link', async () => {
    const { events } = await json(await fetch(`${base}/api/events?scope=upcoming`));
    const seeded = events.find((e) => e.title === 'From Then to Now: Alumni Tales');
    assert.ok(seeded, 'seeded event present');
    assert.equal(seeded.registrationLink, 'https://tinyurl.com/ethicraftpict');
  });

  test('returns the seeded launch event', async () => {
    const { events } = await json(await fetch(`${base}/api/events?scope=upcoming`));
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
    assert.match(event.posterPath, /^\/posters\/\d+$/,
      'poster URL is an id, never a caller-supplied filename');
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

  test('replacing a poster swaps the bytes behind a stable URL', async () => {
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

    // The URL is the event id, so it is stable across replacements by design.
    assert.equal(updated.event.posterPath, url);

    const after = await fetch(`${base}${url}`);
    const afterBytes = Buffer.from(await after.arrayBuffer());
    assert.equal(after.headers.get('content-type'), 'image/jpeg', 'new mime type served');
    assert.ok(!beforeBytes.equals(afterBytes), 'the stored bytes actually changed');
    assert.notEqual(before.headers.get('etag'), after.headers.get('etag'),
      'ETag changes so caches do not serve the old poster');
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
    for (const p of ['/api/config', '/healthz', '/api/admin/me', '/api/events?scope=all']) {
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
    const html = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(html, /Club login/i);
    assert.doesNotMatch(html, /href="[^"]*admin/i, 'admin portal is unlinked');
  });

  test('theme toggle and no-flash script ship on every page', async () => {
    for (const p of ['/', `${TEST_ADMIN.path}/login`, '/no-such-page']) {
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
});

/* ================================================================== theme */

describe('theme', () => {
  test('every page resolves the theme before first paint', async () => {
    for (const p of ['/', `${TEST_ADMIN.path}/login`, '/no-such-page']) {
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
    for (const p of ['/', `${TEST_ADMIN.path}/login`, '/no-such-page']) {
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
    for (const page of ['/', `${TEST_ADMIN.path}/login`, '/no-such-page']) {
      const html = await (await fetch(`${base}${page}`)).text();
      assert.doesNotMatch(html, /cdn\.tailwindcss\.com/,
        `${page} must not load a runtime CSS compiler - it leaves phones on slow ` +
        'connections rendering an unstyled, overflowing page');
      assert.match(html, /href="\/css\/app\.css"/, `${page} links the built stylesheet`);
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

