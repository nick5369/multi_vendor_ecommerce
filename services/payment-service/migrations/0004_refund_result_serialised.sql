-- Concurrent refund completions each computed the cumulative total without seeing the other's uncommitted row,
-- so RefundSucceeded could carry an understated total. Refund results are now serialised on the payment attempt
-- row (the same lock pay_claim_refund takes), so the second completion always sees the first.
CREATE OR REPLACE FUNCTION pay_refund_result(p_refund UUID, p_provider_refund TEXT, p_status TEXT, p_failure TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    ref refunds;
    att_id UUID;
    new_status TEXT;
    total_refunded BIGINT;
    seller_refunded BIGINT;
BEGIN
    SELECT attempt_id INTO att_id FROM refunds WHERE id = p_refund;
    IF att_id IS NULL THEN RETURN jsonb_build_object('effect', 'UNKNOWN_REFUND'); END IF;
    PERFORM 1 FROM payment_attempts WHERE id = att_id FOR UPDATE;
    SELECT * INTO ref FROM refunds WHERE id = p_refund FOR UPDATE;
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
