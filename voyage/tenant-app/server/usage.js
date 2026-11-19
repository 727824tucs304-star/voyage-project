import { pool } from './db.js';

// Counts API requests per day in this client's own database. Platform health checks are not counted.
export function countApiRequest(req, res, next) {
  if (req.originalUrl.startsWith('/api/') && !req.originalUrl.startsWith('/api/health')) {
    pool.query(
      `INSERT INTO usage_daily (day, api_requests) VALUES (CURRENT_DATE, 1)
       ON CONFLICT (day) DO UPDATE SET api_requests = usage_daily.api_requests + 1`
    ).catch(() => {});
  }
  next();
}
