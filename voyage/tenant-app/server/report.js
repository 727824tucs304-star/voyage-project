import { pool } from './db.js';
import { HttpError } from './validate.js';

// Every value from the database is escaped before it reaches the page.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clock = (s) => {
  if (s == null || s === '') return '';
  const t = Math.floor(Number(s));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const stamp = (sec) => (sec == null ? '' : ` <span class="ts">[${clock(sec)}]</span>`);
const dateText = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));
const SECTOR_LABELS = { legal: 'Legal', sales: 'B2B sales', healthcare: 'Healthcare', financial: 'Financial advisory', hr: 'Recruitment and HR', general: 'General' };
const CATEGORY_LABELS = { legal_intake: 'Legal client intake', internal_case: 'Internal case discussion', client_call: 'Client call', board: 'Board or leadership', other: 'Other', healthcare: 'Healthcare', financial: 'Financial advisory', hr: 'Recruitment and HR' };
const humanize = (k) => {
  const s = k.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const speaker = (sp) => {
  const n = Number(String(sp ?? '').replace(/\D/g, ''));
  return sp && Number.isFinite(n) ? `Speaker ${n + 1}` : 'Speaker';
};
const list = (items) => (items?.length
  ? `<ul>${items.map((i) => `<li>${esc(typeof i === 'object' ? i.text : i)}</li>`).join('')}</ul>`
  : '<p class="muted">None stated.</p>');
const section = (title, body) => `<section><h2>${esc(title)}</h2>${body}</section>`;

const STYLE = `
@page { size: A4; margin: 22mm 20mm; }
body { font-family: Georgia, 'Times New Roman', serif; color: #1f2937; font-size: 11pt; line-height: 1.6; max-width: 170mm; margin: 0 auto; }
h1 { font-family: Arial, Helvetica, sans-serif; font-size: 18pt; font-weight: 700; color: #1e1b4b; margin: 0 0 6px; padding-bottom: 8px; border-bottom: 2px solid #4c1d95; }
h2 { font-family: Arial, Helvetica, sans-serif; font-size: 12pt; font-weight: 700; color: #4c1d95; margin: 18px 0 8px; padding-bottom: 3px; border-bottom: 1px solid #d1d5db; page-break-after: avoid; }
.meta { font-family: Arial, Helvetica, sans-serif; font-size: 9.5pt; color: #475569; line-height: 1.5; margin: 0 0 12px; text-align: left; }
p, li { text-align: justify; hyphens: auto; }
ul { margin: 4px 0 8px 18px; padding: 0; }
li { margin: 3px 0; }
.notice { font-family: Arial, Helvetica, sans-serif; font-size: 9.5pt; line-height: 1.5; background: #f5f3ff; border-left: 3px solid #6d28d9; padding: 8px 10px; margin: 12px 0 14px; text-align: left; }
.ts { font-family: 'Courier New', Courier, monospace; color: #6d28d9; font-size: 9pt; }
.muted { color: #6b7280; }
table { width: 100%; border-collapse: collapse; font-family: Arial, Helvetica, sans-serif; font-size: 9.5pt; margin: 4px 0 8px; }
th, td { border-bottom: 1px solid #e5e7eb; padding: 5px 6px; text-align: left; vertical-align: top; }
th { background: #f3f4f6; color: #374151; font-weight: 700; border-top: 1px solid #d1d5db; }
p.seg { text-align: justify; hyphens: auto; font-size: 10pt; margin: 5px 0; }
.sign { font-family: Arial, Helvetica, sans-serif; font-size: 9.5pt; color: #374151; margin-top: 28px; padding-top: 8px; border-top: 1px solid #9ca3af; text-align: left; }
@media print { body { margin: 0; max-width: none; } }
`;

export async function buildReport(id) {
  const { rows: [m] } = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (!m) throw new HttpError(404, 'Meeting not found');
  const { rows: [a] } = await pool.query('SELECT * FROM meeting_analysis WHERE meeting_id = $1', [id]);
  const { rows: tasks } = await pool.query(
    'SELECT description, owner, due_text, status, origin, source_start FROM action_items WHERE meeting_id = $1 ORDER BY id', [id]);
  const { rows: segments } = await pool.query(
    'SELECT seq, speaker, start_sec, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY seq', [id]);

  const workflow = SECTOR_LABELS[a?.sector || m.sector] || SECTOR_LABELS[m.sector] || 'General';
  const participants = Array.isArray(m.participants) && m.participants.length ? m.participants.join(', ') : 'None listed';

  let body = '';
  if (!a) {
    body += section('Analysis', '<p class="muted">The AI analysis has not been completed for this meeting yet.</p>');
  } else {
    body += section('Executive summary', `<p>${esc(a.executive_summary)}</p>`);
    body += section('Detailed summary', `<p>${esc(a.detailed_summary).replace(/\n/g, '<br>')}</p>`);
    body += section('Key points', (a.key_points || []).length
      ? `<ul>${a.key_points.map((k) => `<li>${esc(k.text)}${stamp(k.start_sec)}</li>`).join('')}</ul>`
      : '<p class="muted">None stated.</p>');
    body += section('Decisions', (a.decisions || []).length
      ? `<ul>${a.decisions.map((d) => `<li>${esc(d.text)}${stamp(d.start_sec)}</li>`).join('')}</ul>`
      : '<p class="muted">No decisions stated.</p>');
    body += section('Tasks', tasks.length
      ? `<table><thead><tr><th>Task</th><th>Owner</th><th>Deadline</th><th>Status</th><th>Time</th></tr></thead><tbody>${tasks.map((t) => `<tr><td>${esc(t.description)}</td><td>${esc(t.owner || 'Not stated')}</td><td>${esc(t.due_text || 'Not stated')}</td><td>${t.status === 'done' ? 'Done' : 'Open'}</td><td>${t.source_start == null ? '' : esc(clock(t.source_start))}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No tasks.</p>');
    body += section('Possible conflicts (check both statements)', (a.flags || []).length
      ? `<ul>${a.flags.map((f) => `<li>${esc(f.summary)}${stamp(f.start_a)}${stamp(f.start_b)}</li>`).join('')}</ul>`
      : '<p class="muted">None flagged.</p>');
    body += section('Follow-ups', list(a.follow_ups));
    body += section('Open questions', list(a.open_questions));
    body += section('Risks and concerns', list(a.risks));
    const fields = Object.entries(a.sector_fields || {}).filter(([, v]) => (Array.isArray(v) ? v.length : v));
    for (const [key, v] of fields) {
      body += section(humanize(key), Array.isArray(v) ? list(v) : `<p>${esc(v)}</p>`);
    }
    body += section('Points for professional review', list(a.review_notes));
  }

  const transcript = segments.length
    ? segments.map((s) => `<p class="seg"><span class="ts">[${esc(clock(s.start_sec))}]</span> <strong>${esc(speaker(s.speaker))}:</strong> ${esc(s.text)}</p>`).join('')
    : '<p class="muted">No transcript.</p>';
  body += section('Transcript', transcript);

  const generated = new Date().toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="ProgId" content="Word.Document"><meta name="Generator" content="Vespera"><title>${esc(m.title)}</title><style>${STYLE}</style></head>
<body>
<h1>${esc(m.title)}</h1>
<p class="meta">${esc(dateText(m.meeting_date))} · ${esc(CATEGORY_LABELS[m.category] || m.category)} · Workflow: ${esc(workflow)}<br>Participants: ${esc(participants)}</p>
<div class="notice"><strong>AI-generated draft for professional review.</strong> Check every point against the recording before relying on it. This is not legal, medical or financial advice.</div>
${body}
<div class="sign">Reviewed by: ______________________________ &nbsp; Date: ____________<br><span class="muted">Generated by Vespera on ${esc(generated)}</span></div>
</body></html>`;
}
