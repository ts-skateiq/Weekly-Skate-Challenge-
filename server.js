const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const DATA_FILE = path.join(__dirname, 'schedule.json');
const WEEKS = 8;
const TRICKS_PER_WEEK = 5;

const USERS = {
  'mitchie@skateiq.com': 'Janwun69',
  'tyler@skateiq.com':   'Janwun69',
};

const sessions = new Map();

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

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const key = (email || '').toLowerCase();
  if (!USERS[key] || USERS[key] !== password) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, key);
  res.json({ token });
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SKATE IQ → http://localhost:${PORT}`);
  console.log(`Admin    → http://localhost:${PORT}/admin.html`);
});
