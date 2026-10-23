CREATE TABLE carts (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  customer_id CHAR(36)    NOT NULL,
  created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_cart_customer (customer_id)
) ENGINE=InnoDB;

-- One line per (cart, seller, SKU). The unique key is what makes concurrent adds merge instead of duplicate.
CREATE TABLE cart_items (
  id         CHAR(36)    NOT NULL PRIMARY KEY,
  cart_id    CHAR(36)    NOT NULL,
  seller_id  CHAR(36)    NOT NULL,
  sku_id     CHAR(36)    NOT NULL,
  quantity   INT         NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_cart_line (cart_id, seller_id, sku_id),
  CONSTRAINT ck_cart_item_quantity CHECK (quantity > 0),
  CONSTRAINT fk_cart_items_cart FOREIGN KEY (cart_id) REFERENCES carts (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Idempotency record for add-to-cart. Written in the same transaction as the quantity change.
CREATE TABLE cart_operation_keys (
  cart_id      CHAR(36)     NOT NULL,
  idem_key     VARCHAR(100) NOT NULL,
  request_hash CHAR(64)     NOT NULL,
  result       JSON         NULL,
  created_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (cart_id, idem_key),
  CONSTRAINT fk_cart_keys_cart FOREIGN KEY (cart_id) REFERENCES carts (id) ON DELETE CASCADE
) ENGINE=InnoDB;
