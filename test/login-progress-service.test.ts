import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../src/db.ts';
import {Sealer} from '../src/crypto.ts';
import {Vault} from '../src/vault.ts';
import {Service} from '../src/service.ts';
import {Purchases} from '../src/purchases.ts';
import {loadConfig} from '../src/config.ts';
import type {AgentBrowser} from '../src/browser.ts';

test('browser actions publish real login progress; other sites and pending codes do not overwrite it',async()=>{
 const db=new Db(':memory:'),vault=new Vault(db,Sealer.forTests());
 const r=vault.createRequest({kind:'login',origin:'https://example.com',purpose:'Login'});
 const {itemId}=vault.submit(r.token,{username:'fixture@example.com',password:'dummy-password'});
 let url='https://example.com/login', fail=false;
 const browser={currentUrl:async()=>url,fillSecret:async()=>{},snapshot:async()=>{if(fail)throw Error('Site unavailable');return 'Sign in';},click:async()=> 'Enter code'} as unknown as AgentBrowser;
 const service=new Service({...loadConfig(),openLinks:false},db,browser,vault,new Purchases(db));
 const call=(name:string,args:any={})=>service.call('fixture',name,args);
 try{
  assert.ok(!(await call('vault_fill',{item_id:itemId,field:'username',ref:'e1'})).isError);
  assert.equal(vault.loginStatus(itemId)?.stage,'entering_login');
  await call('browser_click',{ref:'e2'});
  assert.deepEqual(vault.loginStatus(itemId)?.events?.slice(-2).map(e=>e.stage),['waiting_site','checking_result']);
  const progress=JSON.stringify(vault.loginStatus(itemId));url='https://other.example.net';await call('browser_snapshot');
  assert.equal(JSON.stringify(vault.loginStatus(itemId)),progress);
  url='https://example.com/login';
  vault.createChallenge(itemId,'fixture',url,{method:'code',channel:'sms',instruction:'Digite o código.'});
  await call('browser_snapshot');assert.equal(vault.loginStatus(itemId)?.stage,'awaiting_code');
  vault.loginFeedback(itemId,{state:'testing'});fail=true;
  assert.equal((await call('browser_snapshot')).isError,true);assert.equal(vault.loginStatus(itemId)?.stage,'interrupted');
 }finally{db.sql.close();}
});
