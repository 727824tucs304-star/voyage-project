import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Transcription adapter. 'aws' uses AWS Transcribe through the AWS CLI and the instance role.
// 'mock' exists only for automated tests and is labelled as such everywhere it appears.
const CLI = process.env.AWS_CLI_BIN || 'aws';
const provider = () => process.env.TRANSCRIPTION_PROVIDER || 'aws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MEDIA_FORMATS = ['mp3', 'mp4', 'wav', 'flac', 'ogg', 'amr', 'webm', 'm4a'];

export function transcriptionConfigured() {
  if (provider() === 'mock') return true;
  return Boolean(process.env.AWS_REGION && process.env.TRANSCRIBE_BUCKET);
}

function aws(args) {
  return new Promise((resolve, reject) => {
    execFile(CLI, args, { timeout: 600000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 400)));
      else resolve(stdout);
    });
  });
}

// Converts Transcribe's word list into speaker turns with real start and end times.
export function parseTranscript(doc) {
  const items = doc.results?.items || [];
  const speakerAt = new Map();
  for (const seg of doc.results?.speaker_labels?.segments || []) {
    for (const it of seg.items || []) speakerAt.set(it.start_time, seg.speaker_label);
  }
  const segments = [];
  let cur = null;
  for (const it of items) {
    const word = it.alternatives?.[0]?.content || '';
    if (it.type === 'punctuation') {
      if (cur) cur.text += word;
      continue;
    }
    const speaker = speakerAt.get(it.start_time) ?? null;
    const start = Number(it.start_time);
    const end = Number(it.end_time);
    if (!cur || cur.speaker !== speaker) {
      if (cur) segments.push(cur);
      cur = { speaker, start, end, text: word };
    } else {
      cur.end = end;
      cur.text += ` ${word}`;
    }
  }
  if (cur) segments.push(cur);
  const durationSeconds = items.reduce((m, i) => Math.max(m, Number(i.end_time) || 0), 0);
  return { durationSeconds, segments };
}

function mockTranscript() {
  return {
    durationSeconds: 7,
    segments: [
      { speaker: 'spk_0', start: 0, end: 3.5, text: 'Test transcript line one from the automated mock provider.' },
      { speaker: 'spk_1', start: 4, end: 7, text: 'Test transcript line two from the automated mock provider.' },
    ],
  };
}

export async function transcribe({ slug, meetingId, recording, localPath }) {
  if (provider() === 'mock') {
    await sleep(Number(process.env.TRANSCRIPTION_MOCK_DELAY_MS || 0));
    return mockTranscript();
  }
  const region = process.env.AWS_REGION;
  const bucket = process.env.TRANSCRIBE_BUCKET;
  const ext = path.extname(recording.original_name).slice(1).toLowerCase();
  if (!MEDIA_FORMATS.includes(ext)) throw new Error(`AWS Transcribe does not accept .${ext} files.`);
  const jobName = `${slug}-m${meetingId}-r${recording.id}-${Date.now()}`.replace(/[^0-9a-zA-Z._-]/g, '-').slice(0, 200);
  const mediaKey = `${slug}/media/${jobName}.${ext}`;
  const outKey = `${slug}/transcripts/${jobName}.json`;

  await aws(['s3', 'cp', localPath, `s3://${bucket}/${mediaKey}`, '--region', region]);
  await aws([
    'transcribe', 'start-transcription-job',
    '--transcription-job-name', jobName,
    '--language-code', process.env.TRANSCRIBE_LANGUAGE || 'en-US',
    '--media-format', ext,
    '--media', `MediaFileUri=s3://${bucket}/${mediaKey}`,
    '--output-bucket-name', bucket,
    '--output-key', outKey,
    '--settings', 'ShowSpeakerLabels=true,MaxSpeakerLabels=10',
    '--region', region,
  ]);
  for (;;) {
    const job = JSON.parse(await aws(['transcribe', 'get-transcription-job', '--transcription-job-name', jobName, '--region', region])).TranscriptionJob;
    if (job.TranscriptionJobStatus === 'COMPLETED') break;
    if (job.TranscriptionJobStatus === 'FAILED') throw new Error(`AWS Transcribe failed: ${job.FailureReason || 'no reason given'}`);
    await sleep(10000);
  }
  const tmp = path.join(os.tmpdir(), `${jobName}.json`);
  await aws(['s3', 'cp', `s3://${bucket}/${outKey}`, tmp, '--region', region]);
  const doc = JSON.parse(await fs.readFile(tmp, 'utf8'));
  await fs.rm(tmp, { force: true });
  // Delete the media copy from S3 after use. The original recording stays on the client's private volume.
  await aws(['s3', 'rm', `s3://${bucket}/${mediaKey}`, '--region', region]).catch(() => {});
  return parseTranscript(doc);
}
