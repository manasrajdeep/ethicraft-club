# The EthiCraft Club · PICT

A complete website and admin portal for the EthiCraft Club at Pune Institute of
Computer Technology.

* **Public site** — a responsive landing page: a moving strip of past
  activities, the club's aims, the VIBE and IMPACT modules, a live **Upcoming
  Events** section with the next poster shown full size, a photo gallery and
  past speakers. Plus an **FY Calendar** page (`/calendar`) with the year's
  schedule for first-year students.
* **Admin portal** — a password-protected dashboard, at a private path you
  choose, where the club team publishes events with their posters, keeps the
  FY calendar up to date and manages the gallery photos.

Built with Node.js + Express, PostgreSQL, Tailwind CSS and vanilla JavaScript.
No framework, and the compiled stylesheet is committed — clone it and run it.

---

## Quick start

### 1. Requirements

* **Node.js 20 or newer** (`node --version`)
* npm 9+
* **PostgreSQL** — locally (`brew install postgresql@15`) or a free Supabase project

> **Node 18 and below will not work.** If you use `nvm`, the included `.nvmrc`
> handles it:
>
> ```bash
> nvm use        # reads .nvmrc
> ```

### 2. Install

```bash
cd ethicraft-club
npm install
```

### 3. Configure

```bash
cp .env.example .env
```

Open `.env` and set your own values:

| Variable | What it does |
| --- | --- |
| `PORT` | Port to serve on. Defaults to `3000`. |
| `ADMIN_PATH` | Where the dashboard lives. Never linked publicly. |
| `ADMIN_USERNAME` | Username for the admin portal. |
| `ADMIN_PASSWORD` | Password for the admin portal. |
| `DATABASE_URL` | Postgres connection string (Supabase in production). |
| `SESSION_SECRET` | Signs the login cookie. Generate a long random string. |
| `SITE_ORIGIN` | Public origin, used for canonical URLs and the sitemap. |
| `NODE_ENV` | Set to `production` behind HTTPS. Startup then refuses placeholder secrets. |

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

To rotate the admin credentials, change `ADMIN_USERNAME` and/or
`ADMIN_PASSWORD` and restart. The new password is hashed, any account under a
different username is removed, and everyone is signed out.

For a local database, start Postgres and create the database `.env.example`
points at. The app creates its own tables on first run.

```bash
brew services start postgresql@15
createdb ethicraft_dev
```

### 4. Run

```bash
npm start          # or: npm run dev   (restarts on file changes)
```

```
Public site  →  http://localhost:3000
Admin portal →  http://localhost:3000<ADMIN_PATH>
```

The admin portal is **deliberately not linked from the public site**. Its path
comes from `ADMIN_PATH` in `.env`, so it can be moved without a code change.

On first run the app creates its tables, the admin account from your `.env`,
and pre-loads the launch event:

> **From Then to Now: Alumni Tales** — 16th Sept, 7.30 pm – 8.30 pm, on Zoom.
> Topics: Placements · Campus Life · Role of AI in today's World.

**Before you share the site**, sign in to the admin portal, edit that event and
replace the placeholder Zoom link (`https://zoom.us/j/0000000000`) with the real one.

---

## Directory structure

```
ethicraft-club/
├── package.json             # deps + npm scripts
├── .nvmrc                   # pins Node 20 for nvm users
├── .env.example             # copy to .env
├── render.yaml              # Render blueprint for the hosted site
├── tailwind.config.js       # maps Tailwind's colours onto the theme tokens
├── README.md
├── .github/workflows/ci.yml # build + npm test on Node 20 and 22
│
├── server/
│   ├── index.js             # Express app: middleware, sessions, routes, errors
│   ├── db.js                # Postgres pool, schema, admin bootstrap
│   ├── auth.js              # password checks, session guards, login throttling
│   ├── seo.js               # robots.txt and sitemap.xml generation
│   ├── validate.js          # date, time, URL and id checks shared by the routes
│   └── routes/
│       ├── admin.js         # POST /login, POST /logout, GET /me
│       ├── events.js        # public + admin event API, poster uploads
│       ├── photos.js        # gallery API and photo bytes
│       └── calendar.js      # FY calendar API
│
├── scripts/
│   ├── seed.js              # starter content: launch event, gallery photos, FY calendar
│   └── reset-db.js          # drops the app's tables and reseeds
│
├── test/
│   ├── helpers.js           # boots the real server against a throwaway database
│   ├── app.test.js          # integration tests (npm test)
│   ├── responsive-audit.js  # layout audit across device viewports
│   ├── e2e.js               # drives the real UI in headless Chromium
│   └── fixtures/            # a large photo, to test in-browser resizing
│
├── deploy-vps-alternative/  # for running on your own server instead of Render
│   ├── ethicraft.service    # hardened systemd unit
│   ├── Caddyfile            # TLS + www->apex redirect
│   └── backup.sh            # nightly pg_dump of the database
│
├── src/app.css              # Tailwind entry point for npm run build
├── assets-seed/
│   ├── alumni-tales.jpg     # poster for the seeded launch event
│   └── gallery/             # photos the gallery starts with, plus manifest.json
│
├── views/                   # HTML pages, served only via explicit routes
│   ├── index.html           # public landing page
│   ├── calendar.html        # FY calendar page
│   ├── admin.html           # admin dashboard: events, calendar, gallery
│   ├── login.html           # admin login
│   └── 404.html
│
└── public/                  # static assets, served wholesale
    ├── css/
    │   ├── app.css          # compiled Tailwind (committed)
    │   └── styles.css       # colour tokens for both themes + animations
    ├── js/
    │   ├── main.js          # landing page: events, poster, strip, gallery
    │   ├── calendar.js      # FY calendar page
    │   ├── admin.js         # dashboard: events, calendar, gallery uploads
    │   └── theme.js         # day/night toggle
    └── assets/
        ├── logo-day.webp    # background-free logos, one per theme
        ├── logo-night.webp
        ├── logo.png         # link previews (og:image)
        ├── favicon.png      # tab icon, 48px
        ├── apple-touch-icon.png
        ├── hero-bg-960.webp # hero background, phones
        └── hero-bg-1600.webp# hero background, tablets and up
```

Posters and gallery photos are stored in the database, not on disk (see below).

---

## Using the admin portal

Go to `http://localhost:3000<ADMIN_PATH>` and sign in. The dashboard has three
tabs.

**Events**

1. Click **+ New event**.
2. Fill in the title, tagline, start date, start/end time and mode.
   * For a programme over several days, also set an **End date**. It stays
     under Upcoming, and in the hero, until that day is over, so there is no
     need to publish it again each day. The times are each day's session and
     can be left blank.
   * **Zoom** → a meeting link is required before the event can be published.
   * **Offline / Hybrid** → a venue field appears instead.
3. Type topics separated by commas — `Placements, Campus Life, Role of AI`.
4. Drag a poster onto the upload box (JPG/PNG/WebP/GIF, up to 6 MB).
5. Tick **Publish to the public site**, or leave it unticked to save a draft
   only the club team can see.
6. **Save event.** Refresh the public site: it appears under Upcoming Events,
   the next one up is featured in the hero, and its poster is shown full size
   just below.

Events whose last day has passed move automatically to the **Past** tab on the
public site. Use **Publish / Unpublish** on any row to toggle visibility without
deleting anything.

**FY Calendar** — the schedule shown at `/calendar`. Each entry has a date or a
date range, optional times, a track label such as *Wisdom Track* (each label
keeps its own colour), details and an optional link. The page groups entries by
academic year (July to June) and month, and marks today's entry and the next.

**Gallery** — **+ Add photos**, or drag them in. Photos are resized in the
browser before they upload, so pictures straight from a phone are fine. Give
each one a caption, tick **Strip** to also show it in the moving strip under
the menu, and use the arrows to set the order.

---

## Database schema

Created and updated automatically on every boot by `server/db.js`; safe to
re-run.

**`events`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | SERIAL | Primary key |
| `title` | TEXT | Required |
| `subtitle` | TEXT | Tagline |
| `description` | TEXT | Longer blurb |
| `event_date` | DATE | First day |
| `end_date` | DATE | Last day of a programme over several days; empty for one day |
| `start_time`, `end_time` | TEXT | `HH:MM`, 24-hour, IST |
| `mode` | TEXT | `Zoom` · `Offline` · `Hybrid` |
| `venue` | TEXT | Used when the mode is not Zoom |
| `zoom_link` | TEXT | Required to publish a Zoom event |
| `registration_link` | TEXT | Optional sign-up form, linked as **Register now** on upcoming events |
| `poster_data` | BYTEA | The image itself, served at `/posters/:id` |
| `poster_type`, `poster_name` | TEXT | MIME type and original filename |
| `topics` | JSONB | Array of strings |
| `published` | BOOLEAN | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

Posters live in the database rather than on disk, because a free Render
instance wipes its filesystem on every restart. At this site's scale (a handful
of posters and a few dozen photos of a few hundred KB each) that keeps
everything in one connection string and one free tier. Past a few hundred
images, move them to Supabase Storage.

**`photos`** — the gallery: `caption`, `in_strip` (also shown in the moving
strip), `sort_order`, `width`, `height`, and two JPEGs: `image_data` (up to
1440px, for the lightbox) and `thumb_data` (up to 720px, for the grid and strip).

**`calendar_entries`** — the FY calendar: `title`, `start_date`, `end_date`,
`start_time`, `end_time`, `label`, `details`, `link`.

**`app_meta`** — one-off markers, so the starter gallery and calendar are
inserted once and stay deleted if the club team removes them.

**`admins`** — `id`, `username`, `password_hash` (bcrypt, 12 rounds), `created_at`.
Only the account named by `ADMIN_USERNAME` is kept.
**`user_sessions`** — created automatically by `connect-pg-simple`.

---

## API reference

### Public

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/events?scope=upcoming\|past\|all` | Published events only |
| `GET` | `/api/events/:id` | One published event |
| `GET` | `/posters/:id` | An event's poster image (cached, ETag). Link it with the event's `posterPath`, whose `?v=` changes whenever the poster does, so browsers never show a replaced poster from cache. |
| `GET` | `/api/photos` | Gallery photos in order, with captions, sizes, strip flags and image URLs |
| `GET` | `/photos/:id`, `/photos/:id/thumb` | A photo, or its thumbnail. Cached for a year at the versioned URLs `/api/photos` hands out. |
| `GET` | `/api/calendar` | The FY calendar, earliest first |

### Admin — all require a valid session cookie

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/admin/login` | `{ username, password }` |
| `POST` | `/api/admin/logout` | Ends the session |
| `GET` | `/api/admin/me` | Current admin |
| `GET` | `/api/admin/events` | All events, drafts included |
| `GET` | `/api/admin/events/:id` | One event, drafts included |
| `POST` | `/api/admin/events` | Create — `multipart/form-data`, optional `poster` and `endDate` |
| `PUT` | `/api/admin/events/:id` | Update — send `removePoster=1` to clear a poster |
| `PATCH` | `/api/admin/events/:id/publish` | `{ published: true \| false }` |
| `DELETE` | `/api/admin/events/:id` | Deletes the event and its poster |
| `POST` | `/api/admin/photos` | Add a photo — `multipart/form-data` with `photo` and `thumb` JPEGs, optional `caption` and `inStrip` |
| `PATCH` | `/api/admin/photos/:id` | `{ caption?, inStrip?, move?: "up" \| "down" }` |
| `DELETE` | `/api/admin/photos/:id` | Removes a photo |
| `POST` | `/api/admin/calendar` | Add an entry — JSON `{ title, startDate, endDate?, startTime?, endTime?, label?, details?, link? }` |
| `PUT` | `/api/admin/calendar/:id` | Replace an entry (same body) |
| `DELETE` | `/api/admin/calendar/:id` | Removes an entry |

Validation errors come back as `400` with `{ "errors": ["...", "..."] }`.

---

## npm scripts

| Command | What it does |
| --- | --- |
| `npm start` | Start the server |
| `npm run dev` | Start with `--watch` (restarts on save) |
| `npm run build` | Compile Tailwind into `public/css/app.css` (`build:watch` while editing) |
| `npm run seed` | Seed the initial event if the table is empty |
| `npm run reset-db` | **Deletes** every event, admin, session, photo and calendar entry, then reseeds |
| `npm test` | Runs the full integration suite |
| `npm run test:watch` | Same, re-running on file changes |
| `npm run test:responsive` | Drives a real browser across 11 device viewports |
| `npm run test:e2e` | Drives the real site and dashboard in a browser, end to end |

---

## Security notes

Implemented:

* Passwords hashed with bcrypt (12 rounds); logins are compared in constant time
  whether or not the username exists.
* `httpOnly`, `sameSite=lax` session cookies; the session ID is regenerated on
  login. Cookies are marked `Secure` when `NODE_ENV=production`.
* Login throttling — 8 failed attempts per IP locks that IP out for 15 minutes.
* Uploads are restricted to image MIME types and 6 MB, and are stored in the
  database and served by event id, never under a caller-supplied filename.
* All user-supplied text is HTML-escaped at render time, so a poster title
  containing markup is displayed, never executed.
* Server-side validation of dates, times, modes and URLs — the client-side
  checks are a convenience, not the gate.

Before putting this on a public server:

1. Set a real `SESSION_SECRET` and a strong `ADMIN_PASSWORD` in `.env`.
2. Set `NODE_ENV=production` and serve over HTTPS. Render handles TLS for you;
   on your own server, put Caddy in front (`deploy-vps-alternative/Caddyfile`).
3. Back up the database. The posters live in it too, so it is the entire site
   content: `deploy-vps-alternative/backup.sh` takes a nightly `pg_dump`.

---

## Customising

**Brand colours** live in `public/css/styles.css`: `:root` holds the day
palette and `[data-theme="dark"]` the night one. Tailwind's colour classes read
those same variables (see `tailwind.config.js`), so a colour change needs no
rebuild. The two page backgrounds are repeated in each page's `theme-color`
meta tags and in `public/js/theme.js`; change them there too.

**Tailwind** is compiled at build time into `public/css/app.css`, which is
committed so the site runs without a build step. After adding or changing class
names in `views/` or `public/js/`, rebuild it:

```bash
npm run build          # or: npm run build:watch while editing
```

**Content** — the aims, modules, entry criteria and speakers are plain HTML in
`views/index.html`, marked with comments. Edit them directly. Events, the FY
calendar and the gallery are managed from the dashboard instead.

**Logo** — `public/assets/logo-day.webp` and `logo-night.webp` have no background,
so they sit cleanly on any band; the page shows the one that matches the theme.
Replace both together, as square 160px WebPs with transparency (both load on
every page, so keep each under 20 KB): `cwebp -q 88 -alpha_q 100 logo.png -o logo-day.webp`.

**Hero photo** — `hero-bg-960.webp` serves phones and `hero-bg-1600.webp` everything
wider. The breakpoint appears twice, in `.ec-hero-photo` in `styles.css` and in the
preload links in `views/index.html`; change both together, or the photo downloads twice.

**Why `views/` is separate from `public/`** — `public/` is served by
`express.static`, so anything in it is reachable by anyone. Keeping the HTML in
`views/` means the dashboard is only ever reachable through the route that
checks the session; there is no `/admin.html` back door.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Failed to start: connect ECONNREFUSED … (is Postgres running?)` | Start it: `brew services start postgresql@15`. Otherwise check the host and port in `DATABASE_URL`. |
| `Failed to start: database "ethicraft_dev" does not exist` | Create it once: `createdb ethicraft_dev`. |
| `EADDRINUSE` | Another process holds the port. Change `PORT` in `.env`, or `lsof -ti:3000 \| xargs kill`. |
| Admin password not working | Set `ADMIN_PASSWORD` in `.env` and restart — it re-hashes on boot. |
| Events save but don't appear publicly | They are drafts. Hit **Publish** on the row, and check the date isn't in the past. |
| Poster upload rejected | Must be JPG/PNG/WebP/GIF and 6 MB or smaller. |
| Want a clean slate | `npm run reset-db` |

---

## Testing

```bash
npm test
```

Boots the real server against a throwaway Postgres database (created and
dropped per run) and runs integration tests across twelve areas:
infrastructure, security headers, admin portal location, authentication, the
public API, validation, poster uploads, attack surface (path traversal, SQL
injection, stored XSS, oversized bodies, brute force), SEO output, frontend
assets, theming and responsive rules, plus multi-day events, the gallery and
FY calendar APIs, and starter content that is seeded only once. It needs a
local Postgres your user can create databases in; set `TEST_PG_URL` to use
another (CI does).

```bash
npm run test:responsive
```

Drives a real Chromium across 11 device viewports (320px Galaxy Fold through
1920px desktop) on four pages, failing on horizontal overflow, elements that
escape the viewport, tap targets under 24px, and text under 11px. It boots its
own throwaway server. To audit one that is already running, pass its URL, then
its login page (left out otherwise, since the admin path is secret):
`npm run test:responsive -- http://localhost:3000 /admin/login`.

```bash
npm run test:e2e
```

Drives the real site and dashboard in headless Chromium against a throwaway
server: signs in, then creates, edits, unpublishes, republishes and deletes an
event with a poster, adds a multi-day programme, a calendar entry and a gallery
photo, failing on any console error, CSP violation or failed request along the
way. It also checks what only a browser can show: that markup in a title stays
text, that a replaced poster is never served stale from the browser cache, that
the countdown and `.ics` export match the real start time for visitors in other
timezones, that uploads are resized before they leave the browser, and that the
logo, moving strip and lightbox behave.

Screenshots from both browser runs are saved under `.audit-shots/`.

---

## Deploying

`render.yaml` sets the site up on Render's free tier, with a Supabase Postgres
database. Point Render at this repository, then set `ADMIN_PATH`,
`ADMIN_USERNAME`, `ADMIN_PASSWORD` and `DATABASE_URL` (Supabase's transaction
pooler string, port 6543) in the Render dashboard. Render generates
`SESSION_SECRET` itself and health-checks `/healthz`. Point an uptime pinger at
`/healthz` too: it keeps the free instance awake, and its database query keeps
the Supabase project from pausing after a week without activity.

To run it on your own server instead, `deploy-vps-alternative/` has a hardened
systemd unit, a Caddyfile for TLS and the www redirect, and a nightly backup
script.

---

## Contact

**The EthiCraft Club, PICT**
ethicraft.pict25@gmail.com · 98609 15506 / 70209 85163
