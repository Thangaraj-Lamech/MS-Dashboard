/* ============================================================
   MS (HB38) Project Workspace — shared backend
   ------------------------------------------------------------
   Pure Node.js (no npm packages). It:
     - serves the dashboard HTML
     - authenticates the 4 team accounts with HASHED passwords
     - stores ONE shared workspace on disk (data.json) so every
       account sees and edits the same data

   RUN:            node server.js
   CHANGE A PW:    node server.js set-password <username> <newpassword>

   Files it creates next to itself:
     users.json  - usernames + salted password hashes (no plaintext)
     data.json   - the shared workspace content
     secret.key  - random key used to sign login tokens
   ============================================================ */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------
   Where persistent data lives — two backends, picked at startup:
     • Locally (no TURSO_URL set): plain files in this folder.
       Zero setup — just `node server.js`.
     • In the cloud (TURSO_URL set, e.g. on Render): a Turso
       (libSQL/SQLite) database, because hosts like Render have
       NO permanent disk. Accounts, workspace and uploaded files
       all live in the database and survive restarts/redeploys.
   Everything goes through the async `store` interface below, so
   the rest of the app doesn't care which backend is active.
   ------------------------------------------------------------ */
const ROOT        = __dirname;
const DATA_DIR    = process.env.DATA_DIR || ROOT;
const PORT        = process.env.PORT || 8000;
const HTML_FILE   = path.join(ROOT, 'MS WORKSPACE.html');
const DATA_FILE   = path.join(DATA_DIR, 'data.json');
const USERS_FILE  = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const UPLOAD_DIR  = path.join(DATA_DIR, 'uploads');

/* ---- email / signup / app config (all via env; safe defaults) ---- */
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const MAIL_FROM     = process.env.MAIL_FROM     || 'brainsgbc@gmail.com';
const MAIL_FROM_NAME= process.env.MAIL_FROM_NAME|| 'MS HB38 Workspace';
const APP_URL       = process.env.APP_URL       || 'https://ms-hb38.onrender.com';
// Optional shared code required to self-register. Empty string = open signup.
const SIGNUP_CODE   = process.env.SIGNUP_CODE   || '';
// Cloud database (Turso). When unset, the app uses local files instead.
const TURSO_URL     = process.env.TURSO_URL   || process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN   = process.env.TURSO_TOKEN || process.env.TURSO_AUTH_TOKEN   || '';

/* ============================================================
   Storage backends. Both expose the same async interface:
     init(), getKV(k), setKV(k,v), getSecret(), setSecret(buf),
     putFile(id,name,mime,size,buf), getFile(id)
   ============================================================ */
const fileStore = {
  kind: 'files',
  _path(k){ return k === 'data' ? DATA_FILE : k === 'users' ? USERS_FILE : path.join(DATA_DIR, k + '.kv'); },
  async init(){ try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {} },
  async getKV(k){ try { return fs.readFileSync(this._path(k), 'utf8'); } catch (e) { return null; } },
  async setKV(k, v){ fs.writeFileSync(this._path(k), v); },
  async getSecret(){ try { return fs.readFileSync(SECRET_FILE); } catch (e) { return null; } },
  async setSecret(buf){ fs.writeFileSync(SECRET_FILE, buf); },
  async putFile(id, name, mime, size, buf){ fs.writeFileSync(path.join(UPLOAD_DIR, id + '__' + name), buf); },
  async getFile(id){
    if (!/^[a-f0-9]{6,}$/.test(String(id || ''))) return null;
    let f; try { f = fs.readdirSync(UPLOAD_DIR).find(x => x.startsWith(id + '__')); } catch (e) { return null; }
    if (!f) return null;
    const name = f.slice(id.length + 2);
    return { name, mime: mimeFor(name), data: fs.readFileSync(path.join(UPLOAD_DIR, f)) };
  }
};

let _db = null;
function db(){
  if (!_db) {
    const { createClient } = require('@libsql/client');
    _db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN || undefined });
  }
  return _db;
}
const dbStore = {
  kind: 'turso',
  async init(){
    await db().execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
    await db().execute("CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT, mime TEXT, size INTEGER, data BLOB)");
  },
  async getKV(k){
    const r = await db().execute({ sql: "SELECT v FROM kv WHERE k = ?", args: [k] });
    return r.rows.length ? r.rows[0].v : null;
  },
  async setKV(k, v){
    await db().execute({ sql: "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", args: [k, v] });
  },
  async getSecret(){ const s = await this.getKV('secret'); return s ? Buffer.from(s, 'hex') : null; },
  async setSecret(buf){ await this.setKV('secret', buf.toString('hex')); },
  async putFile(id, name, mime, size, buf){
    await db().execute({ sql: "INSERT INTO files (id, name, mime, size, data) VALUES (?, ?, ?, ?, ?)", args: [id, name, mime, size, buf] });
  },
  async getFile(id){
    if (!/^[a-f0-9]{6,}$/.test(String(id || ''))) return null;
    const r = await db().execute({ sql: "SELECT name, mime, data FROM files WHERE id = ?", args: [id] });
    if (!r.rows.length) return null;
    const row = r.rows[0];
    let data = row.data;
    if (!Buffer.isBuffer(data)) data = Buffer.from(data);   // libsql returns BLOB as ArrayBuffer/Uint8Array
    return { name: row.name, mime: row.mime || mimeFor(row.name), data };
  }
};

const store = TURSO_URL ? dbStore : fileStore;

/* ---- signing secret (for login tokens); loaded from `store` at boot ---- */
let SECRET;
async function loadSecret(){
  let s = await store.getSecret();
  if (!s) { s = crypto.randomBytes(32); await store.setSecret(s); }
  SECRET = s;
}

/* ---- password hashing (scrypt) ---- */
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(h, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---- the 4 accounts (default password ms2026 — change it!) ---- */
const DEFAULT_USERS = [
  { username: 'thangaraj',  name: 'Thangaraj',  password: 'ms2026', email: '' },
  { username: 'anjana',     name: 'Anjana',     password: 'ms2026', email: '' },
  { username: 'rakesh',     name: 'Rakesh',     password: 'ms2026', email: '' },
  { username: 'nachiammai', name: 'Nachiammai', password: 'ms2026', email: '' }
];

async function loadUsers() {
  const raw = await store.getKV('users');
  if (raw) {
    const users = JSON.parse(raw);
    users.forEach(u => { if (typeof u.email !== 'string') u.email = ''; }); // older records may predate email
    return users;
  }
  const users = DEFAULT_USERS.map(u => {
    const { salt, hash } = hashPassword(u.password);
    return { username: u.username.toLowerCase(), name: u.name, email: u.email || '', salt, hash };
  });
  await store.setKV('users', JSON.stringify(users, null, 2));
  console.log('Seeded the 4 default accounts (password: ms2026).');
  return users;
}
async function saveUsers(users) { await store.setKV('users', JSON.stringify(users, null, 2)); }

/* ---- CLI commands (run at boot in main(), so they can await the store) ---- */
const CLI_COMMANDS = ['set-password', 'set-email', 'list-users'];
async function runCLI(cmd) {
  if (cmd === 'set-password') {
    const uname = String(process.argv[3] || '').toLowerCase();
    const pw    = process.argv[4];
    if (!uname || !pw) { console.error('Usage: node server.js set-password <username> <newpassword>'); process.exit(1); }
    const users = await loadUsers();
    const u = users.find(x => x.username === uname);
    if (!u) { console.error('No such user:', uname); process.exit(1); }
    const { salt, hash } = hashPassword(pw);
    u.salt = salt; u.hash = hash;
    await saveUsers(users);
    console.log('Password updated for', uname);
  } else if (cmd === 'set-email') {
    const uname = String(process.argv[3] || '').toLowerCase();
    const email = String(process.argv[4] || '').trim();
    if (!uname || !email) { console.error('Usage: node server.js set-email <username> <email>'); process.exit(1); }
    const users = await loadUsers();
    const u = users.find(x => x.username === uname);
    if (!u) { console.error('No such user:', uname); process.exit(1); }
    u.email = email;
    await saveUsers(users);
    console.log('Email updated for', uname, '->', email);
  } else if (cmd === 'list-users') {
    (await loadUsers()).forEach(u => console.log(u.username + '\t' + (u.email || '(no email)') + '\t' + u.name));
  }
}

/* ---- shared workspace data ---- */
function uid() { return crypto.randomBytes(5).toString('hex'); }

function seedData() {
  return {
    members: ['Thangaraj', 'Anjana', 'Rakesh', 'Nachiammai', 'Richa', 'Supriti', 'Easha'],
    literature: [],
    resources: [],
    meetings: [
      {
        id: uid(),
        date: '2026-08-21',
        title: 'HB38 — SPMS Histopathological Mapping | Discussion with Dr Stephanie Zandee',
        attendees: 'Stephanie, Richa, Anjana, Easha',
        notes:
`Time: 6:30 PM – 7:30 PM IST · Mode: Video call · Prepared by: Anjana

Background
Anjana presented an overview of the HB38 project — histopathological mapping of demyelination in a case of Secondary Progressive Multiple Sclerosis (SPMS) — to Dr. Stephanie, covering clinical history, MRI summary, gross pathology, histology findings (HE/LFB/IHC staining), lesion classification, new IHC targets, automated GM/WM detection analytics, and the proposed scope for molecular work.

1. MRI Analysis
- The team is looking to procure clinical MRI data (currently only radiology reports are available) to enable detailed analysis.
- Rakesh had prepared an MRI analysis based on the radiological reports available; a region-wise summary resulted in a heatmap showing MRI-documented disease burden by brain and spinal cord regions (2010–2022), shared in the presentation.
- Stephanie highlighted paramagnetic rim lesions (PRLs) as an important and interesting aspect to analyse once MRI data is available.
- She also suggested looking at pre-active and active lesions on MRI (via perivascular cuffing/infiltrates) as a way to explore early signs of MS.

2. Staining Recommendations
- Stephanie suggested performing Oil Red O staining, which helps identify active myelin breakdown — distinguishing actively demyelinating tissue from chronic, inactive lesions.
- She offered to share the Oil Red O protocol, along with other iron-staining protocols worth trying.

3. Tissue Sectioning Plan
- Based on the disease-burden mapping, the posterior and cerebellum blocks of HB38 (currently frozen) need to be planned and sectioned.

4. Analytics
- The GM/WM automated-detection algorithm requires further fine-tuning (ongoing work led by Rakesh).
- Interest in extending analysis to grey-matter lesions, cortical damage, and meningeal inflammation.

5. Scope for Molecular Work
- Explore feasibility of spatial transcriptomics on this tissue, contingent on compatibility with FFPE (formalin-fixed, paraffin-embedded) samples.

6. Additional Ideas Suggested by Stephanie
- Comparative analysis of active lesions in the cortex and brainstem.
- Region-wise comparison of active vs. inactive lesions across the whole brain.
- Development of a trajectory of GM and WM damage over the disease course.
- She also offered to share relevant literature/papers with the team.

Note: These minutes are based on notes taken during the discussion; the session could not be fully transcribed. Dr Stephanie will be requested to review, add any missed points, and correct anything captured inaccurately.`,
        actionItems: [
          { id: uid(), task: 'Procure clinical MRI data for detailed analysis', owner: '', dueDate: '', status: 'open' },
          { id: uid(), task: 'Explore paramagnetic rim lesions (PRLs) once MRI data is available', owner: '', dueDate: '', status: 'open' },
          { id: uid(), task: 'Continue / extend region-wise MRI disease-burden analysis (heatmap already shared)', owner: '', dueDate: '', status: 'open' },
          { id: uid(), task: 'Look at pre-active and active lesions on MRI (perivascular cuffing/infiltrates) to explore early MS signs', owner: '', dueDate: '', status: 'open' },
          { id: uid(), task: 'Follow up on Oil Red O and other iron-staining protocols from Stephanie', owner: '', dueDate: '', status: 'open' },
          { id: uid(), task: 'Perform Oil Red O staining to distinguish actively demyelinating vs. chronic inactive tissue', owner: '', dueDate: '', status: 'open' },
          { id: uid(), task: 'Plan and section the posterior and cerebellum blocks of HB38 (currently frozen)', owner: '', dueDate: '', status: 'open' },
          { id: uid(), task: 'Fine-tune GM/WM automated-detection algorithm', owner: '', dueDate: '', status: 'open' },
          { id: uid(), task: 'Examine grey-matter lesions, cortical damage, and meningeal inflammation', owner: '', dueDate: '', status: 'open' },
          { id: uid(), task: 'Arrange LIMS access for Stephanie', owner: '', dueDate: '', status: 'open' }
        ]
      },
      {
        id: uid(),
        date: '2026-09-03',
        title: 'MS Weekly Update Meeting — HB38 Project',
        attendees: 'Rakesh, Anjana, Thangaraj, Nachiammai, Supriti',
        notes:
`Prepared by: Anjana
Note: this is now a recurring weekly meeting, held every Thursday, 2:00 PM – 3:00 PM.

Priority Item
The main priority is to get the status of all sections of HB38R (M2P), Block 535, at the earliest, in order to begin stacking and registration work.

1. Oil Red O Staining — discussion on procurement of reagents and purpose (assessing active myelin breakdown). Rakesh suggested running a few trials on HB38R (M2P), Block ID: 535, while awaiting the staining protocol from Stephanie.

2. Dashboard & Histological Processing Coordination — the dashboard needs updating, primarily for block 535 and other blocks. Coordination is needed with one Histotech and one scanning team member. Karthikeyan has assigned Bodhini (Histotech) and Gokul (scanning team) to the HB38 MS case.

3. Registration — Supriti shared her opinions on the registration process. The team has started a sheet, '535 Histology Reconstruction', which needs to be filled ASAP so Supriti can begin registration and stacking work.

4. GM/WM Detectors — Rakesh explained how the automated detection studio works for GM/WM and CD68 detection. Thangaraj is to manually annotate one section (block 535) before the next meeting.

5. MRI — Rakesh briefed the team on visualizing Ex vivo MRI using ITK-SNAP. Efforts to procure pre-mortem MRI are happening in parallel.

6. Follow-up Meeting with Stephanie — Rakesh will send the follow-up email to schedule the next meeting.

7. LIMS / Open Atlas Access for Stephanie — Richa will have a word with Rakesh and Supriti regarding granting access.

8. Sectioning Plan — sectioning of the cerebellum + brainstem block will begin from next week onwards.

9. New IHC Markers — discussion on new IHC markers and analysis to be taken up.

Next Meeting: Thursday, 10 September 2026, 2:00 PM – 3:00 PM (recurring weekly slot).
Notes: Nachiammai will decide and tell which aspect of the project she is interested in.`,
        actionItems: [
          { id: uid(), task: 'Confirm reagent delivery timeline and start date for Oil Red O trial staining on HB38R (M2P), Block ID: 535', owner: 'Anjana', dueDate: '', status: 'open' },
          { id: uid(), task: 'Coordinate with Bodhini (Histotech) and Gokul (scanning team) for smooth, active histological processing of block 535 and other blocks', owner: 'Thangaraj', dueDate: '', status: 'open' },
          { id: uid(), task: "Fill the '535 Histology Reconstruction' Gsheet ASAP to enable Supriti to begin registration and stacking work", owner: 'Thangaraj', dueDate: '', status: 'open' },
          { id: uid(), task: 'Manually annotate section 1061 (block 535) before the next meeting', owner: 'Thangaraj', dueDate: '2026-09-10', status: 'open' },
          { id: uid(), task: 'Continue efforts to procure pre-mortem MRI', owner: 'Richa', dueDate: '', status: 'open' },
          { id: uid(), task: 'Send follow-up email to Dr. Stephanie regarding next meeting', owner: 'Rakesh', dueDate: '', status: 'open' },
          { id: uid(), task: 'Discuss LIMS / Open Atlas access for Dr. Stephanie with Rakesh and Supriti', owner: 'Richa', dueDate: '', status: 'open' },
          { id: uid(), task: 'Begin sectioning of the cerebellum + brainstem block', owner: 'Anjana', dueDate: '', status: 'open' },
          { id: uid(), task: 'Progress work on new IHC markers and analysis', owner: 'Anjana', dueDate: '', status: 'open' }
        ]
      }
    ]
  };
}

async function loadData() {
  const raw = await store.getKV('data');
  if (raw) return JSON.parse(raw);
  const d = seedData();
  await store.setKV('data', JSON.stringify(d, null, 2));
  return d;
}
async function saveData(d) { await store.setKV('data', JSON.stringify(d, null, 2)); }

/* ============================================================
   Email + notifications
   ------------------------------------------------------------
   Sends through Brevo's transactional-email HTTP API (no SMTP,
   no npm packages). If BREVO_API_KEY is unset, email is simply
   skipped and logged — the app keeps working, in-app alerts
   still show.
   ============================================================ */
const https = require('https');

function sendEmail(to, subject, html) {
  return new Promise(resolve => {
    if (!BREVO_API_KEY) { console.log('[email skipped: no BREVO_API_KEY]', to, '-', subject); return resolve(false); }
    if (!to) return resolve(false);
    const payload = JSON.stringify({
      sender: { email: MAIL_FROM, name: MAIL_FROM_NAME },
      to: [{ email: to }],
      subject: subject,
      htmlContent: html
    });
    const req = https.request({
      hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json',
                 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
        else { console.error('[email failed]', res.statusCode, b); resolve(false); }
      });
    });
    req.on('error', e => { console.error('[email error]', e.message); resolve(false); });
    req.write(payload); req.end();
  });
}

function emailShell(bodyHtml) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#22303F">
    <div style="border-bottom:2px solid #22303F;padding-bottom:10px;margin-bottom:18px">
      <span style="font-size:18px;font-weight:600">Multiple Sclerosis (HB38) Project Workspace</span>
    </div>
    ${bodyHtml}
    <p style="margin-top:24px"><a href="${APP_URL}" style="background:#22303F;color:#fff;text-decoration:none;padding:9px 16px;border-radius:4px;display:inline-block">Open the workspace</a></p>
    <p style="color:#5B6672;font-size:12px;margin-top:22px;border-top:1px solid #E9E4D8;padding-top:12px">
      You're receiving this because you're a member of the HB38 workspace.</p>
  </div>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

// name (as shown in the app) -> user record, for looking up an owner's email
async function userByName(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  const users = await loadUsers();
  return users.find(u => (u.name || '').toLowerCase() === n || u.username === n) || null;
}

/* Build owner-per-task map so we can detect *newly assigned* tasks on save. */
function ownerMap(data) {
  const m = {};
  (data.meetings || []).forEach(mt => (mt.actionItems || []).forEach(ai => {
    if (ai && ai.id) m[ai.id] = { owner: ai.owner || '', task: ai.task || '', due: ai.dueDate || '',
                                  meeting: mt.title || '' };
  }));
  return m;
}

/* Compare old vs new workspace; email anyone freshly assigned a task. */
async function notifyAssignments(oldData, newData) {
  try {
    const before = ownerMap(oldData), after = ownerMap(newData);
    for (const id in after) {
      const a = after[id], b = before[id];
      const newlyAssigned = a.owner && (!b || b.owner !== a.owner);
      if (!newlyAssigned) continue;
      const u = await userByName(a.owner);
      if (!u || !u.email) continue;
      const dueLine = a.due ? `<p><strong>Due:</strong> ${esc(a.due)}</p>` : '';
      await sendEmail(u.email, 'New task assigned to you — HB38 Workspace',
        emailShell(`<p>Hi ${esc(u.name)},</p>
          <p>You've been assigned a new action item:</p>
          <blockquote style="border-left:3px solid #B8823D;margin:0;padding:8px 14px;background:#F5EBDA">
            ${esc(a.task)}</blockquote>
          ${dueLine}
          <p style="color:#5B6672;font-size:13px">From: ${esc(a.meeting)}</p>`));
    }
  } catch (e) { console.error('notifyAssignments error', e); }
}

/* Daily digest: each user's open tasks that are overdue or due within 2 days. */
let lastDigestDay = '';
async function runDeadlineDigest() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const data = await loadData();
    const perOwner = {};
    (data.meetings || []).forEach(mt => (mt.actionItems || []).forEach(ai => {
      if (!ai || ai.status === 'done' || !ai.owner || !ai.dueDate) return;
      if (ai.dueDate <= soon) (perOwner[ai.owner] = perOwner[ai.owner] || []).push(ai);
    }));
    for (const owner in perOwner) {
      const u = await userByName(owner);
      if (!u || !u.email) continue;
      const items = perOwner[owner].sort((a, b) => (a.dueDate).localeCompare(b.dueDate));
      const rows = items.map(ai => {
        const overdue = ai.dueDate < today;
        const tag = overdue ? '<span style="color:#A6483C;font-weight:600">OVERDUE</span>'
                            : '<span style="color:#B8823D">due ' + esc(ai.dueDate) + '</span>';
        return `<li style="margin-bottom:8px">${esc(ai.task)} — ${tag}</li>`;
      }).join('');
      await sendEmail(u.email, 'Your HB38 tasks — deadlines coming up',
        emailShell(`<p>Hi ${esc(u.name)},</p>
          <p>Here are your open tasks that are overdue or due within 2 days:</p>
          <ul style="padding-left:18px">${rows}</ul>`));
    }
    lastDigestDay = today;
  } catch (e) { console.error('runDeadlineDigest error', e); }
}

/* Check hourly; send the digest once per day around/after 07:00 server time. */
function startDigestTimer() {
  setInterval(() => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() >= 7 && lastDigestDay !== today) runDeadlineDigest();
  }, 60 * 60 * 1000);
}

/* ---- stateless login tokens (signed, 30-day expiry) ---- */
function makeToken(username) {
  const payload = Buffer.from(JSON.stringify({
    u: username, exp: Date.now() + 1000 * 60 * 60 * 24 * 30
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); }
  catch (e) { return null; }
  if (!data.exp || data.exp < Date.now()) return null;
  return data.u;
}

/* ---- helpers ---- */
function sendJSON(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}
function readBody(req, maxBytes) {
  maxBytes = maxBytes || 5e6;
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > maxBytes) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

/* ---- uploaded-file helpers (stored on disk as "<id>__<original name>") ---- */
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;         // 25 MB per file (base64 body ~33% bigger)
const MIME = {
  pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif',
  webp:'image/webp', svg:'image/svg+xml', txt:'text/plain; charset=utf-8', csv:'text/csv',
  doc:'application/msword', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:'application/vnd.ms-excel', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt:'application/vnd.ms-powerpoint', pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip:'application/zip'
};
function safeName(n) {
  return String(n || 'file').replace(/[^\w.\- ()]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'file';
}
function mimeFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}
/* ---- login rate limiting: max 10 failed attempts per IP per 15 min ---- */
const failedLogins = new Map(); // ip -> { count, first }
const MAX_FAILS = 10, WINDOW_MS = 15 * 60 * 1000;
function clientIp(req) {
  // behind the Cloudflare tunnel the real visitor IP arrives in this header
  return req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
}
function isLockedOut(ip) {
  const f = failedLogins.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) { failedLogins.delete(ip); return false; }
  return f.count >= MAX_FAILS;
}
function recordFail(ip) {
  const f = failedLogins.get(ip);
  if (!f || Date.now() - f.first > WINDOW_MS) failedLogins.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

function authUser(req) {
  const auth = req.headers['authorization'] || '';
  return verifyToken(auth.replace(/^Bearer\s+/i, ''));
}

/* ---- server ---- */
const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];

    if (url === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (isLockedOut(ip)) {
        return sendJSON(res, 429, { error: 'Too many failed attempts. Try again in 15 minutes.' });
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const users = await loadUsers();
      const u = users.find(x => x.username === String(body.username || '').trim().toLowerCase());
      if (!u || !verifyPassword(String(body.password || ''), u.salt, u.hash)) {
        recordFail(ip);
        return sendJSON(res, 401, { error: 'Invalid username or password' });
      }
      failedLogins.delete(ip);
      return sendJSON(res, 200, { token: makeToken(u.username), name: u.name });
    }

    /* ---- self-signup: create your own account ---- */
    if (url === '/api/signup' && req.method === 'POST') {
      const ip = clientIp(req);
      if (isLockedOut(ip)) return sendJSON(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const name     = String(body.name || '').trim();
      const username = String(body.username || '').trim().toLowerCase();
      const email    = String(body.email || '').trim();
      const password = String(body.password || '');
      const code     = String(body.code || '');

      if (SIGNUP_CODE && code !== SIGNUP_CODE) {
        recordFail(ip);
        return sendJSON(res, 403, { error: 'Wrong team access code. Ask the project admin for it.' });
      }
      if (!name || !username || !password)
        return sendJSON(res, 400, { error: 'Name, username and password are all required.' });
      if (!/^[a-z0-9_]{3,20}$/.test(username))
        return sendJSON(res, 400, { error: 'Username must be 3–20 characters: lowercase letters, numbers or _.' });
      if (password.length < 8)
        return sendJSON(res, 400, { error: 'Password must be at least 8 characters.' });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        return sendJSON(res, 400, { error: 'That email address looks invalid.' });

      const users = await loadUsers();
      if (users.some(u => u.username === username))
        return sendJSON(res, 409, { error: 'That username is already taken.' });

      const { salt, hash } = hashPassword(password);
      users.push({ username, name, email, salt, hash });
      await saveUsers(users);

      // add the new member to the shared members list so they can be assigned tasks
      const data = await loadData();
      if (!Array.isArray(data.members)) data.members = [];
      if (!data.members.some(m => (m || '').toLowerCase() === name.toLowerCase())) {
        data.members.push(name); await saveData(data);
      }
      if (email) sendEmail(email, 'Welcome to the HB38 Workspace',
        emailShell(`<p>Hi ${esc(name)},</p><p>Your account <strong>${esc(username)}</strong> is ready. You can sign in any time and you'll get an email when a task is assigned to you or a deadline is near.</p>`));

      return sendJSON(res, 200, { token: makeToken(username), name });
    }

    if (url === '/api/data') {
      const uname = authUser(req);
      if (!uname) return sendJSON(res, 401, { error: 'Unauthorized' });
      const users = await loadUsers();
      const u = users.find(x => x.username === uname);
      if (req.method === 'GET') {
        return sendJSON(res, 200, {
          name: u ? u.name : uname,
          email: u ? (u.email || '') : '',
          data: await loadData()
        });
      }
      if (req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (body && body.data && typeof body.data === 'object') {
          const oldData = await loadData();
          await saveData(body.data);
          notifyAssignments(oldData, body.data); // fire-and-forget email on new assignments
        }
        return sendJSON(res, 200, { ok: true });
      }
    }

    /* ---- upload a file (base64 JSON), auth required ---- */
    if (url === '/api/upload' && req.method === 'POST') {
      if (!authUser(req)) return sendJSON(res, 401, { error: 'Unauthorized' });
      let body;
      try { body = JSON.parse((await readBody(req, UPLOAD_MAX_BYTES + 2e6)) || '{}'); }
      catch (e) { return sendJSON(res, 413, { error: 'File is too large (max 25 MB).' }); }
      const name = safeName(body.name);
      const dataUrl = String(body.dataUrl || '');
      const comma = dataUrl.indexOf(',');
      if (comma < 0) return sendJSON(res, 400, { error: 'No file data received.' });
      let buf;
      try { buf = Buffer.from(dataUrl.slice(comma + 1), 'base64'); }
      catch (e) { return sendJSON(res, 400, { error: 'Could not read the file data.' }); }
      if (!buf.length) return sendJSON(res, 400, { error: 'The file is empty.' });
      if (buf.length > UPLOAD_MAX_BYTES) return sendJSON(res, 413, { error: 'File is too large (max 25 MB).' });
      const id = crypto.randomBytes(8).toString('hex');
      await store.putFile(id, name, mimeFor(name), buf.length, buf);
      return sendJSON(res, 200, { id, name, size: buf.length });
    }

    /* ---- download / view an uploaded file. Token comes via ?t= so it works
           in a plain <a href> / <img src> (browsers can't set auth headers there). ---- */
    if (url.indexOf('/api/file/') === 0 && req.method === 'GET') {
      const q = new URLSearchParams((req.url.split('?')[1] || ''));
      if (!verifyToken(q.get('t'))) { res.writeHead(401); return res.end('Unauthorized'); }
      const id = decodeURIComponent(url.slice('/api/file/'.length));
      const f = await store.getFile(id);
      if (!f) { res.writeHead(404); return res.end('File not found'); }
      const disp = q.get('dl') ? 'attachment' : 'inline';
      res.writeHead(200, {
        'Content-Type': f.mime,
        'Content-Disposition': disp + '; filename="' + f.name.replace(/"/g, '') + '"',
        'Cache-Control': 'private, max-age=86400'
      });
      return res.end(f.data);
    }

    // static: serve the dashboard
    if (url === '/' || url === '/index.html' || decodeURIComponent(url) === '/MS WORKSPACE.html') {
      return fs.readFile(HTML_FILE, (e, buf) => {
        if (e) { res.writeHead(404); res.end('Dashboard file not found'); }
        else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(buf); }
      });
    }

    res.writeHead(404); res.end('Not found');
  } catch (err) {
    console.error('request error:', err);
    sendJSON(res, 500, { error: 'Server error' });
  }
});

/* ---- boot ---- */
async function main() {
  await store.init();
  await loadSecret();

  const cmd = process.argv[2];
  if (CLI_COMMANDS.includes(cmd)) {   // one-off admin command, then exit
    await runCLI(cmd);
    process.exit(0);
  }

  await loadUsers();  // seed default accounts on first run
  await loadData();   // seed workspace on first run
  startDigestTimer(); // daily deadline reminder emails

  server.listen(PORT, () => {
    console.log('MS (HB38) Workspace running:  http://localhost:' + PORT + '/');
    console.log('Storage: ' + store.kind + '  |  Email: ' + (BREVO_API_KEY ? 'on (Brevo)' : 'off'));
  });
}
main().catch(err => { console.error('Fatal startup error:', err); process.exit(1); });
