import { createContext, useContext } from 'react';

export const BUTTON_STYLES = {
  blue: 'bg-blue-600 text-white hover:bg-blue-700',
  green: 'bg-green-600 text-white hover:bg-green-700',
  indigo: 'bg-indigo-600 text-white hover:bg-indigo-700',
  violet: 'bg-violet-600 text-white hover:bg-violet-700',
  rose: 'bg-rose-600 text-white hover:bg-rose-700',
  amber: 'bg-amber-500 text-white hover:bg-amber-600',
  teal: 'bg-teal-600 text-white hover:bg-teal-700',
  slate: 'bg-slate-700 text-white hover:bg-slate-800',
};

export const BUTTON_COLORS = Object.keys(BUTTON_STYLES);
export const BUTTON_LABELS = {
  blue: 'Blue', green: 'Green', indigo: 'Indigo', violet: 'Violet',
  rose: 'Rose', amber: 'Amber', teal: 'Teal', slate: 'Slate',
};

export const DEFAULT_THEME = { app_name: 'Voyage', button_color: 'blue' };

export const ThemeContext = createContext({ theme: DEFAULT_THEME, setTheme: () => {} });
export const useTheme = () => useContext(ThemeContext);
