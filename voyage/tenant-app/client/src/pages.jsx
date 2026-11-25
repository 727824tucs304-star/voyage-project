import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Pencil, Trash2, Save } from 'lucide-react';
import { api, session } from './api.js';
import { useTheme, BUTTON_STYLES } from './theme.js';

const TRIP_STATUSES = ['planned', 'ongoing', 'completed', 'cancelled'];
const EVENT_CATEGORIES = ['transport', 'accommodation', 'activity', 'meal', 'other'];
const EXPENSE_CATEGORIES = ['transport', 'accommodation', 'food', 'activities', 'shopping', 'other'];

export const money = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(n) || 0);
const daysUntil = (d) => Math.max(0, Math.round((new Date(`${d}T00:00:00`) - new Date(new Date().toDateString())) / 86400000));
const label = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
export const fmtDate = (d) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const opts = (list) => list.map((v) => ({ value: v, label: label(v) }));
const inputCls =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

/* ---------- UI primitives ---------- */

export function Card({ children, className = '' }) {
  return <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>;
}

export function Button({ variant = 'primary', className = '', ...props }) {
  const { theme } = useTheme();
  const styles = {
    primary: BUTTON_STYLES[theme.button_color] || BUTTON_STYLES.blue,
    ghost: 'border border-slate-200 text-slate-700 hover:bg-slate-50',
    danger: 'text-red-600 hover:bg-red-50',
  };
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50 ${styles[variant]} ${className}`}
      {...props}
    />
  );
}

function PageHeader({ title, children }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function ErrorText({ children }) {
  return children ? <p className="text-sm text-red-600">{children}</p> : null;
}

function Empty({ children }) {
  return <p className="p-6 text-center text-sm text-slate-500">{children}</p>;
}

function StatusBadge({ status }) {
  const styles = {
    planned: 'bg-blue-50 text-blue-700',
    ongoing: 'bg-amber-50 text-amber-700',
    completed: 'bg-emerald-50 text-emerald-700',
    cancelled: 'bg-slate-100 text-slate-600',
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] || ''}`}>{label(status)}</span>;
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-lg bg-white p-5 shadow-xl sm:max-w-lg sm:rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-slate-900">{title}</h2>
        {children}
      </div>
    </div>
  );
}

// Loads a list endpoint; reload with load().
function useApi(url) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    if (!url) {
      setData([]);
      return Promise.resolve();
    }
    return api('GET', url)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(e.message));
  }, [url]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  return { data, error, load };
}

/* ---------- Generic resource CRUD ---------- */

function FieldControl({ field, value, onChange }) {
  const common = {
    className: inputCls,
    value: value ?? '',
    required: field.required,
    onChange: (e) => onChange(e.target.value),
  };
  let control;
  if (field.type === 'textarea') {
    control = <textarea rows={3} {...common} />;
  } else if (field.type === 'select') {
    control = (
      <select {...common}>
        {field.nullable && <option value="">None</option>}
        {field.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        type={field.type || 'text'}
        step={field.step}
        min={field.min}
        maxLength={field.maxLength}
        {...common}
      />
    );
  }
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">
        {field.label}
        {field.required ? ' *' : ''}
      </span>
      {control}
    </label>
  );
}

function toPayload(fields, values) {
  const out = {};
  for (const f of fields) {
    const v = values[f.name];
    if (v === '' || v === undefined || v === null) out[f.name] = null;
    else if (f.type === 'number' || f.intValue) out[f.name] = Number(v);
    else out[f.name] = v;
  }
  return out;
}

function ResourceForm({ fields, initial, onSave, onCancel }) {
  const [values, setValues] = useState(() =>
    Object.fromEntries(fields.map((f) => [f.name, initial?.[f.name] ?? f.default ?? '']))
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave(toPayload(fields, values));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {fields.map((f) => (
        <FieldControl
          key={f.name}
          field={f}
          value={values[f.name]}
          onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))}
        />
      ))}
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          <Save className="h-4 w-4" />
          Save
        </Button>
      </div>
    </form>
  );
}

function ResourcePage({ title, listUrl, createUrl, itemPath, fields, columns, emptyText, toolbar, summary }) {
  const { data, error, load } = useApi(listUrl);
  const [editing, setEditing] = useState(null);
  const [actionError, setActionError] = useState('');

  const save = async (payload) => {
    if (editing.id) await api('PUT', `${itemPath}/${editing.id}`, payload);
    else await api('POST', createUrl, payload);
    setEditing(null);
    load();
  };

  const remove = async (row) => {
    if (!window.confirm('Delete this record? This cannot be undone.')) return;
    try {
      await api('DELETE', `${itemPath}/${row.id}`);
      load();
    } catch (e) {
      setActionError(e.message);
    }
  };

  return (
    <>
      <PageHeader title={title}>
        {toolbar}
        {createUrl && (
          <Button onClick={() => setEditing({})}>
            <Plus className="h-4 w-4" />
            Add
          </Button>
        )}
      </PageHeader>
      {summary && data && summary(data)}
      <ErrorText>{error || actionError}</ErrorText>
      <Card className="mt-4 overflow-x-auto">
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.length === 0 ? (
          <Empty>{emptyText}</Empty>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className="px-4 py-3 font-medium">
                    {c.label}
                  </th>
                ))}
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50">
                  {columns.map((c) => (
                    <td key={c.key} className="px-4 py-3 align-top text-slate-700">
                      {c.render ? c.render(row) : row[c.key] ?? '—'}
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <Button variant="ghost" className="mr-2" onClick={() => setEditing(row)}>
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button variant="danger" onClick={() => remove(row)} aria-label="Delete">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {editing && (
        <Modal title={`${editing.id ? 'Edit' : 'Add'} ${title.toLowerCase().replace(/s$/, '')}`} onClose={() => setEditing(null)}>
          <ResourceForm
            key={editing.id ?? 'new'}
            fields={fields}
            initial={editing.id ? editing : null}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
    </>
  );
}

/* ---------- Pages ---------- */

export function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = await api('POST', '/auth/login', { email, password });
      session.set(d.token);
      onLogin(d.user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-2 text-slate-900">
          <span className="text-xl font-semibold">Vespera</span>
        </div>
        <h1 className="mb-4 text-lg font-medium">Sign in</h1>
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Email</span>
            <input className={inputCls} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Password</span>
            <input className={inputCls} type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy} className="w-full justify-center">
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}

export function SettingsPage({ onCompanyChange }) {
  const [settings, setSettings] = useState(null);
  const [company, setCompany] = useState('');
  const [profile, setProfile] = useState({ name: '', email: '', password: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api('GET', '/settings')
      .then((s) => {
        setSettings(s);
        setCompany(s.company.name);
        setProfile({ name: s.admin?.name || '', email: s.admin?.email || '', password: '' });
      })
      .catch((e) => setErr(e.message));
  }, []);

  const saveCompany = async (e) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    try {
      await api('PUT', '/settings/company', { name: company });
      onCompanyChange?.(company);
      setMsg('Company details saved.');
    } catch (ex) {
      setErr(ex.message);
    }
  };

  const saveProfile = async (e) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    try {
      await api('PUT', '/settings/profile', {
        name: profile.name,
        email: profile.email,
        password: profile.password || undefined,
      });
      setProfile((p) => ({ ...p, password: '' }));
      setMsg('Profile saved.');
    } catch (ex) {
      setErr(ex.message);
    }
  };

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid max-w-3xl gap-6">
        <Card className="p-5">
          <h2 className="mb-4 font-medium text-slate-900">Company details</h2>
          <form onSubmit={saveCompany} className="space-y-4">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Company name</span>
              <input className={inputCls} required maxLength={120} value={company} onChange={(e) => setCompany(e.target.value)} />
            </label>
            <Button type="submit">
              <Save className="h-4 w-4" />
              Save company
            </Button>
          </form>
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 font-medium text-slate-900">Administrator profile</h2>
          <form onSubmit={saveProfile} className="space-y-4">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Name</span>
              <input className={inputCls} required maxLength={80} value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Email</span>
              <input className={inputCls} type="email" required value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">New password (optional, min 8)</span>
              <input className={inputCls} type="password" minLength={8} value={profile.password} onChange={(e) => setProfile({ ...profile, password: e.target.value })} />
            </label>
            <Button type="submit">
              <Save className="h-4 w-4" />
              Save profile
            </Button>
          </form>
        </Card>

        <Card className="p-5 text-sm text-slate-600">
          Application version: <strong className="text-slate-900">{settings?.version || '…'}</strong>
        </Card>

        <ErrorText>{err}</ErrorText>
        {msg && <p className="text-sm text-emerald-700">{msg}</p>}
      </div>
    </>
  );
}
