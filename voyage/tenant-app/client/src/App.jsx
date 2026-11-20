import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { LayoutDashboard, Mic, History, Settings, LogOut, Sparkles } from 'lucide-react';
import { api, session } from './api.js';
import { DEFAULT_THEME, ThemeContext } from './theme.js';
import { LoginPage, SettingsPage } from './pages.jsx';
import { OverviewPage, MeetingsPage, MeetingDetailPage } from './Vespera.jsx';
import UpdatesPage from './Updates.jsx';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/meetings', label: 'Meetings', icon: Mic },
  { to: '/updates', label: 'Updates', icon: History },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function App() {
  const [user, setUser] = useState(null);
  const [company, setCompany] = useState('');
  const [booting, setBooting] = useState(true);
  const [theme, setTheme] = useState(DEFAULT_THEME);

  useEffect(() => {
    api('GET', '/theme').then(setTheme).catch(() => {});
    const onExpired = () => setUser(null);
    window.addEventListener('voyage:logout', onExpired);
    if (session.get()) {
      api('GET', '/auth/me')
        .then((d) => setUser(d.user))
        .catch(() => session.clear())
        .finally(() => setBooting(false));
    } else {
      setBooting(false);
    }
    return () => window.removeEventListener('voyage:logout', onExpired);
  }, []);

  useEffect(() => {
    if (user) api('GET', '/settings').then((s) => setCompany(s.company.name)).catch(() => {});
  }, [user]);

  if (booting) return null;

  const value = { theme, setTheme };

  if (!user) {
    return (
      <ThemeContext.Provider value={value}>
        <LoginPage onLogin={setUser} />
      </ThemeContext.Provider>
    );
  }

  const logout = () => {
    session.clear();
    setUser(null);
  };

  return (
    <ThemeContext.Provider value={value}>
      <div className="flex min-h-screen flex-col bg-slate-50 md:flex-row">
        <aside className="border-b border-white/5 bg-[#0c1330] text-slate-200 md:flex md:w-60 md:shrink-0 md:flex-col md:border-b-0">
          <div className="flex items-center gap-3 px-5 py-5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-600/20">
              <Sparkles className="h-5 w-5 text-violet-300" />
            </div>
            <div className="min-w-0">
              <div className="font-semibold tracking-tight text-white">{theme.app_name}</div>
              <div className="truncate text-xs text-slate-400">
                {company || 'From conversations to clarity'}
              </div>
            </div>
          </div>

          <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:overflow-visible md:pb-0">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                    isActive ? 'bg-violet-600 text-white' : 'text-slate-300 hover:bg-white/10 hover:text-white'
                  }`
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="hidden px-3 pb-4 md:block">
            <button
              onClick={logout}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </aside>

        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto max-w-6xl">
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/meetings" element={<MeetingsPage />} />
              <Route path="/meetings/:id" element={<MeetingDetailPage />} />
              <Route path="/updates" element={<UpdatesPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </main>
      </div>
    </ThemeContext.Provider>
  );
}