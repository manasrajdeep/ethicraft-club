/* EthiCraft Club — admin dashboard behaviour. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const todayISO = () => new Date().toISOString().slice(0, 10);

  function formatDateLong(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y) return iso;
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  function formatTime(hhmm) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const suffix = h >= 12 ? 'pm' : 'am';
    return `${h % 12 === 0 ? 12 : h % 12}.${String(m).padStart(2, '0')} ${suffix}`;
  }

  /* --------------------------------------------------------------- toast */

  let toastTimer;
  function toast(message, kind = 'success') {
    const host = $('#toast');
    const palette = kind === 'error'
      ? 'bg-magenta-brand text-white'
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
      $('#startTime').value = event.startTime;
      $('#endTime').value = event.endTime;
      $('#mode').value = event.mode;
      $('#venue').value = event.venue;
      $('#zoomLink').value = event.zoomLink;
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
    setTimeout(() => $('#title').focus(), 60);
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
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#confirm').classList.contains('hidden')) return closeConfirm(false);
    if (!drawer.classList.contains('hidden')) closeDrawer();
  });

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
    body.append('startTime', $('#startTime').value);
    body.append('endTime', $('#endTime').value);
    body.append('mode', $('#mode').value);
    body.append('venue', $('#mode').value === 'Zoom' ? '' : $('#venue').value.trim());
    body.append('zoomLink', $('#mode').value === 'Offline' ? '' : $('#zoomLink').value.trim());
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

  function eventRow(event) {
    const isUpcoming = event.eventDate >= todayISO();
    const time = [formatTime(event.startTime), formatTime(event.endTime)].filter(Boolean).join(' – ');

    const status = event.published
      ? '<span class="ec-chip bg-sky-brand/15 text-sky-dark">● Published</span>'
      : '<span class="ec-chip bg-amber-brand/20 text-amber-deep">● Draft</span>';

    const thumb = event.posterPath
      ? `<img src="${esc(event.posterPath)}" alt="" class="h-20 w-14 shrink-0 rounded-lg object-cover ring-1 ring-line" />`
      : `<div class="grid h-20 w-14 shrink-0 place-items-center rounded-lg bg-surface2 ring-1 ring-line">
           <img src="/assets/logo.png" alt="" class="h-7 w-7 opacity-50" />
         </div>`;

    return `
      <article class="flex flex-col gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-line sm:flex-row sm:items-center">
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
              ${esc(formatDateLong(event.eventDate))}${time ? ` · ${esc(time)}` : ''}
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
    $('#statUpcoming').textContent = events.filter((e) => e.published && e.eventDate >= today).length;
  }

  async function loadEvents() {
    const list = $('#eventList');
    list.innerHTML = `<div class="ec-skeleton h-28 rounded-2xl"></div>`.repeat(2);

    try {
      ({ events } = await api('/api/admin/events'));
      list.innerHTML = events.length
        ? events.map(eventRow).join('')
        : `<div class="rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-16 text-center">
             <h3 class="font-display text-lg font-bold">No events yet</h3>
             <p class="mx-auto mt-2 max-w-sm text-sm text-muted">Create your first event and publish it to the public site.</p>
           </div>`;
      paintStats();
    } catch (err) {
      list.innerHTML = `<div class="rounded-2xl bg-white px-6 py-12 text-center text-sm text-magenta-brand">${esc(err.message)}</div>`;
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
        await api(`/api/admin/events/${id}/publish`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ published: !event.published }),
        });
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

  /* -------------------------------------------------------------- logout */

  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      window.location.href = LOGIN_PATH;
    }
  });

  /* --------------------------------------------------------------- start */

  loadEvents();
})();
