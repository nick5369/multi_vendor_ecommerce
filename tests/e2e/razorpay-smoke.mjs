// Real Razorpay TEST-mode smoke check (needs RAZORPAY_* in .env and PAYMENT_GATEWAY=razorpay).
// Proves provider-order creation works end to end and is idempotent. It cannot complete a payment:
// that needs a human using the Razorpay test checkout UI (test card), see README.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { adminLogin, api, buildCart, checkout, waitForOrder } from './helpers.mjs';

const auth = 'Basic ' + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
const rzp = async (path) => (await fetch(`https://api.razorpay.com/v1${path}`, { headers: { Authorization: auth } })).json();

test('real Razorpay TEST order is created once per checkout, even under 20 parallel identical requests', async () => {
  assert.match(process.env.RAZORPAY_KEY_ID ?? '', /^rzp_test_/, 'only TEST keys are allowed');
  const { customer } = await buildCart({ pricePaise: 25000 });
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 20 }, () => checkout(customer, key)));
  assert.ok(results.every((r) => r.status === 201 || r.status === 200), JSON.stringify(results.find((r) => r.status >= 300)?.body));
  assert.equal(new Set(results.map((r) => r.body.orderId)).size, 1, 'one logical order');

  const order = await waitForOrder(customer, results[0].body.orderId, (o) => o.status === 'PAYMENT_PENDING');
  const payment = order.payment;
  assert.match(payment.providerOrderId, /^order_/);
  assert.equal(payment.gateway, 'razorpay');
  assert.equal(payment.keyId, process.env.RAZORPAY_KEY_ID);
  assert.equal(payment.amountPaise, 25000 + 4900, 'server-computed total: item + flat shipping');
  assert.equal(JSON.stringify(payment).includes(process.env.RAZORPAY_KEY_SECRET), false, 'secret never returned');

  const remote = await rzp(`/orders/${payment.providerOrderId}`);
  assert.equal(remote.id, payment.providerOrderId);
  assert.equal(remote.amount, payment.amountPaise);
  assert.equal(remote.currency, 'INR');
  assert.equal(remote.status, 'created');
  assert.equal(remote.receipt, payment.attemptId, 'provider order is tied to our attempt id');
  // Razorpay neither dedupes on receipt nor lists new orders immediately, so count creation calls on our side
  // (incremented under the exclusive lease): 20 parallel requests must have produced exactly one call.
  const admin = await adminLogin();
  const list = await api('/api/payments/admin/payments?size=100', { token: admin.accessToken });
  const mine = list.body.items.find((a) => a.attemptId === payment.attemptId);
  assert.equal(mine.providerCreateCalls, 1, 'exactly one provider order creation call for this logical payment');
  console.log(`# razorpay test order ${payment.providerOrderId} verified at the provider`);
});

test('a forged checkout signature is rejected and the payment stays unpaid', async () => {
  const { customer } = await buildCart();
  const res = await checkout(customer);
  const order = await waitForOrder(customer, res.body.orderId, (o) => o.status === 'PAYMENT_PENDING');
  const bad = await fetch('http://payment-service:8085/payments/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customer.accessToken}` },
    body: JSON.stringify({ razorpay_order_id: order.payment.providerOrderId, razorpay_payment_id: 'pay_forged123456', razorpay_signature: 'f'.repeat(64) }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'INVALID_SIGNATURE');
  assert.equal((await waitForOrder(customer, res.body.orderId, () => true)).status, 'PAYMENT_PENDING');
});
