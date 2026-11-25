// Limits failed customer sign-ins per account: 5 failures within 15 minutes.
// Keyed by email rather than network address, so one user's mistakes cannot lock out
// other people who share the same proxy address.
export const SIGNIN_WINDOW_MS = 15 * 60 * 1000;
export const SIGNIN_MAX_FAILURES = 5;

const failures = new Map();

export function signInBlocked(email, now = Date.now()) {
  const entry = failures.get(email);
  if (!entry) return false;
  if (now > entry.reset) {
    failures.delete(email);
    return false;
  }
  return entry.count >= SIGNIN_MAX_FAILURES;
}

export function recordFailedSignIn(email, now = Date.now()) {
  const entry = failures.get(email);
  if (!entry || now > entry.reset) {
    failures.set(email, { count: 1, reset: now + SIGNIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
  if (failures.size > 10000) failures.clear();
}

export function clearFailedSignIns(email) {
  failures.delete(email);
}
