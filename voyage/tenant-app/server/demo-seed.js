// Creates ONE clearly labelled sample meeting so the product can be demonstrated.
// It calls no AWS or AI service. Every stored value is sample data written by this script.
// Run inside a workspace container:  node server/demo-seed.js
import { pool } from './db.js';

const TITLE = '[DEMO] Sample client intake (sample data, not a real recording)';

const segments = [
  [1, 'spk_0', 0, 6, 'Thank you for coming in. Today we will go through the matter and the next steps.'],
  [2, 'spk_1', 6, 14, 'We need the signed engagement letter back by Friday, and the bank statements from the last six months.'],
  [3, 'spk_0', 14, 22, 'Agreed. We will also review the contract dispute before the hearing on the twelfth of December.'],
  [4, 'spk_1', 22, 30, 'Please note that the client is not willing to accept a settlement below the amount already offered.'],
];

async function main() {
  const existing = await pool.query('SELECT id FROM meetings WHERE title = $1', [TITLE]);
  if (existing.rowCount) {
    console.log(`Demo meeting already exists (id ${existing.rows[0].id}). Nothing changed.`);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [m] } = await client.query(
      `INSERT INTO meetings (title, description, category, meeting_date, participants, status, created_by, sector)
       VALUES ($1, $2, 'legal_intake', CURRENT_DATE, '["Sample client", "Sample lawyer"]'::jsonb, 'completed', 'demo seed', 'legal')
       RETURNING id`,
      [TITLE, 'Sample data created for demonstration. Not a real client or recording.']);
    for (const [seq, speaker, start, end, text] of segments) {
      await client.query(
        'INSERT INTO transcript_segments (meeting_id, seq, speaker, start_sec, end_sec, text) VALUES ($1, $2, $3, $4, $5, $6)',
        [m.id, seq, speaker, start, end, text]);
    }
    await client.query(
      `INSERT INTO meeting_analysis (meeting_id, executive_summary, detailed_summary, key_points, decisions, follow_ups,
         open_questions, risks, legal, provider, model, sector, sector_fields, flags, review_notes)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, NULL, 'Sample data (no AI used)', 'none', 'legal',
         $9::jsonb, '[]'::jsonb, $10::jsonb)`,
      [m.id,
        'Sample intake: the client needs the engagement letter and six months of bank statements. A settlement offer is under discussion.',
        'Sample data. The client will return the engagement letter and bank statements by Friday. The contract dispute will be reviewed before the hearing on 12 December. The client will not accept a settlement below the amount already offered.',
        JSON.stringify([{ text: 'Client has not accepted any settlement below the existing offer.', source_seq: 4, start_sec: 22, end_sec: 30 }]),
        JSON.stringify([]),
        JSON.stringify(['Confirm the hearing date with the court registry.']),
        JSON.stringify([]),
        JSON.stringify(['Settlement position needs confirming with the client.']),
        JSON.stringify({ facts_discussed: ['Contract dispute', 'Bank statements requested'], deadlines: ['Engagement letter due Friday', 'Hearing on 12 December'] }),
        JSON.stringify(['Sample data: check every point before using it in a real matter.']),
      ]);
    await client.query(
      `INSERT INTO action_items (meeting_id, description, owner, due_text, origin, source_seq, source_start, source_end)
       VALUES ($1, 'Send the engagement letter back to the firm', NULL, 'Friday', 'ai', 2, 6, 14),
              ($1, 'Review the contract dispute before the hearing', NULL, NULL, 'ai', 3, 14, 22)`,
      [m.id]);
    await client.query('COMMIT');
    console.log(`Created demo meeting id ${m.id}. It is labelled as sample data.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

main().then(() => pool.end()).catch(async (err) => {
  console.error('demo seed failed:', err.message);
  await pool.end();
  process.exit(1);
});
