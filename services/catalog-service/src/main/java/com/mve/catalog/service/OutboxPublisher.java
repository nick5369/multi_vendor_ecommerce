package com.mve.catalog.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.mve.catalog.domain.Entities.OutboxEvent;
import com.mve.catalog.domain.Repositories.OutboxRepository;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageBuilder;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Relays committed outbox rows to the RabbitMQ topic exchange. A crash after publish but before commit
 * re-sends the row, so consumers de-duplicate on eventId (at-least-once delivery).
 */
@Component
public class OutboxPublisher {
    public static final String EXCHANGE = "mve.events";
    private static final Logger log = LoggerFactory.getLogger(OutboxPublisher.class);

    private final OutboxRepository repository;
    private final RabbitTemplate rabbit;
    private final ObjectMapper mapper;

    public OutboxPublisher(OutboxRepository repository, RabbitTemplate rabbit, ObjectMapper mapper) {
        this.repository = repository;
        this.rabbit = rabbit;
        this.mapper = mapper;
    }

    @Scheduled(fixedDelay = 1000)
    @Transactional
    public void relay() {
        List<OutboxEvent> batch = repository.lockUnpublished(50);
        try {
            for (OutboxEvent event : batch) {
                rabbit.send(EXCHANGE, event.getRoutingKey(), toMessage(event));
                event.markPublished();
            }
        } catch (RuntimeException | JsonProcessingException e) {
            // unpublished rows stay in the table and are picked up by the next scheduled run
            log.warn("outbox relay stopped: {}", e.getClass().getSimpleName());
        }
    }

    private Message toMessage(OutboxEvent event) throws JsonProcessingException {
        return MessageBuilder.withBody(mapper.writeValueAsBytes(event.getPayload()))
                .setContentType(MessageProperties.CONTENT_TYPE_JSON)
                .setMessageId(event.getId().toString())
                .setType(event.getEventType())
                .build();
    }
}
