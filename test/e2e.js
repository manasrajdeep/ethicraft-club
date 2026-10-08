'use strict';

/**
 * Drives the real UI in headless Chrome against a throwaway test server (its
 * own database, like the integration suite) and fails on anything a visitor or
 * the club team would hit: console errors, uncaught exceptions, CSP violations
 * and failed requests on every page, plus the admin flow, output escaping,
 * theme, lightbox, mobile menu, poster caching, and event times as seen from
 * other timezones.
 *
 *   node test/e2e.js
 */
const puppeteer = require('puppeteer');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, TEST_ADMIN, ROOT } = require('./helpers');

const SHOTS = path.join(ROOT, '.audit-shots', 'e2e');
const POSTER = path.join(ROOT, 'assets-seed', 'alumni-tales.jpg');
const OTHER_POSTER = path.join(ROOT, 'public', 'assets', 'logo.png');

let failures = 0;
const thirdParty = new Set();

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  ✖ ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function visible(page, selector) {
  for (const el of await page.$$(selector)) {
    if (await el.isVisible()) return el;
  }
  throw new Error(`no visible ${selector}`);
}

/**
 * Records console errors, uncaught exceptions, failed or 4xx/5xx requests and
 * CSP violations on one page. Returns a function that hands them over (and
 * clears them), minus the ones a step expects. Third-party failures, such as
 * Google Fonts while offline, are reported at the end but fail nothing.
 */
async function instrument(page, base, { timezone = 'Asia/Kolkata', viewport = { width: 1280, height: 800 } } = {}) {
  // The default 'raf' polling stalls in background tabs, where Chrome pauses
  // animation frames; poll on a timer instead.
  const waitFor = page.waitForFunction.bind(page);
  page.waitForFunction = (fn, opts = {}, ...args) => waitFor(fn, { polling: 100, ...opts }, ...args);

  await page.emulateTimezone(timezone);
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'} at ${e.sourceFile || '?'}:${e.lineNumber}`);
    });
    // Keep a copy of each .ics file so the export can be checked without a download.
    window.__ics = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (obj) => {
      if (obj instanceof Blob && /calendar/.test(obj.type)) obj.text().then((t) => window.__ics.push(t));
      return create(obj);
    };
  });

  const own = [];
  const report = (url, message) => {
    if (url && !url.startsWith(base)) thirdParty.add(message);
    else own.push(message);
  };
  page.on('console', (msg) => {
    if (msg.type() === 'error') report(msg.location()?.url, `console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => own.push(`uncaught: ${err.message}`));
  page.on('requestfailed', (req) => {
    const why = req.failure()?.errorText || '';
    if (/ERR_ABORTED/.test(why)) return;   // the page navigated away mid-request
    report(req.url(), `request failed: ${req.url()} (${why})`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) report(res.url(), `HTTP ${res.status()} ${res.request().method()} ${res.url()}`);
  });

  return async (expected = []) => {
    const csp = await page.evaluate(() => window.__csp.splice(0)).catch(() => []);
    return [...own.splice(0), ...csp.map((c) => `CSP violation: ${c}`)]
      .filter((p) => !expected.some((re) => re.test(p)));
  };
}

(async () => {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  const server = await startServer();
  const base = server.base;
  let browser;

  // The event this run creates: 30 days out, 18:00-19:30 IST = 12:30-14:00 UTC.
  const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const [fy, fm, fd] = future.split('-').map(Number);
  const START_MS = Date.UTC(fy, fm - 1, fd, 12, 30);
  const ICS_START = `DTSTART:${future.replace(/-/g, '')}T123000Z`;
  const ICS_END = `DTEND:${future.replace(/-/g, '')}T140000Z`;
  const TITLE = 'E2E <img src=x onerror="window.__xss=1"> Event';

  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.createBrowserContext();
    // The .ics button starts a real download; the file is captured in the page
    // instead, so keep anything from landing on disk.
    const cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: ctx.id });

    const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    const gridReady = (page) => page.waitForFunction(
      () => document.querySelector('#eventsGrid')?.getAttribute('aria-busy') === 'false');
    const dims = (page, selector) => page.waitForFunction((sel) => {
      const img = document.querySelector(sel);
      return img && img.complete && img.naturalWidth > 0 && `${img.naturalWidth}x${img.naturalHeight}`;
    }, {}, selector).then((handle) => handle.jsonValue());

    /* ---------------------------------------------------------- public site */
    console.log('\npublic site');
    const home = await ctx.newPage();
    const homeProblems = await instrument(home, base);

    await check('homepage loads with no JS errors, CSP violations or failed requests', async () => {
      await home.goto(`${base}/`, { waitUntil: 'networkidle0' });
      await gridReady(home);
      const p = await homeProblems();
      assert(!p.length, p.join('\n'));
    });

    await check('"Upcoming" is empty, since the seeded 2026-09-16 event has passed', async () => {
      const grid = await home.$eval('#eventsGrid', (el) => el.textContent);
      assert(/Nothing scheduled right now/.test(grid), `grid: ${grid.trim().slice(0, 100)}`);
      assert(await home.$eval('#heroEvent', (el) => el.innerHTML.trim()) === '', 'hero teaser should be empty');
    });

    await check('"Past" lists the seeded event and its poster loads', async () => {
      await home.click('.ec-tab[data-scope="past"]');
      await home.waitForFunction(() => /Alumni Tales/.test(document.querySelector('#eventsGrid').textContent));
      const img = await home.waitForSelector('#eventsGrid img.ec-poster');
      await img.scrollIntoView();
      await home.waitForFunction((el) => el.complete && el.naturalWidth > 0, {}, img);
      const p = await homeProblems();
      assert(!p.length, p.join('\n'));
    });

    await check('a poster opens in the lightbox, and Escape closes it', async () => {
      await home.click('#eventsGrid .js-poster');
      await home.waitForSelector('#lightbox:not(.hidden)');
      await home.waitForFunction(() => {
        const img = document.querySelector('#lightboxImg');
        return img.complete && img.naturalWidth > 0;
      });
      await home.keyboard.press('Escape');
      await home.waitForSelector('#lightbox.hidden');
    });

    await check('the theme toggle switches day/night, and the choice survives a reload', async () => {
      const before = await home.evaluate(() => document.documentElement.dataset.theme);
      await (await visible(home, '[data-theme-toggle]')).click();
      const after = await home.evaluate(() => document.documentElement.dataset.theme);
      assert(before !== after, `theme stayed ${before}`);
      await home.reload({ waitUntil: 'networkidle0' });
      const kept = await home.evaluate(() => document.documentElement.dataset.theme);
      assert(kept === after, `after reload: ${kept}, expected ${after}`);
      await shot(home, `home-${kept}`);
      await (await visible(home, '[data-theme-toggle]')).click();   // put it back
      const p = await homeProblems();
      assert(!p.length, p.join('\n'));
    });

    /* --------------------------------------------------------- admin portal */
    console.log('\nadmin portal');
    const admin = await ctx.newPage();
    const adminProblems = await instrument(admin, base);
    const stats = () => admin.evaluate(() => ['statPublished', 'statDrafts', 'statUpcoming']
      .map((id) => document.getElementById(id).textContent.trim()).join('/'));
    const rowFor = (title) => admin.evaluate((t) => {
      const row = [...document.querySelectorAll('#eventList article')]
        .find((a) => a.querySelector('h3')?.textContent === t);
      return row && {
        id: row.querySelector('[data-action="edit"]').dataset.id,
        text: row.textContent.replace(/\s+/g, ' ').trim(),
      };
    }, title);
    const toast = (re) => admin.waitForFunction(
      (source) => new RegExp(source).test(document.querySelector('#toast').textContent), {}, re.source);

    await check('the login page loads cleanly, and a wrong password shows an inline error', async () => {
      await admin.goto(`${base}${TEST_ADMIN.path}/login`, { waitUntil: 'networkidle0' });
      await admin.type('#username', TEST_ADMIN.username);
      await admin.type('#password', 'definitely-wrong');
      await admin.click('#loginSubmit');
      await admin.waitForSelector('#loginError:not(.hidden)');
      const message = await admin.$eval('#loginError', (el) => el.textContent.trim());
      assert(/Incorrect username or password/.test(message), `error shown: "${message}"`);
      assert(admin.url().endsWith('/login'), `navigated to ${admin.url()}`);
      const p = await adminProblems([/401/]);
      assert(!p.length, p.join('\n'));
    });

    await check('the right credentials sign in and land on the dashboard', async () => {
      await admin.$eval('#username', (el) => { el.value = ''; });
      await admin.type('#username', TEST_ADMIN.username);
      await admin.type('#password', TEST_ADMIN.password);
      await Promise.all([admin.waitForNavigation({ waitUntil: 'networkidle0' }), admin.click('#loginSubmit')]);
      assert(new URL(admin.url()).pathname === TEST_ADMIN.path, `landed on ${admin.url()}`);
      await admin.waitForFunction(() => document.querySelectorAll('#eventList article').length >= 1);
      const p = await adminProblems();
      assert(!p.length, p.join('\n'));
    });

    await check('the dashboard shows the seeded event as Published and Past; stats read 1/0/0', async () => {
      const row = await rowFor('From Then to Now: Alumni Tales');
      assert(row, 'seeded row missing');
      assert(/Published/.test(row.text) && /Past/.test(row.text), row.text);
      const s = await stats();
      assert(s === '1/0/0', `published/drafts/upcoming = ${s}`);
    });

    let id;
    await check('create: a published Offline event with a poster, through the drawer form', async () => {
      await admin.click('#newEventBtn');
      await admin.waitForSelector('#drawer:not(.hidden)');
      await admin.type('#title', TITLE);
      await admin.type('#subtitle', 'Browser end-to-end check');
      await admin.$eval('#eventDate', (el, v) => { el.value = v; }, future);
      await admin.$eval('#startTime', (el) => { el.value = '18:00'; });
      await admin.$eval('#endTime', (el) => { el.value = '19:30'; });
      await admin.select('#mode', 'Offline');
      await admin.waitForSelector('#venueField:not(.hidden)');
      assert(await admin.$eval('#linkField', (el) => el.classList.contains('hidden')),
        'the meeting-link field should hide for Offline events');
      await admin.type('#venue', 'PICT Main Auditorium');
      await admin.type('#registrationLink', 'https://example.com/register');
      await admin.type('#topics', 'Ethics, AI, Careers');
      await (await admin.$('#poster')).uploadFile(POSTER);
      await admin.waitForSelector('#posterPreview:not(.hidden)');
      await admin.$eval('#published', (el) => { el.checked = true; });
      await shot(admin, 'drawer');
      await admin.click('#saveBtn');
      await toast(/Event created/);
      await admin.waitForFunction(() => document.querySelectorAll('#eventList article').length === 2);
      const row = await rowFor(TITLE);
      assert(row, 'new row missing, or its title was not rendered as plain text');
      id = row.id;
      const s = await stats();
      assert(s === '2/0/1', `published/drafts/upcoming = ${s}`);
      assert(await admin.evaluate(() => window.__xss) === undefined, 'markup in the title EXECUTED on the dashboard');
      const p = await adminProblems();
      assert(!p.length, p.join('\n'));
      await shot(admin, 'dashboard');
    });

    /* ------------------------------------------- public site, once published */
    console.log('\npublic site, once published');

    await check('the new event is featured in the hero and listed under Upcoming, as plain text', async () => {
      await home.bringToFront();
      await home.goto(`${base}/`, { waitUntil: 'networkidle0' });
      await gridReady(home);
      const grid = await home.$eval('#eventsGrid', (el) => el.textContent);
      const hero = await home.$eval('#heroEvent', (el) => el.textContent);
      assert(grid.includes(TITLE), 'title missing from the Upcoming grid');
      assert(hero.includes(TITLE), 'title missing from the hero teaser');
      assert(await home.evaluate(() => window.__xss) === undefined, 'markup in the title EXECUTED on the public page');
      assert(await home.$$eval('img[src="x"]', (els) => els.length) === 0, 'markup in the title became a real element');
      await dims(home, '#heroEvent img');
      const rels = await home.$$eval('#eventsGrid a[href="https://example.com/register"]', (els) => els.map((a) => a.rel));
      assert(rels.length && rels.every((r) => /noopener/.test(r)), `registration link rel: ${JSON.stringify(rels)}`);
      const p = await homeProblems();
      assert(!p.length, p.join('\n'));
      await shot(home, 'home-with-event');
    });

    // Times are wall-clock IST. The countdown and the .ics file must name the
    // same instant wherever the visitor is, including a zone where it is
    // already the next day.
    for (const timezone of ['Asia/Kolkata', 'America/New_York', 'Pacific/Auckland']) {
      await check(`the .ics file and countdown match the real start for a visitor in ${timezone}`, async () => {
        const page = await ctx.newPage();
        const problems = await instrument(page, base, { timezone });
        try {
          await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
          await gridReady(page);
          await page.click('#eventsGrid .js-ics');
          await page.waitForFunction(() => window.__ics.length > 0);
          const ics = await page.evaluate(() => window.__ics[0]);
          await page.waitForFunction(() => document.querySelectorAll('#countdown .ec-digit').length === 4);
          const [d, h, m, s] = await page.$$eval('#countdown .ec-digit', (els) => els.map((e) => Number(e.textContent)));
          const countdownTarget = Date.now() + (((d * 24 + h) * 60 + m) * 60 + s) * 1000;

          const wrong = [];
          if (!ics.startsWith('BEGIN:VCALENDAR') || !ics.includes('\r\n')) wrong.push('not a CRLF iCalendar file');
          if (!ics.includes(ICS_START)) wrong.push(`.ics has ${ics.match(/DTSTART:\S+/)?.[0]}, expected ${ICS_START} (18:00 IST)`);
          if (!ics.includes(ICS_END)) wrong.push(`.ics has ${ics.match(/DTEND:\S+/)?.[0]}, expected ${ICS_END} (19:30 IST)`);
          const off = countdownTarget - START_MS;
          if (Math.abs(off) > 5000) wrong.push(`the countdown is ${(off / 3.6e6).toFixed(2)} h off the real start`);
          wrong.push(...await problems());
          assert(!wrong.length, wrong.join('\n'));
        } finally {
          await page.close();
        }
      });
    }

    /* ----------------------------------------------------- managing the event */
    console.log('\nadmin portal, managing the event');
    const toggleReads = (label) => admin.waitForFunction(
      (i, l) => document.querySelector(`#eventList [data-action="toggle"][data-id="${i}"]`)?.textContent.trim() === l,
      {}, id, label);
    const publicIds = () => admin.evaluate(() => fetch('/api/events?scope=upcoming')
      .then((r) => r.json()).then((d) => d.events.map((e) => String(e.id))));

    await check('edit: the drawer is pre-filled, and renaming keeps the poster and links', async () => {
      await admin.bringToFront();
      await admin.click(`#eventList [data-action="edit"][data-id="${id}"]`);
      await admin.waitForSelector('#drawer:not(.hidden)');
      const form = await admin.evaluate(() => {
        const v = (sel) => document.querySelector(sel).value;
        return {
          title: v('#title'), venue: v('#venue'), topics: v('#topics'), reg: v('#registrationLink'),
          mode: v('#mode'), start: v('#startTime'), end: v('#endTime'), date: v('#eventDate'),
          published: document.querySelector('#published').checked,
          poster: !document.querySelector('#posterPreview').classList.contains('hidden'),
        };
      });
      const expected = {
        title: TITLE, venue: 'PICT Main Auditorium', topics: 'Ethics, AI, Careers',
        reg: 'https://example.com/register', mode: 'Offline', start: '18:00', end: '19:30', date: future,
        published: true, poster: true,
      };
      for (const [key, value] of Object.entries(expected)) {
        assert(form[key] === value, `drawer ${key} = ${JSON.stringify(form[key])}, expected ${JSON.stringify(value)}`);
      }
      await admin.$eval('#title', (el) => { el.value = ''; });
      await admin.type('#title', 'E2E Event (edited)');
      await admin.click('#saveBtn');
      await toast(/Event updated/);
      await admin.waitForFunction(() => [...document.querySelectorAll('#eventList h3')]
        .some((h) => h.textContent === 'E2E Event (edited)'));
      const { event } = await admin.evaluate((i) => fetch(`/api/admin/events/${i}`).then((r) => r.json()), id);
      assert(event.posterPath && event.registrationLink === 'https://example.com/register'
        && event.venue === 'PICT Main Auditorium', `after the edit: ${JSON.stringify(event)}`);
    });

    await check('Unpublish hides it from the public API, and Publish brings it back', async () => {
      await admin.click(`#eventList [data-action="toggle"][data-id="${id}"]`);
      await toast(/Event unpublished/);
      await toggleReads('Publish');
      assert(!(await publicIds()).includes(id), 'still public after Unpublish');
      const s = await stats();
      assert(s === '1/1/0', `published/drafts/upcoming = ${s}`);
      await admin.click(`#eventList [data-action="toggle"][data-id="${id}"]`);
      await toast(/live on the site/);
      await toggleReads('Unpublish');
      assert((await publicIds()).includes(id), 'not public after Publish');
    });

    await check('the dashboard renders in dark mode without errors', async () => {
      await admin.evaluate(() => localStorage.setItem('ethicraft-theme', 'dark'));
      await admin.reload({ waitUntil: 'networkidle0' });
      await admin.waitForFunction(() => document.querySelectorAll('#eventList article').length === 2);
      assert(await admin.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'theme is not dark');
      await shot(admin, 'dashboard-dark');
      await admin.evaluate(() => localStorage.setItem('ethicraft-theme', 'light'));
      await admin.reload({ waitUntil: 'networkidle0' });
      await admin.waitForFunction(() => document.querySelectorAll('#eventList article').length === 2);
      const p = await adminProblems();
      assert(!p.length, p.join('\n'));
    });

    // Posters are cached for a day. A browser that already shows the old one
    // must still get the new one after a replacement.
    await check('a replaced poster shows everywhere the old one had already been seen', async () => {
      const thumb = `#eventList img[src^="/posters/${id}?"]`;
      const before = await dims(admin, thumb);
      const oldSrc = await admin.$eval(thumb, (img) => img.getAttribute('src'));
      await admin.click(`#eventList [data-action="edit"][data-id="${id}"]`);
      await admin.waitForSelector('#drawer:not(.hidden)');
      await (await admin.$('#poster')).uploadFile(OTHER_POSTER);
      await admin.waitForSelector('#posterPreview:not(.hidden)');
      await admin.click('#saveBtn');
      await toast(/Event updated/);
      const current = await admin.evaluate((i) => fetch(`/posters/${i}`, { cache: 'no-store' })
        .then((r) => r.blob()).then(createImageBitmap).then((b) => `${b.width}x${b.height}`), id);
      assert(current !== before, `the server still serves the old poster (${current})`);

      await admin.waitForFunction((sel, old) => document.querySelector(sel)?.getAttribute('src') !== old, {}, thumb, oldSrc);
      const shown = { 'the dashboard': await dims(admin, thumb) };
      await admin.reload({ waitUntil: 'networkidle0' });
      shown['the dashboard after a reload'] = await dims(admin, thumb);
      await home.bringToFront();
      await home.goto(`${base}/`, { waitUntil: 'networkidle0' });
      shown['the public hero'] = await dims(home, '#heroEvent img');
      await admin.bringToFront();

      const stale = Object.entries(shown)
        .filter(([, size]) => size !== current)
        .map(([where, size]) => `${where} still shows the old ${size} poster, not the new ${current} one`);
      assert(!stale.length, stale.join('\n'));
    });

    await check('Delete asks first: Cancel keeps the event, Confirm removes it and its poster', async () => {
      await admin.click(`#eventList [data-action="delete"][data-id="${id}"]`);
      await admin.waitForSelector('#confirm:not(.hidden)');
      await admin.click('#confirmCancel');
      await admin.waitForSelector('#confirm.hidden');
      assert(await admin.$(`#eventList [data-id="${id}"]`), 'the event vanished after Cancel');
      await admin.click(`#eventList [data-action="delete"][data-id="${id}"]`);
      await admin.waitForSelector('#confirm:not(.hidden)');
      await admin.click('#confirmOk');
      await toast(/Event deleted/);
      await admin.waitForFunction(() => document.querySelectorAll('#eventList article').length === 1);
      // Ask the server, not this browser's cache.
      const status = await admin.evaluate((i) => fetch(`/posters/${i}`, { cache: 'no-store' }).then((r) => r.status), id);
      assert(status === 404, `the server still serves the deleted event's poster: ${status}`);
      const p = await adminProblems([new RegExp(`/posters/${id}\\b`), /status of 404/]);
      assert(!p.length, p.join('\n'));
    });

    await check('Sign out returns to the login page and locks the dashboard again', async () => {
      await Promise.all([admin.waitForNavigation({ waitUntil: 'networkidle0' }), admin.click('#logoutBtn')]);
      assert(admin.url().endsWith(`${TEST_ADMIN.path}/login`), `after signing out: ${admin.url()}`);
      const me = await admin.evaluate(() => fetch('/api/admin/me').then((r) => r.status));
      assert(me === 401, `/api/admin/me -> ${me}`);
      await admin.goto(`${base}${TEST_ADMIN.path}`, { waitUntil: 'networkidle0' });
      assert(admin.url().endsWith('/login'), `the dashboard is reachable after signing out: ${admin.url()}`);
      const p = await adminProblems([/401/]);
      assert(!p.length, p.join('\n'));
    });

    /* ---------------------------------------------------------- other pages */
    console.log('\nother pages');

    await check('the 404 page renders cleanly', async () => {
      const page = await ctx.newPage();
      const problems = await instrument(page, base);
      const res = await page.goto(`${base}/no-such-page`, { waitUntil: 'networkidle0' });
      assert(res.status() === 404, `status ${res.status()}`);
      const p = await problems([/HTTP 404 GET \S+\/no-such-page$/, /status of 404/]);
      await page.close();
      assert(!p.length, p.join('\n'));
    });

    await check('on a 375px phone the nav menu opens and closes, with no errors', async () => {
      const page = await ctx.newPage();
      const problems = await instrument(page, base, { viewport: { width: 375, height: 667, isMobile: true, hasTouch: true } });
      await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
      assert(await page.$eval('#mobileMenu', (el) => el.classList.contains('hidden')), 'the menu starts open');
      await page.tap('#navToggle');
      await page.waitForSelector('#mobileMenu:not(.hidden)');
      assert(await page.$eval('#navToggle', (el) => el.getAttribute('aria-expanded')) === 'true', 'aria-expanded not updated');
      await shot(page, 'mobile-menu');
      await page.tap('#navToggle');
      await page.waitForSelector('#mobileMenu.hidden');
      const p = await problems();
      await page.close();
      assert(!p.length, p.join('\n'));
    });
  } finally {
    await browser?.close();
    await server.stop();
  }

  if (thirdParty.size) {
    console.log(`\n  third-party problems (not counted as failures):\n    ${[...thirdParty].join('\n    ')}`);
  }
  const where = `Screenshots: ${path.relative(ROOT, SHOTS)}/`;
  console.log(failures ? `\n  ${failures} check(s) failed. ${where}\n` : `\n  All browser checks passed. ${where}\n`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
