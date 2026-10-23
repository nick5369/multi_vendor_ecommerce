import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, CAT, INV, newKey, ORD, post, type Category, type Page, type Product, type ProductSummary } from '../api';
import { useAuth } from '../auth';
import { Msg, Pager } from '../components/ui';
import { errMsg, money } from '../util';

export function Home() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const sort = params.get('sort') ?? '';
  const page = Number(params.get('page') ?? 0);
  const [text, setText] = useState(q);
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setParams(n); };

  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>(`${CAT}/categories`, { auth: false }) });
  const qs = new URLSearchParams({ page: String(page), size: '12' });
  if (q) qs.set('q', q);
  if (category) qs.set('category', category);
  if (sort) qs.set('sort', sort);
  const list = useQuery({ queryKey: ['products', qs.toString()], queryFn: () => api<Page<ProductSummary>>(`${CAT}/products?${qs}`, { auth: false }) });

  const top = cats.data?.filter((c) => !c.parentId) ?? [];
  return (
    <>
      <section className="hero">
        <h1>Find something you'll love</h1>
        <p>Products from independent sellers across India, in one simple checkout.</p>
        <form onSubmit={(e) => { e.preventDefault(); set('q', text.trim()); }}>
          <input placeholder="Search products…" aria-label="Search products" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn">Search</button>
        </form>
      </section>
      <div className="chips" role="group" aria-label="Categories">
        <button className={`chip${category ? '' : ' on'}`} onClick={() => set('category', '')}>All</button>
        {top.map((c) => <button key={c.id} className={`chip${category === c.slug ? ' on' : ''}`} onClick={() => set('category', c.slug)}>{c.name}</button>)}
        <select value={sort} onChange={(e) => set('sort', e.target.value)} aria-label="Sort" style={{ marginLeft: 'auto' }}>
          <option value="">Newest</option><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option>
        </select>
      </div>
      {list.isLoading && <div className="grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton" />)}</div>}
      <Msg error={list.error ? errMsg(list.error) : null} />
      {list.data && list.data.items.length === 0 && <div className="empty"><span className="big">🔍</span>No products match your search.</div>}
      <div className="grid">
        {list.data?.items.map((p) => (
          <Link key={p.id} to={`/product/${p.id}`} className="tile">
            <div className="ph">{p.imageUrl ? <img src={p.imageUrl} alt={p.title} loading="lazy" /> : <span aria-hidden>🛍️</span>}</div>
            <div className="body"><strong>{p.title}</strong><span className="price">from {money(p.minPricePaise)}</span></div>
          </Link>
        ))}
      </div>
      {list.data && <Pager page={page} size={list.data.size} total={list.data.total} onPage={(p) => set('page', String(p))} />}
    </>
  );
}

export function ProductPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const product = useQuery({ queryKey: ['product', id], queryFn: () => api<Product>(`${CAT}/products/${id}`, { auth: false }) });
  const skuIds = product.data?.skus.map((s) => s.id).join(',');
  const stock = useQuery({
    queryKey: ['stock', skuIds], enabled: !!skuIds,
    queryFn: () => api<{ skuId: string; available: number }[]>(`${INV}/stock?skuIds=${skuIds}`, { auth: false }),
  });
  const [skuId, setSkuId] = useState<string>('');
  const [qty, setQty] = useState(1);
  const [msg, setMsg] = useState<{ err?: string; ok?: string }>({});

  const add = useMutation({
    mutationFn: (sku: string) => post(`${ORD}/cart/items`, { skuId: sku, quantity: qty }, { 'Idempotency-Key': newKey() }),
    onSuccess: () => { setMsg({ ok: 'Added to cart.' }); void qc.invalidateQueries({ queryKey: ['cart'] }); },
    onError: (e) => setMsg({ err: errMsg(e) }),
  });

  if (product.isLoading) return <p className="muted">Loading…</p>;
  if (product.error || !product.data) return <Msg error={product.error ? errMsg(product.error) : 'Not found'} />;
  const p = product.data;
  const sku = p.skus.find((s) => s.id === skuId) ?? p.skus[0];
  const available = stock.data?.find((s) => s.skuId === sku?.id)?.available;
  const canBuy = !user || user.roles.includes('CUSTOMER');

  return (
    <div className="detail">
      <div>{p.images[0] ? <img src={p.images[0].url} alt={p.images[0].alt || p.title} /> : <div className="card empty"><span className="big">🛍️</span>No image</div>}</div>
      <div>
        <h1>{p.title}</h1>
        <p className="muted">Category: {p.categorySlug}</p>
        <p>{p.description}</p>
        {p.skus.length > 1 && (
          <div className="field"><span>Option</span>
            <select value={sku?.id} onChange={(e) => setSkuId(e.target.value)}>
              {p.skus.map((s) => <option key={s.id} value={s.id}>{s.name} — {money(s.pricePaise)}</option>)}
            </select>
          </div>
        )}
        {sku && <p className="bigprice">{money(sku.pricePaise)}</p>}
        {available !== undefined && <p className={available > 0 ? 'muted' : 'error'}>{available > 0 ? `${available} in stock (approximate — confirmed at checkout)` : 'Out of stock'}</p>}
        <Msg error={msg.err} ok={msg.ok} />
        {canBuy ? (
          <div className="inline">
            <input className="qty" type="number" min={1} max={99} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))} aria-label="Quantity" />
            <button className="btn primary" disabled={add.isPending || !sku} onClick={() => { if (!user) { nav('/login', { state: { from: `/product/${p.id}` } }); return; } setMsg({}); add.mutate(sku!.id); }}>
              {add.isPending ? 'Adding…' : 'Add to cart'}
            </button>
            {msg.ok && <Link to="/cart" className="btn">Go to cart</Link>}
          </div>
        ) : <p className="muted">Switch to a customer account to buy.</p>}
      </div>
    </div>
  );
}
