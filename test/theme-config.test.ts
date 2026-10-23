// test/theme-config.test.ts — vendored opencode desktop themes + orbit.json config
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { listThemeFiles, getTheme, getThemeFile, generateThemeCss, DEFAULT_THEME_ID } from '../src/theme.js';
import { loadConfig, mergeConfigs, expandCommand } from '../src/config.js';

describe('vendored opencode themes', () => {
  it('ships the full official theme pack (36 files incl. oc-2)', async () => {
    const themes = await listThemeFiles();
    expect(themes.length).toBeGreaterThanOrEqual(36);
    expect(themes.map((t) => t.id)).toContain(DEFAULT_THEME_ID); // oc-2
    expect(themes.map((t) => t.id)).toContain('gruvbox');
  });

  it('resolves gruvbox palette straight from the official JSON', async () => {
    const resolved = await getTheme('gruvbox');
    expect(resolved.colors.bg).toBe('#282828');
    expect(resolved.colors.accent).toBe('#83a598'); // gruvbox primary
    expect(resolved.ansi.accent).toEqual([131, 165, 152]);
  });

  it('defaults to oc-2 when theme id is unknown', async () => {
    const resolved = await getTheme('nope-forever');
    expect(resolved.id).toBe(DEFAULT_THEME_ID);
  });

  it('generates CSS with palette + derived surfaces + syntax overrides', async () => {
    const file = await getThemeFile('gruvbox');
    expect(file).toBeDefined();
    const css = generateThemeCss(file!);
    expect(css).toContain('--color-bg: #282828');
    expect(css).toContain('--color-bg-surface: color-mix(in srgb, #ebdbb2 5%, #282828)');
    expect(css).toContain('--syntax-keyword: #fb4934');
    expect(css).toContain('color-scheme: dark');
  });

  it('emits light-mode block when theme defines one', async () => {
    const css = generateThemeCss((await getThemeFile('gruvbox'))!);
    expect(css).toContain('@media (prefers-color-scheme: light)');
    expect(css).toContain('--color-bg: #fbf1c7');
  });
});

describe('orbit.json config', () => {
  it('merges global + project layers (project wins, arrays concat)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-cfg-'));
    const globalFile = path.join(dir, 'global.json');
    const projectDir = path.join(dir, 'proj');
    await fs.mkdir(projectDir, { recursive: true });
    const projectFile = path.join(projectDir, 'orbit.json');
    await fs.writeFile(globalFile, JSON.stringify({ theme: 'gruvbox', verifyCommands: ['npm test'], commands: { fix: 'Fix $ARGUMENTS' } }));
    await fs.writeFile(projectFile, JSON.stringify({ theme: 'tokyonight', verifyCommands: ['cargo test'], commands: { deploy: 'Deploy $ARGUMENTS' } }));

    const { merged } = await loadConfig(globalFile, projectDir);
    expect(merged.theme).toBe('tokyonight');
    expect(merged.verifyCommands).toEqual(['npm test', 'cargo test']);
    expect(merged.commands?.fix).toBeDefined();
    expect(merged.commands?.deploy).toBeDefined();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns empty merged config when files are missing', async () => {
    const { merged, global, project } = await loadConfig(path.join(os.tmpdir(), 'orbit-missing.json'), undefined);
    expect(global).toBeNull();
    expect(project).toBeNull();
    expect(merged.theme).toBeUndefined();
  });

  it('expands $ARGUMENTS in custom command templates', () => {
    expect(expandCommand('Fix bug in $ARGUMENTS quickly', 'src/api.ts')).toBe('Fix bug in src/api.ts quickly');
    expect(expandCommand('no placeholder here', 'x')).toBe('no placeholder here');
  });

  it('mergeConfigs concatenates verify commands across layers', () => {
    const merged = mergeConfigs({ verifyCommands: ['a'] }, { verifyCommands: ['b'] }, { verifyCommands: ['c'] });
    expect(merged.verifyCommands).toEqual(['a', 'b', 'c']);
  });
});
