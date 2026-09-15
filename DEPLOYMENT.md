# Deploying ethicraft.in — step by step

Written for someone who has never deployed a website. Follow it in order and
don't skip steps. Total time: about an hour, most of it waiting.

You will use three free services:

| Service | What it does | Cost |
| --- | --- | --- |
| **GitHub** | Stores your code | Free |
| **Supabase** | Stores your events and posters | Free |
| **Render** | Runs the website | Free |

You already own **ethicraft.in** at GoDaddy. That is the fourth piece.

> **Before you start**, have ready: an email address you can check, and your
> GoDaddy login. **No credit card is needed for any of this.**

---

## Part 1 — Put the code on GitHub (15 min)

Render deploys from GitHub, so the code has to live there first.

### 1.1 Create a GitHub account

Go to **<https://github.com/signup>** and sign up. Verify your email.

### 1.2 Create an empty repository

1. Click the **+** in the top right → **New repository**.
2. **Repository name:** `ethicraft-club`
3. Select **Private**.
4. Do **not** tick "Add a README file".
5. Click **Create repository**.

Leave that page open — you need the URL from it in a moment.

### 1.3 Upload the code

On your Mac, open **Terminal** and run these one at a time:

```bash
cd ~/Downloads/ethicraft-club
git init
git add .
git commit -m "EthiCraft Club website"
git branch -M main
```

Now copy the URL GitHub is showing you (it looks like
`https://github.com/YOUR-USERNAME/ethicraft-club.git`) and run:

```bash
git remote add origin https://github.com/YOUR-USERNAME/ethicraft-club.git
git push -u origin main
```

GitHub will ask you to sign in. If it asks for a password, it actually wants a
**Personal Access Token** — go to
<https://github.com/settings/tokens> → *Generate new token (classic)* → tick
**repo** → generate → copy it → paste it as the password.

Refresh the GitHub page. Your files should be there.

> **Check:** your `.env` file must **not** appear on GitHub. It is excluded on
> purpose — it holds your password. If you see it listed, stop and tell me.

---

## Part 2 — Create the database on Supabase (10 min)

### 2.1 Sign up

Go to **<https://supabase.com>** → **Start your project** → sign in with GitHub
(easiest — you just made that account).

### 2.2 Create the project

1. Click **New project**.
2. **Name:** `ethicraft`
3. **Database Password:** click **Generate a password**, then **copy it
   somewhere safe right now**. You cannot see it again.
4. **Region:** `South Asia (Mumbai)` — closest to Pune.
5. Click **Create new project**.

It takes about two minutes to build. Wait for it to finish.

### 2.3 Copy the connection string

1. Click the **gear icon** (Project Settings) in the bottom left.
2. Click **Database**.
3. Scroll to **Connection string** and choose the **Transaction pooler** tab.
   It looks like:
   ```
   postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
   ```
4. Copy it, and **replace `[YOUR-PASSWORD]`** (including the square brackets)
   with the database password you saved in step 2.2.
5. Keep this line somewhere safe — it is your `DATABASE_URL`.

> **Use the Transaction pooler (port 6543), not the direct connection.** Render's
> free tier restarts often and opens a fresh connection each time; the direct
> connection runs out of slots and the site starts failing.

---

## Part 3 — Deploy the website on Render (15 min)

### 3.1 Sign up

Go to **<https://render.com>** → **Get Started** → sign in with GitHub.

### 3.2 Create the web service

1. Click **New +** → **Web Service**.
2. Connect your GitHub account when prompted, and give Render access to the
   `ethicraft-club` repository.
3. Select **ethicraft-club** from the list.
4. Fill in:
   - **Name:** `ethicraft`
   - **Region:** `Singapore`
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** `npm ci`
   - **Start Command:** `node server/index.js`
   - **Instance Type:** **Free**

### 3.3 Add the settings

Scroll to **Environment Variables** and click **Add Environment Variable** for
each of these:

| Key | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `SITE_ORIGIN` | `https://ethicraft.in` |
| `ADMIN_PATH` | `/adminkrsna` |
| `ADMIN_USERNAME` | `harekrishna` |
| `ADMIN_PASSWORD` | your password |
| `DATABASE_URL` | the Supabase line from step 2.3 |
| `SESSION_SECRET` | see below |

For `SESSION_SECRET`, run this in Terminal and paste the result:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3.4 Deploy

Click **Create Web Service**. Watch the log. After two or three minutes you
should see:

```
EthiCraft Club — production
```

Render gives you a temporary address like `https://ethicraft.onrender.com`.
**Open it.** The site should load, in night mode, with the Alumni Tales event.

> If it fails, read the last few lines of the log. `DATABASE_URL must point at
> your Supabase Postgres database` means that variable is missing or misspelled.

---

## Part 4 — Connect ethicraft.in (20 min, mostly waiting)

### 4.1 Tell Render about the domain

1. In Render, open your service → **Settings** → scroll to **Custom Domains**.
2. Click **Add Custom Domain** → type `ethicraft.in` → **Save**.
3. Add a second one: `www.ethicraft.in`.
4. Render now shows you the DNS values it wants. **Keep this tab open.**

### 4.2 Point the domain at Render

1. Go to **<https://dcc.godaddy.com/domains>** and sign in.
2. Find **ethicraft.in** → click it → **DNS** → **Manage DNS**.
3. **Delete GoDaddy's parking records first** — usually an `A` record on `@`
   pointing at a GoDaddy IP, and a `CNAME` on `www`. Leave any `MX` records
   alone if you use email on this domain.
4. Add what Render showed you in step 4.1. It is normally:

   | Type | Name | Value | TTL |
   | --- | --- | --- | --- |
   | `A` | `@` | the IP Render displays | 600 |
   | `CNAME` | `www` | `ethicraft.onrender.com` | 600 |

   **Use the exact values from your Render tab**, not these examples.
5. Click **Save**.

### 4.3 Wait, then verify

DNS changes take anywhere from ten minutes to a couple of hours. Check with:

```bash
dig +short ethicraft.in
```

When it prints Render's IP, go back to the Render tab and click **Verify**.
Render then issues the HTTPS certificate automatically — another few minutes.

Then open **<https://ethicraft.in>**. You should see a padlock in the address
bar.

---

## Part 5 — Keep it awake (5 min)

Render's free tier puts your site to sleep after 15 minutes with no visitors.
The next student then waits about 50 seconds for it to wake. Supabase separately
pauses after 7 days with no database queries.

One free uptime pinger fixes both:

1. Go to **<https://cron-job.org>** and sign up (free).
2. **Create cronjob**:
   - **Title:** `Keep EthiCraft awake`
   - **URL:** `https://ethicraft.in/healthz`
   - **Schedule:** every **10 minutes**
3. Save and enable it.

`/healthz` runs a tiny database query, so a single ping keeps Render awake **and**
stops Supabase pausing. Hitting it every 10 minutes uses about 730 hours a
month, which fits inside Render's 750-hour free allowance.

---

## Part 6 — First run (5 min)

1. Go to **<https://ethicraft.in/adminkrsna>**.
2. Sign in with your username and password.
3. Open the Alumni Tales event and replace the placeholder Zoom link with the
   real one. Save.
4. Check it appears on the public homepage.
5. Upload a poster to confirm uploads work.

Then submit the site to Google — see **[SEO.md](SEO.md)**.

---

## Updating the site later

Whenever you change something:

```bash
cd ~/Downloads/ethicraft-club
git add .
git commit -m "describe what changed"
git push
```

Render redeploys automatically within a couple of minutes. You never touch the
server.

---

## What to expect from the free tier

| | Reality |
| --- | --- |
| Visitors | 1,000 students is nowhere near any limit |
| Posters | 8 posters ≈ 3 MB of your 500 MB database — 0.6% used |
| Speed | Instant while the pinger keeps it awake |
| Data safety | Your events and posters live in Supabase and survive every restart and redeploy |
| Cost | ₹0 |

**Two things to know.** Supabase free projects can be paused if the database
sees no queries for 7 days — the pinger prevents this, but if you ever disable
it over a long holiday, just log into Supabase and click **Restore**; nothing is
lost. And Supabase's free tier has no automatic backups, so before any big
change, use **Table Editor → events → Export to CSV**.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Render log: `DATABASE_URL must point at...` | The variable is missing or misspelled in Render → Environment. |
| Render log: `password authentication failed` | You forgot to replace `[YOUR-PASSWORD]` in the connection string. |
| Render log: `too many connections` | You used the direct connection. Switch to the **Transaction pooler** string (port 6543). |
| Site loads but events are empty | Supabase project is paused. Open Supabase and click **Restore**. |
| `dig` shows the wrong IP | GoDaddy's old parking record is still there. Delete it. |
| Certificate not issuing | DNS has not propagated yet. Wait, then click **Verify** in Render again. |
| First visit takes ~50 seconds | The site went to sleep. Set up the pinger in Part 5. |
| Admin password not working | Change `ADMIN_PASSWORD` in Render → Environment, then **Manual Deploy → Deploy latest commit**. |

---

## Running it on your own Mac

```bash
brew services start postgresql@15
createdb ethicraft_dev
npm install
npm start
```

Open <http://localhost:3000>. Tests: `npm test`.

---

## Alternative: your own server

If you ever outgrow the free tier, `deploy-vps-alternative/` holds a systemd
unit, a Caddy config and a backup script for running this on a normal VPS.
You would also switch `DATABASE_URL` to a Postgres instance on that machine.
