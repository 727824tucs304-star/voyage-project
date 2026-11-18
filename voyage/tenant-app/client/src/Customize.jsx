import { useEffect, useState } from 'react';
import { Save, Undo2 } from 'lucide-react';
import { api } from './api.js';
import { useTheme, BUTTON_STYLES, BUTTON_LABELS, BUTTON_COLORS } from './theme.js';
import { Button, Card } from './pages.jsx';

const FIELD_LABELS = { app_name: 'App name', button_color: 'Button color' };
const inputCls =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

export default function CustomizePage() {
  const { theme, setTheme } = useTheme();
  const [form, setForm] = useState(theme);
  const [history, setHistory] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const loadHistory = () => api('GET', '/theme/history').then(setHistory).catch((e) => setErr(e.message));

  useEffect(() => {
    loadHistory();
  }, []);
  useEffect(() => {
    setForm(theme);
  }, [theme]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      setTheme(await api('PUT', '/theme', form));
      setMsg('Saved. The change is live in this workspace.');
      loadHistory();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (id) => {
    if (!window.confirm('Restore the value from this history entry?')) return;
    setErr('');
    setMsg('');
    try {
      setTheme(await api('POST', `/theme/history/${id}/restore`));
      setMsg('Restored.');
      loadHistory();
    } catch (ex) {
      setErr(ex.message);
    }
  };

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold text-slate-900">Customize</h1>
      <div className="grid max-w-3xl gap-6">
        <Card className="p-5">
          <form onSubmit={save} className="space-y-5">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">App name</span>
              <input
                className={inputCls}
                required
                maxLength={40}
                value={form.app_name}
                onChange={(e) => setForm({ ...form, app_name: e.target.value })}
              />
            </label>

            <div className="text-sm">
              <span className="mb-2 block font-medium text-slate-700">Button color</span>
              <div className="flex flex-wrap gap-2">
                {BUTTON_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setForm({ ...form, button_color: c })}
                    className={`rounded-md px-3 py-2 text-sm font-medium ${BUTTON_STYLES[c]} ${
                      form.button_color === c ? 'ring-2 ring-slate-900 ring-offset-2' : ''
                    }`}
                  >
                    {BUTTON_LABELS[c]}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-slate-500">
                Preview:{' '}
                <span className={`rounded-md px-3 py-1.5 font-medium ${BUTTON_STYLES[form.button_color]}`}>Add</span>
              </p>
            </div>

            {msg && <p className="text-sm text-emerald-700">{msg}</p>}
            {err && <p className="text-sm text-red-600">{err}</p>}
            <Button type="submit" disabled={busy}>
              <Save className="h-4 w-4" />
              Save changes
            </Button>
          </form>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 font-medium text-slate-900">Change history</h2>
          {history.length === 0 ? (
            <p className="text-sm text-slate-500">No changes yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-2 font-medium">When</th>
                    <th className="font-medium">By</th>
                    <th className="font-medium">Setting</th>
                    <th className="font-medium">Change</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td className="py-2">{new Date(h.changed_at).toLocaleString()}</td>
                      <td>{h.changed_by}</td>
                      <td>{FIELD_LABELS[h.setting_key] || h.setting_key}</td>
                      <td>
                        {h.old_value ?? '—'} → {h.new_value}
                      </td>
                      <td className="text-right">
                        <Button variant="ghost" onClick={() => restore(h.id)}>
                          <Undo2 className="h-3.5 w-3.5" />
                          Restore old
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
