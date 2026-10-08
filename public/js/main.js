/* EthiCraft Club — public site behaviour.
   Plain ES2020, no build step. Everything dynamic comes from /api/events and
   /api/photos. Every lookup tolerates a missing element, so the calendar page
   can load this file for its nav, theme and reveals. */
(() => {
  'use strict';

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ------------------------------------------------------------- helpers */

  /** Escapes text before it goes anywhere near innerHTML. */
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MONTHS_LONG = ['January','February','March','April','May','June','July','August',
    'September','October','November','December'];

  const arrow = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';

  /** Both logos; the theme shows one (see .ec-logo-day in styles.css). */
  const logo = (cls) => `<img src="/assets/logo-day.png" alt="" class="ec-logo-day ${cls}" />`
    + `<img src="/assets/logo-night.png" alt="" class="ec-logo-night ${cls}" />`;

  /** '2026-09-16' -> { day: '16', month: 'Sep', weekday: 'Wednesday', full: '16 Sept 2026' } */
  function formatDate(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y || !m || !d) return { day: '--', month: '', weekday: '', full: iso };
    const date = new Date(y, m - 1, d);
    return {
      day: String(d).padStart(2, '0'),
      month: MONTHS[m - 1],
      weekday: date.toLocaleDateString('en-IN', { weekday: 'long' }),
      full: date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
    };
  }

  /** The last day of an event: its end date, or its only date. */
  const lastDay = (event) => event.endDate || event.eventDate;
  const isMultiDay = (event) => Boolean(event.endDate) && event.endDate !== event.eventDate;

  /**
   * '12–22 Oct 2026', '12 Oct – 7 Nov 2026', or for one day '16 Sep 2026'.
   * `long` spells the months out.
   */
  function formatRange(event, long = false) {
    const names = long ? MONTHS_LONG : MONTHS;
    const [y1, m1, d1] = String(event.eventDate).split('-').map(Number);
    if (!y1) return event.eventDate || '';
    if (!isMultiDay(event)) return `${d1} ${names[m1 - 1]} ${y1}`;
    const [y2, m2, d2] = String(event.endDate).split('-').map(Number);
    if (y1 !== y2) return `${d1} ${names[m1 - 1]} ${y1} – ${d2} ${names[m2 - 1]} ${y2}`;
    if (m1 !== m2) return `${d1} ${names[m1 - 1]} – ${d2} ${names[m2 - 1]} ${y1}`;
    return `${d1}–${d2} ${names[m1 - 1]} ${y1}`;
  }

  /** '19:30' -> '7.30 pm' (the format the club uses on its posters). */
  function formatTime(hhmm) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    if (Number.isNaN(h)) return '';
    const suffix = h >= 12 ? 'pm' : 'am';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}.${String(m).padStart(2, '0')} ${suffix}`;
  }

  function timeRange(event) {
    const start = formatTime(event.startTime);
    const end = formatTime(event.endTime);
    if (start && end) return `${start} – ${end}`;
    if (start || end) return start || end;
    return isMultiDay(event) ? 'Multiple sessions' : 'Time to be announced';
  }

  /**
   * Times are stored as wall-clock IST, so they are pinned to +05:30 here.
   * Reading them in the visitor's own timezone put the countdown and the .ics
   * entry hours out for anyone outside India. India has no daylight saving, so
   * the offset is fixed.
   */
  const IST_OFFSET = '+05:30';

  /** '2026-09-16' + '19:30' -> the Date for 7.30 pm IST that day, or null. */
  function istDate(iso, hhmm) {
    const [hh, mm] = (hhmm || '00:00').split(':').map(Number);
    const pad = (n) => String(n || 0).padStart(2, '0');
    const date = new Date(`${iso}T${pad(hh)}:${pad(mm)}:00${IST_OFFSET}`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function eventStart(event) {
    return istDate(event.eventDate, event.startTime);
  }

  /**
   * When an event is over. Without times it lasts to the end of its last day:
   * ending an hour after midnight marked a date-only session "concluded" on
   * the very day it was happening.
   */
  function eventEnd(event) {
    const start = eventStart(event);
    if (!start) return null;
    if (event.endTime) return istDate(lastDay(event), event.endTime);
    if (event.startTime && !isMultiDay(event)) return new Date(start.getTime() + 60 * 60 * 1000);
    const endOfDay = istDate(lastDay(event), '23:59');
    return endOfDay && new Date(endOfDay.getTime() + 59 * 1000);
  }

  /** RFC 5545 escaping: commas, semicolons, backslashes and newlines. */
  const icsEscape = (v) => String(v ?? '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

  const icsStamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  /** The day after an ISO date, for an all-day event's exclusive end. */
  function nextDay(iso) {
    const date = new Date(`${iso}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  }

  /**
   * Builds a downloadable .ics file so members can drop the session into a
   * calendar. A programme over several days, or a day without a start time,
   * becomes an all-day entry, with any session times in its description.
   */
  function buildIcs(event) {
    const start = eventStart(event);
    const end = eventEnd(event);
    if (!start || !end) return null;

    const allDay = !event.startTime || isMultiDay(event);
    const when = allDay
      ? [`DTSTART;VALUE=DATE:${event.eventDate.replace(/-/g, '')}`,
        `DTEND;VALUE=DATE:${nextDay(lastDay(event)).replace(/-/g, '')}`]
      : [`DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`];

    const where = event.mode === 'Zoom' ? (event.zoomLink || 'Zoom') : (event.venue || event.mode);
    const body = [
      event.subtitle,
      event.description,
      allDay && event.startTime ? `Sessions: ${timeRange(event)} IST` : '',
      event.topics?.length ? `Topics: ${event.topics.join(', ')}` : '',
      event.registrationLink ? `Register: ${event.registrationLink}` : '',
      event.zoomLink ? `Join: ${event.zoomLink}` : '',
    ].filter(Boolean).join('\n\n');

    // CRLF line endings are required by the spec; Outlook rejects bare LF.
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//EthiCraft Club PICT//Events//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:ethicraft-${event.id}@pict.edu`,
      `DTSTAMP:${icsStamp(new Date())}`,
      ...when,
      `SUMMARY:${icsEscape(event.title)}`,
      `DESCRIPTION:${icsEscape(body)}`,
      `LOCATION:${icsEscape(where)}`,
      event.zoomLink ? `URL:${icsEscape(event.zoomLink)}` : '',
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean).join('\r\n');
  }

  /**
   * RFC 5545 line folding: no content line may exceed 75 octets. Longer lines are
   * split and continued with a leading space. Folding counts UTF-8 bytes, not
   * characters, so an em dash costs 3 - a naive .slice(0, 75) would corrupt it.
   */
  function foldIcs(ics) {
    const encoder = new TextEncoder();
    return ics.split('\r\n').map((line) => {
      if (encoder.encode(line).length <= 75) return line;
      const out = [];
      let current = '';
      let bytes = 0;
      for (const char of line) {                 // iterates by code point
        const size = encoder.encode(char).length;
        // Continuation lines carry a leading space, so their budget is 74.
        if (bytes + size > (out.length ? 74 : 75)) {
          out.push(current);
          current = '';
          bytes = 0;
        }
        current += char;
        bytes += size;
      }
      if (current) out.push(current);
      return out.join('\r\n ');
    }).join('\r\n');
  }

  function downloadIcs(event) {
    const ics = buildIcs(event);
    if (!ics) return;
    const blob = new Blob([foldIcs(ics)], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${event.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const MODE_STYLES = {
    Zoom:    'bg-sky-brand/12 text-sky-dark',
    Offline: 'bg-magenta-brand/12 text-magenta-brand',
    Hybrid:  'bg-amber-brand/18 text-amber-deep',
  };

  /** Where the event physically/virtually happens. */
  function locationLabel(event) {
    if (event.mode === 'Zoom') return 'Online · Zoom';
    return event.venue || (event.mode === 'Hybrid' ? 'Hybrid · venue TBA' : 'Venue to be announced');
  }

  /* --------------------------------------------------------- event cards */

  function topicPills(topics, limit = 4) {
    if (!topics?.length) return '';
    const shown = topics.slice(0, limit);
    const extra = topics.length - shown.length;
    return `<ul class="mt-4 flex flex-wrap gap-1.5">
      ${shown.map((t) => `<li class="ec-chip bg-surface2 text-ink/75">${esc(t)}</li>`).join('')}
      ${extra > 0 ? `<li class="ec-chip bg-surface2 text-ink/50">+${extra} more</li>` : ''}
    </ul>`;
  }

  /** One line of the card's spec sheet: KEY ......... value */
  function specRow(key, value) {
    return `<div class="ec-spec">
      <dt class="ec-spec-key">${esc(key)}</dt>
      <span class="ec-spec-dots" aria-hidden="true"></span>
      <dd class="ec-spec-val">${esc(value)}</dd>
    </div>`;
  }

  function eventCard(event, { isPast }) {
    const date = formatDate(event.eventDate);
    const until = isMultiDay(event) ? formatDate(event.endDate) : null;
    const modeClass = MODE_STYLES[event.mode] || MODE_STYLES.Zoom;

    const poster = event.posterPath
      ? `<button type="button" class="js-poster group relative block w-full overflow-hidden rounded-t-2xl"
                 data-src="${esc(event.posterPath)}" data-title="${esc(event.title)}">
           <img src="${esc(event.posterPath)}" alt="Poster for ${esc(event.title)}" loading="lazy"
                class="ec-poster transition duration-500 group-hover:scale-[1.03]" />
           <span class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-deep2/70 to-transparent p-3 text-left text-xs font-semibold text-white opacity-0 transition group-hover:opacity-100">
             View full poster
           </span>
         </button>`
      : `<div class="grid h-40 place-items-center rounded-t-2xl bg-gradient-to-br from-deep to-sky-dark">
           ${logo('h-16 w-16 opacity-90')}
         </div>`;

    // Registering comes before joining, so it leads. Once an event is past,
    // both links are dropped rather than left to disappoint.
    const register = !isPast && event.registrationLink
      ? `<a href="${esc(event.registrationLink)}" target="_blank" rel="noopener noreferrer"
            class="inline-flex items-center gap-2 rounded-full bg-amber-brand px-5 py-2.5 text-sm font-bold text-deep2 shadow-sm transition hover:brightness-110">
           Register now ${arrow}
         </a>`
      : '';

    const join = !isPast && event.zoomLink
      ? `<a href="${esc(event.zoomLink)}" target="_blank" rel="noopener noreferrer"
            class="inline-flex items-center gap-2 rounded-full ${register ? 'border border-line px-5 py-2.5 text-ink/80 hover:border-sky-brand hover:text-ink' : 'bg-deep px-5 py-2.5 text-white hover:bg-sky-dark'} text-sm font-bold transition">
           Join the session ${register ? '' : arrow}
         </a>`
      : '';

    const action = isPast
      ? `<span class="inline-flex items-center gap-2 text-sm font-semibold text-ink/40">Session concluded</span>`
      : (register || join)
        ? `${register}${join}`
        : `<span class="inline-flex items-center gap-2 text-sm font-semibold text-ink/50">Joining details coming soon</span>`;

    return `
      <article class="ec-card ec-bracket ec-reveal flex flex-col overflow-hidden text-ink ${isPast ? 'opacity-90' : ''}">
        ${poster}
        <div class="flex flex-1 flex-col p-6">
          <div class="flex items-start gap-4">
            <div class="shrink-0 rounded-xl bg-surface2 px-3 py-2 text-center">
              <span class="block font-display text-2xl font-black leading-none text-ink">${date.day}</span>
              <span class="mt-0.5 block text-[11px] font-bold uppercase tracking-[0.12em] text-magenta-brand">${date.month}</span>
              ${until ? `<span class="mt-1 block text-[10px] font-bold uppercase tracking-[0.08em] text-ink/50">to ${until.day} ${until.month}</span>` : ''}
            </div>
            <div class="min-w-0">
              <span class="ec-chip ${modeClass}">${esc(event.mode)}</span>
              <h3 class="mt-2 font-display text-xl font-bold leading-snug">${esc(event.title)}</h3>
              ${event.subtitle ? `<p class="mt-1 text-sm font-medium text-magenta-brand">${esc(event.subtitle)}</p>` : ''}
            </div>
          </div>

          ${event.description ? `<p class="mt-4 text-sm leading-relaxed text-muted">${esc(event.description)}</p>` : ''}
          ${topicPills(event.topics)}

          <dl class="mt-5 space-y-2 border-t border-line pt-4 text-ink/80">
            ${specRow(until ? 'Dates' : 'Date', formatRange(event))}
            ${specRow('Time', timeRange(event))}
            ${specRow('Venue', locationLabel(event))}
            ${specRow('Ref', `EC-${String(event.id).padStart(3, '0')}`)}
          </dl>

          <div class="mt-auto flex flex-wrap items-center gap-2 pt-5">
            ${action}
            ${isPast ? '' : `<button type="button" class="js-ics ec-label rounded-full border border-line px-4 py-2.5 text-ink/70 transition hover:border-sky-brand hover:text-ink" data-id="${event.id}">+ .ICS</button>`}
          </div>
        </div>
      </article>`;
  }

  function emptyState(scope) {
    const copy = scope === 'past'
      ? { title: 'No past events yet', body: 'Once a session wraps up it will be archived here.' }
      : { title: 'Nothing scheduled right now', body: 'New sessions go up regularly — check back soon or email us to be notified.' };
    return `
      <div class="col-span-full rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-16 text-center">
        ${logo('mx-auto h-14 w-14 opacity-40')}
        <h3 class="mt-4 font-display text-xl font-bold">${copy.title}</h3>
        <p class="mx-auto mt-2 max-w-sm text-sm text-muted">${copy.body}</p>
      </div>`;
  }

  const skeletons = (n = 3) => Array.from({ length: n }, () => `
    <div class="ec-card overflow-hidden">
      <div class="ec-skeleton ec-poster-skeleton"></div>
      <div class="space-y-3 p-6">
        <div class="ec-skeleton h-5 w-2/3 rounded"></div>
        <div class="ec-skeleton h-3.5 w-full rounded"></div>
        <div class="ec-skeleton h-3.5 w-4/5 rounded"></div>
      </div>
    </div>`).join('');

  /* ------------------------------------------------------------ countdown */

  let countdownTimer = null;

  /** Splits a millisecond delta into padded d/h/m/s parts. */
  function splitDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return {
      days:    String(Math.floor(total / 86400)).padStart(2, '0'),
      hours:   String(Math.floor((total % 86400) / 3600)).padStart(2, '0'),
      minutes: String(Math.floor((total % 3600) / 60)).padStart(2, '0'),
      seconds: String(total % 60).padStart(2, '0'),
    };
  }

  /** What is happening now, in the hero's small caps. */
  function nowLabel(event) {
    if (isMultiDay(event)) {
      const until = formatDate(event.endDate);
      return `ON NOW · UNTIL ${until.day} ${until.month.toUpperCase()}`;
    }
    return event.startTime ? 'LIVE NOW' : 'HAPPENING TODAY';
  }

  /**
   * Drives the hero countdown. One interval for the whole page, cleared and
   * restarted whenever the featured event changes, so tab-switching never
   * leaves a stray timer running.
   */
  function startCountdown(event) {
    clearInterval(countdownTimer);
    countdownTimer = null;

    const host = document.querySelector('#countdown');
    if (!host || !event) return;

    const start = eventStart(event);
    const end = eventEnd(event);
    if (!start) return;

    const cell = (value, label) => `
      <div class="text-center">
        <div class="ec-digit rounded-lg bg-white/10 px-2.5 py-2 text-2xl font-bold text-white ring-1 ring-inset ring-white/15 sm:text-3xl">${value}</div>
        <div class="ec-label mt-1.5 text-ondeep/45">${label}</div>
      </div>`;

    const tick = () => {
      const now = Date.now();

      if (now >= end.getTime()) {
        host.innerHTML = `<p class="ec-label text-ondeep/50">${isMultiDay(event) ? 'PROGRAMME CONCLUDED' : 'SESSION CONCLUDED'}</p>`;
        clearInterval(countdownTimer);
        return;
      }
      if (now >= start.getTime()) {
        host.innerHTML = `
          <p class="ec-label flex items-center gap-2 text-amber-brand">
            <span class="ec-status text-amber-brand"></span> ${nowLabel(event)}
          </p>`;
        return;   // keep ticking so it flips to concluded at the end time
      }

      const { days, hours, minutes, seconds } = splitDuration(start.getTime() - now);
      host.innerHTML = `
        <p class="ec-label mb-2.5 text-ondeep/45">STARTS IN</p>
        <div class="grid grid-cols-4 gap-2">
          ${cell(days, 'DAYS')}${cell(hours, 'HRS')}${cell(minutes, 'MIN')}${cell(seconds, 'SEC')}
        </div>`;
    };

    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  /* ------------------------------------------------------------ telemetry */

  /** The thin data strip above the events grid. */
  function renderEventsMeta(events, scope) {
    const host = document.querySelector('#eventsMeta');
    if (!host) return;

    const next = scope === 'upcoming' ? events[0] : null;
    const cells = [
      ['COUNT', String(events.length).padStart(2, '0')],
      ['SCOPE', scope.toUpperCase()],
      ['NEXT', next ? `${formatDate(next.eventDate).day} ${formatDate(next.eventDate).month}`.toUpperCase() : '—'],
      ['TZ', 'IST (UTC+05:30)'],
    ];

    host.innerHTML = cells.map(([key, value]) => `
      <span class="ec-label text-ink/40">
        ${key} <span class="ml-1.5 font-semibold text-ink/75">${esc(value)}</span>
      </span>`).join('');
  }

  /* --------------------------------------------------------- hero teaser */

  /** Under way already: an ongoing programme leads with that, not "next". */
  const isUnderway = (event) => {
    const start = eventStart(event);
    return Boolean(start) && Date.now() >= start.getTime();
  };

  /**
   * The hero card carries the details and the countdown. The poster itself is
   * shown full size in its own band just below, so it is not repeated here.
   */
  function renderHeroEvent(event) {
    const host = $('#heroEvent');
    if (!host) return;
    if (!event) { host.innerHTML = ''; return; }

    const kicker = isUnderway(event) ? 'HAPPENING NOW' : 'NEXT SESSION';
    host.innerHTML = `
      <div class="w-full max-w-md rounded-3xl bg-white/[0.08] p-2 ring-1 ring-inset ring-white/20 backdrop-blur-md">
        <div class="p-5">
          <div class="flex items-center justify-between gap-3">
            <span class="ec-label flex items-center gap-2 text-amber-brand">
              <span class="ec-status text-amber-brand"></span> ${kicker}
            </span>
            <span class="ec-label text-ondeep/35">EC-${String(event.id).padStart(3, '0')}</span>
          </div>

          <h2 class="mt-3 font-display text-2xl font-bold leading-snug text-white">${esc(event.title)}</h2>
          <p class="ec-label mt-2 text-ondeep/55">
            ${esc(formatRange(event, true).toUpperCase())} · ${esc(timeRange(event).toUpperCase())} · ${esc((event.mode === 'Zoom' ? 'Zoom' : locationLabel(event)).toUpperCase())}
          </p>

          <div id="countdown" class="mt-5" aria-live="off"></div>

          ${event.registrationLink ? `
            <a href="${esc(event.registrationLink)}" target="_blank" rel="noopener noreferrer"
               class="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-amber-brand px-5 py-3.5 text-sm font-bold text-deep2 shadow-lg transition hover:brightness-110">
              Register now ${arrow}
            </a>` : ''}

          <div class="mt-3 flex gap-2">
            ${event.zoomLink ? `
              <a href="${esc(event.zoomLink)}" target="_blank" rel="noopener noreferrer"
                 class="flex-1 rounded-full ${event.registrationLink ? 'border border-white/25 text-white hover:bg-white/10' : 'bg-white text-deep2 hover:bg-amber-brand'} px-5 py-3 text-center text-sm font-bold transition">
                Join on Zoom
              </a>` : ''}
            ${event.posterPath ? `
              <a href="#featured" class="ec-label flex-1 rounded-full border border-white/25 px-4 py-3 text-center text-white/75 transition hover:border-white hover:text-white">
                SEE POSTER ↓
              </a>` : ''}
            <button type="button" class="js-ics ec-label rounded-full border border-white/25 px-4 py-3 text-white/75 transition hover:border-white hover:text-white" data-id="${event.id}">
              + .ICS
            </button>
          </div>
        </div>
      </div>`;
    observeReveals(host);
  }

  /* ---------------------------------------------------- featured poster */

  /** The next session's poster in its own band, as large as the window allows. */
  function renderFeatured(event) {
    const section = $('#featured');
    if (!section) return;
    if (!event?.posterPath) { section.classList.add('hidden'); return; }

    $('#featuredKicker').innerHTML = `<span class="ec-status text-amber-brand"></span> ${isUnderway(event) ? 'HAPPENING NOW' : 'NEXT SESSION'}`;
    $('#featuredTitle').textContent = event.title;
    $('#featuredMeta').textContent = [formatRange(event, true), timeRange(event), locationLabel(event)]
      .join(' · ').toUpperCase();
    $('#featuredActions').innerHTML = `
      ${event.registrationLink ? `
        <a href="${esc(event.registrationLink)}" target="_blank" rel="noopener noreferrer"
           class="inline-flex items-center gap-2 rounded-full bg-amber-brand px-6 py-3 text-sm font-bold text-deep2 shadow-lg transition hover:brightness-110">
          Register now ${arrow}
        </a>` : ''}
      <button type="button" class="js-ics ec-label rounded-full border border-white/25 px-4 py-3 text-white/75 transition hover:border-white hover:text-white" data-id="${event.id}">
        + .ICS
      </button>`;

    const button = $('#featuredPoster');
    button.dataset.src = event.posterPath;
    button.dataset.title = event.title;
    button.setAttribute('aria-label', `View the poster for ${event.title} full screen`);
    const img = $('#featuredImg');
    img.src = event.posterPath;
    img.alt = `Poster for ${event.title}`;
    section.classList.remove('hidden');
  }

  /* ------------------------------------------------------------- loading */

  const grid = $('#eventsGrid');
  let activeScope = 'upcoming';
  let loadedEvents = [];      // backs the .ics buttons
  let featured = null;        // the hero's event, which outlives a switch to "Past"

  function paintTabs() {
    $$('.ec-tab').forEach((tab) => {
      const on = tab.dataset.scope === activeScope;
      tab.setAttribute('aria-selected', String(on));
      tab.className = `ec-tab rounded-full px-5 py-2 text-sm font-semibold transition ${
        on ? 'bg-deep text-white shadow-sm' : 'text-ink/60 hover:text-ink'
      }`;
    });
  }

  async function loadEvents(scope) {
    activeScope = scope;
    paintTabs();
    if (!grid) return;

    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = skeletons();

    try {
      const res = await fetch(`/api/events?scope=${encodeURIComponent(scope)}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const { events } = await res.json();
      loadedEvents = events;
      renderEventsMeta(events, scope);

      grid.innerHTML = events.length
        ? events.map((e) => eventCard(e, { isPast: scope === 'past' })).join('')
        : emptyState(scope);

      if (scope === 'upcoming') {
        featured = events[0] || null;
        renderHeroEvent(featured);
        startCountdown(featured);
        renderFeatured(featured);
      }
      observeReveals(grid);
    } catch (err) {
      console.error(err);
      grid.innerHTML = `
        <div class="col-span-full rounded-2xl border border-magenta-brand/25 bg-white px-6 py-12 text-center">
          <h3 class="font-display text-lg font-bold">We couldn't load the events</h3>
          <p class="mt-2 text-sm text-muted">Please refresh the page, or email ethicraft.pict25@gmail.com.</p>
          <button type="button" id="retryEvents" class="mt-5 rounded-full bg-deep px-5 py-2.5 text-sm font-bold text-white">Try again</button>
        </div>`;
      $('#retryEvents')?.addEventListener('click', () => loadEvents(activeScope));
    } finally {
      grid.setAttribute('aria-busy', 'false');
    }
  }

  /* -------------------------------------------------------------- photos */

  let photos = [];        // every gallery photo, in order
  let stripPhotos = [];   // the ones picked for the moving strip

  const photoItem = (p) => ({ src: p.src, alt: p.caption || 'A photo from the EthiCraft Club', caption: p.caption });

  /**
   * The strip under the nav. Two identical tracks loop seamlessly; a short
   * selection is repeated so the loop never shows a gap on a wide screen. The
   * photos are not tab stops: keyboard users get the same set in the gallery,
   * which the strip's own link points to.
   */
  function renderStrip() {
    const host = $('#activityStrip');
    if (!host) return;
    host.setAttribute('aria-busy', 'false');
    stripPhotos = photos.filter((p) => p.inStrip);
    if (!stripPhotos.length) {
      $('#activitiesBody')?.classList.add('hidden');
      return;
    }

    const items = [];
    while (items.length < 12) items.push(...stripPhotos);
    const track = (copy) => `
      <div class="ec-strip__track" aria-hidden="true">
        ${items.map((p, i) => `
          <span class="ec-strip__item js-photo" data-set="strip" data-index="${i % stripPhotos.length}">
            <img src="${esc(p.thumb)}" alt="" width="${Number(p.width)}" height="${Number(p.height)}"
                 ${copy ? 'loading="lazy"' : i < 6 ? '' : 'loading="lazy"'} decoding="async" />
          </span>`).join('')}
      </div>`;
    host.innerHTML = track(false) + track(true);

    // A steady pace whatever the number of photos: about 40px a second.
    const width = host.firstElementChild.getBoundingClientRect().width;
    host.style.setProperty('--strip-duration', `${Math.max(30, Math.round(width / 40))}s`);
  }

  function renderGallery() {
    const host = $('#galleryGrid');
    if (!host) return;
    if (!photos.length) {
      $('#gallery')?.classList.add('hidden');
      return;
    }
    host.innerHTML = photos.map((p, i) => `
      <button type="button" class="ec-photo ec-reveal js-photo" data-set="gallery" data-index="${i}"
              aria-label="${esc(p.caption || 'Club photo')}: view larger">
        <img src="${esc(p.thumb)}" alt="${esc(p.caption)}" width="${Number(p.width)}" height="${Number(p.height)}"
             loading="lazy" decoding="async" />
        ${p.caption ? `<span class="ec-photo__caption" aria-hidden="true">${esc(p.caption)}</span>` : ''}
      </button>`).join('');
    observeReveals(host);
  }

  async function loadPhotos() {
    if (!$('#activityStrip') && !$('#galleryGrid')) return;
    try {
      const res = await fetch('/api/photos', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      ({ photos } = await res.json());
    } catch (err) {
      console.error(err);
      photos = [];
    }
    renderStrip();
    renderGallery();
  }

  /* -------------------------------------------------------------- reveal */

  function reveal(el, obs) {
    el.classList.add('is-visible');
    obs?.unobserve(el);
  }

  const revealObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries, obs) => {
        entries.forEach((entry) => {
          // `isIntersecting` alone is not enough. A fast fling (or a jump to an
          // anchor) can carry an element past the viewport between two observer
          // frames, and the only callback reports it as already gone. Treating
          // "its top is above the fold" as revealed too means content can never
          // be left stranded at opacity 0.
          if (entry.isIntersecting || entry.boundingClientRect.top < window.innerHeight) {
            reveal(entry.target, obs);
          }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })
    : null;

  /** Safety sweep: reveal anything that has reached the viewport, whatever the observer did. */
  function sweepReveals() {
    if (!revealObserver) return;
    for (const el of $$('.ec-reveal:not(.is-visible)')) {
      if (el.getBoundingClientRect().top < window.innerHeight) reveal(el, revealObserver);
    }
  }

  function observeReveals(root = document) {
    const targets = $$('.ec-reveal:not(.is-visible)', root);
    if (!revealObserver) {
      targets.forEach((el) => el.classList.add('is-visible'));
      return;
    }
    // Stagger siblings slightly so grids cascade instead of popping at once.
    targets.forEach((el, i) => {
      el.style.transitionDelay = `${Math.min(i, 8) * 55}ms`;
      revealObserver.observe(el);
    });
  }

  /* ------------------------------------------------------------ lightbox */

  const lightbox = $('#lightbox');
  const lightboxImg = $('#lightboxImg');
  const lightboxCaption = $('#lightboxCaption');
  let lightboxItems = [];
  let lightboxIndex = 0;
  let lightboxReturn = null;   // what had focus, to hand it back on close

  function showLightboxItem(index) {
    const count = lightboxItems.length;
    lightboxIndex = (index + count) % count;
    const item = lightboxItems[lightboxIndex];
    lightboxImg.src = item.src;
    lightboxImg.alt = item.alt;
    const many = count > 1;
    if (lightboxCaption) {
      lightboxCaption.textContent = [item.caption, many ? `${lightboxIndex + 1} / ${count}` : '']
        .filter(Boolean).join('  ·  ');
    }
    for (const id of ['#lightboxPrev', '#lightboxNext']) {
      $(id)?.classList.toggle('hidden', !many);
      $(id)?.classList.toggle('grid', many);
    }
    // Warm the cache for the next photo, so stepping through never waits.
    if (many) new Image().src = lightboxItems[(lightboxIndex + 1) % count].src;
  }

  function openLightbox(items, index = 0, trigger = null) {
    if (!lightbox || !items.length) return;
    lightboxItems = items;
    lightboxReturn = trigger;
    showLightboxItem(index);
    lightbox.classList.remove('hidden');
    lightbox.classList.add('flex');
    document.body.style.overflow = 'hidden';
    $('#lightboxClose')?.focus();
  }

  function closeLightbox() {
    if (!lightbox || lightbox.classList.contains('hidden')) return;
    lightbox.classList.add('hidden');
    lightbox.classList.remove('flex');
    lightboxImg.src = '';
    document.body.style.overflow = '';
    lightboxReturn?.focus?.();
  }

  const lightboxOpen = () => lightbox && !lightbox.classList.contains('hidden');

  document.addEventListener('click', (e) => {
    const ics = e.target.closest('.js-ics');
    if (ics) {
      const id = Number(ics.dataset.id);
      const event = loadedEvents.find((item) => item.id === id) || (featured?.id === id ? featured : null);
      if (event) downloadIcs(event);
      return;
    }

    const poster = e.target.closest('.js-poster');
    if (poster) {
      const title = poster.dataset.title || '';
      openLightbox([{ src: poster.dataset.src, alt: `Poster for ${title}`, caption: title }], 0, poster);
      return;
    }

    const photo = e.target.closest('.js-photo');
    if (photo) {
      const set = photo.dataset.set === 'strip' ? stripPhotos : photos;
      openLightbox(set.map(photoItem), Number(photo.dataset.index) || 0, photo);
      return;
    }

    if (e.target.closest('#lightboxPrev')) { showLightboxItem(lightboxIndex - 1); return; }
    if (e.target.closest('#lightboxNext')) { showLightboxItem(lightboxIndex + 1); return; }
    if (e.target === lightbox || e.target.closest('#lightboxClose')) closeLightbox();
  });

  document.addEventListener('keydown', (e) => {
    if (!lightboxOpen()) return;
    if (e.key === 'Escape') closeLightbox();
    else if (lightboxItems.length > 1 && e.key === 'ArrowLeft') showLightboxItem(lightboxIndex - 1);
    else if (lightboxItems.length > 1 && e.key === 'ArrowRight') showLightboxItem(lightboxIndex + 1);
  });

  // A horizontal swipe steps through the gallery on phones.
  let touchX = null;
  lightbox?.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  lightbox?.addEventListener('touchend', (e) => {
    if (touchX === null || lightboxItems.length < 2) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) showLightboxItem(lightboxIndex + (dx < 0 ? 1 : -1));
  });

  /* ----------------------------------------------------------- nav + tabs */

  const nav = $('#nav');
  const progress = $('#scrollProgress');

  // Both scroll effects share one rAF-throttled handler: a naive scroll
  // listener fires far more often than the screen refreshes.
  let scrollQueued = false;
  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      nav?.setAttribute('data-scrolled', String(y > 24));
      if (progress) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        progress.style.transform = `scaleX(${max > 0 ? Math.min(y / max, 1) : 0})`;
      }
      sweepReveals();
      scrollQueued = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  onScroll();

  const menu = $('#mobileMenu');
  const toggle = $('#navToggle');
  function setMenu(open) {
    menu?.classList.toggle('hidden', !open);
    toggle?.setAttribute('aria-expanded', String(open));
    $('#navIconOpen')?.classList.toggle('hidden', open);
    $('#navIconClose')?.classList.toggle('hidden', !open);
  }
  toggle?.addEventListener('click', () => setMenu(menu?.classList.contains('hidden')));
  menu?.addEventListener('click', (e) => { if (e.target.tagName === 'A') setMenu(false); });

  $$('.ec-tab').forEach((tab) => tab.addEventListener('click', () => loadEvents(tab.dataset.scope)));

  /* --------------------------------------------------------------- start */

  // Footer build strip: the viewer's own locale/timezone, resolved at runtime.
  const buildMeta = $('#buildMeta');
  if (buildMeta) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
    buildMeta.textContent = `RENDERED ${new Date().getFullYear()} · ${tz.toUpperCase()}`;
  }

  observeReveals();
  loadEvents('upcoming');
  loadPhotos();
})();
