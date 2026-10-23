package main

import "testing"

func TestOrderStateMachine(t *testing.T) {
	legal := [][2]string{
		{StPendingStock, StStockReserved}, {StPendingStock, StFailed}, {StPendingStock, StCancelled},
		{StStockReserved, StPaymentPending}, {StStockReserved, StFailed}, {StStockReserved, StCancelled},
		{StPaymentPending, StPaid}, {StPaymentPending, StFailed}, {StPaymentPending, StCancelled},
		{StPaid, StConfirmed}, {StConfirmed, StRefunded},
	}
	for _, m := range legal {
		if !canTransition(m[0], m[1]) {
			t.Errorf("%s -> %s should be allowed", m[0], m[1])
		}
	}
	illegal := [][2]string{
		{StPending(), StPaid}, {StPaid, StFailed}, {StPaid, StCancelled}, {StConfirmed, StCancelled}, {StConfirmed, StFailed},
		{StFailed, StPaid}, {StCancelled, StPaymentPending}, {StRefunded, StConfirmed}, {StPaymentPending, StConfirmed},
		{StStockReserved, StPaid}, {StConfirmed, StPaymentPending},
	}
	for _, m := range illegal {
		if canTransition(m[0], m[1]) {
			t.Errorf("%s -> %s must be rejected", m[0], m[1])
		}
	}
}

// StPending keeps the table above readable.
func StPending() string { return StPendingStock }

func TestTerminalStates(t *testing.T) {
	for _, s := range []string{StFailed, StCancelled, StRefunded} {
		if !isTerminal(s) {
			t.Errorf("%s should be terminal", s)
		}
		if len(orderTransitions[s]) != 0 {
			t.Errorf("%s must have no outgoing transitions", s)
		}
	}
	if isTerminal(StConfirmed) {
		t.Error("CONFIRMED is not terminal: fulfilment and refunds follow")
	}
}

func TestGroupFulfilmentPath(t *testing.T) {
	path := []string{StConfirmed, GrProcessing, GrShipped, GrDelivered}
	for i := 0; i < len(path)-1; i++ {
		if groupTransitions[path[i]] != path[i+1] {
			t.Errorf("%s should lead to %s", path[i], path[i+1])
		}
	}
	if next, ok := groupTransitions[GrDelivered]; ok {
		t.Errorf("DELIVERED must be final, got next %s", next)
	}
}

func TestBuildPlanComputesTotalsOnTheServer(t *testing.T) {
	s := &Saga{cfg: Config{ShippingFlatPaise: 4900, TaxBps: 500}}
	skus := map[string]CatalogSKU{
		"sku-a": {SkuID: "sku-a", SellerID: "seller-1", PricePaise: 10000, Currency: "INR", Title: "A", SkuName: "Default", Purchasable: true},
		"sku-b": {SkuID: "sku-b", SellerID: "seller-1", PricePaise: 2599, Currency: "INR", Title: "B", SkuName: "Default", Purchasable: true},
		"sku-c": {SkuID: "sku-c", SellerID: "seller-2", PricePaise: 999, Currency: "INR", Title: "C", SkuName: "Default", Purchasable: true},
	}
	rows := []cartRow{{"sku-a", 2}, {"sku-b", 1}, {"sku-c", 3}}
	plan, err := s.buildPlan(rows, skus)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.groups) != 2 {
		t.Fatalf("want 2 seller groups, got %d", len(plan.groups))
	}
	// seller-1: 20000 + 2599 = 22599, tax 5% = 1129.95 -> 1130 (half-up), shipping 4900
	// seller-2: 2997, tax = 149.85 -> 150, shipping 4900
	want := map[string]int64{"seller-1": 22599 + 1130 + 4900, "seller-2": 2997 + 150 + 4900}
	var sum int64
	for _, g := range plan.groups {
		if g.total != want[g.sellerID] {
			t.Errorf("%s total = %d, want %d", g.sellerID, g.total, want[g.sellerID])
		}
		sum += g.total
	}
	if plan.total != sum {
		t.Errorf("order total %d must equal the sum of groups %d", plan.total, sum)
	}
	if plan.total != plan.subtotal+plan.shipping+plan.tax {
		t.Errorf("total %d != subtotal+shipping+tax %d", plan.total, plan.subtotal+plan.shipping+plan.tax)
	}
}

func TestCheckoutRequestHashIgnoresWhitespaceButNotContent(t *testing.T) {
	a := Address{Name: " Asha ", Line1: "1 Road", City: "Pune", State: "MH", Pincode: "411001", Phone: "9999999999"}
	b := Address{Name: "Asha", Line1: "1 Road", City: "Pune", State: "MH", Pincode: "411001", Phone: "9999999999"}
	if hashRequest(a.normalized()) != hashRequest(b.normalized()) {
		t.Error("whitespace differences must not change the request hash")
	}
	c := b
	c.Line1 = "2 Road"
	if hashRequest(b.normalized()) == hashRequest(c.normalized()) {
		t.Error("different addresses must hash differently")
	}
}

func TestCartRequestHashBindsSkuAndQuantity(t *testing.T) {
	if requestHash("ABC", 1) != requestHash("abc", 1) {
		t.Error("sku ids are compared case-insensitively")
	}
	if requestHash("abc", 1) == requestHash("abc", 2) {
		t.Error("quantity must be part of the request hash")
	}
}
