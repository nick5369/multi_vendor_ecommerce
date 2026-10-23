import { chromium } from 'playwright';
const W='http://localhost:5173', pw=process.env.DEMO_USER_PASSWORD;
const b=await chromium.launch({slowMo:100});
const errs=[];
async function session(email,password,fn){const ctx=await b.newContext({viewport:{width:1200,height:900}});const p=await ctx.newPage();
 p.on('pageerror',e=>errs.push(email+' PAGEERR '+e.message));p.on('response',r=>{if(r.status()>=400&&!/refresh/.test(r.url())&&r.url().includes(':8080'))errs.push(`${r.status()} ${r.request().method()} ${r.url().slice(0,110)}`)});
 await p.goto(W+'/login');await p.getByLabel('Email').fill(email);await p.getByLabel('Password').fill(password);await p.getByRole('button',{name:'Log in'}).click();await p.getByText('Log out').waitFor();
 const step=async(n,f)=>{try{await f(p);console.log('OK  ',n)}catch(e){console.log('FAIL',n,e.message.split('\n')[0]);await p.screenshot({path:`${process.env.OUT}/fail-${n.replace(/\W+/g,'_')}.png`})}};
 await fn(step,p);await ctx.close();}
await session('seller.alpha@demo.local',pw,async(step)=>{
 await step('seller products list',async p=>{await p.getByText('Wireless Earbuds Pro').first().waitFor()});
 await step('seller product detail',async p=>{await p.getByRole('link',{name:/Wireless Earbuds Pro/}).first().click();await p.getByText('SKUs, prices and stock').waitFor();await p.getByText(/on hand \d+/).first().waitFor()});
 await step('seller set stock',async p=>{await p.getByLabel('Stock on hand').first().fill('60');await p.getByRole('button',{name:'Set stock'}).first().click();await p.getByText('Stock updated').waitFor()});
 await step('seller create product',async p=>{await p.goto(W+'/seller/new');await p.getByLabel('Title').fill('UI Test Gadget');await p.getByLabel('Category').selectOption({index:1});await p.getByLabel('SKU code').fill('UI-GADGET-'+Date.now()%100000);await p.getByLabel('Price (₹)').fill('199.50');await p.getByRole('button',{name:'Create product'}).click();await p.getByText('SKUs, prices and stock').waitFor({timeout:10000});await p.getByText(/on hand 10/).waitFor()});
 await step('seller orders + mark processing',async p=>{await p.goto(W+'/seller/orders');await p.getByRole('button',{name:'Mark processing'}).first().click();await p.getByText('Updated').waitFor();await p.getByRole('button',{name:'Mark shipped'}).first().waitFor()});
});
await session(process.env.ADMIN_SEED_EMAIL,process.env.ADMIN_SEED_PASSWORD,async(step)=>{
 for(const [n,path,text] of [['admin applications','/admin','Seller applications'],['admin stores','/admin/stores',null],['admin users','/admin/users',null],['admin products','/admin/products',null],['admin audit','/admin/audit',null]])
  await step(n,async p=>{await p.goto(W+path);if(text)await p.getByText(text).first().waitFor({timeout:8000});else await p.locator('tbody tr, p.muted').first().waitFor()});
 await step('admin order refund',async p=>{await p.goto(W+'/admin/orders');await p.getByRole('combobox').selectOption('CONFIRMED');await p.getByRole('link',{name:/^[0-9a-f]{8}$/}).first().click();
  await p.getByPlaceholder(/Amount/).fill('1');p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'Refund',exact:true}).click();await p.getByText(/Refund submitted/).waitFor({timeout:15000});await p.screenshot({path:process.env.OUT+'/refund.png'})});
});
console.log('http errors:',JSON.stringify(errs,null,1));await b.close();
