import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sameLoginSite,sameSite} from '../src/vault.ts';
import {AgentBrowser} from '../src/browser.ts';
import {loadConfig} from '../src/config.ts';
import {mkdtempSync,rmSync} from 'node:fs';
test('Mercado Livre auth alias is narrow and does not broaden purchase matching',()=>{
 assert.equal(sameLoginSite('https://www.mercadolivre.com.br','https://www.mercadolivre.com/jms/mlb/login'),true);
 assert.equal(sameSite('https://www.mercadolivre.com.br','https://www.mercadolivre.com'),false);
 for(const url of ['https://evil.mercadolivre.com','https://mercadolivre.com.evil.net','http://www.mercadolivre.com','https://www.mercadolivre.com:8443','https://mercadolibre.com']) assert.equal(sameLoginSite('https://www.mercadolivre.com.br',url),false,url);
});
test('split OTP fields fill correctly while snapshots, find and screenshots keep code private',async()=>{
 const home=mkdtempSync('/tmp/inskit-split-otp-');
 const b=new AgentBrowser({...loadConfig(),home,browserUse:undefined,cdpUrl:undefined,headless:true,cookieSync:false});
 try{
  const page=await b.page('test');
  await page.setContent('<h1>Code</h1>'+Array.from({length:6},(_,i)=>`<label>Digit ${i+1}<input type=tel></label>`).join(''));
  const snap=await b.snapshot('test');
  const refs=[...snap.matchAll(/textbox "Digit \d" \[ref=([^\]]+)\]/g)].map(m=>m[1]);
  assert.equal(refs.length,6);
  await b.fillSecretParts('test',refs,'482691');
  assert.deepEqual(await page.locator('input').evaluateAll(es=>es.map((e:any)=>e.value)),['4','8','2','6','9','1']);
  for(const text of [await b.snapshot('test'),await b.find('test','Digit')]) {
   assert.doesNotMatch(text,/\]:\s*"?[0-9]/);
   assert.match(text,/hidden by vault/);
  }
  await assert.rejects(b.screenshot('test'),/blocked/);
  await assert.rejects(b.fillSecretParts('test',refs.slice(0,5),'482691'),/distinct field/);
 }finally{await b.close();rmSync(home,{recursive:true,force:true});}
});
