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
// 1600px wide: bigger than the 1440px the gallery stores, so the upload shows
// whether the browser really resized it.
const BIG_PHOTO = path.join(ROOT, 'test', 'fixtures', 'big-photo.jpg');
const REGISTER = 'https://tinyurl.com/ethicraftpict';

let failures = 0;
const thirdParty = new Set();

// The step a long check is on, so a timeout says where it stalled.
let currentStep = '';
const step = (label) => { currentStep = label; };

async function check(name, fn) {
  currentStep = '';
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures += 1;
    const where = currentStep ? ` (at: ${currentStep})` : '';
    console.log(`  ✖ ${name}\n      ${`${err.message}${where}`.split('\n').join('\n      ')}`);
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

    await check('the nav shows the day logo by day and the night logo by night', async () => {
      const shown = () => home.$$eval('#nav img', (imgs) => imgs
        .filter((img) => getComputedStyle(img).display !== 'none').map((img) => img.getAttribute('src')));
      const theme = await home.evaluate(() => document.documentElement.dataset.theme);
      const first = await shown();
      const expected = `/assets/logo-${theme === 'dark' ? 'night' : 'day'}.webp`;
      assert(first.length === 1 && first[0] === expected, `${theme} theme shows ${JSON.stringify(first)}`);
      await (await visible(home, '[data-theme-toggle]')).click();
      const flipped = await shown();
      assert(flipped.length === 1 && flipped[0] !== expected, `after toggling: ${JSON.stringify(flipped)}`);
      await (await visible(home, '[data-theme-toggle]')).click();   // put it back
    });

    await check('the past-activities strip moves, and its photos open in the lightbox', async () => {
      await home.evaluate(() => window.scrollTo(0, 0));
      await home.mouse.move(5, 700);   // hovering the strip pauses it
      const track = () => home.$eval('#activityStrip .ec-strip__track', (el) => ({
        items: el.children.length,
        animation: getComputedStyle(el).animationName,
        x: el.getBoundingClientRect().x,
      }));
      const a = await track();
      assert(a.items >= 12 && a.animation === 'ec-marquee', `strip: ${JSON.stringify(a)}`);
      await new Promise((r) => setTimeout(r, 700));
      const b = await track();
      assert(b.x < a.x, `the strip is not moving (${a.x} -> ${b.x})`);

      await home.click('#activityStrip .js-photo');
      await home.waitForSelector('#lightbox:not(.hidden)');
      const caption = await home.$eval('#lightboxCaption', (el) => el.textContent);
      assert(/\d+ \/ \d+/.test(caption), `caption: "${caption}"`);
      const firstSrc = await home.$eval('#lightboxImg', (img) => img.src);
      await home.keyboard.press('ArrowRight');
      assert(await home.$eval('#lightboxImg', (img) => img.src) !== firstSrc, 'ArrowRight should move on');
      await home.keyboard.press('Escape');
      await home.waitForSelector('#lightbox.hidden');
    });

    await check('the gallery opens any photo in a lightbox you can step through', async () => {
      const count = await home.$$eval('#galleryGrid .js-photo', (els) => els.length);
      assert(count >= 12, `${count} photos in the gallery`);
      const tile = await home.$('#galleryGrid .js-photo:nth-child(3)');
      await tile.scrollIntoView();
      await tile.click();
      await home.waitForSelector('#lightbox:not(.hidden)');
      const caption = () => home.$eval('#lightboxCaption', (el) => el.textContent);
      assert((await caption()).endsWith(`3 / ${count}`), `caption: "${await caption()}"`);
      assert(await home.$eval('#lightboxPrev', (el) => !el.classList.contains('hidden')), 'no previous button');
      await home.click('#lightboxPrev');
      assert((await caption()).endsWith(`2 / ${count}`), `after Previous: "${await caption()}"`);
      await home.waitForFunction(() => {
        const img = document.querySelector('#lightboxImg');
        return img.complete && img.naturalWidth > 0;
      });
      await home.keyboard.press('Escape');
      await home.waitForSelector('#lightbox.hidden');
      const p = await homeProblems();
      assert(!p.length, p.join('\n'));
    });

    await check('the lightbox keeps keyboard focus inside, and hands it back on close', async () => {
      const tile = await home.$('#galleryGrid .js-photo:nth-child(2)');
      await tile.focus();
      await home.keyboard.press('Enter');
      await home.waitForSelector('#lightbox:not(.hidden)');
      const focused = () => home.evaluate(() => document.activeElement.id || document.activeElement.tagName);
      const shiftTab = async () => {
        await home.keyboard.down('Shift');
        await home.keyboard.press('Tab');
        await home.keyboard.up('Shift');
      };
      assert(await focused() === 'lightboxClose', `opened with focus on ${await focused()}`);
      const order = [];
      for (let i = 0; i < 4; i++) {
        await home.keyboard.press('Tab');
        order.push(await focused());
      }
      assert(order.join(' ') === 'lightboxPrev lightboxNext lightboxClose lightboxPrev', `Tab went ${order.join(' → ')}`);
      await shiftTab();
      await shiftTab();
      assert(await focused() === 'lightboxNext', `Shift+Tab from the first button went to ${await focused()}`);
      await home.keyboard.press('Escape');
      await home.waitForSelector('#lightbox.hidden');
      assert(await home.evaluate((el) => document.activeElement === el, tile), 'focus did not return to the photo');
    });

    await check('"Join the club" and "Register now" open the registration form in a new tab', async () => {
      const targets = await home.$$eval(`a[href="${REGISTER}"]`, (els) => els.map((a) => a.target));
      assert(targets.length >= 3 && targets.every((t) => t === '_blank'), `links: ${JSON.stringify(targets)}`);
      const join = await home.$eval('#join', (el) => el.textContent.replace(/\s+/g, ' '));
      assert(/Register now/.test(join) && !/Email us to join/.test(join), join);
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

    await check('the drawer keeps keyboard focus inside, and Escape hands it back', async () => {
      await admin.focus('#newEventBtn');
      await admin.keyboard.press('Enter');
      await admin.waitForSelector('#drawer:not(.hidden)');
      assert(await admin.evaluate(() => document.activeElement?.id) === 'title', 'the title field should take focus');
      for (let i = 1; i <= 40; i++) {
        await admin.keyboard.press('Tab');
        assert(await admin.evaluate(() => document.querySelector('#drawer').contains(document.activeElement)),
          `focus left the open drawer after ${i} Tabs`);
      }
      await admin.keyboard.press('Escape');
      await admin.waitForSelector('#drawer.hidden');
      assert(await admin.evaluate(() => document.activeElement?.id) === 'newEventBtn',
        'focus did not return to "New event"');
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

      // The poster gets its own band, as large as the window allows: the full
      // width for a landscape poster, the full height for a portrait one.
      await home.$eval('#featured', (el) => el.scrollIntoView());
      await dims(home, '#featuredImg');
      const featured = await home.evaluate(() => {
        const box = document.querySelector('#featuredImg').getBoundingClientRect();
        return {
          hidden: document.querySelector('#featured').classList.contains('hidden'),
          title: document.querySelector('#featuredTitle').textContent,
          w: Math.round(box.width), h: Math.round(box.height),
          vw: document.documentElement.clientWidth, vh: window.innerHeight,
        };
      });
      assert(!featured.hidden && featured.title === TITLE, `featured band: ${JSON.stringify(featured)}`);
      assert(featured.w >= featured.vw * 0.8 || featured.h >= featured.vh * 0.8,
        `poster only ${featured.w}x${featured.h} in a ${featured.vw}x${featured.vh} window`);

      // A lone upcoming event fills the row rather than sitting in one column.
      const span = await home.evaluate(() => {
        const cards = document.querySelectorAll('#eventsGrid article');
        return { cards: cards.length, ratio: cards[0].offsetWidth / document.querySelector('#eventsGrid').offsetWidth };
      });
      assert(span.cards === 1 && span.ratio > 0.95, `lone card spans ${Math.round(span.ratio * 100)}% of the grid`);

      // The join section fans out real photos above its button.
      const prints = await home.$$eval('#joinPhotos .ec-polaroid img', (imgs) => imgs.map((i) => i.getAttribute('src')));
      assert(prints.length === 5 && prints.every((src) => /^\/photos\/\d+\/thumb/.test(src)), `join photos: ${prints.join(', ')}`);

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
      shown['the featured poster'] = await dims(home, '#featuredImg');
      await admin.bringToFront();

      const stale = Object.entries(shown)
        .filter(([, size]) => size !== current)
        .map(([where, size]) => `${where} still shows the old ${size} poster, not the new ${current} one`);
      assert(!stale.length, stale.join('\n'));
    });

    await check('Delete asks first: Cancel keeps the event, Confirm removes it and its poster', async () => {
      await admin.click(`#eventList [data-action="delete"][data-id="${id}"]`);
      await admin.waitForSelector('#confirm:not(.hidden)');
      // Focus starts on Cancel, so a stray Enter cannot delete, and Tab stays in the box.
      assert(await admin.evaluate(() => document.activeElement?.id) === 'confirmCancel', 'the box should open on Cancel');
      for (let i = 1; i <= 3; i++) {
        await admin.keyboard.press('Tab');
        assert(await admin.evaluate(() => document.querySelector('#confirm').contains(document.activeElement)),
          `focus left the confirm box after ${i} Tabs`);
      }
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

    await check('a programme over several days stays "on now" until its last day', async () => {
      const start = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
      const end = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
      await admin.bringToFront();
      await admin.click('#newEventBtn');
      await admin.waitForSelector('#drawer:not(.hidden)');
      await admin.type('#title', 'E2E Programme');
      await admin.$eval('#eventDate', (el, v) => { el.value = v; }, start);
      await admin.$eval('#endDate', (el, v) => { el.value = v; }, end);
      await admin.select('#mode', 'Offline');
      await admin.$eval('#published', (el) => { el.checked = true; });
      await admin.click('#saveBtn');
      await toast(/Event created/);
      await admin.waitForFunction(() => [...document.querySelectorAll('#eventList h3')].some((h) => h.textContent === 'E2E Programme'));
      const row = await rowFor('E2E Programme');
      assert(!/Past/.test(row.text), `started 3 days ago, yet marked past: ${row.text}`);

      await home.bringToFront();
      await home.goto(`${base}/`, { waitUntil: 'networkidle0' });
      await gridReady(home);
      await home.waitForFunction(() => /ON NOW · UNTIL/.test(document.querySelector('#countdown')?.textContent || ''));
      const hero = await home.$eval('#heroEvent', (el) => el.textContent.replace(/\s+/g, ' '));
      assert(/HAPPENING NOW/.test(hero) && hero.includes('E2E Programme'), `hero: ${hero}`);
      const card = await home.evaluate(() => [...document.querySelectorAll('#eventsGrid article')]
        .find((a) => a.textContent.includes('E2E Programme'))?.textContent.replace(/\s+/g, ' '));
      assert(card && /Dates/.test(card) && /to \d{2} [A-Z][a-z]{2}/.test(card), `card: ${card}`);
      const p = await homeProblems();
      assert(!p.length, p.join('\n'));

      await admin.bringToFront();
      await admin.click(`#eventList [data-action="delete"][data-id="${row.id}"]`);
      await admin.waitForSelector('#confirm:not(.hidden)');
      await admin.click('#confirmOk');
      await toast(/Event deleted/);
    });

    await check('FY calendar: an entry added in the dashboard appears on /calendar, as text', async () => {
      const CAL_TITLE = 'E2E <img src=x onerror="window.__xss=1"> Orientation';
      step('opening the calendar tab');
      await admin.click('#tab-calendar');
      await admin.waitForFunction(() => document.querySelectorAll('#entryList article').length >= 17);
      step('opening the entry drawer');
      await admin.click('#newEntryBtn');
      await admin.waitForSelector('#calDrawer:not(.hidden)');
      await admin.type('#entryTitle', CAL_TITLE);
      await admin.type('#entryLabel', 'Workshop');
      await admin.$eval('#entryStartDate', (el, v) => { el.value = v; }, future);
      await admin.$eval('#entryStartTime', (el) => { el.value = '10:00'; });
      await admin.$eval('#entryEndTime', (el) => { el.value = '12:30'; });
      await admin.type('#entryDetails', 'Seminar Hall, A Wing');
      step('saving the entry');
      await admin.click('#calSave');
      await toast(/added to the calendar/);
      step('waiting for the entry in the dashboard list');
      await admin.waitForFunction((t) => [...document.querySelectorAll('#entryList h3')].some((h) => h.textContent === t), {}, CAL_TITLE);

      const page = await ctx.newPage();
      const problems = await instrument(page, base);
      try {
        step('loading /calendar');
        await page.goto(`${base}/calendar`, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => document.querySelector('#calendarRoot').getAttribute('aria-busy') === 'false');
        // The page opens on this academic year; switch if the entry falls in another.
        const [y, m] = future.split('-').map(Number);
        const year = await page.$(`#calYears [data-year="${m >= 7 ? y : y - 1}"]`);
        if (year) await year.click();
        const row = await page.evaluate((t) => [...document.querySelectorAll('#calendarRoot h3')]
          .find((h) => h.textContent === t)?.closest('li').textContent.replace(/\s+/g, ' '), CAL_TITLE);
        assert(row, 'the new entry is missing from /calendar');
        assert(/10\.00 AM – 12\.30 PM IST/.test(row) && /Workshop/.test(row) && /Seminar Hall/.test(row), row);
        assert(await page.evaluate(() => window.__xss) === undefined, 'markup in a calendar title EXECUTED');
        const p = await problems();
        assert(!p.length, p.join('\n'));
        await shot(page, 'calendar');
      } finally {
        await page.close();
      }

      await admin.bringToFront();
      step('deleting the entry');
      const id = await admin.evaluate((t) => [...document.querySelectorAll('#entryList article')]
        .find((a) => a.querySelector('h3').textContent === t).querySelector('[data-entry-action="delete"]').dataset.id, CAL_TITLE);
      await admin.click(`#entryList [data-entry-action="delete"][data-id="${id}"]`);
      await admin.waitForSelector('#confirm:not(.hidden)');
      await admin.click('#confirmOk');
      await toast(/Entry deleted/);
      step('waiting for the entry to leave the list');
      await admin.waitForFunction((t) => ![...document.querySelectorAll('#entryList h3')].some((h) => h.textContent === t), {}, CAL_TITLE);
    });

    await check('Gallery: an upload is resized in the browser, then captioned, put in the strip and deleted', async () => {
      await admin.click('#tab-gallery');
      await admin.waitForFunction(() => document.querySelectorAll('#photoGrid article').length >= 12);
      const before = await admin.$$eval('#photoGrid article', (els) => els.length);
      await (await admin.$('#photoInput')).uploadFile(BIG_PHOTO);
      await toast(/1 photo added/);
      await admin.waitForFunction((n) => document.querySelectorAll('#photoGrid article').length === n + 1, {}, before);
      const id = await admin.$eval('#photoGrid article', (el) => el.dataset.photoId);   // newest leads

      const stored = await admin.evaluate(async (photoId) => {
        const { photos } = await (await fetch('/api/photos')).json();
        const p = photos.find((x) => String(x.id) === photoId);
        const [full, thumb] = await Promise.all([fetch(p.src), fetch(p.thumb)].map(async (r) => (await r).blob()));
        return { w: p.width, h: p.height, full: full.size, thumb: thumb.size, type: full.type };
      }, id);
      assert(Math.max(stored.w, stored.h) === 1440, `a 1600px photo was stored at ${stored.w}x${stored.h}`);
      assert(stored.type === 'image/jpeg' && stored.thumb < stored.full, JSON.stringify(stored));

      const tile = `#photoGrid [data-photo-id="${id}"]`;
      await admin.click(`${tile} [data-photo-caption]`);
      await admin.type(`${tile} [data-photo-caption]`, 'E2E caption');
      await admin.keyboard.press('Enter');
      await toast(/Caption saved/);
      await admin.click(`${tile} [data-photo-strip]`);
      await toast(/Now in the moving strip/);

      const page = await ctx.newPage();
      const problems = await instrument(page, base);
      try {
        await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
        await page.waitForFunction((photoId) => [...document.querySelectorAll('#activityStrip img')]
          .some((img) => img.getAttribute('src').startsWith(`/photos/${photoId}/thumb`)), {}, id);
        const first = await page.$eval('#galleryGrid .js-photo', (el) => el.getAttribute('aria-label'));
        assert(first.startsWith('E2E caption'), `first gallery photo: ${first}`);
        const p = await problems();
        assert(!p.length, p.join('\n'));
      } finally {
        await page.close();
      }

      await admin.bringToFront();
      await admin.click(`${tile} [data-photo-delete]`);
      await admin.waitForSelector('#confirm:not(.hidden)');
      await admin.click('#confirmOk');
      await toast(/Photo deleted/);
      await admin.waitForFunction((n) => document.querySelectorAll('#photoGrid article').length === n, {}, before);
      const p = await adminProblems();
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

    await check('the FY calendar page lays the schedule out by month', async () => {
      const page = await ctx.newPage();
      const problems = await instrument(page, base);
      try {
        await page.goto(`${base}/calendar`, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => document.querySelector('#calendarRoot').getAttribute('aria-busy') === 'false');
        const info = await page.evaluate(() => ({
          year: document.querySelector('#calYearTitle').textContent,
          months: [...document.querySelectorAll('#calendarRoot h2')].map((h) => h.textContent),
          rows: document.querySelectorAll('#calendarRoot li').length,
          current: document.querySelector('#nav [aria-current]')?.textContent.trim(),
        }));
        assert(/^\d{4}–\d{2}$/.test(info.year), `year label: ${info.year}`);
        assert(info.months.includes('October 2026') && info.months.includes('November 2026'), info.months.join(', '));
        assert(info.rows >= 17, `${info.rows} entries`);
        assert(info.current === 'FY Calendar', `nav marks ${info.current} as current`);

        // The spotlight names what is on today or next, unless the year is over.
        const anyAhead = await page.evaluate(() => {
          const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
          return fetch('/api/calendar').then((r) => r.json())
            .then(({ entries }) => entries.some((e) => (e.endDate || e.startDate) >= today));
        });
        const spotlight = await page.$eval('#calOverview', (el) => el.textContent.replace(/\s+/g, ' '));
        assert(!anyAhead || /NEXT UP|ON TODAY/.test(spotlight), `spotlight: ${spotlight.slice(0, 120)}`);

        // A track chip narrows the timeline to that track, and All brings it back.
        await page.click('[data-track="Technical Track"]');
        const labels = await page.$$eval('#calendarRoot li .ec-chip:first-child', (els) => [...new Set(els.map((e) => e.textContent.trim()))]);
        assert(labels.length === 1 && labels[0] === 'Technical Track', `filtered labels: ${labels.join(', ')}`);
        assert(await page.$eval('[data-track="Technical Track"]', (b) => b.getAttribute('aria-pressed')) === 'true');
        await page.click('[data-track=""]');
        assert(await page.$$eval('#calendarRoot li', (els) => els.length) === info.rows, 'All restores every entry');
        const p = await problems();
        assert(!p.length, p.join('\n'));
      } finally {
        await page.close();
      }
    });

    await check('pages hold still while their data loads, on a slow connection (CLS under 0.1)', async () => {
      const shifts = [];
      for (const [where, viewport] of [
        ['/calendar', { width: 390, height: 844 }], ['/calendar', { width: 1280, height: 800 }],
        ['/', { width: 390, height: 844 }], ['/', { width: 1280, height: 800 }],
      ]) {
        const page = await ctx.newPage();
        try {
          await page.setViewport(viewport);
          // A phone on a middling connection: data that lands after the first
          // paint is what makes a page jump.
          const cdp = await page.createCDPSession();
          await cdp.send('Network.emulateNetworkConditions', {
            offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8,
          });
          await page.evaluateOnNewDocument(() => {
            window.__cls = 0;
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__cls += entry.value;
            }).observe({ type: 'layout-shift', buffered: true });
          });
          await page.goto(`${base}${where}`, { waitUntil: 'networkidle0', timeout: 60000 });
          await new Promise((resolve) => setTimeout(resolve, 500));
          const cls = await page.evaluate(() => window.__cls);
          if (cls >= 0.1) shifts.push(`${where} at ${viewport.width}px: ${cls.toFixed(3)}`);
        } finally {
          await page.close();
        }
      }
      assert(!shifts.length, `layout shift: ${shifts.join(', ')}`);
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
      await page.keyboard.press('Escape');
      await page.waitForSelector('#mobileMenu.hidden');
      assert(await page.evaluate(() => document.activeElement?.id) === 'navToggle',
        'Escape should hand focus back to the menu button');
      await page.tap('#navToggle');
      await page.waitForSelector('#mobileMenu:not(.hidden)');
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
