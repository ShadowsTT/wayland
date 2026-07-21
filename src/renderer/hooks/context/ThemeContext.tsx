/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// context/ThemeContext.tsx - Unified Theme Management Context
import type { PropsWithChildren } from 'react';
import React, { createContext, useContext } from 'react';
import type { ResolvedTheme, Theme, ThemePreference } from '@renderer/hooks/system/useTheme';
import useTheme from '@renderer/hooks/system/useTheme';
import type { ColorScheme } from '@renderer/hooks/ui/useColorScheme';
import useColorScheme from '@renderer/hooks/ui/useColorScheme';
import useFontScale from '@renderer/hooks/ui/useFontScale';

/**
 * Theme context value interface.
 * Separates light/dark mode from color schemes.
 */
interface ThemeContextValue {
  // Resolved theme - concrete value currently applied to the DOM.
  // Use this for visual checks (e.g. `theme === 'dark' ? ... : ...`).
  theme: Theme;

  // User's stored theme preference ('light' | 'dark' | 'system').
  // Use this in the theme switcher to highlight the active button.
  themePreference: ThemePreference;

  // Setter accepts any preference - passing 'system' enables auto-follow
  // via `prefers-color-scheme`.
  setTheme: (preference: ThemePreference) => Promise<void>;

  // Color scheme
  colorScheme: ColorScheme;
  setColorScheme: (scheme: ColorScheme) => Promise<void>;

  // Font scaling
  fontScale: number;
  setFontScale: (scale: number) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Theme provider component.
 * Manages both light/dark mode and color schemes.
 */
export const ThemeProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [theme, setTheme, themePreference] = useTheme();
  const [colorScheme, setColorScheme] = useColorScheme();
  const [fontScale, setFontScale] = useFontScale();

  return (
    <ThemeContext.Provider
      value={{ theme, themePreference, setTheme, colorScheme, setColorScheme, fontScale, setFontScale }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

/**
 * Hook to access theme context.
 * @throws {Error} If used outside of ThemeProvider
 */
export const useThemeContext = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useThemeContext must be used within ThemeProvider');
  }
  return context;
};

/**
 * Non-throwing resolved-theme read. Returns the provider's theme when present,
 * otherwise falls back to the DOM `data-theme` attribute (the pre-context
 * behaviour). Use this in components that can be rendered in isolation without
 * the app's ThemeProvider — e.g. CodeBlock, which unit tests mount directly.
 * `useThemeContext()` throws outside a provider and would break those tests.
 */
export const useResolvedThemeSafe = (): Theme => {
  const context = useContext(ThemeContext);
  if (context) return context.theme;
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
  }
  return 'light';
};

export type { ResolvedTheme, Theme, ThemePreference };
