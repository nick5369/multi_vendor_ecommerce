package com.mve.catalog.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.mve.catalog.config.AppProperties;
import java.time.Duration;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Cache-aside helper for PUBLIC catalog reads only. Keys never contain seller-private data.
 * Redis is an optimisation: any Redis failure is treated as a cache miss, never as a business error.
 *
 * Listing keys embed a generation counter; bumping it makes every cached listing unreachable at once
 * (they then expire by TTL), which is how listings are invalidated when any product changes.
 */
@Component
public class ProductCache {
    private static final Logger log = LoggerFactory.getLogger(ProductCache.class);
    private static final String PREFIX = "catalog:v1:";
    private static final String GENERATION_KEY = PREFIX + "gen";

    private final StringRedisTemplate redis;
    private final ObjectMapper mapper;
    private final Duration ttl;

    public ProductCache(StringRedisTemplate redis, ObjectMapper mapper, AppProperties props) {
        this.redis = redis;
        this.mapper = mapper;
        this.ttl = Duration.ofSeconds(props.cacheTtlSeconds());
    }

    public static String productKey(UUID id) { return PREFIX + "product:" + id; }

    public static String categoriesKey() { return PREFIX + "categories"; }

    public String listKey(String canonicalQuery) {
        return PREFIX + "list:" + generation() + ":" + Integer.toHexString(canonicalQuery.hashCode()) + ":" + canonicalQuery.length();
    }

    public <T> Optional<T> get(String key, TypeReference<T> type) {
        try {
            String json = redis.opsForValue().get(key);
            return json == null ? Optional.empty() : Optional.of(mapper.readValue(json, type));
        } catch (RuntimeException | JsonProcessingException e) {
            log.warn("cache read skipped key={} reason={}", key, e.getClass().getSimpleName());
            return Optional.empty();
        }
    }

    public void put(String key, Object value) {
        try {
            redis.opsForValue().set(key, mapper.writeValueAsString(value), ttl);
        } catch (RuntimeException | JsonProcessingException e) {
            log.warn("cache write skipped key={} reason={}", key, e.getClass().getSimpleName());
        }
    }

    /** Evicts after the surrounding DB transaction commits, so readers cannot re-cache pre-commit data. */
    public void invalidateProductAfterCommit(UUID productId) {
        Runnable evict = () -> {
            try {
                redis.delete(productKey(productId));
                redis.opsForValue().increment(GENERATION_KEY);
            } catch (RuntimeException e) {
                log.warn("cache invalidation failed product={} reason={}", productId, e.getClass().getSimpleName());
            }
        };
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() { evict.run(); }
            });
        } else {
            evict.run();
        }
    }

    public void invalidateCategories() {
        try {
            redis.delete(categoriesKey());
        } catch (RuntimeException e) {
            log.warn("category cache invalidation failed");
        }
    }

    private String generation() {
        try {
            String g = redis.opsForValue().get(GENERATION_KEY);
            return g == null ? "0" : g;
        } catch (RuntimeException e) {
            return "0";
        }
    }
}
