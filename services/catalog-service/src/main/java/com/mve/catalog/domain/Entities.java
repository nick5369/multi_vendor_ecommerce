package com.mve.catalog.domain;

import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.OneToMany;
import jakarta.persistence.OrderBy;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.hibernate.annotations.BatchSize;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

/** JPA entities for the catalog schema. Kept together because they form one aggregate. */
public final class Entities {
    private Entities() {}

    public enum ProductStatus { DRAFT, ACTIVE, ARCHIVED }

    public enum Moderation { APPROVED, SUSPENDED }

    @Entity
    @Table(name = "categories")
    public static class Category {
        @Id private UUID id;
        private String slug;
        private String name;
        @Column(name = "parent_id") private UUID parentId;

        protected Category() {}

        public Category(UUID id, String slug, String name, UUID parentId) {
            this.id = id;
            this.slug = slug;
            this.name = name;
            this.parentId = parentId;
        }

        public UUID getId() { return id; }
        public String getSlug() { return slug; }
        public String getName() { return name; }
        public UUID getParentId() { return parentId; }
    }

    @Entity
    @Table(name = "products")
    public static class Product {
        @Id private UUID id;
        @Column(name = "seller_id") private UUID sellerId;
        @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "category_id") private Category category;
        private String title;
        private String description;
        @Enumerated(EnumType.STRING) private ProductStatus status;
        @Enumerated(EnumType.STRING) private Moderation moderation = Moderation.APPROVED;
        @Column(name = "moderation_reason") private String moderationReason;
        @Column(name = "min_price_paise") private long minPricePaise;
        private String currency = "INR";
        @Version private long version;
        @Column(name = "created_at") private Instant createdAt = Instant.now();
        @Column(name = "updated_at") private Instant updatedAt = Instant.now();

        @OneToMany(mappedBy = "product", cascade = CascadeType.ALL, orphanRemoval = true)
        @OrderBy("isDefault DESC, createdAt ASC")
        @BatchSize(size = 50)
        private List<Sku> skus = new ArrayList<>();

        @OneToMany(mappedBy = "product", cascade = CascadeType.ALL, orphanRemoval = true)
        @OrderBy("position ASC")
        @BatchSize(size = 50)
        private List<ProductImage> images = new ArrayList<>();

        protected Product() {}

        public Product(UUID sellerId, Category category, String title, String description, ProductStatus status) {
            this.id = UUID.randomUUID();
            this.sellerId = sellerId;
            this.category = category;
            this.title = title;
            this.description = description;
            this.status = status;
        }

        public UUID getId() { return id; }
        public UUID getSellerId() { return sellerId; }
        public Category getCategory() { return category; }
        public String getTitle() { return title; }
        public String getDescription() { return description; }
        public ProductStatus getStatus() { return status; }
        public Moderation getModeration() { return moderation; }
        public String getModerationReason() { return moderationReason; }
        public long getMinPricePaise() { return minPricePaise; }
        public String getCurrency() { return currency; }
        public Instant getCreatedAt() { return createdAt; }
        public List<Sku> getSkus() { return skus; }
        public List<ProductImage> getImages() { return images; }

        public void update(Category category, String title, String description) {
            this.category = category;
            this.title = title;
            this.description = description;
            touch();
        }

        public void setStatus(ProductStatus status) { this.status = status; touch(); }

        public void moderate(Moderation moderation, String reason) {
            this.moderation = moderation;
            this.moderationReason = reason;
            touch();
        }

        public boolean isPubliclyVisible() {
            return status == ProductStatus.ACTIVE && moderation == Moderation.APPROVED;
        }

        public void addSku(Sku sku) { skus.add(sku); }

        public void addImage(ProductImage image) { images.add(image); }

        /** Recomputes the denormalised cheapest price from active SKUs. */
        public void recomputeMinPrice() {
            this.minPricePaise = skus.stream().filter(Sku::isActive).mapToLong(Sku::getPricePaise).min().orElse(minPricePaise);
            touch();
        }

        public long activeSkuCount() { return skus.stream().filter(Sku::isActive).count(); }

        private void touch() { this.updatedAt = Instant.now(); }
    }

    @Entity
    @Table(name = "skus")
    public static class Sku {
        @Id private UUID id;
        @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "product_id") private Product product;
        @Column(name = "seller_id") private UUID sellerId;
        @Column(name = "sku_code") private String skuCode;
        private String name;
        @Column(name = "price_paise") private long pricePaise;
        @JdbcTypeCode(SqlTypes.JSON) private Map<String, String> attributes = new HashMap<>();
        @Column(name = "is_default") private boolean isDefault;
        private boolean active = true;
        @Column(name = "created_at") private Instant createdAt = Instant.now();
        @Column(name = "updated_at") private Instant updatedAt = Instant.now();

        protected Sku() {}

        public Sku(Product product, String skuCode, String name, long pricePaise, Map<String, String> attributes, boolean isDefault) {
            this.id = UUID.randomUUID();
            this.product = product;
            this.sellerId = product.getSellerId();
            this.skuCode = skuCode;
            this.name = name;
            this.pricePaise = pricePaise;
            this.attributes = attributes == null ? new HashMap<>() : new HashMap<>(attributes);
            this.isDefault = isDefault;
        }

        public UUID getId() { return id; }
        public Product getProduct() { return product; }
        public UUID getSellerId() { return sellerId; }
        public String getSkuCode() { return skuCode; }
        public String getName() { return name; }
        public long getPricePaise() { return pricePaise; }
        public Map<String, String> getAttributes() { return attributes; }
        public boolean isDefault() { return isDefault; }
        public boolean isActive() { return active; }

        public void change(String name, long pricePaise, Map<String, String> attributes, boolean active) {
            this.name = name;
            this.pricePaise = pricePaise;
            this.attributes = attributes == null ? new HashMap<>() : new HashMap<>(attributes);
            this.active = active;
            this.updatedAt = Instant.now();
        }
    }

    @Entity
    @Table(name = "product_images")
    public static class ProductImage {
        @Id private UUID id;
        @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "product_id") private Product product;
        private String url;
        private String alt;
        private int position;

        protected ProductImage() {}

        public ProductImage(Product product, String url, String alt, int position) {
            this.id = UUID.randomUUID();
            this.product = product;
            this.url = url;
            this.alt = alt;
            this.position = position;
        }

        public UUID getId() { return id; }
        public String getUrl() { return url; }
        public String getAlt() { return alt; }
        public int getPosition() { return position; }
    }

    @Entity
    @Table(name = "outbox_events")
    public static class OutboxEvent {
        @Id private UUID id;
        @Column(name = "event_type") private String eventType;
        @Column(name = "routing_key") private String routingKey;
        @JdbcTypeCode(SqlTypes.JSON) private Map<String, Object> payload;
        @Column(name = "created_at") private Instant createdAt = Instant.now();
        @Column(name = "published_at") private Instant publishedAt;

        protected OutboxEvent() {}

        public OutboxEvent(UUID id, String eventType, String routingKey, Map<String, Object> payload) {
            this.id = id;
            this.eventType = eventType;
            this.routingKey = routingKey;
            this.payload = payload;
        }

        public UUID getId() { return id; }
        public String getEventType() { return eventType; }
        public String getRoutingKey() { return routingKey; }
        public Map<String, Object> getPayload() { return payload; }
        public void markPublished() { this.publishedAt = Instant.now(); }
    }
}
