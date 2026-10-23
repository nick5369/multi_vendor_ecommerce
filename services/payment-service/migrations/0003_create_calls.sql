-- Counts how many times this service has asked the provider to create an order for the attempt.
-- The provider does not dedupe by receipt, so this counter (incremented under the exclusive lease) is what lets
-- tests and operators verify "at most one creation call per logical payment" without trusting provider listings.
ALTER TABLE payment_attempts ADD COLUMN provider_create_calls INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION pay_attempt_json(a payment_attempts) RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object('attemptId', a.id, 'orderId', a.order_id, 'customerId', a.customer_id, 'status', a.status,
        'providerOrderId', a.provider_order_id, 'providerPaymentId', a.provider_payment_id, 'amountPaise', a.amount_paise,
        'currency', a.currency, 'gateway', a.gateway, 'needsRefund', a.needs_refund, 'createdAt', a.created_at,
        'providerCreateCalls', a.provider_create_calls)
$$;
