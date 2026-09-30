# 🧠 MS (HB38) Project Workspace

A small, self-contained team dashboard for the **HB38 Multiple Sclerosis** project —
meeting minutes, action items, a project timeline, literature, resources,
**file uploads**, and **email notifications**.

Built as **pure Node.js with zero npm dependencies**, so it runs anywhere Node runs
and starts instantly.

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

You only need **[Node.js](https://nodejs.org)** (the LTS version). Nothing else to install.

```bash
node server.js
```

Then open **http://localhost:8000** and sign in.

> Data is stored locally in `data.json` (workspace), `users.json` (accounts),
> and the `uploads/` folder. This local copy is **only on your computer** — see
> "Local vs cloud" below.

### Handy commands
```bash
node server.js set-password <username> <newpassword>   # change a password
node server.js set-email    <username> <email>         # set someone's alert email
node server.js list-users                              # list all accounts
```

---

## ☁️ Host it so the whole team can use it from anywhere

### Where to host — read this first

This app **saves data to files**, so it needs a host with **permanent storage**
and a **long-running server**. That rules out serverless hosts:

| Platform | Free | Auto-deploy on push | Keeps your data | Use it? |
|----------|:----:|:-------------------:|:---------------:|:-------:|
| **Fly.io** | ✅ (card required) | ✅ (via the included GitHub Action) | ✅ persistent volume | ✅ **Recommended** |
| Render (free) | ✅ | ✅ | ❌ wiped on restart | ⚠️ data loss |
| Vercel / Netlify | ✅ | ✅ | ❌ serverless, no disk | ❌ won't work |
| Railway | trial | ✅ | ✅ | 💰 paid after trial |

### Deploy to Fly.io

1. Install the Fly CLI → <https://fly.io/docs/flyctl/install/>
2. `fly auth login`
3. First time only — create the app + its persistent disk:
   ```bash
   fly apps create ms-hb38          # choose another name if this one is taken
   fly volumes create ms_data --region bom --size 1
   ```
4. Add the secrets (email + signup code; Google Drive backup is optional):
   ```bash
   fly secrets set BREVO_API_KEY=xkeysib-....
   fly secrets set SIGNUP_CODE=your-team-code
   fly secrets set RCLONE_CONF_B64="$(base64 -w0 rclone.conf)"   # optional: Drive backups
   ```
5. Deploy:
   ```bash
   fly deploy
   ```

Your live site: **https://ms-hb38.fly.dev** 🎉

---

## 🔁 Auto-deploy: your changes go live automatically

This repo ships with a GitHub Action (`.github/workflows/deploy.yml`) that
**redeploys the live site on every push to `main`**. Set it up once:

1. Create a deploy token:
   ```bash
   fly tokens create deploy
   ```
2. On GitHub: **repo → Settings → Secrets and variables → Actions → New repository secret**
   - Name: `FLY_API_TOKEN`
   - Value: *(paste the token)*

After that, your workflow is simply:

```bash
# edit code, test locally with `node server.js`, then:
git add .
git commit -m "my change"
git push
```

…and the live site updates itself within a minute. ✅

---

## 🖥️ Local vs cloud — important

| | Where data lives | Who sees it |
|---|---|---|
| **Local** (`localhost:8000`) | files on *your* computer | only you |
| **Cloud** (`ms-hb38.fly.dev`) | Fly.io persistent volume | the whole team, anywhere |

Use **local** to develop and test; the **cloud** version is the real shared
workspace. Push your changes to update the cloud version.

---

## 💾 Backups

When deployed with a Google Drive token (`RCLONE_CONF_B64`), the app tars up
`data.json`, `users.json` and `uploads/` to **Google Drive every 6 hours** and
keeps 30 days of history (`backup.sh`). Even without it, data is safe on Fly's
persistent volume.

---

## 📁 Project layout

| File | Purpose |
|------|---------|
| `server.js` | Backend HTTP server + API (Node, no dependencies) |
| `MS WORKSPACE.html` | The entire dashboard UI (single file) |
| `data.json` / `users.json` | Workspace content / accounts (passwords hashed) |
| `uploads/` | Uploaded files |
| `Dockerfile` · `fly.toml` · `entrypoint.sh` · `backup.sh` | Cloud deployment |
| `.github/workflows/deploy.yml` | Auto-deploy to Fly.io on push |
