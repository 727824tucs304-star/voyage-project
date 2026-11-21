import { pool } from './db.js';
import { recordingPath } from './storage.js';
import { transcribe, transcriptionConfigured } from './transcription.js';

// Background worker. Jobs are claimed one at a time with SKIP LOCKED, so no job runs twice.
const POLL_MS = 5000;
const MAX_ATTEMPTS = 3;

export async function resetInterruptedJobs() {
  await pool.query("UPDATE processing_jobs SET state = 'queued', updated_at = now() WHERE state IN ('transcribing','analysing')");
  await pool.query("UPDATE meetings SET status = 'queued' WHERE status IN ('transcribing','analysing')");
}

async function claimJob() {
  const { rows } = await pool.query(
    `UPDATE processing_jobs SET state = 'transcribing', attempts = attempts + 1, updated_at = now()
     WHERE id = (SELECT id FROM processing_jobs WHERE state = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, meeting_id, attempts`);
  return rows[0] || null;
}

async function fail(job, message, retry) {
  await pool.query('UPDATE processing_jobs SET state = $2, last_error = $3, updated_at = now() WHERE id = $1',
    [job.id, retry ? 'queued' : 'failed', String(message).slice(0, 500)]);
  await pool.query('UPDATE meetings SET status = $2 WHERE id = $1', [job.meeting_id, retry ? 'queued' : 'failed']);
}

async function saveTranscript(job, rec, result) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM transcript_segments WHERE meeting_id = $1', [job.meeting_id]);
    for (const [i, s] of result.segments.entries()) {
      await client.query(
        'INSERT INTO transcript_segments (meeting_id, seq, speaker, start_sec, end_sec, text) VALUES ($1, $2, $3, $4, $5, $6)',
        [job.meeting_id, i + 1, s.speaker, s.start, s.end, s.text]);
    }
    await client.query('UPDATE recordings SET duration_seconds = $2 WHERE id = $1', [rec.id, result.durationSeconds]);
    await client.query("UPDATE processing_jobs SET state = 'completed', last_error = NULL, updated_at = now() WHERE id = $1", [job.id]);
    await client.query("UPDATE meetings SET status = 'transcribed' WHERE id = $1", [job.meeting_id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function runJob(job) {
  const { rows: [rec] } = await pool.query(
    'SELECT * FROM recordings WHERE meeting_id = $1 ORDER BY id DESC LIMIT 1', [job.meeting_id]);
  if (!rec) return fail(job, 'No recording is attached to this meeting.', false);
  if (!transcriptionConfigured()) {
    // Not configured: the job waits. Nothing is marked as processed.
    await pool.query(
      "UPDATE processing_jobs SET state = 'queued', attempts = attempts - 1, last_error = $2, updated_at = now() WHERE id = $1",
      [job.id, 'Transcription is not configured yet. Set AWS_REGION and TRANSCRIBE_BUCKET.']);
    return;
  }
  await pool.query("UPDATE meetings SET status = 'transcribing' WHERE id = $1", [job.meeting_id]);
  try {
    const result = await transcribe({
      slug: process.env.TENANT_SLUG || 'tenant', meetingId: job.meeting_id, recording: rec,
      localPath: recordingPath(rec.storage_key),
    });
    await saveTranscript(job, rec, result);
  } catch (err) {
    console.error('transcription failed:', err.message);
    await fail(job, err.message, job.attempts < MAX_ATTEMPTS);
  }
}

export async function startWorker() {
  await resetInterruptedJobs();
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const job = await claimJob();
      if (job) await runJob(job);
    } catch (err) {
      console.error('worker error:', err.message);
    } finally {
      busy = false;
    }
  }, POLL_MS);
}
