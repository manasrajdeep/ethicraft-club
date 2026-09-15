# The EthiCraft Club · PICT

A complete website and admin portal for the EthiCraft Club at Pune Institute of
Computer Technology.

* **Public site** — a responsive landing page covering the club's aims, the VIBE
  and IMPACT modules, past speakers and a live **Upcoming Events** section.
* **Admin portal** — a password-protected dashboard at `/admin` where the club
  team uploads event posters, sets the date, time and Zoom link, and publishes an
  event straight onto the public site.

Built with Node.js + Express, PostgreSQL, Tailwind CSS and vanilla JavaScript.
No build step, no framework — clone it and run it.

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

Changing `ADMIN_PASSWORD` and restarting re-hashes the stored password, so that
is also how you rotate the admin credentials.

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

**Before you share the site**, sign in to `/admin`, edit that event and replace
the placeholder Zoom link (`https://zoom.us/j/0000000000`) with the real one.

---

## Directory structure

```
ethicraft-club/
├── package.json             # deps + npm scripts
├── .nvmrc                   # pins Node 20 for nvm users
├── .env.example             # copy to .env
├── README.md
│
├── server/
│   ├── index.js             # Express app: middleware, sessions, routes, errors
│   ├── db.js                # SQLite connection, schema, admin bootstrap
│   ├── auth.js              # password checks, session guards, login throttling
│   ├── seo.js               # robots.txt and sitemap.xml generation
│   └── routes/
│       ├── admin.js         # POST /login, POST /logout, GET /me
│       └── events.js        # public + admin event API, poster uploads
│
├── scripts/
│   └── seed.js              # pre-loads the Alumni Tales event (idempotent)
│
├── test/
│   ├── helpers.js           # boots the real server against a temp database
│   └── app.test.js          # 55 integration tests
│
├── deploy/
│   ├── ethicraft.service    # hardened systemd unit
│   ├── Caddyfile            # TLS + www->apex redirect
│   └── backup.sh            # nightly database + uploads backup
│
├── views/                   # HTML pages, served only via explicit routes
│   ├── index.html           # public landing page
│   ├── admin.html           # admin dashboard
│   ├── login.html           # admin login
│   └── 404.html
│
├── public/                  # static assets, served wholesale
│   ├── css/styles.css       # brand tokens + animations
│   ├── js/
│   │   ├── main.js          # landing page: fetches and renders events
│   │   └── admin.js         # dashboard: CRUD, uploads, publish toggle
│   └── assets/
│       ├── logo.png         # club logo
│       └── hero-bg.jpg      # hero background
│
├── uploads/                 # uploaded posters (served at /uploads/...)
│   └── seed-alumni-tales.jpg
│
└── data/
    └── ethicraft.db         # SQLite database (created on first run)
```

---

## Using the admin portal

1. Go to `http://localhost:3000<ADMIN_PATH>` and sign in.
2. Click **+ New event**.
3. Fill in the title, tagline, date, start/end time and mode.
   * **Zoom** → a meeting link is required before the event can be published.
   * **Offline / Hybrid** → a venue field appears instead.
4. Type topics separated by commas — `Placements, Campus Life, Role of AI`.
5. Drag a poster onto the upload box (JPG/PNG/WebP/GIF, up to 6 MB).
6. Tick **Publish to the public site**, or leave it unticked to save a draft
   only the club team can see.
7. **Save event.** Refresh the public site — it appears under Upcoming Events,
   and the next one up is featured in the hero.

Events dated in the past move automatically to the **Past** tab on the public
site. Use **Publish / Unpublish** on any row to toggle visibility without
deleting anything.

---

## Database schema

`data/ethicraft.db`, created automatically.

**`events`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | SERIAL | Primary key |
| `title` | TEXT | Required |
| `subtitle` | TEXT | Tagline |
| `description` | TEXT | Longer blurb |
| `event_date` | DATE | |
| `start_time`, `end_time` | TEXT | `HH:MM`, 24-hour |
| `mode` | TEXT | `Zoom` · `Offline` · `Hybrid` |
| `venue` | TEXT | Used when the mode is not Zoom |
| `zoom_link` | TEXT | Required to publish a Zoom event |
| `poster_data` | BYTEA | The image itself, served at `/posters/:id` |
| `poster_type`, `poster_name` | TEXT | MIME type and original filename |
| `topics` | JSONB | Array of strings |
| `published` | BOOLEAN | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

Posters live in the database rather than on disk, because a free Render
instance wipes its filesystem on every restart. At this site's scale (a handful
of posters) that keeps everything in one connection string and one free tier.
Past roughly fifty posters, move them to Supabase Storage.

**`admins`** — `id`, `username`, `password_hash` (bcrypt, 12 rounds), `created_at`.
**`user_sessions`** — created automatically by `connect-pg-simple`.

---

## API reference

### Public

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/events?scope=upcoming\|past\|all` | Published events only |
| `GET` | `/api/events/:id` | One published event |
| `GET` | `/posters/:id` | An event's poster image (cached, ETag) |

### Admin — all require a valid session cookie

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/admin/login` | `{ username, password }` |
| `POST` | `/api/admin/logout` | Ends the session |
| `GET` | `/api/admin/me` | Current admin |
| `GET` | `/api/admin/events` | All events, drafts included |
| `POST` | `/api/admin/events` | Create — `multipart/form-data`, optional `poster` |
| `PUT` | `/api/admin/events/:id` | Update — send `removePoster=1` to clear a poster |
| `PATCH` | `/api/admin/events/:id/publish` | `{ published: true \| false }` |
| `DELETE` | `/api/admin/events/:id` | Deletes the event and its poster file |

Validation errors come back as `400` with `{ "errors": ["...", "..."] }`.

---

## npm scripts

| Command | What it does |
| --- | --- |
| `npm start` | Start the server |
| `npm run dev` | Start with `--watch` (restarts on save) |
| `npm run seed` | Seed the initial event if the table is empty |
| `npm run reset-db` | **Deletes** the database and reseeds from scratch |
| `npm test` | Runs the full integration suite (68 tests) |
| `npm run test:responsive` | Drives a real browser across 11 device viewports |
| `npm run test:watch` | Same, re-running on file changes |

---

## Security notes

Implemented:

* Passwords hashed with bcrypt (12 rounds); logins are compared in constant time
  whether or not the username exists.
* `httpOnly`, `sameSite=lax` session cookies; the session ID is regenerated on
  login. Cookies are marked `Secure` when `NODE_ENV=production`.
* Login throttling — 8 failed attempts per IP locks that IP out for 15 minutes.
* Uploads are restricted to image MIME types and 6 MB, and are always saved
  under a server-generated random filename.
* All user-supplied text is HTML-escaped at render time, so a poster title
  containing markup is displayed, never executed.
* Server-side validation of dates, times, modes and URLs — the client-side
  checks are a convenience, not the gate.

Before putting this on a public server:

1. Set a real `SESSION_SECRET` and a strong `ADMIN_PASSWORD` in `.env`.
2. Set `NODE_ENV=production` and serve over HTTPS.
3. Swap the session store — the default `MemoryStore` drops every session on
   restart and leaks memory. `connect-sqlite3` slots in with a few lines.
4. Put the app behind nginx or Caddy for TLS and static file serving.
5. Back up `data/ethicraft.db` and `uploads/` — that is the entire site content.

---

## Customising

**Brand colours** live in two places, and both should be changed together:
`:root` in `public/css/styles.css`, and the `tailwind.config` block near the top
of each HTML file.

**Tailwind** is loaded from the Play CDN so the project runs with no build step.
That is the right trade for a club site. If you would rather compile it:

```bash
npm install -D tailwindcss
npx tailwindcss -i ./public/css/tailwind.css -o ./public/css/build.css --watch
```

…then drop the `<script src="https://cdn.tailwindcss.com">` tags and link
`build.css` instead.

**Content** — the aims, modules, entry criteria and speakers are plain HTML in
`views/index.html`, marked with comments. Edit them directly.

**Why `views/` is separate from `public/`** — `public/` is served by
`express.static`, so anything in it is reachable by anyone. Keeping the HTML in
`views/` means `/admin` is only ever reachable through the route that checks the
session; there is no `/admin.html` back door.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `FATAL ERROR: napi_get_last_error_info` on start | You are on Node 19 or older. `nvm use 20` (or newer), then `rm -rf node_modules && npm install`. |
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
dropped per run) and runs 68 integration
tests across twelve areas: infrastructure, security headers, admin portal
location, authentication, the public API, validation, poster uploads, attack
surface (path traversal, SQL injection, stored XSS, oversized bodies, brute
force), SEO output, frontend assets, theming and responsive rules.

```bash
npm run test:responsive
```

Drives a real Chromium across 11 device viewports (320px Galaxy Fold through
1920px desktop) on three pages, failing on horizontal overflow, elements that
escape the viewport, tap targets under 24px, and text under 11px.

---

## Deploying

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full path from a fresh VPS to
`https://ethicraft.in`, including GoDaddy DNS records, TLS, systemd and
backups. See **[SEO.md](SEO.md)** for what to do in Google Search Console once
the site is live.

---

## Contact

**The EthiCraft Club, PICT**
ethicraft.pict25@gmail.com · 98609 15506 / 70209 85163
