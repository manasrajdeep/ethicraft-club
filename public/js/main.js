/* EthiCraft Club — public site behaviour.
   Plain ES2020, no build step. Everything dynamic comes from /api/events. */
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
    return start || end || 'Time to be announced';
  }

  /** Combines the stored date + time into a local Date. Times are wall-clock IST for PICT. */
  function eventStart(event) {
    const [y, m, d] = String(event.eventDate).split('-').map(Number);
    if (!y) return null;
    const [hh, mm] = (event.startTime || '00:00').split(':').map(Number);
    return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0);
  }

  function eventEnd(event) {
    const start = eventStart(event);
    if (!start) return null;
    if (!event.endTime) return new Date(start.getTime() + 60 * 60 * 1000);
    const [hh, mm] = event.endTime.split(':').map(Number);
    const end = new Date(start);
    end.setHours(hh || 0, mm || 0, 0, 0);
    return end;
  }

  /** RFC 5545 escaping: commas, semicolons, backslashes and newlines. */
  const icsEscape = (v) => String(v ?? '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

  const icsStamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  /** Builds a downloadable .ics file so members can drop the session into a calendar. */
  function buildIcs(event) {
    const start = eventStart(event);
    const end = eventEnd(event);
    if (!start || !end) return null;

    const where = event.mode === 'Zoom' ? (event.zoomLink || 'Zoom') : (event.venue || event.mode);
    const body = [
      event.subtitle,
      event.description,
      event.topics?.length ? `Topics: ${event.topics.join(', ')}` : '',
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
      `DTSTART:${icsStamp(start)}`,
      `DTEND:${icsStamp(end)}`,
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
           <img src="/assets/logo.png" alt="" class="h-16 w-16 opacity-90" />
         </div>`;

    // Past events keep the link visible but inert — it tells people where it happened.
    const action = isPast
      ? `<span class="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-ink/40">Session concluded</span>`
      : event.zoomLink
        ? `<a href="${esc(event.zoomLink)}" target="_blank" rel="noopener noreferrer"
              class="mt-5 inline-flex items-center gap-2 rounded-full bg-deep px-5 py-2.5 text-sm font-bold text-white transition hover:bg-sky-dark">
             Join the session
             <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>
           </a>`
        : `<span class="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-ink/50">Joining details coming soon</span>`;

    return `
      <article class="ec-card ec-bracket ec-reveal flex flex-col overflow-hidden text-ink ${isPast ? 'opacity-90' : ''}">
        ${poster}
        <div class="flex flex-1 flex-col p-6">
          <div class="flex items-start gap-4">
            <div class="shrink-0 rounded-xl bg-surface2 px-3 py-2 text-center">
              <span class="block font-display text-2xl font-black leading-none text-ink">${date.day}</span>
              <span class="mt-0.5 block text-[11px] font-bold uppercase tracking-[0.12em] text-magenta-brand">${date.month}</span>
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
            ${specRow('Date', `${date.day} ${date.month} ${esc(String(event.eventDate).slice(0, 4))}`)}
            ${specRow('Time', timeRange(event))}
            ${specRow('Venue', locationLabel(event))}
            ${specRow('Ref', `EC-${String(event.id).padStart(3, '0')}`)}
          </dl>

          <div class="mt-auto flex flex-wrap items-center gap-2">
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
        <img src="/assets/logo.png" alt="" class="mx-auto h-14 w-14 opacity-40" />
        <h3 class="mt-4 font-display text-xl font-bold">${copy.title}</h3>
        <p class="mx-auto mt-2 max-w-sm text-sm text-muted">${copy.body}</p>
      </div>`;
  }

  const skeletons = (n = 3) => Array.from({ length: n }, () => `
    <div class="ec-card overflow-hidden">
      <div class="ec-skeleton ec-poster"></div>
      <div class="space-y-3 p-6">
        <div class="ec-skeleton h-5 w-2/3 rounded"></div>
        <div class="ec-skeleton h-3.5 w-full rounded"></div>
        <div class="ec-skeleton h-3.5 w-4/5 rounded"></div>
      </div>
    </div>`).join('');

  /* --------------------------------------------------------- hero teaser */

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
        host.innerHTML = `<p class="ec-label text-ondeep/50">SESSION CONCLUDED</p>`;
        clearInterval(countdownTimer);
        return;
      }
      if (now >= start.getTime()) {
        host.innerHTML = `
          <p class="ec-label flex items-center gap-2 text-amber-brand">
            <span class="ec-status text-amber-brand"></span> LIVE NOW
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

  function renderHeroEvent(event) {
    const host = $('#heroEvent');
    if (!host) return;
    if (!event) { host.innerHTML = ''; return; }

    const date = formatDate(event.eventDate);
    host.innerHTML = `
      <div class="w-full max-w-md rounded-3xl bg-white/[0.08] p-2 ring-1 ring-inset ring-white/20 backdrop-blur-md">
        ${event.posterPath
          ? `<button type="button" class="js-poster block w-full overflow-hidden rounded-[1.25rem]"
                     data-src="${esc(event.posterPath)}" data-title="${esc(event.title)}">
               <img src="${esc(event.posterPath)}" alt="Poster for ${esc(event.title)}" class="w-full rounded-[1.25rem]" />
             </button>`
          : ''}
        <div class="p-5">
          <div class="flex items-center justify-between gap-3">
            <span class="ec-label flex items-center gap-2 text-amber-brand">
              <span class="ec-status text-amber-brand"></span> NEXT SESSION
            </span>
            <span class="ec-label text-ondeep/35">EC-${String(event.id).padStart(3, '0')}</span>
          </div>

          <h2 class="mt-3 font-display text-2xl font-bold leading-snug text-white">${esc(event.title)}</h2>
          <p class="ec-label mt-2 text-ondeep/55">
            ${esc(date.full.toUpperCase())} · ${esc(timeRange(event).toUpperCase())} · ${esc((event.mode === 'Zoom' ? 'Zoom' : locationLabel(event)).toUpperCase())}
          </p>

          <div id="countdown" class="mt-5" aria-live="off"></div>

          <div class="mt-5 flex gap-2">
            ${event.zoomLink ? `
              <a href="${esc(event.zoomLink)}" target="_blank" rel="noopener noreferrer"
                 class="flex-1 rounded-full bg-white px-5 py-3 text-center text-sm font-bold text-deep2 transition hover:bg-amber-brand">
                Join on Zoom
              </a>` : ''}
            <button type="button" class="js-ics ec-label rounded-full border border-white/25 px-4 py-3 text-white/75 transition hover:border-white hover:text-white" data-id="${event.id}">
              + .ICS
            </button>
          </div>
        </div>
      </div>`;
    observeReveals(host);
  }

  /* ------------------------------------------------------------- loading */

  const grid = $('#eventsGrid');
  let activeScope = 'upcoming';
  let loadedEvents = [];      // backs the .ics buttons

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
        renderHeroEvent(events[0] || null);
        startCountdown(events[0] || null);
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

  function openLightbox(src, title) {
    if (!lightbox) return;
    lightboxImg.src = src;
    lightboxImg.alt = `Poster for ${title}`;
    lightbox.classList.remove('hidden');
    lightbox.classList.add('flex');
    document.body.style.overflow = 'hidden';
    $('#lightboxClose')?.focus();
  }

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.classList.add('hidden');
    lightbox.classList.remove('flex');
    lightboxImg.src = '';
    document.body.style.overflow = '';
  }

  document.addEventListener('click', (e) => {
    const ics = e.target.closest('.js-ics');
    if (ics) {
      const event = loadedEvents.find((item) => item.id === Number(ics.dataset.id));
      if (event) downloadIcs(event);
      return;
    }

    const trigger = e.target.closest('.js-poster');
    if (trigger) {
      openLightbox(trigger.dataset.src, trigger.dataset.title || '');
      return;
    }
    if (e.target === lightbox || e.target.closest('#lightboxClose')) closeLightbox();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

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
})();
