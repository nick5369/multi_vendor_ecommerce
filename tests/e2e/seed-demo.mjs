// DEMO / DEVELOPMENT DATA ONLY. Seeds products for the two demo sellers through the public API,
// so every business rule (ownership, validation, events, cache invalidation) applies.
// Idempotent: a product whose first SKU code already exists for the seller is skipped.
// Run with: scripts/seed-demo.sh
import { api, demoLogin } from './helpers.mjs';

const img = (text) => ({ url: `https://placehold.co/600x400?text=${encodeURIComponent(text)}`, alt: text, position: 0 });

const CATALOG = {
  'seller.alpha@demo.local': [
    { title: 'Wireless Earbuds Pro (demo)', categorySlug: 'audio', skuCode: 'ALPHA-EARBUDS-1', pricePaise: 249900, description: 'Demo product: noise-cancelling earbuds.' },
    { title: 'Bluetooth Speaker Mini (demo)', categorySlug: 'audio', skuCode: 'ALPHA-SPEAKER-1', pricePaise: 149900, description: 'Demo product: pocket speaker.' },
    { title: 'Fast Charger 30W (demo)', categorySlug: 'mobile-accessories', skuCode: 'ALPHA-CHARGER-1', pricePaise: 79900, description: 'Demo product: USB-C charger.' },
    { title: 'Phone Case (demo)', categorySlug: 'mobile-accessories', description: 'Demo product with colour variants.',
      variants: [
        { skuCode: 'ALPHA-CASE-BLK', name: 'Black', pricePaise: 39900, attributes: { colour: 'Black' } },
        { skuCode: 'ALPHA-CASE-BLU', name: 'Blue', pricePaise: 42900, attributes: { colour: 'Blue' } },
      ] },
  ],
  'seller.beta@demo.local': [
    { title: 'Stainless Steel Pan (demo)', categorySlug: 'kitchenware', skuCode: 'BETA-PAN-1', pricePaise: 129900, description: 'Demo product: 24cm pan.' },
    { title: 'Ceramic Mug Set (demo)', categorySlug: 'kitchenware', skuCode: 'BETA-MUGS-1', pricePaise: 69900, description: 'Demo product: set of four mugs.' },
    { title: 'Cotton T-Shirt (demo)', categorySlug: 'fashion', description: 'Demo product with size variants.',
      variants: [
        { skuCode: 'BETA-TEE-S', name: 'Small', pricePaise: 59900, attributes: { size: 'S' } },
        { skuCode: 'BETA-TEE-M', name: 'Medium', pricePaise: 59900, attributes: { size: 'M' } },
        { skuCode: 'BETA-TEE-L', name: 'Large', pricePaise: 64900, attributes: { size: 'L' } },
      ] },
    { title: 'Learning Go (demo)', categorySlug: 'books', skuCode: 'BETA-BOOK-1', pricePaise: 49900, description: 'Demo product: a book.' },
  ],
};

for (const [email, products] of Object.entries(CATALOG)) {
  const seller = await demoLogin(email);
  for (const p of products) {
    const res = await api('/api/catalog/seller/products', {
      method: 'POST',
      token: seller.accessToken,
      body: { ...p, status: 'ACTIVE', images: [img(p.title)] },
    });
    const label = `${email} :: ${p.title}`;
    if (res.status === 201) console.log(`created  ${label}`);
    else if (res.status === 409) console.log(`exists   ${label}`);
    else throw new Error(`seed failed for ${label}: ${res.status} ${JSON.stringify(res.body)}`);
  }
}
console.log('demo catalog seeded');
