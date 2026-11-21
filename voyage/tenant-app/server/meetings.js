import { Router } from 'express';
import fs from 'node:fs';
import { pool } from './db.js';
import { HttpError, text, date, oneOf } from './validate.js';
import { checkRecordingHeaders, saveStream, recordingPath, removeMeetingFiles } from './storage.js';
import { providerStatus } from './providers.js';

export const CATEGORIES = ['legal_intake', 'internal_case', 'client_call', 'board', 'other'];
export const STATUSES = ['draft', 'uploaded', 'queued', 'transcribing', 'analysing', 'completed', 'failed'];
const ACTIVE = "('queued','transcribing','analysing')";

export const meetingsRouter = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const who = (req) => req.user?.name || req.user?.email || 'member';
const idOf = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Meeting not found');
  return id;
};
async function requireMeeting(id) {
  const { rowCount } = await pool.query('SELECT 1 FROM meetings WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'Meeting not found');
}

function participants(v) {
  if (v === undefined || v === null || v === '') return [];
  const list = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
  if (list.length > 50 || list.some((x) => x.length > 80)) throw new HttpError(400, 'Up to 50 participants, 80 characters each.');
  return list;
}
function meetingInput(b) {
  return {
    title: text(b, 'title', { max: 160, required: true }),
    description: text(b, 'description', { max: 2000 }),
    category: oneOf(b, 'category', CATEGORIES, 'other'),
    meeting_date: date(b, 'meeting_date', { required: true }),
    participants: participants(b?.participants),
  };
}
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

// Stats are computed from the database. Duration is only known after transcription, so it is 0 until then.
meetingsRouter.get('/meetings/stats', wrap(async (req, res) => {
  const { rows: [t] } = await pool.query(
    "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'completed')::int AS processed FROM meetings");
  const { rows: [d] } = await pool.query('SELECT COALESCE(SUM(duration_seconds), 0)::float8 AS seconds FROM recordings');
  const { rows: [p] } = await pool.query(`SELECT COUNT(*)::int AS pending FROM processing_jobs WHERE state IN ${ACTIVE}`);
  const { rows: recent } = await pool.query('SELECT id, title, meeting_date, status FROM meetings ORDER BY created_at DESC LIMIT 5');
  res.json({ total_meetings: t.total, processed: t.processed, duration_seconds: d.seconds, pending_jobs: p.pending, recent });
}));

meetingsRouter.get('/processing/status', (req, res) => res.json(providerStatus()));

meetingsRouter.get('/meetings', wrap(async (req, res) => {
  const where = [];
  const params = [];
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
    where.push(`(m.title ILIKE $${params.length} OR m.description ILIKE $${params.length} OR m.participants::text ILIKE $${params.length})`);
  }
  const category = String(req.query.category || '');
  if (category) {
    if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Unknown category.');
    params.push(category);
    where.push(`m.category = $${params.length}`);
  }
  const status = String(req.query.status || '');
  if (status) {
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status.');
    params.push(status);
    where.push(`m.status = $${params.length}`);
  }
  for (const [key, op] of [['from', '>='], ['to', '<=']]) {
    const v = String(req.query[key] || '');
    if (!v) continue;
    if (!isDate(v)) throw new HttpError(400, `${key} must be a date (YYYY-MM-DD).`);
    params.push(v);
    where.push(`m.meeting_date ${op} $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT m.*, (SELECT COUNT(*) FROM recordings r WHERE r.meeting_id = m.id)::int AS recording_count
     FROM meetings m ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY m.meeting_date DESC, m.id DESC LIMIT 200`,
    params
  );
  res.json(rows);
}));

meetingsRouter.post('/meetings', wrap(async (req, res) => {
  const i = meetingInput(req.body);
  const { rows } = await pool.query(
    `INSERT INTO meetings (title, description, category, meeting_date, participants, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING *`,
    [i.title, i.description, i.category, i.meeting_date, JSON.stringify(i.participants), who(req)]
  );
  res.status(201).json(rows[0]);
}));

meetingsRouter.get('/meetings/:id', wrap(async (req, res) => {
  const id = idOf(req);
  const { rows } = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Meeting not found');
  const recordings = await pool.query(
    'SELECT id, original_name, content_type, bytes, duration_seconds, created_at FROM recordings WHERE meeting_id = $1 ORDER BY id', [id]);
  const job = await pool.query(
    'SELECT stage, state, attempts, last_error, updated_at FROM processing_jobs WHERE meeting_id = $1 ORDER BY id DESC LIMIT 1', [id]);
  const transcript = await pool.query(
    'SELECT seq, speaker, start_sec, end_sec, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY seq', [id]);
  const analysis = await pool.query('SELECT * FROM meeting_analysis WHERE meeting_id = $1', [id]);
  const actions = await pool.query(
    'SELECT id, description, owner, due_text, status, origin, source_seq, source_start FROM action_items WHERE meeting_id = $1 ORDER BY id', [id]);
  res.json({ ...rows[0], recordings: recordings.rows, job: job.rows[0] || null, transcript: transcript.rows,
    analysis: analysis.rows[0] || null, action_items: actions.rows });
}));

meetingsRouter.put('/meetings/:id', wrap(async (req, res) => {
  const id = idOf(req);
  await requireMeeting(id);
  const i = meetingInput(req.body);
  const { rows } = await pool.query(
    `UPDATE meetings SET title = $2, description = $3, category = $4, meeting_date = $5, participants = $6::jsonb
     WHERE id = $1 RETURNING *`,
    [id, i.title, i.description, i.category, i.meeting_date, JSON.stringify(i.participants)]
  );
  res.json(rows[0]);
}));

meetingsRouter.delete('/meetings/:id', wrap(async (req, res) => {
  const id = idOf(req);
  await requireMeeting(id);
  await pool.query('DELETE FROM meetings WHERE id = $1', [id]);
  removeMeetingFiles(id);
  res.status(204).end();
}));

meetingsRouter.post('/meetings/:id/retry', wrap(async (req, res) => {
  const id = idOf(req);
  await requireMeeting(id);
  const { rowCount } = await pool.query(
    "UPDATE processing_jobs SET state = 'queued', attempts = 0, last_error = NULL, updated_at = now() WHERE meeting_id = $1 AND state = 'failed'", [id]);
  if (!rowCount) throw new HttpError(409, 'Only failed processing can be retried.');
  await pool.query("UPDATE meetings SET status = 'queued' WHERE id = $1", [id]);
  res.status(202).json({ id, status: 'queued' });
}));

// Raw upload. Requires explicit consent, validates type and size before reading the body, and never runs
// a second upload while a processing job is still active for the same meeting.
meetingsRouter.post('/meetings/:id/recording', async (req, res, next) => {
  try {
    const id = idOf(req);
    await requireMeeting(id);
    if (req.headers['x-consent'] !== 'confirmed') {
      throw new HttpError(400, 'Consent to the recording must be confirmed before uploading.');
    }
    const { rowCount: active } = await pool.query(`SELECT 1 FROM processing_jobs WHERE meeting_id = $1 AND state IN ${ACTIVE}`, [id]);
    if (active) throw new HttpError(409, 'A processing job is already active for this meeting.');
    const filename = decodeURIComponent(String(req.headers['x-file-name'] || 'recording'));
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    const length = Number(req.headers['content-length'] || 0);
    const ext = checkRecordingHeaders(filename, mime, length);
    const saved = await saveStream(req, id, ext, length);
    const { rows } = await pool.query(
      `INSERT INTO recordings (meeting_id, original_name, content_type, storage_key, bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [id, filename.slice(0, 200), mime, saved.storage_key, saved.bytes, who(req)]
    );
    await pool.query("INSERT INTO processing_jobs (meeting_id, state) VALUES ($1, 'queued')", [id]);
    await pool.query("UPDATE meetings SET status = 'queued' WHERE id = $1", [id]);
    res.status(201).json({ id: rows[0].id, bytes: saved.bytes, status: 'queued' });
  } catch (err) {
    next(err);
  }
});

meetingsRouter.get('/meetings/:id/recordings/:rid', wrap(async (req, res) => {
  const id = idOf(req);
  const rid = Number(req.params.rid);
  const { rows } = await pool.query('SELECT * FROM recordings WHERE id = $1 AND meeting_id = $2', [rid, id]);
  if (!rows[0]) throw new HttpError(404, 'Recording not found');
  const full = recordingPath(rows[0].storage_key);
  if (!fs.existsSync(full)) throw new HttpError(404, 'The recording file is missing from storage.');
  res.setHeader('Content-Type', rows[0].content_type);
  res.setHeader('Content-Length', String(fs.statSync(full).size));
  res.setHeader('Content-Disposition', `attachment; filename="${rows[0].original_name.replace(/["\\]/g, '')}"`);
  fs.createReadStream(full).pipe(res);
}));
