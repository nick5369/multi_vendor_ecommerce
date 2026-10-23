import type { ReactNode } from 'react';
import { statusClass } from '../util';

export const Badge = ({ status }: { status: string }) => <span className={`badge ${statusClass(status)}`}>{status.replace(/_/g, ' ')}</span>;

export function Pager({ page, size, total, onPage }: { page: number; size: number; total: number; onPage(p: number): void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <button className="btn" disabled={page <= 0} onClick={() => onPage(page - 1)}>← Prev</button>
      <span>Page {page + 1} of {pages}</span>
      <button className="btn" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>Next →</button>
    </div>
  );
}

export function Msg({ error, ok }: { error?: string | null; ok?: string | null }) {
  if (error) return <p className="error box" role="alert">{error}</p>;
  if (ok) return <p className="ok box" role="status">{ok}</p>;
  return null;
}

export const Card = ({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) => (
  <section className="card">
    {(title || actions) && <header><h3>{title}</h3><div>{actions}</div></header>}
    {children}
  </section>
);

export const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="field"><span>{label}</span>{children}{hint && <small className="muted">{hint}</small>}</label>
);

/** Renders any list of flat-ish records (used where the API shape is generic, e.g. the audit log). */
export function JsonTable({ rows }: { rows: Record<string, any>[] }) {
  if (!rows.length) return <p className="muted">Nothing here yet.</p>;
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  return (
    <div className="scroll">
      <table>
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{cols.map((c) => <td key={c}>{typeof r[c] === 'object' && r[c] !== null ? JSON.stringify(r[c]) : String(r[c] ?? '')}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
