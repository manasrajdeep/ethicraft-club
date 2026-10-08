/* EthiCraft Club — admin dashboard behaviour: events, the FY calendar and the gallery. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const todayISO = () => new Date().toISOString().slice(0, 10);

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];

  function formatDateLong(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y) return iso;
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  /** 'Mon, 12 Oct 2026', or 'Mon, 12 Oct 2026 – Thu, 22 Oct 2026' for a range. */
  const formatDates = (start, end) => (end ? `${formatDateLong(start)} – ${formatDateLong(end)}` : formatDateLong(start));

  function formatTime(hhmm) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const suffix = h >= 12 ? 'pm' : 'am';
    return `${h % 12 === 0 ? 12 : h % 12}.${String(m).padStart(2, '0')} ${suffix}`;
  }

  const timeSpan = (start, end) => [formatTime(start), formatTime(end)].filter(Boolean).join(' – ');

  /* --------------------------------------------------------------- toast */

  let toastTimer;
  function toast(message, kind = 'success') {
    const host = $('#toast');
    const palette = kind === 'error'
      ? 'bg-magenta-fill text-white'
      : 'bg-deep text-white';
    host.innerHTML = `<div class="pointer-events-auto rounded-full ${palette} px-5 py-3 text-sm font-semibold shadow-xl">${esc(message)}</div>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { host.innerHTML = ''; }, 3600);
  }

  /* ----------------------------------------------------------------- api */

  // This page is served AT the admin path, so its login screen is one level
  // down. Deriving it keeps ADMIN_PATH configurable with no duplicated constant.
  const LOGIN_PATH = `${window.location.pathname.replace(/\/$/, '')}/login`;

  async function api(url, options = {}) {
    const res = await fetch(url, { credentials: 'same-origin', ...options });

    if (res.status === 401) {
      window.location.href = LOGIN_PATH;
      throw new Error('Session expired');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data.errors?.join(' ') || data.error || `Request failed (${res.status})`;
      throw new Error(message);
    }
    return data;
  }

  const sendJson = (url, method, payload) => api(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  /* ------------------------------------------------------------ confirm */

  let confirmResolve = null;
  function askConfirm(title, body, okLabel = 'Delete') {
    $('#confirmTitle').textContent = title;
    $('#confirmBody').textContent = body;
    $('#confirmOk').textContent = okLabel;
    $('#confirm').classList.remove('hidden');
    $('#confirm').classList.add('flex');
    return new Promise((resolve) => { confirmResolve = resolve; });
  }
  function closeConfirm(result) {
    $('#confirm').classList.add('hidden');
    $('#confirm').classList.remove('flex');
    confirmResolve?.(result);
    confirmResolve = null;
  }
  $('#confirmCancel').addEventListener('click', () => closeConfirm(false));
  $('#confirmOk').addEventListener('click', () => closeConfirm(true));
  $('#confirm').addEventListener('click', (e) => { if (e.target.id === 'confirm') closeConfirm(false); });

  const skeletonRows = (n = 2) => `<div class="ec-skeleton h-28 rounded-2xl"></div>`.repeat(n);
  const emptyCard = (title, body) => `
    <div class="rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-16 text-center">
      <h3 class="font-display text-lg font-bold">${title}</h3>
      <p class="mx-auto mt-2 max-w-sm text-sm text-muted">${body}</p>
    </div>`;

  /* ============================================================= EVENTS */

  /* ------------------------------------------------------------- drawer */

  const drawer = $('#drawer');
  const form = $('#eventForm');
  let pendingPosterUrl = null;   // object URL for the preview, revoked on close

  function clearPosterPreview() {
    if (pendingPosterUrl) {
      URL.revokeObjectURL(pendingPosterUrl);
      pendingPosterUrl = null;
    }
    $('#posterPreview').classList.add('hidden');
    $('#posterPreview').classList.remove('flex');
    $('#posterImg').src = '';
  }

  function showPosterPreview(src, name, meta, { isObjectUrl = false } = {}) {
    if (isObjectUrl) pendingPosterUrl = src;
    $('#posterImg').src = src;
    $('#posterName').textContent = name;
    $('#posterMeta').textContent = meta;
    $('#posterPreview').classList.remove('hidden');
    $('#posterPreview').classList.add('flex');
  }

  function syncModeFields() {
    const mode = $('#mode').value;
    $('#venueField').classList.toggle('hidden', mode === 'Zoom');
    $('#linkField').classList.toggle('hidden', mode === 'Offline');
  }
  $('#mode').addEventListener('change', syncModeFields);

  function openDrawer(event = null) {
    form.reset();
    $('#formError').classList.add('hidden');
    $('#removePoster').value = '0';
    clearPosterPreview();

    if (event) {
      $('#drawerTitle').textContent = 'Edit event';
      $('#eventId').value = event.id;
      $('#title').value = event.title;
      $('#subtitle').value = event.subtitle;
      $('#description').value = event.description;
      $('#eventDate').value = event.eventDate;
      $('#endDate').value = event.endDate || '';
      $('#startTime').value = event.startTime;
      $('#endTime').value = event.endTime;
      $('#mode').value = event.mode;
      $('#venue').value = event.venue;
      $('#zoomLink').value = event.zoomLink;
      $('#registrationLink').value = event.registrationLink || '';
      $('#topics').value = event.topics.join(', ');
      $('#published').checked = event.published;
      if (event.posterPath) {
        showPosterPreview(event.posterPath, 'Current poster', 'Upload a new image to replace it');
      }
    } else {
      $('#drawerTitle').textContent = 'New event';
      $('#eventId').value = '';
      $('#eventDate').value = todayISO();
    }

    syncModeFields();
    drawer.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    // Focus now, inside the click: a delayed focus could pull the cursor back
    // from a field the user had already moved to, and phones only raise the
    // keyboard for a focus that happens within the tap itself.
    $('#title').focus();
  }

  function closeDrawer() {
    drawer.classList.add('hidden');
    document.body.style.overflow = '';
    clearPosterPreview();
  }

  $('#newEventBtn').addEventListener('click', () => openDrawer());
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#cancelBtn').addEventListener('click', closeDrawer);
  $('#drawerBackdrop').addEventListener('click', closeDrawer);

  /* ---------------------------------------------------------- poster i/o */

  const MAX_POSTER_BYTES = 6 * 1024 * 1024;
  const fileInput = $('#poster');

  function acceptFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('That file is not an image.', 'error');
    if (file.size > MAX_POSTER_BYTES) return toast('Poster must be 6 MB or smaller.', 'error');

    clearPosterPreview();
    $('#removePoster').value = '0';
    showPosterPreview(
      URL.createObjectURL(file),
      file.name,
      `${(file.size / 1024 / 1024).toFixed(2)} MB`,
      { isObjectUrl: true },
    );
  }

  fileInput.addEventListener('change', () => acceptFile(fileInput.files[0]));

  $('#posterRemove').addEventListener('click', () => {
    fileInput.value = '';
    clearPosterPreview();
    $('#removePoster').value = '1';   // tells the API to clear a stored poster
  });

  const dropzone = $('#dropzone');
  ['dragenter', 'dragover'].forEach((type) => dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('border-sky-brand', 'bg-sky-brand/5');
  }));
  ['dragleave', 'drop'].forEach((type) => dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.remove('border-sky-brand', 'bg-sky-brand/5');
  }));
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    // Keep the real input in sync so the file is submitted with the form.
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    acceptFile(file);
  });

  /* ---------------------------------------------------------------- save */

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = $('#formError');
    errorBox.classList.add('hidden');

    const id = $('#eventId').value;
    const body = new FormData();
    body.append('title', $('#title').value.trim());
    body.append('subtitle', $('#subtitle').value.trim());
    body.append('description', $('#description').value.trim());
    body.append('eventDate', $('#eventDate').value);
    body.append('endDate', $('#endDate').value);
    body.append('startTime', $('#startTime').value);
    body.append('endTime', $('#endTime').value);
    body.append('mode', $('#mode').value);
    body.append('venue', $('#mode').value === 'Zoom' ? '' : $('#venue').value.trim());
    body.append('zoomLink', $('#mode').value === 'Offline' ? '' : $('#zoomLink').value.trim());
    body.append('registrationLink', $('#registrationLink').value.trim());
    body.append('topics', $('#topics').value);
    body.append('published', $('#published').checked ? '1' : '0');
    if (id) body.append('removePoster', $('#removePoster').value);
    if (fileInput.files[0]) body.append('poster', fileInput.files[0]);

    const save = $('#saveBtn');
    save.disabled = true;
    save.textContent = 'Saving…';

    try {
      await api(id ? `/api/admin/events/${id}` : '/api/admin/events', {
        method: id ? 'PUT' : 'POST',
        body,
      });
      toast(id ? 'Event updated.' : 'Event created.');
      closeDrawer();
      await loadEvents();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove('hidden');
      errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      save.disabled = false;
      save.textContent = 'Save event';
    }
  });

  /* ---------------------------------------------------------------- list */

  let events = [];

  /** A programme counts as upcoming until its last day is over. */
  const eventLastDay = (event) => event.endDate || event.eventDate;

  function eventRow(event) {
    const isUpcoming = eventLastDay(event) >= todayISO();
    const time = timeSpan(event.startTime, event.endTime);

    const status = event.published
      ? '<span class="ec-chip bg-sky-brand/15 text-sky-dark">● Published</span>'
      : '<span class="ec-chip bg-amber-brand/20 text-amber-deep">● Draft</span>';

    const thumb = event.posterPath
      ? `<img src="${esc(event.posterPath)}" alt="" class="h-20 w-14 shrink-0 rounded-lg object-cover ring-1 ring-line" />`
      : `<div class="grid h-20 w-14 shrink-0 place-items-center rounded-lg bg-surface2 ring-1 ring-line">
           <img src="/assets/logo-day.png" alt="" class="ec-logo-day h-7 w-7 opacity-50" />
           <img src="/assets/logo-night.png" alt="" class="ec-logo-night h-7 w-7 opacity-50" />
         </div>`;

    return `
      <article class="flex flex-col gap-4 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line sm:flex-row sm:items-center">
        <div class="flex min-w-0 flex-1 items-start gap-4">
          ${thumb}
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              ${status}
              <span class="ec-chip bg-surface2 text-ink/70">${esc(event.mode)}</span>
              ${isUpcoming ? '' : '<span class="ec-chip bg-surface2 text-ink/50">Past</span>'}
            </div>
            <h3 class="mt-2 truncate font-display text-lg font-bold">${esc(event.title)}</h3>
            <p class="mt-0.5 text-sm text-muted">
              ${esc(formatDates(event.eventDate, event.endDate))}${time ? ` · ${esc(time)}` : ''}
            </p>
            ${event.topics.length
              ? `<p class="mt-1 truncate text-xs text-muted">${esc(event.topics.join(' · '))}</p>`
              : ''}
          </div>
        </div>

        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <button type="button" data-action="toggle" data-id="${event.id}"
                  class="rounded-lg border border-line px-3.5 py-2 text-xs font-bold text-ink transition hover:bg-surface2">
            ${event.published ? 'Unpublish' : 'Publish'}
          </button>
          <button type="button" data-action="edit" data-id="${event.id}"
                  class="rounded-lg border border-line px-3.5 py-2 text-xs font-bold text-ink transition hover:bg-surface2">
            Edit
          </button>
          <button type="button" data-action="delete" data-id="${event.id}"
                  class="rounded-lg border border-magenta-brand/25 px-3.5 py-2 text-xs font-bold text-magenta-brand transition hover:bg-magenta-brand/8">
            Delete
          </button>
        </div>
      </article>`;
  }

  function paintStats() {
    const today = todayISO();
    $('#statPublished').textContent = events.filter((e) => e.published).length;
    $('#statDrafts').textContent = events.filter((e) => !e.published).length;
    $('#statUpcoming').textContent = events.filter((e) => e.published && eventLastDay(e) >= today).length;
  }

  async function loadEvents() {
    const list = $('#eventList');
    list.innerHTML = skeletonRows();

    try {
      ({ events } = await api('/api/admin/events'));
      list.innerHTML = events.length
        ? events.map(eventRow).join('')
        : emptyCard('No events yet', 'Create your first event and publish it to the public site.');
      paintStats();
    } catch (err) {
      list.innerHTML = `<div class="rounded-2xl bg-surface px-6 py-12 text-center text-sm text-magenta-brand">${esc(err.message)}</div>`;
    }
  }

  $('#eventList').addEventListener('click', async (e) => {
    const button = e.target.closest('button[data-action]');
    if (!button) return;

    const id = Number(button.dataset.id);
    const event = events.find((item) => item.id === id);
    if (!event) return;

    if (button.dataset.action === 'edit') return openDrawer(event);

    if (button.dataset.action === 'toggle') {
      button.disabled = true;
      try {
        await sendJson(`/api/admin/events/${id}/publish`, 'PATCH', { published: !event.published });
        toast(event.published ? 'Event unpublished.' : 'Event is live on the site.');
        await loadEvents();
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
      }
      return;
    }

    if (button.dataset.action === 'delete') {
      const ok = await askConfirm('Delete this event?', `"${event.title}" and its poster will be removed permanently.`);
      if (!ok) return;
      try {
        await api(`/api/admin/events/${id}`, { method: 'DELETE' });
        toast('Event deleted.');
        await loadEvents();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  /* =========================================================== CALENDAR */

  const calDrawer = $('#calDrawer');
  const calForm = $('#calForm');
  let entries = [];

  function openCalDrawer(entry = null) {
    calForm.reset();
    $('#calError').classList.add('hidden');
    $('#calDrawerTitle').textContent = entry ? 'Edit calendar entry' : 'New calendar entry';
    $('#entryId').value = entry?.id ?? '';
    $('#entryTitle').value = entry?.title ?? '';
    $('#entryLabel').value = entry?.label ?? '';
    $('#entryStartDate').value = entry?.startDate ?? todayISO();
    $('#entryEndDate').value = entry?.endDate ?? '';
    $('#entryStartTime').value = entry?.startTime ?? '';
    $('#entryEndTime').value = entry?.endTime ?? '';
    $('#entryDetails').value = entry?.details ?? '';
    $('#entryLink').value = entry?.link ?? '';
    calDrawer.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('#entryTitle').focus();   // now, not later: see openDrawer
  }

  function closeCalDrawer() {
    calDrawer.classList.add('hidden');
    document.body.style.overflow = '';
  }

  $('#newEntryBtn').addEventListener('click', () => openCalDrawer());
  calDrawer.addEventListener('click', (e) => { if (e.target.closest('[data-cal-close]')) closeCalDrawer(); });

  calForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = $('#calError');
    errorBox.classList.add('hidden');

    const id = $('#entryId').value;
    const payload = {
      title: $('#entryTitle').value.trim(),
      label: $('#entryLabel').value.trim(),
      startDate: $('#entryStartDate').value,
      endDate: $('#entryEndDate').value,
      startTime: $('#entryStartTime').value,
      endTime: $('#entryEndTime').value,
      details: $('#entryDetails').value.trim(),
      link: $('#entryLink').value.trim(),
    };

    const save = $('#calSave');
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      await sendJson(id ? `/api/admin/calendar/${id}` : '/api/admin/calendar', id ? 'PUT' : 'POST', payload);
      toast(id ? 'Entry updated.' : 'Entry added to the calendar.');
      closeCalDrawer();
      await loadEntries();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove('hidden');
    } finally {
      save.disabled = false;
      save.textContent = 'Save entry';
    }
  });

  function entryRow(entry) {
    const past = (entry.endDate || entry.startDate) < todayISO();
    const time = timeSpan(entry.startTime, entry.endTime);
    return `
      <article class="flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line sm:flex-row sm:items-center">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            ${entry.label ? `<span class="ec-chip bg-surface2 text-ink/75">${esc(entry.label)}</span>` : ''}
            ${past ? '<span class="ec-chip bg-surface2 text-ink/50">Past</span>' : ''}
          </div>
          <h3 class="mt-1.5 truncate font-display text-lg font-bold">${esc(entry.title)}</h3>
          <p class="mt-0.5 text-sm text-muted">${esc(formatDates(entry.startDate, entry.endDate))}${time ? ` · ${esc(time)}` : ''}</p>
          ${entry.details ? `<p class="mt-1 truncate text-xs text-muted">${esc(entry.details)}</p>` : ''}
        </div>
        <div class="flex shrink-0 gap-2">
          <button type="button" data-entry-action="edit" data-id="${entry.id}"
                  class="rounded-lg border border-line px-3.5 py-2 text-xs font-bold text-ink transition hover:bg-surface2">Edit</button>
          <button type="button" data-entry-action="delete" data-id="${entry.id}"
                  class="rounded-lg border border-magenta-brand/25 px-3.5 py-2 text-xs font-bold text-magenta-brand transition hover:bg-magenta-brand/8">Delete</button>
        </div>
      </article>`;
  }

  async function loadEntries() {
    const list = $('#entryList');
    list.innerHTML = skeletonRows();
    try {
      ({ entries } = await api('/api/calendar'));
      if (!entries.length) {
        list.innerHTML = emptyCard('The calendar is empty', 'Add the first session of the year with + New entry.');
        return;
      }
      // Grouped by month, the way students see it on /calendar.
      const months = new Map();
      for (const entry of entries) {
        const key = entry.startDate.slice(0, 7);
        if (!months.has(key)) months.set(key, []);
        months.get(key).push(entry);
      }
      list.innerHTML = [...months].map(([key, items]) => {
        const [y, m] = key.split('-').map(Number);
        return `
          <section class="mt-8 first:mt-0">
            <h2 class="text-[11px] font-bold uppercase tracking-[0.15em] text-muted">${MONTHS[m - 1]} ${y} · ${items.length}</h2>
            <div class="mt-3 space-y-3">${items.map(entryRow).join('')}</div>
          </section>`;
      }).join('');
    } catch (err) {
      list.innerHTML = `<div class="rounded-2xl bg-surface px-6 py-12 text-center text-sm text-magenta-brand">${esc(err.message)}</div>`;
    }
  }

  $('#entryList').addEventListener('click', async (e) => {
    const button = e.target.closest('button[data-entry-action]');
    if (!button) return;
    const id = Number(button.dataset.id);
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;

    if (button.dataset.entryAction === 'edit') return openCalDrawer(entry);

    const ok = await askConfirm('Delete this entry?', `"${entry.title}" will be removed from the FY calendar.`);
    if (!ok) return;
    try {
      await api(`/api/admin/calendar/${id}`, { method: 'DELETE' });
      toast('Entry deleted.');
      await loadEntries();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  /* ============================================================ GALLERY */

  let photos = [];

  // The sizes the site serves: lightbox and thumbnail, long edge in pixels.
  const PHOTO_EDGE = 1440;
  const THUMB_EDGE = 720;

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`${file.name} is not an image this browser can open.`));
      };
      img.src = url;
    });
  }

  /**
   * Redraws an image as a JPEG no longer than `edge` on its long side. Phone
   * photos are many megabytes; this sends a few hundred kilobytes instead.
   * Transparent images get a white ground rather than JPEG's black.
   */
  function toJpeg(img, edge) {
    const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not process that image.'))),
      'image/jpeg', 0.72));
  }

  async function uploadPhotos(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith('image/'));
    if (!files.length) {
      toast('Choose image files to upload.', 'error');
      return;
    }
    const progress = $('#photoProgress');
    progress.classList.remove('hidden');
    let added = 0;
    for (const [i, file] of files.entries()) {
      progress.textContent = `Uploading ${i + 1} of ${files.length}…`;
      try {
        const img = await loadImage(file);
        const [photo, thumb] = await Promise.all([toJpeg(img, PHOTO_EDGE), toJpeg(img, THUMB_EDGE)]);
        const body = new FormData();
        body.append('photo', photo, 'photo.jpg');
        body.append('thumb', thumb, 'thumb.jpg');
        await api('/api/admin/photos', { method: 'POST', body });
        added += 1;
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    progress.classList.add('hidden');
    if (added) toast(`${added} photo${added === 1 ? '' : 's'} added. Give ${added === 1 ? 'it' : 'them'} a caption below.`);
    await loadPhotos();
  }

  function photoTile(photo, i) {
    const moveButton = (dir, label, disabled) => `
      <button type="button" data-photo-move="${dir}" ${disabled ? 'disabled' : ''} aria-label="${label}"
              class="grid h-9 w-9 place-items-center rounded-lg border border-line text-ink/70 transition hover:bg-surface2 disabled:opacity-30">
        ${dir === 'up' ? '↑' : '↓'}
      </button>`;
    return `
      <article class="flex flex-col overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line" data-photo-id="${photo.id}">
        <img src="${esc(photo.thumb)}" alt="" loading="lazy" class="aspect-[4/3] w-full bg-surface2 object-cover" />
        <div class="space-y-3 p-4">
          <input type="text" value="${esc(photo.caption)}" maxlength="160" placeholder="Add a caption"
                 aria-label="Caption for photo ${i + 1}" data-photo-caption
                 class="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none transition focus:border-sky-brand" />
          <div class="flex items-center justify-between gap-2">
            <label class="flex cursor-pointer items-center gap-2 text-sm font-semibold">
              <input type="checkbox" data-photo-strip ${photo.inStrip ? 'checked' : ''} class="h-4 w-4 accent-sky-dark" />
              Strip
            </label>
            <div class="flex items-center gap-1">
              ${moveButton('up', 'Move earlier', i === 0)}
              ${moveButton('down', 'Move later', i === photos.length - 1)}
              <button type="button" data-photo-delete
                      class="ml-1 rounded-lg border border-magenta-brand/25 px-3 py-2 text-xs font-bold text-magenta-brand transition hover:bg-magenta-brand/8">
                Delete
              </button>
            </div>
          </div>
        </div>
      </article>`;
  }

  async function loadPhotos() {
    const grid = $('#photoGrid');
    try {
      ({ photos } = await api('/api/photos'));
      const inStrip = photos.filter((p) => p.inStrip).length;
      $('#photoCount').textContent = photos.length
        ? `${photos.length} photo${photos.length === 1 ? '' : 's'} · ${inStrip} in the moving strip`
        : '';
      grid.innerHTML = photos.length
        ? photos.map(photoTile).join('')
        : `<div class="sm:col-span-2 lg:col-span-3">${emptyCard('No photos yet', 'Add photos from an event and they appear in the homepage gallery.')}</div>`;
    } catch (err) {
      grid.innerHTML = `<div class="rounded-2xl bg-surface px-6 py-12 text-center text-sm text-magenta-brand sm:col-span-2 lg:col-span-3">${esc(err.message)}</div>`;
    }
  }

  const tileId = (el) => Number(el.closest('[data-photo-id]')?.dataset.photoId);

  // A caption is saved when the field is left or Enter is pressed.
  $('#photoGrid').addEventListener('change', async (e) => {
    const id = tileId(e.target);
    if (!id) return;
    try {
      if (e.target.matches('[data-photo-caption]')) {
        await sendJson(`/api/admin/photos/${id}`, 'PATCH', { caption: e.target.value });
        toast('Caption saved.');
      } else if (e.target.matches('[data-photo-strip]')) {
        await sendJson(`/api/admin/photos/${id}`, 'PATCH', { inStrip: e.target.checked });
        toast(e.target.checked ? 'Now in the moving strip.' : 'Removed from the moving strip.');
        await loadPhotos();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#photoGrid').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-photo-caption]')) e.target.blur();
  });

  $('#photoGrid').addEventListener('click', async (e) => {
    const move = e.target.closest('[data-photo-move]');
    const remove = e.target.closest('[data-photo-delete]');
    if (!move && !remove) return;
    const id = tileId(e.target);
    try {
      if (move) {
        await sendJson(`/api/admin/photos/${id}`, 'PATCH', { move: move.dataset.photoMove });
      } else {
        const ok = await askConfirm('Delete this photo?', 'It will be removed from the gallery and the strip.');
        if (!ok) return;
        await api(`/api/admin/photos/${id}`, { method: 'DELETE' });
        toast('Photo deleted.');
      }
      await loadPhotos();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const photoInput = $('#photoInput');
  photoInput.addEventListener('change', async () => {
    const files = [...photoInput.files];
    photoInput.value = '';
    await uploadPhotos(files);
  });

  const photoDrop = $('#photoDrop');
  ['dragenter', 'dragover'].forEach((type) => photoDrop.addEventListener(type, (e) => {
    e.preventDefault();
    photoDrop.classList.add('border-sky-brand', 'bg-sky-brand/5');
  }));
  ['dragleave', 'drop'].forEach((type) => photoDrop.addEventListener(type, (e) => {
    e.preventDefault();
    photoDrop.classList.remove('border-sky-brand', 'bg-sky-brand/5');
  }));
  photoDrop.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) uploadPhotos(e.dataTransfer.files);
  });

  /* =============================================================== TABS */

  const LOADERS = { events: loadEvents, calendar: loadEntries, gallery: loadPhotos };
  const loaded = new Set();

  /** Shows one section. Each loads the first time it is opened. */
  function showTab(name) {
    const tab = LOADERS[name] ? name : 'events';
    for (const button of document.querySelectorAll('[data-tab]')) {
      const on = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(on));
      $(`#panel-${button.dataset.tab}`).classList.toggle('hidden', !on);
    }
    // The hash keeps the open section across a reload.
    if (window.location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
    if (!loaded.has(tab)) {
      loaded.add(tab);
      LOADERS[tab]();
    }
  }

  $('[role="tablist"]').addEventListener('click', (e) => {
    const button = e.target.closest('[data-tab]');
    if (button) showTab(button.dataset.tab);
  });
  window.addEventListener('hashchange', () => showTab(window.location.hash.slice(1)));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#confirm').classList.contains('hidden')) return closeConfirm(false);
    if (!drawer.classList.contains('hidden')) closeDrawer();
    if (!calDrawer.classList.contains('hidden')) closeCalDrawer();
  });

  /* -------------------------------------------------------------- logout */

  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      window.location.href = LOGIN_PATH;
    }
  });

  /* --------------------------------------------------------------- start */

  showTab(window.location.hash.slice(1) || 'events');
})();
