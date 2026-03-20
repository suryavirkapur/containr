import { createEffect, createSignal, onCleanup, type JSX } from 'solid-js';

type Theme = 'light' | 'dark' | 'system';

export function createTheme() {
  const [theme, setTheme] = createSignal<Theme>('system');
  const [resolvedTheme, setResolvedTheme] = createSignal<'light' | 'dark'>('light');

  const applyTheme = (t: 'light' | 'dark') => {
    setResolvedTheme(t);
    if (t === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  };

  const updateResolvedTheme = () => {
    const t = theme();
    if (t === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      applyTheme(prefersDark ? 'dark' : 'light');
    } else {
      applyTheme(t);
    }
  };

  createEffect(() => {
    const stored = localStorage.getItem('containr-theme') as Theme | null;
    if (stored && ['light', 'dark', 'system'].includes(stored)) {
      setTheme(stored);
    }
    updateResolvedTheme();
  });

  createEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => updateResolvedTheme();
    mediaQuery.addEventListener('change', handler);
    onCleanup(() => mediaQuery.removeEventListener('change', handler));
  });

  const setThemeWithPersistence = (t: Theme) => {
    setTheme(t);
    localStorage.setItem('containr-theme', t);
    updateResolvedTheme();
  };

  const toggleTheme = () => {
    const current = resolvedTheme();
    setThemeWithPersistence(current === 'dark' ? 'light' : 'dark');
  };

  return {
    theme,
    resolvedTheme,
    setTheme: setThemeWithPersistence,
    toggleTheme,
  };
}

export const ThemeContext = createTheme();
