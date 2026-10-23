package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

// CatalogSKU is the catalog's authoritative view of a SKU. Prices always come from here, never from a client.
type CatalogSKU struct {
	SkuID       string `json:"skuId"`
	ProductID   string `json:"productId"`
	SellerID    string `json:"sellerId"`
	Title       string `json:"title"`
	SkuName     string `json:"skuName"`
	PricePaise  int64  `json:"pricePaise"`
	Currency    string `json:"currency"`
	Purchasable bool   `json:"purchasable"`
}

type CatalogClient interface {
	Lookup(ids []string) (map[string]CatalogSKU, error)
}

type httpCatalog struct {
	baseURL string
	token   string
	client  *http.Client
}

func newCatalogClient(cfg Config) CatalogClient {
	return &httpCatalog{baseURL: cfg.CatalogURL, token: cfg.InternalToken, client: &http.Client{}}
}

func (h *httpCatalog) Lookup(ids []string) (map[string]CatalogSKU, error) {
	if len(ids) == 0 {
		return map[string]CatalogSKU{}, nil
	}
	body, _ := json.Marshal(map[string]any{"ids": ids})
	req, err := http.NewRequest(http.MethodPost, h.baseURL+"/internal/skus/lookup", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", h.token)
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("catalog lookup status %d", resp.StatusCode)
	}
	var rows []CatalogSKU
	if err := json.NewDecoder(resp.Body).Decode(&rows); err != nil {
		return nil, err
	}
	out := make(map[string]CatalogSKU, len(rows))
	for _, r := range rows {
		out[r.SkuID] = r
	}
	return out, nil
}
