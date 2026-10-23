package com.mve.catalog.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.mve.catalog.api.Dtos.CategoryRequest;
import com.mve.catalog.api.Dtos.CategoryView;
import com.mve.catalog.api.Dtos.InternalSkuView;
import com.mve.catalog.api.Dtos.PageResponse;
import com.mve.catalog.api.Dtos.ProductSummary;
import com.mve.catalog.api.Dtos.ProductView;
import com.mve.catalog.domain.Entities.Category;
import com.mve.catalog.domain.Entities.Moderation;
import com.mve.catalog.domain.Entities.Product;
import com.mve.catalog.domain.Entities.ProductStatus;
import com.mve.catalog.domain.Entities.Sku;
import com.mve.catalog.domain.Repositories.CategoryRepository;
import com.mve.catalog.domain.Repositories.ProductRepository;
import com.mve.catalog.domain.Repositories.SkuRepository;
import jakarta.persistence.criteria.Predicate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Public read side with cache-aside (Redis). The database stays the source of truth. */
@Service
@Transactional(readOnly = true)
public class CatalogQueryService {
    private static final Map<String, Sort> SORTS = Map.of(
            "newest", Sort.by(Sort.Order.desc("createdAt"), Sort.Order.asc("id")),
            "price_asc", Sort.by(Sort.Order.asc("minPricePaise"), Sort.Order.asc("id")),
            "price_desc", Sort.by(Sort.Order.desc("minPricePaise"), Sort.Order.asc("id")),
            "title", Sort.by(Sort.Order.asc("title"), Sort.Order.asc("id")));

    public record SearchQuery(String q, String category, UUID seller, Long minPrice, Long maxPrice, String sort, int page, int size) {
        String canonical() {
            return String.join("|", String.valueOf(q), String.valueOf(category), String.valueOf(seller), String.valueOf(minPrice),
                    String.valueOf(maxPrice), String.valueOf(sort), String.valueOf(page), String.valueOf(size));
        }
    }

    private final ProductRepository products;
    private final CategoryRepository categories;
    private final SkuRepository skus;
    private final ProductCache cache;

    public CatalogQueryService(ProductRepository products, CategoryRepository categories, SkuRepository skus, ProductCache cache) {
        this.products = products;
        this.categories = categories;
        this.skus = skus;
        this.cache = cache;
    }

    public List<CategoryView> categories() {
        Optional<List<CategoryView>> hit = cache.get(ProductCache.categoriesKey(), new TypeReference<>() {});
        if (hit.isPresent()) return hit.get();
        List<CategoryView> all = categories.findAllByOrderByNameAsc().stream().map(Mappers::category).toList();
        cache.put(ProductCache.categoriesKey(), all);
        return all;
    }

    public ProductView detail(UUID id) {
        String key = ProductCache.productKey(id);
        Optional<ProductView> hit = cache.get(key, new TypeReference<>() {});
        if (hit.isPresent()) return hit.get();
        Product p = products.findById(id).filter(Product::isPubliclyVisible).orElseThrow(() -> ApiException.notFound("Product"));
        ProductView view = Mappers.product(p);
        cache.put(key, view);
        return view;
    }

    public PageResponse<ProductSummary> search(SearchQuery query) {
        if (query.minPrice() != null && query.maxPrice() != null && query.minPrice() > query.maxPrice()) {
            throw ApiException.badRequest("minPrice must not exceed maxPrice");
        }
        String key = cache.listKey(query.canonical());
        Optional<PageResponse<ProductSummary>> hit = cache.get(key, new TypeReference<>() {});
        if (hit.isPresent()) return hit.get();

        Sort sort = SORTS.get(query.sort() == null ? "newest" : query.sort());
        if (sort == null) throw ApiException.badRequest("Unknown sort: " + query.sort());
        var page = products.findAll(spec(query), PageRequest.of(query.page(), query.size(), sort));
        var response = new PageResponse<>(page.map(Mappers::summary).getContent(), query.page(), query.size(), page.getTotalElements());
        cache.put(key, response);
        return response;
    }

    /** Trusted lookup for other services: always reads the database so price/purchasability are current. */
    public List<InternalSkuView> internalLookup(Collection<UUID> ids) {
        return skus.findByIdIn(ids).stream().map(CatalogQueryService::internalView).toList();
    }

    private static InternalSkuView internalView(Sku s) {
        Product p = s.getProduct();
        boolean purchasable = s.isActive() && p.isPubliclyVisible();
        return new InternalSkuView(s.getId(), p.getId(), s.getSellerId(), p.getTitle(), s.getName(), s.getPricePaise(), p.getCurrency(), purchasable);
    }

    @Transactional
    public CategoryView createCategory(CategoryRequest req) {
        if (categories.findBySlug(req.slug()).isPresent()) throw ApiException.conflict("Category slug exists");
        UUID parent = null;
        if (req.parentSlug() != null) {
            parent = categories.findBySlug(req.parentSlug()).orElseThrow(() -> ApiException.badRequest("Unknown parent")).getId();
        }
        UUID id = UUID.randomUUID();
        categories.save(new Category(id, req.slug(), req.name(), parent));
        cache.invalidateCategories();
        return new CategoryView(id, req.slug(), req.name(), parent);
    }

    private Specification<Product> spec(SearchQuery q) {
        return (root, cq, cb) -> {
            List<Predicate> ps = new ArrayList<>();
            ps.add(cb.equal(root.get("status"), ProductStatus.ACTIVE));
            ps.add(cb.equal(root.get("moderation"), Moderation.APPROVED));
            if (q.q() != null && !q.q().isBlank()) {
                String escaped = q.q().trim().toLowerCase().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
                ps.add(cb.like(cb.lower(root.get("title")), "%" + escaped + "%", '\\'));
            }
            if (q.category() != null && !q.category().isBlank()) {
                ps.add(root.get("category").get("id").in(categoryIds(q.category())));
            }
            if (q.seller() != null) ps.add(cb.equal(root.get("sellerId"), q.seller()));
            if (q.minPrice() != null) ps.add(cb.greaterThanOrEqualTo(root.get("minPricePaise"), q.minPrice()));
            if (q.maxPrice() != null) ps.add(cb.lessThanOrEqualTo(root.get("minPricePaise"), q.maxPrice()));
            return cb.and(ps.toArray(Predicate[]::new));
        };
    }

    /** A category filter includes its direct children (one level, which is what the seed hierarchy uses). */
    private List<UUID> categoryIds(String slug) {
        Category c = categories.findBySlug(slug).orElse(null);
        if (c == null) return List.of(new UUID(0, 0));
        List<UUID> ids = new ArrayList<>(List.of(c.getId()));
        categories.findByParentId(c.getId()).forEach(child -> ids.add(child.getId()));
        return ids;
    }
}
