ALTER TABLE checkout_idempotency ADD CONSTRAINT fk_checkout_order FOREIGN KEY (order_id) REFERENCES orders (id);
