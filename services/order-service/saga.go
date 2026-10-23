package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Saga owns checkout orchestration. Every step is persisted as an order status, and every call to another
// service is idempotent (inventory keyed by the order id, payment keyed by "order-<id>"), so any step can be
// repeated safely by the request handler, an event handler or the reconciler.
type Saga struct {
	db        *gorm.DB
	catalog   CatalogClient
	inventory InventoryClient
	payments  PaymentClient
	cfg       Config
}

func NewSaga(db *gorm.DB, catalog CatalogClient, inv InventoryClient, pay PaymentClient, cfg Config) *Saga {
	return &Saga{db: db, catalog: catalog, inventory: inv, payments: pay, cfg: cfg}
}

type Address struct {
	Name    string `json:"name" binding:"required,max=100"`
	Line1   string `json:"line1" binding:"required,max=200"`
	Line2   string `json:"line2" binding:"max=200"`
	City    string `json:"city" binding:"required,max=100"`
	State   string `json:"state" binding:"required,max=100"`
	Pincode string `json:"pincode" binding:"required,len=6,numeric"`
	Phone   string `json:"phone" binding:"required,len=10,numeric"`
}

type CheckoutRequest struct {
	ShippingAddress Address `json:"shippingAddress" binding:"required"`
}

func (a Address) normalized() Address {
	t := strings.TrimSpace
	return Address{t(a.Name), t(a.Line1), t(a.Line2), t(a.City), t(a.State), t(a.Pincode), t(a.Phone)}
}

func hashRequest(addr Address) string {
	raw, _ := json.Marshal(addr)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// ---------------------------------------------------------------- checkout
type cartRow struct {
	SkuID    string
	Quantity int
}

// Checkout turns the customer's cart into one parent order with a suborder per seller.
// created=false means the idempotency key had been used before and the existing order is returned.
func (s *Saga) Checkout(customerID, key string, addr Address) (orderID string, created bool, err error) {
	addr = addr.normalized()
	hash := hashRequest(addr)

	if id, found, err := s.lookupIdempotency(customerID, key, hash); err != nil || found {
		return id, false, err
	}

	var rows []cartRow
	if err := s.db.Raw("SELECT ci.sku_id, ci.quantity FROM cart_items ci JOIN carts c ON c.id = ci.cart_id WHERE c.customer_id = ? ORDER BY ci.created_at, ci.id", customerID).
		Scan(&rows).Error; err != nil {
		return "", false, err
	}
	if len(rows) == 0 {
		return "", false, newErr(http.StatusUnprocessableEntity, "CART_EMPTY", "Your cart is empty")
	}
	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.SkuID
	}
	skus, err := s.catalog.Lookup(ids)
	if err != nil {
		return "", false, newErr(http.StatusServiceUnavailable, "CATALOG_UNAVAILABLE", "Could not verify cart items")
	}

	// Re-validate against the catalog now; prices and titles are snapshotted from these answers, not from the cart.
	var unavailable []string
	for _, r := range rows {
		if sku, ok := skus[strings.ToLower(r.SkuID)]; !ok || !sku.Purchasable {
			unavailable = append(unavailable, r.SkuID)
		}
	}
	if len(unavailable) > 0 {
		return "", false, &APIError{Status: http.StatusUnprocessableEntity, Code: "SKU_NOT_PURCHASABLE", Message: "Some items are no longer available", Details: unavailable}
	}

	plan, err := s.buildPlan(rows, skus)
	if err != nil {
		return "", false, err
	}
	orderID = uuid.NewString()
	addrJSON, _ := json.Marshal(addr)

	err = s.db.Transaction(func(tx *gorm.DB) error {
		claim := tx.Exec("INSERT INTO checkout_idempotency (customer_id, idem_key, request_hash, order_id) VALUES (?, ?, ?, ?)", customerID, key, hash, orderID)
		if claim.Error != nil {
			var me *mysql.MySQLError
			if errors.As(claim.Error, &me) && me.Number == mysqlDuplicateKey {
				id, found, lerr := s.lookupIdempotency(customerID, key, hash)
				if lerr != nil {
					return lerr
				}
				if !found {
					return errors.New("idempotency record vanished")
				}
				orderID, created = id, false
				return nil
			}
			return claim.Error
		}
		created = true
		if err := tx.Exec(`INSERT INTO orders (id, customer_id, status, currency, subtotal_paise, shipping_paise, discount_paise, tax_paise, total_paise, shipping_address)
			VALUES (?, ?, ?, 'INR', ?, ?, 0, ?, ?, ?)`,
			orderID, customerID, StPendingStock, plan.subtotal, plan.shipping, plan.tax, plan.total, string(addrJSON)).Error; err != nil {
			return err
		}
		for _, g := range plan.groups {
			if err := tx.Exec(`INSERT INTO order_seller_groups (id, order_id, seller_id, status, subtotal_paise, shipping_paise, tax_paise, total_paise)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, g.id, orderID, g.sellerID, StPendingStock, g.subtotal, g.shipping, g.tax, g.total).Error; err != nil {
				return err
			}
			for _, it := range g.items {
				if err := tx.Exec(`INSERT INTO order_items (id, order_id, group_id, seller_id, sku_id, product_id, title, sku_name, unit_price_paise, quantity, line_total_paise, currency)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, uuid.NewString(), orderID, g.id, g.sellerID, it.skuID, it.productID, it.title, it.skuName,
					it.unitPrice, it.quantity, it.unitPrice*int64(it.quantity), it.currency).Error; err != nil {
					return err
				}
			}
		}
		if err := tx.Exec("INSERT INTO order_status_history (order_id, to_status, actor, reason) VALUES (?, ?, ?, 'checkout created')", orderID, StPendingStock, "customer:"+customerID).Error; err != nil {
			return err
		}
		return emit(tx, "OrderCreated", "order.created.v1", map[string]any{
			"orderId": orderID, "customerId": customerID, "totalPaise": plan.total, "currency": "INR", "sellerIds": plan.sellerIDs(),
		})
	})
	if err != nil {
		return "", false, err
	}
	return orderID, created, nil
}

func (s *Saga) lookupIdempotency(customerID, key, hash string) (string, bool, error) {
	var row struct {
		RequestHash string
		OrderID     string
	}
	res := s.db.Raw("SELECT request_hash, order_id FROM checkout_idempotency WHERE customer_id = ? AND idem_key = ?", customerID, key).Scan(&row)
	if res.Error != nil {
		return "", false, res.Error
	}
	if res.RowsAffected == 0 {
		return "", false, nil
	}
	if row.RequestHash != hash {
		return "", false, newErr(http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different checkout request")
	}
	return row.OrderID, true, nil
}

type itemPlan struct {
	skuID, productID, title, skuName, currency string
	unitPrice                                  int64
	quantity                                   int
}

type groupPlan struct {
	id, sellerID                    string
	items                           []itemPlan
	subtotal, shipping, tax, total  int64
}

type orderPlan struct {
	groups                         []*groupPlan
	subtotal, shipping, tax, total int64
}

func (p orderPlan) sellerIDs() []string {
	out := make([]string, len(p.groups))
	for i, g := range p.groups {
		out[i] = g.sellerID
	}
	return out
}

// buildPlan computes every amount on the server from catalog prices. The client never supplies a total.
func (s *Saga) buildPlan(rows []cartRow, skus map[string]CatalogSKU) (orderPlan, error) {
	bySeller := map[string]*groupPlan{}
	var plan orderPlan
	for _, r := range rows {
		sku := skus[strings.ToLower(r.SkuID)]
		g, ok := bySeller[sku.SellerID]
		if !ok {
			g = &groupPlan{id: uuid.NewString(), sellerID: sku.SellerID}
			bySeller[sku.SellerID] = g
			plan.groups = append(plan.groups, g)
		}
		g.items = append(g.items, itemPlan{skuID: sku.SkuID, productID: sku.ProductID, title: sku.Title, skuName: sku.SkuName,
			currency: sku.Currency, unitPrice: sku.PricePaise, quantity: r.Quantity})
		g.subtotal += sku.PricePaise * int64(r.Quantity)
	}
	sort.Slice(plan.groups, func(i, j int) bool { return plan.groups[i].sellerID < plan.groups[j].sellerID })
	for _, g := range plan.groups {
		g.shipping = s.cfg.ShippingFlatPaise
		g.tax = (g.subtotal*int64(s.cfg.TaxBps) + 5000) / 10000
		g.total = g.subtotal + g.shipping + g.tax
		plan.subtotal += g.subtotal
		plan.shipping += g.shipping
		plan.tax += g.tax
		plan.total += g.total
	}
	if plan.total <= 0 || plan.total > maxOrderPaise {
		return plan, newErr(http.StatusUnprocessableEntity, "ORDER_TOTAL_OUT_OF_RANGE", "order total is outside the allowed range")
	}
	return plan, nil
}

const maxOrderPaise = 100_000_000_00 // INR 10 crore, well under provider limits

// ---------------------------------------------------------------- step driver
type orderState struct {
	ID                   string
	CustomerID           string
	Status               string
	StockReleased        bool
	StockCommitted       bool
	ReservationExpiresAt *time.Time
}

func (s *Saga) state(orderID string) (*orderState, error) {
	var st orderState
	res := s.db.Raw("SELECT id, customer_id, status, stock_released, stock_committed, reservation_expires_at FROM orders WHERE id = ?", orderID).Scan(&st)
	if res.Error != nil {
		return nil, res.Error
	}
	if res.RowsAffected == 0 {
		return nil, newErr(http.StatusNotFound, "NOT_FOUND", "Order not found")
	}
	return &st, nil
}

// Advance pushes an order as far as it can go right now. It is safe to call repeatedly and concurrently:
// external calls are idempotent and every status change is a locked, validated transition.
// A non-nil error means "outcome unknown, try again later"; the order is left in its last durable state.
func (s *Saga) Advance(orderID string) error {
	for i := 0; i < 6; i++ {
		st, err := s.state(orderID)
		if err != nil {
			return err
		}
		progressed := false
		switch st.Status {
		case StPendingStock:
			progressed, err = s.reserveStep(st)
		case StStockReserved:
			progressed, err = s.paymentStep(st)
		case StPaid:
			progressed, err = s.finalize(st)
		case StFailed, StCancelled:
			if !st.StockReleased {
				progressed, err = s.releaseStock(st.ID)
			}
		}
		if err != nil || !progressed {
			return err
		}
	}
	return nil
}

func (s *Saga) reserveStep(st *orderState) (bool, error) {
	var items []ReserveItem
	if err := s.db.Raw("SELECT sku_id, SUM(quantity) AS quantity FROM order_items WHERE order_id = ? GROUP BY sku_id", st.ID).Scan(&items).Error; err != nil {
		return false, err
	}
	err := s.inventory.Reserve(st.ID, items, s.cfg.ReservationTTLSeconds)
	switch {
	case err == nil:
		expires := time.Now().UTC().Add(time.Duration(s.cfg.ReservationTTLSeconds) * time.Second)
		return true, s.db.Transaction(func(tx *gorm.DB) error {
			_, terr := transitionOrder(tx, st.ID, StStockReserved, "saga", "stock reserved", map[string]any{"reservation_expires_at": expires})
			return terr
		})
	case isDefinitive(err):
		return true, s.fail(st.ID, "INSUFFICIENT_STOCK", "stock reservation rejected")
	default:
		return false, err // unknown outcome: keep PENDING_STOCK, reconciler repeats the idempotent reserve
	}
}

func (s *Saga) paymentStep(st *orderState) (bool, error) {
	payload, err := s.payments.Initiate(st.ID, st.CustomerID)
	switch {
	case err == nil:
		raw, _ := json.Marshal(payload)
		return true, s.db.Transaction(func(tx *gorm.DB) error {
			_, terr := transitionOrder(tx, st.ID, StPaymentPending, "saga", "payment initiated", map[string]any{
				"payment_attempt_id": payload.AttemptID, "provider_order_id": payload.ProviderOrderID, "payment_payload": string(raw),
			})
			return terr
		})
	case isDefinitive(err):
		return true, s.fail(st.ID, "PAYMENT_INIT_REJECTED", err.Error())
	default:
		return false, err
	}
}

// fail moves an unpaid order to FAILED and releases its stock reservation (compensation).
func (s *Saga) fail(orderID, code, reason string) error {
	err := s.db.Transaction(func(tx *gorm.DB) error {
		changed, terr := transitionOrder(tx, orderID, StFailed, "saga", code, map[string]any{"failure_reason": truncate(reason, 250)})
		if terr != nil || !changed {
			return terr
		}
		return emit(tx, "OrderCancelled", "order.cancelled.v1", map[string]any{"orderId": orderID, "status": StFailed, "reason": code})
	})
	if err != nil {
		return err
	}
	_, rerr := s.releaseStock(orderID)
	return rerr
}

func (s *Saga) releaseStock(orderID string) (bool, error) {
	if err := s.inventory.Release(orderID); err != nil {
		return false, err
	}
	return true, s.db.Exec("UPDATE orders SET stock_released = 1 WHERE id = ?", orderID).Error
}

// finalize commits the reserved stock for a paid order and confirms it.
func (s *Saga) finalize(st *orderState) (bool, error) {
	if !st.StockCommitted {
		if err := s.inventory.Commit(st.ID); err != nil {
			if isDefinitive(err) {
				logger.Error("stock commit rejected for paid order; needs manual attention", "orderId", st.ID, "reason", err.Error())
			}
			return false, err
		}
		if err := s.db.Exec("UPDATE orders SET stock_committed = 1 WHERE id = ?", st.ID).Error; err != nil {
			return false, err
		}
	}
	return true, s.db.Transaction(func(tx *gorm.DB) error {
		changed, terr := transitionOrder(tx, st.ID, StConfirmed, "saga", "payment verified, stock committed", nil)
		if terr != nil || !changed {
			return terr
		}
		return emit(tx, "OrderConfirmed", "order.confirmed.v1", map[string]any{"orderId": st.ID, "customerId": st.CustomerID})
	})
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// ---------------------------------------------------------------- event handlers (inbox-protected)
// Handle applies a payment/refund event exactly once: the inbox insert and the state change share one transaction.
func (s *Saga) Handle(env Envelope) error {
	orderID, _ := env.Data["orderId"].(string)
	if orderID == "" {
		return nil
	}
	var followUp bool
	err := s.db.Transaction(func(tx *gorm.DB) error {
		ins := tx.Exec("INSERT INTO inbox_events (event_id, event_type) VALUES (?, ?)", env.EventID, env.EventType)
		if ins.Error != nil {
			var me *mysql.MySQLError
			if errors.As(ins.Error, &me) && me.Number == mysqlDuplicateKey {
				return nil // already processed: no second effect
			}
			return ins.Error
		}
		switch env.EventType {
		case "PaymentSucceeded":
			ok, err := s.applyPaymentSucceeded(tx, orderID)
			followUp = ok
			return err
		case "PaymentFailed":
			reason, _ := env.Data["reason"].(string)
			return s.applyPaymentFailed(tx, orderID, reason)
		case "RefundSucceeded":
			return s.applyRefund(tx, orderID, env.Data)
		}
		return nil
	})
	if err != nil {
		return err
	}
	_ = followUp
	// post-commit follow-ups (stock commit / release). Failures here are picked up by the reconciler.
	if err := s.Advance(orderID); err != nil {
		logger.Warn("follow-up after event left for reconciler", "orderId", orderID, "reason", err.Error())
	}
	return nil
}

func (s *Saga) applyPaymentSucceeded(tx *gorm.DB, orderID string) (bool, error) {
	var status string
	if err := tx.Raw("SELECT status FROM orders WHERE id = ? FOR UPDATE", orderID).Scan(&status).Error; err != nil {
		return false, err
	}
	switch status {
	case StStockReserved:
		if _, err := transitionOrder(tx, orderID, StPaymentPending, "payment-event", "payment attempt recorded", nil); err != nil {
			return false, err
		}
		fallthrough
	case StPaymentPending:
		if _, err := transitionOrder(tx, orderID, StPaid, "payment-event", "payment verified by payment service", nil); err != nil {
			return false, err
		}
		// the purchased lines leave the cart only once payment is confirmed
		err := tx.Exec(`DELETE ci FROM cart_items ci JOIN carts c ON c.id = ci.cart_id JOIN orders o ON o.customer_id = c.customer_id
			WHERE o.id = ? AND ci.sku_id IN (SELECT sku_id FROM order_items WHERE order_id = ?)`, orderID, orderID).Error
		return true, err
	default:
		// FAILED/CANCELLED: a late payment. The payment service refunds it; the order stays cancelled.
		return false, nil
	}
}

func (s *Saga) applyPaymentFailed(tx *gorm.DB, orderID, reason string) error {
	if reason == "" {
		reason = "payment failed"
	}
	changed, err := transitionOrder(tx, orderID, StFailed, "payment-event", "PAYMENT_FAILED", map[string]any{"failure_reason": truncate(reason, 250)})
	var ae *APIError
	if errors.As(err, &ae) && ae.Code == "ILLEGAL_TRANSITION" {
		return nil // already PAID/CONFIRMED/terminal: a failure report cannot undo that
	}
	if err != nil || !changed {
		return err
	}
	return emit(tx, "OrderCancelled", "order.cancelled.v1", map[string]any{"orderId": orderID, "status": StFailed, "reason": "PAYMENT_FAILED"})
}

// applyRefund records cumulative refund totals reported by the payment service. Using the cumulative value
// (not an increment) makes a redelivered or reordered event harmless.
func (s *Saga) applyRefund(tx *gorm.DB, orderID string, data map[string]any) error {
	total, _ := data["totalRefundedPaise"].(float64)
	if total <= 0 {
		return nil
	}
	if err := tx.Exec("UPDATE orders SET refunded_paise = GREATEST(refunded_paise, LEAST(?, total_paise)), updated_at = NOW(6) WHERE id = ?", int64(total), orderID).Error; err != nil {
		return err
	}
	if seller, _ := data["sellerId"].(string); seller != "" {
		if sellerTotal, _ := data["sellerRefundedPaise"].(float64); sellerTotal > 0 {
			if err := tx.Exec("UPDATE order_seller_groups SET refunded_paise = GREATEST(refunded_paise, LEAST(?, total_paise)) WHERE order_id = ? AND seller_id = ?",
				int64(sellerTotal), orderID, seller).Error; err != nil {
				return err
			}
		}
	}
	var full int64
	if err := tx.Raw("SELECT COUNT(*) FROM orders WHERE id = ? AND refunded_paise = total_paise", orderID).Scan(&full).Error; err != nil || full == 0 {
		return err
	}
	_, err := transitionOrder(tx, orderID, StRefunded, "payment-event", "fully refunded", nil)
	var ae *APIError
	if errors.As(err, &ae) && ae.Code == "ILLEGAL_TRANSITION" {
		return nil
	}
	return err
}

// ---------------------------------------------------------------- customer cancel
// Cancel closes an unpaid order. While a payment attempt exists the payment service must first confirm
// nothing was paid, so stock is never released while the payment outcome is unknown.
func (s *Saga) Cancel(customerID, orderID string) error {
	st, err := s.state(orderID)
	if err != nil || st.CustomerID != customerID {
		if err == nil {
			err = newErr(http.StatusNotFound, "NOT_FOUND", "Order not found")
		}
		return err
	}
	if st.Status == StCancelled {
		return nil
	}
	if st.Status != StPendingStock && st.Status != StStockReserved && st.Status != StPaymentPending {
		return newErr(http.StatusConflict, "NOT_CANCELLABLE", "Only unpaid orders can be cancelled")
	}
	if st.Status != StPendingStock {
		res, err := s.payments.Expire(orderID)
		if err != nil {
			return newErr(http.StatusServiceUnavailable, "PAYMENT_STATUS_UNKNOWN", "Could not confirm the payment state; try again shortly")
		}
		if !res.Expired {
			return newErr(http.StatusConflict, "PAYMENT_IN_PROGRESS", "A payment is in progress or already completed for this order")
		}
	}
	err = s.db.Transaction(func(tx *gorm.DB) error {
		changed, terr := transitionOrder(tx, orderID, StCancelled, "customer:"+customerID, "cancelled by customer", nil)
		if terr != nil || !changed {
			return terr
		}
		return emit(tx, "OrderCancelled", "order.cancelled.v1", map[string]any{"orderId": orderID, "status": StCancelled, "reason": "CUSTOMER_CANCELLED"})
	})
	if err != nil {
		return err
	}
	_ = s.Advance(orderID)
	return nil
}

// ---------------------------------------------------------------- reconciliation
// Reconcile repeats stalled steps. It is the safety net for lost events and unknown outcomes; it never guesses:
// stock is only released after the payment service confirms that no payment can still complete.
func (s *Saga) Reconcile() {
	var ids []string
	s.db.Raw(`SELECT id FROM orders WHERE
		(status IN (?, ?) AND updated_at < NOW(6) - INTERVAL 3 SECOND)
		OR status = ?
		OR (status IN (?, ?) AND stock_released = 0)
		ORDER BY updated_at LIMIT 50`, StPendingStock, StStockReserved, StPaid, StFailed, StCancelled).Scan(&ids)
	for _, id := range ids {
		if err := s.Advance(id); err != nil {
			logger.Warn("reconcile step deferred", "orderId", id, "reason", err.Error())
		}
	}

	var pending []orderState
	s.db.Raw("SELECT id, customer_id, status, reservation_expires_at FROM orders WHERE status = ? AND updated_at < NOW(6) - INTERVAL 10 SECOND ORDER BY updated_at LIMIT 50", StPaymentPending).Scan(&pending)
	for _, p := range pending {
		s.reconcilePayment(p)
	}
}

func (s *Saga) reconcilePayment(p orderState) {
	expired := p.ReservationExpiresAt != nil && p.ReservationExpiresAt.Before(time.Now())
	status, err := s.payments.Status(p.ID)
	if err != nil {
		return // unknown: do nothing
	}
	switch status.Status {
	case "SUCCEEDED":
		_ = s.Handle(Envelope{EventID: "reconcile-paid-" + p.ID, EventType: "PaymentSucceeded", Data: map[string]any{"orderId": p.ID}})
	case "FAILED":
		_ = s.Handle(Envelope{EventID: "reconcile-failed-" + p.ID, EventType: "PaymentFailed", Data: map[string]any{"orderId": p.ID, "reason": "payment failed"}})
	default:
		if !expired {
			return
		}
		// reservation window over: ask the payment service to close the attempt; it refuses if money may be moving
		res, err := s.payments.Expire(p.ID)
		if err != nil || !res.Expired {
			return
		}
		if err := s.db.Transaction(func(tx *gorm.DB) error {
			changed, terr := transitionOrder(tx, p.ID, StCancelled, "reconciler", "payment window expired", nil)
			if terr != nil || !changed {
				return terr
			}
			return emit(tx, "OrderCancelled", "order.cancelled.v1", map[string]any{"orderId": p.ID, "status": StCancelled, "reason": "PAYMENT_WINDOW_EXPIRED"})
		}); err == nil {
			_ = s.Advance(p.ID)
		}
	}
}

func (s *Saga) RunReconciler(stop <-chan struct{}) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			s.Reconcile()
		}
	}
}

var _ = fmt.Sprintf
