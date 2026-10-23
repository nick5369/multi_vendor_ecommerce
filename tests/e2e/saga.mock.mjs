// Checkout saga: compensation, uncertainty, duplicates. Runs with PAYMENT_GATEWAY=mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  api, buildCart, checkout, getOrder, internal, payOrder, sendWebhook, sleep, stockOf, waitForOrder, webhookEvent,
} from './helpers.mjs';

async function pendingOrder(options) {
  const fixture = await buildCart(options);
  const placed = await checkout(fixture.customer);
  const order = await waitForOrder(fixture.customer, placed.body.orderId, (o) => o.status === 'PAYMENT_PENDING');
  return { ...fixture, order, sku: fixture.skus[0], seller: fixture.sellers[0] };
}

/** Publishes a domain event straight to the broker, the way a duplicate or late delivery would arrive. */
async function publishEvent(routingKey, eventType, data, eventId = randomUUID()) {
  const auth = Buffer.from(`${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}`).toString('base64');
  const envelope = { eventId, eventType, version: 1, occurredAt: new Date().toISOString(), data };
  const res = await fetch('http://rabbitmq:15672/api/exchanges/%2F/mve.events/publish', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { message_id: eventId, content_type: 'application/json' },
      routing_key: routingKey, payload: JSON.stringify(envelope), payload_encoding: 'string',
    }),
  });
  assert.equal(res.status, 200);
  return eventId;
}

const waitFor = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(400);
  }
  throw new Error('condition not met in time');
};

const stockPair = async (seller, skuId) => {
  const s = await stockOf(seller, skuId);
  return [s.onHand, s.reserved];
};

test('payment fails definitively after a successful reservation -> stock released and order FAILED', async () => {
  const { customer, order, sku, seller } = await pendingOrder({ stock: 6, qty: 2 });
  assert.deepEqual(await stockPair(seller, sku.skuId), [6, 2]);

  const hook = await sendWebhook(webhookEvent('payment.failed', {
    providerOrderId: order.payment.providerOrderId, paymentId: `pay_f_${randomUUID().slice(0, 8)}`, amount: order.totalPaise, status: 'failed',
  }));
  assert.equal(hook.body.effect, 'FAILED');

  const failed = await waitForOrder(customer, order.orderId, (o) => o.status === 'FAILED');
  assert.match(failed.failureReason, /fail/i);
  assert.ok(failed.groups.every((g) => g.status === 'FAILED'));
  const released = await waitFor(async () => ((await stockOf(seller, sku.skuId)).reserved === 0 ? true : null));
  assert.ok(released);
  const s = await stockOf(seller, sku.skuId);
  assert.deepEqual([s.onHand, s.reserved, s.available], [6, 0, 6], 'reservation released, nothing sold');
  assert.deepEqual(failed.history.filter((h) => !h.groupId).map((h) => h.toStatus), ['PENDING_STOCK', 'STOCK_RESERVED', 'PAYMENT_PENDING', 'FAILED']);
});

test('payment outcome unknown -> stock is NOT released and the order stays pending', async () => {
  const { customer, order, sku, seller } = await pendingOrder({ stock: 3 });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await internal('orders', '/internal/reconcile', { method: 'POST' })).status, 204);
    await sleep(4500);
  }
  assert.equal((await getOrder(customer, order.orderId)).body.status, 'PAYMENT_PENDING');
  assert.deepEqual(await stockPair(seller, sku.skuId), [3, 1], 'reservation kept while the payment may still complete');
});

test('duplicate PaymentSucceeded events: confirmed once, stock committed once, one PAID transition', async () => {
  const { customer, order, sku, seller } = await pendingOrder({ stock: 10, qty: 3 });
  const data = { orderId: order.orderId, attemptId: order.payment.attemptId, amountPaise: order.totalPaise };
  const eventId = randomUUID();
  await Promise.all(Array.from({ length: 6 }, () => publishEvent('payment.succeeded.v1', 'PaymentSucceeded', data, eventId)));
  await publishEvent('payment.succeeded.v1', 'PaymentSucceeded', data); // a different event id for the same payment

  const done = await waitForOrder(customer, order.orderId, (o) => o.status === 'CONFIRMED');
  await sleep(2500); // let every duplicate be consumed
  const final = (await getOrder(customer, order.orderId)).body;
  assert.equal(final.status, 'CONFIRMED');
  assert.equal(final.history.filter((h) => h.toStatus === 'PAID' && !h.groupId).length, 1);
  assert.equal(final.history.filter((h) => h.toStatus === 'CONFIRMED' && !h.groupId).length, 1);
  assert.deepEqual(await stockPair(seller, sku.skuId), [7, 0], 'stock committed exactly once despite 7 deliveries');
  assert.ok(done.groups.every((g) => g.status === 'CONFIRMED'));
});

test('late or contradictory events cannot undo a finished order', async () => {
  const { customer, order, sku, seller } = await pendingOrder({ stock: 4 });
  await sendWebhook(webhookEvent('payment.failed', {
    providerOrderId: order.payment.providerOrderId, paymentId: `pay_x_${randomUUID().slice(0, 8)}`, amount: order.totalPaise, status: 'failed',
  }));
  await waitForOrder(customer, order.orderId, (o) => o.status === 'FAILED');
  await publishEvent('payment.succeeded.v1', 'PaymentSucceeded', { orderId: order.orderId });
  await sleep(2500);
  assert.equal((await getOrder(customer, order.orderId)).body.status, 'FAILED', 'a failed order is not revived by a late success event');
  await waitFor(async () => ((await stockOf(seller, sku.skuId)).reserved === 0 ? true : null));
  assert.deepEqual(await stockPair(seller, sku.skuId), [4, 0]);

  const paid = await pendingOrder({ stock: 4 });
  await payOrder(paid.customer, paid.order);
  await waitForOrder(paid.customer, paid.order.orderId, (o) => o.status === 'CONFIRMED');
  await publishEvent('payment.failed.v1', 'PaymentFailed', { orderId: paid.order.orderId, reason: 'stale failure' });
  await sleep(2500);
  assert.equal((await getOrder(paid.customer, paid.order.orderId)).body.status, 'CONFIRMED', 'a failure report cannot cancel a paid order');
  assert.deepEqual(await stockPair(paid.seller, paid.sku.skuId), [3, 0]);
});

test('cancel is refused while a payment is authorized (outcome not yet known)', async () => {
  const { customer, order, sku, seller } = await pendingOrder({ stock: 2 });
  const hook = await sendWebhook(webhookEvent('payment.authorized', {
    providerOrderId: order.payment.providerOrderId, paymentId: `pay_a_${randomUUID().slice(0, 8)}`, amount: order.totalPaise, status: 'authorized',
  }));
  assert.equal(hook.body.effect, 'AUTHORIZED');
  const res = await api(`/api/orders/orders/${order.orderId}/cancel`, { method: 'POST', token: customer.accessToken });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'PAYMENT_IN_PROGRESS');
  assert.equal((await getOrder(customer, order.orderId)).body.status, 'PAYMENT_PENDING');
  assert.equal((await stockOf(seller, sku.skuId)).reserved, 1, 'stock still held');
});

test('the order queue exists and is durable (events from the outbox are routed to it)', async () => {
  const auth = Buffer.from(`${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}`).toString('base64');
  const res = await fetch('http://rabbitmq:15672/api/queues/%2F/order-service.events', { headers: { Authorization: `Basic ${auth}` } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).durable, true);
});
