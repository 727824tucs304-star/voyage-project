import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Button, Card } from './pages.jsx';

const inputCls = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600';
const dateText = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export default function TeamPage() {
  const [users, setUsers] = useState(null);
  const [meId, setMeId] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'member' });
  const [msg, setMsg] = useState({ text: '', bad: false });
  const [busy, setBusy] = useState(false);

  const load = () => Promise.all([api('GET', '/users'), api('GET', '/auth/me')])
    .then(([list, who]) => { setUsers(list); setMeId(who.user.id); })
    .catch((e) => setMsg({ text: e.message, bad: true }));
  useEffect(() => { load(); }, []);

  const me = users?.find((u) => u.id === meId);
  const isAdmin = me?.role === 'admin';
  const say = (text, bad = false) => setMsg({ text, bad });

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('POST', '/users', form);
      setForm({ name: '', email: '', password: '', role: 'member' });
      say('Team member added. Share their email and password with them securely.');
      load();
    } catch (err) { say(err.message, true); } finally { setBusy(false); }
  };

  const resetPassword = async (u) => {
    const password = window.prompt(`New password for ${u.name} (at least 8 characters):`);
    if (!password) return;
    try {
      await api('PUT', `/users/${u.id}/password`, { password });
      say(`Password changed for ${u.name}. Their existing sign-in stays valid until it expires (12 hours).`);
    } catch (err) { say(err.message, true); }
  };

  const remove = async (u) => {
    if (!window.confirm(`Remove ${u.name} from this workspace? They will no longer be able to sign in.`)) return;
    try {
      await api('DELETE', `/users/${u.id}`);
      say(`${u.name} was removed.`);
      load();
    } catch (err) { say(err.message, true); }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Team</h1>
        <p className="text-sm text-slate-500">People who can sign in to this workspace. Administrators can add, reset and remove team members.</p>
      </div>

      {msg.text && <p className={`text-sm ${msg.bad ? 'text-red-600' : 'text-emerald-700'}`}>{msg.text}</p>}

      <Card className="overflow-x-auto p-0">
        {!users ? <p className="p-6 text-sm text-slate-500">Loading…</p> : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
              <tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Email</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Added</th><th className="px-4 py-3"></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3 font-medium text-slate-900">{u.name}{u.id === meId && <span className="ml-2 text-xs text-violet-700">(you)</span>}</td>
                  <td className="px-4 py-3 text-slate-600">{u.email}</td>
                  <td className="px-4 py-3 text-slate-600">{u.role === 'admin' ? 'Administrator' : 'Member'}</td>
                  <td className="px-4 py-3 text-slate-600">{dateText(u.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {isAdmin && u.id !== meId && (
                      <span className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => resetPassword(u)}>Reset password</Button>
                        <Button variant="danger" onClick={() => remove(u)}>Remove</Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {isAdmin && (
        <Card className="p-5">
          <h2 className="mb-3 font-medium text-slate-900">Add a team member</h2>
          <form onSubmit={add} className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm"><span className="mb-1 block font-medium">Name</span>
              <input className={inputCls} required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="block text-sm"><span className="mb-1 block font-medium">Email</span>
              <input className={inputCls} type="email" required maxLength={254} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label className="block text-sm"><span className="mb-1 block font-medium">Temporary password</span>
              <input className={inputCls} type="password" required minLength={8} maxLength={200} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
            <label className="block text-sm"><span className="mb-1 block font-medium">Role</span>
              <select className={inputCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="member">Member</option>
                <option value="admin">Administrator</option>
              </select></label>
            <div className="flex justify-end sm:col-span-2"><Button type="submit" disabled={busy}>Add team member</Button></div>
          </form>
        </Card>
      )}
    </div>
  );
}
