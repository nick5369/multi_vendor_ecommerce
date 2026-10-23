import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, adminLogin, createSeller, registerAndLogin, suffix } from './helpers.mjs';

const CATALOG = '/api/catalog';

async function createProduct(seller, overrides = {}) {
  const s = suffix();
  const res = await api(`${CATALOG}/seller/products`, {
    method: 'POST',
    token: seller.accessToken,
    body: { title: `Test Product ${s}`, description: 'desc', categorySlug: 'audio', skuCode: `SKU-${s}`, pricePaise: 49900, ...overrides },
  });
  return res;
}

test('public categories are readable; seller/admin routes reject anonymous and customers', async () => {
  const cats = await api(`${CATALOG}/categories`);
  assert.equal(cats.status, 200);
  assert.ok(cats.body.some((c) => c.slug === 'electronics'));
  const customer = await registerAndLogin('cust');
  assert.equal((await api(`${CATALOG}/seller/products`)).status, 401);
  assert.equal((await api(`${CATALOG}/seller/products`, { token: customer.accessToken })).status, 403);
  assert.equal((await api(`${CATALOG}/admin/products`, { token: customer.accessToken })).status, 403);
});

test('default SKU for no-variant products; drafts are hidden until published', async () => {
  const seller = await createSeller('catA');
  const created = await createProduct(seller);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { product, status } = created.body;
  assert.equal(status, 'DRAFT');
  assert.equal(product.skus.length, 1);
  assert.equal(product.skus[0].isDefault, true);
  assert.equal(product.skus[0].pricePaise, 49900);
  assert.equal(product.currency, 'INR');
  assert.equal(product.sellerId, seller.storeId);

  assert.equal((await api(`${CATALOG}/products/${product.id}`)).status, 404, 'draft not public');
  const pub = await api(`${CATALOG}/seller/products/${product.id}/status`, { method: 'POST', token: seller.accessToken, body: { status: 'ACTIVE' } });
  assert.equal(pub.status, 200);
  const detail = await api(`${CATALOG}/products/${product.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.title, product.title);
});

test('price validation: integer paise only, > 0, bounded', async () => {
  const seller = await createSeller('catPrice');
  for (const bad of [0, -100, 1.5, 100000001, '500']) {
    const res = await createProduct(seller, { pricePaise: bad });
    assert.equal(res.status, 400, `pricePaise=${JSON.stringify(bad)} -> ${res.status}`);
  }
  assert.equal((await createProduct(seller, { skuCode: 'bad code!' })).status, 400);
  assert.equal((await createProduct(seller, { categorySlug: 'nope' })).status, 400);
  assert.equal((await createProduct(seller, { pricePaise: undefined })).status, 400, 'default SKU needs a price');
});

test('seller A cannot read or modify seller B resources', async () => {
  const a = await createSeller('ownerA');
  const b = await createSeller('ownerB');
  const prod = (await createProduct(a)).body.product;
  const sku = prod.skus[0].id;

  const attempts = [
    api(`${CATALOG}/seller/products/${prod.id}`, { token: b.accessToken }),
    api(`${CATALOG}/seller/products/${prod.id}`, { method: 'PUT', token: b.accessToken, body: { title: 'hijack', description: '', categorySlug: 'audio' } }),
    api(`${CATALOG}/seller/products/${prod.id}/status`, { method: 'POST', token: b.accessToken, body: { status: 'ACTIVE' } }),
    api(`${CATALOG}/seller/skus/${sku}`, { method: 'PUT', token: b.accessToken, body: { name: 'x', pricePaise: 1, active: true } }),
    api(`${CATALOG}/seller/products/${prod.id}/images`, { method: 'POST', token: b.accessToken, body: { url: 'https://example.com/a.png', position: 0 } }),
  ];
  for (const r of await Promise.all(attempts)) assert.equal(r.status, 404);

  const own = await api(`${CATALOG}/seller/products/${prod.id}`, { token: a.accessToken });
  assert.equal(own.status, 200);
  assert.equal(own.body.product.title, prod.title, 'unchanged');
  const listB = await api(`${CATALOG}/seller/products?size=100`, { token: b.accessToken });
  assert.ok(!listB.body.items.some((i) => i.product.id === prod.id));
});

test('variants: distinct SKU ids, no default, sku codes unique per seller', async () => {
  const seller = await createSeller('variants');
  const s = suffix();
  const res = await api(`${CATALOG}/seller/products`, {
    method: 'POST', token: seller.accessToken,
    body: {
      title: `Shirt ${s}`, categorySlug: 'fashion',
      variants: [
        { skuCode: `S-${s}`, name: 'Small', pricePaise: 79900, attributes: { size: 'S' } },
        { skuCode: `M-${s}`, name: 'Medium', pricePaise: 89900, attributes: { size: 'M' } },
      ],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const skus = res.body.product.skus;
  assert.equal(skus.length, 2);
  assert.notEqual(skus[0].id, skus[1].id);
  assert.ok(skus.every((k) => k.isDefault === false));
  assert.equal(res.body.product.minPricePaise, 79900);

  const dup = await createProduct(seller, { skuCode: `S-${s}` });
  assert.equal(dup.status, 409, 'same seller cannot reuse a sku code');
  const dupInReq = await api(`${CATALOG}/seller/products`, {
    method: 'POST', token: seller.accessToken,
    body: { title: 'x', categorySlug: 'fashion', variants: [{ skuCode: 'D1', name: 'a', pricePaise: 100 }, { skuCode: 'D1', name: 'b', pricePaise: 100 }] },
  });
  assert.equal(dupInReq.status, 400);

  const other = await createSeller('variants2');
  assert.equal((await createProduct(other, { skuCode: `S-${s}` })).status, 201, 'another seller may reuse the code');

  const added = await api(`${CATALOG}/seller/products/${res.body.product.id}/variants`, {
    method: 'POST', token: seller.accessToken, body: { skuCode: `L-${s}`, name: 'Large', pricePaise: 99900 },
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.product.skus.length, 3);

  const single = (await createProduct(seller)).body.product;
  const noVariant = await api(`${CATALOG}/seller/products/${single.id}/variants`, {
    method: 'POST', token: seller.accessToken, body: { skuCode: `X-${suffix()}`, name: 'x', pricePaise: 100 },
  });
  assert.equal(noVariant.status, 409, 'default-SKU product cannot grow variants');
});

test('search: category, text, price range, sorting and pagination', async () => {
  const seller = await createSeller('search');
  const tag = `zq${suffix()}`;
  const prices = [30000, 10000, 20000];
  const ids = [];
  for (const [i, price] of prices.entries()) {
    const p = (await createProduct(seller, { title: `${tag} widget ${i}`, pricePaise: price })).body.product;
    await api(`${CATALOG}/seller/products/${p.id}/status`, { method: 'POST', token: seller.accessToken, body: { status: 'ACTIVE' } });
    ids.push(p.id);
  }
  const asc = await api(`${CATALOG}/products?q=${tag}&category=audio&sort=price_asc`);
  assert.equal(asc.status, 200);
  assert.deepEqual(asc.body.items.map((i) => i.minPricePaise), [10000, 20000, 30000]);
  const desc = await api(`${CATALOG}/products?q=${tag}&sort=price_desc`);
  assert.deepEqual(desc.body.items.map((i) => i.minPricePaise), [30000, 20000, 10000]);

  const range = await api(`${CATALOG}/products?q=${tag}&minPrice=15000&maxPrice=25000`);
  assert.deepEqual(range.body.items.map((i) => i.minPricePaise), [20000]);

  const p0 = await api(`${CATALOG}/products?q=${tag}&sort=price_asc&size=2&page=0`);
  const p1 = await api(`${CATALOG}/products?q=${tag}&sort=price_asc&size=2&page=1`);
  assert.equal(p0.body.total, 3);
  assert.equal(p0.body.items.length, 2);
  assert.equal(p1.body.items.length, 1);

  const parent = await api(`${CATALOG}/products?q=${tag}&category=electronics`);
  assert.equal(parent.body.total, 3, 'parent category includes child category products');
  const other = await api(`${CATALOG}/products?q=${tag}&category=books`);
  assert.equal(other.body.total, 0);
  const mine = await api(`${CATALOG}/products?q=${tag}&seller=${seller.storeId}`);
  assert.equal(mine.body.total, 3);

  assert.equal((await api(`${CATALOG}/products?size=1000`)).status, 400);
  assert.equal((await api(`${CATALOG}/products?sort=bogus`)).status, 400);
  assert.equal((await api(`${CATALOG}/products?minPrice=10&maxPrice=5`)).status, 400);
  // LIKE wildcards in user input are literals
  assert.equal((await api(`${CATALOG}/products?q=${encodeURIComponent('%')}`)).body.total, 0);
});

test('cached reads are invalidated after an update', async () => {
  const seller = await createSeller('cache');
  const tag = `cache${suffix()}`;
  const p = (await createProduct(seller, { title: `${tag} before` })).body.product;
  await api(`${CATALOG}/seller/products/${p.id}/status`, { method: 'POST', token: seller.accessToken, body: { status: 'ACTIVE' } });

  assert.equal((await api(`${CATALOG}/products/${p.id}`)).body.title, `${tag} before`);
  assert.equal((await api(`${CATALOG}/products/${p.id}`)).body.title, `${tag} before`, 'second read served from cache');
  assert.equal((await api(`${CATALOG}/products?q=${tag}`)).body.items[0].title, `${tag} before`);

  const upd = await api(`${CATALOG}/seller/products/${p.id}`, { method: 'PUT', token: seller.accessToken, body: { title: `${tag} after`, description: '', categorySlug: 'audio' } });
  assert.equal(upd.status, 200);
  assert.equal((await api(`${CATALOG}/products/${p.id}`)).body.title, `${tag} after`);
  assert.equal((await api(`${CATALOG}/products?q=${tag}`)).body.items[0].title, `${tag} after`);

  const sku = p.skus[0].id;
  await api(`${CATALOG}/seller/skus/${sku}`, { method: 'PUT', token: seller.accessToken, body: { name: 'Default', pricePaise: 12345, active: true } });
  assert.equal((await api(`${CATALOG}/products/${p.id}`)).body.minPricePaise, 12345);

  await api(`${CATALOG}/seller/products/${p.id}/status`, { method: 'POST', token: seller.accessToken, body: { status: 'ARCHIVED' } });
  assert.equal((await api(`${CATALOG}/products/${p.id}`)).status, 404, 'archived product leaves the cache path too');
});

test('admin moderation hides a product from the public', async () => {
  const seller = await createSeller('moderated');
  const admin = await adminLogin();
  const p = (await createProduct(seller)).body.product;
  await api(`${CATALOG}/seller/products/${p.id}/status`, { method: 'POST', token: seller.accessToken, body: { status: 'ACTIVE' } });
  assert.equal((await api(`${CATALOG}/products/${p.id}`)).status, 200);

  const bad = await api(`${CATALOG}/admin/products/${p.id}/moderation`, { method: 'POST', token: seller.accessToken, body: { status: 'SUSPENDED' } });
  assert.equal(bad.status, 403, 'seller cannot moderate');
  const ok = await api(`${CATALOG}/admin/products/${p.id}/moderation`, { method: 'POST', token: admin.accessToken, body: { status: 'SUSPENDED', reason: 'policy' } });
  assert.equal(ok.status, 200);
  assert.equal((await api(`${CATALOG}/products/${p.id}`)).status, 404);
  const own = await api(`${CATALOG}/seller/products/${p.id}`, { token: seller.accessToken });
  assert.equal(own.body.moderation, 'SUSPENDED');
  await api(`${CATALOG}/admin/products/${p.id}/moderation`, { method: 'POST', token: admin.accessToken, body: { status: 'APPROVED' } });
  assert.equal((await api(`${CATALOG}/products/${p.id}`)).status, 200);
});

test('suspended store loses seller access on next login', async () => {
  const seller = await createSeller('suspend');
  const ok = await createProduct(seller);
  assert.equal(ok.status, 201);
  await api(`/api/auth/admin/stores/${seller.storeId}/status`, { method: 'POST', token: seller.admin.accessToken, body: { status: 'SUSPENDED' } });
  const relogin = await api('/api/auth/login', { method: 'POST', body: { email: seller.email, password: 'E2e-Password-12345' } });
  const res = await api(`${CATALOG}/seller/products`, { token: relogin.body.accessToken });
  assert.equal(res.status, 403);
});

test('internal SKU lookup needs the service token and is blocked at the gateway', async () => {
  const seller = await createSeller('internal');
  const p = (await createProduct(seller)).body.product;
  const body = { ids: [p.skus[0].id] };
  assert.equal((await api(`${CATALOG}/internal/skus/lookup`, { method: 'POST', body })).status, 403, 'gateway blocks it');
  const direct = 'http://catalog-service:8082/internal/skus/lookup';
  const noToken = await fetch(direct, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(noToken.status, 403);
  const wrong = await fetch(direct, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'nope' }, body: JSON.stringify(body) });
  assert.equal(wrong.status, 403);
  const ok = await fetch(direct, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN }, body: JSON.stringify(body) });
  assert.equal(ok.status, 200);
  const [view] = await ok.json();
  assert.equal(view.skuId, p.skus[0].id);
  assert.equal(view.sellerId, seller.storeId);
  assert.equal(view.pricePaise, 49900);
  assert.equal(view.purchasable, false, 'draft product is not purchasable');
});

test('error envelope and security headers', async () => {
  const res = await api(`${CATALOG}/products/not-a-uuid`);
  assert.equal(res.status, 400);
  assert.ok(res.body.error.requestId);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await api(`${CATALOG}/products/00000000-0000-4000-8000-000000000000`)).status, 404);
});
