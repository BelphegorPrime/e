import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'e-theme';

function readStoredTheme(): Theme {
  const stored = globalThis.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system'
    ? stored
    : 'system';
}

function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'system') {
    return globalThis.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return theme;
}

/**
 * Dark mode state. Defaults to the OS preference ('system') and
 * persists the chosen mode in localStorage so the class survives
 * reloads. `.dark` on the document root flips the CSS variable
 * palette defined in index.css.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(readStoredTheme())
  );

  useEffect(() => {
    setResolved(resolveTheme(theme));
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  // Follow OS preference changes while in 'system' mode.
  useEffect(() => {
    if (theme !== 'system') return;
    const media = globalThis.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(media.matches ? 'dark' : 'light');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  useEffect(() => {
    globalThis.document.documentElement.classList.toggle(
      'dark',
      resolved === 'dark'
    );
  }, [resolved]);

  return { theme, resolved, setTheme };
}
