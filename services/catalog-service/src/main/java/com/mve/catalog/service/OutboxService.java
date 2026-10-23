package com.mve.catalog.service;

import com.mve.catalog.domain.Entities.OutboxEvent;
import com.mve.catalog.domain.Entities.Product;
import com.mve.catalog.domain.Repositories.OutboxRepository;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Writes domain events into the outbox in the caller's transaction (MANDATORY: no ambient tx, no event). */
@Service
public class OutboxService {
    private final OutboxRepository repository;

    public OutboxService(OutboxRepository repository) {
        this.repository = repository;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void productPublished(Product product) {
        record("ProductPublished", "product.published.v1", product);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void productUpdated(Product product) {
        record("ProductUpdated", "product.updated.v1", product);
    }

    private void record(String type, String routingKey, Product p) {
        UUID eventId = UUID.randomUUID();
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("productId", p.getId().toString());
        data.put("sellerId", p.getSellerId().toString());
        data.put("title", p.getTitle());
        data.put("status", p.getStatus().name());
        data.put("moderation", p.getModeration().name());
        data.put("minPricePaise", p.getMinPricePaise());
        data.put("currency", p.getCurrency());
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("eventId", eventId.toString());
        envelope.put("eventType", type);
        envelope.put("version", 1);
        envelope.put("occurredAt", Instant.now().toString());
        envelope.put("data", data);
        repository.save(new OutboxEvent(eventId, type, routingKey, envelope));
    }
}
