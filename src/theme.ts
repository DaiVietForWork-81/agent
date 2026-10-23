// src/theme.ts — Orbit theme system, consuming OpenCode's official desktop-theme JSON files (MIT).
// Source: github.com/anomalyco/opencode packages/ui/src/theme/themes/*.json — vendored in public/themes/.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_THEME_ID = 'oc-2';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEMES_DIR = path.join(ROOT, 'public', 'themes');

export interface DesktopPalette {
  neutral: string; ink: string; primary: string; accent: string;
  success: string; warning: string; error: string; info: string;
  diffAdd: string; diffDelete: string;
}

export interface DesktopThemeMode {
  palette: DesktopPalette;
  overrides?: Record<string, string>;
}

export interface DesktopThemeFile {
  $schema?: string;
  name: string;
  id: string;
  light?: DesktopThemeMode;
  dark: DesktopThemeMode;
}

export interface ResolvedTheme {
  id: string;
  label: string;
  dark: boolean;
  colors: {
    bg: string; surface: string; elevated: string;
    text: string; textSecondary: string; textMuted: string; textDisabled: string;
    accent: string; accentHover: string;
    success: string; warning: string; danger: string;
    border: string; borderMuted: string;
    diffAdd: string; diffDelete: string;
    syntax: Record<string, string>;
  };
  ansi: { accent: [number, number, number]; success: [number, number, number]; warning: [number, number, number]; danger: [number, number, number]; secondary: [number, number, number] };
}

export async function listThemeFiles(): Promise<DesktopThemeFile[]> {
  try {
    const files = (await fs.readdir(THEMES_DIR)).filter((f) => f.endsWith('.json'));
    const out: DesktopThemeFile[] = [];
    for (const f of files) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(THEMES_DIR, f), 'utf8')) as DesktopThemeFile;
        if (parsed?.name && parsed?.dark?.palette) out.push(parsed);
      } catch { /* skip malformed */ }
    }
    return out.sort((a, b) => (a.id === DEFAULT_THEME_ID ? -1 : b.id === DEFAULT_THEME_ID ? 1 : a.name.localeCompare(b.name)));
  } catch {
    return [];
  }
}

export async function getTheme(id: string | undefined): Promise<ResolvedTheme> {
  const themes = await listThemeFiles();
  const t = themes.find((x) => x.id === id) ?? themes.find((x) => x.id === DEFAULT_THEME_ID) ?? themes[0];
  if (!t) {
    // disk themes missing — hard fallback to classic opencode palette
    return fallbackTheme();
  }
  return resolve(t);
}

export async function getThemeFile(id: string | undefined): Promise<DesktopThemeFile | undefined> {
  const themes = await listThemeFiles();
  return themes.find((x) => x.id === id) ?? themes.find((x) => x.id === DEFAULT_THEME_ID) ?? themes[0];
}

function mix(ink: string, neutral: string, pct: number): string {
  // emit as CSS color-mix so the browser resolves it with theme colors
  return `color-mix(in srgb, ${ink} ${pct}%, ${neutral})`;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function resolve(t: DesktopThemeFile, preferLight = false): ResolvedTheme {
  const mode = preferLight && t.light ? t.light : t.dark;
  const p = mode.palette;
  const colors = {
    bg: p.neutral,
    surface: mix(p.ink, p.neutral, 5),
    elevated: mix(p.ink, p.neutral, 12),
    text: p.ink,
    textSecondary: mix(p.ink, p.neutral, 82),
    textMuted: mix(p.ink, p.neutral, 60),
    textDisabled: mix(p.ink, p.neutral, 40),
    accent: p.primary,
    accentHover: mix(p.primary, p.neutral, 80),
    success: p.success,
    warning: p.warning,
    danger: p.error,
    border: mix(p.ink, p.neutral, 22),
    borderMuted: mix(p.ink, p.neutral, 12),
    diffAdd: p.diffAdd,
    diffDelete: p.diffDelete,
    syntax: mode.overrides ?? {},
  };
  return {
    id: t.id,
    label: t.name,
    dark: true,
    colors,
    ansi: { accent: rgb(p.primary), success: rgb(p.success), warning: rgb(p.warning), danger: rgb(p.error), secondary: rgb(p.info) },
  };
}

function fallbackTheme(): ResolvedTheme {
  return {
    id: 'fallback',
    label: 'Fallback',
    dark: true,
    colors: {
      bg: '#0c0c0e', surface: '#161618', elevated: '#1c1c1f',
      text: '#ffffff', textSecondary: '#c7c7cc', textMuted: '#a1a1a6', textDisabled: '#68686f',
      accent: '#007aff', accentHover: '#0056b3',
      success: '#30d158', warning: '#ff9f0a', danger: '#ff453a',
      border: '#38383a', borderMuted: '#2c2c2e', diffAdd: '#30d158', diffDelete: '#ff453a', syntax: {},
    },
    ansi: { accent: [0, 122, 255], success: [48, 209, 88], warning: [255, 159, 10], danger: [255, 69, 58], secondary: [199, 199, 204] },
  };
}

/** Generate :root CSS overrides from an OpenCode desktop theme (dark palette; light if present via media query). */
export function generateThemeCss(t: DesktopThemeFile): string {
  const block = (mode: DesktopThemeMode): string => {
    const p = mode.palette;
    return `  --color-bg: ${p.neutral};
  --color-bg-surface: ${mix(p.ink, p.neutral, 5)};
  --color-bg-elevated: ${mix(p.ink, p.neutral, 12)};
  --color-text: ${p.ink};
  --color-text-secondary: ${mix(p.ink, p.neutral, 82)};
  --color-text-muted: ${mix(p.ink, p.neutral, 60)};
  --color-text-disabled: ${mix(p.ink, p.neutral, 40)};
  --color-accent: ${p.primary};
  --color-accent-hover: ${mix(p.primary, p.neutral, 80)};
  --color-success: ${p.success};
  --color-warning: ${p.warning};
  --color-danger: ${p.error};
  --color-border: ${mix(p.ink, p.neutral, 22)};
  --color-border-muted: ${mix(p.ink, p.neutral, 12)};
  --color-diff-add: ${p.diffAdd};
  --color-diff-delete: ${p.diffDelete};
  color-scheme: dark;`;
  };
  const syntaxVars = (mode: DesktopThemeMode): string =>
    Object.entries(mode.overrides ?? {}).map(([k, v]) => `  --syntax-${k.replace('syntax-', '')}: ${v};`).join('\n');
  let css = `/* theme: ${t.name} (${t.id}) — vendored from opencode desktop-theme (MIT) */\n:root {\n${block(t.dark)}\n${syntaxVars(t.dark)}\n}\n`;
  if (t.light) {
    css += `\n@media (prefers-color-scheme: light) {\n:root {\n${block(t.light).replace('color-scheme: dark;', 'color-scheme: light;')}\n${syntaxVars(t.light)}\n}\n}\n`;
  }
  return css;
}

export function ansiFor(resolved: ResolvedTheme) {
  const wrap = (rgbTuple: [number, number, number]) =>
    (s: string) => `\x1b[38;2;${rgbTuple[0]};${rgbTuple[1]};${rgbTuple[2]}m${s}\x1b[0m`;
  return {
    accent: wrap(resolved.ansi.accent),
    success: wrap(resolved.ansi.success),
    warning: wrap(resolved.ansi.warning),
    danger: wrap(resolved.ansi.danger),
    secondary: wrap(resolved.ansi.secondary),
  };
}
