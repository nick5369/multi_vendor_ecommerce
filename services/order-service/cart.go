package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

const mysqlDuplicateKey = 1062

var idemKeyPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{8,100}$`)

// AddResult is stored with the idempotency key and returned unchanged on every repeat of the same request.
type AddResult struct {
	CartID   string `json:"cartId"`
	SkuID    string `json:"skuId"`
	SellerID string `json:"sellerId"`
	Quantity int    `json:"quantity"`
}

type CartService struct {
	db      *gorm.DB
	catalog CatalogClient
	maxQty  int
}

func NewCartService(db *gorm.DB, catalog CatalogClient, maxQty int) *CartService {
	return &CartService{db: db, catalog: catalog, maxQty: maxQty}
}

// cartID returns the customer's cart, creating it atomically. Runs outside the add transaction so
// first-time concurrent requests do not contend on the carts unique key while holding other locks.
func (s *CartService) cartID(customerID string) (string, error) {
	err := s.db.Exec(
		"INSERT INTO carts (id, customer_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE customer_id = customer_id",
		uuid.NewString(), customerID).Error
	if err != nil {
		return "", err
	}
	var id string
	err = s.db.Raw("SELECT id FROM carts WHERE customer_id = ?", customerID).Scan(&id).Error
	return id, err
}

func requestHash(skuID string, qty int) string {
	sum := sha256.Sum256([]byte(strings.ToLower(skuID) + "|" + strconv.Itoa(qty)))
	return hex.EncodeToString(sum[:])
}

// existingOperation looks for a committed operation with this key.
func existingOperation(tx *gorm.DB, cartID, key, hash string) (*AddResult, error) {
	var row struct {
		RequestHash string
		Result      []byte
	}
	res := tx.Raw("SELECT request_hash, result FROM cart_operation_keys WHERE cart_id = ? AND idem_key = ?", cartID, key).Scan(&row)
	if res.Error != nil {
		return nil, res.Error
	}
	if res.RowsAffected == 0 {
		return nil, nil
	}
	if row.RequestHash != hash {
		return nil, newErr(http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request")
	}
	var out AddResult
	if err := json.Unmarshal(row.Result, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AddItem adds `qty` units of a SKU. Each distinct request (distinct key) increments the quantity; a repeat of
// the same request (same key, same payload) returns the first result without incrementing again.
//
// Concurrency safety lives in MySQL, not in this process:
//   - INSERT ... ON DUPLICATE KEY UPDATE on UNIQUE (cart_id, seller_id, sku_id) merges concurrent adds into one row.
//   - The idempotency key is claimed by INSERT on PRIMARY KEY (cart_id, idem_key) in the same transaction as the
//     quantity change; a concurrent duplicate waits for that row lock and then reads the stored result.
func (s *CartService) AddItem(customerID, skuID string, qty int, key string) (*AddResult, bool, error) {
	if qty < 1 || qty > s.maxQty {
		return nil, false, newErr(http.StatusUnprocessableEntity, "QUANTITY_LIMIT_EXCEEDED", "quantity must be between 1 and the configured maximum")
	}
	cartID, err := s.cartID(customerID)
	if err != nil {
		return nil, false, err
	}
	hash := requestHash(skuID, qty)

	if prior, err := existingOperation(s.db, cartID, key, hash); err != nil || prior != nil {
		return prior, prior != nil, err
	}

	skus, err := s.catalog.Lookup([]string{skuID})
	if err != nil {
		return nil, false, newErr(http.StatusServiceUnavailable, "CATALOG_UNAVAILABLE", "Could not verify the SKU with the catalog")
	}
	sku, ok := skus[strings.ToLower(skuID)]
	if !ok || !sku.Purchasable {
		return nil, false, newErr(http.StatusUnprocessableEntity, "SKU_NOT_PURCHASABLE", "SKU does not exist or is not available for purchase")
	}

	var result *AddResult
	replayed := false
	err = s.db.Transaction(func(tx *gorm.DB) error {
		claim := tx.Exec("INSERT INTO cart_operation_keys (cart_id, idem_key, request_hash, result) VALUES (?, ?, ?, NULL)", cartID, key, hash)
		if claim.Error != nil {
			var me *mysql.MySQLError
			if errors.As(claim.Error, &me) && me.Number == mysqlDuplicateKey {
				prior, perr := existingOperation(tx, cartID, key, hash)
				if perr != nil || prior == nil {
					return errOrUnexpected(perr)
				}
				result, replayed = prior, true
				return nil
			}
			return claim.Error
		}

		upsert := tx.Exec(
			"INSERT INTO cart_items (id, cart_id, seller_id, sku_id, quantity) VALUES (?, ?, ?, ?, ?) "+
				"ON DUPLICATE KEY UPDATE quantity = IF(quantity + VALUES(quantity) <= ?, quantity + VALUES(quantity), quantity)",
			uuid.NewString(), cartID, sku.SellerID, sku.SkuID, qty, s.maxQty)
		if upsert.Error != nil {
			return upsert.Error
		}
		// affected rows: 1 = inserted, 2 = incremented, 0 = left unchanged because the maximum would be exceeded
		if upsert.RowsAffected == 0 {
			return newErr(http.StatusUnprocessableEntity, "QUANTITY_LIMIT_EXCEEDED", "cart line would exceed the maximum quantity")
		}
		var quantity int
		if err := tx.Raw("SELECT quantity FROM cart_items WHERE cart_id = ? AND seller_id = ? AND sku_id = ?", cartID, sku.SellerID, sku.SkuID).
			Scan(&quantity).Error; err != nil {
			return err
		}
		result = &AddResult{CartID: cartID, SkuID: sku.SkuID, SellerID: sku.SellerID, Quantity: quantity}
		payload, _ := json.Marshal(result)
		return tx.Exec("UPDATE cart_operation_keys SET result = ? WHERE cart_id = ? AND idem_key = ?", string(payload), cartID, key).Error
	})
	if err != nil {
		return nil, false, err
	}
	return result, replayed, nil
}

func errOrUnexpected(err error) error {
	if err != nil {
		return err
	}
	return errors.New("idempotency record vanished")
}

// SetQuantity sets an absolute quantity. Naturally idempotent.
func (s *CartService) SetQuantity(customerID, skuID string, qty int) error {
	if qty < 1 || qty > s.maxQty {
		return newErr(http.StatusUnprocessableEntity, "QUANTITY_LIMIT_EXCEEDED", "quantity must be between 1 and the configured maximum")
	}
	cartID, err := s.cartID(customerID)
	if err != nil {
		return err
	}
	var exists int
	if err := s.db.Raw("SELECT COUNT(*) FROM cart_items WHERE cart_id = ? AND sku_id = ?", cartID, skuID).Scan(&exists).Error; err != nil {
		return err
	}
	if exists == 0 {
		return newErr(http.StatusNotFound, "NOT_FOUND", "Item is not in the cart")
	}
	return s.db.Exec("UPDATE cart_items SET quantity = ? WHERE cart_id = ? AND sku_id = ?", qty, cartID, skuID).Error
}

func (s *CartService) RemoveItem(customerID, skuID string) error {
	cartID, err := s.cartID(customerID)
	if err != nil {
		return err
	}
	return s.db.Exec("DELETE FROM cart_items WHERE cart_id = ? AND sku_id = ?", cartID, skuID).Error
}

func (s *CartService) Clear(customerID string) error {
	cartID, err := s.cartID(customerID)
	if err != nil {
		return err
	}
	return s.db.Exec("DELETE FROM cart_items WHERE cart_id = ?", cartID).Error
}

type CartLine struct {
	SkuID       string `json:"skuId"`
	SellerID    string `json:"sellerId"`
	Title       string `json:"title,omitempty"`
	SkuName     string `json:"skuName,omitempty"`
	Quantity    int    `json:"quantity"`
	PricePaise  int64  `json:"pricePaise"`
	LineTotal   int64  `json:"lineTotalPaise"`
	Available   bool   `json:"purchasable"`
}

type CartView struct {
	CartID        string     `json:"cartId"`
	Items         []CartLine `json:"items"`
	SubtotalPaise int64      `json:"subtotalPaise"`
	Currency      string     `json:"currency"`
}

// View prices each line from the catalog right now. Prices are never stored in the cart.
func (s *CartService) View(customerID string) (*CartView, error) {
	cartID, err := s.cartID(customerID)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		SkuID    string
		SellerID string
		Quantity int
	}
	if err := s.db.Raw("SELECT sku_id, seller_id, quantity FROM cart_items WHERE cart_id = ? ORDER BY created_at, id", cartID).Scan(&rows).Error; err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.SkuID)
	}
	skus, err := s.catalog.Lookup(ids)
	if err != nil {
		return nil, newErr(http.StatusServiceUnavailable, "CATALOG_UNAVAILABLE", "Could not load product details")
	}
	view := &CartView{CartID: cartID, Items: []CartLine{}, Currency: "INR"}
	for _, r := range rows {
		line := CartLine{SkuID: r.SkuID, SellerID: r.SellerID, Quantity: r.Quantity}
		if sku, ok := skus[strings.ToLower(r.SkuID)]; ok {
			line.Title, line.SkuName, line.PricePaise, line.Available = sku.Title, sku.SkuName, sku.PricePaise, sku.Purchasable
			line.LineTotal = sku.PricePaise * int64(r.Quantity)
			if sku.Purchasable {
				view.SubtotalPaise += line.LineTotal
			}
		}
		view.Items = append(view.Items, line)
	}
	return view, nil
}

// ------------------------------------------------------------------ HTTP
type addItemRequest struct {
	SkuID    string `json:"skuId" binding:"required,uuid"`
	Quantity *int   `json:"quantity"`
}

type setQuantityRequest struct {
	Quantity int `json:"quantity" binding:"required"`
}

func registerCartRoutes(r *gin.Engine, auth *Authenticator, svc *CartService) {
	g := r.Group("/cart", auth.require("CUSTOMER"))

	g.GET("", func(c *gin.Context) {
		view, err := svc.View(principal(c).UserID)
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, view)
	})

	g.POST("/items", func(c *gin.Context) {
		key := c.GetHeader("Idempotency-Key")
		if !idemKeyPattern.MatchString(key) {
			writeError(c, http.StatusBadRequest, "VALIDATION_ERROR", "Idempotency-Key header (8-100 chars: letters, digits, . _ : -) is required", nil)
			return
		}
		var req addItemRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid request body", err.Error())
			return
		}
		qty := 1
		if req.Quantity != nil {
			qty = *req.Quantity
		}
		res, replayed, err := svc.AddItem(principal(c).UserID, strings.ToLower(req.SkuID), qty, key)
		if err != nil {
			fail(c, err)
			return
		}
		c.Header("Idempotent-Replay", map[bool]string{true: "true", false: "false"}[replayed])
		c.JSON(http.StatusOK, res)
	})

	g.PUT("/items/:skuId", func(c *gin.Context) {
		sku := c.Param("skuId")
		if _, err := uuid.Parse(sku); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION_ERROR", "skuId must be a UUID", nil)
			return
		}
		var req setQuantityRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid request body", err.Error())
			return
		}
		if err := svc.SetQuantity(principal(c).UserID, strings.ToLower(sku), req.Quantity); err != nil {
			fail(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	})

	g.DELETE("/items/:skuId", func(c *gin.Context) {
		sku := c.Param("skuId")
		if _, err := uuid.Parse(sku); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION_ERROR", "skuId must be a UUID", nil)
			return
		}
		if err := svc.RemoveItem(principal(c).UserID, strings.ToLower(sku)); err != nil {
			fail(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	})

	g.DELETE("", func(c *gin.Context) {
		if err := svc.Clear(principal(c).UserID); err != nil {
			fail(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	})
}
