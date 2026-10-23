package com.mve.catalog.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app")
public record AppProperties(
        long cacheTtlSeconds,
        String internalToken,
        String jwksUrl,
        String jwtIssuer,
        String jwtAudience) {}
