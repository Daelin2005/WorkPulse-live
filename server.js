require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./lib/db');
const { HttpError, wrap } = require('./lib/util');
const { loadUser, requireAuth } = require('./lib/auth');
const dbReady = require('./scripts/migrate')();

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is missing. Copy .env.example to .env and fill it in.'); process.exit(1); }

const app = express();
const ORIGIN = process.env.APP_ORIGIN || '';
if (process.env.NODE_ENV === 'production' && !ORIGIN) console.warn('APP_ORIGIN is not set. Emailed invitation and reset links need your site address, for example https://app.yourcompany.com');
app.set('trust proxy', 1);                       // behind a proxy or load balancer, so req.ip and secure cookies work
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false })); // the pages ship their own inline scripts; tighten this when they move to files
app.use(express.json({ limit: '3mb' }));          // room for a profile photo or logo sent as a data URL
app.use(cookieParser());
app.use((req, res, next) => dbReady.then(() => next(), next));

// CORS for when the pages are served from a different port (for example Vite on 5173). Cookies need credentials.
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && origin === ORIGIN) {
    res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', Vary: 'Origin' });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// CSRF: cookie logins are only accepted for changes that come from our own pages.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  const sameHost = origin && (() => { try { return new URL(origin).host === req.get('host'); } catch (_) { return false; } })();
  if (origin ? (origin === ORIGIN || sameHost) : req.get('x-requested-with') === 'workpulse') return next();
  next(new HttpError(403, 'This request did not come from the WorkPulse app.', 'BAD_ORIGIN'));
});

app.use('/api', rateLimit({ windowMs: 60e3, limit: 600, standardHeaders: true, legacyHeaders: false }));
app.use(loadUser);

app.get('/api/health', wrap(async (req, res) => {
  await db.query('SELECT 1');
  res.json({ ok: true });
}));

// Public (no sign-in needed)
app.use('/api/auth', require('./routes/auth'));

// Everything below needs a signed-in person
app.use('/api', requireAuth);
app.use('/api/bootstrap', require('./routes/bootstrap'));
app.use('/api', require('./routes/org'));        // company, departments, employees, me, notifications
app.use('/api/chat', require('./routes/chat'));
app.use('/api', require('./routes/policy'));     // leave types, SLA targets, ticket rules, announcements, audit, reports
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/leave', require('./routes/leave'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api', require('./routes/assets'));     // asset types, locations, assets, incidents

app.use('/api', (req, res, next) => next(new HttpError(404, 'That endpoint does not exist.', 'NOT_FOUND')));

// Serves the HTML pages from ./public so the pages and the API share one origin (no CORS needed).
app.get('/', (req, res) => res.redirect('/Login.html'));
app.use(express.static(path.join(__dirname, 'public')));

// One place that turns errors into answers. Database details never reach the browser.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  const pg = { '23505': [409, 'That already exists.', 'DUPLICATE'], '23503': [400, 'That refers to something that does not exist.', 'BAD_REFERENCE'],
               '23514': [400, 'Those values are not allowed.', 'BAD_VALUE'], '22P02': [400, 'One of the values is not in the right format.', 'BAD_FORMAT'] }[err.code];
  if (pg) return res.status(pg[0]).json({ error: pg[1], code: pg[2] });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.', code: 'TOO_LARGE' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.', code: 'BAD_JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side.', code: 'SERVER_ERROR' });
});

const port = Number(process.env.PORT || 3000);
if (require.main === module) dbReady.then(() => {
  app.listen(port, () => console.log(`WorkPulse API listening on http://127.0.0.1:${port}`));
}).catch(error => {
  console.error('Could not apply database migrations.', error);
  process.exitCode = 1;
});
module.exports = app;
