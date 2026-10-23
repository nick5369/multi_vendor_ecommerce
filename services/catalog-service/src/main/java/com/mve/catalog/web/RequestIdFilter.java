package com.mve.catalog.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/** Propagates X-Request-Id (or creates one) into the MDC/response and logs one access line per request. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestIdFilter extends OncePerRequestFilter {
    private static final Pattern SAFE_ID = Pattern.compile("^[\\w-]{8,64}$");
    private static final Logger access = LoggerFactory.getLogger("access");

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String incoming = req.getHeader("X-Request-Id");
        String requestId = incoming != null && SAFE_ID.matcher(incoming).matches() ? incoming : UUID.randomUUID().toString();
        MDC.put("requestId", requestId);
        res.setHeader("X-Request-Id", requestId);
        long start = System.nanoTime();
        try {
            chain.doFilter(req, res);
        } finally {
            access.info("{} {} -> {} in {}ms", req.getMethod(), req.getRequestURI(), res.getStatus(), (System.nanoTime() - start) / 1_000_000);
            MDC.remove("requestId");
        }
    }
}
