import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus, Search, Trash2, Download, ShieldCheck, Clock } from 'lucide-react';
import { api, session } from './api.js';
import { Button, Card } from './pages.jsx';

export const CATEGORY = {
  legal_intake: 'Legal client intake', internal_case: 'Internal case discussion',
  client_call: 'Client call', board: 'Board or leadership', other: 'Other',
  healthcare: 'Healthcare', financial: 'Financial advisory', hr: 'Recruitment and HR',
};
export const STATUS = {
  draft: 'Draft', uploaded: 'Uploaded', queued: 'Waiting for transcription', transcribing: 'Transcribing',
  analysing: 'Analysing', completed: 'Completed', failed: 'Failed',
};
const SECTOR_LABELS = {
  legal: 'Legal', sales: 'B2B sales', healthcare: 'Healthcare', financial: 'Financial advisory', hr: 'Recruitment and HR', general: 'General',
};
const STATUS_STYLE = {
  draft: 'bg-slate-100 text-slate-700', uploaded: 'bg-slate-100 text-slate-700', queued: 'bg-amber-50 text-amber-800',
  transcribing: 'bg-violet-50 text-violet-700', analysing: 'bg-violet-50 text-violet-700',
  completed: 'bg-emerald-50 text-emerald-700', failed: 'bg-red-50 text-red-700',
};
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm' };
const inputCls = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600';
const EMPTY_FILTERS = { q: '', category: '', status: '', from: '', to: '' };

const dateText = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const sizeText = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const clock = (sec) => {
  const s = Math.floor(Number(sec) || 0);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const speakerName = (sp) => {
  const n = Number(String(sp).replace(/\D/g, ''));
  return Number.isFinite(n) ? `Speaker ${n + 1}` : 'Speaker';
};
const humanize = (key) => {
  const s = key.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const durationText = (sec) => {
  const s = Math.round(Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
const Block = ({ title, children }) => (
  <div className="mt-5">
    <h3 className="mb-2 text-sm font-semibold text-slate-900">{title}</h3>
    {children}
  </div>
);
const Bullets = ({ items }) => (items?.length ? (
  <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">{items.map((x, i) => <li key={i}>{typeof x === 'object' ? x.text : x}</li>)}</ul>
) : <p className="text-sm text-slate-400">None stated.</p>);
const TimeChip = ({ sec, seq }) => (sec == null ? null : (
  <a href={`#seg-${seq}`} className="ml-2 rounded bg-violet-50 px-1.5 py-0.5 font-mono text-xs text-violet-700 hover:underline">{clock(sec)}</a>
));
// Renders whatever workflow fields the analysis contains. Empty fields are not shown.
const SectorFields = ({ data }) => Object.entries(data || {})
  .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : Boolean(v)))
  .map(([key, v]) => (
    <Block key={key} title={humanize(key)}>
      {Array.isArray(v)
        ? <Bullets items={v} />
        : <p className="text-sm text-slate-700">{v}</p>}
    </Block>
  ));

function Header({ title, subtitle, children }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

const Pill = ({ status }) => (
  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status] || STATUS_STYLE.draft}`}>
    {STATUS[status] || status}
  </span>
);

// Shows whether the AI services are configured. Missing credentials are reported, never hidden.
function ProviderBanner({ status }) {
  if (!status) return null;
  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-2">
      {[['Transcription', status.transcription], ['AI analysis', status.ai]].map(([label, p]) => (
        <div key={label} className={`rounded-lg border p-4 text-sm ${p.configured ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
          <div className="font-medium text-slate-900">{label}: {p.configured ? 'Configured' : 'Not configured'}</div>
          <div className="mt-1 text-slate-600">{p.message}</div>
        </div>
      ))}
    </div>
  );
}

export function OverviewPage() {
  const [stats, setStats] = useState(null);
  const [prov, setProv] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    Promise.all([api('GET', '/meetings/stats'), api('GET', '/processing/status')])
      .then(([s, p]) => { setStats(s); setProv(p); })
      .catch((e) => setErr(e.message));
  }, []);
  const cards = stats ? [
    ['Total meetings', stats.total_meetings],
    ['Meetings processed', stats.processed],
    ['Recording duration', durationText(stats.duration_seconds)],
    ['Pending jobs', stats.pending_jobs],
  ] : [];
  return (
    <>
      <Header title="Overview" subtitle="Meetings, processing and recent activity for your organisation." />
      {err && <p className="mb-4 text-sm text-red-600">{err}</p>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {cards.map(([label, value]) => (
          <Card key={label} className="p-5">
            <div className="text-sm text-slate-500">{label}</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
          </Card>
        ))}
      </div>
      <Card className="mt-6">
        <div className="border-b border-slate-200 px-5 py-3 font-medium text-slate-900">Recent meetings</div>
        {!stats ? <p className="p-6 text-sm text-slate-500">Loading…</p>
          : stats.recent.length === 0 ? <p className="p-6 text-sm text-slate-500">No meetings yet. Create your first meeting to get started.</p>
          : <ul className="divide-y divide-slate-100">{stats.recent.map((m) => (
              <li key={m.id} className="flex items-center justify-between px-5 py-3 text-sm">
                <Link to={`/meetings/${m.id}`} className="font-medium text-slate-900 hover:underline">{m.title}</Link>
                <span className="flex items-center gap-3 text-slate-500"><Pill status={m.status} />{dateText(m.meeting_date)}</span>
              </li>))}
            </ul>}
      </Card>
    </>
  );
}

function MeetingForm({ onSaved, onCancel }) {
  const [form, setForm] = useState({ title: '', description: '', category: 'legal_intake', sector: '', meeting_date: new Date().toISOString().slice(0, 10), participants: '' });
  const [err, setErr] = useState('');
  const save = async (e) => {
    e.preventDefault();
    setErr('');
    try { onSaved(await api('POST', '/meetings', form)); } catch (ex) { setErr(ex.message); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center" onClick={onCancel}>
      <form onSubmit={save} onClick={(e) => e.stopPropagation()} className="max-h-[90vh] w-full space-y-3 overflow-y-auto rounded-t-lg bg-white p-5 sm:max-w-lg sm:rounded-lg">
        <h2 className="text-lg font-semibold text-slate-900">New meeting</h2>
        <label className="block text-sm"><span className="mb-1 block font-medium">Title *</span>
          <input className={inputCls} required maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm"><span className="mb-1 block font-medium">Category</span>
            <select className={inputCls} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {Object.entries(CATEGORY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="block text-sm"><span className="mb-1 block font-medium">Meeting date *</span>
            <input className={inputCls} type="date" required value={form.meeting_date} onChange={(e) => setForm({ ...form, meeting_date: e.target.value })} /></label>
        </div>
        <label className="block text-sm"><span className="mb-1 block font-medium">Workflow</span>
          <select className={inputCls} value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })}>
            <option value="">Choose from the category</option>
            {Object.entries(SECTOR_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="block text-sm"><span className="mb-1 block font-medium">Participants</span>
          <input className={inputCls} placeholder="Separate names with commas" value={form.participants} onChange={(e) => setForm({ ...form, participants: e.target.value })} /></label>
        <label className="block text-sm"><span className="mb-1 block font-medium">Description</span>
          <textarea className={inputCls} rows={3} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onCancel}>Cancel</Button>
          <Button type="submit">Create meeting</Button>
        </div>
      </form>
    </div>
  );
}

function SearchPanel() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [err, setErr] = useState('');
  const run = async (e) => {
    e.preventDefault();
    setErr('');
    try { setResults(await api('GET', `/search?q=${encodeURIComponent(q)}`)); } catch (ex) { setErr(ex.message); }
  };
  return (
    <Card className="mb-4 p-4">
      <form onSubmit={run} className="flex gap-2">
        <input className={inputCls} placeholder="Search everything said in your meetings, tasks and owners" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit">Search</Button>
      </form>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      {results && (
        <div className="mt-3 space-y-2 text-sm">
          {results.transcript.length === 0 && results.tasks.length === 0 && <p className="text-slate-500">No matches.</p>}
          {results.transcript.map((r, i) => (
            <button key={`t${i}`} type="button" onClick={() => navigate(`/meetings/${r.meeting_id}`)} className="block w-full rounded-md p-2 text-left hover:bg-slate-50">
              <span className="font-medium text-slate-900">{r.title}</span>
              <span className="text-xs text-slate-500"> · {clock(r.start_sec)} · {dateText(r.meeting_date)}</span>
              <p className="text-slate-600">{r.text}</p>
            </button>
          ))}
          {results.tasks.map((r) => (
            <button key={`k${r.id}`} type="button" onClick={() => navigate(`/meetings/${r.meeting_id}`)} className="block w-full rounded-md p-2 text-left hover:bg-slate-50">
              <span className="text-xs font-medium uppercase text-violet-700">Task</span>
              <span className="ml-2 text-slate-900">{r.description}</span>
              <span className="text-xs text-slate-500"> · {r.title}{r.owner ? ` · Owner: ${r.owner}` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

export function MeetingsPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    const p = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    return api('GET', `/meetings?${p}`).then((r) => { setRows(r); setErr(''); }).catch((e) => setErr(e.message));
  }, [filters]);
  useEffect(() => { load(); }, [load]);
  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const anyFilter = Object.values(filters).some(Boolean);

  return (
    <>
      <Header title="Meetings" subtitle="Record, search and review every meeting in one place.">
        <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New meeting</Button>
      </Header>
      <SearchPanel />
      <Card className="mb-2 grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-6">
        <label className="relative block sm:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input className={`${inputCls} pl-9`} placeholder="Search titles, descriptions, participants" value={filters.q} onChange={set('q')} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Category</span>
          <select className={inputCls} value={filters.category} onChange={set('category')}>
            <option value="">All categories</option>{Object.entries(CATEGORY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Status</span>
          <select className={inputCls} value={filters.status} onChange={set('status')}>
            <option value="">All statuses</option>{Object.entries(STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">From date</span>
          <input className={inputCls} type="date" value={filters.from} onChange={set('from')} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">To date</span>
          <input className={inputCls} type="date" value={filters.to} onChange={set('to')} />
        </label>
      </Card>
      <div className="mb-4 flex h-6 justify-end">
        {anyFilter && (
          <button type="button" className="text-sm text-violet-700 hover:underline" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear filters
          </button>
        )}
      </div>
      {err && <p className="mb-4 text-sm text-red-600">{err}</p>}
      <Card className="overflow-x-auto">
        {!rows ? <p className="p-6 text-sm text-slate-500">Loading…</p>
          : rows.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">No meetings match. Create a meeting or change the filters.</p>
          : <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
                <tr><th className="px-4 py-3">Meeting</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">Category</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Recordings</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((m) => (
                  <tr key={m.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/meetings/${m.id}`)}>
                    <td className="px-4 py-3"><div className="font-medium text-slate-900">{m.title}</div>
                      {m.participants?.length > 0 && <div className="text-xs text-slate-500">{m.participants.join(', ')}</div>}</td>
                    <td className="px-4 py-3 text-slate-600">{dateText(m.meeting_date)}</td>
                    <td className="px-4 py-3 text-slate-600">{CATEGORY[m.category]}</td>
                    <td className="px-4 py-3"><Pill status={m.status} /></td>
                    <td className="px-4 py-3 text-slate-600">{m.recording_count}</td>
                  </tr>))}
              </tbody>
            </table>}
      </Card>
      {creating && <MeetingForm onCancel={() => setCreating(false)} onSaved={(m) => navigate(`/meetings/${m.id}`)} />}
    </>
  );
}

function TasksCard({ meetingId, tasks, onChange, onError }) {
  const [draft, setDraft] = useState({ description: '', owner: '', due: '' });
  const [busy, setBusy] = useState(false);
  const patch = async (t, body) => {
    try { await api('PATCH', `/meetings/${meetingId}/actions/${t.id}`, body); onChange(); } catch (e) { onError(e.message); }
  };
  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('POST', `/meetings/${meetingId}/actions`, draft);
      setDraft({ description: '', owner: '', due: '' });
      onChange();
    } catch (ex) { onError(ex.message); } finally { setBusy(false); }
  };
  const remove = async (t) => {
    if (!window.confirm('Delete this task?')) return;
    try { await api('DELETE', `/meetings/${meetingId}/actions/${t.id}`); onChange(); } catch (e) { onError(e.message); }
  };
  return (
    <Card className="p-5 lg:col-span-2">
      <h2 className="mb-1 font-medium text-slate-900">Tasks</h2>
      <p className="mb-4 text-xs text-slate-500">Suggested tasks show the moment in the recording they came from. Check owners and deadlines before acting.</p>
      {tasks.length === 0 ? <p className="text-sm text-slate-400">No tasks yet.</p> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {tasks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-start gap-3 py-3">
              <input type="checkbox" className="mt-1" aria-label="Mark done" checked={t.status === 'done'}
                onChange={(e) => patch(t, { status: e.target.checked ? 'done' : 'open' })} />
              <div className="min-w-0 flex-1">
                <div className={t.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-800'}>
                  {t.description}<TimeChip sec={t.source_start} seq={t.source_seq} />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                  <label>Owner <input className="ml-1 rounded border border-slate-300 px-2 py-0.5" defaultValue={t.owner || ''}
                    onBlur={(e) => e.target.value.trim() !== (t.owner || '') && patch(t, { owner: e.target.value.trim() })} /></label>
                  <label>Deadline <input className="ml-1 rounded border border-slate-300 px-2 py-0.5" defaultValue={t.due_text || ''}
                    onBlur={(e) => e.target.value.trim() !== (t.due_text || '') && patch(t, { due: e.target.value.trim() })} /></label>
                  <span>{t.origin === 'ai' ? 'Suggested' : 'Added by you'}</span>
                </div>
              </div>
              {t.origin === 'manual' && <button type="button" onClick={() => remove(t)} className="text-xs text-red-600 hover:underline">Delete</button>}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="mt-4 grid gap-2 border-t border-slate-100 pt-4 sm:grid-cols-4">
        <input className={`${inputCls} sm:col-span-2`} required placeholder="New task" value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        <input className={inputCls} placeholder="Owner" value={draft.owner} onChange={(e) => setDraft({ ...draft, owner: e.target.value })} />
        <input className={inputCls} placeholder="Deadline" value={draft.due} onChange={(e) => setDraft({ ...draft, due: e.target.value })} />
        <div className="flex justify-end sm:col-span-4"><Button type="submit" disabled={busy}>Add task</Button></div>
      </form>
    </Card>
  );
}

export function MeetingDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [m, setM] = useState(null);
  const [prov, setProv] = useState(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(() => Promise.all([api('GET', `/meetings/${id}`), api('GET', '/processing/status')])
    .then(([a, b]) => { setM(a); setProv(b); }).catch((e) => setErr(e.message)), [id]);
  useEffect(() => { load(); }, [load]);

  // Live updates: while a meeting is still being processed, refresh every 4 seconds.
  // The check stops by itself once processing finishes or fails.
  const processing = Boolean(m) && (
    ['queued', 'transcribing', 'transcribed', 'analysing'].includes(m.status)
    || ['queued', 'transcribing'].includes(m.job?.state)
  ) && m.status !== 'failed' && m.status !== 'completed';
  useEffect(() => {
    if (!processing) return undefined;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [processing, load]);

  const upload = async (file) => {
    setErr('');
    if (!consent) { setErr('Confirm that every participant has agreed to this recording before you upload.'); return; }
    const ext = file.name.split('.').pop().toLowerCase();
    setBusy(true);
    try {
      const res = await fetch(`/api/meetings/${id}/recording`, {
        method: 'POST',
        headers: {
          'Content-Type': MIME[ext] || file.type,
          'x-file-name': encodeURIComponent(file.name),
          'x-consent': 'confirmed',
          Authorization: `Bearer ${session.get()}`,
        },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const download = async (r) => {
    const res = await fetch(`/api/meetings/${id}/recordings/${r.id}`, { headers: { Authorization: `Bearer ${session.get()}` } });
    if (!res.ok) return setErr('The recording could not be downloaded.');
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: r.original_name });
    a.click();
    URL.revokeObjectURL(url);
  };
  const remove = async () => {
    if (!window.confirm('Delete this meeting and its recordings? This cannot be undone.')) return;
    try { await api('DELETE', `/meetings/${id}`); navigate('/meetings'); } catch (e) { setErr(e.message); }
  };

  const exportCsv = async () => {
    const res = await fetch(`/api/meetings/${id}/export.csv`, { headers: { Authorization: `Bearer ${session.get()}` } });
    if (!res.ok) return setErr('The export could not be created.');
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: `vespera-tasks-${id}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const fetchReport = async (path) => {
    const res = await fetch(`/api/meetings/${id}/${path}`, { headers: { Authorization: `Bearer ${session.get()}` } });
    if (!res.ok) throw new Error('The report could not be created.');
    return res;
  };
  const printReport = async () => {
    setErr('');
    try {
      const html = await (await fetchReport('report.html')).text();
      const w = window.open('', '_blank');
      if (!w) return setErr('Allow pop-ups for this site to open the report.');
      w.document.open();
      w.document.write(html);
      w.document.close();
      setTimeout(() => w.print(), 400);
    } catch (e) { setErr(e.message); }
  };
  const downloadWord = async () => {
    setErr('');
    try {
      const url = URL.createObjectURL(await (await fetchReport('report.doc')).blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: `vespera-report-${id}.doc` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setErr(e.message); }
  };

  const removeRecording = async (r) => {
    if (!window.confirm(`Remove "${r.original_name}"? Its transcript, summary and AI-suggested tasks will be cleared. Tasks you added are kept.`)) return;
    setErr('');
    try { await api('DELETE', `/meetings/${id}/recordings/${r.id}`); load(); } catch (e) { setErr(e.message); }
  };

  const retry = async () => {
    setErr('');
    try { await api('POST', `/meetings/${id}/retry`); load(); } catch (e) { setErr(e.message); }
  };
  if (!m) return <p className="text-sm text-slate-500">{err || 'Loading…'}</p>;
  const job = m.job;
  const processingNote = job?.stage === 'analyse' && job?.state === 'queued' && job?.last_error
    ? job.last_error
    : m.status === 'completed' ? 'Summary, decisions and action items are ready below.'
    : m.status === 'transcribed' || job?.state === 'completed'
    ? 'Transcript is ready. Summaries, decisions and action items are the next processing step.'
    : m.status === 'transcribing' || job?.state === 'transcribing'
      ? 'Transcribing now. Long recordings can take several minutes.'
      : m.status === 'failed'
        ? 'Transcription failed. You can retry it below.'
        : job && job.state === 'queued'
          ? (prov?.transcription?.configured
            ? 'Waiting in the processing queue.'
            : 'Your recording is saved safely. Transcription is not configured yet, so processing has not started.')
          : 'Upload a recording to start processing.';

  const a = m.analysis;
  const workflowData = a && Object.keys(a.sector_fields || {}).length ? a.sector_fields : a?.legal;

  return (
    <>
      <Link to="/meetings" className="mb-4 inline-block text-sm text-violet-700">← All meetings</Link>
      <Header title={m.title} subtitle={`${dateText(m.meeting_date)} · ${CATEGORY[m.category]}`}>
        <Pill status={m.status} />
        {(m.action_items || []).length > 0 && <Button variant="ghost" onClick={exportCsv}><Download className="h-4 w-4" />Export tasks (CSV)</Button>}
        {a && <Button variant="ghost" onClick={printReport}>Print / save as PDF</Button>}
        {a && <Button variant="ghost" onClick={downloadWord}>Download Word</Button>}
      </Header>
      {err && <p className="mb-4 text-sm text-red-600">{err}</p>}
      <div className="grid max-w-5xl gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-2 font-medium text-slate-900">Meeting details</h2>
          <p className="text-sm text-slate-600">{m.description || 'No description added.'}</p>
          <p className="mt-3 text-sm"><span className="text-slate-500">Participants: </span>{m.participants?.length ? m.participants.join(', ') : 'None listed'}</p>
        </Card>
        <Card className="p-5">
          <h2 className="mb-2 flex items-center gap-2 font-medium text-slate-900"><Clock className="h-4 w-4 text-violet-700" />Processing</h2>
          <p className="text-sm text-slate-600">{processingNote}</p>
          {processing && <p className="mt-2 text-xs text-violet-700">Updating automatically…</p>}
          {m.job?.last_error && <p className="mt-2 text-sm text-red-600">{m.job.last_error}</p>}
          {m.status === 'failed' && <Button variant="ghost" className="mt-3" onClick={retry}>Retry transcription</Button>}
        </Card>
        {m.transcript?.length > 0 && (
          <Card className="p-5 lg:col-span-2">
            <h2 className="mb-3 font-medium text-slate-900">Transcript</h2>
            <ol className="space-y-4 text-sm">
              {m.transcript.map((seg) => (
                <li key={seg.seq} id={`seg-${seg.seq}`} className="flex scroll-mt-24 gap-4">
                  <span className="w-14 shrink-0 pt-0.5 font-mono text-xs text-violet-700">{clock(seg.start_sec)}</span>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-slate-500">{seg.speaker ? speakerName(seg.speaker) : 'Speaker'}</div>
                    <p className="mt-0.5 leading-relaxed text-slate-800">{seg.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-xs text-slate-500">Timestamps and speaker labels come from the transcription service. Review before relying on them.</p>
          </Card>
        )}
        {a && (
          <Card className="p-5 lg:col-span-2">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-medium text-slate-900">AI meeting intelligence</h2>
              <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800">Draft for review</span>
            </div>
            <p className="text-xs text-slate-500">Generated by AI from the transcript. Check each point against the recording before you rely on it. This is not legal, medical or financial advice.</p>
            {a.sector && <p className="mt-3 text-xs font-medium uppercase tracking-wide text-violet-700">Workflow: {SECTOR_LABELS[a.sector] || 'General'}</p>}
            <Block title="Executive summary"><p className="text-sm leading-relaxed text-slate-700">{a.executive_summary}</p></Block>
            <Block title="Detailed summary"><p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">{a.detailed_summary}</p></Block>
            <Block title="Key points">
              <ul className="space-y-1 text-sm text-slate-700">{(a.key_points || []).map((k, i) => <li key={i}>{k.text}<TimeChip sec={k.start_sec} seq={k.source_seq} /></li>)}</ul>
            </Block>
            <Block title="Decisions">
              <ul className="space-y-1 text-sm text-slate-700">{(a.decisions || []).map((d, i) => <li key={i}>{d.text}<TimeChip sec={d.start_sec} seq={d.source_seq} /></li>)}</ul>
              {!(a.decisions || []).length && <p className="text-sm text-slate-400">No decisions stated.</p>}
            </Block>
            <Block title="Possible conflicts (check both statements)">
              {(a.flags || []).length === 0 ? <p className="text-sm text-slate-400">None flagged.</p> : (
                <ul className="space-y-2 text-sm text-slate-700">
                  {a.flags.map((fl, i) => (
                    <li key={i}>{fl.summary}<TimeChip sec={fl.start_a} seq={fl.seq_a} /><TimeChip sec={fl.start_b} seq={fl.seq_b} /></li>
                  ))}
                </ul>
              )}
            </Block>
            <Block title="Follow-ups"><Bullets items={a.follow_ups} /></Block>
            <Block title="Open questions"><Bullets items={a.open_questions} /></Block>
            <Block title="Risks and concerns"><Bullets items={a.risks} /></Block>
            <SectorFields data={workflowData} />
            <Block title="Points for professional review"><Bullets items={a.review_notes} /></Block>
          </Card>
        )}
        <TasksCard meetingId={m.id} tasks={m.action_items || []} onChange={load} onError={setErr} />
        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-3 font-medium text-slate-900">Recording</h2>
          <label className="mb-3 flex items-start gap-2 rounded-md bg-violet-50 p-3 text-sm text-slate-700">
            <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span className="flex gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-700" />
              I confirm every participant has agreed to this recording, and I'm allowed to upload it.</span>
          </label>
          <input type="file" disabled={busy} accept=".mp3,.wav,.m4a,.mp4,.webm" onChange={(e) => e.target.files[0] && upload(e.target.files[0])}
            className="block w-full text-sm text-slate-600 file:mr-4 file:rounded-md file:border-0 file:bg-violet-600 file:px-4 file:py-2 file:text-white hover:file:bg-violet-700" />
          <p className="mt-2 text-xs text-slate-500">MP3, WAV, M4A, MP4 or WebM. Stored privately for this organisation only.</p>
          {m.recordings.length > 0 && (
            <ul className="mt-4 divide-y divide-slate-100">
              {m.recordings.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                  <span>{r.original_name} <span className="text-slate-500">· {sizeText(r.bytes)}</span></span>
                  <div className="flex gap-2"><Button variant="ghost" onClick={() => download(r)}><Download className="h-4 w-4" />Download</Button><Button variant="ghost" onClick={() => removeRecording(r)}><Trash2 className="h-4 w-4" />Remove</Button></div>
                </li>))}
            </ul>)}
        </Card>
      </div>
      <div className="mt-8 max-w-5xl border-t border-slate-200 pt-4">
        <Button variant="danger" onClick={remove}><Trash2 className="h-4 w-4" />Delete meeting</Button>
      </div>
    </>
  );
}
