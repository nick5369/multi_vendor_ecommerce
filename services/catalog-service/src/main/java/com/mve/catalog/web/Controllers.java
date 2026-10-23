package com.mve.catalog.web;

import com.mve.catalog.api.Dtos.CategoryRequest;
import com.mve.catalog.api.Dtos.CategoryView;
import com.mve.catalog.api.Dtos.CreateProductRequest;
import com.mve.catalog.api.Dtos.ImageInput;
import com.mve.catalog.api.Dtos.ImageView;
import com.mve.catalog.api.Dtos.InternalSkuView;
import com.mve.catalog.api.Dtos.ModerationRequest;
import com.mve.catalog.api.Dtos.PageResponse;
import com.mve.catalog.api.Dtos.ProductSummary;
import com.mve.catalog.api.Dtos.ProductView;
import com.mve.catalog.api.Dtos.SellerProductView;
import com.mve.catalog.api.Dtos.SkuInput;
import com.mve.catalog.api.Dtos.SkuLookupRequest;
import com.mve.catalog.api.Dtos.StatusRequest;
import com.mve.catalog.api.Dtos.UpdateProductRequest;
import com.mve.catalog.api.Dtos.UpdateSkuRequest;
import com.mve.catalog.service.ApiException;
import com.mve.catalog.service.CatalogQueryService;
import com.mve.catalog.service.CatalogQueryService.SearchQuery;
import com.mve.catalog.service.ProductService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** HTTP layer: thin mapping from requests to services. All rules live in the service classes. */
public final class Controllers {
    private Controllers() {}

    /** The seller id is the store id claim issued by auth-service while the store is ACTIVE. */
    static UUID sellerId(Jwt jwt) {
        String store = jwt.getClaimAsString("storeId");
        if (store == null) throw ApiException.forbidden("No active store for this account");
        return UUID.fromString(store);
    }

    @RestController
    @Validated
    public static class PublicController {
        private final CatalogQueryService query;

        public PublicController(CatalogQueryService query) {
            this.query = query;
        }

        @GetMapping("/categories")
        public List<CategoryView> categories() {
            return query.categories();
        }

        @GetMapping("/products")
        public PageResponse<ProductSummary> search(
                @RequestParam(required = false) String q,
                @RequestParam(required = false) String category,
                @RequestParam(required = false) UUID seller,
                @RequestParam(required = false) @Min(0) Long minPrice,
                @RequestParam(required = false) @Min(0) Long maxPrice,
                @RequestParam(required = false) String sort,
                @RequestParam(defaultValue = "0") @Min(0) int page,
                @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
            return query.search(new SearchQuery(q, category, seller, minPrice, maxPrice, sort, page, size));
        }

        @GetMapping("/products/{id}")
        public ProductView detail(@PathVariable UUID id) {
            return query.detail(id);
        }
    }

    @RestController
    @RequestMapping("/seller")
    @Validated
    public static class SellerController {
        private final ProductService service;

        public SellerController(ProductService service) {
            this.service = service;
        }

        @PostMapping("/products")
        @ResponseStatus(HttpStatus.CREATED)
        public SellerProductView create(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody CreateProductRequest req) {
            return service.create(sellerId(jwt), req);
        }

        @GetMapping("/products")
        public PageResponse<SellerProductView> list(@AuthenticationPrincipal Jwt jwt,
                                                    @RequestParam(required = false) String status,
                                                    @RequestParam(defaultValue = "0") @Min(0) int page,
                                                    @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
            return service.listOwn(sellerId(jwt), status, page, size);
        }

        @GetMapping("/products/{id}")
        public SellerProductView get(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
            return service.getOwn(sellerId(jwt), id);
        }

        @PutMapping("/products/{id}")
        public SellerProductView update(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
                                        @Valid @RequestBody UpdateProductRequest req) {
            return service.update(sellerId(jwt), id, req);
        }

        @PostMapping("/products/{id}/status")
        public SellerProductView status(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
                                        @Valid @RequestBody StatusRequest req) {
            return service.setStatus(sellerId(jwt), id, req.status());
        }

        @PostMapping("/products/{id}/variants")
        @ResponseStatus(HttpStatus.CREATED)
        public SellerProductView addVariant(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
                                            @Valid @RequestBody SkuInput req) {
            return service.addVariant(sellerId(jwt), id, req);
        }

        @PutMapping("/skus/{skuId}")
        public SellerProductView updateSku(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID skuId,
                                           @Valid @RequestBody UpdateSkuRequest req) {
            return service.updateSku(sellerId(jwt), skuId, req);
        }

        @PostMapping("/products/{id}/images")
        @ResponseStatus(HttpStatus.CREATED)
        public ImageView addImage(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id, @Valid @RequestBody ImageInput req) {
            return service.addImage(sellerId(jwt), id, req);
        }

        @DeleteMapping("/products/{id}/images/{imageId}")
        @ResponseStatus(HttpStatus.NO_CONTENT)
        public void deleteImage(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id, @PathVariable UUID imageId) {
            service.deleteImage(sellerId(jwt), id, imageId);
        }
    }

    @RestController
    @RequestMapping("/admin")
    @Validated
    public static class AdminController {
        private final ProductService service;
        private final CatalogQueryService query;

        public AdminController(ProductService service, CatalogQueryService query) {
            this.service = service;
            this.query = query;
        }

        @GetMapping("/products")
        public PageResponse<SellerProductView> list(@RequestParam(required = false) String status,
                                                    @RequestParam(required = false) String moderation,
                                                    @RequestParam(defaultValue = "0") @Min(0) int page,
                                                    @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
            return service.listAll(status, moderation, page, size);
        }

        @PostMapping("/products/{id}/moderation")
        public SellerProductView moderate(@PathVariable UUID id, @Valid @RequestBody ModerationRequest req) {
            return service.moderate(id, req.status(), req.reason());
        }

        @PostMapping("/categories")
        @ResponseStatus(HttpStatus.CREATED)
        public CategoryView createCategory(@Valid @RequestBody CategoryRequest req) {
            return query.createCategory(req);
        }
    }

    /** Service-to-service contract. Guarded by the X-Internal-Token filter; not reachable through the gateway. */
    @RestController
    @RequestMapping("/internal")
    public static class InternalController {
        private final CatalogQueryService query;

        public InternalController(CatalogQueryService query) {
            this.query = query;
        }

        @PostMapping("/skus/lookup")
        public List<InternalSkuView> lookup(@Valid @RequestBody SkuLookupRequest req) {
            return query.internalLookup(req.ids());
        }
    }
}
