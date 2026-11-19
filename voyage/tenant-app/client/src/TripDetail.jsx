import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BedDouble, Plane, Phone, StickyNote, Trash2, Plus, ArrowLeft } from 'lucide-react';
import { api } from './api.js';
import { Button, Card, money, fmtDate } from './pages.jsx';

const F = (name, label, type = 'text', required = false) => ({ name, label, type, required });
const SECTIONS = {
  stay: { label: 'Stays', icon: BedDouble, hint: 'Hotel or house, check-in and check-out, booking reference',
    fields: [F('title', 'Hotel or house name', 'text', true), F('reference', 'Booking reference'),
      F('starts_on', 'Check-in', 'date'), F('ends_on', 'Check-out', 'date'), F('amount', 'Amount (₹)', 'number')] },
  transport: { label: 'Transport', icon: Plane, hint: 'Train, flight or bus, with the PNR or ticket number',
    fields: [F('title', 'Train, flight or bus (name and number)', 'text', true), F('reference', 'PNR or ticket number'),
      F('starts_on', 'Travel date', 'date'), F('time_text', 'Departure time, e.g. 06:30'), F('amount', 'Amount (₹)', 'number')] },
  contact: { label: 'Emergency contacts', icon: Phone, hint: 'Someone the crew can call in an emergency',
    fields: [F('title', 'Name', 'text', true), F('phone', 'Phone number')] },
  note: { label: 'Notes', icon: StickyNote, hint: 'Anything the crew should remember',
    fields: [F('title', 'Title', 'text', true), F('notes', 'Details')] },
};

export default function TripDetailPage() {
  const { id } = useParams();
  const [trip, setTrip] = useState(null);
  const [items, setItems] = useState([]);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(null);
  const [form, setForm] = useState({});

  const load = () => Promise.all([api('GET', `/trips/${id}`), api('GET', `/trips/${id}/details`)])
    .then(([t, d]) => { setTrip(t); setItems(d); })
    .catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);

  const save = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      await api('POST', `/trips/${id}/details`, { ...form, kind: adding });
      setAdding(null);
      setForm({});
      load();
    } catch (ex) {
      setErr(ex.message);
    }
  };
  const remove = async (row) => {
    if (!window.confirm('Remove this entry?')) return;
    try { await api('DELETE', `/details/${row.id}`); load(); } catch (e) { setErr(e.message); }
  };

  if (!trip) return <p className="text-sm text-slate-500">{err || 'Loading…'}</p>;
  const addSection = adding ? SECTIONS[adding] : null;
  const inputCls = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600';

  return (
    <>
      <Link to="/trips" className="mb-4 inline-flex items-center gap-1 text-sm text-teal-700"><ArrowLeft className="h-4 w-4" />All trips</Link>
      <h1 className="text-2xl font-semibold text-slate-900">{trip.title}</h1>
      <p className="mb-6 text-sm text-slate-600">
        {trip.destination_name || 'No destination'} · {fmtDate(trip.start_date)} – {fmtDate(trip.end_date)} · Budget {money(trip.budget)}
      </p>
      {err && <p className="mb-4 text-sm text-red-600">{err}</p>}
      <div className="grid max-w-4xl gap-5">
        {Object.entries(SECTIONS).map(([kind, s]) => {
          const list = items.filter((i) => i.kind === kind);
          const Icon = s.icon;
          return (
            <Card key={kind} className="p-5">
              <div className="mb-1 flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 font-medium text-slate-900"><Icon className="h-5 w-5 text-teal-700" />{s.label}</h2>
                <Button variant="ghost" onClick={() => { setAdding(kind); setForm({}); }}><Plus className="h-4 w-4" />Add</Button>
              </div>
              <p className="mb-3 text-sm text-slate-500">{s.hint}</p>
              {list.length === 0 ? <p className="text-sm text-slate-400">Nothing added yet.</p> : (
                <ul className="divide-y divide-slate-100">
                  {list.map((row) => (
                    <li key={row.id} className="flex items-start justify-between gap-4 py-3 text-sm">
                      <div>
                        <div className="font-medium text-slate-900">{row.title}</div>
                        <div className="text-slate-500">
                          {[row.reference && `Ref ${row.reference}`, row.starts_on && fmtDate(row.starts_on),
                            row.ends_on && `to ${fmtDate(row.ends_on)}`, row.time_text, row.phone,
                            row.amount != null && money(row.amount)].filter(Boolean).join(' · ')}
                        </div>
                        {row.notes && <div className="mt-1 text-slate-600">{row.notes}</div>}
                      </div>
                      <Button variant="danger" onClick={() => remove(row)} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>

      {addSection && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center" onClick={() => setAdding(null)}>
          <form onSubmit={save} onClick={(e) => e.stopPropagation()} className="w-full space-y-3 rounded-t-lg bg-white p-5 sm:max-w-md sm:rounded-lg">
            <h2 className="font-semibold text-slate-900">Add {addSection.label.toLowerCase()}</h2>
            {addSection.fields.map((f) => (
              <label key={f.name} className="block text-sm">
                <span className="mb-1 block font-medium text-slate-700">{f.label}{f.required ? ' *' : ''}</span>
                <input className={inputCls} type={f.type} required={f.required}
                  value={form[f.name] ?? ''} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })} />
              </label>
            ))}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" type="button" onClick={() => setAdding(null)}>Cancel</Button>
              <Button type="submit">Save</Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
