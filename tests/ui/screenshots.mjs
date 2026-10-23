import { chromium } from 'playwright';
const W='http://localhost:5173', pw=process.env.DEMO_USER_PASSWORD, O=process.env.OUT;
const b=await chromium.launch();
for(const [name,scheme,vp] of [['light','light',{width:1280,height:900}],['dark','dark',{width:1280,height:900}],['mobile','light',{width:390,height:800}]]){
 const ctx=await b.newContext({viewport:vp,colorScheme:scheme});const p=await ctx.newPage();
 await p.goto(W+'/?q=Earbuds'); await p.getByText('Wireless Earbuds Pro').first().waitFor(); await p.waitForTimeout(400);
 await p.screenshot({path:`${O}/${name}-home.png`});
 await p.getByText('Wireless Earbuds Pro').first().click(); await p.getByRole('button',{name:'Add to cart'}).waitFor(); await p.waitForTimeout(400);
 await p.screenshot({path:`${O}/${name}-product.png`});
 await p.goto(W+'/login'); await p.getByLabel('Email').fill('customer.one@demo.local'); await p.getByLabel('Password').fill(pw); await p.getByRole('button',{name:'Log in'}).click(); await p.getByText('Log out').waitFor();
 await p.goto(W+'/orders'); await p.getByRole('link',{name:/Order /}).first().waitFor(); await p.getByRole('link',{name:/Order /}).first().click(); await p.getByText('Totals').waitFor(); await p.waitForTimeout(500);
 await p.screenshot({path:`${O}/${name}-order.png`});
 await ctx.close();
}
await b.close();
