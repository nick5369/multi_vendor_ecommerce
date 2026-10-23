import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api, ORD, post, type Order, type Page } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Msg, Pager } from '../components/ui';
import { launchCheckout, syncPayment } from '../razorpay';
import { errMsg, fmtDate, money } from '../util';

export function Orders() {
  const [page, setPage] = useState(0);
  const q = useQuery({ queryKey: ['orders', page], queryFn: () => api<Page<Order>>(`${ORD}/orders?page=${page}&size=10`) });
  return (
    <>
      <h1>My orders</h1>
      <Msg error={q.error ? errMsg(q.error) : null} />
      {q.data?.items.length === 0 && <div className="empty"><span className="big">📦</span>No orders yet. <Link to="/">Start shopping</Link></div>}
      {q.data?.items.map((o) => (
        <Card key={o.orderId}>
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <Link to={`/orders/${o.orderId}`}><strong>Order {o.orderId.slice(0, 8)}</strong></Link>
            <Badge status={o.status} />
          </div>
          <p className="muted">{fmtDate(o.createdAt)} · {o.groups.reduce((n, g) => n + g.items.reduce((m, i) => m + i.quantity, 0), 0)} item(s) · <strong>{money(o.totalPaise)}</strong></p>
        </Card>
      ))}
      {q.data && <Pager page={page} size={q.data.size} total={q.data.total} onPage={setPage} />}
    </>
  );
}

const STEPS = ['Order placed', 'Stock reserved', 'Payment', 'Confirmed'];
const STEP_OF: Record<string, number> = { PENDING_STOCK: 0, STOCK_RESERVED: 1, PAYMENT_PENDING: 2, PAID: 3, CONFIRMED: 4, REFUNDED: 4 };

function Stepper({ status }: { status: string }) {
  const failed = status === 'FAILED' || status === 'CANCELLED';
  const at = STEP_OF[status] ?? 0;
  return (
    <ol className="steps" aria-label="Order progress">
      {STEPS.map((label, i) => (
        <li key={label} data-n={i + 1} className={failed ? (i === 0 ? 'done' : i === 1 ? 'fail' : '') : i < at ? 'done' : i === at ? 'now' : ''}>{label}</li>
      ))}
    </ol>
  );
}

const TRANSIENT = new Set(['PENDING_STOCK', 'STOCK_RESERVED', 'PAID']);

export function OrderDetail() {
  const { id } = useParams();
  const loc = useLocation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [note, setNote] = useState<{ err?: string; ok?: string }>({});
  const [paying, setPaying] = useState(false);
  const [waitingServer, setWaitingServer] = useState(false);
  const autopayed = useRef(false);

  const q = useQuery({
    queryKey: ['order', id],
    queryFn: () => api<Order>(`${ORD}/orders/${id}`),
    // the saga runs in the background: poll while the order is between steps, or while we wait for the server to see a payment
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s && (TRANSIENT.has(s) || (waitingServer && s === 'PAYMENT_PENDING')) ? 1500 : false;
    },
  });
  const o = q.data;

  async function pay() {
    if (!o?.payment) return;
    setPaying(true); setNote({});
    try {
      const out = await launchCheckout(o.payment, { name: o.shippingAddress?.name ?? user?.name, email: user?.email, contact: o.shippingAddress?.phone });
      if (out.kind === 'paid') { setNote({ ok: 'Payment received — confirming your order…' }); setWaitingServer(true); }
      else if (out.kind === 'failed') setNote({ err: out.message });
      else setNote({ err: 'Payment window closed. You can retry from here while the order is still open.' });
    } catch (e) { setNote({ err: errMsg(e) }); } finally {
      setPaying(false);
      void qc.invalidateQueries({ queryKey: ['order', id] });
      void qc.invalidateQueries({ queryKey: ['cart'] });
    }
  }

  // arriving from checkout: open Razorpay as soon as the server has produced the payment (once)
  useEffect(() => {
    if (o?.status === 'PAYMENT_PENDING' && o.payment && (loc.state as any)?.autopay && !autopayed.current) {
      autopayed.current = true;
      void pay();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o?.status, o?.payment?.providerOrderId]);

  useEffect(() => { if (o && o.status !== 'PAYMENT_PENDING') { setWaitingServer(false); void qc.invalidateQueries({ queryKey: ['cart'] }); } }, [o?.status, qc]);

  async function check() {
    if (!o?.payment) return;
    setNote({});
    try { await syncPayment(o.payment.providerOrderId); setNote({ ok: 'Checked with the payment provider.' }); } catch (e) { setNote({ err: errMsg(e) }); }
    void qc.invalidateQueries({ queryKey: ['order', id] });
  }
  async function cancel() {
    setNote({});
    try { await post(`${ORD}/orders/${id}/cancel`); setNote({ ok: 'Order cancelled.' }); } catch (e) { setNote({ err: errMsg(e) }); }
    void qc.invalidateQueries({ queryKey: ['order', id] });
  }

  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.error || !o) return <Msg error={q.error ? errMsg(q.error) : 'Not found'} />;
  const cancellable = ['PENDING_STOCK', 'STOCK_RESERVED', 'PAYMENT_PENDING'].includes(o.status);
  return (
    <>
      <p><Link to="/orders">← My orders</Link></p>
      <h1>Order {o.orderId.slice(0, 8)} <Badge status={o.status} /></h1>
      <Msg error={note.err} ok={note.ok} />
      <Stepper status={o.status} />
      {TRANSIENT.has(o.status) && <p className="muted">Working on it… this page updates automatically.</p>}
      {o.status === 'FAILED' && <Msg error={`This order could not be completed${o.failureReason ? `: ${o.failureReason}` : ''}. Nothing was charged. Your cart is unchanged.`} />}
      {o.status === 'CONFIRMED' && <div className="success-burst"><div className="tick" aria-hidden>✓</div><Msg ok="Order confirmed. Sellers have been notified." /></div>}
      {o.status === 'PAYMENT_PENDING' && o.payment && (
        <Card title="Payment">
          <p>Amount due: <strong>{money(o.payment.amountPaise)}</strong> · stock is reserved for a limited time.</p>
          {o.payment.gateway !== 'razorpay' && <Msg error={`Gateway is "${o.payment.gateway}" — there is no browser checkout for it.`} />}
          <div className="inline">
            <button className="btn primary" disabled={paying || o.payment.gateway !== 'razorpay'} onClick={pay}>{paying ? 'Payment window open…' : 'Pay with Razorpay'}</button>
            <button className="btn" onClick={check}>I already paid — check status</button>
            {cancellable && <button className="btn danger" onClick={cancel}>Cancel order</button>}
          </div>
          <p className="muted">Test mode: use Razorpay's test card (Indian test card <code>5267 3181 8797 5449</code>, any future expiry, any CVV; at the OTP step choose “Pay on bank's page” and click Success). The <code>4111…</code> card is rejected as international on this account.</p>
        </Card>
      )}
      {cancellable && o.status !== 'PAYMENT_PENDING' && <button className="btn danger" onClick={cancel}>Cancel order</button>}

      {o.groups.map((g) => (
        <Card key={g.groupId} title={`Seller ${g.sellerId.slice(0, 8)}`} actions={<Badge status={g.status} />}>
          <table>
            <tbody>
              {g.items.map((i) => (
                <tr key={i.skuId}><td>{i.title}{i.skuName !== 'Default' ? ` — ${i.skuName}` : ''}</td><td>{i.quantity} × {money(i.unitPricePaise)}</td><td className="right">{money(i.lineTotalPaise)}</td></tr>
              ))}
              <tr><td colSpan={2} className="right muted">Shipping</td><td className="right">{money(g.shippingPaise)}</td></tr>
              {g.refundedPaise > 0 && <tr><td colSpan={2} className="right muted">Refunded</td><td className="right">−{money(g.refundedPaise)}</td></tr>}
            </tbody>
          </table>
        </Card>
      ))}
      <Card title="Totals">
        <table><tbody>
          <tr><td>Subtotal</td><td className="right">{money(o.subtotalPaise)}</td></tr>
          <tr><td>Shipping</td><td className="right">{money(o.shippingPaise)}</td></tr>
          {o.taxPaise > 0 && <tr><td>Tax</td><td className="right">{money(o.taxPaise)}</td></tr>}
          <tr className="total"><td>Total</td><td className="right">{money(o.totalPaise)}</td></tr>
          {o.refundedPaise > 0 && <tr><td>Refunded</td><td className="right">{money(o.refundedPaise)}</td></tr>}
        </tbody></table>
        {o.shippingAddress && <p className="muted">Ship to: {o.shippingAddress.name}, {o.shippingAddress.line1}, {o.shippingAddress.city} {o.shippingAddress.pincode}</p>}
      </Card>
      {o.history && (
        <Card title="History">
          <ul className="timeline">{o.history.filter((h) => !h.groupId).map((h, i) => <li key={i}>{fmtDate(h.createdAt)} — {h.toStatus.replace(/_/g, ' ')}{h.reason ? ` (${h.reason})` : ''}</li>)}</ul>
        </Card>
      )}
    </>
  );
}
