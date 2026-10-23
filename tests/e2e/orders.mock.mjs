// Order checkout, multi-seller grouping, visibility and fulfilment. Runs with PAYMENT_GATEWAY=mock (see scripts/run-mock-suites.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ADDRESS, adminLogin, api, buildCart, checkout, createPublishedProduct, createSeller, getOrder, payOrder,
  registerAndLogin, setStock, stockOf, waitForOrder,
} from './helpers.mjs';

const ORD = '/api/orders';

test('checkout builds one parent order with a suborder per seller; totals are computed on the server', async () => {
  const { customer, sellers, skus } = await buildCart({ sellerCount: 2, qty: 2, pricePaise: 15000 });
  const res = await checkout(customer);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const order = await waitForOrder(customer, res.body.orderId, (o) => o.status === 'PAYMENT_PENDING');

  assert.equal(order.groups.length, 2, 'one group per seller');
  assert.deepEqual(new Set(order.groups.map((g) => g.sellerId)), new Set(sellers.map((s) => s.storeId)));
  assert.equal(order.subtotalPaise, 2 * 2 * 15000);
  assert.equal(order.shippingPaise, 2 * 4900, 'flat shipping per seller group');
  assert.equal(order.totalPaise, order.subtotalPaise + order.shippingPaise + order.taxPaise - order.discountPaise);
  assert.equal(order.totalPaise, order.groups.reduce((n, g) => n + g.totalPaise, 0), 'groups add up to the aggregate payable');
  for (const g of order.groups) {
    assert.equal(g.items.length, 1);
    assert.equal(g.items[0].unitPricePaise, 15000);
    assert.equal(g.items[0].quantity, 2);
    assert.equal(g.items[0].lineTotalPaise, 30000);
  }
  assert.equal(order.payment.amountPaise, order.totalPaise, 'payable amount = server total');
  assert.equal(order.payment.gateway, 'mock');
  assert.ok(order.history.length >= 3);
  for (const s of skus) assert.equal((await stockOf(sellers.find((x) => x.storeId === s.sellerId), s.skuId)).reserved, 2);
});

test('client-supplied totals and prices are ignored; price at checkout time is snapshotted', async () => {
  const { customer, sellers, skus } = await buildCart({ pricePaise: 20000 });
  // seller raises the price after the item went into the cart
  await api(`/api/catalog/seller/skus/${skus[0].skuId}`, { method: 'PUT', token: sellers[0].accessToken, body: { name: 'Default', pricePaise: 22000, active: true } });
  const res = await checkout(customer, randomUUID(), { shippingAddress: ADDRESS, totalPaise: 1, subtotalPaise: 1, items: [{ skuId: skus[0].skuId, pricePaise: 1, quantity: 99 }] });
  assert.equal(res.status, 201);
  const order = await waitForOrder(customer, res.body.orderId, (o) => o.status === 'PAYMENT_PENDING');
  assert.equal(order.groups[0].items[0].unitPricePaise, 22000, 'current catalog price, revalidated at checkout');
  assert.equal(order.totalPaise, 22000 + 4900);

  // a later price change does not touch the snapshot
  await api(`/api/catalog/seller/skus/${skus[0].skuId}`, { method: 'PUT', token: sellers[0].accessToken, body: { name: 'Default', pricePaise: 99900, active: true } });
  assert.equal((await getOrder(customer, order.orderId)).body.groups[0].items[0].unitPricePaise, 22000);
});

test('same checkout key -> one logical order, even with 20 parallel requests; other payloads conflict', async () => {
  const { customer } = await buildCart();
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 20 }, () => checkout(customer, key)));
  assert.ok(results.every((r) => r.status === 200 || r.status === 201), JSON.stringify(results.find((r) => r.status >= 300)?.body));
  assert.equal(results.filter((r) => r.status === 201).length, 1, 'exactly one creation');
  assert.equal(new Set(results.map((r) => r.body.orderId)).size, 1);
  const list = await api(`${ORD}/orders?size=50`, { token: customer.accessToken });
  assert.equal(list.body.total, 1, 'only one order exists for the customer');

  const other = await checkout(customer, key, { shippingAddress: { ...ADDRESS, line1: 'A different street' } });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await api(`${ORD}/orders?size=50`, { token: customer.accessToken })).body.total, 1);

  const replay = await checkout(customer, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
});

test('checkout validation: empty cart, bad address, missing key, unavailable items', async () => {
  const empty = await registerAndLogin('emptycart');
  assert.equal((await checkout(empty)).status, 422);
  const { customer, sellers, skus } = await buildCart();
  assert.equal((await checkout(customer, randomUUID(), { shippingAddress: { ...ADDRESS, pincode: '12' } })).status, 400);
  assert.equal((await api(`${ORD}/checkout`, { method: 'POST', token: customer.accessToken, body: { shippingAddress: ADDRESS } })).status, 400, 'Idempotency-Key required');
  assert.equal((await api(`${ORD}/checkout`, { method: 'POST', body: {} })).status, 401);

  const productId = (await api(`/api/catalog/products?seller=${sellers[0].storeId}`)).body.items[0].id;
  await api(`/api/catalog/seller/products/${productId}/status`, { method: 'POST', token: sellers[0].accessToken, body: { status: 'ARCHIVED' } });
  const res = await checkout(customer);
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'SKU_NOT_PURCHASABLE');
  assert.deepEqual(res.body.error.details, [skus[0].skuId]);
});

test('insufficient stock: the order fails cleanly and nothing is left reserved', async () => {
  const { customer, sellers, skus } = await buildCart({ stock: 5 });
  // someone else drains the stock after the item was added to this cart
  await setStock(sellers[0], skus[0].skuId, 0);
  const res = await checkout(customer);
  assert.equal(res.status, 201);
  const order = await waitForOrder(customer, res.body.orderId, (o) => o.status === 'FAILED');
  assert.equal(order.failureReason, 'stock reservation rejected');
  assert.equal(order.payment, undefined, 'no payment was started');
  const s = await stockOf(sellers[0], skus[0].skuId);
  assert.deepEqual([s.onHand, s.reserved], [0, 0]);
});

test('simultaneous checkouts for the last unit: exactly one succeeds, nobody oversells', async () => {
  const seller = await createSeller('lastunit');
  const product = await createPublishedProduct(seller, { pricePaise: 5000 });
  await setStock(seller, product.skuIds[0], 1);
  const buyers = await Promise.all(Array.from({ length: 8 }, () => registerAndLogin('racer')));
  await Promise.all(buyers.map((b) => api(`${ORD}/cart/items`, { method: 'POST', token: b.accessToken, headers: { 'Idempotency-Key': randomUUID() }, body: { skuId: product.skuIds[0] } })));
  const placed = await Promise.all(buyers.map((b) => checkout(b)));
  assert.ok(placed.every((r) => r.status === 201), JSON.stringify(placed.find((r) => r.status !== 201)?.body));
  const finals = await Promise.all(buyers.map((b, i) => waitForOrder(b, placed[i].body.orderId, (o) => o.status === 'PAYMENT_PENDING' || o.status === 'FAILED')));
  assert.equal(finals.filter((o) => o.status === 'PAYMENT_PENDING').length, 1);
  assert.equal(finals.filter((o) => o.status === 'FAILED').length, 7);
  const s = await stockOf(seller, product.skuIds[0]);
  assert.deepEqual([s.onHand, s.reserved, s.available], [1, 1, 0]);
});

test('visibility: buyer sees own orders only; admin sees all; sellers only their paid suborders', async () => {
  const { customer, sellers } = await buildCart({ sellerCount: 2 });
  const other = await registerAndLogin('nosy');
  const admin = await adminLogin();
  const placed = await checkout(customer);
  const order = await waitForOrder(customer, placed.body.orderId, (o) => o.status === 'PAYMENT_PENDING');

  assert.equal((await getOrder(other, order.orderId)).status, 404, 'other customers cannot read it');
  assert.equal((await api(`${ORD}/orders/${order.orderId}/cancel`, { method: 'POST', token: other.accessToken })).status, 404);
  assert.equal((await api(`${ORD}/admin/orders/${order.orderId}`, { token: customer.accessToken })).status, 403);
  const adminView = await api(`${ORD}/admin/orders/${order.orderId}`, { token: admin.accessToken });
  assert.equal(adminView.status, 200);
  assert.equal(adminView.body.customerId, order.customerId);
  const listed = await api(`${ORD}/admin/orders?status=PAYMENT_PENDING&size=100`, { token: admin.accessToken });
  assert.equal(listed.status, 200);
  assert.equal((await api(`${ORD}/admin/orders?status=BOGUS`, { token: admin.accessToken })).status, 400);
  assert.equal((await api(`${ORD}/seller/orders`, { token: customer.accessToken })).status, 403);

  const unpaid = await api(`${ORD}/seller/orders`, { token: sellers[0].accessToken });
  assert.ok(!unpaid.body.items.some((g) => g.orderId === order.orderId), 'sellers never see unpaid orders');

  const { response } = await payOrder(customer, order);
  assert.equal(response.status, 200);
  await waitForOrder(customer, order.orderId, (o) => o.status === 'CONFIRMED');
  for (const s of sellers) {
    const mine = await api(`${ORD}/seller/orders`, { token: s.accessToken });
    const groups = mine.body.items.filter((g) => g.orderId === order.orderId);
    assert.equal(groups.length, 1, 'each seller sees exactly their own suborder');
    assert.equal(groups[0].items.length, 1);
    assert.ok(groups[0].shippingAddress.pincode, 'fulfilment needs the address');
  }
});

test('payment verified -> CONFIRMED, stock committed once, cart lines removed; seller fulfilment follows legal transitions', async () => {
  const { customer, sellers, skus } = await buildCart({ sellerCount: 2, qty: 3, stock: 10 });
  const placed = await checkout(customer);
  const order = await waitForOrder(customer, placed.body.orderId, (o) => o.status === 'PAYMENT_PENDING');
  assert.equal((await api(`${ORD}/cart`, { token: customer.accessToken })).body.items.length, 2, 'cart kept until payment');

  assert.equal((await payOrder(customer, order)).response.status, 200);
  const confirmed = await waitForOrder(customer, order.orderId, (o) => o.status === 'CONFIRMED');
  assert.ok(confirmed.groups.every((g) => g.status === 'CONFIRMED'));
  assert.equal(confirmed.payment, undefined, 'checkout payload only while payment is pending');
  for (const s of skus) {
    const st = await stockOf(sellers.find((x) => x.storeId === s.sellerId), s.skuId);
    assert.deepEqual([st.onHand, st.reserved], [7, 0], 'sold exactly once');
  }
  assert.equal((await api(`${ORD}/cart`, { token: customer.accessToken })).body.items.length, 0);
  const statuses = confirmed.history.filter((h) => !h.groupId).map((h) => h.toStatus);
  assert.deepEqual(statuses, ['PENDING_STOCK', 'STOCK_RESERVED', 'PAYMENT_PENDING', 'PAID', 'CONFIRMED']);

  // fulfilment
  const [g0, g1] = [confirmed.groups.find((g) => g.sellerId === sellers[0].storeId), confirmed.groups.find((g) => g.sellerId === sellers[1].storeId)];
  const setStatus = (seller, group, status) => api(`${ORD}/seller/orders/${group.groupId}/status`, { method: 'POST', token: seller.accessToken, body: { status } });
  assert.equal((await setStatus(sellers[1], g0, 'PROCESSING')).status, 404, "seller B cannot touch seller A's suborder");
  assert.equal((await setStatus(sellers[0], g0, 'SHIPPED')).status, 409, 'cannot skip PROCESSING');
  assert.equal((await setStatus(sellers[0], g0, 'DELIVERED')).status, 409);
  assert.equal((await setStatus(sellers[0], g0, 'PROCESSING')).status, 200);
  assert.equal((await setStatus(sellers[0], g0, 'PROCESSING')).status, 409, 'cannot repeat a step');
  assert.equal((await setStatus(sellers[0], g0, 'SHIPPED')).status, 200);
  assert.equal((await setStatus(sellers[0], g0, 'DELIVERED')).status, 200);
  assert.equal((await setStatus(sellers[0], g0, 'PROCESSING')).status, 409, 'no going backwards');
  assert.equal((await api(`${ORD}/seller/orders/${g0.groupId}/status`, { method: 'POST', token: sellers[0].accessToken, body: { status: 'CONFIRMED' } })).status, 400);
  const after = (await getOrder(customer, order.orderId)).body;
  assert.equal(after.groups.find((g) => g.groupId === g0.groupId).status, 'DELIVERED');
  assert.equal(after.groups.find((g) => g.groupId === g1.groupId).status, 'CONFIRMED', 'groups progress independently');
  assert.equal(after.status, 'CONFIRMED');
  assert.equal((await setStatus(sellers[1], g1, 'PROCESSING')).status, 200);
});

test('customers can cancel only unpaid orders; stock is released', async () => {
  const { customer, sellers, skus } = await buildCart({ stock: 4 });
  const placed = await checkout(customer);
  const order = await waitForOrder(customer, placed.body.orderId, (o) => o.status === 'PAYMENT_PENDING');
  assert.equal((await stockOf(sellers[0], skus[0].skuId)).reserved, 1);

  const cancelled = await api(`${ORD}/orders/${order.orderId}/cancel`, { method: 'POST', token: customer.accessToken });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.status, 'CANCELLED');
  const s = await (async () => { for (let i = 0; i < 20; i += 1) { const x = await stockOf(sellers[0], skus[0].skuId); if (x.reserved === 0) return x; await new Promise((r) => setTimeout(r, 500)); } return stockOf(sellers[0], skus[0].skuId); })();
  assert.deepEqual([s.onHand, s.reserved], [4, 0]);
  assert.equal((await api(`${ORD}/orders/${order.orderId}/cancel`, { method: 'POST', token: customer.accessToken })).status, 200, 'cancelling twice is harmless');

  // paying after cancellation must never revive the order (the captured money is refunded, see payments suite)
  await payOrder(customer, order);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await getOrder(customer, order.orderId)).body.status, 'CANCELLED');

  const second = await buildCart();
  const placed2 = await checkout(second.customer);
  const order2 = await waitForOrder(second.customer, placed2.body.orderId, (o) => o.status === 'PAYMENT_PENDING');
  await payOrder(second.customer, order2);
  await waitForOrder(second.customer, order2.orderId, (o) => o.status === 'CONFIRMED');
  const refused = await api(`${ORD}/orders/${order2.orderId}/cancel`, { method: 'POST', token: second.customer.accessToken });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'NOT_CANCELLABLE');
});

test('internal order endpoints need the service token and are blocked at the gateway', async () => {
  assert.equal((await api(`${ORD}/internal/orders/${randomUUID()}/payable`)).status, 403);
  const direct = await fetch(`http://order-service:8083/internal/orders/${randomUUID()}/payable`);
  assert.equal(direct.status, 403);
});
