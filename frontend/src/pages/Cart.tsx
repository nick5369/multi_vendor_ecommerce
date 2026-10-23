import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, del, newKey, ORD, post, put, type Address, type Cart as CartT, type Order } from '../api';
import { Card, Field, Msg } from '../components/ui';
import { errMsg, money } from '../util';

export function Cart() {
  const qc = useQueryClient();
  const cart = useQuery({ queryKey: ['cart'], queryFn: () => api<CartT>(`${ORD}/cart`) });
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['cart'] });
  const setQty = useMutation({ mutationFn: (v: { sku: string; q: number }) => put(`${ORD}/cart/items/${v.sku}`, { quantity: v.q }), onSuccess: refresh, onError: (e) => setErr(errMsg(e)) });
  const remove = useMutation({ mutationFn: (sku: string) => del(`${ORD}/cart/items/${sku}`), onSuccess: refresh, onError: (e) => setErr(errMsg(e)) });
  const clear = useMutation({ mutationFn: () => del(`${ORD}/cart`), onSuccess: refresh, onError: (e) => setErr(errMsg(e)) });

  if (cart.isLoading) return <p className="muted">Loading…</p>;
  if (cart.error) return <Msg error={errMsg(cart.error)} />;
  const c = cart.data!;
  const blocked = c.items.some((i) => !i.purchasable);
  return (
    <>
      <h1>Your cart</h1>
      <Msg error={err} />
      {c.items.length === 0 ? <div className="empty"><span className="big">🛒</span>Your cart is empty. <Link to="/">Browse products</Link></div> : (
        <Card>
          <div className="scroll">
            <table>
              <thead><tr><th>Item</th><th>Price</th><th>Qty</th><th className="right">Total</th><th /></tr></thead>
              <tbody>
                {c.items.map((i) => (
                  <tr key={i.skuId}>
                    <td>{i.title ?? 'Unavailable item'}{i.skuName && i.skuName !== 'Default' ? ` — ${i.skuName}` : ''}{!i.purchasable && <div className="error">No longer available — remove it to continue</div>}</td>
                    <td>{money(i.pricePaise)}</td>
                    <td><input className="qty" type="number" min={1} max={99} defaultValue={i.quantity} key={`${i.skuId}-${i.quantity}`}
                      onBlur={(e) => { const q = Number(e.target.value); if (q >= 1 && q !== i.quantity) setQty.mutate({ sku: i.skuId, q }); }} /></td>
                    <td className="right">{i.purchasable ? money(i.lineTotalPaise) : '—'}</td>
                    <td><button className="btn small danger" onClick={() => remove.mutate(i.skuId)}>Remove</button></td>
                  </tr>
                ))}
                <tr className="total"><td colSpan={3} className="right">Subtotal (shipping added at checkout)</td><td className="right">{money(c.subtotalPaise)}</td><td /></tr>
              </tbody>
            </table>
          </div>
          <div className="inline" style={{ marginTop: 12 }}>
            <Link to="/checkout" className={`btn primary${blocked ? ' disabled' : ''}`} aria-disabled={blocked} onClick={(e) => blocked && e.preventDefault()}>Checkout</Link>
            <button className="btn" onClick={() => clear.mutate()}>Empty cart</button>
          </div>
        </Card>
      )}
    </>
  );
}

const EMPTY: Address = { name: '', line1: '', line2: '', city: '', state: '', pincode: '', phone: '' };

export function Checkout() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const cart = useQuery({ queryKey: ['cart'], queryFn: () => api<CartT>(`${ORD}/cart`) });
  const [addr, setAddr] = useState<Address>(EMPTY);
  // One key per page visit: a double click or a retry after a network error returns the same order instead of a second one.
  const [key] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bind = (f: keyof Address) => ({ value: addr[f] ?? '', onChange: (e: { target: { value: string } }) => setAddr({ ...addr, [f]: e.target.value }) });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body: Address = { ...addr, line2: addr.line2 || undefined };
      const order = await post<Order>(`${ORD}/checkout`, { shippingAddress: body }, { 'Idempotency-Key': key });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      nav(`/orders/${order.orderId}`, { state: { autopay: true } });
    } catch (e2) { setErr(errMsg(e2)); setBusy(false); }
  }

  if (cart.isLoading) return <p className="muted">Loading…</p>;
  const c = cart.data;
  if (!c || c.items.length === 0) return <div className="empty"><span className="big">🛒</span>Your cart is empty. <Link to="/">Browse products</Link></div>;
  return (
    <>
      <h1>Checkout</h1>
      <div className="detail">
        <Card title="Shipping address">
          <form onSubmit={submit}>
            <Msg error={err} />
            <Field label="Full name"><input required {...bind('name')} /></Field>
            <Field label="Address line 1"><input required {...bind('line1')} /></Field>
            <Field label="Address line 2"><input {...bind('line2')} /></Field>
            <div className="row">
              <Field label="City"><input required {...bind('city')} /></Field>
              <Field label="State"><input required {...bind('state')} /></Field>
            </div>
            <div className="row">
              <Field label="PIN code"><input required pattern="\d{6}" title="6 digits" inputMode="numeric" {...bind('pincode')} /></Field>
              <Field label="Phone"><input required pattern="\d{10}" title="10 digits" inputMode="numeric" {...bind('phone')} /></Field>
            </div>
            <button className="btn primary" disabled={busy}>{busy ? 'Placing order…' : 'Place order & pay'}</button>
          </form>
        </Card>
        <Card title="Order summary">
          {c.items.map((i) => <div key={i.skuId} className="inline" style={{ justifyContent: 'space-between' }}><span>{i.title} × {i.quantity}</span><span>{money(i.lineTotalPaise)}</span></div>)}
          <hr />
          <div className="inline" style={{ justifyContent: 'space-between' }}><strong>Subtotal</strong><strong>{money(c.subtotalPaise)}</strong></div>
          <p className="muted">Shipping (per seller) and the final payable total are calculated by the server when the order is placed. Stock is reserved at that point.</p>
        </Card>
      </div>
    </>
  );
}
