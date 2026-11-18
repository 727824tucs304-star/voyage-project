import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { LayoutDashboard, Plane, CalendarDays, MapPin, Wallet, Settings, Palette, History, LogOut, Compass } from 'lucide-react';
import { api, session } from './api.js';
import { DEFAULT_THEME, ThemeContext } from './theme.js';
import {
  LoginPage, DashboardPage, TripsPage, ItineraryPage, DestinationsPage, ExpensesPage, SettingsPage,
} from './pages.jsx';
import CustomizePage from './Customize.jsx';
import UpdatesPage from './Updates.jsx';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/trips', label: 'My Trips', icon: Plane },
  { to: '/itinerary', label: 'Itinerary', icon: CalendarDays },
  { to: '/destinations', label: 'Destinations', icon: MapPin },
  { to: '/expenses', label: 'Expenses', icon: Wallet },
  { to: '/customize', label: 'Customize', icon: Palette },
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
        <aside className="bg-[#0f1f3d] text-slate-200 md:flex md:w-60 md:shrink-0 md:flex-col">
          <div className="flex items-center gap-2 px-5 py-4 text-white">
            <Compass className="h-6 w-6 text-blue-400" />
            <div className="min-w-0">
              <div className="font-semibold">{theme.app_name}</div>
              <div className="truncate text-xs text-slate-400">{company}</div>
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:overflow-visible md:pb-0">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm ${
                    isActive ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-white/10'
                  }`
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="px-3 pb-4">
            <button
              onClick={logout}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-white/10"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </aside>

        <main className="flex-1 p-4 md:p-8">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/trips" element={<TripsPage />} />
            <Route path="/itinerary" element={<ItineraryPage />} />
            <Route path="/destinations" element={<DestinationsPage />} />
            <Route path="/expenses" element={<ExpensesPage />} />
            <Route path="/customize" element={<CustomizePage />} />
            <Route path="/updates" element={<UpdatesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </ThemeContext.Provider>
  );
}
