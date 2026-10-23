import { createPublicKey, verify, randomUUID } from 'node:crypto';

export const BASE = process.env.BASE_URL ?? 'http://gateway:8080';

export async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Token-Delivery': 'body',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

export const uniqueEmail = (p = 'user') => `${p}.${randomUUID().slice(0, 8)}@e2e.local`;
export const PASSWORD = 'E2e-Password-12345';

export async function registerAndLogin(prefix = 'user') {
  const email = uniqueEmail(prefix);
  const reg = await api('/api/auth/register', { method: 'POST', body: { email, password: PASSWORD, name: 'E2E User' } });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const login = await api('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return { email, user: reg.body, ...login.body };
}

export async function adminLogin() {
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { email: process.env.ADMIN_SEED_EMAIL, password: process.env.ADMIN_SEED_PASSWORD },
  });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
  return login.body;
}

/** Verifies an RS256 JWT against a JWKS document, the same way other services do. */
export function verifyJwtWithJwks(jwt, jwks) {
  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  return ok ? JSON.parse(Buffer.from(p, 'base64url').toString()) : null;
}

export const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD;

export async function demoLogin(email) {
  const res = await api('/api/auth/login', { method: 'POST', body: { email, password: DEMO_PASSWORD } });
  if (res.status !== 200) throw new Error(`demo login failed for ${email}: ${res.status}`);
  return res.body;
}

/** Registers a user, gets a store approved by the admin, and returns a login whose token carries storeId. */
export async function createSeller(prefix = 'seller') {
  const admin = await adminLogin();
  const u = await registerAndLogin(prefix);
  const app = await api('/api/auth/apply-as-seller', { method: 'POST', token: u.accessToken, body: { storeName: `Store ${prefix}` } });
  const approved = await api(`/api/auth/admin/seller-applications/${app.body._id}/approve`, { method: 'POST', token: admin.accessToken });
  const login = await api('/api/auth/login', { method: 'POST', body: { email: u.email, password: PASSWORD } });
  return { ...login.body, email: u.email, storeId: approved.body._id, admin };
}

export const suffix = () => randomUUID().slice(0, 8);

const INTERNAL = { 'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN };

/** Calls a service's private endpoint directly on the internal network (these are blocked at the gateway). */
export async function internal(service, path, { method = 'GET', body } = {}) {
  const hosts = { inventory: 'http://inventory-service:8084', catalog: 'http://catalog-service:8082', orders: 'http://order-service:8083', payments: 'http://payment-service:8085' };
  const res = await fetch(hosts[service] + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...INTERNAL },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, body: json };
}

/** Creates a published product with the given number of variants and returns the SKU ids. */
export async function createPublishedProduct(seller, { variants = 1, pricePaise = 10000, category = 'audio' } = {}) {
  const s = suffix();
  const body = variants === 1
    ? { title: `Stock Item ${s}`, categorySlug: category, skuCode: `STK-${s}`, pricePaise, status: 'ACTIVE' }
    : { title: `Stock Item ${s}`, categorySlug: category, status: 'ACTIVE',
        variants: Array.from({ length: variants }, (_, i) => ({ skuCode: `STK-${s}-${i}`, name: `V${i}`, pricePaise })) };
  const res = await api('/api/catalog/seller/products', { method: 'POST', token: seller.accessToken, body });
  if (res.status !== 201) throw new Error(`product create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { productId: res.body.product.id, skuIds: res.body.product.skus.map((k) => k.id), skus: res.body.product.skus };
}

export async function setStock(seller, skuId, onHand) {
  return api(`/api/inventory/seller/stock/${skuId}`, { method: 'PUT', token: seller.accessToken, body: { onHand } });
}

export const ADDRESS = { name: 'Test Buyer', line1: '12 Test Street', city: 'Ahmedabad', state: 'Gujarat', pincode: '380001', phone: '9876543210' };

/**
 * Builds a ready-to-checkout situation: `sellerCount` sellers each with a stocked, published product,
 * and a customer whose cart contains one unit (or `qty`) of each.
 */
export async function buildCart({ sellerCount = 1, qty = 1, stock = 10, pricePaise = 10000 } = {}) {
  const sellers = [];
  const skus = [];
  for (let i = 0; i < sellerCount; i += 1) {
    const seller = await createSeller(`ord${i}`);
    const product = await createPublishedProduct(seller, { pricePaise });
    await setStock(seller, product.skuIds[0], stock);
    sellers.push(seller);
    skus.push({ skuId: product.skuIds[0], sellerId: seller.storeId, pricePaise });
  }
  const customer = await registerAndLogin('buyer');
  for (const s of skus) {
    const res = await api('/api/orders/cart/items', {
      method: 'POST', token: customer.accessToken, headers: { 'Idempotency-Key': randomUUID() }, body: { skuId: s.skuId, quantity: qty },
    });
    if (res.status !== 200) throw new Error(`add to cart failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { customer, sellers, skus };
}

export const checkout = (customer, key = randomUUID(), body = { shippingAddress: ADDRESS }) =>
  api('/api/orders/checkout', { method: 'POST', token: customer.accessToken, headers: { 'Idempotency-Key': key }, body });

export const getOrder = (customer, orderId) => api(`/api/orders/orders/${orderId}`, { token: customer.accessToken });

/** Polls until `predicate(order)` holds or the deadline passes. */
export async function waitForOrder(customer, orderId, predicate, { timeoutMs = 20000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = (await getOrder(customer, orderId)).body;
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for order ${orderId}; last status ${last?.status}`);
}

// ------------------------------------------------------------------ payment helpers (PAYMENT_GATEWAY=mock only)
import { createHmac } from 'node:crypto';

/** Simulates what Razorpay Checkout would hand back for a provider order. */
export async function mockPay(providerOrderId, outcome = 'captured') {
  const res = await internal('payments', '/internal/mock/payments', { method: 'POST', body: { providerOrderId, outcome } });
  if (res.status !== 201) throw new Error(`mock payment failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export const verifyPayment = (customer, checkoutResult) =>
  api('/api/payments/payments/verify', { method: 'POST', token: customer.accessToken, body: checkoutResult });

/** Pays an order through the browser-callback path: mock checkout result -> server-side verify. */
export async function payOrder(customer, order, outcome = 'captured') {
  const result = await mockPay(order.payment.providerOrderId, outcome);
  return { result, response: await verifyPayment(customer, result) };
}

export function webhookEvent(event, { providerOrderId, paymentId, amount, status = 'captured' }) {
  return {
    entity: 'event', event, account_id: 'acc_test',
    payload: { payment: { entity: { id: paymentId, order_id: providerOrderId, amount, currency: 'INR', status, method: 'card' } } },
  };
}

/** Delivers a signed provider webhook exactly as Razorpay would (HMAC-SHA256 over the raw body). */
export async function sendWebhook(payload, { eventId = `evt_${randomUUID()}`, secret = process.env.MOCK_WEBHOOK_SECRET, signature } = {}) {
  const raw = JSON.stringify(payload);
  const sig = signature ?? createHmac('sha256', secret).update(raw).digest('hex');
  const res = await fetch(`${BASE}/api/payments/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': eventId },
    body: raw,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, eventId };
}

export async function paymentAdminView(attemptId) {
  const admin = await adminLogin();
  const list = await api('/api/payments/admin/payments?size=100', { token: admin.accessToken });
  return list.body.items.find((a) => a.attemptId === attemptId);
}

export async function stockOf(seller, skuId) {
  const res = await api('/api/inventory/seller/stock?size=100', { token: seller.accessToken });
  return res.body.items.find((i) => i.skuId === skuId);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
