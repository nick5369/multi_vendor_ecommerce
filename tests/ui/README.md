# Browser (Playwright) checks — run on the host against the running stack
```
npm i playwright && npx playwright install chromium
set -a; . ../../.env; set +a; export OUT=./out; mkdir -p out
node seed-demo-stock.mjs            # demo products have no stock until this runs
node customer-razorpay.mjs          # browse -> cart -> checkout -> real Razorpay TEST payment -> CONFIRMED
node seller-admin.mjs               # seller stock/product/orders, admin pages, a real ₹1 test refund
```
Uses Razorpay's Indian test card 5267 3181 8797 5449 and the "Pay on bank's page" -> Success mock. Each run places a real test-mode order and (admin script) a ₹1 refund. Failure screenshots go to $OUT. Admin-list checks only assert that rows render.
node screenshots.mjs                # light/dark/mobile screenshots of home, product, order
