// src/tui.ts — minimal OpenCode-style TUI kit: arrow-key menus, forms, password input, spinner.
// Password input uses readline output muting (NO raw-mode on shared stdin — avoids echo leaks
// and phantom lines). Menus use raw mode; the host must drop 'line' events while gate.active.
import { stdin, stdout } from 'node:process';
import { emitKeypressEvents, type Key } from 'node:readline';

export interface MenuOption<T> { label: string; value: T; hint?: string }

/** Host-provided IO. gate.active === true means a raw-mode menu owns stdin: drop rl 'line' events. */
export interface TuiIO {
  question: (q: string) => Promise<string>;
  rl?: unknown;                       // readline Interface (for output muting)
  gate?: { active: boolean };
}

const isTTY = (): boolean => stdin.isTTY === true;

function clearUp(n: number): void {
  if (n > 0) stdout.write(`\x1b[${n}A\x1b[J`);
}

// ---------- single-select menu ----------
export async function menu<T>(title: string, options: MenuOption<T>[], io: TuiIO): Promise<T | null> {
  if (options.length === 0) return null;
  if (!isTTY()) {
    console.log(`${title}`);
    options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}${o.hint ? ` ${o.hint}` : ''}`));
    const ans = (await io.question('chọn số (Enter = 1, bỏ trống = hủy): ')).trim();
    if (!ans) return null;
    const n = Number(ans);
    if (!Number.isInteger(n) || n < 1 || n > options.length) return null;
    return options[n - 1].value;
  }

  if (io.gate) io.gate.active = true;
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  let idx = 0;
  let frameLines = 0;

  const render = (): void => {
    clearUp(frameLines);
    const lines: string[] = [`${title} ${dim('(↑↓ di chuyển, Enter chọn, Esc hủy)')}`];
    options.forEach((o, i) => {
      const sel = i === idx;
      lines.push(`${sel ? cyan('❯ ') : '  '}${sel ? bold(o.label) : o.label}${o.hint ? ` ${dim(o.hint)}` : ''}`);
    });
    stdout.write(lines.join('\n') + '\n');
    frameLines = lines.length;
  };

  const picked = await new Promise<T | null>((resolve) => {
    render();
    const onKey = (_ch: string, key: Key): void => {
      if (key.name === 'up' || key.name === 'k') idx = (idx - 1 + options.length) % options.length;
      else if (key.name === 'down' || key.name === 'j') idx = (idx + 1) % options.length;
      else if (key.name === 'return') {
        finish(options[idx].value);
        return;
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        finish(null);
        return;
      } else return;
      render();
    };
    const finish = (value: T | null): void => {
      stdin.removeListener('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      if (io.gate) io.gate.active = false;
      clearUp(frameLines);
      stdout.write(value !== null ? `${title} ${cyan(`→ ${options[idx].label}`)}\n` : `${title} ${dim('→ hủy')}\n`);
      resolve(value);
    };
    stdin.on('keypress', onKey);
  });
  return picked;
}

// ---------- multi-select menu (space toggle) ----------
export async function multiMenu<T>(title: string, options: MenuOption<T>[], io: TuiIO): Promise<T[] | null> {
  if (options.length === 0) return null;
  if (!isTTY()) {
    console.log(`${title} ${dim('(nhập các số cách nhau bởi dấu phẩy, vd 1,3)')}`);
    options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}${o.hint ? ` ${o.hint}` : ''}`));
    const ans = (await io.question('chọn: ')).trim();
    if (!ans) return null;
    const nums = ans.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length);
    return nums.map((n) => options[n - 1].value);
  }

  if (io.gate) io.gate.active = true;
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  let idx = 0;
  const pickedSet = new Set<number>();
  let frameLines = 0;

  const render = (): void => {
    clearUp(frameLines);
    const lines: string[] = [`${title} ${dim('(space chọn/bỏ, Enter xác nhận, Esc hủy)')}`];
    options.forEach((o, i) => {
      const sel = i === idx;
      const box = pickedSet.has(i) ? green('[x]') : '[ ]';
      lines.push(`${sel ? cyan('❯ ') : '  '}${box} ${sel ? bold(o.label) : o.label}${o.hint ? ` ${dim(o.hint)}` : ''}`);
    });
    stdout.write(lines.join('\n') + '\n');
    frameLines = lines.length;
  };

  const result = await new Promise<T[] | null>((resolve) => {
    render();
    const onKey = (_ch: string, key: Key): void => {
      if (key.name === 'up' || key.name === 'k') idx = (idx - 1 + options.length) % options.length;
      else if (key.name === 'down' || key.name === 'j') idx = (idx + 1) % options.length;
      else if (key.name === 'space') { if (pickedSet.has(idx)) pickedSet.delete(idx); else pickedSet.add(idx); }
      else if (key.name === 'return') {
        if (pickedSet.size === 0) { render(); return; } // cần chọn ít nhất 1
        finish([...pickedSet].map((i) => options[i].value));
        return;
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        finish(null);
        return;
      } else return;
      render();
    };
    const finish = (value: T[] | null): void => {
      stdin.removeListener('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      if (io.gate) io.gate.active = false;
      clearUp(frameLines);
      stdout.write(value !== null ? `${title} ${cyan(`→ ${value.length} mục`)}\n` : `${title} ${dim('→ hủy')}\n`);
      resolve(value);
    };
    stdin.on('keypress', onKey);
  });
  return result;
}

// ---------- text input (masked option) ----------
export async function input(label: string, io: TuiIO, opts: { password?: boolean; defaultValue?: string } = {}): Promise<string | null> {
  // Password: mute readline's own echo instead of raw mode — no double-processing, no leaks.
  if (opts.password && isTTY() && io.rl) {
    const rl = io.rl as { _writeToOutput?: (s: string) => void; question: (q: string, cb: (a: string) => void) => unknown };
    if (typeof rl._writeToOutput !== 'function') return plainQuestion(label, io, opts);
    const orig = rl._writeToOutput.bind(rl);
    let muted = true;
    rl._writeToOutput = (s: string): void => {
      if (/^[\r\n]+$/.test(s)) { orig(s); return; }
      // strip ANSI escapes + control chars, mask only visible chars (backspace redraws stay aligned)
      const visible = s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x1f\x7f]/g, '');
      orig(visible.length ? '*'.repeat(visible.length) : '');
    };
    stdout.write(`${label}: `);
    const ans = await new Promise<string>((resolve) => {
      rl.question('', (a: string) => resolve(a));
    });
    muted = false;
    rl._writeToOutput = orig;
    stdout.write('\n');
    return ans.length ? ans : null;
  }
  return plainQuestion(label, io, opts);
}

async function plainQuestion(label: string, io: TuiIO, opts: { password?: boolean; defaultValue?: string }): Promise<string | null> {
  const hint = opts.defaultValue ? dim(` (Enter = ${opts.defaultValue})`) : '';
  const ans = (await io.question(`${label}${hint}: `)).trim();
  if (!ans) return opts.defaultValue ?? null;
  return ans;
}

export async function confirm(label: string, io: TuiIO): Promise<boolean> {
  const ans = (await io.question(`${label} (y/N): `)).trim().toLowerCase();
  return ans === 'y' || ans === 'yes';
}

// ---------- spinner ----------
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private i = 0;

  start(text: string): void {
    if (!isTTY()) {
      console.log(cyan(`… ${text}`));
      return;
    }
    this.timer = setInterval(() => {
      stdout.write(`\r\x1b[K${cyan(FRAMES[this.i % FRAMES.length])} ${text}`);
      this.i++;
    }, 80);
  }

  stop(final?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      stdout.write(`\r\x1b[K`);
    }
    if (final) console.log(final);
  }
}

// ---------- color helpers (theme-driven, truecolor) ----------
import { ansiFor, type ResolvedTheme } from './theme.js';

let PALETTE = ansiFor({
  id: 'fallback', label: 'Fallback', dark: true,
  colors: {} as ResolvedTheme['colors'],
  ansi: { accent: [0, 122, 255] as [number, number, number], success: [48, 209, 88] as [number, number, number], warning: [255, 159, 10] as [number, number, number], danger: [255, 69, 58] as [number, number, number], secondary: [199, 199, 204] as [number, number, number] },
});

export function setAnsiTheme(theme: ResolvedTheme): void {
  PALETTE = ansiFor(theme);
}

export const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
export const cyan = (s: string): string => PALETTE.accent(s);
export const green = (s: string): string => PALETTE.success(s);
export const yellow = (s: string): string => PALETTE.warning(s);
export const red = (s: string): string => PALETTE.danger(s);
export const magenta = (s: string): string => PALETTE.secondary(s);
