import { chromium } from 'playwright';
const pw=process.env.DEMO_USER_PASSWORD, W='http://localhost:5173';
const b=await chromium.launch({headless:process.env.HEADED?false:true,slowMo:150});
const ctx=await b.newContext({viewport:{width:1200,height:900}});
const p=await ctx.newPage();
const errs=[];p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});p.on('pageerror',e=>errs.push('PAGEERR '+e.message));
p.on('response',async r=>{const u=r.url();if(/razorpay\.com/.test(u)&&/payments\/create|ajax|error|status/.test(u)&&r.request().method()==='POST'){const t=await r.text().catch(()=>'');if(/error|fail/i.test(t))console.log('RZP',r.status(),u.slice(0,90),t.slice(0,400))}});
const shot=n=>p.screenshot({path:`${process.env.OUT}/${n}.png`,fullPage:false});
const step=async(n,f)=>{try{await f();console.log('OK  ',n)}catch(e){console.log('FAIL',n,e.message.split('\n')[0]);await shot('fail-'+n.replace(/\W+/g,'_'))}};
await step('home lists products',async()=>{await p.goto(W+'/?q=Earbuds');await p.getByText('Wireless Earbuds Pro').first().waitFor({timeout:8000})});
await step('login customer',async()=>{await p.goto(W+'/login');await p.getByLabel('Email').fill('customer.one@demo.local');await p.getByLabel('Password').fill(pw);await p.getByRole('button',{name:'Log in'}).click();await p.getByText('Log out').waitFor()});
await step('reload keeps session',async()=>{await p.reload();await p.getByText('Log out').waitFor({timeout:8000})});
await step('add to cart',async()=>{await p.goto(W+'/?q=Earbuds');await p.getByText('Wireless Earbuds Pro').first().click();await p.getByRole('button',{name:'Add to cart'}).click();await p.getByText('Added to cart.').waitFor()});
await step('cart page',async()=>{await p.goto(W+'/cart');await p.getByRole('cell',{name:/Wireless Earbuds/}).waitFor();});
await step('checkout form',async()=>{await p.getByRole('link',{name:'Checkout'}).click();
 await p.getByLabel('Full name').fill('Test Buyer');await p.getByLabel('Address line 1').fill('12 Test St');await p.getByLabel('City').fill('Ahmedabad');await p.getByLabel('State').fill('Gujarat');await p.getByLabel('PIN code').fill('380001');await p.getByLabel('Phone').fill('9898123456');
 await p.getByRole('button',{name:/Place order/}).click();await p.waitForURL(/\/orders\//,{timeout:15000})});
await step('payment pending + razorpay iframe',async()=>{await p.getByText('Amount due').waitFor({timeout:20000});await p.locator('iframe.razorpay-checkout-frame').waitFor({timeout:20000});await shot('razorpay-open')});
await step('pay with test card',async()=>{
 const f=p.frameLocator('iframe.razorpay-checkout-frame');
 await f.getByText(/Card/i).first().click({timeout:15000}).catch(()=>{});
 await shot('razorpay-methods');
 await f.locator('input[name="card.number"], #card_number').fill('5267 3181 8797 5449').catch(()=>{});
 await f.locator('input[name="card.expiry"], #card_expiry').fill('12/30').catch(()=>{});
 await f.locator('input[name="card.cvv"], #card_cvv').fill('123').catch(()=>{});
 await shot('razorpay-card');
 
 
 await p.waitForTimeout(2500);await shot('razorpay-after-contact');
 const pay=f.getByRole('button',{name:/^Pay|Continue/i}).first();
 if(await pay.isVisible().catch(()=>false)) await pay.click();
 await f.getByText('Maybe later').click({timeout:8000}).catch(()=>console.log('no save-card prompt'));
 await p.waitForTimeout(4000);await shot('razorpay-after-pay');console.log('IFRAME TEXT',(await f.locator('body').innerText().catch(()=>'')).replace(/\s+/g,' ').slice(0,500));
 const popupP=ctx.waitForEvent('page',{timeout:15000}).catch(()=>null);
 await f.getByText("Pay on bank's page").click({timeout:10000});
 const pop=await popupP; console.log('popup:',pop?pop.url().slice(0,80):'none');
 if(pop){await pop.waitForLoadState().catch(()=>{});await pop.screenshot({path:process.env.OUT+'/bank.png'}).catch(()=>{});await pop.getByRole('button',{name:/Success/i}).click({timeout:10000});}
 else {await shot('no-popup'); for(const fr of p.frames()) console.log('frame',fr.url().slice(0,80));}
});
await step('order confirmed',async()=>{await p.getByText('Order confirmed').waitFor({timeout:40000});await shot('confirmed')});
console.log('console errors:',JSON.stringify(errs.slice(0,8)));
await b.close();
