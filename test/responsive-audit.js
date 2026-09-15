'use strict';

/**
 * Drives a real browser across real device viewports and reports layout faults
 * that static inspection cannot catch: horizontal overflow, elements wider than
 * the screen, tap targets below the 44px minimum, and unreadable text.
 *
 *   node test/responsive-audit.js [baseUrl]
 */
const puppeteer = require('puppeteer');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] || 'http://localhost:3000';
const SHOTS = path.join(__dirname, '..', '.audit-shots');

const DEVICES = [
  { name: 'iPhone SE',        width: 375,  height: 667,  dsf: 2, mobile: true },
  { name: 'iPhone 14 Pro',    width: 393,  height: 852,  dsf: 3, mobile: true },
  { name: 'Pixel 7',          width: 412,  height: 915,  dsf: 2.6, mobile: true },
  { name: 'iPhone 14 Pro Max',width: 430,  height: 932,  dsf: 3, mobile: true },
  { name: 'Galaxy Fold (narrow)', width: 320, height: 653, dsf: 2, mobile: true },
  { name: 'iPad mini',        width: 768,  height: 1024, dsf: 2, mobile: true },
  { name: 'iPad Pro 11',      width: 834,  height: 1194, dsf: 2, mobile: true },
  { name: 'iPad Pro 12.9',    width: 1024, height: 1366, dsf: 2, mobile: true },
  { name: 'Laptop',           width: 1280, height: 800,  dsf: 2, mobile: false },
  { name: 'Desktop',          width: 1440, height: 900,  dsf: 2, mobile: false },
  { name: 'Wide',             width: 1920, height: 1080, dsf: 1, mobile: false },
];

const PAGES = [
  { path: '/', name: 'home' },
  { path: `${require('./helpers').TEST_ADMIN.path}/login`, name: 'login' },
  { path: '/no-such-page', name: '404' },
];

/** Runs inside the page: finds everything that breaks the viewport. */
function collectFaults() {
  const vw = document.documentElement.clientWidth;
  const faults = [];

  const scrollW = document.documentElement.scrollWidth;
  if (scrollW > vw + 1) {
    faults.push({ type: 'page-overflow', detail: `page scrolls horizontally: ${scrollW}px content in a ${vw}px viewport` });
  }

  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 90);
  };

  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    // Ignore things deliberately clipped by an ancestor (marquee, bignum).
    let clipped = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.overflow === 'hidden' || ps.overflowX === 'hidden') { clipped = true; break; }
    }
    if (clipped) continue;

    if (r.right > vw + 2 || r.left < -2) {
      faults.push({ type: 'element-overflow', detail: `${describe(el)} spans ${Math.round(r.left)}..${Math.round(r.right)} outside 0..${vw}` });
    }
  }

  // Tap targets: WCAG 2.5.8 asks for 24px minimum; 44px is the usable floor.
  for (const el of document.querySelectorAll('a[href], button, input, select, [role="tab"]')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    // Skip links are 1px by design until focused.
    if (el.classList.contains('sr-only')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.height < 24 || r.width < 24) {
      faults.push({ type: 'tap-target', detail: `${describe(el)} is ${Math.round(r.width)}x${Math.round(r.height)}px` });
    }
  }

  // Body copy below 12px is unreadable on a phone.
  for (const el of document.querySelectorAll('p, li, dd, dt, span, a')) {
    if (!el.textContent.trim()) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size && size < 11) {
      faults.push({ type: 'tiny-text', detail: `${describe(el)} at ${size.toFixed(1)}px` });
    }
  }

  return faults;
}

(async () => {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let total = 0;
  const seen = new Set();

  for (const device of DEVICES) {
    for (const spec of PAGES) {
      const page = await browser.newPage();
      await page.setViewport({
        width: device.width, height: device.height,
        deviceScaleFactor: 1, isMobile: device.mobile, hasTouch: device.mobile,
      });
      await page.goto(`${BASE}${spec.path}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await new Promise((r) => setTimeout(r, 450));   // let reveals settle

      const faults = await page.evaluate(collectFaults);
      if (faults.length) {
        console.log(`\n  ${device.name} (${device.width}px) — ${spec.name}`);
        for (const f of faults) {
          const key = `${f.type}|${f.detail}`;
          if (seen.has(key)) continue;
          seen.add(key);
          console.log(`    [${f.type}] ${f.detail}`);
          total += 1;
        }
      }

      if (spec.name === 'home') {
        await page.screenshot({
          path: path.join(SHOTS, `${device.width}-${spec.name}.png`),
          fullPage: device.width <= 834,
        });
      }
      await page.close();
    }
  }

  await browser.close();
  console.log(total === 0
    ? `\n  No layout faults across ${DEVICES.length} viewports x ${PAGES.length} pages.\n`
    : `\n  ${total} distinct fault(s) found.\n`);
  process.exit(total === 0 ? 0 : 1);
})();
