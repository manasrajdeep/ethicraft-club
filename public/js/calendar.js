/* EthiCraft Club — FY calendar page.
   Lays /api/calendar out by academic year (July to June) and month. "Today"
   is the club's own date in IST, wherever the visitor happens to be. */
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

  /** '17:15' -> '5.15 pm', the club's own style. */
  function formatTime(hhmm) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    if (Number.isNaN(h)) return '';
    return `${h % 12 === 0 ? 12 : h % 12}.${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
  }

  function timeText(entry) {
    const start = formatTime(entry.startTime);
    const end = formatTime(entry.endTime);
    if (start && end) return `${start} – ${end} IST`;
    return start ? `${start} IST` : '';
  }

  /** A track keeps one colour all year, so the eye can follow it down the page. */
  const KNOWN = {
    'wisdom track': 'bg-magenta-brand/12 text-magenta-brand',
    'technical track': 'bg-sky-brand/12 text-sky-dark',
  };
  const PALETTE = ['bg-amber-brand/18 text-amber-deep', 'bg-magenta-brand/12 text-magenta-brand', 'bg-sky-brand/12 text-sky-dark'];
  function labelClass(label) {
    const key = label.toLowerCase();
    if (KNOWN[key]) return KNOWN[key];
    let hash = 0;
    for (const c of key) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    return PALETTE[hash % PALETTE.length];
  }

  function dateBlock(entry) {
    const s = parts(entry.startDate);
    if (!entry.endDate) {
      return `<span class="block font-display text-2xl font-black leading-none">${s.d}</span>
              <span class="mt-1 block text-[11px] font-bold uppercase tracking-[0.12em] text-magenta-brand">${s.weekday}</span>`;
    }
    const e = parts(entry.endDate);
    return e.m === s.m
      ? `<span class="block font-display text-xl font-black leading-none">${s.d}–${e.d}</span>
         <span class="mt-1 block text-[11px] font-bold uppercase tracking-[0.12em] text-magenta-brand">${SHORT[s.m - 1]}</span>`
      : `<span class="block font-display text-xl font-black leading-none">${s.d}</span>
         <span class="mt-1 block text-[10px] font-bold uppercase tracking-[0.08em] text-magenta-brand">to ${e.d} ${SHORT[e.m - 1]}</span>`;
  }

  function row(entry, isNext) {
    const past = lastDay(entry) < today;
    const isToday = entry.startDate <= today && today <= lastDay(entry);
    const badge = isToday
      ? '<span class="ec-chip bg-amber-brand text-deep2">TODAY</span>'
      : isNext ? '<span class="ec-chip bg-deep text-ondeep">NEXT UP</span>' : '';
    const time = timeText(entry);
    return `
      <li class="flex gap-4 rounded-2xl bg-surface p-4 shadow-sm sm:gap-5 sm:p-5 ${isToday ? 'ring-2 ring-amber-brand' : 'ring-1 ring-line'} ${past ? 'opacity-60' : ''}">
        <div class="w-16 shrink-0 self-start rounded-xl bg-surface2 px-2 py-2.5 text-center text-ink">${dateBlock(entry)}</div>
        <div class="min-w-0 flex-1">
          ${entry.label || badge ? `<div class="flex flex-wrap items-center gap-2">
            ${entry.label ? `<span class="ec-chip ${labelClass(entry.label)}">${esc(entry.label)}</span>` : ''}
            ${badge}
          </div>` : ''}
          <h3 class="mt-2 font-display text-lg font-bold leading-snug text-ink">${esc(entry.title)}</h3>
          ${time ? `<p class="ec-label mt-1.5 text-ink/55">${esc(time.toUpperCase())}</p>` : ''}
          ${entry.details ? `<p class="mt-2 text-sm leading-relaxed text-muted">${esc(entry.details)}</p>` : ''}
          ${entry.link ? `<a href="${esc(entry.link)}" target="_blank" rel="noopener noreferrer"
                             class="ec-taplink text-sm font-bold text-sky-dark hover:underline">Details ↗</a>` : ''}
        </div>
      </li>`;
  }

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

  function render(entries, ay) {
    const label = yearLabel(ay);
    $('#calYearTitle').textContent = label;
    document.title = `FY Calendar ${label} | EthiCraft Club PICT`;

    const inYear = entries.filter((e) => academicYear(e.startDate) === ay);
    const next = inYear.find((e) => e.startDate > today);
    const months = new Map();
    for (const entry of inYear) {
      const key = entry.startDate.slice(0, 7);
      if (!months.has(key)) months.set(key, []);
      months.get(key).push(entry);
    }

    root.innerHTML = [...months].map(([key, list]) => {
      const [y, m] = key.split('-').map(Number);
      return `
        <section class="mt-14 first:mt-0" aria-labelledby="month-${key}">
          <div class="flex items-baseline justify-between gap-4 border-b border-line pb-3">
            <h2 id="month-${key}" class="font-display text-2xl font-bold tracking-tight sm:text-3xl">${MONTHS[m - 1]} ${y}</h2>
            <span class="ec-label text-ink/40">${String(list.length).padStart(2, '0')} ${list.length === 1 ? 'ENTRY' : 'ENTRIES'}</span>
          </div>
          <ol class="mt-5 space-y-3">${list.map((entry) => row(entry, entry === next)).join('')}</ol>
        </section>`;
    }).join('');
  }

  function emptyState() {
    root.innerHTML = `
      <div class="rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-16 text-center">
        <img src="/assets/logo-day.png" alt="" class="ec-logo-day mx-auto h-14 w-14 opacity-50" />
        <img src="/assets/logo-night.png" alt="" class="ec-logo-night mx-auto h-14 w-14 opacity-50" />
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
      root.innerHTML = `
        <p class="rounded-2xl bg-surface px-6 py-10 text-center text-muted ring-1 ring-line">
          We couldn't load the calendar. Please refresh the page, or email ethicraft.pict25@gmail.com.
        </p>`;
      return;
    } finally {
      root.setAttribute('aria-busy', 'false');
    }

    if (!entries.length) {
      emptyState();
      return;
    }

    // Open on this academic year, else the next one with entries, else the latest.
    const years = [...new Set(entries.map((e) => academicYear(e.startDate)))].sort((a, b) => a - b);
    const current = academicYear(today);
    const first = years.includes(current) ? current : (years.find((y) => y > current) ?? years[years.length - 1]);

    const show = (ay) => {
      renderYears(years, ay);
      render(entries, ay);
    };
    $('#calYears')?.addEventListener('click', (e) => {
      const button = e.target.closest('[data-year]');
      if (button) show(Number(button.dataset.year));
    });
    show(first);
  }

  load();
})();
