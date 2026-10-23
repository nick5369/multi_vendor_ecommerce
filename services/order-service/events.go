package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	amqp "github.com/rabbitmq/amqp091-go"
	"gorm.io/gorm"
)

const eventExchange = "mve.events"

// emit writes a domain event to the outbox inside the caller's transaction. Nothing is published here:
// the relay below sends committed rows, so an event exists if and only if the business change committed.
func emit(tx *gorm.DB, eventType, routingKey string, data map[string]any) error {
	id := uuid.NewString()
	envelope := map[string]any{
		"eventId":    id,
		"eventType":  eventType,
		"version":    1,
		"occurredAt": time.Now().UTC().Format(time.RFC3339Nano),
		"data":       data,
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	return tx.Exec("INSERT INTO outbox_events (id, event_type, routing_key, payload) VALUES (?, ?, ?, ?)",
		id, eventType, routingKey, string(payload)).Error
}

type Broker struct {
	url string
	db  *gorm.DB
}

func newBroker(url string, db *gorm.DB) *Broker { return &Broker{url: url, db: db} }

// RunRelay publishes unpublished outbox rows (at-least-once). Rows are claimed with SKIP LOCKED.
// A crash between publish and commit re-sends a row; consumers de-duplicate on eventId via the inbox table.
func (b *Broker) RunRelay(ctx context.Context) {
	for ctx.Err() == nil {
		if err := b.relayLoop(ctx); err != nil {
			logger.Warn("outbox relay paused", "reason", err.Error())
			select {
			case <-ctx.Done():
			case <-time.After(2 * time.Second):
			}
		}
	}
}

func (b *Broker) relayLoop(ctx context.Context) error {
	conn, err := amqp.Dial(b.url)
	if err != nil {
		return err
	}
	defer conn.Close()
	ch, err := conn.Channel()
	if err != nil {
		return err
	}
	if err := ch.ExchangeDeclare(eventExchange, "topic", true, false, false, false, nil); err != nil {
		return err
	}
	for ctx.Err() == nil {
		n, err := b.relayOnce(ctx, ch)
		if err != nil {
			return err
		}
		if n == 0 {
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
			}
		}
	}
	return nil
}

func (b *Broker) relayOnce(ctx context.Context, ch *amqp.Channel) (int, error) {
	published := 0
	err := b.db.Transaction(func(tx *gorm.DB) error {
		var rows []struct {
			ID         string
			EventType  string
			RoutingKey string
			Payload    []byte
		}
		if err := tx.Raw("SELECT id, event_type, routing_key, payload FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED").
			Scan(&rows).Error; err != nil {
			return err
		}
		for _, r := range rows {
			err := ch.PublishWithContext(ctx, eventExchange, r.RoutingKey, false, false, amqp.Publishing{
				ContentType: "application/json", MessageId: r.ID, Type: r.EventType, Body: r.Payload, DeliveryMode: amqp.Persistent,
			})
			if err != nil {
				return err
			}
			if err := tx.Exec("UPDATE outbox_events SET published_at = NOW(6) WHERE id = ?", r.ID).Error; err != nil {
				return err
			}
			published++
		}
		return nil
	})
	return published, err
}

type Envelope struct {
	EventID   string                    `json:"eventId"`
	EventType string                    `json:"eventType"`
	Data      map[string]any            `json:"data"`
}

// EventHandler processes one event. Returning an error leaves the message unacknowledged so it is redelivered.
type EventHandler func(env Envelope) error

// RunConsumer subscribes to the payment events the order saga depends on.
func (b *Broker) RunConsumer(ctx context.Context, handler EventHandler) {
	for ctx.Err() == nil {
		if err := b.consumeLoop(ctx, handler); err != nil && !errors.Is(err, context.Canceled) {
			logger.Warn("event consumer paused", "reason", err.Error())
		}
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
}

func (b *Broker) consumeLoop(ctx context.Context, handler EventHandler) error {
	conn, err := amqp.Dial(b.url)
	if err != nil {
		return err
	}
	defer conn.Close()
	ch, err := conn.Channel()
	if err != nil {
		return err
	}
	if err := ch.ExchangeDeclare(eventExchange, "topic", true, false, false, false, nil); err != nil {
		return err
	}
	q, err := ch.QueueDeclare("order-service.events", true, false, false, false, nil)
	if err != nil {
		return err
	}
	for _, key := range []string{"payment.succeeded.v1", "payment.failed.v1", "refund.succeeded.v1"} {
		if err := ch.QueueBind(q.Name, key, eventExchange, false, nil); err != nil {
			return err
		}
	}
	if err := ch.Qos(10, 0, false); err != nil {
		return err
	}
	deliveries, err := ch.Consume(q.Name, "", false, false, false, false, nil)
	if err != nil {
		return err
	}
	closed := conn.NotifyClose(make(chan *amqp.Error, 1))
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case e := <-closed:
			return e
		case d, ok := <-deliveries:
			if !ok {
				return errors.New("delivery channel closed")
			}
			var env Envelope
			if err := json.Unmarshal(d.Body, &env); err != nil {
				_ = d.Nack(false, false) // unparseable: drop rather than loop forever
				continue
			}
			if err := handler(env); err != nil {
				logger.Warn("event handling failed", "eventId", env.EventID, "type", env.EventType, "reason", err.Error())
				_ = d.Nack(false, true)
				time.Sleep(time.Second)
				continue
			}
			_ = d.Ack(false)
		}
	}
}
