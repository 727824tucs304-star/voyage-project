import { pool } from './db.js';

// AI analysis. Uses Google Gemini (free tier) when GEMINI_API_KEY is set.
// AI_PROVIDER=mock exists only for automated tests and is labelled as such.
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
export const aiConfigured = () => process.env.AI_PROVIDER === 'mock' || Boolean(process.env.GEMINI_API_KEY);
const provider = () => (process.env.AI_PROVIDER === 'mock' ? 'Test provider (mock)' : 'Google Gemini');
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function callGemini(prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Gemini returned HTTP ${res.status}. Check GEMINI_API_KEY and the model name.`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  try {
    return JSON.parse(text.replace(/^```json\s*|```\s*$/g, '').trim());
  } catch {
    throw new Error('The AI reply was not valid JSON. The job will be retried.');
  }
}

function mockOutput() {
  return {
    executive_summary: 'Mock summary for automated tests.',
    detailed_summary: 'Mock detailed summary for automated tests.',
    key_points: [{ text: 'Mock key point.', source_seq: 1 }],
    decisions: [{ text: 'Mock decision.', source_seq: 1 }],
    action_items: [{ text: 'Mock action item.', owner: 'Priya', due: null, source_seq: 2 }],
    follow_ups: ['Mock follow-up.'],
    open_questions: [],
    risks: [],
    legal: null,
  };
}

function prompt(meeting, segments) {
  const lines = segments.map((s) => `[${s.seq}] ${s.speaker ? `Speaker ${Number(String(s.speaker).replace(/\D/g, '')) + 1}` : 'Speaker'} (${clock(s.start_sec)}): ${s.text}`);
  return `You analyse a meeting transcript. Return ONLY JSON with this shape:
{"executive_summary": string, "detailed_summary": string,
 "key_points": [{"text": string, "source_seq": number}],
 "decisions": [{"text": string, "source_seq": number}],
 "action_items": [{"text": string, "owner": string|null, "due": string|null, "source_seq": number}],
 "follow_ups": [string], "open_questions": [string], "risks": [string],
 "legal": null or {"client_matter": string, "facts_discussed": [string], "key_statements": [{"text": string, "source_seq": number}], "commitments": [string], "outstanding_documents": [string], "deadlines_follow_ups": [string], "review_flags": [string]}}
Rules:
- Use only information stated in the transcript. Never invent people, facts, dates, deadlines or conclusions.
- source_seq must be one of the bracketed numbers below.
- owner and due must be copied word for word from the transcript, or null if not stated.
- If something cannot be determined, write "Unknown from the transcript".
- Fill "legal" only when the meeting category is legal_intake; otherwise null. Legal items are for professional review, not legal advice.
Meeting category: ${meeting.category}. Title: ${meeting.title}.

Transcript:
${lines.join('\n')}`;
}

// Server-side checks: AI output is kept only when it can be traced to the transcript.
function validate(out, segments) {
  const seqs = new Set(segments.map((s) => s.seq));
  const haystack = segments.map((s) => s.text).join(' ').toLowerCase();
  const seq = (n) => (seqs.has(Number(n)) ? Number(n) : null);
  const txt = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const grounded = (v) => (typeof v === 'string' && v.trim() && haystack.includes(v.trim().toLowerCase()) ? v.trim().slice(0, 120) : null);
  const items = (arr) => (Array.isArray(arr) ? arr : []).map((x) => ({ text: txt(x?.text), source_seq: seq(x?.source_seq) })).filter((x) => x.text).slice(0, 50);
  const strings = (arr) => (Array.isArray(arr) ? arr : []).map((x) => txt(x)).filter(Boolean).slice(0, 50);
  const actions = (Array.isArray(out.action_items) ? out.action_items : []).map((a) => ({
    text: txt(a?.text), owner: grounded(a?.owner), due: grounded(a?.due), source_seq: seq(a?.source_seq),
  })).filter((a) => a.text).slice(0, 50);
  const legal = out.legal && typeof out.legal === 'object' ? {
    client_matter: txt(out.legal.client_matter, 300),
    facts_discussed: strings(out.legal.facts_discussed),
    key_statements: items(out.legal.key_statements),
    commitments: strings(out.legal.commitments),
    outstanding_documents: strings(out.legal.outstanding_documents),
    deadlines_follow_ups: strings(out.legal.deadlines_follow_ups),
    review_flags: strings(out.legal.review_flags),
  } : null;
  return {
    executive_summary: txt(out.executive_summary, 2000),
    detailed_summary: txt(out.detailed_summary, 6000),
    key_points: items(out.key_points),
    decisions: items(out.decisions),
    action_items: actions,
    follow_ups: strings(out.follow_ups),
    open_questions: strings(out.open_questions),
    risks: strings(out.risks),
    legal,
  };
}

// Stores analysis. Timestamps come from the stored transcript, never from the AI.
export async function saveAnalysis(meetingId, meeting, segments, rawOut) {
  const v = validate(rawOut, segments);
  const start = new Map(segments.map((s) => [s.seq, { start: Number(s.start_sec), end: Number(s.end_sec) }]));
  const at = (seq) => (seq && start.has(seq) ? start.get(seq) : { start: null, end: null });
  const withTime = (arr) => arr.map((x) => ({ ...x, start_sec: at(x.source_seq).start, end_sec: at(x.source_seq).end }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO meeting_analysis (meeting_id, executive_summary, detailed_summary, key_points, decisions, follow_ups,
         open_questions, risks, legal, provider, model)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11)
       ON CONFLICT (meeting_id) DO UPDATE SET executive_summary = EXCLUDED.executive_summary,
         detailed_summary = EXCLUDED.detailed_summary, key_points = EXCLUDED.key_points, decisions = EXCLUDED.decisions,
         follow_ups = EXCLUDED.follow_ups, open_questions = EXCLUDED.open_questions, risks = EXCLUDED.risks,
         legal = EXCLUDED.legal, provider = EXCLUDED.provider, model = EXCLUDED.model, created_at = now()`,
      [meetingId, v.executive_summary, v.detailed_summary, JSON.stringify(withTime(v.key_points)),
        JSON.stringify(withTime(v.decisions)), JSON.stringify(v.follow_ups), JSON.stringify(v.open_questions),
        JSON.stringify(v.risks), v.legal ? JSON.stringify(v.legal) : null, provider(),
        process.env.AI_PROVIDER === 'mock' ? 'mock' : MODEL]);
    await client.query("DELETE FROM action_items WHERE meeting_id = $1 AND origin = 'ai'", [meetingId]);
    for (const a of v.action_items) {
      const t = at(a.source_seq);
      await client.query(
        `INSERT INTO action_items (meeting_id, description, owner, due_text, origin, source_seq, source_start, source_end)
         VALUES ($1, $2, $3, $4, 'ai', $5, $6, $7)`,
        [meetingId, a.text, a.owner, a.due, a.source_seq, t.start, t.end]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function analyse(meetingId) {
  const { rows: [meeting] } = await pool.query('SELECT title, category FROM meetings WHERE id = $1', [meetingId]);
  const { rows: segments } = await pool.query(
    'SELECT seq, speaker, start_sec, end_sec, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY seq', [meetingId]);
  if (!segments.length) throw new Error('No transcript is stored for this meeting.');
  const out = process.env.AI_PROVIDER === 'mock'
    ? mockOutput()
    : await callGemini(prompt(meeting, segments));
  await saveAnalysis(meetingId, meeting, segments, out);
}
