import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../src/db.ts';
import {Sealer,type Envelope} from '../src/crypto.ts';
import {Vault} from '../src/vault.ts';

test('original status URL survives restart, retains saved credential, and receives the new challenge',()=>{
 const db=new Db(':memory:'),sealer=Sealer.forTests();
 let vault=new Vault(db,sealer);
 try{
  const r=vault.createRequest({kind:'login',origin:'https://example.com',purpose:'Login'});
  const {itemId}=vault.submit(r.token,{username:'fixture@example.com',password:'fixture-password'});
  vault.loginFeedback(itemId,{state:'testing'});
  vault.loginProgress(itemId,'entering_login');
  const old=vault.createChallenge(itemId,'fixture','https://example.com/login',{method:'code',channel:'sms',instruction:'Digite o código.'}).challenge;
  vault.submitChallenge(r.token,old.id,{code:'482691'});
  const saved=sealer.open(db.get<Envelope>('vault.login_requests.v1')!,'vault:login-requests:v1');
  assert.doesNotMatch(JSON.stringify(saved),/482691|fixture-password|challengeId|fixture@example/);
  assert.doesNotMatch(JSON.stringify(db.sql.prepare('select * from kv').all()),new RegExp(r.token));
  vault=new Vault(db,sealer);
  assert.equal(vault.requestByToken(r.token)?.resultItemId,itemId);
  assert.equal(vault.requestByToken(r.token)?.login?.stage,'interrupted');
  assert.equal(vault.requestByToken(r.token)?.challengeId,undefined);
  assert.throws(()=>vault.takeChallengeCode(old.id,'fixture','https://example.com'));
  assert.throws(()=>vault.submit(r.token,{username:'replay',password:'replay'}));
  assert.equal(vault.valueForFill(itemId,'password','https://example.com'),'fixture-password');
  const fresh=vault.createChallenge(itemId,'fixture','https://example.com/login',{method:'code',channel:'sms',instruction:'Novo código.'}).challenge;
  assert.equal(vault.requestByToken(r.token)?.challengeId,fresh.id);
  assert.equal(vault.requestByToken(r.token)?.login?.stage,'awaiting_code');
  vault.submitChallenge(r.token,fresh.id,{code:'963852'});
  assert.equal(vault.requestByToken(r.token)?.login?.stage,'checking_code');
  vault.takeChallengeCode(fresh.id,'fixture','https://example.com');
  vault.loginFeedback(itemId,{state:'verified'});
  vault=new Vault(db,sealer);
  assert.equal(vault.requestByToken(r.token)?.login?.state,'verified');
  assert.equal(vault.requestByToken(r.token)?.login?.stage,'verified');
 }finally{db.sql.close();}
});

test('retry chain and pending links survive restart; expired metadata and removed logins do not',()=>{
 const db=new Db(':memory:'),sealer=Sealer.forTests();let vault=new Vault(db,sealer);
 try{
  const r=vault.createRequest({kind:'login',origin:'https://example.com',purpose:'Login'});
  const {itemId}=vault.submit(r.token,{username:'fixture@example.com',password:'fixture-password'});
  vault.loginFeedback(itemId,{state:'failed',reason:'incorrect_password'});
  const next=vault.retryLogin(r.token);
  vault=new Vault(db,sealer);
  assert.equal(vault.latestRequest(r.id)?.id,next.id);
  assert.equal(vault.requestByToken(next.token)?.status,'pending');
  const corrected=vault.submit(next.token,{username:'fixture@example.com',password:'corrected-fixture'}).itemId;
  vault=new Vault(db,sealer);
  assert.equal(vault.latestRequest(r.id)?.resultItemId,corrected);
  vault.remove(corrected);vault=new Vault(db,sealer);
  assert.equal(vault.requestByToken(next.token),undefined);
  const stale=vault.createRequest({kind:'login',origin:'https://example.com',purpose:'Expired'});stale.createdAt=0;
  vault.createRequest({kind:'login',origin:'https://example.com',purpose:'Persist'});
  vault=new Vault(db,sealer);assert.equal(vault.requestByToken(stale.token),undefined);
 }finally{db.sql.close();}
});
