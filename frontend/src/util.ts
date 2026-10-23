const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
export const money = (paise: number) => inr.format(paise / 100);

/** "123.45" -> 12345. Parsed from text (no floating point) so the paise value is exact. */
export function rupeesToPaise(input: string): number | null {
  const m = /^\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
}
export const paiseToRupees = (p: number) => (p / 100).toFixed(2);

export const fmtDate = (s?: string) => (s ? new Date(s).toLocaleString('en-IN') : '');

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const TERMINAL_BAD = new Set(['FAILED', 'CANCELLED']);
export const statusClass = (s: string) => (TERMINAL_BAD.has(s) ? 'bad' : ['CONFIRMED', 'PAID', 'DELIVERED', 'ACTIVE', 'APPROVED'].includes(s) ? 'good' : 'neutral');
