package com.mve.catalog.service;

import com.mve.catalog.api.Dtos.CategoryView;
import com.mve.catalog.api.Dtos.ImageView;
import com.mve.catalog.api.Dtos.ProductSummary;
import com.mve.catalog.api.Dtos.ProductView;
import com.mve.catalog.api.Dtos.SellerProductView;
import com.mve.catalog.api.Dtos.SkuView;
import com.mve.catalog.domain.Entities.Category;
import com.mve.catalog.domain.Entities.Product;
import com.mve.catalog.domain.Entities.Sku;
import java.util.List;

/** Entity -> DTO mapping. Must run inside a transaction because associations are lazy. */
public final class Mappers {
    private Mappers() {}

    public static CategoryView category(Category c) {
        return new CategoryView(c.getId(), c.getSlug(), c.getName(), c.getParentId());
    }

    private static SkuView sku(Sku s) {
        return new SkuView(s.getId(), s.getSkuCode(), s.getName(), s.getPricePaise(), s.getAttributes(), s.isDefault());
    }

    /** Public view: only active SKUs are visible. */
    public static ProductView product(Product p) {
        List<SkuView> skus = p.getSkus().stream().filter(Sku::isActive).map(Mappers::sku).toList();
        return productWith(p, skus);
    }

    /** Seller view: includes inactive SKUs so they can be re-enabled. */
    public static SellerProductView sellerProduct(Product p) {
        ProductView view = productWith(p, p.getSkus().stream().map(Mappers::sku).toList());
        return new SellerProductView(view, p.getStatus().name(), p.getModeration().name(), p.getModerationReason());
    }

    private static ProductView productWith(Product p, List<SkuView> skus) {
        List<com.mve.catalog.api.Dtos.ImageView> images = p.getImages().stream()
                .map(i -> new ImageView(i.getId(), i.getUrl(), i.getAlt(), i.getPosition())).toList();
        return new ProductView(p.getId(), p.getSellerId(), p.getTitle(), p.getDescription(), p.getCategory().getSlug(),
                p.getMinPricePaise(), p.getCurrency(), images, skus);
    }

    public static ProductSummary summary(Product p) {
        String image = p.getImages().isEmpty() ? null : p.getImages().get(0).getUrl();
        return new ProductSummary(p.getId(), p.getSellerId(), p.getTitle(), p.getCategory().getSlug(),
                p.getMinPricePaise(), p.getCurrency(), image);
    }
}
