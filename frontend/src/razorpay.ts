// Razorpay Checkout launcher. The order id, amount and key id all come from OUR server (the payment payload);
// the browser never decides what is payable. The callback result is only a claim: the server verifies the
// HMAC signature and then asks Razorpay for the real payment before marking anything paid.
import { api, PAY, type PaymentPayload } from './api';

declare global {
  interface Window { Razorpay?: new (options: Record<string, unknown>) => { open(): void; on(ev: string, cb: (r: any) => void): void } }
}

const SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';
let loading: Promise<void> | null = null;

export function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { loading = null; s.remove(); reject(new Error('Could not load Razorpay Checkout (network blocked?)')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

export interface CheckoutResult { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }
export type LaunchOutcome =
  | { kind: 'paid'; verify: { status: string } }
  | { kind: 'failed'; message: string }
  | { kind: 'dismissed' };

export async function launchCheckout(payment: PaymentPayload, prefill: { name?: string; email?: string; contact?: string }): Promise<LaunchOutcome> {
  if (payment.gateway !== 'razorpay') throw new Error(`Payment gateway "${payment.gateway}" has no browser checkout`);
  await loadRazorpay();
  return new Promise<LaunchOutcome>((resolve) => {
    let settled = false;
    const done = (o: LaunchOutcome) => { if (!settled) { settled = true; resolve(o); } };
    const rzp = new window.Razorpay!({
      key: payment.keyId,
      order_id: payment.providerOrderId,
      amount: payment.amountPaise,
      currency: payment.currency,
      name: 'Multi-Vendor Marketplace',
      description: 'Test mode order',
      prefill,
      theme: { color: '#3b5bdb' },
      handler: async (result: CheckoutResult) => {
        try {
          const verify = await api(`${PAY}/payments/verify`, { method: 'POST', body: result });
          done(verify.status === 'SUCCEEDED' ? { kind: 'paid', verify } : { kind: 'failed', message: `Payment status: ${verify.status}` });
        } catch (e) {
          done({ kind: 'failed', message: e instanceof Error ? e.message : 'Verification failed' });
        }
      },
      modal: { ondismiss: () => done({ kind: 'dismissed' }) },
    });
    // a failed attempt can be retried inside the same Razorpay modal, so this is informational only
    rzp.on('payment.failed', () => { /* the modal stays open for retry; final state comes from the server */ });
    rzp.open();
  });
}

/** Asks the server to re-check the provider (used when the browser callback was lost or is still processing). */
export const syncPayment = (providerOrderId: string) => api(`${PAY}/payments/sync`, { method: 'POST', body: { razorpay_order_id: providerOrderId } });
