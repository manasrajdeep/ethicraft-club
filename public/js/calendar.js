/* EthiCraft Club — FY calendar page.
   Lays /api/calendar out by academic year (July to June) and month, as a
   timeline coloured by track, under a "next up" spotlight. "Today" is the
   club's own date in IST, wherever the visitor happens to be. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const root = $('#calendarRoot');
  if (!root) return;

  /** Escapes text before it goes anywhere near innerHTML. */
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  const SHORT = MONTHS.map((m) => m.slice(0, 3));
  const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  /** Today in IST as YYYY-MM-DD ('en-CA' formats dates that way). */
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

  /** Academic years run July to June: 2026-10-12 and 2027-03-01 both belong to 2026–27. */
  const academicYear = (iso) => {
    const [y, m] = iso.split('-').map(Number);
    return m >= 7 ? y : y - 1;
  };
  const yearLabel = (ay) => `${ay}–${String(ay + 1).slice(2)}`;

  const parts = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return { y, m, d, weekday: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] };
  };

  const lastDay = (entry) => entry.endDate || entry.startDate;
  const pad = (n) => String(n).padStart(2, '0');

  /** '17:15' -> '5.15 pm', the club's own style. */
  function formatTime(hhmm) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    if (Number.isNaN(h)) return '';
    return `${h % 12 === 0 ? 12 : h % 12}.${pad(m)} ${h >= 12 ? 'pm' : 'am'}`;
  }

  function timeText(entry) {
    const start = formatTime(entry.startTime);
    const end = formatTime(entry.endTime);
    if (start && end) return `${start} – ${end} IST`;
    return start ? `${start} IST` : '';
  }

  /** 'MON 12 OCT 2026', or '12 OCT – 7 NOV 2026' for a range. */
  function dateText(entry) {
    const s = parts(entry.startDate);
    if (!entry.endDate) return `${s.weekday} ${s.d} ${SHORT[s.m - 1]} ${s.y}`.toUpperCase();
    const e = parts(entry.endDate);
    return `${s.d} ${SHORT[s.m - 1]} – ${e.d} ${SHORT[e.m - 1]} ${e.y}`.toUpperCase();
  }

  /** When an entry starts, as an instant: its date and time in IST. */
  const startsAt = (entry) => new Date(`${entry.startDate}T${entry.startTime || '00:00'}:00+05:30`);

  /* ---------------------------------------------------------------- tracks */

  /**
   * A track keeps one colour all year, so the eye can follow it down the page.
   * Each colour is a token name, used for the timeline dot and card edge, and
   * a matching chip.
   */
  const KNOWN = {
    'wisdom track': ['--brand-magenta', 'bg-magenta-brand/12 text-magenta-brand'],
    'technical track': ['--brand-sky', 'bg-sky-brand/12 text-sky-dark'],
  };
  const PALETTE = [
    ['--brand-amber', 'bg-amber-brand/18 text-amber-deep'],
    ['--brand-magenta', 'bg-magenta-brand/12 text-magenta-brand'],
    ['--brand-sky', 'bg-sky-brand/12 text-sky-dark'],
  ];
  function trackOf(label) {
    const key = (label || '').toLowerCase();
    if (KNOWN[key]) return KNOWN[key];
    let hash = 0;
    for (const c of key) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    return PALETTE[hash % PALETTE.length];
  }
  const trackStyle = (label) => `--track: var(${trackOf(label)[0]})`;

  /* ---------------------------------------------------------------- rows */

  function dateBlock(entry) {
    const s = parts(entry.startDate);
    if (!entry.endDate) {
      return `<span class="block font-display text-2xl font-black leading-none">${s.d}</span>
              <span class="mt-1 block text-[11px] font-bold uppercase tracking-[0.12em] ec-date-accent">${s.weekday}</span>`;
    }
    const e = parts(entry.endDate);
    return e.m === s.m
      ? `<span class="block font-display text-xl font-black leading-none">${s.d}–${e.d}</span>
         <span class="mt-1 block text-[11px] font-bold uppercase tracking-[0.12em] ec-date-accent">${SHORT[s.m - 1]}</span>`
      : `<span class="block font-display text-xl font-black leading-none">${s.d}</span>
         <span class="mt-1 block text-[11px] font-bold uppercase tracking-[0.06em] ec-date-accent">to ${e.d} ${SHORT[e.m - 1]}</span>`;
  }

  function row(entry, next) {
    const past = lastDay(entry) < today;
    const isToday = entry.startDate <= today && today <= lastDay(entry);
    const badge = isToday
      ? '<span class="ec-chip bg-amber-brand text-deep2">TODAY</span>'
      : entry === next ? '<span class="ec-chip bg-deep text-ondeep">NEXT UP</span>' : '';
    const time = timeText(entry);
    return `
      <li class="ec-tl-item ${past ? 'is-past' : ''} ${isToday ? 'is-today' : ''}" style="${trackStyle(entry.label)}">
        <div class="ec-tl-card flex gap-4 rounded-2xl bg-surface p-4 shadow-sm sm:gap-5 sm:p-5 ${isToday ? 'ring-2 ring-amber-brand' : 'ring-1 ring-line'} ${past ? 'opacity-60' : ''}">
          <div class="w-16 shrink-0 self-start rounded-xl bg-surface2 px-2 py-2.5 text-center text-ink">${dateBlock(entry)}</div>
          <div class="min-w-0 flex-1 sm:flex sm:items-start sm:justify-between sm:gap-6">
            <div class="min-w-0">
              ${entry.label || badge ? `<div class="flex flex-wrap items-center gap-2">
                ${entry.label ? `<span class="ec-chip ${trackOf(entry.label)[1]}">${esc(entry.label)}</span>` : ''}
                ${badge}
              </div>` : ''}
              <h3 class="mt-2 font-display text-lg font-bold leading-snug text-ink">${esc(entry.title)}</h3>
              ${entry.details ? `<p class="mt-1.5 text-sm leading-relaxed text-muted">${esc(entry.details)}</p>` : ''}
              ${entry.link ? `<a href="${esc(entry.link)}" target="_blank" rel="noopener noreferrer"
                                 class="ec-taplink text-sm font-bold text-sky-dark hover:underline">Details ↗</a>` : ''}
            </div>
            ${time ? `<p class="ec-label mt-2 shrink-0 text-ink/70 sm:mt-1.5 sm:text-right">${esc(time.toUpperCase())}</p>` : ''}
          </div>
        </div>
      </li>`;
  }

  /* -------------------------------------------------------------- overview */

  function renderStats(inYear, next) {
    const host = $('#calStats');
    if (!host) return;
    const done = inYear.filter((e) => lastDay(e) < today).length;
    const tracks = new Set(inYear.map((e) => e.label).filter(Boolean)).size;
    const cells = [
      ['ENTRIES', pad(inYear.length)],
      ['TRACKS', pad(tracks)],
      ['DONE', `${pad(done)} / ${pad(inYear.length)}`],
      ['NEXT', next ? `${parts(next.startDate).d} ${SHORT[parts(next.startDate).m - 1]}`.toUpperCase() : '—'],
    ];
    host.innerHTML = cells.map(([key, value]) => `
      <span class="ec-label text-ondeep/60">${key} <span class="ml-1.5 font-semibold text-white">${esc(value)}</span></span>`).join('');
    host.classList.remove('invisible');
  }

  let countdownTimer = null;

  /** The spotlight: what is on today, else what comes next, with a countdown. */
  function renderSpotlight(inYear, next) {
    clearInterval(countdownTimer);
    const todays = inYear.find((e) => e.startDate <= today && today <= lastDay(e));
    const entry = todays || next;
    if (!entry) return '';

    const done = inYear.filter((e) => lastDay(e) < today).length;
    const pct = inYear.length ? Math.round((done / inYear.length) * 100) : 0;
    const time = timeText(entry);
    return `
      <article class="relative overflow-hidden rounded-3xl bg-deep p-6 text-white shadow-xl sm:p-9" style="${trackStyle(entry.label)}">
        <div class="ec-mesh" aria-hidden="true"></div>
        <div class="relative grid gap-7 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div class="min-w-0">
            <p class="ec-label flex items-center gap-2 text-amber-brand">
              <span class="ec-status text-amber-brand"></span> ${todays ? 'ON TODAY' : 'NEXT UP'}
            </p>
            <p class="mt-4 font-display text-3xl font-bold leading-tight sm:text-4xl">${esc(entry.title)}</p>
            <p class="ec-label mt-3 text-ondeep/70">${esc(dateText(entry))}${time ? ` · ${esc(time.toUpperCase())}` : ''}</p>
            ${entry.details ? `<p class="mt-3 max-w-xl text-sm leading-relaxed text-ondeep/75">${esc(entry.details)}</p>` : ''}
            ${entry.label ? `<span class="ec-chip mt-4 bg-white/10 text-white ring-1 ring-inset ring-white/15">
              <span class="ec-filter__dot"></span>${esc(entry.label)}</span>` : ''}
          </div>
          <div id="calCountdown" class="grid grid-cols-3 gap-2" aria-live="off"></div>
        </div>
        <div class="relative mt-8">
          <div class="flex items-center justify-between gap-4">
            <span class="ec-label text-ondeep/60">THE YEAR SO FAR</span>
            <span class="ec-label text-ondeep/70">${pad(done)} OF ${pad(inYear.length)} DONE</span>
          </div>
          <div class="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div class="h-full rounded-full" style="width:${Math.max(pct, 2)}%;background:linear-gradient(90deg,rgb(var(--brand-amber)),rgb(var(--brand-magenta)),rgb(var(--brand-sky)))"></div>
          </div>
        </div>
      </article>`;
  }

  function startCountdown(entry, isToday) {
    const host = $('#calCountdown');
    if (!host || !entry) return;
    const cell = (value, label) => `
      <div class="text-center">
        <div class="ec-digit rounded-lg bg-white/10 px-3 py-2 text-2xl font-bold ring-1 ring-inset ring-white/15 sm:text-3xl">${value}</div>
        <div class="ec-label mt-1.5 text-ondeep/60">${label}</div>
      </div>`;
    const tick = () => {
      const ms = startsAt(entry).getTime() - Date.now();
      if (isToday || ms <= 0) {
        host.className = '';
        host.innerHTML = '';
        clearInterval(countdownTimer);
        return;
      }
      const mins = Math.floor(ms / 60000);
      host.innerHTML = cell(pad(Math.floor(mins / 1440)), 'DAYS') + cell(pad(Math.floor((mins % 1440) / 60)), 'HRS')
        + cell(pad(mins % 60), 'MIN');
    };
    tick();
    countdownTimer = setInterval(tick, 30000);
  }

  function renderFilters(inYear, active) {
    const counts = new Map();
    for (const e of inYear) if (e.label) counts.set(e.label, (counts.get(e.label) || 0) + 1);
    if (counts.size < 2) return '';
    const chip = (label, count, text) => `
      <button type="button" class="ec-filter" data-track="${esc(label)}" aria-pressed="${active === label}"
              ${label ? `style="${trackStyle(label)}"` : ''}>
        ${label ? '<span class="ec-filter__dot"></span>' : ''}${esc(text)}
        <span class="ec-filter__count">${pad(count)}</span>
      </button>`;
    return `
      <div class="mt-8 flex flex-wrap items-center gap-2" role="group" aria-label="Show one track">
        <span class="ec-label mr-2 text-ink/70">SHOW</span>
        ${chip('', inYear.length, 'All')}
        ${[...counts].map(([label, count]) => chip(label, count, label)).join('')}
      </div>`;
  }

  /* --------------------------------------------------------------- months */

  function renderMonths(list, next) {
    if (!list.length) {
      root.innerHTML = '<p class="rounded-2xl bg-surface px-6 py-10 text-center text-muted ring-1 ring-line">Nothing in this track yet.</p>';
      return;
    }
    const months = new Map();
    for (const entry of list) {
      const key = entry.startDate.slice(0, 7);
      if (!months.has(key)) months.set(key, []);
      months.get(key).push(entry);
    }
    root.innerHTML = [...months].map(([key, items]) => {
      const [y, m] = key.split('-').map(Number);
      return `
        <section class="mt-14 first:mt-0" aria-labelledby="month-${key}">
          <div class="flex items-baseline justify-between gap-4 border-b border-line pb-3">
            <h2 id="month-${key}" class="font-display text-2xl font-bold tracking-tight sm:text-3xl">${MONTHS[m - 1]} ${y}</h2>
            <span class="ec-label text-ink/70">${pad(items.length)} ${items.length === 1 ? 'ENTRY' : 'ENTRIES'}</span>
          </div>
          <ol class="ec-timeline mt-6 space-y-3">${items.map((entry) => row(entry, next)).join('')}</ol>
        </section>`;
    }).join('');
  }

  /* ----------------------------------------------------------------- page */

  function renderYears(years, active) {
    const host = $('#calYears');
    if (!host) return;
    host.innerHTML = years.length < 2 ? '' : years.map((ay) => `
      <button type="button" role="tab" aria-selected="${ay === active}" data-year="${ay}"
              class="ec-label rounded-full px-4 py-3 transition ${ay === active
                ? 'bg-white text-deep2'
                : 'border border-white/25 text-white/75 hover:border-white hover:text-white'}">
        ${yearLabel(ay)}
      </button>`).join('');
  }

  function emptyState() {
    root.innerHTML = `
      <div class="rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-16 text-center">
        <img src="/assets/logo-day.webp" alt="" class="ec-logo-day mx-auto h-14 w-14 opacity-50" />
        <img src="/assets/logo-night.webp" alt="" class="ec-logo-night mx-auto h-14 w-14 opacity-50" />
        <h2 class="mt-4 font-display text-xl font-bold">The schedule is on its way</h2>
        <p class="mx-auto mt-2 max-w-sm text-sm text-muted">This year's sessions will be listed here as soon as the club team publishes them.</p>
      </div>`;
  }

  async function load() {
    let entries;
    try {
      const res = await fetch('/api/calendar', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      ({ entries } = await res.json());
    } catch (err) {
      console.error(err);
      $('#calStats')?.replaceChildren();
      $('#calOverview')?.replaceChildren();
      root.innerHTML = `
        <p class="rounded-2xl bg-surface px-6 py-10 text-center text-muted ring-1 ring-line">
          We couldn't load the calendar. Please refresh the page, or email ethicraft.pict25@gmail.com.
        </p>`;
      return;
    } finally {
      root.setAttribute('aria-busy', 'false');
    }

    if (!entries.length) {
      // Nothing to count or spotlight: drop both placeholders.
      $('#calStats')?.replaceChildren();
      $('#calOverview')?.replaceChildren();
      emptyState();
      return;
    }

    // Open on this academic year, else the next one with entries, else the latest.
    const years = [...new Set(entries.map((e) => academicYear(e.startDate)))].sort((a, b) => a - b);
    const current = academicYear(today);
    let year = years.includes(current) ? current : (years.find((y) => y > current) ?? years[years.length - 1]);
    let track = '';

    const show = () => {
      const label = yearLabel(year);
      $('#calYearTitle').textContent = label;
      document.title = `FY Calendar ${label} | EthiCraft Club PICT`;

      const inYear = entries.filter((e) => academicYear(e.startDate) === year);
      const next = inYear.find((e) => e.startDate > today);
      renderYears(years, year);
      renderStats(inYear, next);

      const overview = $('#calOverview');
      if (overview) {
        overview.innerHTML = renderSpotlight(inYear, next) + renderFilters(inYear, track);
        const todays = inYear.find((e) => e.startDate <= today && today <= lastDay(e));
        startCountdown(todays || next, Boolean(todays));
      }
      renderMonths(track ? inYear.filter((e) => e.label === track) : inYear, next);
    };

    $('#calYears')?.addEventListener('click', (e) => {
      const button = e.target.closest('[data-year]');
      if (!button) return;
      year = Number(button.dataset.year);
      track = '';
      show();
    });
    $('#calOverview')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-track]');
      if (!chip) return;
      track = chip.dataset.track;
      show();
    });
    show();
  }

  load();
})();
