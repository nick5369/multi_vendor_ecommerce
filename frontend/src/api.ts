// API client. Access token lives in memory only; the refresh token is an HttpOnly cookie the page cannot read.
// A page reload therefore starts with a silent POST /refresh.
const BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');

export type Role = 'CUSTOMER' | 'SELLER' | 'ADMIN';
export interface User {
  id: string; email: string; name: string; roles: Role[]; status: string; emailVerified: boolean; storeId?: string | null; createdAt: string;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

let accessToken: string | null = null;
let onSession: ((user: User | null) => void) | null = null;
export const setSessionListener = (fn: (user: User | null) => void) => { onSession = fn; };
export const hasToken = () => accessToken !== null;

function describe(body: any, status: number): ApiError {
  const e = body?.error ?? body;
  let message = e?.message ?? body?.message ?? `Request failed (${status})`;
  if (Array.isArray(message)) message = message.join('; ');
  const detail = e?.details ?? e?.detail;
  if (typeof detail === 'string' && detail && !String(message).includes(detail) && status < 500) message = `${message}: ${detail}`;
  return new ApiError(status, e?.code ?? (typeof body?.error === 'string' ? body.error : 'ERROR'), String(message), e?.details);
}

// One refresh at a time: the server rotates refresh tokens, so two parallel refreshes would look like token reuse.
let refreshing: Promise<User | null> | null = null;
export function refreshSession(): Promise<User | null> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!res.ok) throw new Error('no session');
        const data = await res.json();
        accessToken = data.accessToken;
        onSession?.(data.user);
        return data.user as User;
      } catch {
        accessToken = null;
        onSession?.(null);
        return null;
      } finally {
        setTimeout(() => { refreshing = null; }, 0);
      }
    })();
  }
  return refreshing;
}

export function setAuth(token: string, user: User) { accessToken = token; onSession?.(user); }
export function clearAuth() { accessToken = null; onSession?.(null); }

export interface ReqOptions { method?: string; body?: unknown; headers?: Record<string, string>; auth?: boolean; idempotent?: boolean }

export async function api<T = any>(path: string, opts: ReqOptions = {}): Promise<T> {
  const attempt = async (): Promise<Response> => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken && opts.auth !== false) headers.Authorization = `Bearer ${accessToken}`;
    return fetch(`${BASE}${path}`, {
      method: opts.method ?? 'GET', headers, credentials: 'include',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  };
  let res: Response;
  try {
    res = await attempt();
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Is the stack running?');
  }
  if (res.status === 401 && opts.auth !== false && !path.startsWith('/api/auth/login')) {
    if (await refreshSession()) res = await attempt();
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = { message: text }; }
  if (!res.ok) throw describe(body, res.status);
  return body as T;
}

export const newKey = () => crypto.randomUUID();
export const post = <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => api<T>(path, { method: 'POST', body: body ?? {}, headers });
export const put = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body: body ?? {} });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

export const AUTH = '/api/auth';
export const CAT = '/api/catalog';
export const ORD = '/api/orders';
export const INV = '/api/inventory';
export const PAY = '/api/payments';

// ---------------------------------------------------------------- types
export interface Page<T> { items: T[]; page: number; size: number; total: number }
export interface Category { id: string; slug: string; name: string; parentId: string | null }
export interface Sku { id: string; skuCode: string; name: string; pricePaise: number; attributes: Record<string, string>; isDefault: boolean }
export interface Image { id: string; url: string; alt: string; position: number }
export interface Product {
  id: string; sellerId: string; title: string; description: string; categorySlug: string; minPricePaise: number;
  currency: string; images: Image[]; skus: Sku[];
}
export interface ProductSummary { id: string; sellerId: string; title: string; categorySlug: string; minPricePaise: number; currency: string; imageUrl: string | null }
export interface SellerProduct { product: Product; status: string; moderation: string; moderationReason: string | null }
export interface CartLine { skuId: string; sellerId: string; title?: string; skuName?: string; quantity: number; pricePaise: number; lineTotalPaise: number; purchasable: boolean }
export interface Cart { cartId: string; items: CartLine[]; subtotalPaise: number; currency: string }
export interface OrderItem { skuId: string; productId: string; title: string; skuName: string; unitPricePaise: number; quantity: number; lineTotalPaise: number }
export interface OrderGroup {
  groupId: string; orderId?: string; sellerId: string; status: string; subtotalPaise: number; shippingPaise: number; taxPaise: number;
  totalPaise: number; refundedPaise: number; items: OrderItem[]; shippingAddress?: Address; createdAt?: string;
}
export interface Address { name: string; line1: string; line2?: string; city: string; state: string; pincode: string; phone: string }
export interface PaymentPayload {
  attemptId: string; orderId?: string; status: string; providerOrderId: string; keyId: string; amountPaise: number; currency: string; gateway: string;
}
export interface Order {
  orderId: string; customerId?: string; status: string; currency: string; subtotalPaise: number; shippingPaise: number; discountPaise: number;
  taxPaise: number; totalPaise: number; refundedPaise: number; shippingAddress?: Address; payment?: PaymentPayload; failureReason?: string;
  createdAt: string; updatedAt: string; groups: OrderGroup[];
  history?: { groupId?: string; fromStatus?: string; toStatus: string; actor: string; reason?: string; createdAt: string }[];
}
