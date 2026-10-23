package com.mve.catalog.config;

import com.mve.catalog.service.OutboxPublisher;
import org.springframework.amqp.core.TopicExchange;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

@Configuration
@EnableScheduling
public class RabbitConfig {
    /** Durable topic exchange shared by every service; declared idempotently on connection. */
    @Bean
    TopicExchange eventsExchange() {
        return new TopicExchange(OutboxPublisher.EXCHANGE, true, false);
    }
}
