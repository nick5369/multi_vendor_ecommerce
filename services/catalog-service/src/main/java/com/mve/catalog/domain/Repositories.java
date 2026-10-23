package com.mve.catalog.domain;

import com.mve.catalog.domain.Entities.Category;
import com.mve.catalog.domain.Entities.OutboxEvent;
import com.mve.catalog.domain.Entities.Product;
import com.mve.catalog.domain.Entities.Sku;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public final class Repositories {
    private Repositories() {}

    public interface CategoryRepository extends JpaRepository<Category, UUID> {
        Optional<Category> findBySlug(String slug);

        List<Category> findByParentId(UUID parentId);

        List<Category> findAllByOrderByNameAsc();
    }

    public interface ProductRepository extends JpaRepository<Product, UUID>, JpaSpecificationExecutor<Product> {
        Optional<Product> findByIdAndSellerId(UUID id, UUID sellerId);
    }

    public interface SkuRepository extends JpaRepository<Sku, UUID> {
        Optional<Sku> findByIdAndSellerId(UUID id, UUID sellerId);

        List<Sku> findByIdIn(Collection<UUID> ids);

        boolean existsBySellerIdAndSkuCode(UUID sellerId, String skuCode);
    }

    public interface OutboxRepository extends JpaRepository<OutboxEvent, UUID> {
        /** SKIP LOCKED lets several publisher instances share the table without double-sending a row. */
        @Query(value = "select * from outbox_events where published_at is null order by created_at limit :n for update skip locked",
                nativeQuery = true)
        List<OutboxEvent> lockUnpublished(@Param("n") int n);
    }
}
