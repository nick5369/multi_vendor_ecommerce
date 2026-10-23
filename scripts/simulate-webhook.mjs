// Delivers a SIGNED Razorpay-style webhook to the local payment service, for testing without a public tunnel.
// The signature is HMAC-SHA256 over the raw JSON body using the webhook secret, exactly as Razorpay does.
//
// Usage (via scripts/simulate-webhook.sh):
//   simulate-webhook.sh <event> <razorpay_order_id> <razorpay_payment_id> <amount_paise> [event_id]
//   event: payment.authorized | payment.captured | payment.failed | order.paid
// Re-running with the same event_id demonstrates duplicate-delivery protection.
import { createHmac, randomUUID } from 'node:crypto';

const [event, orderId, paymentId, amount, eventId = `evt_sim_${randomUUID()}`] = process.argv.slice(2);
const secret = process.env.WEBHOOK_SECRET;
const url = process.env.WEBHOOK_URL ?? 'http://gateway:8080/api/payments/webhooks/razorpay';

if (!event || !orderId || !paymentId || !amount) {
  console.error('usage: simulate-webhook.sh <event> <razorpay_order_id> <razorpay_payment_id> <amount_paise> [event_id]');
  process.exit(2);
}
if (!secret) {
  console.error('WEBHOOK_SECRET is empty: set RAZORPAY_WEBHOOK_SECRET in .env (or PAYMENT_GATEWAY=mock with MOCK_WEBHOOK_SECRET).');
  process.exit(2);
}

const status = { 'payment.authorized': 'authorized', 'payment.failed': 'failed' }[event] ?? 'captured';
const body = JSON.stringify({
  entity: 'event', account_id: 'acc_simulated', event,
  payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: Number(amount), currency: 'INR', status, method: 'card' } } },
});
const signature = createHmac('sha256', secret).update(body).digest('hex');

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId },
  body,
});
console.log(`event ${eventId} -> HTTP ${res.status} ${await res.text()}`);
