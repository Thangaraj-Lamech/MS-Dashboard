# 🧠 MS (HB38) Project Workspace

A small, self-contained team dashboard for the **HB38 Multiple Sclerosis** project —
meeting minutes, action items, a project timeline, literature, resources,
**file uploads**, and **email notifications**.

Runs as a tiny Node.js server. Locally it uses plain files (zero setup); in the
cloud it uses a free database so nothing is ever lost.

---

## ✨ Features

- 🔐 **Accounts** with hashed passwords + **self-signup** (optional shared team code)
- 📝 **Meeting minutes** and per-meeting **action items** with owners & due dates
- 🏠 **Home overview**, **My tasks**, **Action items**, and a **Timeline** view
- 📚 **Literature** & **Resources** libraries, grouped by category
- 📎 **File uploads** — attach documents to tasks, literature and resources
- 🔔 **Notifications** — in-app deadline bell + emails on new task assignment and a daily deadline digest
- 📱 **Mobile-friendly** — works on phones and tablets

---

## 🚀 Run it on your own computer

You only need **[Node.js](https://nodejs.org)** (the LTS version).

```bash
npm install        # installs one small package
node server.js
```

Then open **http://localhost:8000** and sign in.

> With no database configured, it stores everything in local files
> (`data.json`, `users.json`, `uploads/`). This is your personal copy — see
> "Local vs cloud" below.

### Handy commands
```bash
node server.js set-password <username> <newpassword>   # change a password
node server.js set-email    <username> <email>         # set someone's alert email
node server.js list-users                              # list all accounts
```

---

## ☁️ Host it free (no credit card) — Render + Turso

Render's free tier has no permanent disk, so the app keeps its data in a free
**Turso** database instead. Neither service needs a card.

### Step A — create the database (Turso)
1. Sign up at <https://turso.tech> (free, no card — sign in with GitHub)
2. Create a database (any name, e.g. `ms-hb38`)
3. Copy two values:
   - the **Database URL** (looks like `libsql://ms-hb38-you.turso.io`)
   - a **database token** (create one for the database)

### Step B — deploy the app (Render)
1. Sign up at <https://render.com> (free, no card — sign in with GitHub)
2. **New → Blueprint** → connect the **MS-Dashboard** repo (Render reads `render.yaml`)
3. When prompted, fill the environment variables:
   | Variable | Value |
   |----------|-------|
   | `TURSO_URL` | the Turso Database URL |
   | `TURSO_TOKEN` | the Turso token |
   | `SIGNUP_CODE` | a shared code teammates type when signing up |
   | `APP_URL` | your Render URL, e.g. `https://ms-hb38.onrender.com` |
   | `BREVO_API_KEY` | *(optional — for email; leave blank to skip)* |
4. Click **Apply / Create**. Your live site: **https://ms-hb38.onrender.com** 🎉

> Free Render services **sleep after ~15 min idle**; the first visit after that
> takes ~30–50s to wake, then it's fast. Your data is safe in Turso regardless.

---

## 🔁 Auto-deploy: your changes go live automatically

Render watches the GitHub repo. With `autoDeploy: true` (already set in
`render.yaml`), **every push to `main` redeploys the live site** — no extra setup:

```bash
# edit code, test locally with `node server.js`, then:
git add .
git commit -m "my change"
git push
```

…and the live site updates itself in a minute or two. ✅

---

## 🖥️ Local vs cloud — important

| | Where data lives | Who sees it |
|---|---|---|
| **Local** (`localhost:8000`, no DB set) | files on *your* computer | only you |
| **Cloud** (`…onrender.com`, Turso set) | the Turso database | the whole team, anywhere |

Use **local** to develop and test; the **cloud** version is the real shared
workspace. Push your changes to update the cloud version.

---

## 📁 Project layout

| Path | Purpose |
|------|---------|
| `server.js` | Backend server + API (files locally, Turso database in the cloud) |
| `MS WORKSPACE.html` | The entire dashboard UI (single file) |
| `render.yaml` | Render deployment blueprint (auto-deploy) |
| `package.json` | Node project + the one dependency (`@libsql/client`) |
| `data.json` / `users.json` | Local-mode workspace / accounts (passwords hashed) |
| `deploy-fly/` | Alternative Fly.io deployment (needs a card) — kept for the future |
