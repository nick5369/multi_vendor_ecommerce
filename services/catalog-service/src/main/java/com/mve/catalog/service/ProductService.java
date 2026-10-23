package com.mve.catalog.service;

import com.mve.catalog.api.Dtos.CreateProductRequest;
import com.mve.catalog.api.Dtos.ImageInput;
import com.mve.catalog.api.Dtos.ImageView;
import com.mve.catalog.api.Dtos.PageResponse;
import com.mve.catalog.api.Dtos.SellerProductView;
import com.mve.catalog.api.Dtos.SkuInput;
import com.mve.catalog.api.Dtos.UpdateProductRequest;
import com.mve.catalog.api.Dtos.UpdateSkuRequest;
import com.mve.catalog.domain.Entities.Category;
import com.mve.catalog.domain.Entities.Moderation;
import com.mve.catalog.domain.Entities.Product;
import com.mve.catalog.domain.Entities.ProductImage;
import com.mve.catalog.domain.Entities.ProductStatus;
import com.mve.catalog.domain.Entities.Sku;
import com.mve.catalog.domain.Repositories.CategoryRepository;
import com.mve.catalog.domain.Repositories.ProductRepository;
import com.mve.catalog.domain.Repositories.SkuRepository;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Seller-side catalog operations plus admin moderation. Every method that takes a sellerId scopes
 * its lookups by that id: another seller's product is reported as "not found", never as forbidden.
 */
@Service
@Transactional
public class ProductService {
    private static final int MAX_IMAGES = 10;

    private final ProductRepository products;
    private final SkuRepository skus;
    private final CategoryRepository categories;
    private final OutboxService outbox;
    private final ProductCache cache;

    public ProductService(ProductRepository products, SkuRepository skus, CategoryRepository categories,
                          OutboxService outbox, ProductCache cache) {
        this.products = products;
        this.skus = skus;
        this.categories = categories;
        this.outbox = outbox;
        this.cache = cache;
    }

    public SellerProductView create(UUID sellerId, CreateProductRequest req) {
        ProductStatus status = parseStatus(req.status() == null ? "DRAFT" : req.status());
        Product product = new Product(sellerId, category(req.categorySlug()), req.title().trim(),
                req.description() == null ? "" : req.description().trim(), status);
        addInitialSkus(product, req);
        addInitialImages(product, req.images());
        product.recomputeMinPrice();
        assertSkuCodesFree(sellerId, product.getSkus());
        products.saveAndFlush(product);
        publishEvent(product, status == ProductStatus.ACTIVE);
        return Mappers.sellerProduct(product);
    }

    @Transactional(readOnly = true)
    public SellerProductView getOwn(UUID sellerId, UUID productId) {
        return Mappers.sellerProduct(owned(sellerId, productId));
    }

    @Transactional(readOnly = true)
    public PageResponse<SellerProductView> listOwn(UUID sellerId, String status, int page, int size) {
        Specification<Product> spec = (root, q, cb) -> cb.equal(root.get("sellerId"), sellerId);
        if (status != null) {
            ProductStatus s = parseStatus(status);
            spec = spec.and((root, q, cb) -> cb.equal(root.get("status"), s));
        }
        var result = products.findAll(spec, PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "createdAt")));
        return new PageResponse<>(result.map(Mappers::sellerProduct).getContent(), page, size, result.getTotalElements());
    }

    public SellerProductView update(UUID sellerId, UUID productId, UpdateProductRequest req) {
        Product p = owned(sellerId, productId);
        p.update(category(req.categorySlug()), req.title().trim(), req.description() == null ? "" : req.description().trim());
        publishEvent(p, false);
        return Mappers.sellerProduct(p);
    }

    public SellerProductView setStatus(UUID sellerId, UUID productId, String status) {
        Product p = owned(sellerId, productId);
        ProductStatus next = parseStatus(status);
        boolean becameActive = next == ProductStatus.ACTIVE && p.getStatus() != ProductStatus.ACTIVE;
        if (next == ProductStatus.ACTIVE && p.activeSkuCount() == 0) {
            throw ApiException.badRequest("Product needs at least one active SKU to be published");
        }
        p.setStatus(next);
        publishEvent(p, becameActive);
        return Mappers.sellerProduct(p);
    }

    public SellerProductView addVariant(UUID sellerId, UUID productId, SkuInput input) {
        Product p = owned(sellerId, productId);
        if (p.getSkus().stream().anyMatch(Sku::isDefault)) {
            throw ApiException.conflict("Product has a single default SKU; edit it instead of adding variants");
        }
        Sku sku = new Sku(p, input.skuCode(), input.name().trim(), input.pricePaise(), input.attributes(), false);
        assertSkuCodesFree(sellerId, List.of(sku));
        p.addSku(sku);
        p.recomputeMinPrice();
        products.saveAndFlush(p);
        publishEvent(p, false);
        return Mappers.sellerProduct(p);
    }

    public SellerProductView updateSku(UUID sellerId, UUID skuId, UpdateSkuRequest req) {
        Sku sku = skus.findByIdAndSellerId(skuId, sellerId).orElseThrow(() -> ApiException.notFound("SKU"));
        Product p = sku.getProduct();
        if (sku.isDefault() && !req.active()) {
            throw ApiException.badRequest("The default SKU cannot be deactivated; archive the product instead");
        }
        sku.change(req.name().trim(), req.pricePaise(), req.attributes(), req.active());
        if (p.activeSkuCount() == 0) throw ApiException.badRequest("A product must keep at least one active SKU");
        p.recomputeMinPrice();
        publishEvent(p, false);
        return Mappers.sellerProduct(p);
    }

    public ImageView addImage(UUID sellerId, UUID productId, ImageInput input) {
        Product p = owned(sellerId, productId);
        if (p.getImages().size() >= MAX_IMAGES) throw ApiException.conflict("Image limit reached (" + MAX_IMAGES + ")");
        ProductImage image = new ProductImage(p, input.url(), input.alt() == null ? "" : input.alt(), input.position());
        p.addImage(image);
        products.saveAndFlush(p);
        publishEvent(p, false);
        return new ImageView(image.getId(), image.getUrl(), image.getAlt(), image.getPosition());
    }

    public void deleteImage(UUID sellerId, UUID productId, UUID imageId) {
        Product p = owned(sellerId, productId);
        if (!p.getImages().removeIf(i -> i.getId().equals(imageId))) throw ApiException.notFound("Image");
        publishEvent(p, false);
    }

    /** Admin moderation: a suspended product disappears from public reads regardless of seller status. */
    public SellerProductView moderate(UUID productId, String moderation, String reason) {
        Product p = products.findById(productId).orElseThrow(() -> ApiException.notFound("Product"));
        p.moderate(Moderation.valueOf(moderation), reason);
        publishEvent(p, false);
        return Mappers.sellerProduct(p);
    }

    @Transactional(readOnly = true)
    public PageResponse<SellerProductView> listAll(String status, String moderation, int page, int size) {
        Specification<Product> spec = Specification.where(null);
        if (status != null) spec = spec.and((r, q, cb) -> cb.equal(r.get("status"), parseStatus(status)));
        if (moderation != null) spec = spec.and((r, q, cb) -> cb.equal(r.get("moderation"), Moderation.valueOf(moderation)));
        var result = products.findAll(spec, PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "createdAt")));
        return new PageResponse<>(result.map(Mappers::sellerProduct).getContent(), page, size, result.getTotalElements());
    }

    // ------------------------------------------------------------------ helpers
    private Product owned(UUID sellerId, UUID productId) {
        return products.findByIdAndSellerId(productId, sellerId).orElseThrow(() -> ApiException.notFound("Product"));
    }

    private Category category(String slug) {
        return categories.findBySlug(slug).orElseThrow(() -> ApiException.badRequest("Unknown category: " + slug));
    }

    private static ProductStatus parseStatus(String s) {
        try {
            return ProductStatus.valueOf(s);
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest("Invalid status: " + s);
        }
    }

    private void addInitialSkus(Product product, CreateProductRequest req) {
        boolean hasVariants = req.variants() != null && !req.variants().isEmpty();
        if (hasVariants) {
            if (req.skuCode() != null || req.pricePaise() != null) {
                throw ApiException.badRequest("Provide either variants or skuCode/pricePaise, not both");
            }
            Set<String> seen = new HashSet<>();
            for (SkuInput v : req.variants()) {
                if (!seen.add(v.skuCode())) throw ApiException.badRequest("Duplicate skuCode in request: " + v.skuCode());
                product.addSku(new Sku(product, v.skuCode(), v.name().trim(), v.pricePaise(), v.attributes(), false));
            }
        } else {
            if (req.skuCode() == null || req.pricePaise() == null) {
                throw ApiException.badRequest("skuCode and pricePaise are required when no variants are given");
            }
            product.addSku(new Sku(product, req.skuCode(), "Default", req.pricePaise(), null, true));
        }
    }

    private void addInitialImages(Product product, List<ImageInput> images) {
        if (images == null) return;
        for (ImageInput i : images) {
            product.addImage(new ProductImage(product, i.url(), i.alt() == null ? "" : i.alt(), i.position()));
        }
    }

    /** Friendly pre-check; the UNIQUE (seller_id, sku_code) constraint remains the real guarantee. */
    private void assertSkuCodesFree(UUID sellerId, List<Sku> candidates) {
        for (Sku s : candidates) {
            if (skus.existsBySellerIdAndSkuCode(sellerId, s.getSkuCode())) {
                throw ApiException.conflict("SKU code already in use: " + s.getSkuCode());
            }
        }
    }

    private void publishEvent(Product p, boolean published) {
        if (published) outbox.productPublished(p);
        else outbox.productUpdated(p);
        cache.invalidateProductAfterCommit(p.getId());
    }
}
