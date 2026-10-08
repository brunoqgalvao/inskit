import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.ts';
import { Sealer } from '../src/crypto.ts';
import { Vault } from '../src/vault.ts';
import { Service } from '../src/service.ts';
import { Purchases } from '../src/purchases.ts';
import { loadConfig } from '../src/config.ts';
import type { AgentBrowser } from '../src/browser.ts';
function setup() {
 const db=new Db(':memory:'), vault=new Vault(db,Sealer.forTests());
 const r=vault.createRequest({kind:'login',origin:'https://accounts.example.com',purpose:'Login'});
 const {itemId}=vault.submit(r.token,{username:'fixture@example.com',password:'dummy-password'});
 const create=()=>vault.createChallenge(itemId,'session-a','https://accounts.example.com/login',{method:'code',channel:'sms',instruction:'Digite o código recebido.'});
 return {db,vault,r,itemId,create};
}
test('code is ephemeral, hidden from public state and audit, single-use and bound to session/origin',()=>{
 const {db,vault,r,create}=setup();
 try {
  const {challenge:c}=create();vault.submitChallenge(r.token,c.id,{code:'482691'});
  assert.doesNotMatch(JSON.stringify(vault.publicChallenge(c.id)),/482691/);
  assert.doesNotMatch(JSON.stringify(db.sql.prepare('select * from audit').all()),/482691/);
  assert.doesNotMatch(JSON.stringify(db.sql.prepare('select * from vault_items').all()),/482691/);
  assert.throws(()=>vault.takeChallengeCode(c.id,'session-b','https://accounts.example.com'));
  assert.throws(()=>vault.takeChallengeCode(c.id,'session-a','https://evil.example.com'));
  assert.throws(()=>vault.submitChallenge(r.token,c.id,{code:'111111'}));
  assert.equal(vault.takeChallengeCode(c.id,'session-a','https://accounts.example.com/verify'),'482691');
  assert.throws(()=>vault.takeChallengeCode(c.id,'session-a','https://accounts.example.com'));
 }finally{db.sql.close();}
});
test('replaced or expired challenges cannot reuse old codes',()=>{
 const {db,vault,r,create}=setup();
 try {
  const old=create().challenge;vault.submitChallenge(r.token,old.id,{code:'482691'});
  const next=create().challenge;
  assert.equal(vault.publicChallenge(old.id),undefined);
  assert.throws(()=>vault.takeChallengeCode(old.id,'session-a','https://accounts.example.com'));
  assert.throws(()=>vault.submitChallenge(r.token,old.id,{code:'482691'}));
  vault.submitChallenge(r.token,next.id,{code:'963852'});next.expiresAt=Date.now()-1;
  assert.equal(vault.publicChallenge(next.id)?.status,'expired');
  assert.throws(()=>vault.takeChallengeCode(next.id,'session-a','https://accounts.example.com'));
 }finally{db.sql.close();}
});
test('human app confirmation only resumes checking and is never authentication proof',()=>{
 const {db,vault,r,itemId}=setup();
 try {
  const {challenge:c}=vault.createChallenge(itemId,'session-a','https://accounts.example.com',{method:'app',channel:'app',instruction:'Aprove no aplicativo.'});
  vault.submitChallenge(r.token,c.id,{confirmed:'yes'});
  assert.equal(r.login?.state,'testing');
  assert.equal(c.status,'ready');
  assert.throws(()=>vault.takeChallengeCode(c.id,'session-a','https://accounts.example.com'));
  vault.loginFeedback(itemId,{state:'verified'});
  assert.equal(vault.publicChallenge(c.id),undefined);
 }finally{db.sql.close();}
});
test('service requires evidence, waits without exposing code and fills through secret redaction path',async()=>{
 const {db,vault,r,itemId}=setup();let filled='';
 const browser={currentUrl:async()=> 'https://accounts.example.com/verify',text:async()=> 'Enter SMS code',fillSecret:async(_s:string,_r:string,value:string)=>{filled=value;}} as unknown as AgentBrowser;
 const service=new Service({...loadConfig(),openLinks:false},db,browser,vault,new Purchases(db));
 const call=(name:string,args:any)=>service.call('session-a',name,args);
 try {
  const start=await call('vault_login_challenge',{item_id:itemId,method:'code',channel:'sms',instruction:'Digite o código.',evidence:'not visible'});assert.equal(start.isError,true);
  const good=await call('vault_login_challenge',{item_id:itemId,method:'code',channel:'sms',instruction:'Digite o código.',evidence:'Enter SMS code'});assert.ok(!good.isError);
  const id=r.challengeId!;
  vault.submitChallenge(r.token,id,{code:'482691'});
  const ready=await call('vault_challenge_wait',{challenge_id:id,timeout_seconds:1});assert.doesNotMatch(JSON.stringify(ready),/482691/);
  const result=await call('vault_challenge_fill',{challenge_id:id,ref:'e2'});
  assert.equal(filled,'482691');assert.ok(!result.isError);assert.doesNotMatch(JSON.stringify(result),/482691/);
  assert.equal((await call('vault_challenge_fill',{challenge_id:id,ref:'e2'})).isError,true);
 }finally{db.sql.close();}
});

test('challenge opens a vault page when none is being watched (login saved long ago)',async()=>{
 const {db,vault,r,itemId}=setup();
 const browser={currentUrl:async()=> 'https://accounts.example.com/verify',text:async()=> 'Enter SMS code'} as unknown as AgentBrowser;
 const service=new Service({...loadConfig(),openLinks:false},db,browser,vault,new Purchases(db));
 const ask=()=>service.call('session-a','vault_login_challenge',{item_id:itemId,method:'code',channel:'sms',instruction:'Digite o código.',evidence:'Enter SMS code'});
 const textOf=(x:any)=>JSON.stringify(x.content);
 try {
  vault.markViewed(r);
  const watched=await ask();assert.ok(!watched.isError);
  assert.match(textOf(watched),/already has open/);assert.doesNotMatch(textOf(watched),/\/v\//);
  r.createdAt=Date.now()-31*60_000;
  const fresh=await ask();assert.ok(!fresh.isError);
  const token=textOf(fresh).match(/\/v\/([\w-]{20,})/)?.[1];
  assert.ok(token,'returns a link to a live vault page');assert.notEqual(token,r.token);
  const page=vault.requestByToken(token!)!;
  assert.equal(page.status,'done');assert.ok(page.challengeId);
  vault.submitChallenge(token!,page.challengeId!,{code:'482691'});
  assert.equal(vault.challenge(page.challengeId!)?.status,'ready');
 }finally{db.sql.close();}
});


test('agent-provided code (from email or pasted by the user) is filled and confirmed without leaking',async()=>{
 const {db,vault,r,itemId}=setup();const filled:string[]=[];
 const browser={currentUrl:async()=> 'https://accounts.example.com/verify',text:async()=> 'Enter the code we emailed you',snapshot:async()=> 'Welcome back',
  autoFillCode:async(_s:string,take:(u:string)=>string)=>{filled.push(take('https://accounts.example.com/verify'));return {ms:900};}} as unknown as AgentBrowser;
 const service=new Service({...loadConfig(),openLinks:false},db,browser,vault,new Purchases(db));
 const call=(name:string,args:any)=>service.call('session-a',name,args);
 try {
  assert.equal((await call('vault_challenge_code',{code:'482691',source:'email',item_id:itemId,evidence:'not on page'})).isError,true);
  const direct=await call('vault_challenge_code',{code:'482691',source:'email',item_id:itemId,evidence:'Enter the code we emailed you'});
  assert.ok(!direct.isError);assert.match(JSON.stringify(direct),/filled and confirmed/);assert.doesNotMatch(JSON.stringify(direct),/482691/);
  assert.deepEqual(filled,['482691']);
  vault.markViewed(r);
  await call('vault_login_challenge',{item_id:itemId,method:'code',channel:'email',instruction:'Digite o código.',evidence:'Enter the code we emailed you'});
  const id=r.challengeId!;
  const pasted=await call('vault_challenge_code',{code:'466 033',source:'user',challenge_id:id});
  assert.ok(!pasted.isError);assert.equal(filled[1],'466033');assert.equal(vault.challenge(id)?.status,'consumed');
  assert.equal((await call('vault_challenge_code',{code:'466033',source:'user',challenge_id:id})).isError,true);
  assert.equal((await service.call('session-b','vault_challenge_code',{code:'111111',source:'user',challenge_id:id})).isError,true);
  assert.doesNotMatch(JSON.stringify(db.sql.prepare('select * from audit').all()),/482691|466033/);
 }finally{db.sql.close();}
});

