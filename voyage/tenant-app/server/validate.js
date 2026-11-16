export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);

export function text(body, key, { max = 200, required = false } = {}) {
  const v = body?.[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${key} is required`);
    return null;
  }
  if (typeof v !== 'string') throw bad(`${key} must be text`);
  const t = v.trim();
  if (!t) {
    if (required) throw bad(`${key} is required`);
    return null;
  }
  if (t.length > max) throw bad(`${key} must be at most ${max} characters`);
  return t;
}

export function number(body, key, { min = 0, max = 1e9, required = false } = {}) {
  const v = body?.[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${key} is required`);
    return null;
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${key} must be between ${min} and ${max}`);
  return n;
}

export function integer(body, key) {
  const v = body?.[key];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`${key} must be a positive integer`);
  return n;
}

export function date(body, key, { required = false } = {}) {
  const v = text(body, key, { max: 10, required });
  if (v === null) return null;
  const d = new Date(`${v}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw bad(`${key} must be a valid date (YYYY-MM-DD)`);
  }
  return v;
}

export function time(body, key) {
  const v = text(body, key, { max: 5 });
  if (v === null) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad(`${key} must be HH:MM`);
  return v;
}

export function oneOf(body, key, allowed, fallback = null) {
  const v = body?.[key];
  if (v === undefined || v === null || v === '') return fallback;
  if (!allowed.includes(v)) throw bad(`${key} must be one of: ${allowed.join(', ')}`);
  return v;
}
