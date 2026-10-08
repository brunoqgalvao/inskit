import { BRAND } from './brand.ts';
import type { SecretRequest, VaultItemPublic, Vault } from './vault.ts';
import { hostOf } from './vault.ts';
import { money, type Order } from './purchases.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const shell = (title: string, body: string, wide = false) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)} · ${esc(BRAND)}</title>
<style>
:root{--ink:#18181b;--muted:#6b6b72;--line:#e4e2dd;--bg:#f4f3ef;--card:#fff;--accent:#1d4ed8;--ok:#15803d;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--ink:#ececee;--muted:#a1a1aa;--line:#2f2f35;--bg:#121214;--card:#1b1b1f;--accent:#7aa2ff;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink);display:grid;place-items:center;min-height:100vh;padding:24px}
main{width:100%;max-width:${wide ? 640 : 420}px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 26px}
.brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;color:var(--muted);margin-bottom:18px}
.dot{width:18px;height:18px;border-radius:6px;background:var(--ink);display:inline-grid;place-items:center;color:var(--card);font-size:11px}
h1{font-size:20px;line-height:1.25;margin:0 0 6px;letter-spacing:-.01em;text-wrap:balance}p{margin:0 0 16px;color:var(--muted)}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
input:not([type=checkbox]){width:100%;font:inherit;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);outline:none}
input:focus{border-color:var(--accent)}.row{display:flex;gap:10px}.row>div{flex:1}
.check{display:flex;gap:8px;align-items:center;font-weight:500;font-size:14px;margin-top:16px}
button,.btn{display:inline-block;text-align:center;text-decoration:none;margin-top:20px;width:100%;font:inherit;font-weight:600;padding:12px;border:0;border-radius:10px;background:var(--ink);color:var(--card);cursor:pointer}
button.secondary,.btn.secondary{background:transparent;color:var(--ink);border:1px solid var(--line);margin-top:10px}
button:active{transform:scale(.99)}.err{background:color-mix(in srgb,var(--bad) 12%,transparent);color:var(--bad);padding:10px 12px;border-radius:10px;font-size:14px;margin-bottom:12px}
.fine{font-size:12px;color:var(--muted);margin:14px 0 0}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;margin:6px 0 4px}td{padding:7px 0;border-bottom:1px solid var(--line);vertical-align:top}td:last-child{text-align:right;white-space:nowrap;padding-left:12px}
tr.total td{font-weight:700;font-size:17px;border-bottom:0;padding-top:12px}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:14px 0 0;font-size:14px}dt{color:var(--muted)}dd{margin:0}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--bg);border:1px solid var(--line)}
.list{list-style:none;padding:0;margin:8px 0 0}.list li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
.list form{margin:0}.list button{margin:0;width:auto;padding:6px 10px;font-size:13px}
h2{font-size:14px;margin:24px 0 0}
</style></head><body><main><div class="brand"><span class="dot">◆</span>${esc(BRAND)}</div>${body}</main></body></html>`;

export function vaultPage(request: SecretRequest | undefined, cardLabel?: string, error?: string) {
  if (!request) return shell('Invalid link', `<h1>This link is not valid</h1><p>Ask Codex for a new one.</p>`);
  if (request.status !== 'pending') return shell('Link used', `<h1>This link was already used</h1><p>Each vault link works once. Ask Codex for a new one if you need it.</p>`);
  const err = error ? `<div class="err">${esc(error)}</div>` : '';
  const intro = request.kind === 'login' ? `<h1>Guardar login</h1><p>${esc(hostOf(request.origin ?? ''))}</p>${err}` : `<h1>${esc(request.purpose)}</h1><p>What you type here goes straight into the encrypted vault on this computer. Codex never sees it; it can only ask the vault to type it into the right field.</p>${err}`;
  let fields = '';
  switch (request.kind) {
    case 'card':
      fields = `<label for=number>Card number</label><input id=number name=number inputmode=numeric autocomplete=cc-number required autofocus>
<div class=row><div><label for=expiry>Expiry</label><input id=expiry name=expiry placeholder="MM/YY" autocomplete=cc-exp required></div>
<div><label for=cvv>CVV</label><input id=cvv name=cvv inputmode=numeric autocomplete=cc-csc maxlength=4></div></div>
<label for=holder>Name on card</label><input id=holder name=holder autocomplete=cc-name required>
<label for=label>Nickname (optional)</label><input id=label name=label placeholder="e.g. Personal Visa">
<label class=check><input type=checkbox name=rememberCvv> Remember the CVV on this computer</label>
<p class=fine>Without it, the CVV is used for this purchase only and you'll be asked again next time.</p>`;
      break;
    case 'cvv':
      fields = `<label for=cvv>CVV for ${esc(cardLabel ?? 'your card')}</label><input id=cvv name=cvv inputmode=numeric autocomplete=cc-csc maxlength=4 required autofocus>
<p class=fine>Used once for this purchase, then discarded.</p>`;
      break;
    case 'login':
      fields = `<label for=username>E-mail ou usuário</label><input id=username name=username autocomplete=username required autofocus>
<label for=password>Senha</label><input id=password name=password type=password autocomplete=current-password required><p class=fine>Guardamos seus dados e tentamos entrar. Se precisar de um código, você confirma aqui.</p>`;
      break;
    case 'identity':
      fields = `<label for=document>Document number (ID, passport…)</label><input id=document name=document autofocus>
<label for=cpf>CPF (Brazil, optional)</label><input id=cpf name=cpf inputmode=numeric>
<label for=birthDate>Date of birth (optional)</label><input id=birthDate name=birthDate placeholder="YYYY-MM-DD">`;
      break;
  }
  return shell('Vault', `${intro}<form method=post autocomplete=on>${fields}<button type=submit>${request.kind === 'login' ? 'Guardar e continuar' : 'Save to vault'}</button></form>`);
}

export function donePage(title: string, body: string) {
  return shell(title, `<h1>${esc(title)}</h1><p>${esc(body)}</p><script>setTimeout(()=>{try{window.close()}catch{}},2500)</script>`);
}

export function approvalPage(order: Order | undefined, error?: string) {
  if (!order) return shell('Invalid link', `<h1>This approval link is not valid</h1><p>It may have been used already. Ask Codex for a new proposal.</p>`);
  if (order.status !== 'awaiting_approval') return shell('Already decided', `<h1>This purchase is ${esc(order.status.replace('_', ' '))}</h1><p>Nothing else to do here.</p>`);
  const q = order.quote;
  const m = (c: number) => esc(money(c, order.currency));
  const rows = q.items.map(i => `<tr><td>${esc(i.name)}${i.quantity > 1 ? ` <span class=pill>×${i.quantity}</span>` : ''}</td><td>${m(i.unitPriceCents * i.quantity)}</td></tr>`).join('');
  const line = (label: string, cents: number, sign = '') => cents ? `<tr><td>${label}</td><td>${sign}${m(cents)}</td></tr>` : '';
  return shell('Approve purchase', `${error ? `<div class=err>${esc(error)}</div>` : ''}
<h1>Buy from ${esc(order.storeName)}?</h1><p>Codex filled the cart and stopped before paying. Nothing is charged until you approve.</p>
<table>${rows}${line('Shipping', q.shippingCents)}${line('Tax', q.taxCents)}${line('Discount', q.discountCents, '−')}
<tr class=total><td>Total</td><td>${m(q.totalCents)}</td></tr></table>
<dl><dt>Store</dt><dd>${esc(order.storeHost)}</dd><dt>Payment</dt><dd>${esc(q.paymentMethod)}</dd><dt>Delivery</dt><dd>${esc(q.shippingMethod)} · ${esc(q.deliveryEstimate)}</dd><dt>Ship to</dt><dd>${esc(q.address)}</dd>${q.notes ? `<dt>Notes</dt><dd>${esc(q.notes)}</dd>` : ''}</dl>
<form method=post><button name=decision value=approve type=submit>Approve ${m(q.totalCents)}</button><button class=secondary name=decision value=reject type=submit>Don't buy</button></form>
<p class=fine>Codex can only place this exact order, at this store, while this total is on the checkout page.</p>`, true);
}

export function homePage(items: VaultItemPublic[], orders: Order[], status: { browser: string; cookies: string }) {
  const vault = items.length
    ? `<ul class=list>${items.map(i => `<li><span>${esc(i.label)} <span class=pill>${esc(i.kind)}</span></span><form method=post action="/items/${esc(i.id)}/delete"><button class=secondary type=submit>Remove</button></form></li>`).join('')}</ul>`
    : '<p>Empty.</p>';
  const recent = orders.length
    ? `<ul class=list>${orders.map(o => `<li><span>${esc(o.storeName)} · ${esc(money(o.totalCents, o.currency))}</span><span class=pill>${esc(o.status.replace('_', ' '))}</span></li>`).join('')}</ul>`
    : '<p>None yet.</p>';
  return shell('Home', `<h1>${esc(BRAND)} for Codex</h1><p>Browser: ${esc(status.browser)} · Logins: ${esc(status.cookies)}</p>
<a class=btn href="/new/card">Add a card</a><a class="btn secondary" href="/new/identity">Add an ID document</a>
<h2>Vault</h2>${vault}<h2>Recent purchases</h2>${recent}`, true);
}


/** Public challenge metadata only. Codes never enter the rendered HTML or status API. */
export function loginStatusPage(request: SecretRequest, challenge?: ReturnType<Vault['publicChallenge']>) {
  return shell('Login guardado', `<style>
main{max-width:440px;padding:30px}.brand{margin-bottom:28px}.saved-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:50%;color:var(--ok);background:color-mix(in srgb,var(--ok) 9%,var(--card));margin-bottom:14px;font-size:20px}
.site{font-size:12px;margin:0 0 5px}.saved-title{font-size:23px;letter-spacing:-.035em}.intro{font-size:14px;line-height:1.55;margin:10px 0 0;max-width:340px}
.progress{border-top:1px solid var(--line);margin-top:26px;padding-top:21px}.section-label{font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
.history{list-style:none;margin:0;padding:0}.history li{display:flex;align-items:center;gap:11px;font-size:13px;color:var(--muted);padding:0 0 13px}.history .tick{width:18px;text-align:center;color:var(--ok);font-size:12px}
.current{display:flex;align-items:flex-start;gap:11px}.indicator{width:18px;height:18px;flex:0 0 18px;display:grid;place-items:center;color:var(--ok);margin-top:2px}.indicator.busy:before{content:'';height:12px;width:12px;border:2px solid var(--line);border-top-color:var(--ink);border-radius:50%;animation:spin 1s linear infinite}.indicator.waiting:before{content:'';width:7px;height:7px;background:var(--muted);border-radius:50%;animation:breathe 1.8s ease-in-out infinite}.indicator.attention{color:var(--accent)}.indicator.failed{color:var(--bad)}
#title{font-size:15px;line-height:1.4;margin:0;font-weight:600;letter-spacing:-.01em}#message{font-size:13px;line-height:1.5;margin:5px 0 0}#challenge{margin:18px 0 0 29px}#instruction{font-size:13px;margin-bottom:12px}#code-field label{font-weight:500;margin-top:0}#code{font-size:21px;letter-spacing:.18em;padding:10px 12px}#challenge-submit{font-size:14px;margin-top:12px;padding:10px}#challenge-error{font-size:12px}#retry{margin-left:29px}#retry button{font-size:14px;margin-top:14px;padding:10px}#connection{font-size:12px;margin:12px 0 0 29px}
[hidden]{display:none!important}@keyframes spin{to{transform:rotate(360deg)}}@keyframes breathe{50%{opacity:.3}}@media(prefers-reduced-motion:reduce){*,*:before{animation:none!important;transition:none!important}}@media(max-width:480px){body{padding:18px}main{padding:25px 23px}.saved-title{font-size:22px}}
</style>
<div class=saved-mark aria-hidden=true>✓</div>
<p class=site>${esc(hostOf(request.origin ?? ''))}</p>
<h1 class=saved-title>Guardado no cofre</h1>
<p class=intro>Pode fechar esta página. Se preferir, fique para acompanhar a validação do acesso.</p>
<section class=progress aria-label="Validação do acesso">
<div class=section-label>Validação do acesso</div>
<ol class=history id=history aria-label="Etapas anteriores"></ol>
<div class=current role=status aria-live=polite aria-atomic=true><span id=indicator class="indicator busy" aria-hidden=true></span><div><h2 id=title>Preparando a validação</h2><p id=message hidden></p></div></div>
<section id=challenge hidden>
<p id=instruction></p><p class=err id=challenge-error hidden role=alert></p>
<form id=challenge-form method=post action="/v/${esc(request.token)}/challenge" autocomplete=on>
<div id=code-field><label for=code>Código de verificação</label><input id=code name=code autocomplete=one-time-code inputmode=text minlength=3 maxlength=32 placeholder="Seu código" spellcheck=false autocapitalize=off></div>
<button id=challenge-submit type=submit>Confirmar código</button>
</form></section>
<form method=post action="/v/${esc(request.token)}/retry" id=retry hidden><button>Corrigir login</button></form>
<p id=connection hidden role=status></p>
</section>
<script>
const el=id=>document.getElementById(id);
const labels={saved:'Preparando a validação',preparing:'Preparando a validação',opening_site:'Abrindo o site',entering_login:'Login preenchido',entering_password:'Senha preenchida',waiting_site:'Aguardando o site',checking_result:'Conferindo a resposta do site',awaiting_code:'O site pediu um código',awaiting_app:'Confirme no aplicativo',checking_code:'Código recebido. Conferindo…',checking_app:'Conferindo sua confirmação',verified:'Acesso confirmado',failed:'Não conseguimos entrar',interrupted:'Vamos retomar a validação'};
const completed={preparing:'Validação iniciada',entering_login:'Login preenchido',entering_password:'Senha preenchida',checking_code:'Código recebido',checking_app:'Confirmação recebida'};
const reasons={email_not_found:'O site não reconheceu o login. Você pode corrigir abaixo.',incorrect_password:'O site não aceitou a senha. Você pode corrigir abaixo.'};
let currentId,submitting=false,stopped=false,lastHistory='',lastData,offline=false;
function setText(id,text){if(el(id).textContent!==text)el(id).textContent=text;}
function render(data){
 lastData=data;const state=data.login.state,c=data.challenge;
 let stage=data.login.stage||({saved:'saved',testing:'checking_result',action_required:'awaiting_code',verified:'verified',failed:'failed'})[state]||'saved';
 const pending=c&&c.status==='pending'&&Date.now()<c.expiresAt;
 const expired=c&&(c.status==='expired'||Date.now()>=c.expiresAt)&&!['consumed','cancelled'].includes(c.status);
 const terminal=['verified','failed'].includes(state);
 let title=labels[stage]||labels.saved,message='',mode='busy';
 if(state==='verified'){stage='verified';title=labels.verified;message='Tudo pronto para usar sua conta.';mode='done';}
 else if(state==='failed'){stage='failed';title=labels.failed;message=reasons[data.login.reason]||'Seus dados continuam guardados. Confira o login para tentar de novo.';mode='failed';}
 else if(pending){stage=c.method==='app'?'awaiting_app':'awaiting_code';title=labels[stage];mode='attention';}
 else if(expired){title='O código expirou';message='Aguardando uma nova tentativa. Sua senha continua guardada.';mode='waiting';}
 else if(c&&['ready','consumed'].includes(c.status)){stage=c.method==='code'?'checking_code':'checking_app';title=labels[stage];}
 else if(stage==='interrupted'){message='Sua senha está salva. A próxima tentativa continua aqui.';mode='waiting';}
 else if(state==='action_required'){title='O site pediu uma confirmação';message='Preparando a próxima etapa aqui.';}
 const age=Date.now()-(data.login.lastActivityAt||data.login.updatedAt||Date.now());
 if(!terminal&&!pending&&!expired&&stage!=='interrupted'&&age>45000){title='Ainda aguardando o site';message='Sem resposta por enquanto. Pode fechar e voltar depois.';mode='waiting';}
 if(offline){title='Reconectando…';message='Seu login já está guardado. Tentando atualizar o andamento.';mode='waiting';}
 setText('title',title);setText('message',message);el('message').hidden=!message;
 el('indicator').className='indicator '+mode;el('indicator').textContent=mode==='done'?'✓':mode==='attention'?'→':mode==='failed'?'!':'';
 el('retry').hidden=state!=='failed';
 const events=(data.login.events||[]).filter(e=>e.stage!=='saved');
 const lastIndex=events.length-1;
 // Only completed earlier steps; never invent steps from elapsed time.
 const earlier=events.filter((e,i)=>i<lastIndex&&completed[e.stage]).slice(-2).map(e=>completed[e.stage]);
 const key=JSON.stringify(earlier);if(key!==lastHistory){lastHistory=key;el('history').replaceChildren(...earlier.map(text=>{const li=document.createElement('li'),tick=document.createElement('span'),label=document.createElement('span');tick.className='tick';tick.setAttribute('aria-hidden','true');tick.textContent='✓';label.textContent=text;li.append(tick,label);return li;}));}
 el('challenge').hidden=!c||!pending||terminal||offline;
 if(c){
  if(currentId!==c.id){currentId=c.id;el('code').value='';el('challenge-error').hidden=true;}
  setText('instruction',c.instruction);
  el('code-field').hidden=c.method!=='code';el('code').required=c.method==='code'&&pending;
  setText('challenge-submit',c.method==='app'?'Já confirmei no aplicativo':'Confirmar código');
  el('challenge-submit').disabled=!pending||submitting;el('code').disabled=!pending||submitting;
  if(!pending)el('code').value='';
  if(pending&&c.error==='invalid_code'){setText('challenge-error','Esse código não funcionou. Tente o mais recente.');el('challenge-error').hidden=false;}
 }
 if(data.retry){location.reload();return;}
}
async function poll(){try{
 const res=await fetch(location.pathname+'/status',{signal:AbortSignal.timeout(8000)});
 if(res.status===404||res.status===410){stopped=true;el('challenge').hidden=true;el('indicator').className='indicator waiting';setText('title','Este acompanhamento expirou');setText('message','Seu login continua guardado. Peça para retomar a validação.');el('message').hidden=false;return;}
 if(!res.ok)throw Error();offline=false;render(await res.json());
 }catch{offline=true;if(lastData)render(lastData);}
 if(!stopped)setTimeout(poll,1000);
}
el('challenge-form').addEventListener('submit',async event=>{
 event.preventDefault();if(submitting||!currentId)return;
 submitting=true;el('challenge-submit').disabled=true;el('challenge-error').hidden=true;
 try{
  const data=new URLSearchParams({challenge_id:currentId,code:el('code').value,confirmed:'yes'});
  const res=await fetch(location.pathname+'/challenge',{method:'POST',body:data,signal:AbortSignal.timeout(8000)});
  const result=await res.json();if(!res.ok)throw Error(result.error||'Não foi possível enviar. Tente novamente.');
  el('code').value='';el('challenge').hidden=true;setText('title','Recebido. Conferindo…');
  const status=await fetch(location.pathname+'/status');if(status.ok)render(await status.json());
 }catch(error){setText('challenge-error',error.name==='TimeoutError'?'Não foi possível confirmar o envio. Aguarde a atualização.':error.message);el('challenge-error').hidden=false;}
 finally{submitting=false;el('challenge-submit').disabled=false;el('code').disabled=false;}
});
render(${JSON.stringify({ login: request.login ?? { state: 'saved' }, challenge }).replace(/</g,'\\u003c')});
setTimeout(poll,1000);
</script>`);
}
