-- Payment attempts: one logical payment per (order, purpose). Amounts are integer paise, always taken
-- from the order service, never from the browser.
CREATE TABLE payment_attempts (
    id                  UUID PRIMARY KEY,
    order_id            UUID        NOT NULL,
    customer_id         UUID        NOT NULL,
    purpose             TEXT        NOT NULL DEFAULT 'ORDER_PAYMENT',
    amount_paise        BIGINT      NOT NULL CHECK (amount_paise > 0),
    currency            TEXT        NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    gateway             TEXT        NOT NULL CHECK (gateway IN ('razorpay', 'mock')),
    status              TEXT        NOT NULL CHECK (status IN ('INITIATING', 'CREATED', 'AUTHORIZED', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
    provider_order_id   TEXT        UNIQUE,
    provider_payment_id TEXT        UNIQUE,      -- set only when the payment is captured
    lease_until         TIMESTAMPTZ,             -- exclusive right to create the provider order
    failure_reason      TEXT,
    needs_refund        BOOLEAN     NOT NULL DEFAULT FALSE,  -- money captured for an order that is already closed
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_attempt_order_purpose UNIQUE (order_id, purpose)
);
CREATE INDEX ix_attempts_status ON payment_attempts (status, updated_at);

CREATE TABLE idempotency_records (
    customer_id     UUID        NOT NULL,
    idempotency_key TEXT        NOT NULL,
    request_hash    TEXT        NOT NULL,
    attempt_id      UUID        NOT NULL REFERENCES payment_attempts (id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (customer_id, idempotency_key)
);

-- Test-mode settlement/reference metadata lives in meta. No card data is ever stored.
CREATE TABLE payment_transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id          UUID        NOT NULL REFERENCES payment_attempts (id),
    provider_payment_id TEXT        NOT NULL,
    kind                TEXT        NOT NULL CHECK (kind IN ('CAPTURE')),
    amount_paise        BIGINT      NOT NULL,
    meta                JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_transaction_payment_kind UNIQUE (provider_payment_id, kind)
);

-- Every verified provider event, keyed by the provider's unique event id.
CREATE TABLE provider_events (
    event_id    TEXT PRIMARY KEY,
    event_type  TEXT        NOT NULL,
    payload     JSONB       NOT NULL,
    effect      TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id         UUID        NOT NULL REFERENCES payment_attempts (id),
    order_id           UUID        NOT NULL,
    seller_id          UUID,                       -- set when a seller (not an admin) requested it
    amount_paise       BIGINT      NOT NULL CHECK (amount_paise >= 100),
    idempotency_key    TEXT        NOT NULL,
    request_hash       TEXT        NOT NULL,
    status             TEXT        NOT NULL CHECK (status IN ('REQUESTED', 'PENDING', 'PROCESSED', 'FAILED')),
    provider_refund_id TEXT        UNIQUE,
    reason             TEXT,
    failure_reason     TEXT,
    requested_by       UUID        NOT NULL,
    requested_role     TEXT        NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_refund_attempt_key UNIQUE (attempt_id, idempotency_key)
);
CREATE INDEX ix_refunds_order ON refunds (order_id);

-- Only used when PAYMENT_GATEWAY=mock (explicit local flag). Never populated against Razorpay.
CREATE TABLE mock_gateway_payments (
    id                TEXT PRIMARY KEY,
    provider_order_id TEXT        NOT NULL,
    amount_paise      BIGINT      NOT NULL,
    status            TEXT        NOT NULL CHECK (status IN ('authorized', 'captured', 'failed')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================================================
-- State transitions as single atomic calls. Each function is one transaction: business rows and the
-- outbox event commit together or not at all.
-- =====================================================================================================
CREATE FUNCTION pay_emit(p_type TEXT, p_key TEXT, p_data JSONB) RETURNS VOID LANGUAGE sql AS $$
    INSERT INTO outbox_events (id, event_type, routing_key, payload)
    SELECT e, p_type, p_key, jsonb_build_object(
        'eventId', e::text, 'eventType', p_type, 'version', 1,
        'occurredAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'data', p_data)
    FROM (SELECT gen_random_uuid() AS e) s
$$;

CREATE FUNCTION pay_attempt_json(a payment_attempts) RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object('attemptId', a.id, 'orderId', a.order_id, 'customerId', a.customer_id, 'status', a.status,
        'providerOrderId', a.provider_order_id, 'providerPaymentId', a.provider_payment_id, 'amountPaise', a.amount_paise,
        'currency', a.currency, 'gateway', a.gateway, 'needsRefund', a.needs_refund, 'createdAt', a.created_at)
$$;

CREATE FUNCTION pay_refund_json(r refunds) RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object('refundId', r.id, 'orderId', r.order_id, 'attemptId', r.attempt_id, 'sellerId', r.seller_id,
        'amountPaise', r.amount_paise, 'status', r.status, 'providerRefundId', r.provider_refund_id, 'reason', r.reason,
        'failureReason', r.failure_reason, 'requestedRole', r.requested_role, 'createdAt', r.created_at)
$$;

-- Claims the idempotency key and the (order, purpose) slot. Same key + same request returns the same attempt;
-- same key + different request is reported as KEY_REUSED; a second key for the same order returns the same attempt.
CREATE FUNCTION pay_claim_intent(p_customer UUID, p_key TEXT, p_hash TEXT, p_order UUID, p_amount BIGINT, p_gateway TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    rec idempotency_records;
    att payment_attempts;
    new_id UUID := gen_random_uuid();
    was_created BOOLEAN;
BEGIN
    SELECT * INTO rec FROM idempotency_records WHERE customer_id = p_customer AND idempotency_key = p_key;
    IF FOUND THEN
        IF rec.request_hash <> p_hash THEN
            RETURN jsonb_build_object('result', 'KEY_REUSED');
        END IF;
        SELECT * INTO att FROM payment_attempts WHERE id = rec.attempt_id;
        RETURN jsonb_build_object('result', 'OK', 'created', FALSE, 'attempt', pay_attempt_json(att));
    END IF;

    INSERT INTO payment_attempts (id, order_id, customer_id, amount_paise, gateway, status)
    VALUES (new_id, p_order, p_customer, p_amount, p_gateway, 'INITIATING')
    ON CONFLICT (order_id, purpose) DO NOTHING;

    SELECT * INTO att FROM payment_attempts WHERE order_id = p_order AND purpose = 'ORDER_PAYMENT';
    IF att.customer_id <> p_customer THEN
        RETURN jsonb_build_object('result', 'FORBIDDEN');
    END IF;
    was_created := (att.id = new_id);

    INSERT INTO idempotency_records (customer_id, idempotency_key, request_hash, attempt_id)
    VALUES (p_customer, p_key, p_hash, att.id)
    ON CONFLICT (customer_id, idempotency_key) DO NOTHING;
    SELECT * INTO rec FROM idempotency_records WHERE customer_id = p_customer AND idempotency_key = p_key;
    IF rec.request_hash <> p_hash THEN
        RETURN jsonb_build_object('result', 'KEY_REUSED');
    END IF;

    IF was_created THEN
        PERFORM pay_emit('PaymentInitiated', 'payment.initiated.v1', jsonb_build_object(
            'attemptId', att.id, 'orderId', att.order_id, 'customerId', att.customer_id,
            'amountPaise', att.amount_paise, 'currency', att.currency));
    END IF;
    RETURN jsonb_build_object('result', 'OK', 'created', was_created, 'attempt', pay_attempt_json(att));
END $$;

CREATE FUNCTION pay_set_provider_order(p_attempt UUID, p_provider_order TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE att payment_attempts;
BEGIN
    UPDATE payment_attempts
       SET provider_order_id = p_provider_order,
           status = CASE WHEN status = 'INITIATING' THEN 'CREATED' ELSE status END,
           lease_until = NULL, updated_at = now()
     WHERE id = p_attempt AND provider_order_id IS NULL
     RETURNING * INTO att;
    IF NOT FOUND THEN
        SELECT * INTO att FROM payment_attempts WHERE id = p_attempt;
    END IF;
    RETURN pay_attempt_json(att);
END $$;

CREATE FUNCTION pay_apply_authorized(p_provider_order TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
    UPDATE payment_attempts SET status = 'AUTHORIZED', updated_at = now()
     WHERE provider_order_id = p_provider_order AND status = 'CREATED';
    RETURN CASE WHEN FOUND THEN 'AUTHORIZED' ELSE 'IGNORED' END;
END $$;

-- The one place a payment becomes SUCCEEDED. Reached from the verified checkout callback (after a provider
-- lookup) and from signed webhooks; whichever arrives first wins and the other sees ALREADY.
CREATE FUNCTION pay_apply_captured(p_provider_order TEXT, p_provider_payment TEXT, p_amount BIGINT, p_meta JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE att payment_attempts;
BEGIN
    SELECT * INTO att FROM payment_attempts WHERE provider_order_id = p_provider_order FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('effect', 'UNKNOWN_ORDER');
    END IF;
    IF p_amount <> att.amount_paise THEN
        RETURN jsonb_build_object('effect', 'AMOUNT_MISMATCH', 'attemptId', att.id, 'orderId', att.order_id);
    END IF;

    INSERT INTO payment_transactions (attempt_id, provider_payment_id, kind, amount_paise, meta)
    VALUES (att.id, p_provider_payment, 'CAPTURE', p_amount, COALESCE(p_meta, '{}'::jsonb))
    ON CONFLICT (provider_payment_id, kind) DO NOTHING;

    IF att.status IN ('INITIATING', 'CREATED', 'AUTHORIZED') THEN
        UPDATE payment_attempts SET status = 'SUCCEEDED', provider_payment_id = p_provider_payment, updated_at = now()
         WHERE id = att.id;
        PERFORM pay_emit('PaymentSucceeded', 'payment.succeeded.v1', jsonb_build_object(
            'attemptId', att.id, 'orderId', att.order_id, 'customerId', att.customer_id,
            'amountPaise', att.amount_paise, 'currency', att.currency, 'providerPaymentId', p_provider_payment));
        RETURN jsonb_build_object('effect', 'SUCCEEDED', 'attemptId', att.id, 'orderId', att.order_id);
    ELSIF att.status = 'SUCCEEDED' AND att.provider_payment_id = p_provider_payment THEN
        RETURN jsonb_build_object('effect', 'ALREADY', 'attemptId', att.id, 'orderId', att.order_id);
    ELSIF att.status = 'SUCCEEDED' THEN
        -- a second, different payment captured on an order that is already paid: recorded above, needs manual review
        RETURN jsonb_build_object('effect', 'DUPLICATE_PAYMENT', 'attemptId', att.id, 'orderId', att.order_id);
    ELSE
        -- money captured for an attempt that is already closed (FAILED/EXPIRED): it is never kept.
        -- The sweeper refunds it in full.
        UPDATE payment_attempts
           SET needs_refund = TRUE, provider_payment_id = COALESCE(provider_payment_id, p_provider_payment), updated_at = now()
         WHERE id = att.id;
        RETURN jsonb_build_object('effect', 'LATE_REFUND_NEEDED', 'attemptId', att.id, 'orderId', att.order_id);
    END IF;
END $$;

CREATE FUNCTION pay_apply_failed(p_provider_order TEXT, p_reason TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE att payment_attempts;
BEGIN
    SELECT * INTO att FROM payment_attempts WHERE provider_order_id = p_provider_order FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('effect', 'UNKNOWN_ORDER');
    END IF;
    IF att.status IN ('INITIATING', 'CREATED', 'AUTHORIZED') THEN
        UPDATE payment_attempts SET status = 'FAILED', failure_reason = left(COALESCE(p_reason, 'payment failed'), 250), updated_at = now()
         WHERE id = att.id;
        PERFORM pay_emit('PaymentFailed', 'payment.failed.v1', jsonb_build_object(
            'attemptId', att.id, 'orderId', att.order_id, 'customerId', att.customer_id,
            'amountPaise', att.amount_paise, 'currency', att.currency, 'reason', left(COALESCE(p_reason, 'payment failed'), 250)));
        RETURN jsonb_build_object('effect', 'FAILED', 'attemptId', att.id, 'orderId', att.order_id);
    END IF;
    RETURN jsonb_build_object('effect', 'IGNORED', 'status', att.status);
END $$;

-- Closes an attempt that has not been paid. Refuses (expired=false) while a payment is authorized or captured.
CREATE FUNCTION pay_expire(p_order UUID) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE att payment_attempts;
BEGIN
    UPDATE payment_attempts SET status = 'EXPIRED', updated_at = now()
     WHERE order_id = p_order AND status IN ('INITIATING', 'CREATED')
     RETURNING * INTO att;
    IF FOUND THEN
        RETURN jsonb_build_object('status', 'EXPIRED', 'expired', TRUE);
    END IF;
    SELECT * INTO att FROM payment_attempts WHERE order_id = p_order;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'NONE', 'expired', TRUE);
    END IF;
    RETURN jsonb_build_object('status', att.status, 'expired', att.status IN ('EXPIRED', 'FAILED'));
END $$;

-- ----------------------------------------------------------------------------------------------- refunds
CREATE FUNCTION pay_claim_refund(p_order UUID, p_amount BIGINT, p_key TEXT, p_hash TEXT, p_actor UUID, p_role TEXT,
                                 p_seller UUID, p_seller_cap BIGINT, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    att payment_attempts;
    ref refunds;
    refunded BIGINT;
    seller_refunded BIGINT;
    lim BIGINT;
    amt BIGINT;
BEGIN
    -- the attempt row lock serialises concurrent refund requests so the cap below cannot be raced
    SELECT * INTO att FROM payment_attempts WHERE order_id = p_order AND purpose = 'ORDER_PAYMENT' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result', 'NOT_FOUND'); END IF;
    IF att.provider_payment_id IS NULL THEN RETURN jsonb_build_object('result', 'NOT_CAPTURED'); END IF;

    SELECT * INTO ref FROM refunds WHERE attempt_id = att.id AND idempotency_key = p_key;
    IF FOUND THEN
        IF ref.request_hash <> p_hash THEN RETURN jsonb_build_object('result', 'KEY_REUSED'); END IF;
        RETURN jsonb_build_object('result', 'OK', 'created', FALSE, 'refund', pay_refund_json(ref), 'attempt', pay_attempt_json(att));
    END IF;

    SELECT COALESCE(sum(amount_paise), 0) INTO refunded FROM refunds WHERE attempt_id = att.id AND status <> 'FAILED';
    lim := att.amount_paise - refunded;
    IF p_seller IS NOT NULL THEN
        SELECT COALESCE(sum(amount_paise), 0) INTO seller_refunded
          FROM refunds WHERE attempt_id = att.id AND seller_id = p_seller AND status <> 'FAILED';
        lim := LEAST(lim, p_seller_cap - seller_refunded);
    END IF;
    amt := COALESCE(NULLIF(p_amount, 0), lim);          -- no amount requested = refund everything still refundable
    IF amt < 100 OR amt > lim THEN
        RETURN jsonb_build_object('result', 'INVALID_AMOUNT', 'maxRefundablePaise', GREATEST(lim, 0));
    END IF;

    INSERT INTO refunds (attempt_id, order_id, seller_id, amount_paise, idempotency_key, request_hash, status, reason, requested_by, requested_role)
    VALUES (att.id, p_order, p_seller, amt, p_key, p_hash, 'REQUESTED', p_reason, p_actor, p_role)
    RETURNING * INTO ref;
    RETURN jsonb_build_object('result', 'OK', 'created', TRUE, 'refund', pay_refund_json(ref), 'attempt', pay_attempt_json(att));
END $$;

-- Records the provider's answer. PROCESSED is terminal and emits RefundSucceeded exactly once.
CREATE FUNCTION pay_refund_result(p_refund UUID, p_provider_refund TEXT, p_status TEXT, p_failure TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    ref refunds;
    new_status TEXT;
    total_refunded BIGINT;
    seller_refunded BIGINT;
BEGIN
    SELECT * INTO ref FROM refunds WHERE id = p_refund FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('effect', 'UNKNOWN_REFUND'); END IF;
    IF ref.status IN ('PROCESSED', 'FAILED') THEN
        RETURN jsonb_build_object('effect', 'ALREADY', 'refund', pay_refund_json(ref));
    END IF;
    new_status := CASE lower(p_status) WHEN 'processed' THEN 'PROCESSED' WHEN 'failed' THEN 'FAILED' ELSE 'PENDING' END;
    UPDATE refunds
       SET status = new_status, provider_refund_id = COALESCE(provider_refund_id, p_provider_refund),
           failure_reason = p_failure, updated_at = now()
     WHERE id = p_refund RETURNING * INTO ref;
    IF new_status = 'PROCESSED' THEN
        SELECT COALESCE(sum(amount_paise), 0) INTO total_refunded FROM refunds WHERE attempt_id = ref.attempt_id AND status = 'PROCESSED';
        SELECT COALESCE(sum(amount_paise), 0) INTO seller_refunded
          FROM refunds WHERE attempt_id = ref.attempt_id AND status = 'PROCESSED' AND seller_id IS NOT DISTINCT FROM ref.seller_id AND ref.seller_id IS NOT NULL;
        PERFORM pay_emit('RefundSucceeded', 'refund.succeeded.v1', jsonb_build_object(
            'refundId', ref.id, 'orderId', ref.order_id, 'attemptId', ref.attempt_id, 'amountPaise', ref.amount_paise,
            'totalRefundedPaise', total_refunded, 'sellerId', ref.seller_id, 'sellerRefundedPaise', seller_refunded));
    END IF;
    RETURN jsonb_build_object('effect', new_status, 'refund', pay_refund_json(ref));
END $$;

-- ----------------------------------------------------------------------------------------------- webhooks
-- Dedupes on the provider event id and applies the effect in the same transaction, so a repeated delivery
-- (or a crash between "seen" and "applied") can never double-apply or lose an event.
CREATE FUNCTION pay_handle_webhook(p_event_id TEXT, p_type TEXT, p_payload JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    n INTEGER;
    pay_entity JSONB := p_payload #> '{payload,payment,entity}';
    ref_entity JSONB := p_payload #> '{payload,refund,entity}';
    result JSONB := jsonb_build_object('effect', 'IGNORED');
    refund_id UUID;
BEGIN
    INSERT INTO provider_events (event_id, event_type, payload) VALUES (p_event_id, p_type, p_payload)
    ON CONFLICT (event_id) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
        RETURN jsonb_build_object('effect', 'DUPLICATE');
    END IF;

    IF p_type = 'payment.authorized' THEN
        result := jsonb_build_object('effect', pay_apply_authorized(pay_entity ->> 'order_id'));
    ELSIF p_type IN ('payment.captured', 'order.paid') THEN
        result := pay_apply_captured(pay_entity ->> 'order_id', pay_entity ->> 'id', (pay_entity ->> 'amount')::bigint,
                                     jsonb_build_object('method', pay_entity ->> 'method', 'source', 'webhook'));
    ELSIF p_type = 'payment.failed' THEN
        result := pay_apply_failed(pay_entity ->> 'order_id', pay_entity ->> 'error_description');
    ELSIF p_type IN ('refund.created', 'refund.processed', 'refund.failed') THEN
        SELECT id INTO refund_id FROM refunds WHERE provider_refund_id = ref_entity ->> 'id';
        IF refund_id IS NOT NULL THEN
            result := pay_refund_result(refund_id, ref_entity ->> 'id',
                                        CASE p_type WHEN 'refund.processed' THEN 'processed' WHEN 'refund.failed' THEN 'failed' ELSE ref_entity ->> 'status' END,
                                        NULL);
        END IF;
    END IF;
    UPDATE provider_events SET effect = result ->> 'effect' WHERE event_id = p_event_id;
    RETURN result;
END $$;
