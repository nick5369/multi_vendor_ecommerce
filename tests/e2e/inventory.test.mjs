import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { adminLogin, api, createPublishedProduct, createSeller, internal, registerAndLogin, setStock } from './helpers.mjs';

const INV = '/api/inventory';
const reserve = (checkoutId, items, ttlSeconds) => internal('inventory', '/internal/reservations', { method: 'POST', body: { checkoutId, items, ttlSeconds } });
const skuState = async (seller, skuId) => (await api(`${INV}/seller/stock?size=100`, { token: seller.accessToken })).body.items.find((i) => i.skuId === skuId);

test('seller stock: ownership is verified against the catalog, roles enforced', async () => {
  const a = await createSeller('invA');
  const b = await createSeller('invB');
  const customer = await registerAndLogin('invCust');
  const { skuIds } = await createPublishedProduct(a);

  assert.equal((await api(`${INV}/seller/stock`)).status, 401);
  assert.equal((await api(`${INV}/seller/stock`, { token: customer.accessToken })).status, 403);
  assert.equal((await setStock(b, skuIds[0], 10)).status, 404, "seller B cannot stock seller A's SKU");
  assert.equal((await setStock(a, randomUUID(), 10)).status, 404, 'unknown SKU');

  const ok = await setStock(a, skuIds[0], 25);
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.onHand, ok.body.reserved, ok.body.available], [25, 0, 25]);
  assert.equal((await setStock(a, skuIds[0], -1)).status, 400);
  assert.equal((await api(`${INV}/seller/stock/${skuIds[0]}`, { method: 'PUT', token: a.accessToken, body: { onHand: 5, extra: 1 } })).status, 400);

  const hint = await api(`${INV}/stock?skuIds=${skuIds[0]},${randomUUID()}`);
  assert.equal(hint.status, 200);
  assert.equal(hint.body[0].available, 25);
  assert.equal(hint.body[1].available, 0);
});

test('adjustments: cannot drop below reserved, idempotency key applies once, admin can audit', async () => {
  const seller = await createSeller('invAdj');
  const admin = await adminLogin();
  const { skuIds } = await createPublishedProduct(seller);
  const sku = skuIds[0];
  await setStock(seller, sku, 10);
  assert.equal((await reserve(randomUUID(), [{ skuId: sku, quantity: 4 }])).status, 201);

  const tooLow = await api(`${INV}/seller/stock/${sku}/adjust`, { method: 'POST', token: seller.accessToken, body: { delta: -7, reason: 'shrink' } });
  assert.equal(tooLow.status, 409);
  assert.equal((await setStock(seller, sku, 3)).status, 409, 'set below reserved rejected');

  const key = randomUUID();
  const headers = { 'Idempotency-Key': key };
  const first = await api(`${INV}/seller/stock/${sku}/adjust`, { method: 'POST', token: seller.accessToken, headers, body: { delta: 5, reason: 'restock' } });
  const repeat = await api(`${INV}/seller/stock/${sku}/adjust`, { method: 'POST', token: seller.accessToken, headers, body: { delta: 5, reason: 'restock' } });
  assert.equal(first.status, 200);
  assert.equal(repeat.status, 200);
  assert.equal((await skuState(seller, sku)).onHand, 15, 'applied exactly once');
  const clash = await api(`${INV}/seller/stock/${sku}/adjust`, { method: 'POST', token: seller.accessToken, headers, body: { delta: 9, reason: 'restock' } });
  assert.equal(clash.status, 409);

  assert.equal((await api(`${INV}/admin/adjustments`, { token: seller.accessToken })).status, 403);
  const audit = await api(`${INV}/admin/adjustments?size=100`, { token: admin.accessToken });
  assert.equal(audit.status, 200);
  const mine = audit.body.items.filter((i) => i.skuId === sku);
  assert.deepEqual(mine.map((i) => i.delta).sort((x, y) => x - y), [5, 10]);
  assert.ok(mine.every((i) => i.actorId === seller.user.id && i.reason));
});

test('100 simultaneous reservations for ONE unit: exactly one succeeds, stock never negative', async () => {
  const seller = await createSeller('invRace1');
  const { skuIds } = await createPublishedProduct(seller);
  await setStock(seller, skuIds[0], 1);
  const results = await Promise.all(Array.from({ length: 100 }, () => reserve(randomUUID(), [{ skuId: skuIds[0], quantity: 1 }])));
  const ok = results.filter((r) => r.status === 201).length;
  const rejected = results.filter((r) => r.status === 409 && r.body.error.code === 'INSUFFICIENT_STOCK').length;
  assert.equal(ok, 1);
  assert.equal(rejected, 99);
  assert.equal(results.filter((r) => r.status >= 500).length, 0);
  const s = await skuState(seller, skuIds[0]);
  assert.deepEqual([s.onHand, s.reserved, s.available], [1, 1, 0]);
});

test('100 simultaneous reservations against 30 units: exactly 30 succeed', async () => {
  const seller = await createSeller('invRace30');
  const { skuIds } = await createPublishedProduct(seller);
  await setStock(seller, skuIds[0], 30);
  const results = await Promise.all(Array.from({ length: 100 }, () => reserve(randomUUID(), [{ skuId: skuIds[0], quantity: 1 }])));
  assert.equal(results.filter((r) => r.status === 201).length, 30);
  assert.equal(results.filter((r) => r.status === 409).length, 70);
  const s = await skuState(seller, skuIds[0]);
  assert.deepEqual([s.onHand, s.reserved, s.available], [30, 30, 0]);
});

test('reserve is idempotent per checkout; different payload for same checkout is rejected', async () => {
  const seller = await createSeller('invIdem');
  const { skuIds } = await createPublishedProduct(seller);
  await setStock(seller, skuIds[0], 10);
  const checkoutId = randomUUID();
  const items = [{ skuId: skuIds[0], quantity: 3 }];
  const results = await Promise.all(Array.from({ length: 20 }, () => reserve(checkoutId, items)));
  assert.equal(results.filter((r) => r.status === 201).length, 1, 'one creation');
  assert.equal(results.filter((r) => r.status === 200).length, 19, 'the rest return the stored reservation');
  assert.equal(new Set(results.map((r) => r.body.reservationId)).size, 1);
  assert.equal((await skuState(seller, skuIds[0])).reserved, 3, 'quantity reserved once');
  const mismatch = await reserve(checkoutId, [{ skuId: skuIds[0], quantity: 5 }]);
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.code, 'CHECKOUT_PAYLOAD_MISMATCH');
  assert.equal((await reserve(randomUUID(), [{ skuId: skuIds[0], quantity: 1 }, { skuId: skuIds[0], quantity: 1 }])).status, 400, 'duplicate sku lines');
});

test('release and commit change totals exactly once and never both', async () => {
  const seller = await createSeller('invLife');
  const { skuIds } = await createPublishedProduct(seller);
  const sku = skuIds[0];
  await setStock(seller, sku, 10);

  const rel = randomUUID();
  await reserve(rel, [{ skuId: sku, quantity: 4 }]);
  const releases = await Promise.all(Array.from({ length: 10 }, () => internal('inventory', `/internal/reservations/${rel}/release`, { method: 'POST' })));
  assert.ok(releases.every((r) => r.status === 200 && r.body.status === 'RELEASED'));
  let s = await skuState(seller, sku);
  assert.deepEqual([s.onHand, s.reserved], [10, 0], 'released once, not 10 times');
  assert.equal((await internal('inventory', `/internal/reservations/${rel}/commit`, { method: 'POST' })).status, 409, 'cannot commit a released reservation');

  const com = randomUUID();
  await reserve(com, [{ skuId: sku, quantity: 6 }]);
  const commits = await Promise.all(Array.from({ length: 10 }, () => internal('inventory', `/internal/reservations/${com}/commit`, { method: 'POST' })));
  assert.ok(commits.every((r) => r.status === 200 && r.body.status === 'COMMITTED'));
  s = await skuState(seller, sku);
  assert.deepEqual([s.onHand, s.reserved, s.available], [4, 0, 4], 'sold once');
  assert.equal((await internal('inventory', `/internal/reservations/${com}/release`, { method: 'POST' })).status, 409, 'cannot release a committed sale');
  s = await skuState(seller, sku);
  assert.deepEqual([s.onHand, s.reserved], [4, 0]);
  assert.equal((await internal('inventory', `/internal/reservations/${randomUUID()}/release`, { method: 'POST' })).status, 404);
});

test('multi-SKU reservation is all-or-nothing', async () => {
  const seller = await createSeller('invMulti');
  const { skuIds } = await createPublishedProduct(seller, { variants: 2 });
  const [plenty, scarce] = skuIds;
  await setStock(seller, plenty, 10);
  await setStock(seller, scarce, 1);
  const checkoutId = randomUUID();
  const res = await reserve(checkoutId, [{ skuId: plenty, quantity: 5 }, { skuId: scarce, quantity: 2 }]);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'INSUFFICIENT_STOCK');
  assert.deepEqual(res.body.error.details.map((f) => f.skuId), [scarce]);
  assert.equal((await skuState(seller, plenty)).reserved, 0, 'nothing held for the satisfiable line');
  assert.equal((await internal('inventory', `/internal/reservations/${checkoutId}`)).status, 404, 'no reservation record left');

  const good = await reserve(randomUUID(), [{ skuId: plenty, quantity: 5 }, { skuId: scarce, quantity: 1 }]);
  assert.equal(good.status, 201);
  assert.equal(good.body.items.length, 2);
});

test('opposite-order multi-SKU checkouts in parallel do not deadlock or oversell', async () => {
  const seller = await createSeller('invOrder');
  const { skuIds } = await createPublishedProduct(seller, { variants: 2 });
  const [x, y] = skuIds;
  await setStock(seller, x, 20);
  await setStock(seller, y, 20);
  const calls = Array.from({ length: 40 }, (_, i) => reserve(randomUUID(), i % 2 ? [{ skuId: x, quantity: 1 }, { skuId: y, quantity: 1 }] : [{ skuId: y, quantity: 1 }, { skuId: x, quantity: 1 }]));
  const results = await Promise.all(calls);
  assert.equal(results.filter((r) => r.status >= 500).length, 0, JSON.stringify(results.find((r) => r.status >= 500)));
  assert.equal(results.filter((r) => r.status === 201).length, 20);
  const [sx, sy] = [await skuState(seller, x), await skuState(seller, y)];
  assert.deepEqual([sx.reserved, sy.reserved], [20, 20]);
});

test('expired reservations are listed but never auto-released', async () => {
  const seller = await createSeller('invExp');
  const { skuIds } = await createPublishedProduct(seller);
  await setStock(seller, skuIds[0], 5);
  const checkoutId = randomUUID();
  assert.equal((await reserve(checkoutId, [{ skuId: skuIds[0], quantity: 2 }], 30)).status, 201);
  const early = await internal('inventory', '/internal/reservations/expired');
  assert.ok(!early.body.some((r) => r.checkoutId === checkoutId), 'not yet due');
  assert.equal((await skuState(seller, skuIds[0])).reserved, 2);
});

test('internal endpoints require the service token and are not exposed by the gateway', async () => {
  assert.equal((await api(`${INV}/internal/reservations`, { method: 'POST', body: {} })).status, 403);
  const res = await fetch('http://inventory-service:8084/internal/reservations/expired');
  assert.equal(res.status, 403);
});
