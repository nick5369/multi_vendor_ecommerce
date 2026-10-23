package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// definitiveError marks a downstream answer that will not change on repeat (for example "insufficient stock").
// Any other error is treated as "outcome unknown", and the saga leaves the order where it is so the
// reconciler can repeat the (idempotent) step later.
type definitiveError struct {
	Status int
	Code   string
	Msg    string
}

func (e *definitiveError) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Msg) }

func isDefinitive(err error) bool {
	_, ok := err.(*definitiveError)
	return ok
}

type ReserveItem struct {
	SkuID    string `json:"skuId"`
	Quantity int    `json:"quantity"`
}

type InventoryClient interface {
	Reserve(checkoutID string, items []ReserveItem, ttlSeconds int) error
	Release(checkoutID string) error
	Commit(checkoutID string) error
}

type PaymentPayload struct {
	AttemptID       string `json:"attemptId"`
	OrderID         string `json:"orderId,omitempty"`
	Status          string `json:"status"`
	ProviderOrderID string `json:"providerOrderId"`
	KeyID           string `json:"keyId"`
	AmountPaise     int64  `json:"amountPaise"`
	Currency        string `json:"currency"`
	Gateway         string `json:"gateway"`
}

type PaymentStatus struct {
	Status  string `json:"status"`
	Expired bool   `json:"expired"`
}

type PaymentClient interface {
	Initiate(orderID, customerID string) (*PaymentPayload, error)
	Status(orderID string) (*PaymentStatus, error)
	// Expire atomically closes an attempt that has not been paid. If a payment is already in flight or captured it
	// refuses (Expired=false) and reports the current status.
	Expire(orderID string) (*PaymentStatus, error)
}

type internalHTTP struct {
	client *http.Client
	token  string
}

func (h *internalHTTP) do(method, url string, body any) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", h.token)
	resp, err := h.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	return resp.StatusCode, data, err
}

func errorCode(data []byte) (string, string) {
	var e struct {
		Error struct{ Code, Message string } `json:"error"`
	}
	_ = json.Unmarshal(data, &e)
	return e.Error.Code, e.Error.Message
}

// classify turns a non-success HTTP answer into a definitive error (4xx) or an unknown-outcome error (5xx).
func classify(status int, data []byte) error {
	code, msg := errorCode(data)
	if status >= 400 && status < 500 {
		return &definitiveError{Status: status, Code: code, Msg: msg}
	}
	return fmt.Errorf("downstream status %d", status)
}

// ---------------------------------------------------------------- inventory
type httpInventory struct {
	base string
	http *internalHTTP
}

func newInventoryClient(cfg Config) InventoryClient {
	return &httpInventory{base: cfg.InventoryURL, http: &internalHTTP{client: &http.Client{}, token: cfg.InternalToken}}
}

func (c *httpInventory) Reserve(checkoutID string, items []ReserveItem, ttl int) error {
	status, data, err := c.http.do(http.MethodPost, c.base+"/internal/reservations",
		map[string]any{"checkoutId": checkoutID, "items": items, "ttlSeconds": ttl})
	if err != nil {
		return err
	}
	if status == http.StatusOK || status == http.StatusCreated {
		return nil
	}
	return classify(status, data)
}

func (c *httpInventory) Release(checkoutID string) error {
	status, data, err := c.http.do(http.MethodPost, c.base+"/internal/reservations/"+checkoutID+"/release", nil)
	if err != nil {
		return err
	}
	if status == http.StatusOK || status == http.StatusNotFound { // 404: nothing was ever reserved
		return nil
	}
	return classify(status, data)
}

func (c *httpInventory) Commit(checkoutID string) error {
	status, data, err := c.http.do(http.MethodPost, c.base+"/internal/reservations/"+checkoutID+"/commit", nil)
	if err != nil {
		return err
	}
	if status == http.StatusOK {
		return nil
	}
	return classify(status, data)
}

// ---------------------------------------------------------------- payment
type httpPayment struct {
	base string
	http *internalHTTP
}

func newPaymentClient(cfg Config) PaymentClient {
	return &httpPayment{base: cfg.PaymentURL, http: &internalHTTP{client: &http.Client{}, token: cfg.InternalToken}}
}

func (c *httpPayment) Initiate(orderID, customerID string) (*PaymentPayload, error) {
	status, data, err := c.http.do(http.MethodPost, c.base+"/internal/payments",
		map[string]any{"orderId": orderID, "customerId": customerID, "idempotencyKey": "order-" + orderID})
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK && status != http.StatusCreated {
		return nil, classify(status, data)
	}
	var p PaymentPayload
	return &p, json.Unmarshal(data, &p)
}

func (c *httpPayment) Status(orderID string) (*PaymentStatus, error) {
	status, data, err := c.http.do(http.MethodGet, c.base+"/internal/payments/by-order/"+orderID, nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return &PaymentStatus{Status: "NONE"}, nil
	}
	if status != http.StatusOK {
		return nil, classify(status, data)
	}
	var s PaymentStatus
	return &s, json.Unmarshal(data, &s)
}

func (c *httpPayment) Expire(orderID string) (*PaymentStatus, error) {
	status, data, err := c.http.do(http.MethodPost, c.base+"/internal/payments/by-order/"+orderID+"/expire", nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound { // no payment attempt exists, nothing can be paid
		return &PaymentStatus{Status: "NONE", Expired: true}, nil
	}
	if status != http.StatusOK {
		return nil, classify(status, data)
	}
	var s PaymentStatus
	return &s, json.Unmarshal(data, &s)
}
