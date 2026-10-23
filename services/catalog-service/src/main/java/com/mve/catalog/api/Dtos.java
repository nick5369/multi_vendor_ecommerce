package com.mve.catalog.api;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Request/response DTOs. Money is always integer paise (INR minor units). */
public final class Dtos {
    private Dtos() {}

    public static final long MAX_PRICE_PAISE = 100_000_000L; // INR 10,00,000
    public static final String SKU_CODE_REGEX = "^[A-Za-z0-9._-]{1,64}$";
    public static final String IMAGE_URL_REGEX = "^https?://[^\\s]{1,490}$";

    // ---------- responses ----------
    public record ImageView(UUID id, String url, String alt, int position) {}

    public record SkuView(UUID id, String skuCode, String name, long pricePaise, Map<String, String> attributes, boolean isDefault) {}

    public record ProductView(UUID id, UUID sellerId, String title, String description, String categorySlug,
                              long minPricePaise, String currency, List<ImageView> images, List<SkuView> skus) {}

    public record ProductSummary(UUID id, UUID sellerId, String title, String categorySlug, long minPricePaise,
                                 String currency, String imageUrl) {}

    public record SellerProductView(ProductView product, String status, String moderation, String moderationReason) {}

    public record CategoryView(UUID id, String slug, String name, UUID parentId) {}

    public record PageResponse<T>(List<T> items, int page, int size, long total) {}

    public record InternalSkuView(UUID skuId, UUID productId, UUID sellerId, String title, String skuName, long pricePaise,
                                  String currency, boolean purchasable) {}

    // ---------- requests ----------
    public record SkuInput(
            @NotBlank @Pattern(regexp = SKU_CODE_REGEX, message = "must be 1-64 chars of letters, digits, '.', '_' or '-'") String skuCode,
            @NotBlank @Size(max = 120) String name,
            @Min(1) @Max(MAX_PRICE_PAISE) long pricePaise,
            @Size(max = 20) Map<@NotBlank @Size(max = 60) String, @NotNull @Size(max = 120) String> attributes) {}

    public record ImageInput(
            @NotBlank @Pattern(regexp = IMAGE_URL_REGEX, message = "must be an http(s) URL") String url,
            @Size(max = 200) String alt,
            @Min(0) @Max(100) int position) {}

    /**
     * Without {@code variants} the product gets one default SKU built from skuCode/pricePaise.
     * With {@code variants} no default SKU exists and skuCode/pricePaise must be omitted.
     */
    public record CreateProductRequest(
            @NotBlank @Size(max = 200) String title,
            @Size(max = 5000) String description,
            @NotBlank String categorySlug,
            String status,
            @Pattern(regexp = SKU_CODE_REGEX) String skuCode,
            @Min(1) @Max(MAX_PRICE_PAISE) Long pricePaise,
            @Valid @Size(max = 50) List<SkuInput> variants,
            @Valid @Size(max = 10) List<ImageInput> images) {}

    public record UpdateProductRequest(
            @NotBlank @Size(max = 200) String title,
            @Size(max = 5000) String description,
            @NotBlank String categorySlug) {}

    public record UpdateSkuRequest(
            @NotBlank @Size(max = 120) String name,
            @Min(1) @Max(MAX_PRICE_PAISE) long pricePaise,
            @Size(max = 20) Map<@NotBlank @Size(max = 60) String, @NotNull @Size(max = 120) String> attributes,
            boolean active) {}

    public record StatusRequest(@NotBlank @Pattern(regexp = "DRAFT|ACTIVE|ARCHIVED") String status) {}

    public record ModerationRequest(@NotBlank @Pattern(regexp = "APPROVED|SUSPENDED") String status,
                                    @Size(max = 500) String reason) {}

    public record CategoryRequest(@NotBlank @Pattern(regexp = "^[a-z0-9-]{2,80}$") String slug,
                                  @NotBlank @Size(max = 120) String name,
                                  String parentSlug) {}

    public record SkuLookupRequest(@NotEmpty @Size(max = 200) List<UUID> ids) {}
}
