-- Parent order = one checkout. Seller groups hold the per-vendor split (suborders).
CREATE TABLE orders (
  id                     CHAR(36)     NOT NULL PRIMARY KEY,
  customer_id            CHAR(36)     NOT NULL,
  status                 VARCHAR(20)  NOT NULL,
  currency               CHAR(3)      NOT NULL DEFAULT 'INR',
  subtotal_paise         BIGINT       NOT NULL,
  shipping_paise         BIGINT       NOT NULL,
  discount_paise         BIGINT       NOT NULL DEFAULT 0,
  tax_paise              BIGINT       NOT NULL DEFAULT 0,
  total_paise            BIGINT       NOT NULL,
  refunded_paise         BIGINT       NOT NULL DEFAULT 0,
  shipping_address       JSON         NOT NULL,
  payment_attempt_id     CHAR(36)     NULL,
  provider_order_id      VARCHAR(64)  NULL,
  payment_payload        JSON         NULL,
  failure_reason         VARCHAR(255) NULL,
  reservation_expires_at DATETIME(6)  NULL,
  stock_released         TINYINT(1)   NOT NULL DEFAULT 0,
  stock_committed        TINYINT(1)   NOT NULL DEFAULT 0,
  created_at             DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at             DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY ix_orders_customer (customer_id, created_at),
  KEY ix_orders_status (status, updated_at),
  CONSTRAINT ck_orders_total_positive CHECK (total_paise > 0),
  CONSTRAINT ck_orders_total_adds_up CHECK (total_paise = subtotal_paise + shipping_paise + tax_paise - discount_paise),
  CONSTRAINT ck_orders_refund_bound CHECK (refunded_paise >= 0 AND refunded_paise <= total_paise)
) ENGINE=InnoDB;

CREATE TABLE order_seller_groups (
  id             CHAR(36)    NOT NULL PRIMARY KEY,
  order_id       CHAR(36)    NOT NULL,
  seller_id      CHAR(36)    NOT NULL,
  status         VARCHAR(20) NOT NULL,
  subtotal_paise BIGINT      NOT NULL,
  shipping_paise BIGINT      NOT NULL,
  tax_paise      BIGINT      NOT NULL DEFAULT 0,
  total_paise    BIGINT      NOT NULL,
  refunded_paise BIGINT      NOT NULL DEFAULT 0,
  created_at     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_group_order_seller (order_id, seller_id),
  KEY ix_groups_seller (seller_id, created_at),
  CONSTRAINT fk_groups_order FOREIGN KEY (order_id) REFERENCES orders (id)
) ENGINE=InnoDB;

-- Price, title and seller are snapshotted at purchase time and never re-read from the catalog afterwards.
CREATE TABLE order_items (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  order_id         CHAR(36)     NOT NULL,
  group_id         CHAR(36)     NOT NULL,
  seller_id        CHAR(36)     NOT NULL,
  sku_id           CHAR(36)     NOT NULL,
  product_id       CHAR(36)     NOT NULL,
  title            VARCHAR(200) NOT NULL,
  sku_name         VARCHAR(120) NOT NULL,
  unit_price_paise BIGINT       NOT NULL,
  quantity         INT          NOT NULL,
  line_total_paise BIGINT       NOT NULL,
  currency         CHAR(3)      NOT NULL DEFAULT 'INR',
  UNIQUE KEY uq_item_order_sku (order_id, sku_id),
  CONSTRAINT ck_item_quantity CHECK (quantity > 0),
  CONSTRAINT ck_item_line_total CHECK (line_total_paise = unit_price_paise * quantity),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT fk_items_group FOREIGN KEY (group_id) REFERENCES order_seller_groups (id)
) ENGINE=InnoDB;

CREATE TABLE order_status_history (
  id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id    CHAR(36)     NOT NULL,
  group_id    CHAR(36)     NULL,
  from_status VARCHAR(20)  NULL,
  to_status   VARCHAR(20)  NOT NULL,
  actor       VARCHAR(64)  NOT NULL,
  reason      VARCHAR(255) NULL,
  created_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY ix_history_order (order_id, id)
) ENGINE=InnoDB;

-- A checkout intent is (customer, client key). Same key + same request hash maps to the same order.
CREATE TABLE checkout_idempotency (
  customer_id  CHAR(36)    NOT NULL,
  idem_key     VARCHAR(100) NOT NULL,
  request_hash CHAR(64)    NOT NULL,
  order_id     CHAR(36)    NOT NULL,
  created_at   DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (customer_id, idem_key),
  CONSTRAINT fk_checkout_order FOREIGN KEY (order_id) REFERENCES orders (id)
) ENGINE=InnoDB;
