CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE categories (
    id         UUID PRIMARY KEY,
    slug       VARCHAR(80)  NOT NULL UNIQUE,
    name       VARCHAR(120) NOT NULL,
    parent_id  UUID REFERENCES categories (id),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- A product is owned by exactly one seller (store). seller_id is the auth-service store id.
CREATE TABLE products (
    id                UUID PRIMARY KEY,
    seller_id         UUID         NOT NULL,
    category_id       UUID         NOT NULL REFERENCES categories (id),
    title             VARCHAR(200) NOT NULL,
    description       TEXT         NOT NULL DEFAULT '',
    status            VARCHAR(16)  NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
    moderation        VARCHAR(16)  NOT NULL DEFAULT 'APPROVED' CHECK (moderation IN ('APPROVED', 'SUSPENDED')),
    moderation_reason VARCHAR(500),
    -- denormalised cheapest active SKU price, maintained by the service, used for price filters/sorting
    min_price_paise   BIGINT       NOT NULL CHECK (min_price_paise > 0),
    currency          VARCHAR(3)  NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    version           BIGINT       NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX ix_products_seller ON products (seller_id, created_at DESC);
CREATE INDEX ix_products_category_status ON products (category_id, status, moderation);
CREATE INDEX ix_products_price ON products (min_price_paise);
CREATE INDEX ix_products_title_trgm ON products USING gin (lower(title) gin_trgm_ops);

-- Every product has >= 1 SKU. A product without variants has exactly one SKU flagged is_default.
CREATE TABLE skus (
    id          UUID PRIMARY KEY,
    product_id  UUID         NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    seller_id   UUID         NOT NULL,
    sku_code    VARCHAR(64)  NOT NULL,
    name        VARCHAR(120) NOT NULL,
    price_paise BIGINT       NOT NULL CHECK (price_paise > 0 AND price_paise <= 100000000),
    attributes  JSONB        NOT NULL DEFAULT '{}'::jsonb,
    is_default  BOOLEAN      NOT NULL DEFAULT FALSE,
    active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uq_sku_code_per_seller UNIQUE (seller_id, sku_code)
);
CREATE INDEX ix_skus_product ON skus (product_id);
CREATE UNIQUE INDEX uq_one_default_sku ON skus (product_id) WHERE is_default;

CREATE TABLE product_images (
    id         UUID PRIMARY KEY,
    product_id UUID         NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    url        VARCHAR(500) NOT NULL,
    alt        VARCHAR(200) NOT NULL DEFAULT '',
    position   INT          NOT NULL DEFAULT 0
);
CREATE INDEX ix_images_product ON product_images (product_id, position);

-- reference data (not demo data)
INSERT INTO categories (id, slug, name, parent_id) VALUES
 ('c0000000-0000-4000-8000-000000000001', 'electronics', 'Electronics', NULL),
 ('c0000000-0000-4000-8000-000000000002', 'home-kitchen', 'Home & Kitchen', NULL),
 ('c0000000-0000-4000-8000-000000000003', 'fashion', 'Fashion', NULL),
 ('c0000000-0000-4000-8000-000000000004', 'books', 'Books', NULL),
 ('c0000000-0000-4000-8000-000000000011', 'mobile-accessories', 'Mobile Accessories', 'c0000000-0000-4000-8000-000000000001'),
 ('c0000000-0000-4000-8000-000000000012', 'audio', 'Audio', 'c0000000-0000-4000-8000-000000000001'),
 ('c0000000-0000-4000-8000-000000000021', 'kitchenware', 'Kitchenware', 'c0000000-0000-4000-8000-000000000002');
