import { Router } from 'express';
import { db } from './db.js';
import { HttpError } from './errors.js';
import { SLUG_RE } from './security.js';
import { audit } from './audit.js';
import { prescriptionFor } from './prescriptions.js';

export const prescriptionRouter = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const currentMonth = () => new Date().toISOString().slice(0, 7);

prescriptionRouter.get('/prescriptions', wrap(async (req, res) => {
  const month = String(req.query.month || currentMonth());
  const slug = req.query.slug ? String(req.query.slug) : '';
  if (slug && !SLUG_RE.test(slug)) throw new HttpError(404, 'Customer not found');
  res.json(await prescriptionFor(slug || null, month));
}));

prescriptionRouter.put('/tenants/:slug/budget', wrap(async (req, res) => {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) throw new HttpError(404, 'Customer not found');
  const raw = req.body?.monthly_budget;
  let budget = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    budget = Number(raw);
    if (!Number.isFinite(budget) || budget < 0 || budget > 1000000) {
      throw new HttpError(400, 'monthly_budget must be between 0 and 1000000');
    }
  }
  const { rowCount } = await db.query('UPDATE tenants SET monthly_budget = $2 WHERE slug = $1', [slug, budget]);
  if (!rowCount) throw new HttpError(404, 'Customer not found');
  audit('budget.set', { slug, monthly_budget: budget });
  res.json({ slug, monthly_budget: budget });
}));
