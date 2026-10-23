import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, createPublishedProduct, createSeller, registerAndLogin } from './helpers.mjs';

const ORD = '/api/orders';
const add = (customer, skuId, quantity, key = randomUUID()) =>
  api(`${ORD}/cart/items`, { method: 'POST', token: customer.accessToken, headers: { 'Idempotency-Key': key }, body: quantity === undefined ? { skuId } : { skuId, quantity } });
const cart = async (customer) => (await api(`${ORD}/cart`, { token: customer.accessToken })).body;

let seller;
async function sellerFixture() {
  seller ??= await createSeller('cartSeller');
  return seller;
}

test('cart requires authentication and an Idempotency-Key', async () => {
  const s = await sellerFixture();
  const { skuIds } = await createPublishedProduct(s);
  assert.equal((await api(`${ORD}/cart`)).status, 401);
  const c = await registerAndLogin('cartAuth');
  const noKey = await api(`${ORD}/cart/items`, { method: 'POST', token: c.accessToken, body: { skuId: skuIds[0] } });
  assert.equal(noKey.status, 400);
  const shortKey = await add(c, skuIds[0], 1, 'short');
  assert.equal(shortKey.status, 400);
  assert.equal((await add(c, 'not-a-uuid', 1)).status, 400);
});

test('100 DISTINCT concurrent adds of the same SKU -> one cart line, quantity 100', async () => {
  const s = await sellerFixture();
  const { skuIds } = await createPublishedProduct(s);
  const c = await registerAndLogin('cartRace');
  const results = await Promise.all(Array.from({ length: 100 }, () => add(c, skuIds[0])));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.find((r) => r.status !== 200)?.body));
  const view = await cart(c);
  assert.equal(view.items.length, 1, 'exactly one row for the seller/SKU');
  assert.equal(view.items[0].quantity, 100);
  assert.equal(view.items[0].sellerId, s.storeId);
  assert.equal(Math.max(...results.map((r) => r.body.quantity)), 100);
});

test('100 DUPLICATE deliveries of the SAME idempotency key -> one line, quantity 1', async () => {
  const s = await sellerFixture();
  const { skuIds } = await createPublishedProduct(s);
  const c = await registerAndLogin('cartDup');
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 100 }, () => add(c, skuIds[0], undefined, key)));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.find((r) => r.status !== 200)?.body));
  const replays = results.filter((r) => r.headers.get('idempotent-replay') === 'true').length;
  assert.equal(replays, 99, 'one real execution, 99 replays');
  assert.ok(results.every((r) => r.body.quantity === 1), 'every response carries the original result');
  const view = await cart(c);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].quantity, 1);
  // a later sequential retry is still a no-op
  assert.equal((await add(c, skuIds[0], undefined, key)).body.quantity, 1);
  assert.equal((await cart(c)).items[0].quantity, 1);
});

test('mixed load: 100 requests over 10 keys (10 deliveries each) -> quantity 10', async () => {
  const s = await sellerFixture();
  const { skuIds } = await createPublishedProduct(s);
  const c = await registerAndLogin('cartMixed');
  const keys = Array.from({ length: 10 }, () => randomUUID());
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) => add(c, skuIds[0], 1, keys[i % 10])));
  assert.ok(results.every((r) => r.status === 200));
  const view = await cart(c);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].quantity, 10);
});

test('same key with a different payload -> 409 and no change', async () => {
  const s = await sellerFixture();
  const { skuIds } = await createPublishedProduct(s, { variants: 2 });
  const c = await registerAndLogin('cartKey');
  const key = randomUUID();
  assert.equal((await add(c, skuIds[0], 1, key)).status, 200);
  const diffQty = await add(c, skuIds[0], 2, key);
  assert.equal(diffQty.status, 409);
  assert.equal(diffQty.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await add(c, skuIds[1], 1, key)).status, 409, 'different SKU, same key');
  const view = await cart(c);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].quantity, 1);
});

test('keys are scoped per customer', async () => {
  const s = await sellerFixture();
  const { skuIds } = await createPublishedProduct(s);
  const a = await registerAndLogin('cartScopeA');
  const b = await registerAndLogin('cartScopeB');
  const key = randomUUID();
  assert.equal((await add(a, skuIds[0], 1, key)).status, 200);
  const other = await add(b, skuIds[0], 3, key);
  assert.equal(other.status, 200, 'same key text, different customer: independent operation');
  assert.equal(other.body.quantity, 3);
  assert.equal((await cart(a)).items[0].quantity, 1);
  assert.equal((await cart(b)).items[0].quantity, 3);
});

test('variants of one product are distinct lines; quantities are tracked per SKU', async () => {
  const s = await sellerFixture();
  const { skuIds } = await createPublishedProduct(s, { variants: 3 });
  const c = await registerAndLogin('cartVar');
  await Promise.all(skuIds.flatMap((id) => Array.from({ length: 5 }, () => add(c, id))));
  const view = await cart(c);
  assert.equal(view.items.length, 3);
  assert.ok(view.items.every((i) => i.quantity === 5));
  assert.deepEqual(new Set(view.items.map((i) => i.skuId)), new Set(skuIds));
});

test('quantity limit is enforced and leaves the line unchanged', async () => {
  const s = await sellerFixture();
  const { skuIds } = await createPublishedProduct(s);
  const c = await registerAndLogin('cartMax');
  assert.equal((await add(c, skuIds[0], 1001)).status, 422, 'single request above the maximum');
  assert.equal((await add(c, skuIds[0], 0)).status, 422);
  assert.equal((await add(c, skuIds[0], -3)).status, 422);
  assert.equal((await add(c, skuIds[0], 1000)).status, 200);
  const over = await add(c, skuIds[0], 1);
  assert.equal(over.status, 422);
  assert.equal(over.body.error.code, 'QUANTITY_LIMIT_EXCEEDED');
  assert.equal((await cart(c)).items[0].quantity, 1000);
  // the failed attempt did not consume its idempotency key
  const retryKey = randomUUID();
  assert.equal((await add(c, skuIds[0], 1, retryKey)).status, 422);
  assert.equal((await api(`${ORD}/cart/items/${skuIds[0]}`, { method: 'PUT', token: c.accessToken, body: { quantity: 5 } })).status, 204);
  assert.equal((await add(c, skuIds[0], 1, retryKey)).status, 200);
  assert.equal((await cart(c)).items[0].quantity, 6);
});

test('prices come from the catalog; client-supplied prices are ignored; unavailable SKUs rejected', async () => {
  const s = await sellerFixture();
  const { skuIds, productId } = await createPublishedProduct(s, { pricePaise: 25000 });
  const c = await registerAndLogin('cartPrice');
  const tampered = await api(`${ORD}/cart/items`, {
    method: 'POST', token: c.accessToken, headers: { 'Idempotency-Key': randomUUID() },
    body: { skuId: skuIds[0], quantity: 2, pricePaise: 1, price: 1, sellerId: randomUUID() },
  });
  assert.equal(tampered.status, 200);
  let view = await cart(c);
  assert.equal(view.items[0].pricePaise, 25000);
  assert.equal(view.items[0].lineTotalPaise, 50000);
  assert.equal(view.subtotalPaise, 50000);
  assert.equal(view.items[0].sellerId, s.storeId, 'seller comes from the catalog, not the request');

  await api(`/api/catalog/seller/skus/${skuIds[0]}`, { method: 'PUT', token: s.accessToken, body: { name: 'Default', pricePaise: 30000, active: true } });
  view = await cart(c);
  assert.equal(view.items[0].pricePaise, 30000, 'cart reflects the current catalog price');
  assert.equal(view.subtotalPaise, 60000);

  assert.equal((await add(c, randomUUID(), 1)).status, 422, 'unknown SKU');
  const draft = await api('/api/catalog/seller/products', { method: 'POST', token: s.accessToken, body: { title: 'Draft item', categorySlug: 'audio', skuCode: `D-${randomUUID().slice(0, 8)}`, pricePaise: 100 } });
  assert.equal((await add(c, draft.body.product.skus[0].id, 1)).status, 422, 'draft product is not purchasable');

  await api(`/api/catalog/seller/products/${productId}/status`, { method: 'POST', token: s.accessToken, body: { status: 'ARCHIVED' } });
  view = await cart(c);
  assert.equal(view.items[0].purchasable, false);
  assert.equal(view.subtotalPaise, 0, 'unavailable lines are excluded from the subtotal');
});

test('update quantity, remove item, clear cart; carts are private', async () => {
  const s = await sellerFixture();
  const { skuIds } = await createPublishedProduct(s, { variants: 2 });
  const a = await registerAndLogin('cartEditA');
  const b = await registerAndLogin('cartEditB');
  await add(a, skuIds[0], 2);
  await add(a, skuIds[1], 2);

  assert.equal((await api(`${ORD}/cart/items/${skuIds[0]}`, { method: 'PUT', token: a.accessToken, body: { quantity: 7 } })).status, 204);
  assert.equal((await api(`${ORD}/cart/items/${skuIds[0]}`, { method: 'PUT', token: a.accessToken, body: { quantity: 7 } })).status, 204, 'idempotent');
  assert.equal((await api(`${ORD}/cart/items/${skuIds[0]}`, { method: 'PUT', token: a.accessToken, body: { quantity: 0 } })).status, 400);
  assert.equal((await api(`${ORD}/cart/items/${skuIds[0]}`, { method: 'PUT', token: a.accessToken, body: { quantity: 5000 } })).status, 422);
  assert.equal((await api(`${ORD}/cart/items/${randomUUID()}`, { method: 'PUT', token: a.accessToken, body: { quantity: 1 } })).status, 404);
  assert.equal((await cart(a)).items.find((i) => i.skuId === skuIds[0]).quantity, 7);

  assert.equal((await cart(b)).items.length, 0, "customer B cannot see A's cart");
  assert.equal((await api(`${ORD}/cart/items/${skuIds[0]}`, { method: 'PUT', token: b.accessToken, body: { quantity: 1 } })).status, 404, "B cannot edit A's line");

  assert.equal((await api(`${ORD}/cart/items/${skuIds[1]}`, { method: 'DELETE', token: a.accessToken })).status, 204);
  assert.equal((await api(`${ORD}/cart/items/${skuIds[1]}`, { method: 'DELETE', token: a.accessToken })).status, 204, 'idempotent');
  assert.equal((await cart(a)).items.length, 1);
  assert.equal((await api(`${ORD}/cart`, { method: 'DELETE', token: a.accessToken })).status, 204);
  assert.equal((await cart(a)).items.length, 0);
});

test('items from several sellers can share one cart as separate lines', async () => {
  const s1 = await sellerFixture();
  const s2 = await createSeller('cartSeller2');
  const p1 = await createPublishedProduct(s1);
  const p2 = await createPublishedProduct(s2);
  const c = await registerAndLogin('cartMulti');
  await Promise.all([add(c, p1.skuIds[0], 2), add(c, p2.skuIds[0], 3)]);
  const view = await cart(c);
  assert.equal(view.items.length, 2);
  assert.deepEqual(new Set(view.items.map((i) => i.sellerId)), new Set([s1.storeId, s2.storeId]));
});
