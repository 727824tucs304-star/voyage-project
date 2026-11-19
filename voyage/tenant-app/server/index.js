import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase } from './db.js';
import { api } from './routes.js';
import { HttpError } from './validate.js';
import { countApiRequest } from './usage.js';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(countApiRequest);
app.use('/api', api);

const dist = path.join(here, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h' }));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err.code === '23503') return res.status(422).json({ error: 'Referenced record does not exist' });
  if (err.code === '23505') return res.status(409).json({ error: 'Duplicate record' });
  if (err.code === '23514') return res.status(422).json({ error: 'Value violates a data rule' });
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

async function start(attempt = 1) {
  try {
    await initDatabase();
  } catch (err) {
    if (attempt >= 30) {
      console.error('Database unavailable, exiting', err);
      process.exit(1);
    }
    console.warn(`Database not ready (attempt ${attempt}), retrying`);
    await new Promise((r) => setTimeout(r, 2000));
    return start(attempt + 1);
  }
  app.listen(port, host, () => {
    console.log(`Voyage tenant ${process.env.APP_VERSION || ''} listening on ${host}:${port}`);
  });
}

start();
