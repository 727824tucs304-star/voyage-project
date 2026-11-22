import { Router } from 'express';
import fs from 'node:fs';
import { pool } from './db.js';
import { HttpError, text, date, oneOf } from './validate.js';
import { checkRecordingHeaders, saveStream, recordingPath, removeMeetingFiles } from './storage.js';
import { providerStatus } from './providers.js';
import { buildReport } from './report.js';

export const CATEGORIES = ['legal_intake', 'internal_case', 'client_call', 'board', 'other'];
export const STATUSES = ['draft', 'uploaded', 'queued', 'transcribing', 'analysing', 'completed', 'failed'];
export const SECTOR_KEYS = ['legal', 'sales', 'healthcare', 'financial', 'hr', 'general'];
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
const clockOf = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
// Protects against spreadsheet formula injection when a CSV is opened in Excel.
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

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
    sector: oneOf(b, 'sector', SECTOR_KEYS, null),
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

// Search across everything said in the transcripts, plus task descriptions and owners.
meetingsRouter.get('/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) throw new HttpError(400, 'Enter at least 2 characters.');
  const pattern = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const { rows: transcript } = await pool.query(
    `SELECT m.id AS meeting_id, m.title, m.meeting_date, t.seq, t.start_sec, t.text
     FROM transcript_segments t JOIN meetings m ON m.id = t.meeting_id
     WHERE t.text ILIKE $1 ORDER BY m.meeting_date DESC, t.seq LIMIT 50`, [pattern]);
  const { rows: tasks } = await pool.query(
    `SELECT a.meeting_id, a.id, a.description, a.owner, a.status, m.title, m.meeting_date
     FROM action_items a JOIN meetings m ON m.id = a.meeting_id
     WHERE a.description ILIKE $1 OR a.owner ILIKE $1 ORDER BY m.meeting_date DESC, a.id LIMIT 50`, [pattern]);
  res.json({ transcript, tasks });
}));

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
    `INSERT INTO meetings (title, description, category, meeting_date, participants, created_by, sector)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *`,
    [i.title, i.description, i.category, i.meeting_date, JSON.stringify(i.participants), who(req), i.sector]
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
    `UPDATE meetings SET title = $2, description = $3, category = $4, meeting_date = $5, participants = $6::jsonb, sector = $7
     WHERE id = $1 RETURNING *`,
    [id, i.title, i.description, i.category, i.meeting_date, JSON.stringify(i.participants), i.sector]
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

// Tasks. AI-suggested tasks can be edited or marked done; re-running the analysis replaces only AI tasks.
const taskText = (b, key, max) => text(b, key, { max });
meetingsRouter.post('/meetings/:id/actions', wrap(async (req, res) => {
  const id = idOf(req);
  await requireMeeting(id);
  const description = text(req.body, 'description', { max: 500, required: true });
  const owner = taskText(req.body, 'owner', 120);
  const due = taskText(req.body, 'due', 120);
  const { rows } = await pool.query(
    `INSERT INTO action_items (meeting_id, description, owner, due_text, origin)
     VALUES ($1, $2, $3, $4, 'manual')
     RETURNING id, description, owner, due_text, status, origin, source_seq, source_start`,
    [id, description, owner, due]);
  res.status(201).json(rows[0]);
}));

meetingsRouter.patch('/meetings/:id/actions/:aid', wrap(async (req, res) => {
  const id = idOf(req);
  const aid = Number(req.params.aid);
  if (!Number.isInteger(aid) || aid <= 0) throw new HttpError(404, 'Task not found');
  const b = req.body || {};
  const status = b.status === undefined ? null : oneOf(b, 'status', ['open', 'done']);
  const ownerSet = b.owner !== undefined;
  const dueSet = b.due !== undefined;
  const owner = ownerSet ? taskText(b, 'owner', 120) : null;
  const due = dueSet ? taskText(b, 'due', 120) : null;
  const { rows } = await pool.query(
    `UPDATE action_items SET
       status = COALESCE($3, status),
       owner = CASE WHEN $4::boolean THEN $5 ELSE owner END,
       due_text = CASE WHEN $6::boolean THEN $7 ELSE due_text END
     WHERE id = $1 AND meeting_id = $2
     RETURNING id, description, owner, due_text, status, origin, source_seq, source_start`,
    [aid, id, status, ownerSet, owner, dueSet, due]);
  if (!rows[0]) throw new HttpError(404, 'Task not found');
  res.json(rows[0]);
}));

meetingsRouter.delete('/meetings/:id/actions/:aid', wrap(async (req, res) => {
  const id = idOf(req);
  const aid = Number(req.params.aid);
  const { rowCount } = await pool.query(
    "DELETE FROM action_items WHERE id = $1 AND meeting_id = $2 AND origin = 'manual'", [aid, id]);
  if (!rowCount) throw new HttpError(409, 'Only tasks added manually can be deleted. Mark AI-suggested tasks as done instead.');
  res.status(204).end();
}));

meetingsRouter.get('/meetings/:id/export.csv', wrap(async (req, res) => {
  const id = idOf(req);
  await requireMeeting(id);
  const { rows } = await pool.query(
    'SELECT description, owner, due_text, status, origin, source_start FROM action_items WHERE meeting_id = $1 ORDER BY id', [id]);
  const lines = [['task', 'owner', 'deadline', 'status', 'origin', 'timestamp'].map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([r.description, r.owner, r.due_text, r.status, r.origin,
      r.source_start == null ? '' : clockOf(Number(r.source_start))].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="vespera-tasks-${id}.csv"`);
  res.send(`\uFEFF${lines.join('\r\n')}`);
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

// Removes a wrong or unwanted recording. Its transcript, summary and AI-suggested tasks are cleared,
// because they came from that file. Tasks you added yourself are kept.
meetingsRouter.delete('/meetings/:id/recordings/:rid', wrap(async (req, res) => {
  const id = idOf(req);
  const rid = Number(req.params.rid);
  await requireMeeting(id);
  const { rowCount: active } = await pool.query(`SELECT 1 FROM processing_jobs WHERE meeting_id = $1 AND state IN ${ACTIVE}`, [id]);
  if (active) throw new HttpError(409, 'Wait for the current processing to finish before removing a recording.');
  const { rows: [rec] } = await pool.query('SELECT storage_key FROM recordings WHERE id = $1 AND meeting_id = $2', [rid, id]);
  if (!rec) throw new HttpError(404, 'Recording not found');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM recordings WHERE id = $1', [rid]);
    await client.query('DELETE FROM transcript_segments WHERE meeting_id = $1', [id]);
    await client.query('DELETE FROM meeting_analysis WHERE meeting_id = $1', [id]);
    await client.query("DELETE FROM action_items WHERE meeting_id = $1 AND origin = 'ai'", [id]);
    await client.query('DELETE FROM processing_jobs WHERE meeting_id = $1', [id]);
    const { rows: [left] } = await client.query('SELECT COUNT(*)::int AS n FROM recordings WHERE meeting_id = $1', [id]);
    if (left.n > 0) await client.query("INSERT INTO processing_jobs (meeting_id, state) VALUES ($1, 'queued')", [id]);
    await client.query('UPDATE meetings SET status = $2 WHERE id = $1', [id, left.n > 0 ? 'queued' : 'draft']);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  try { fs.rmSync(recordingPath(rec.storage_key), { force: true }); } catch { /* file already gone */ }
  res.status(204).end();
}));

// Printable report. The browser's Print dialog saves it as PDF; the Word download is the same report.
meetingsRouter.get('/meetings/:id/report.html', wrap(async (req, res) => {
  const html = await buildReport(idOf(req));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}));
meetingsRouter.get('/meetings/:id/report.doc', wrap(async (req, res) => {
  const id = idOf(req);
  const html = await buildReport(id);
  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', `attachment; filename="vespera-report-${id}.doc"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}));

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
