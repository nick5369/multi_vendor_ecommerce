// Payment idempotency, signature/webhook verification, refunds. Runs with PAYMENT_GATEWAY=mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import {
  adminLogin, api, buildCart, checkout, getOrder, mockPay, paymentAdminView, payOrder, registerAndLogin, sendWebhook,
  sleep, verifyPayment, waitForOrder, webhookEvent,
} from './helpers.mjs';

const PAY = '/api/payments';

async function pendingOrder(options) {
  const fixture = await buildCart(options);
  const placed = await checkout(fixture.customer);
  const order = await waitForOrder(fixture.customer, placed.body.orderId, (o) => o.status === 'PAYMENT_PENDING');
  return { ...fixture, order };
}

const createPayment = (customer, orderId, key = randomUUID()) =>
  api(`${PAY}/payments`, { method: 'POST', token: customer.accessToken, headers: { 'Idempotency-Key': key }, body: { orderId } });

test('payment creation is idempotent: one logical payment, one provider order, repeats return the original', async () => {
  const { customer, order } = await pendingOrder();
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 20 }, () => createPayment(customer, order.orderId, key)));
  assert.ok(results.every((r) => r.status === 200 || r.status === 201), JSON.stringify(results.find((r) => r.status >= 300)?.body));
  assert.equal(new Set(results.map((r) => r.body.providerOrderId)).size, 1);
  assert.equal(results[0].body.providerOrderId, order.payment.providerOrderId, 'same payment the checkout created');
  assert.equal(results[0].body.attemptId, order.payment.attemptId);

  const view = await paymentAdminView(order.payment.attemptId);
  assert.equal(view.providerCreateCalls, 1, 'the provider was asked to create an order exactly once');

  // a different key for the same order still resolves to the same single payment
  const other = await createPayment(customer, order.orderId);
  assert.equal(other.body.attemptId, order.payment.attemptId);
  assert.equal((await paymentAdminView(order.payment.attemptId)).providerCreateCalls, 1);
});

test('same idempotency key with a different request -> 409; other customers cannot touch the order', async () => {
  const a = await pendingOrder();
  const b = await pendingOrder();
  const key = randomUUID();
  assert.equal((await createPayment(a.customer, a.order.orderId, key)).status, 200);
  const clash = await createPayment(a.customer, b.order.orderId, key);
  assert.ok([404, 409].includes(clash.status), 'a different order for the same key is never accepted');
  assert.equal((await createPayment(b.customer, a.order.orderId)).status, 404, "customer B cannot pay for A's order");
  assert.equal((await api(`${PAY}/payments/orders/${a.order.orderId}`, { token: b.customer.accessToken })).status, 404);
  assert.equal((await api(`${PAY}/payments/orders/${a.order.orderId}`, { token: a.customer.accessToken })).status, 200);

  // reuse of one key for two different orders of the SAME customer
  const c = await pendingOrder();
  const second = await (async () => {
    const placed = await checkout(c.customer);
    return waitForOrder(c.customer, placed.body.orderId, (o) => o.status === 'PAYMENT_PENDING');
  })();
  const k2 = randomUUID();
  assert.equal((await createPayment(c.customer, c.order.orderId, k2)).status, 200);
  const reuse = await createPayment(c.customer, second.orderId, k2);
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await api(`${PAY}/payments`, { method: 'POST', token: c.customer.accessToken, body: { orderId: c.order.orderId } })).status, 400, 'key required');
  assert.equal((await api(`${PAY}/payments`, { method: 'POST', body: {} })).status, 401);
});

test('checkout callback: wrong signature rejected; unknown payment ids never mark an order paid', async () => {
  const { customer, order } = await pendingOrder();

  // correctly signed, but the provider has no such payment: the browser callback alone is not proof
  const forgedId = `pay_forged_${randomUUID().slice(0, 8)}`;
  const forged = createHmac('sha256', process.env.MOCK_GATEWAY_SECRET).update(`${order.payment.providerOrderId}|${forgedId}`).digest('hex');
  const res = await verifyPayment(customer, { razorpay_order_id: order.payment.providerOrderId, razorpay_payment_id: forgedId, razorpay_signature: forged });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'CREATED', 'still unpaid');
  await sleep(1500);
  assert.equal((await getOrder(customer, order.orderId)).body.status, 'PAYMENT_PENDING');

  // now a genuine payment exists at the provider
  const result = await mockPay(order.payment.providerOrderId, 'captured');

  const tampered = await verifyPayment(customer, { ...result, razorpay_signature: '0'.repeat(64) });
  assert.equal(tampered.status, 400);
  assert.equal(tampered.body.error.code, 'INVALID_SIGNATURE');
  const wrongPayment = await verifyPayment(customer, { ...result, razorpay_payment_id: 'pay_someone_else' });
  assert.equal(wrongPayment.status, 400, 'signature is bound to the payment id');

  const other = await registerAndLogin('thief');
  assert.equal((await verifyPayment(other, result)).status, 404, 'cannot verify another customer\'s payment');

  // only now, with the provider reporting a captured payment, does it become PAID
  const ok = await verifyPayment(customer, result);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'SUCCEEDED');
  await waitForOrder(customer, order.orderId, (o) => o.status === 'CONFIRMED');
});

test('authorized-but-not-captured payments are captured by the server before the order is paid', async () => {
  const { customer, order } = await pendingOrder();
  const { response } = await payOrder(customer, order, 'authorized');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'SUCCEEDED');
  await waitForOrder(customer, order.orderId, (o) => o.status === 'CONFIRMED');
});

test('a failed provider payment does not mark the order paid', async () => {
  const { customer, order } = await pendingOrder();
  const { response } = await payOrder(customer, order, 'failed');
  assert.equal(response.status, 200);
  assert.notEqual(response.body.status, 'SUCCEEDED');
  assert.equal(response.body.status, 'FAILED');
  await waitForOrder(customer, order.orderId, (o) => o.status === 'FAILED');
});

test('webhooks: bad signature rejected, duplicate event id applies once, amount mismatch ignored', async () => {
  const { customer, order } = await pendingOrder();
  const entity = { providerOrderId: order.payment.providerOrderId, paymentId: `pay_wh_${randomUUID().slice(0, 8)}`, amount: order.totalPaise };

  const bad = await sendWebhook(webhookEvent('payment.captured', entity), { signature: 'a'.repeat(64) });
  assert.equal(bad.status, 400);
  const wrongSecret = await sendWebhook(webhookEvent('payment.captured', entity), { secret: 'not-the-secret' });
  assert.equal(wrongSecret.status, 400);
  assert.equal((await getOrder(customer, order.orderId)).body.status, 'PAYMENT_PENDING', 'nothing applied');

  const mismatch = await sendWebhook(webhookEvent('payment.captured', { ...entity, amount: 100 }));
  assert.equal(mismatch.status, 200);
  assert.equal(mismatch.body.effect, 'AMOUNT_MISMATCH');
  assert.equal((await getOrder(customer, order.orderId)).body.status, 'PAYMENT_PENDING');

  const eventId = `evt_${randomUUID()}`;
  const first = await sendWebhook(webhookEvent('payment.captured', entity), { eventId });
  const again = await Promise.all(Array.from({ length: 10 }, () => sendWebhook(webhookEvent('payment.captured', entity), { eventId })));
  assert.equal(first.body.effect, 'SUCCEEDED');
  assert.ok(again.every((r) => r.status === 200 && r.body.effect === 'DUPLICATE'), 'repeat deliveries have no effect');

  // a different event id for the same captured payment is also harmless
  const replayedUnderNewId = await sendWebhook(webhookEvent('order.paid', entity));
  assert.equal(replayedUnderNewId.body.effect, 'ALREADY');

  const done = await waitForOrder(customer, order.orderId, (o) => o.status === 'CONFIRMED');
  assert.equal(done.history.filter((h) => h.toStatus === 'PAID' && !h.groupId).length, 1, 'PAID applied exactly once');
  assert.equal(done.history.filter((h) => h.toStatus === 'CONFIRMED' && !h.groupId).length, 1);
});

test('webhook events may arrive out of order (captured before authorized)', async () => {
  const { customer, order } = await pendingOrder();
  const entity = { providerOrderId: order.payment.providerOrderId, paymentId: `pay_ooo_${randomUUID().slice(0, 8)}`, amount: order.totalPaise };
  assert.equal((await sendWebhook(webhookEvent('payment.captured', entity))).body.effect, 'SUCCEEDED');
  assert.equal((await sendWebhook(webhookEvent('payment.authorized', { ...entity, status: 'authorized' }))).body.effect, 'IGNORED', 'late authorized does not downgrade');
  await waitForOrder(customer, order.orderId, (o) => o.status === 'CONFIRMED');
  assert.equal((await paymentAdminView(order.payment.attemptId)).status, 'SUCCEEDED');
});

test('webhook endpoint refuses unsigned/malformed requests', async () => {
  const res = await fetch('http://payment-service:8085/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"event":"payment.captured"}' });
  assert.equal(res.status, 400);
  const raw = '{"event":"payment.captured"}';
  const sig = createHmac('sha256', process.env.MOCK_WEBHOOK_SECRET).update(raw).digest('hex');
  const noId = await fetch('http://payment-service:8085/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig }, body: raw });
  assert.equal(noId.status, 400, 'event id required');
});

async function paidOrder(options) {
  const fixture = await pendingOrder(options);
  await payOrder(fixture.customer, fixture.order);
  const confirmed = await waitForOrder(fixture.customer, fixture.order.orderId, (o) => o.status === 'CONFIRMED');
  return { ...fixture, order: confirmed };
}

const refund = (token, orderId, body, key = randomUUID()) =>
  api(`${PAY}/refunds`, { method: 'POST', token, headers: { 'Idempotency-Key': key }, body: { orderId, ...body } });

test('refunds: admin partial then full, idempotent, never above the captured amount', async () => {
  const { customer, order } = await paidOrder({ pricePaise: 50000 });
  const admin = await adminLogin();
  const total = order.totalPaise;

  assert.equal((await refund(customer.accessToken, order.orderId, { amountPaise: 1000 })).status, 403, 'customers cannot refund');
  assert.equal((await refund(admin.accessToken, order.orderId, { amountPaise: 50 })).status, 400, 'below the 100 paise minimum');
  assert.equal((await refund(admin.accessToken, order.orderId, { amountPaise: 12.5 })).status, 400, 'integer paise only');
  assert.equal((await refund(admin.accessToken, order.orderId, { amountPaise: total + 1 })).status, 422, 'more than was captured');

  const key = randomUUID();
  const first = await refund(admin.accessToken, order.orderId, { amountPaise: 10000, reason: 'damaged' }, key);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.status, 'PROCESSED');
  const repeats = await Promise.all(Array.from({ length: 10 }, () => refund(admin.accessToken, order.orderId, { amountPaise: 10000, reason: 'damaged' }, key)));
  assert.ok(repeats.every((r) => r.status === 200 && r.body.refundId === first.body.refundId), 'repeats return the same refund');
  const clash = await refund(admin.accessToken, order.orderId, { amountPaise: 20000 }, key);
  assert.equal(clash.status, 409);

  const overshoot = await refund(admin.accessToken, order.orderId, { amountPaise: total - 5000 });
  assert.equal(overshoot.status, 422);
  assert.equal(overshoot.body.error.details.maxRefundablePaise, total - 10000, 'cumulative refunds are capped');

  const partial = await waitForOrder(customer, order.orderId, (o) => o.refundedPaise === 10000);
  assert.equal(partial.status, 'CONFIRMED', 'partial refund keeps the order confirmed');

  const full = await refund(admin.accessToken, order.orderId, {});
  assert.equal(full.status, 201);
  assert.equal(full.body.amountPaise, total - 10000, 'omitted amount = everything still refundable');
  const refunded = await waitForOrder(customer, order.orderId, (o) => o.status === 'REFUNDED');
  assert.equal(refunded.refundedPaise, total);
  assert.equal((await refund(admin.accessToken, order.orderId, {})).status, 422, 'nothing left to refund');

  const list = await api(`${PAY}/admin/refunds?size=100`, { token: admin.accessToken });
  assert.equal(list.body.items.filter((r) => r.orderId === order.orderId && r.status === 'PROCESSED').length, 2);
});

test('refund races: parallel refunds with different keys cannot exceed the captured amount', async () => {
  const { customer, order } = await paidOrder({ pricePaise: 30000 });
  const admin = await adminLogin();
  const each = Math.floor(order.totalPaise / 3) + 100;
  const results = await Promise.all(Array.from({ length: 6 }, () => refund(admin.accessToken, order.orderId, { amountPaise: each })));
  const ok = results.filter((r) => r.status === 201);
  assert.equal(ok.length, 2, `only 2 of 6 requests of ${each} fit into ${order.totalPaise}`);
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 422));
  const final = await waitForOrder(customer, order.orderId, (o) => o.refundedPaise === 2 * each);
  assert.ok(final.refundedPaise <= final.totalPaise);
});

test('sellers may refund only their own share of an order', async () => {
  const { customer, sellers, order } = await paidOrder({ sellerCount: 2, pricePaise: 20000 });
  const [a, b] = order.groups.slice().sort((x, y) => (x.sellerId === sellers[0].storeId ? -1 : 1));
  const sellerA = sellers.find((s) => s.storeId === a.sellerId);
  const sellerB = sellers.find((s) => s.storeId === b.sellerId);
  const outsider = (await buildCart()).sellers[0];

  assert.equal((await refund(outsider.accessToken, order.orderId, { amountPaise: 1000 })).status, 404, 'a seller with no share in the order');
  const tooMuch = await refund(sellerA.accessToken, order.orderId, { amountPaise: a.totalPaise + 100 });
  assert.equal(tooMuch.status, 422);
  assert.equal(tooMuch.body.error.details.maxRefundablePaise, a.totalPaise, "capped at the seller's own group total");

  const ok = await refund(sellerA.accessToken, order.orderId, { amountPaise: a.totalPaise });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.sellerId, a.sellerId);
  assert.equal((await refund(sellerA.accessToken, order.orderId, { amountPaise: 100 })).status, 422, 'own share exhausted');

  const okB = await refund(sellerB.accessToken, order.orderId, {});
  assert.equal(okB.status, 201, 'seller B still has their own share');
  assert.equal(okB.body.amountPaise, b.totalPaise);
  const done = await waitForOrder(customer, order.orderId, (o) => o.status === 'REFUNDED');
  assert.equal(done.refundedPaise, order.totalPaise);
  assert.equal(done.groups.find((g) => g.sellerId === a.sellerId).refundedPaise, a.totalPaise);
});

test('refunds are impossible before payment is captured', async () => {
  const { order } = await pendingOrder();
  const admin = await adminLogin();
  const res = await refund(admin.accessToken, order.orderId, { amountPaise: 1000 });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ORDER_NOT_PAID');
  assert.equal((await refund(admin.accessToken, randomUUID(), { amountPaise: 1000 })).status, 404);
});

test('money captured after an order was cancelled is automatically refunded in full', async () => {
  const { customer, order } = await pendingOrder({ pricePaise: 40000 });
  const cancelled = await api('/api/orders/orders/' + order.orderId + '/cancel', { method: 'POST', token: customer.accessToken });
  assert.equal(cancelled.status, 200);

  // the customer finished paying in an already-open checkout window
  const entity = { providerOrderId: order.payment.providerOrderId, paymentId: `pay_late_${randomUUID().slice(0, 8)}`, amount: order.totalPaise };
  const hook = await sendWebhook(webhookEvent('payment.captured', entity));
  assert.equal(hook.body.effect, 'LATE_REFUND_NEEDED');

  const admin = await adminLogin();
  let refunds = [];
  for (let i = 0; i < 20; i += 1) {
    const list = await api(`${PAY}/admin/refunds?size=100`, { token: admin.accessToken });
    refunds = list.body.items.filter((r) => r.orderId === order.orderId);
    if (refunds.some((r) => r.status === 'PROCESSED')) break;
    await sleep(500);
  }
  assert.equal(refunds.length, 1, 'exactly one automatic refund');
  assert.equal(refunds[0].status, 'PROCESSED');
  assert.equal(refunds[0].amountPaise, order.totalPaise);
  assert.equal(refunds[0].requestedRole, 'SYSTEM');
  assert.equal((await getOrder(customer, order.orderId)).body.status, 'CANCELLED', 'the cancelled order is not revived');
});

test('admin payment views list summaries without any secret', async () => {
  const { order } = await paidOrder();
  const admin = await adminLogin();
  const list = await api(`${PAY}/admin/payments?size=5`, { token: admin.accessToken });
  assert.equal(list.status, 200);
  const text = JSON.stringify(list.body);
  assert.ok(!text.includes(process.env.MOCK_GATEWAY_SECRET) && !text.includes(process.env.RAZORPAY_KEY_SECRET ?? 'x-none'));
  assert.equal((await api(`${PAY}/admin/payments`, { token: (await registerAndLogin('plain')).accessToken })).status, 403);
  assert.equal((await api(`${PAY}/admin/refunds`)).status, 401);
  assert.ok(order.orderId);
});

test('internal payment endpoints need the service token and are blocked at the gateway', async () => {
  assert.equal((await api(`${PAY}/internal/payments`, { method: 'POST', body: {} })).status, 403);
  const direct = await fetch(`http://payment-service:8085/internal/payments/by-order/${randomUUID()}`);
  assert.equal(direct.status, 403);
});
