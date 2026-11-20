import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus, Search, Trash2, Download, ShieldCheck, Clock } from 'lucide-react';
import { api, session } from './api.js';
import { Button, Card } from './pages.jsx';

export const CATEGORY = {
  legal_intake: 'Legal client intake', internal_case: 'Internal case discussion',
  client_call: 'Client call', board: 'Board or leadership', other: 'Other',
};
export const STATUS = {
  draft: 'Draft', uploaded: 'Uploaded', queued: 'Waiting for transcription', transcribing: 'Transcribing',
  analysing: 'Analysing', completed: 'Completed', failed: 'Failed',
};
const STATUS_STYLE = {
  draft: 'bg-slate-100 text-slate-700', uploaded: 'bg-slate-100 text-slate-700', queued: 'bg-amber-50 text-amber-800',
  transcribing: 'bg-violet-50 text-violet-700', analysing: 'bg-violet-50 text-violet-700',
  completed: 'bg-emerald-50 text-emerald-700', failed: 'bg-red-50 text-red-700',
};
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm' };
const inputCls = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600';

const dateText = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const sizeText = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const durationText = (sec) => {
  const s = Math.round(Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

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
    ['Action items', 'Next phase'],
  ] : [];
  return (
    <>
      <Header title="Overview" subtitle="Meetings, processing and recent activity for your organisation." />
      <ProviderBanner status={prov} />
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
  const [form, setForm] = useState({ title: '', description: '', category: 'legal_intake', meeting_date: new Date().toISOString().slice(0, 10), participants: '' });
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

export function MeetingsPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({ q: '', category: '', status: '', from: '', to: '' });
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    const p = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    return api('GET', `/meetings?${p}`).then((r) => { setRows(r); setErr(''); }).catch((e) => setErr(e.message));
  }, [filters]);
  useEffect(() => { load(); }, [load]);
  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });

  return (
    <>
      <Header title="Meetings" subtitle="Record, search and review every meeting in one place.">
        <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New meeting</Button>
      </Header>
      <Card className="mb-4 grid gap-3 p-4 md:grid-cols-5">
        <label className="relative md:col-span-2"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input className={`${inputCls} pl-9`} placeholder="Search titles, descriptions, participants" value={filters.q} onChange={set('q')} /></label>
        <select className={inputCls} value={filters.category} onChange={set('category')}>
          <option value="">All categories</option>{Object.entries(CATEGORY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <select className={inputCls} value={filters.status} onChange={set('status')}>
          <option value="">All statuses</option>{Object.entries(STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <div className="flex gap-2">
          <input className={inputCls} type="date" aria-label="From" value={filters.from} onChange={set('from')} />
          <input className={inputCls} type="date" aria-label="To" value={filters.to} onChange={set('to')} />
        </div>
      </Card>
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

  if (!m) return <p className="text-sm text-slate-500">{err || 'Loading…'}</p>;
  const processingNote = m.job && ['queued', 'transcribing', 'analysing'].includes(m.job.state)
    ? (prov?.transcription?.configured
      ? 'Your recording is saved and queued. Transcription starts when the processing worker is enabled.'
      : 'Your recording is saved safely. Processing has not started because transcription is not configured yet.')
    : m.status === 'completed' ? 'Processing is complete.' : 'Upload a recording to start processing.';

  return (
    <>
      <Link to="/meetings" className="mb-4 inline-block text-sm text-violet-700">← All meetings</Link>
      <Header title={m.title} subtitle={`${dateText(m.meeting_date)} · ${CATEGORY[m.category]}`}>
        <Pill status={m.status} />
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
          {m.job?.last_error && <p className="mt-2 text-sm text-red-600">{m.job.last_error}</p>}
        </Card>
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
                  <Button variant="ghost" onClick={() => download(r)}><Download className="h-4 w-4" />Download</Button>
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
