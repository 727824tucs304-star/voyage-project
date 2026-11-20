import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './validate.js';

// Accepted formats: extension -> MIME types that must match it.
export const ALLOWED = {
  mp3: ['audio/mpeg'],
  wav: ['audio/wav', 'audio/x-wav', 'audio/wave'],
  m4a: ['audio/mp4', 'audio/x-m4a'],
  mp4: ['video/mp4'],
  webm: ['video/webm', 'audio/webm'],
};
export const MAX_BYTES = Number(process.env.MAX_RECORDING_MB || 500) * 1024 * 1024;
const ROOT = process.env.STORAGE_DIR || '/data/recordings';

export function checkRecordingHeaders(filename, mime, length) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (!ALLOWED[ext]) throw new HttpError(415, 'Unsupported file type. Use MP3, WAV, M4A, MP4 or WebM.');
  const type = String(mime || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED[ext].includes(type)) throw new HttpError(415, 'The file content type does not match its extension.');
  if (!(length > 0)) throw new HttpError(411, 'Content-Length is required.');
  if (length > MAX_BYTES) throw new HttpError(413, `Recordings must be ${Math.round(MAX_BYTES / 1048576)} MB or smaller.`);
  return ext;
}

// Writes the upload under a random name inside the meeting's folder. Clients never choose a path.
export function saveStream(req, meetingId, ext, length) {
  return new Promise((resolve, reject) => {
    const dir = path.join(ROOT, String(meetingId));
    fs.mkdirSync(dir, { recursive: true });
    const name = `${crypto.randomUUID()}.${ext}`;
    const full = path.join(dir, name);
    const out = fs.createWriteStream(full);
    let received = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rmSync(full, { force: true });
      reject(err);
    };
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > length || received > MAX_BYTES) fail(new HttpError(413, 'Upload is larger than declared.'));
    });
    req.on('aborted', () => fail(new HttpError(400, 'Upload was interrupted.')));
    out.on('error', (err) => fail(err));
    out.on('finish', () => {
      if (!failed) resolve({ storage_key: path.join(String(meetingId), name), bytes: received });
    });
    req.pipe(out);
  });
}

// Resolves a stored key and refuses anything that would leave the storage root.
export function recordingPath(key) {
  const root = path.resolve(ROOT);
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new HttpError(400, 'Invalid storage location.');
  return full;
}

export function removeMeetingFiles(meetingId) {
  fs.rmSync(path.join(ROOT, String(meetingId)), { recursive: true, force: true });
}
