const B='http://localhost:8080', pw=process.env.DEMO_USER_PASSWORD;
const j=async(p,o={})=>{const r=await fetch(B+p,{...o,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body&&JSON.stringify(o.body)});return {s:r.status,b:await r.json().catch(()=>null)}};
for(const e of ['seller.alpha@demo.local','seller.beta@demo.local']){
 const l=await j('/api/auth/login',{method:'POST',body:{email:e,password:pw}});const t=l.b.accessToken;
 const list=await j('/api/catalog/seller/products?size=100',{headers:{Authorization:'Bearer '+t}});
 let n=0;for(const p of list.b.items){if(!p.product.title.includes('(demo)'))continue;for(const s of p.product.skus){const r=await j('/api/inventory/seller/stock/'+s.id,{method:'PUT',headers:{Authorization:'Bearer '+t},body:{onHand:50,reason:'demo stock'}});if(r.s===200)n++;else console.log(r.s,r.b)}}
 console.log(e,'stocked skus:',n);}
