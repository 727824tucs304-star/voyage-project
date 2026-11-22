import { pool } from './db.js';

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
// Longer transcripts are analysed in parts and merged, to stay within free-tier token limits.
const CHUNK_CHARS = 9000;

const LIST = 'list';
const TEXT = 'text';
const f = (type, hint) => ({ type, hint });

// Industry workflows. Each lists the extra fields the AI may fill in. Fields left empty are not shown.
export const SECTORS = {
  legal: {
    label: 'Legal',
    fields: {
      client_matter: f(TEXT, 'Client and matter name, only if stated'),
      facts_discussed: f(LIST, 'Facts raised in the conversation'),
      key_statements: f(LIST, 'Notable statements, quoted or closely paraphrased'),
      commitments: f(LIST, 'Commitments made by either party'),
      outstanding_documents: f(LIST, 'Documents requested or promised'),
      deadlines: f(LIST, 'Court, filing or limitation dates, only if explicitly stated'),
    },
  },
  sales: {
    label: 'B2B sales',
    fields: {
      buyer_needs: f(LIST, 'Problems or goals the buyer described'),
      objections: f(LIST, 'Objections or concerns the buyer raised'),
      budget: f(TEXT, 'Budget mentioned by the buyer, only if stated'),
      decision_makers: f(LIST, 'People who make the decision, only if named'),
      next_steps: f(LIST, 'Agreed next steps'),
    },
  },
  healthcare: {
    label: 'Healthcare',
    fields: {
      subjective: f(LIST, 'Patient-reported symptoms and history, as stated'),
      objective: f(LIST, 'Observations and measurements stated in the consultation'),
      assessment: f(LIST, 'Assessments stated by the clinician'),
      plan: f(LIST, 'Plan stated in the consultation'),
      medications_stated: f(LIST, 'Medications mentioned, exactly as stated, with any dose stated'),
    },
  },
  financial: {
    label: 'Financial advisory',
    fields: {
      client_goals: f(LIST, 'Financial goals the client described'),
      risk_disclosures: f(LIST, 'Risks or disclosures discussed'),
      portfolio_actions: f(LIST, 'Actions agreed about holdings or investments'),
      compliance_statements: f(LIST, 'Statements that may need compliance review'),
    },
  },
  hr: {
    label: 'Recruitment and HR',
    fields: {
      competencies_discussed: f(LIST, 'Skills or experience discussed'),
      strengths_stated: f(LIST, 'Strengths mentioned in the interview'),
      concerns_raised: f(LIST, 'Concerns raised about the candidate or role'),
      follow_up_questions: f(LIST, 'Questions still to answer'),
    },
  },
  general: { label: 'General', fields: {} },
};

// Values in these fields must appear word for word in the transcript, or they are dropped.
const GROUNDED_LISTS = new Set(['deadlines', 'medications_stated', 'decision_makers']);
const GROUNDED_TEXT = new Set(['budget']);

// Meeting categories map to a workflow. A meeting can also set its own sector.
const CATEGORY_SECTOR = { legal_intake: 'legal', client_call: 'sales', internal_case: 'general', board: 'general', other: 'general' };
export const sectorFor = (meeting) => (meeting.sector && SECTORS[meeting.sector] ? meeting.sector : CATEGORY_SECTOR[meeting.category] || 'general');

function activeProvider() {
  if (process.env.AI_PROVIDER === 'mock') return 'mock';
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}
export const aiConfigured = () => activeProvider() !== null;
const providerLabel = () => ({ mock: 'Test provider (mock)', groq: 'Groq', gemini: 'Google Gemini' })[activeProvider()] || 'Not configured';
const modelName = () => ({ groq: GROQ_MODEL, gemini: GEMINI_MODEL })[activeProvider()] || 'mock';
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function parseJson(text) {
  try {
    return JSON.parse(text.replace(/^```json\s*|```\s*$/g, '').trim());
  } catch {
    throw new Error('The AI reply could not be read. It will be retried automatically.');
  }
}

async function callGroq(prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    console.error('groq http', res.status);
    throw new Error('AI analysis is temporarily unavailable. It will be retried automatically.');
  }
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content || '');
}

async function callGemini(prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    console.error('gemini http', res.status);
    throw new Error('AI analysis is temporarily unavailable. It will be retried automatically.');
  }
  const data = await res.json();
  return parseJson((data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(''));
}

async function callModel(prompt) {
  const kind = activeProvider();
  if (kind === 'groq') return callGroq(prompt);
  if (kind === 'gemini') return callGemini(prompt);
  throw new Error('No AI provider is configured.');
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
    possible_conflicts: [],
    review_notes: ['Mock review note.'],
    sector_fields: {},
  };
}

function sectorSpec(sector) {
  const entries = Object.entries(SECTORS[sector].fields);
  if (!entries.length) return '"sector_fields": {}';
  const lines = entries.map(([k, def]) => `    "${k}": ${def.type === LIST ? '[string]' : 'string or null'}   // ${def.hint}`);
  return `"sector_fields": {\n${lines.join('\n')}\n  }`;
}

function buildPrompt(meeting, sector, segs) {
  const lines = segs.map((s) => `[${s.seq}] ${s.speaker ? `Speaker ${Number(String(s.speaker).replace(/\D/g, '')) + 1}` : 'Speaker'} (${clock(s.start_sec)}): ${s.text}`);
  return `You analyse part of a meeting transcript for a ${SECTORS[sector].label} workflow. Return ONLY JSON with this shape:
{
  "executive_summary": string,
  "detailed_summary": string,
  "key_points": [{"text": string, "source_seq": number}],
  "decisions": [{"text": string, "source_seq": number}],
  "action_items": [{"text": string, "owner": string|null, "due": string|null, "source_seq": number}],
  "follow_ups": [string],
  "open_questions": [string],
  "risks": [string],
  "possible_conflicts": [{"summary": string, "seq_a": number, "seq_b": number}],
  "review_notes": [string],
  ${sectorSpec(sector)}
}
Rules:
- Use only information stated in the transcript. Never invent people, facts, dates, deadlines, figures or conclusions.
- source_seq, seq_a and seq_b must be bracketed numbers from the transcript below.
- Never mention segment numbers or brackets in any text field.
- owner, due, budget, deadlines, decision_makers and medications_stated must be copied word for word from the transcript, or left null or empty.
- possible_conflicts: only pairs of statements that appear to contradict each other, with both segment numbers. Do not decide which one is correct.
- review_notes: points a professional should verify before relying on this output.
- If something cannot be determined, write "Unknown from the transcript" or leave the list empty.
- This is a draft for professional review. It is not legal, medical or financial advice.
Meeting title: ${meeting.title}. Category: ${meeting.category}.

Transcript:
${lines.join('\n')}`;
}

// Splits the transcript into parts of roughly CHUNK_CHARS characters, on segment boundaries.
function splitChunks(segments) {
  const parts = [];
  let current = [];
  let size = 0;
  for (const s of segments) {
    const len = s.text.length + 40;
    if (size + len > CHUNK_CHARS && current.length) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(s);
    size += len;
  }
  if (current.length) parts.push(current);
  return parts;
}

function mergePartials(partials, sector) {
  const out = {
    executive_summary: '', detailed_summary: '',
    key_points: [], decisions: [], action_items: [], follow_ups: [], open_questions: [], risks: [],
    possible_conflicts: [], review_notes: [], sector_fields: {},
  };
  for (const p of partials) {
    for (const k of ['key_points', 'decisions', 'action_items', 'follow_ups', 'open_questions', 'risks', 'possible_conflicts', 'review_notes']) {
      out[k].push(...(Array.isArray(p[k]) ? p[k] : []));
    }
    for (const [k, def] of Object.entries(SECTORS[sector].fields)) {
      const v = p.sector_fields?.[k];
      if (def.type === LIST) out.sector_fields[k] = [...(out.sector_fields[k] || []), ...(Array.isArray(v) ? v : [])];
      else if (v && !out.sector_fields[k]) out.sector_fields[k] = v;
    }
  }
  return out;
}

async function runModel(meeting, sector, segs) {
  if (activeProvider() === 'mock') return mockOutput();
  return callModel(buildPrompt(meeting, sector, segs));
}

// Short transcripts take one request. Long ones are analysed in parts, then merged,
// and the overall summary is written from the part summaries only.
async function analyseChunked(meeting, sector, segments) {
  const parts = splitChunks(segments);
  if (parts.length === 1) return runModel(meeting, sector, parts[0]);

  const partials = [];
  for (const part of parts) partials.push(await runModel(meeting, sector, part));
  const merged = mergePartials(partials, sector);

  if (activeProvider() !== 'mock') {
    const summaries = partials.map((p, i) => `Part ${i + 1}: ${p.executive_summary || ''}\n${p.detailed_summary || ''}`).join('\n\n');
    const final = await callModel(`Combine these partial summaries of one meeting titled "${meeting.title}" into one result.
Return ONLY JSON: {"executive_summary": string, "detailed_summary": string}.
Use only what the parts say. Do not add anything new.

${summaries}`);
    merged.executive_summary = final.executive_summary || merged.executive_summary;
    merged.detailed_summary = final.detailed_summary || merged.detailed_summary;
  }
  return merged;
}

// Server-side checks: AI output is kept only when it can be traced to the transcript.
function validate(out, segments, sector) {
  const seqs = new Set(segments.map((s) => s.seq));
  const haystack = segments.map((s) => s.text).join(' ').toLowerCase();
  const seq = (n) => (seqs.has(Number(n)) ? Number(n) : null);
  const txt = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const grounded = (v) => (typeof v === 'string' && v.trim() && haystack.includes(v.trim().toLowerCase()) ? v.trim().slice(0, 120) : null);
  const strings = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => txt(x).replace(/\s*(after|in|at|from)?\s*segment\s*\[?\d+\]?/gi, '').replace(/\s*\[\d+\]/g, '').trim()).filter(Boolean))].slice(0, 50);
  const items = (arr) => (Array.isArray(arr) ? arr : []).map((x) => ({ text: txt(x?.text), source_seq: seq(x?.source_seq) })).filter((x) => x.text).slice(0, 50);

  const actions = (Array.isArray(out.action_items) ? out.action_items : []).map((a) => ({
    text: txt(a?.text), owner: grounded(a?.owner), due: grounded(a?.due), source_seq: seq(a?.source_seq),
  })).filter((a) => a.text).slice(0, 50);

  const conflicts = (Array.isArray(out.possible_conflicts) ? out.possible_conflicts : []).map((c) => ({
    summary: txt(c?.summary), seq_a: seq(c?.seq_a), seq_b: seq(c?.seq_b),
  })).filter((c) => c.summary && c.seq_a != null && c.seq_b != null && c.seq_a !== c.seq_b).slice(0, 30);

  const sectorFields = {};
  for (const [key, def] of Object.entries(SECTORS[sector].fields)) {
    const v = out.sector_fields?.[key];
    if (def.type === LIST) {
      let list = strings(v);
      if (GROUNDED_LISTS.has(key)) list = list.filter((x) => haystack.includes(x.toLowerCase()));
      sectorFields[key] = list;
    } else {
      const val = txt(v, 300);
      sectorFields[key] = val && (!GROUNDED_TEXT.has(key) || grounded(val)) ? val : null;
    }
  }

  return {
    executive_summary: txt(out.executive_summary, 2000),
    detailed_summary: txt(out.detailed_summary, 6000),
    key_points: items(out.key_points),
    decisions: items(out.decisions),
    action_items: actions,
    follow_ups: strings(out.follow_ups),
    open_questions: strings(out.open_questions),
    risks: strings(out.risks),
    review_notes: strings(out.review_notes),
    possible_conflicts: conflicts,
    sector_fields: sectorFields,
  };
}

// Stores analysis. Timestamps come from the stored transcript, never from the AI.
export async function saveAnalysis(meetingId, meeting, segments, rawOut, sector) {
  const v = validate(rawOut, segments, sector);
  const startMap = new Map(segments.map((s) => [s.seq, Number(s.start_sec)]));
  const endMap = new Map(segments.map((s) => [s.seq, Number(s.end_sec)]));
  const startAt = (seq) => (seq != null && startMap.has(seq) ? startMap.get(seq) : null);
  const endAt = (seq) => (seq != null && endMap.has(seq) ? endMap.get(seq) : null);
  const withTime = (arr) => arr.map((x) => ({ ...x, start_sec: startAt(x.source_seq), end_sec: endAt(x.source_seq) }));
  const flags = v.possible_conflicts.map((c) => ({
    summary: c.summary, seq_a: c.seq_a, seq_b: c.seq_b, start_a: startAt(c.seq_a), start_b: startAt(c.seq_b),
  }));
  const legal = sector === 'legal' ? v.sector_fields : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO meeting_analysis (meeting_id, executive_summary, detailed_summary, key_points, decisions, follow_ups,
         open_questions, risks, legal, provider, model, sector, sector_fields, flags, review_notes)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb)
       ON CONFLICT (meeting_id) DO UPDATE SET executive_summary = EXCLUDED.executive_summary,
         detailed_summary = EXCLUDED.detailed_summary, key_points = EXCLUDED.key_points, decisions = EXCLUDED.decisions,
         follow_ups = EXCLUDED.follow_ups, open_questions = EXCLUDED.open_questions, risks = EXCLUDED.risks,
         legal = EXCLUDED.legal, provider = EXCLUDED.provider, model = EXCLUDED.model, sector = EXCLUDED.sector,
         sector_fields = EXCLUDED.sector_fields, flags = EXCLUDED.flags, review_notes = EXCLUDED.review_notes,
         created_at = now()`,
      [meetingId, v.executive_summary, v.detailed_summary, JSON.stringify(withTime(v.key_points)),
        JSON.stringify(withTime(v.decisions)), JSON.stringify(v.follow_ups), JSON.stringify(v.open_questions),
        JSON.stringify(v.risks), legal ? JSON.stringify(legal) : null, providerLabel(), modelName(),
        sector, JSON.stringify(v.sector_fields), JSON.stringify(flags), JSON.stringify(v.review_notes)]);

    await client.query("DELETE FROM action_items WHERE meeting_id = $1 AND origin = 'ai'", [meetingId]);
    for (const a of v.action_items) {
      await client.query(
        `INSERT INTO action_items (meeting_id, description, owner, due_text, origin, source_seq, source_start, source_end)
         VALUES ($1, $2, $3, $4, 'ai', $5, $6, $7)`,
        [meetingId, a.text, a.owner, a.due, a.source_seq, startAt(a.source_seq), endAt(a.source_seq)]);
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
  const { rows: [meeting] } = await pool.query('SELECT title, category, sector FROM meetings WHERE id = $1', [meetingId]);
  const { rows: segments } = await pool.query(
    'SELECT seq, speaker, start_sec, end_sec, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY seq', [meetingId]);
  if (!segments.length) throw new Error('No transcript is stored for this meeting.');
  const sector = sectorFor(meeting);
  const raw = await analyseChunked(meeting, sector, segments);
  await saveAnalysis(meetingId, meeting, segments, raw, sector);
}
