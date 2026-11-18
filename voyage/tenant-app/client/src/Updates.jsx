import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { api } from './api.js';
import { Card } from './pages.jsx';

const KIND = { deploy: 'Update', rollback: 'Rolled back' };
const fmt = (d) => new Date(d).toLocaleString();

export default function UpdatesPage() {
  const [items, setItems] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api('GET', '/releases').then(setItems).catch((e) => setErr(e.message));
  }, []);
  return (
    <>
      <h1 className="mb-6 flex items-center gap-2 text-2xl font-semibold text-slate-900">
        <History className="h-6 w-6" />
        Updates
      </h1>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <Card className="max-w-3xl">
        {!items ? (
          <p className="p-6 text-sm text-slate-500">Loading…</p>
        ) : items.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">No updates yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((r) => (
              <li key={r.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-slate-900">{fmt(r.released_at)}</span>
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                    {KIND[r.kind] || r.kind} · {r.version}
                  </span>
                  {r.commit_hash && <code className="text-xs text-slate-500">{r.commit_hash.slice(0, 7)}</code>}
                </div>
                <p className="mt-1 text-slate-700">{r.message}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
