package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type ItemView struct {
	SkuID          string `json:"skuId"`
	ProductID      string `json:"productId"`
	Title          string `json:"title"`
	SkuName        string `json:"skuName"`
	UnitPricePaise int64  `json:"unitPricePaise"`
	Quantity       int    `json:"quantity"`
	LineTotalPaise int64  `json:"lineTotalPaise"`
}

type GroupView struct {
	ID            string     `json:"groupId"`
	OrderID       string     `json:"orderId,omitempty"`
	SellerID      string     `json:"sellerId"`
	Status        string     `json:"status"`
	SubtotalPaise int64      `json:"subtotalPaise"`
	ShippingPaise int64      `json:"shippingPaise"`
	TaxPaise      int64      `json:"taxPaise"`
	TotalPaise    int64      `json:"totalPaise"`
	RefundedPaise int64      `json:"refundedPaise"`
	Items         []ItemView `json:"items"`
}

type HistoryView struct {
	GroupID    *string   `json:"groupId,omitempty"`
	FromStatus *string   `json:"fromStatus,omitempty"`
	ToStatus   string    `json:"toStatus"`
	Actor      string    `json:"actor"`
	Reason     *string   `json:"reason,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}

type OrderView struct {
	ID              string          `json:"orderId"`
	CustomerID      string          `json:"customerId,omitempty"`
	Status          string          `json:"status"`
	Currency        string          `json:"currency"`
	SubtotalPaise   int64           `json:"subtotalPaise"`
	ShippingPaise   int64           `json:"shippingPaise"`
	DiscountPaise   int64           `json:"discountPaise"`
	TaxPaise        int64           `json:"taxPaise"`
	TotalPaise      int64           `json:"totalPaise"`
	RefundedPaise   int64           `json:"refundedPaise"`
	ShippingAddress json.RawMessage `json:"shippingAddress,omitempty"`
	Payment         json.RawMessage `json:"payment,omitempty"`
	FailureReason   *string         `json:"failureReason,omitempty"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
	Groups          []GroupView     `json:"groups"`
	History         []HistoryView   `json:"history,omitempty"`
}

type orderRow struct {
	ID              string
	CustomerID      string
	Status          string
	Currency        string
	SubtotalPaise   int64
	ShippingPaise   int64
	DiscountPaise   int64
	TaxPaise        int64
	TotalPaise      int64
	RefundedPaise   int64
	ShippingAddress []byte
	PaymentPayload  []byte
	FailureReason   *string
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type OrderQueries struct{ db *gorm.DB }

func (q OrderQueries) toView(r orderRow, withHistory, withAddress bool) (*OrderView, error) {
	v := &OrderView{ID: r.ID, CustomerID: r.CustomerID, Status: r.Status, Currency: r.Currency, SubtotalPaise: r.SubtotalPaise,
		ShippingPaise: r.ShippingPaise, DiscountPaise: r.DiscountPaise, TaxPaise: r.TaxPaise, TotalPaise: r.TotalPaise,
		RefundedPaise: r.RefundedPaise, FailureReason: r.FailureReason, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, Groups: []GroupView{}}
	if withAddress {
		v.ShippingAddress = r.ShippingAddress
	}
	// the Razorpay checkout payload is only useful (and only returned) while payment is being awaited
	if len(r.PaymentPayload) > 0 && (r.Status == StPaymentPending) {
		v.Payment = r.PaymentPayload
	}
	var groups []struct {
		ID, SellerID, Status                                          string
		SubtotalPaise, ShippingPaise, TaxPaise, TotalPaise, RefundedPaise int64
	}
	if err := q.db.Raw("SELECT id, seller_id, status, subtotal_paise, shipping_paise, tax_paise, total_paise, refunded_paise FROM order_seller_groups WHERE order_id = ? ORDER BY seller_id", r.ID).Scan(&groups).Error; err != nil {
		return nil, err
	}
	for _, g := range groups {
		gv := GroupView{ID: g.ID, SellerID: g.SellerID, Status: g.Status, SubtotalPaise: g.SubtotalPaise, ShippingPaise: g.ShippingPaise,
			TaxPaise: g.TaxPaise, TotalPaise: g.TotalPaise, RefundedPaise: g.RefundedPaise, Items: []ItemView{}}
		if err := q.db.Raw("SELECT sku_id, product_id, title, sku_name, unit_price_paise, quantity, line_total_paise FROM order_items WHERE group_id = ? ORDER BY title, sku_id", g.ID).Scan(&gv.Items).Error; err != nil {
			return nil, err
		}
		v.Groups = append(v.Groups, gv)
	}
	if withHistory {
		if err := q.db.Raw("SELECT group_id, from_status, to_status, actor, reason, created_at FROM order_status_history WHERE order_id = ? ORDER BY id", r.ID).Scan(&v.History).Error; err != nil {
			return nil, err
		}
	}
	return v, nil
}

const orderColumns = "id, customer_id, status, currency, subtotal_paise, shipping_paise, discount_paise, tax_paise, total_paise, refunded_paise, shipping_address, payment_payload, failure_reason, created_at, updated_at"

// Get returns an order only if it belongs to customerID (empty customerID = unrestricted, for admins).
func (q OrderQueries) Get(orderID, customerID string) (*OrderView, error) {
	var r orderRow
	query, args := "SELECT "+orderColumns+" FROM orders WHERE id = ?", []any{orderID}
	if customerID != "" {
		query += " AND customer_id = ?"
		args = append(args, customerID)
	}
	res := q.db.Raw(query, args...).Scan(&r)
	if res.Error != nil {
		return nil, res.Error
	}
	if res.RowsAffected == 0 {
		return nil, newErr(http.StatusNotFound, "NOT_FOUND", "Order not found")
	}
	return q.toView(r, true, true)
}

type Page[T any] struct {
	Items []T   `json:"items"`
	Page  int   `json:"page"`
	Size  int   `json:"size"`
	Total int64 `json:"total"`
}

func (q OrderQueries) List(customerID, status string, page, size int) (*Page[*OrderView], error) {
	where, args := "1=1", []any{}
	if customerID != "" {
		where += " AND customer_id = ?"
		args = append(args, customerID)
	}
	if status != "" {
		where += " AND status = ?"
		args = append(args, status)
	}
	var total int64
	if err := q.db.Raw("SELECT COUNT(*) FROM orders WHERE "+where, args...).Scan(&total).Error; err != nil {
		return nil, err
	}
	var rows []orderRow
	if err := q.db.Raw("SELECT "+orderColumns+" FROM orders WHERE "+where+" ORDER BY created_at DESC, id LIMIT ? OFFSET ?", append(args, size, page*size)...).Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := &Page[*OrderView]{Items: []*OrderView{}, Page: page, Size: size, Total: total}
	for _, r := range rows {
		v, err := q.toView(r, false, customerID != "")
		if err != nil {
			return nil, err
		}
		out.Items = append(out.Items, v)
	}
	return out, nil
}

// SellerGroups lists only this seller's suborders, and only once they are paid (CONFIRMED or later).
func (q OrderQueries) SellerGroups(sellerID string, page, size int) (*Page[map[string]any], error) {
	var total int64
	if err := q.db.Raw("SELECT COUNT(*) FROM order_seller_groups WHERE seller_id = ? AND status IN ('CONFIRMED','PROCESSING','SHIPPED','DELIVERED')", sellerID).Scan(&total).Error; err != nil {
		return nil, err
	}
	var groups []struct {
		ID, OrderID, Status                                               string
		SubtotalPaise, ShippingPaise, TaxPaise, TotalPaise, RefundedPaise int64
		ShippingAddress                                                   []byte
		CreatedAt                                                         time.Time
	}
	if err := q.db.Raw(`SELECT g.id, g.order_id, g.status, g.subtotal_paise, g.shipping_paise, g.tax_paise, g.total_paise, g.refunded_paise, o.shipping_address, g.created_at
		FROM order_seller_groups g JOIN orders o ON o.id = g.order_id
		WHERE g.seller_id = ? AND g.status IN ('CONFIRMED','PROCESSING','SHIPPED','DELIVERED')
		ORDER BY g.created_at DESC, g.id LIMIT ? OFFSET ?`, sellerID, size, page*size).Scan(&groups).Error; err != nil {
		return nil, err
	}
	out := &Page[map[string]any]{Items: []map[string]any{}, Page: page, Size: size, Total: total}
	for _, g := range groups {
		var items []ItemView
		if err := q.db.Raw("SELECT sku_id, product_id, title, sku_name, unit_price_paise, quantity, line_total_paise FROM order_items WHERE group_id = ? ORDER BY title", g.ID).Scan(&items).Error; err != nil {
			return nil, err
		}
		out.Items = append(out.Items, map[string]any{
			"groupId": g.ID, "orderId": g.OrderID, "status": g.Status, "subtotalPaise": g.SubtotalPaise, "shippingPaise": g.ShippingPaise,
			"taxPaise": g.TaxPaise, "totalPaise": g.TotalPaise, "refundedPaise": g.RefundedPaise, "shippingAddress": json.RawMessage(g.ShippingAddress),
			"createdAt": g.CreatedAt, "items": items,
		})
	}
	return out, nil
}

func paging(c *gin.Context) (int, int, bool) {
	page, err1 := strconv.Atoi(c.DefaultQuery("page", "0"))
	size, err2 := strconv.Atoi(c.DefaultQuery("size", "20"))
	if err1 != nil || err2 != nil || page < 0 || size < 1 || size > 100 {
		writeError(c, http.StatusBadRequest, "VALIDATION_ERROR", "page must be >= 0 and size between 1 and 100", nil)
		return 0, 0, false
	}
	return page, size, true
}

var validOrderStatus = map[string]bool{StPendingStock: true, StStockReserved: true, StPaymentPending: true, StPaid: true, StConfirmed: true, StFailed: true, StCancelled: true, StRefunded: true}

func registerOrderRoutes(r *gin.Engine, auth *Authenticator, saga *Saga, db *gorm.DB, cfg Config) {
	q := OrderQueries{db: db}

	// ---------------- customer
	customer := r.Group("", auth.require("CUSTOMER"))

	customer.POST("/checkout", func(c *gin.Context) {
		key := c.GetHeader("Idempotency-Key")
		if !idemKeyPattern.MatchString(key) {
			writeError(c, http.StatusBadRequest, "VALIDATION_ERROR", "Idempotency-Key header (8-100 chars: letters, digits, . _ : -) is required", nil)
			return
		}
		var req CheckoutRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid checkout request", err.Error())
			return
		}
		userID := principal(c).UserID
		orderID, created, err := saga.Checkout(userID, key, req.ShippingAddress)
		if err != nil {
			fail(c, err)
			return
		}
		if err := saga.Advance(orderID); err != nil {
			logger.Warn("checkout step deferred to reconciler", "orderId", orderID, "reason", err.Error())
		}
		view, err := q.Get(orderID, userID)
		if err != nil {
			fail(c, err)
			return
		}
		status := http.StatusCreated
		if !created {
			status = http.StatusOK
		}
		c.Header("Idempotent-Replay", strconv.FormatBool(!created))
		c.JSON(status, view)
	})

	customer.GET("/orders", func(c *gin.Context) {
		page, size, ok := paging(c)
		if !ok {
			return
		}
		out, err := q.List(principal(c).UserID, "", page, size)
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, out)
	})

	customer.GET("/orders/:id", func(c *gin.Context) {
		if _, err := uuid.Parse(c.Param("id")); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION_ERROR", "order id must be a UUID", nil)
			return
		}
		view, err := q.Get(strings.ToLower(c.Param("id")), principal(c).UserID)
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, view)
	})

	customer.POST("/orders/:id/cancel", func(c *gin.Context) {
		id := strings.ToLower(c.Param("id"))
		if _, err := uuid.Parse(id); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION_ERROR", "order id must be a UUID", nil)
			return
		}
		if err := saga.Cancel(principal(c).UserID, id); err != nil {
			fail(c, err)
			return
		}
		view, err := q.Get(id, principal(c).UserID)
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, view)
	})

	// ---------------- seller: only their own suborders
	seller := r.Group("/seller", auth.require("SELLER"))
	seller.Use(func(c *gin.Context) {
		if principal(c).StoreID == "" {
			writeError(c, http.StatusForbidden, "FORBIDDEN", "No active store for this account", nil)
			return
		}
		c.Next()
	})

	seller.GET("/orders", func(c *gin.Context) {
		page, size, ok := paging(c)
		if !ok {
			return
		}
		out, err := q.SellerGroups(principal(c).StoreID, page, size)
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, out)
	})

	seller.POST("/orders/:groupId/status", func(c *gin.Context) {
		var body struct {
			Status string `json:"status" binding:"required,oneof=PROCESSING SHIPPED DELIVERED"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION_ERROR", "status must be PROCESSING, SHIPPED or DELIVERED", nil)
			return
		}
		p := principal(c)
		groupID := strings.ToLower(c.Param("groupId"))
		if _, err := uuid.Parse(groupID); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION_ERROR", "group id must be a UUID", nil)
			return
		}
		err := db.Transaction(func(tx *gorm.DB) error { return advanceGroup(tx, groupID, p.StoreID, body.Status, "seller:"+p.UserID) })
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"groupId": groupID, "status": body.Status})
	})

	// ---------------- admin: read-only oversight (no gateway secrets are stored here)
	admin := r.Group("/admin", auth.require("ADMIN"))
	admin.GET("/orders", func(c *gin.Context) {
		page, size, ok := paging(c)
		if !ok {
			return
		}
		status := c.Query("status")
		if status != "" && !validOrderStatus[status] {
			writeError(c, http.StatusBadRequest, "VALIDATION_ERROR", "unknown status", nil)
			return
		}
		out, err := q.List("", status, page, size)
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, out)
	})
	admin.GET("/orders/:id", func(c *gin.Context) {
		if _, err := uuid.Parse(c.Param("id")); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION_ERROR", "order id must be a UUID", nil)
			return
		}
		view, err := q.Get(strings.ToLower(c.Param("id")), "")
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, view)
	})

	// ---------------- internal (service-to-service; blocked at the gateway)
	internal := r.Group("/internal", internalOnly(cfg.InternalToken))

	// The payment service asks for the payable amount instead of trusting a caller-supplied one.
	internal.GET("/orders/:id/payable", func(c *gin.Context) {
		var row struct {
			CustomerID  string
			Status      string
			TotalPaise  int64
			Currency    string
		}
		res := db.Raw("SELECT customer_id, status, total_paise, currency FROM orders WHERE id = ?", strings.ToLower(c.Param("id"))).Scan(&row)
		if res.Error != nil {
			fail(c, res.Error)
			return
		}
		if res.RowsAffected == 0 {
			writeError(c, http.StatusNotFound, "NOT_FOUND", "Order not found", nil)
			return
		}
		if row.Status != StStockReserved && row.Status != StPaymentPending {
			writeError(c, http.StatusConflict, "ORDER_NOT_PAYABLE", "Order is not awaiting payment", nil)
			return
		}
		var groups []struct {
			GroupID    string `json:"groupId"`
			SellerID   string `json:"sellerId"`
			TotalPaise int64  `json:"totalPaise"`
		}
		db.Raw("SELECT id AS group_id, seller_id, total_paise FROM order_seller_groups WHERE order_id = ?", strings.ToLower(c.Param("id"))).Scan(&groups)
		c.JSON(http.StatusOK, gin.H{"orderId": strings.ToLower(c.Param("id")), "customerId": row.CustomerID, "status": row.Status,
			"amountPaise": row.TotalPaise, "currency": row.Currency, "groups": groups})
	})

	// Seller scope for refunds: which seller group totals does this order contain?
	internal.GET("/orders/:id/groups", func(c *gin.Context) {
		var groups []struct {
			GroupID    string `json:"groupId"`
			SellerID   string `json:"sellerId"`
			TotalPaise int64  `json:"totalPaise"`
		}
		if err := db.Raw("SELECT id AS group_id, seller_id, total_paise FROM order_seller_groups WHERE order_id = ?", strings.ToLower(c.Param("id"))).Scan(&groups).Error; err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, groups)
	})

	// Runs one reconciliation pass on demand (also runs every 5s in the background).
	internal.POST("/reconcile", func(c *gin.Context) {
		saga.Reconcile()
		c.Status(http.StatusNoContent)
	})
}
