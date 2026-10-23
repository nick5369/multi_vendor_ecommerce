package main

import (
	"errors"
	"fmt"
	"net/http"

	"gorm.io/gorm"
)

// Parent order lifecycle:
//
//	PENDING_STOCK -> STOCK_RESERVED -> PAYMENT_PENDING -> PAID -> CONFIRMED -> (REFUNDED)
//	any pre-PAID state -> FAILED | CANCELLED
//
// Seller groups then advance independently: CONFIRMED -> PROCESSING -> SHIPPED -> DELIVERED.
const (
	StPendingStock   = "PENDING_STOCK"
	StStockReserved  = "STOCK_RESERVED"
	StPaymentPending = "PAYMENT_PENDING"
	StPaid           = "PAID"
	StConfirmed      = "CONFIRMED"
	StFailed         = "FAILED"
	StCancelled      = "CANCELLED"
	StRefunded       = "REFUNDED"

	GrProcessing = "PROCESSING"
	GrShipped    = "SHIPPED"
	GrDelivered  = "DELIVERED"
)

var orderTransitions = map[string][]string{
	StPendingStock:   {StStockReserved, StFailed, StCancelled},
	StStockReserved:  {StPaymentPending, StFailed, StCancelled},
	StPaymentPending: {StPaid, StFailed, StCancelled},
	StPaid:           {StConfirmed},
	StConfirmed:      {StRefunded},
}

// groupTransitions is the only forward path for seller fulfilment.
var groupTransitions = map[string]string{
	StConfirmed:  GrProcessing,
	GrProcessing: GrShipped,
	GrShipped:    GrDelivered,
}

func canTransition(from, to string) bool {
	for _, next := range orderTransitions[from] {
		if next == to {
			return true
		}
	}
	return false
}

func isTerminal(status string) bool {
	return status == StFailed || status == StCancelled || status == StRefunded
}

var errIllegalTransition = errors.New("illegal order transition")

func illegal(from, to string) error {
	return newErr(http.StatusConflict, "ILLEGAL_TRANSITION", fmt.Sprintf("cannot move order from %s to %s", from, to))
}

// transitionOrder moves the parent order (and its seller groups) to `to` inside the caller's transaction.
// It locks the row, validates the move against the state machine and writes status history.
// Re-applying the state the order is already in is a no-op (changed=false), which makes event handlers idempotent.
// `sets` holds extra columns to update; keys are fixed column names chosen by this package, never client input.
func transitionOrder(tx *gorm.DB, orderID, to, actor, reason string, sets map[string]any) (changed bool, err error) {
	var current string
	res := tx.Raw("SELECT status FROM orders WHERE id = ? FOR UPDATE", orderID).Scan(&current)
	if res.Error != nil {
		return false, res.Error
	}
	if res.RowsAffected == 0 {
		return false, newErr(http.StatusNotFound, "NOT_FOUND", "Order not found")
	}
	if current == to {
		return false, nil
	}
	if !canTransition(current, to) {
		return false, illegal(current, to)
	}
	query := "UPDATE orders SET status = ?, updated_at = NOW(6)"
	args := []any{to}
	for col, val := range sets {
		query += ", " + col + " = ?"
		args = append(args, val)
	}
	query += " WHERE id = ?"
	args = append(args, orderID)
	if err := tx.Exec(query, args...).Error; err != nil {
		return false, err
	}
	switch to {
	case StRefunded:
		// groups keep their fulfilment status; refunds are tracked in refunded_paise
	case StConfirmed:
		err = tx.Exec("UPDATE order_seller_groups SET status = ?, updated_at = NOW(6) WHERE order_id = ? AND status = ?", StConfirmed, orderID, StPaid).Error
	default:
		err = tx.Exec("UPDATE order_seller_groups SET status = ?, updated_at = NOW(6) WHERE order_id = ?", to, orderID).Error
	}
	if err != nil {
		return false, err
	}
	err = tx.Exec("INSERT INTO order_status_history (order_id, from_status, to_status, actor, reason) VALUES (?, ?, ?, ?, ?)",
		orderID, current, to, actor, nullable(reason)).Error
	return err == nil, err
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// advanceGroup moves one seller group a single step along the fulfilment path.
func advanceGroup(tx *gorm.DB, groupID, sellerID, to, actor string) error {
	var g struct {
		OrderID string
		Status  string
	}
	res := tx.Raw("SELECT order_id, status FROM order_seller_groups WHERE id = ? AND seller_id = ? FOR UPDATE", groupID, sellerID).Scan(&g)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return newErr(http.StatusNotFound, "NOT_FOUND", "Order group not found") // not this seller's group: indistinguishable from missing
	}
	if groupTransitions[g.Status] != to {
		return illegal(g.Status, to)
	}
	if err := tx.Exec("UPDATE order_seller_groups SET status = ?, updated_at = NOW(6) WHERE id = ?", to, groupID).Error; err != nil {
		return err
	}
	return tx.Exec("INSERT INTO order_status_history (order_id, group_id, from_status, to_status, actor) VALUES (?, ?, ?, ?, ?)",
		g.OrderID, groupID, g.Status, to, actor).Error
}
