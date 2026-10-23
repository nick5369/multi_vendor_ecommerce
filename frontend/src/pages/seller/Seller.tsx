import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, CAT, INV, newKey, ORD, PAY, post, put, type Category, type OrderGroup, type Page, type SellerProduct } from '../../api';
import { Badge, Card, Field, Msg, Pager } from '../../components/ui';
import { errMsg, fmtDate, money, paiseToRupees, rupeesToPaise } from '../../util';

export function SellerShell() {
  return (
    <>
      <h1>Seller dashboard</h1>
      <div className="tabs">
        <NavLink end to="/seller">Products</NavLink>
        <NavLink to="/seller/new">New product</NavLink>
        <NavLink to="/seller/orders">Orders</NavLink>
      </div>
      <Outlet />
    </>
  );
}

interface Balance { skuId: string; onHand: number; reserved: number; available: number }

export function SellerProducts() {
  const [page, setPage] = useState(0);
  const q = useQuery({ queryKey: ['seller-products', page], queryFn: () => api<Page<SellerProduct>>(`${CAT}/seller/products?page=${page}&size=20`) });
  return (
    <>
      <Msg error={q.error ? errMsg(q.error) : null} />
      {q.data?.items.length === 0 && <p>No products yet. <Link to="/seller/new">Create your first one</Link>.</p>}
      {q.data && q.data.items.length > 0 && (
        <Card>
          <div className="scroll"><table>
            <thead><tr><th>Product</th><th>From</th><th>Status</th><th>Moderation</th></tr></thead>
            <tbody>{q.data.items.map((p) => (
              <tr key={p.product.id}>
                <td><Link to={`/seller/products/${p.product.id}`}>{p.product.title}</Link></td>
                <td>{money(p.product.minPricePaise)}</td>
                <td><Badge status={p.status} /></td>
                <td><Badge status={p.moderation} />{p.moderationReason && <div className="muted">{p.moderationReason}</div>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
      )}
      {q.data && <Pager page={page} size={q.data.size} total={q.data.total} onPage={setPage} />}
    </>
  );
}

interface VariantRow { skuCode: string; name: string; price: string }

export function NewProduct() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>(`${CAT}/categories`, { auth: false }) });
  const [f, setF] = useState({ title: '', description: '', categorySlug: '', skuCode: '', price: '', imageUrl: '', stock: '10', status: 'ACTIVE' });
  const [variants, setVariants] = useState<VariantRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    const body: Record<string, unknown> = { title: f.title, description: f.description, categorySlug: f.categorySlug, status: f.status };
    const stockQty = Number(f.stock);
    if (!Number.isInteger(stockQty) || stockQty < 0) return setErr('Stock must be a whole number ≥ 0');
    if (f.imageUrl) body.images = [{ url: f.imageUrl, alt: f.title, position: 0 }];
    if (variants.length) {
      const vs = variants.map((v) => ({ skuCode: v.skuCode, name: v.name, pricePaise: rupeesToPaise(v.price) }));
      if (vs.some((v) => v.pricePaise === null || v.pricePaise < 1)) return setErr('Every variant needs a valid price like 499 or 499.50');
      body.variants = vs;
    } else {
      const paise = rupeesToPaise(f.price);
      if (paise === null || paise < 1) return setErr('Enter a valid price like 499 or 499.50');
      body.skuCode = f.skuCode; body.pricePaise = paise;
    }
    setBusy(true);
    try {
      const created = await post<SellerProduct>(`${CAT}/seller/products`, body);
      // stock lives in the inventory service; a failure here leaves a product with 0 stock, which the seller can fix on the next page
      let warning = '';
      for (const sku of created.product.skus) {
        try { await put(`${INV}/seller/stock/${sku.id}`, { onHand: stockQty }); } catch (e2) { warning = errMsg(e2); }
      }
      void qc.invalidateQueries({ queryKey: ['seller-products'] });
      nav(`/seller/products/${created.product.id}`, { state: warning ? { warning: `Product created, but setting stock failed: ${warning}` } : undefined });
    } catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const setV = (i: number, k: keyof VariantRow, v: string) => setVariants(variants.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Card title="New product">
      <form className="form" style={{ maxWidth: 560 }} onSubmit={submit}>
        <Msg error={err} />
        <Field label="Title"><input required maxLength={200} value={f.title} onChange={set('title')} /></Field>
        <Field label="Description"><textarea rows={3} maxLength={5000} value={f.description} onChange={set('description')} /></Field>
        <div className="row">
          <Field label="Category"><select required value={f.categorySlug} onChange={set('categorySlug')}><option value="">Select…</option>{cats.data?.map((c) => <option key={c.id} value={c.slug}>{c.name}</option>)}</select></Field>
          <Field label="Status"><select value={f.status} onChange={set('status')}><option value="ACTIVE">Active (visible)</option><option value="DRAFT">Draft</option></select></Field>
        </div>
        <Field label="Image URL (https)"><input type="url" value={f.imageUrl} onChange={set('imageUrl')} /></Field>
        {variants.length === 0 ? (
          <div className="row">
            <Field label="SKU code"><input required pattern="[A-Za-z0-9._-]{1,64}" value={f.skuCode} onChange={set('skuCode')} /></Field>
            <Field label="Price (₹)"><input required inputMode="decimal" value={f.price} onChange={set('price')} /></Field>
          </div>
        ) : variants.map((v, i) => (
          <div className="row" key={i}>
            <Field label="Variant name"><input required value={v.name} onChange={(e) => setV(i, 'name', e.target.value)} /></Field>
            <Field label="SKU code"><input required pattern="[A-Za-z0-9._-]{1,64}" value={v.skuCode} onChange={(e) => setV(i, 'skuCode', e.target.value)} /></Field>
            <Field label="Price (₹)"><input required inputMode="decimal" value={v.price} onChange={(e) => setV(i, 'price', e.target.value)} /></Field>
            <button type="button" className="btn small" onClick={() => setVariants(variants.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <p><button type="button" className="btn small" onClick={() => setVariants([...variants, { skuCode: '', name: '', price: '' }])}>+ Add variant</button></p>
        <Field label="Initial stock per SKU"><input type="number" min={0} value={f.stock} onChange={set('stock')} /></Field>
        <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create product'}</button>
      </form>
    </Card>
  );
}

export function SellerProductDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['seller-product', id], queryFn: () => api<SellerProduct>(`${CAT}/seller/products/${id}`) });
  const stock = useQuery({ queryKey: ['seller-stock'], queryFn: () => api<Page<Balance>>(`${INV}/seller/stock?size=100`) });
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>(`${CAT}/categories`, { auth: false }) });
  const warning = (useLocation().state as { warning?: string } | null)?.warning;
  const [msg, setMsg] = useState<{ err?: string; ok?: string }>(warning ? { err: warning } : {});
  const reload = () => { void qc.invalidateQueries({ queryKey: ['seller-product', id] }); void qc.invalidateQueries({ queryKey: ['seller-stock'] }); void qc.invalidateQueries({ queryKey: ['seller-products'] }); };
  const run = async (fn: () => Promise<unknown>, ok: string) => { setMsg({}); try { await fn(); setMsg({ ok }); reload(); } catch (e) { setMsg({ err: errMsg(e) }); } };

  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (!q.data) return <Msg error={errMsg(q.error)} />;
  const sp = q.data;
  const p = sp.product;
  const balance = (skuId: string) => stock.data?.items.find((b) => b.skuId === skuId);
  return (
    <>
      <p><Link to="/seller">← Products</Link></p>
      <h2>{p.title} <Badge status={sp.status} /> <Badge status={sp.moderation} /></h2>
      <Msg error={msg.err} ok={msg.ok} />
      {sp.moderation === 'SUSPENDED' && <Msg error={`Suspended by an admin${sp.moderationReason ? `: ${sp.moderationReason}` : ''}. It is not visible to shoppers.`} />}
      <Card title="Visibility">
        <div className="inline">
          {['ACTIVE', 'DRAFT', 'ARCHIVED'].map((s) => (
            <button key={s} className="btn" disabled={sp.status === s} onClick={() => run(() => post(`${CAT}/seller/products/${p.id}/status`, { status: s }), `Status set to ${s}`)}>{s}</button>
          ))}
        </div>
      </Card>
      <Card title="Details"><DetailsForm p={p} cats={cats.data ?? []} onSave={(b) => run(() => put(`${CAT}/seller/products/${p.id}`, b), 'Saved')} /></Card>
      <Card title="SKUs, prices and stock">
        {p.skus.map((s) => <SkuRow key={s.id} sku={s} balance={balance(s.id)} run={run} />)}
      </Card>
    </>
  );
}

function DetailsForm({ p, cats, onSave }: { p: SellerProduct['product']; cats: Category[]; onSave(b: object): void }) {
  const [t, setT] = useState(p.title);
  const [d, setD] = useState(p.description ?? '');
  const [c, setC] = useState(p.categorySlug);
  return (
    <form className="form" style={{ maxWidth: 560 }} onSubmit={(e) => { e.preventDefault(); onSave({ title: t, description: d, categorySlug: c }); }}>
      <Field label="Title"><input required value={t} onChange={(e) => setT(e.target.value)} /></Field>
      <Field label="Description"><textarea rows={3} value={d} onChange={(e) => setD(e.target.value)} /></Field>
      <Field label="Category"><select value={c} onChange={(e) => setC(e.target.value)}>{cats.map((x) => <option key={x.id} value={x.slug}>{x.name}</option>)}</select></Field>
      <button className="btn">Save details</button>
    </form>
  );
}

function SkuRow({ sku, balance, run }: { sku: SellerProduct['product']['skus'][number]; balance?: Balance; run(fn: () => Promise<unknown>, ok: string): Promise<void> }) {
  const [name, setName] = useState(sku.name);
  const [price, setPrice] = useState(paiseToRupees(sku.pricePaise));
  const [onHand, setOnHand] = useState(String(balance?.onHand ?? 0));
  const [err, setErr] = useState<string | null>(null);
  return (
    <div style={{ borderBottom: '1px solid var(--line)', padding: '10px 0' }}>
      <strong>{sku.skuCode}</strong> <span className="muted">· on hand {balance?.onHand ?? 0}, reserved {balance?.reserved ?? 0}, available {balance?.available ?? 0}</span>
      <Msg error={err} />
      <div className="inline">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="SKU name" />
        <input className="qty" style={{ width: 110 }} value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Price in rupees" />
        <button className="btn small" onClick={() => {
          const paise = rupeesToPaise(price);
          if (paise === null || paise < 1) return setErr('Invalid price');
          setErr(null);
          void run(() => put(`${CAT}/seller/skus/${sku.id}`, { name, pricePaise: paise, attributes: sku.attributes ?? {}, active: true }), 'SKU updated');
        }}>Save price</button>
        <input className="qty" type="number" min={0} value={onHand} onChange={(e) => setOnHand(e.target.value)} aria-label="Stock on hand" />
        <button className="btn small" onClick={() => {
          const n = Number(onHand);
          if (!Number.isInteger(n) || n < 0) return setErr('Stock must be a whole number ≥ 0');
          setErr(null);
          void run(() => put(`${INV}/seller/stock/${sku.id}`, { onHand: n, reason: 'seller update' }), 'Stock updated');
        }}>Set stock</button>
      </div>
    </div>
  );
}

const NEXT: Record<string, string> = { CONFIRMED: 'PROCESSING', PROCESSING: 'SHIPPED', SHIPPED: 'DELIVERED' };

export function SellerOrders() {
  const [page, setPage] = useState(0);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['seller-orders', page], queryFn: () => api<Page<OrderGroup>>(`${ORD}/seller/orders?page=${page}&size=10`) });
  const [msg, setMsg] = useState<{ err?: string; ok?: string }>({});
  const advance = useMutation({
    mutationFn: (v: { groupId: string; status: string }) => post(`${ORD}/seller/orders/${v.groupId}/status`, { status: v.status }),
    onSuccess: () => { setMsg({ ok: 'Updated' }); void qc.invalidateQueries({ queryKey: ['seller-orders'] }); },
    onError: (e) => setMsg({ err: errMsg(e) }),
  });
  const refund = async (g: OrderGroup) => {
    const raw = window.prompt(`Refund amount in ₹ for this order's share (max ${money(g.totalPaise - g.refundedPaise)}). Leave empty to refund everything still refundable.`);
    if (raw === null) return;
    const body: Record<string, unknown> = { orderId: g.orderId, reason: 'seller refund' };
    if (raw.trim()) { const p = rupeesToPaise(raw); if (p === null || p < 100) return setMsg({ err: 'Minimum refund is ₹1.00' }); body.amountPaise = p; }
    try { const r = await post(`${PAY}/refunds`, body, { 'Idempotency-Key': newKey() }); setMsg({ ok: `Refund requested (${r?.status ?? 'ok'})` }); void qc.invalidateQueries({ queryKey: ['seller-orders'] }); } catch (e) { setMsg({ err: errMsg(e) }); }
  };
  return (
    <>
      <p className="muted">Only paid orders appear here, and only your own items.</p>
      <Msg error={msg.err} ok={msg.ok} />
      {q.data?.items.length === 0 && <p>No paid orders yet.</p>}
      {q.data?.items.map((g) => (
        <Card key={g.groupId} title={`Order ${g.orderId?.slice(0, 8)} · ${fmtDate(g.createdAt)}`} actions={<Badge status={g.status} />}>
          <table><tbody>
            {g.items.map((i) => <tr key={i.skuId}><td>{i.title}{i.skuName !== 'Default' ? ` — ${i.skuName}` : ''}</td><td>{i.quantity} × {money(i.unitPricePaise)}</td><td className="right">{money(i.lineTotalPaise)}</td></tr>)}
            <tr className="total"><td colSpan={2} className="right">Your share (incl. shipping)</td><td className="right">{money(g.totalPaise)}</td></tr>
          </tbody></table>
          {g.shippingAddress && <p className="muted">Ship to: {g.shippingAddress.name}, {g.shippingAddress.line1}{g.shippingAddress.line2 ? `, ${g.shippingAddress.line2}` : ''}, {g.shippingAddress.city}, {g.shippingAddress.state} {g.shippingAddress.pincode} · {g.shippingAddress.phone}</p>}
          <div className="inline">
            {NEXT[g.status] && <button className="btn primary" disabled={advance.isPending} onClick={() => advance.mutate({ groupId: g.groupId, status: NEXT[g.status] })}>Mark {NEXT[g.status].toLowerCase()}</button>}
            {g.refundedPaise < g.totalPaise && <button className="btn" onClick={() => refund(g)}>Refund…</button>}
            {g.refundedPaise > 0 && <span className="muted">Refunded {money(g.refundedPaise)}</span>}
          </div>
        </Card>
      ))}
      {q.data && <Pager page={page} size={q.data.size} total={q.data.total} onPage={setPage} />}
    </>
  );
}
