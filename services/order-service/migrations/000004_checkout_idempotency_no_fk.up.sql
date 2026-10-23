-- The idempotency claim is inserted BEFORE the order rows (inside the same transaction), so a foreign key to
-- orders would fail and, under concurrency, deadlock. The primary key (customer_id, idem_key) alone serialises
-- concurrent claims for the same key; order_id remains a logical reference.
ALTER TABLE checkout_idempotency DROP FOREIGN KEY fk_checkout_order;
