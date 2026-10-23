package com.mve.catalog.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Stateless JWT resource server. Tokens are verified against the auth-service JWKS (RS256, issuer + audience).
 * Authorization is enforced here, independently of the gateway.
 */
@Configuration
@EnableConfigurationProperties(AppProperties.class)
public class SecurityConfig {

    @Bean
    JwtDecoder jwtDecoder(AppProperties props) {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(props.jwksUrl()).jwsAlgorithm(SignatureAlgorithm.RS256).build();
        OAuth2TokenValidator<Jwt> audience = jwt -> jwt.getAudience().contains(props.jwtAudience())
                ? OAuth2TokenValidatorResult.success()
                : OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "wrong audience", null));
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(JwtValidators.createDefaultWithIssuer(props.jwtIssuer()), audience));
        return decoder;
    }

    @Bean
    JwtAuthenticationConverter jwtAuthenticationConverter() {
        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(jwt -> {
            List<String> roles = jwt.getClaimAsStringList("roles");
            Collection<GrantedAuthority> out = new java.util.ArrayList<>();
            if (roles != null) roles.forEach(r -> out.add(new SimpleGrantedAuthority("ROLE_" + r)));
            return out;
        });
        return converter;
    }

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http, JwtDecoder decoder, JwtAuthenticationConverter converter,
                                    AppProperties props, ObjectMapper mapper) throws Exception {
        http.csrf(AbstractHttpConfigurer::disable)
                .cors(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .headers(h -> h.frameOptions(f -> f.deny()).contentTypeOptions(Customizer.withDefaults()))
                .authorizeHttpRequests(a -> a
                        .requestMatchers(HttpMethod.GET, "/products", "/products/*", "/categories").permitAll()
                        .requestMatchers("/internal/**").permitAll() // guarded by InternalTokenFilter
                        // actuator is served only on the internal management port (8081), never on the public port
                        .requestMatchers("/actuator/**").permitAll()
                        .requestMatchers("/seller/**").hasRole("SELLER")
                        .requestMatchers("/admin/**").hasRole("ADMIN")
                        .anyRequest().denyAll())
                .oauth2ResourceServer(o -> o
                        .jwt(j -> j.decoder(decoder).jwtAuthenticationConverter(converter))
                        .authenticationEntryPoint((req, res, ex) -> writeError(mapper, res, 401, "UNAUTHORIZED", "Authentication required"))
                        .accessDeniedHandler((req, res, ex) -> writeError(mapper, res, 403, "FORBIDDEN", "Access denied")))
                .exceptionHandling(e -> e
                        .authenticationEntryPoint((req, res, ex) -> writeError(mapper, res, 401, "UNAUTHORIZED", "Authentication required"))
                        .accessDeniedHandler((req, res, ex) -> writeError(mapper, res, 403, "FORBIDDEN", "Access denied")))
                .addFilterBefore(new InternalTokenFilter(props.internalToken(), mapper),
                        org.springframework.security.web.authentication.AnonymousAuthenticationFilter.class);
        return http.build();
    }

    static void writeError(ObjectMapper mapper, HttpServletResponse res, int status, String code, String message) throws IOException {
        res.setStatus(status);
        res.setContentType(MediaType.APPLICATION_JSON_VALUE);
        mapper.writeValue(res.getOutputStream(), Map.of("error", Map.of("code", code, "message", message)));
    }

    /** /internal/** is for other services only: requires the shared secret, compared in constant time. */
    static final class InternalTokenFilter extends OncePerRequestFilter {
        private final byte[] expected;
        private final ObjectMapper mapper;

        InternalTokenFilter(String token, ObjectMapper mapper) {
            this.expected = token.getBytes(StandardCharsets.UTF_8);
            this.mapper = mapper;
        }

        @Override
        protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
                throws ServletException, IOException {
            if (req.getRequestURI().startsWith("/internal/")) {
                String presented = req.getHeader("X-Internal-Token");
                boolean ok = presented != null && MessageDigest.isEqual(expected, presented.getBytes(StandardCharsets.UTF_8));
                if (!ok) {
                    writeError(mapper, res, 403, "FORBIDDEN", "Internal endpoint");
                    return;
                }
            }
            chain.doFilter(req, res);
        }
    }
}
