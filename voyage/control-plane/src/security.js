import crypto from 'node:crypto';
import { config } from './config.js';

export const SLUG_RE = /^[a-z][a-z0-9]{2,30}$/;
export const VERSION_RE = /^v[1-9][0-9]{0,2}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const derive = (label) => crypto.createHmac('sha256', config.controlSecret).update(label).digest('hex');

// Per-tenant credentials are derived from CONTROL_SECRET, so they never need to be stored and
// are identical when a container is recreated. Rotating CONTROL_SECRET requires re-provisioning.
export function tenantSecrets(slug) {
  return { dbPassword: derive(`db:${slug}`), jwtSecret: derive(`jwt:${slug}`) };
}

export function baseSlug(company) {
  let s = company.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
  if (!s) s = 'ws';
  if (!/^[a-z]/.test(s)) s = `w${s}`;
  while (s.length < 3) s += 'w';
  return s;
}

export const randomSuffix = () => crypto.randomBytes(2).toString('hex');

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
