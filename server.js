const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const DATA_FILE = path.join(__dirname, 'schedule.json');
// Scores go to Supabase when it's configured; otherwise to this local file.
const SCORES_FILE = path.join(__dirname, 'scores.json');
function loadLocalScores() {
  try { return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8')); } catch { return []; }
}
const WEEKS = 8;
const TRICKS_PER_WEEK = 5;

// Admin access comes from the Skate IQ Accountability app: when a coach opens S.K.A.T.E. there,
// the app hands over a short-lived pass signed with SKATE_ADMIN_SECRET (the same value is set in both apps).
// There is no separate admin password.
const ADMIN_SECRET = process.env.SKATE_ADMIN_SECRET || '';

function verifyAppPass(pass) {
  if (!ADMIN_SECRET || typeof pass !== 'string') return null;
  const [body, sig] = pass.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', ADMIN_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (claims.role !== 'coach' || typeof claims.exp !== 'number' || claims.exp < Date.now()) return null;
    return claims;
  } catch { return null; }
}

const sessions = new Map();

// Supabase admin client (server-side only)
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;

function nextFridays(count) {
  const dates = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const daysUntilFriday = (5 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilFriday);
  for (let i = 0; i < count; i++) {
    dates.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 7);
  }
  return dates;
}

function defaultSchedule() {
  return nextFridays(WEEKS).map(date => ({
    start: date,
    tricks: Array.from({ length: TRICKS_PER_WEEK }, () => ({ name: '', url: '' }))
  }));
}

function loadSchedule() {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  const s = defaultSchedule();
  fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2));
  return s;
}

function requireAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ── Admin routes ──────────────────────────────────────────────────────────────

app.post('/api/app-login', (req, res) => {
  if (!ADMIN_SECRET) return res.status(503).json({ error: 'Admin is not set up (SKATE_ADMIN_SECRET missing)' });
  const claims = verifyAppPass((req.body || {}).pass);
  if (!claims) return res.status(401).json({ error: 'Open the admin from the Skate IQ Accountability app' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, claims.email || 'coach');
  res.json({ token });
});

// Lets the admin page check a saved session is still valid (sessions reset when the server restarts).
app.get('/api/session', requireAuth, (req, res) => res.json({ ok: true }));

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/schedule', (req, res) => {
  res.json(loadSchedule());
});

app.post('/api/schedule', requireAuth, (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'expected array' });
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// ── Public config (safe to expose) ───────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
});

// ── Leaderboard ───────────────────────────────────────────────────────────────

function currentWeekStart() {
  const schedule = loadSchedule();
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  let current = null;
  for (const entry of schedule) {
    if (new Date(entry.start + 'T00:00:00') <= now) current = entry;
  }
  return current ? current.start : schedule[0]?.start;
}

// Leaderboard shows first name + last initial ("Brock S."), so full names aren't public.
function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

// Best ratio first, then most makes, then whoever got there first.
function rank(entries) {
  return entries.sort((a, b) => {
    const ratioA = a.makes / a.total, ratioB = b.makes / b.total;
    if (ratioB !== ratioA) return ratioB - ratioA;
    if (b.makes !== a.makes) return b.makes - a.makes;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

app.get('/api/leaderboard', async (req, res) => {
  const week = req.query.week || currentWeekStart();
  let entries = [];
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin
      .from('weekly_scores')
      .select('name, makes, total, dots, created_at')
      .eq('week_start', week);
    if (!error) entries = data || [];
  } else {
    entries = loadLocalScores().filter(e => e.week_start === week);
  }
  entries = rank(entries).map(({ name, makes, total, dots }) => ({ name: shortName(name), makes, total, dots }));
  res.json({ entries, count: entries.length, week });
});

// ── Score submission ──────────────────────────────────────────────────────────
// One row per player per week; it updates as they log more tricks.

app.post('/api/weekly-score', async (req, res) => {
  const { client_id, name, makes, total, dots, week_start } = req.body || {};
  if (!client_id || !name || typeof makes !== 'number' || typeof total !== 'number' || !week_start) {
    return res.status(400).json({ error: 'missing fields' });
  }
  const row = { client_id: String(client_id).slice(0, 80), name: String(name).trim().slice(0, 60), week_start,
    makes, total, dots: String(dots || '').slice(0, 40) };

  if (supabaseAdmin) {
    const { error } = await supabaseAdmin
      .from('weekly_scores')
      .upsert(row, { onConflict: 'client_id,week_start' });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  }

  const all = loadLocalScores();
  const existing = all.find(e => e.client_id === row.client_id && e.week_start === row.week_start);
  if (existing) Object.assign(existing, row);
  else all.push({ ...row, created_at: new Date().toISOString() });
  fs.writeFileSync(SCORES_FILE, JSON.stringify(all, null, 2));
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SKATE IQ → http://localhost:${PORT}`);
  console.log(`Admin    → open S.K.A.T.E. in the Skate IQ Accountability app as a coach`);
  if (!ADMIN_SECRET) console.log('Warning: SKATE_ADMIN_SECRET is not set, so the admin is locked.');
});
