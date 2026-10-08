import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.ts';
import { Sealer } from '../src/crypto.ts';
import { Vault } from '../src/vault.ts';
import { Service } from '../src/service.ts';
import { Purchases } from '../src/purchases.ts';
import { loadConfig } from '../src/config.ts';
import type { AgentBrowser } from '../src/browser.ts';

function fixture() {
 const db = new Db(':memory:');
 const vault = new Vault(db, Sealer.forTests());
 const r = vault.createRequest({kind:'login',origin:'https://example.com',purpose:'Login'});
 const { itemId } = vault.submit(r.token, {username:'fixture@example.com', password:'test-secret'});
 return {db,vault,r,itemId};
}
test('saving is not verification; retry remains single-use and old wait follows new credentials', () => {
 const {db,vault,r,itemId} = fixture();
 try {
  assert.equal(r.login?.state, 'saved');
  assert.throws(()=>vault.retryLogin(r.token));
  vault.loginFeedback(itemId,{state:'failed',reason:'incorrect_password'});
  const retry=vault.retryLogin(r.token);
  assert.equal(vault.retryLogin(r.token).id,retry.id);
  assert.equal(vault.latestRequest(r.id)?.status,'pending');
  assert.throws(()=>vault.submit(r.token,{username:'changed',password:'changed'}));
  const next=vault.submit(retry.token,{username:'fixture@example.com',password:'corrected-secret'});
  assert.notEqual(next.itemId,itemId);
  assert.equal(vault.latestRequest(r.id)?.resultItemId,next.itemId);
  assert.equal(vault.latestRequest(r.id)?.login?.state,'saved');
  assert.doesNotMatch(JSON.stringify(r),/test-secret/);
  assert.throws(()=>vault.submit(retry.token,{username:'changed',password:'changed'}));
 } finally {db.sql.close();}
});
test('feedback requires visible evidence on the bound site and distinguishes MFA from success', async () => {
 const {db,vault,r,itemId}=fixture();
 let url='https://attacker.example.net', text='Sign out';
 const browser={currentUrl:async()=>url,text:async()=>text} as unknown as AgentBrowser;
 const service=new Service({...loadConfig(),openLinks:false},db,browser,vault,new Purchases(db));
 const report=(state:string,evidence:string)=>service.call('test','vault_login_feedback',{item_id:itemId,state,evidence});
 try {
  assert.equal((await report('verified','Sign out')).isError,true);
  url='https://example.com/account'; text='Enter verification code';
  assert.equal((await report('verified','Sign out')).isError,true);
  assert.equal(r.login?.state,'saved');
  assert.ok(!(await report('action_required','Enter verification code')).isError);
  assert.equal(r.login?.state,'action_required');
  text='Account settings Sign out';
  assert.ok(!(await report('verified','Sign out')).isError);
  assert.equal(r.login?.state,'verified');
 } finally {db.sql.close();}
});

test('reopening feedback after expiry issues a fresh status link', () => {
 const {db,vault,r,itemId}=fixture();
 try {
  r.createdAt=0;
  const fresh=vault.loginFeedback(itemId,{state:'testing'});
  assert.notEqual(fresh.token,r.token);
  assert.equal(fresh.resultItemId,itemId);
  assert.equal(fresh.status,'done');
 } finally {db.sql.close();}
});
