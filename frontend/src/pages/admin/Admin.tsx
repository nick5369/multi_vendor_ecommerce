import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router-dom';
import { api, AUTH, CAT, newKey, ORD, PAY, post, type Order, type Page, type SellerProduct } from '../../api';
import { Badge, Card, JsonTable, Msg, Pager } from '../../components/ui';
import { errMsg, fmtDate, money, rupeesToPaise } from '../../util';

export function AdminShell() {
  return (
    <>
      <h1>Admin</h1>
      <div className="tabs">
        <NavLink end to="/admin">Seller applications</NavLink>
        <NavLink to="/admin/stores">Stores</NavLink>
        <NavLink to="/admin/users">Users</NavLink>
        <NavLink to="/admin/products">Products</NavLink>
        <NavLink to="/admin/orders">Orders</NavLink>
        <NavLink to="/admin/audit">Audit log</NavLink>
      </div>
      <Outlet />
    </>
  );
}

/** Small helper for list pages: pagination + a shared message line + refetch after an action. */
function useAdminList<T>(key: string, url: string, size = 20) {
  const [page, setPage] = useState(0);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: [key, page], queryFn: () => api<Page<T>>(`${url}${url.includes('?') ? '&' : '?'}page=${page}&size=${size}`) });
  const [msg, setMsg] = useState<{ err?: string; ok?: string }>({});
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg({});
    try { await fn(); setMsg({ ok }); await qc.invalidateQueries({ queryKey: [key] }); } catch (e) { setMsg({ err: errMsg(e) }); }
  };
  return { q, page, setPage, msg, act };
}

export function Applications() {
  const { q, page, setPage, msg, act } = useAdminList<any>('admin-apps', `${AUTH}/admin/seller-applications`);
  return (
    <>
      <Msg error={msg.err} ok={msg.ok} />
      {q.error && <Msg error={errMsg(q.error)} />}
      {q.data?.items.length === 0 && <p className="muted">No applications.</p>}
      {q.data?.items.map((a) => (
        <Card key={a._id} title={a.storeName} actions={<Badge status={a.status} />}>
          <p>{a.description || <span className="muted">No description</span>}</p>
          <p className="muted">Applicant {String(a.userId).slice(0, 8)} · {fmtDate(a.createdAt)}{a.rejectionReason ? ` · rejected: ${a.rejectionReason}` : ''}</p>
          {a.status === 'PENDING' && (
            <div className="inline">
              <button className="btn primary" onClick={() => act(() => post(`${AUTH}/admin/seller-applications/${a._id}/approve`), 'Approved')}>Approve</button>
              <button className="btn danger" onClick={() => { const reason = window.prompt('Reason for rejection?'); if (reason?.trim()) void act(() => post(`${AUTH}/admin/seller-applications/${a._id}/reject`, { reason: reason.trim() }), 'Rejected'); }}>Reject</button>
            </div>
          )}
        </Card>
      ))}
      {q.data && <Pager page={page} size={q.data.size} total={q.data.total} onPage={setPage} />}
    </>
  );
}

export function Stores() {
  const { q, page, setPage, msg, act } = useAdminList<any>('admin-stores', `${AUTH}/admin/stores`);
  return (
    <>
      <Msg error={msg.err} ok={msg.ok} />
      <Card><div className="scroll"><table>
        <thead><tr><th>Store</th><th>ID</th><th>Status</th><th /></tr></thead>
        <tbody>{q.data?.items.map((s) => (
          <tr key={s._id}><td>{s.name}</td><td><code>{String(s._id).slice(0, 8)}</code></td><td><Badge status={s.status} /></td>
            <td>{s.status === 'ACTIVE'
              ? <button className="btn small danger" onClick={() => act(() => post(`${AUTH}/admin/stores/${s._id}/status`, { status: 'SUSPENDED' }), 'Store suspended')}>Suspend</button>
              : <button className="btn small" onClick={() => act(() => post(`${AUTH}/admin/stores/${s._id}/status`, { status: 'ACTIVE' }), 'Store reactivated')}>Reactivate</button>}</td></tr>
        ))}</tbody>
      </table></div></Card>
      {q.data && <Pager page={page} size={q.data.size} total={q.data.total} onPage={setPage} />}
    </>
  );
}

export function Users() {
  const { q, page, setPage, msg, act } = useAdminList<any>('admin-users', `${AUTH}/admin/users`);
  return (
    <>
      <Msg error={msg.err} ok={msg.ok} />
      <Card><div className="scroll"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Status</th><th /></tr></thead>
        <tbody>{q.data?.items.map((u) => (
          <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.roles.join(', ')}</td><td><Badge status={u.status} /></td>
            <td>{u.roles.includes('ADMIN') ? null : u.status === 'ACTIVE'
              ? <button className="btn small danger" onClick={() => act(() => post(`${AUTH}/admin/users/${u.id}/status`, { status: 'DISABLED' }), 'User disabled')}>Disable</button>
              : <button className="btn small" onClick={() => act(() => post(`${AUTH}/admin/users/${u.id}/status`, { status: 'ACTIVE' }), 'User enabled')}>Enable</button>}</td></tr>
        ))}</tbody>
      </table></div></Card>
      {q.data && <Pager page={page} size={q.data.size} total={q.data.total} onPage={setPage} />}
    </>
  );
}

export function AdminProducts() {
  const { q, page, setPage, msg, act } = useAdminList<SellerProduct>('admin-products', `${CAT}/admin/products`);
  return (
    <>
      <Msg error={msg.err} ok={msg.ok} />
      <Card><div className="scroll"><table>
        <thead><tr><th>Product</th><th>Seller</th><th>Status</th><th>Moderation</th><th /></tr></thead>
        <tbody>{q.data?.items.map((s) => (
          <tr key={s.product.id}>
            <td><Link to={`/product/${s.product.id}`}>{s.product.title}</Link></td>
            <td><code>{s.product.sellerId.slice(0, 8)}</code></td>
            <td><Badge status={s.status} /></td>
            <td><Badge status={s.moderation} />{s.moderationReason && <div className="muted">{s.moderationReason}</div>}</td>
            <td>{s.moderation === 'SUSPENDED'
              ? <button className="btn small" onClick={() => act(() => post(`${CAT}/admin/products/${s.product.id}/moderation`, { status: 'APPROVED' }), 'Approved')}>Approve</button>
              : <button className="btn small danger" onClick={() => { const reason = window.prompt('Reason for suspending?'); if (reason?.trim()) void act(() => post(`${CAT}/admin/products/${s.product.id}/moderation`, { status: 'SUSPENDED', reason: reason.trim() }), 'Suspended'); }}>Suspend</button>}</td>
          </tr>
        ))}</tbody>
      </table></div></Card>
      {q.data && <Pager page={page} size={q.data.size} total={q.data.total} onPage={setPage} />}
    </>
  );
}

const ORDER_STATUSES = ['', 'PENDING_STOCK', 'STOCK_RESERVED', 'PAYMENT_PENDING', 'PAID', 'CONFIRMED', 'FAILED', 'CANCELLED', 'REFUNDED'];

export function AdminOrders() {
  const [status, setStatus] = useState('');
  const { q, page, setPage } = useAdminList<Order>(`admin-orders-${status}`, `${ORD}/admin/orders${status ? `?status=${status}` : ''}`);
  return (
    <>
      <div className="filters">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }} aria-label="Status">
          {ORDER_STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
        </select>
      </div>
      <Msg error={q.error ? errMsg(q.error) : null} />
      <Card><div className="scroll"><table>
        <thead><tr><th>Order</th><th>Created</th><th>Status</th><th className="right">Total</th><th className="right">Refunded</th></tr></thead>
        <tbody>{q.data?.items.map((o) => (
          <tr key={o.orderId}><td><Link to={`/admin/orders/${o.orderId}`}>{o.orderId.slice(0, 8)}</Link></td><td>{fmtDate(o.createdAt)}</td><td><Badge status={o.status} /></td>
            <td className="right">{money(o.totalPaise)}</td><td className="right">{o.refundedPaise ? money(o.refundedPaise) : '—'}</td></tr>
        ))}</tbody>
      </table></div></Card>
      {q.data && <Pager page={page} size={q.data.size} total={q.data.total} onPage={setPage} />}
    </>
  );
}

export function AdminOrderDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-order', id], queryFn: () => api<Order>(`${ORD}/admin/orders/${id}`) });
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState<{ err?: string; ok?: string }>({});
  // one key per refund intent; it changes only after the request is accepted, so a retry cannot refund twice
  const [key, setKey] = useState(newKey);

  async function refund() {
    setMsg({});
    const body: Record<string, unknown> = { orderId: id, reason: 'admin refund' };
    if (amount.trim()) {
      const p = rupeesToPaise(amount);
      if (p === null || p < 100) return setMsg({ err: 'Minimum refund is ₹1.00 (100 paise)' });
      body.amountPaise = p;
    }
    try {
      const r = await post(`${PAY}/refunds`, body, { 'Idempotency-Key': key });
      setMsg({ ok: `Refund submitted${r?.status ? ` (${r.status})` : ''}. It completes when the provider confirms.` });
      setKey(newKey()); setAmount('');
      void qc.invalidateQueries({ queryKey: ['admin-order', id] });
    } catch (e) { setMsg({ err: errMsg(e) }); }
  }
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (!q.data) return <Msg error={errMsg(q.error)} />;
  const o = q.data;
  const refundable = ['CONFIRMED', 'PAID', 'REFUNDED'].includes(o.status) && o.refundedPaise < o.totalPaise;
  return (
    <>
      <p><Link to="/admin/orders">← Orders</Link></p>
      <h2>Order {o.orderId} <Badge status={o.status} /></h2>
      <p className="muted">Customer {o.customerId} · {fmtDate(o.createdAt)} · total {money(o.totalPaise)} · refunded {money(o.refundedPaise)}</p>
      {o.failureReason && <Msg error={o.failureReason} />}
      {o.groups.map((g) => (
        <Card key={g.groupId} title={`Seller ${g.sellerId.slice(0, 8)}`} actions={<Badge status={g.status} />}>
          <table><tbody>{g.items.map((i) => <tr key={i.skuId}><td>{i.title}</td><td>{i.quantity} × {money(i.unitPricePaise)}</td><td className="right">{money(i.lineTotalPaise)}</td></tr>)}</tbody></table>
        </Card>
      ))}
      {refundable && (
        <Card title="Refund">
          <Msg error={msg.err} ok={msg.ok} />
          <div className="inline">
            <input placeholder="Amount ₹ (empty = everything refundable)" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ minWidth: 280 }} />
            <button className="btn danger" onClick={() => { if (window.confirm('Refund this order via the payment provider?')) void refund(); }}>Refund</button>
          </div>
          <p className="muted">Refunds go to Razorpay (test mode) and cannot exceed what was captured.</p>
        </Card>
      )}
      {!refundable && msg.ok && <Msg ok={msg.ok} />}
      {o.history && <Card title="History"><ul>{o.history.map((h, i) => <li key={i}>{fmtDate(h.createdAt)} — {h.groupId ? `group ${h.groupId.slice(0, 8)}: ` : ''}{h.toStatus} <span className="muted">by {h.actor}{h.reason ? ` (${h.reason})` : ''}</span></li>)}</ul></Card>}
    </>
  );
}

export function AuditLog() {
  const { q, page, setPage } = useAdminList<any>('admin-audit', `${AUTH}/admin/audit`, 50);
  return (
    <>
      <Msg error={q.error ? errMsg(q.error) : null} />
      <Card><JsonTable rows={q.data?.items ?? []} /></Card>
      {q.data && <Pager page={page} size={q.data.size} total={q.data.total} onPage={setPage} />}
    </>
  );
}
