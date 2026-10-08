// Browser-side sources. Kept as plain strings: bundlers inject helpers (e.g. __name) into
// functions, and those helpers do not exist inside the page.

export type ScanOptions = { username?: string[]; password?: string[]; submit?: string[]; submitNames?: string[] };
export type ClassifyOptions = {
  rejected?: string[]; chooser?: string[]; code?: string[]; human?: string[]; app?: string[];
  loggedInSelectors?: string[]; loggedInText?: string[]; loggedOutSelectors?: string[]; loggedOutText?: string[];
};
export type PageClass = {
  captcha: boolean; passkey: boolean; app: boolean; chooser: boolean; codeText: boolean; rejected: string;
  logoutLink: boolean; loggedInSignal: boolean; loggedOutSignal: boolean; busy: boolean; signup: boolean; newAccount: boolean; interstitial: boolean; blocked: boolean; textLength: number;
};

const call = (fn: string, arg: unknown) => '(' + fn + ')(' + JSON.stringify(arg) + ')';

const SCAN = String.raw`(opts) => {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect(), st = getComputedStyle(el);
    if (r.width < 3 || r.height < 3 || st.visibility === 'hidden' || st.display === 'none') return false;
    // Off-screen or clipped fields exist only for password managers.
    if (r.right < 0 || r.bottom < -2000 || r.left > innerWidth + 50 || st.clipPath === 'inset(50%)' || st.clip === 'rect(0px, 0px, 0px, 0px)') return false;
    // Transparent native submit inputs under a styled label (Amazon) are still the real button.
    const nativeSubmit = el.tagName === 'INPUT' && el.type === 'submit';
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const sa = getComputedStyle(a);
      // Ancestor opacity is a styling trick on many sites (Airbnb): only the element's own opacity counts.
      if (a.getAttribute('aria-hidden') === 'true' || sa.visibility === 'hidden' || (a === el && sa.opacity === '0' && !nativeSubmit)) return false;
    }
    return true;
  };
  const pick = (sels) => { for (const s of sels || []) { try { const el = Array.from(document.querySelectorAll(s)).find(visible); if (el) return el; } catch (e) {} } return undefined; };
  document.querySelectorAll('[data-inskit],[data-inskit-code]').forEach(e => { e.removeAttribute('data-inskit'); e.removeAttribute('data-inskit-code'); });
  const inputs = Array.from(document.querySelectorAll('input')).filter((i) => visible(i) && !i.readOnly && !['hidden','checkbox','radio','submit','button','search','image','file'].includes(i.type));
  const describe = (i) => [i.name, i.id, i.autocomplete, i.placeholder, i.getAttribute('aria-label'), ...Array.from(i.labels || []).map((l) => l.innerText)].join(' ');
  const codeBoxes = inputs.filter(i => i.maxLength === 1 && ['text', 'tel', 'number', 'password', ''].includes(i.type));
  const codeField = inputs.find(i => i.autocomplete === 'one-time-code' || (i.type !== 'password' && /c[oó]digo|\bcode\b|\botp\b|token|verifica/i.test(describe(i))));
  const recipePass = pick(opts.password), recipeUser = pick(opts.username), recipeSubmit = pick(opts.submit);
  const pass = codeBoxes.length ? undefined : (recipePass || inputs.find(i => i.type === 'password' && !i.disabled));
  const user = recipeUser || inputs.find(i => i !== pass && !i.disabled && !codeBoxes.includes(i) && i !== codeField && (i.type === 'email' || /\b(username|email)\b/.test(i.autocomplete || '') || (['text', 'tel', ''].includes(i.type) && /user|e-?mail|login|identif|usu[aá]rio|telefone|phone|cpf|celular|account|conta/i.test(describe(i)))));
  const field = codeBoxes[0] || codeField || pass || user;
  const scope = field?.form || field?.closest('form') || field?.closest('[role=dialog]') || field?.closest('main') || document;
  const labelledBy = (b) => (b.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ');
  const label = (b) => (b.innerText || b.value || b.getAttribute('aria-label') || labelledBy(b) || b.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
  const avoid = /google|apple|facebook|microsoft|github|criar|create|cadastr|sign ?up|registr|esqueci|forgot|outro m[eé]todo|other method|another way|trocar|switch|ajuda|help|reenviar|resend|cancel|voltar|back|mostrar|show|exibir|ocultar|hide|passkey|chave de acesso/i;
  const buttons = Array.from(scope.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')).filter((b) => visible(b) && !avoid.test(label(b)));
  const links = Array.from(scope.querySelectorAll('a')).filter((b) => visible(b) && !avoid.test(label(b)));
  const learned = (opts.submitNames || []).map(n => n.toLowerCase());
  const named = /^(continuar|continue|entrar|acessar|avan[cç]ar|pr[oó]ximo|seguinte|next|sign in|signin|log ?in|iniciar sess[aã]o|fazer login|enviar|submit|ok|confirmar|verificar|validar|confirm|verify|ingresar|iniciar sesi[oó]n|siguiente|anmelden|weiter|connexion|se connecter|suivant)( o)?( c[oó]digo| code)?$/i;
  const lone = Array.from(scope.querySelectorAll('button')).filter(visible);
  const submit = recipeSubmit
    || buttons.find(b => learned.includes(label(b).toLowerCase()))
    || buttons.find(b => named.test(label(b)))
    || links.find(b => named.test(label(b)) && scope !== document)
    || buttons.find(b => b.type === 'submit')
    || (lone.length === 1 && !avoid.test(label(lone[0])) ? lone[0] : undefined)
    || Array.from(document.querySelectorAll('button, input[type=submit], [role=button]')).find((b) => visible(b) && !avoid.test(label(b)) && named.test(label(b)));
  // Other controls the form needs (a select, a terms checkbox): a deterministic submit would likely fail.
  const extras = field && field !== codeBoxes[0] && field !== codeField ? Array.from(scope.querySelectorAll('select, input[type=checkbox], input[type=radio]'))
    .filter(e => (e.type === 'checkbox' || e.type === 'radio') ? !/remember|lembr|mant(er|enha)|conectad|keep me|stay (signed|logged)|trust this|confiar neste|mostrar|show/i.test((e.labels?.[0]?.innerText || e.name || e.id || '')) : visible(e)).length : 0;
  if (pass) pass.setAttribute('data-inskit', 'password');
  if (user) user.setAttribute('data-inskit', 'username');
  if (submit) submit.setAttribute('data-inskit', 'submit');
  codeBoxes.forEach((b, n) => b.setAttribute('data-inskit-code', String(n)));
  if (codeField && !codeBoxes.length) codeField.setAttribute('data-inskit-code', '0');
  const alerts = Array.from(document.querySelectorAll('[role=alert], [aria-live=assertive], [aria-invalid=true] ~ *, [class*=error-message], [class*=errorMessage], [class*=--error], [class*=error-text], [class*=alert-danger], [class*=flash], [class*=helper], [id*=error]'))
    .filter(visible).map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 300);
  return {
    password: !!pass, passwordEmpty: !!pass && !pass.value, username: !!user, usernameEmpty: !!user && !user.value,
    submit: submit ? label(submit).slice(0, 80) : '', submitEnabled: !!submit && !submit.disabled && submit.getAttribute('aria-disabled') !== 'true',
    codeFields: codeBoxes.length || (codeField ? 1 : 0), codeEnabled: (codeBoxes[0] || codeField) ? !(codeBoxes[0] || codeField).disabled : false,
    invalid: inputs.some(i => i.getAttribute('aria-invalid') === 'true'), alert: [...new Set(alerts)].join(' · ').slice(0, 200), extras,
  };
}`;

const CLASSIFY = String.raw`(opts) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
  const low = text.toLowerCase();
  const has = (list) => (list || []).find(t => low.includes(String(t).toLowerCase())) || '';
  const sel = (list) => (list || []).some(s => { try { return Array.from(document.querySelectorAll(s)).some(visible); } catch (e) { return false; } });
  const frames = Array.from(document.querySelectorAll('iframe')).filter(visible).map(f => f.src || '');
  // Visible challenge widgets only; the small "protected by reCAPTCHA" badge is not a challenge.
  const captcha = frames.some(s => /recaptcha\/(api2|enterprise)\/(anchor|bframe)|hcaptcha\.com\/.*(checkbox|challenge)|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs|funcaptcha|captcha-delivery/i.test(s))
    || /n[aã]o sou um rob[oô]|i['’]?m not a robot|verify you are human|confirme que voc[eê] [eé] humano|digite os caracteres|enter the characters you see|resolva este quebra-cabe[cç]a|solve this puzzle|press (and|&) hold|security challenge|desafio de seguran[cç]a/i.test(text)
    || !!has(opts.human);
  // The site is working on our submit: fields or the button are disabled, or a loading label shows.
  const creds = Array.from(document.querySelectorAll('input[type=email], input[type=text], input[type=password], input[type=tel], input:not([type])')).filter(visible);
  // Disabled credentials only mean "working" when nothing else is editable (a locked e-mail next to a password box is a normal step 2).
  const busy = (creds.some(i => i.disabled) && !creds.some(i => !i.disabled && !i.readOnly))
    || Array.from(document.querySelectorAll('button, [role=button], input[type=submit]')).some(b => visible(b) && /^(loading|carregando|aguarde|please wait|entrando|signing in)|, loading$/i.test((b.innerText || b.value || b.getAttribute('aria-label') || '').trim()))
    || !!document.querySelector('form[aria-busy=true], [aria-busy=true] input');
  // A sign-up form after we sent the username means the account does not exist.
  // Wording sites use when the account does not exist and they offer to create one.
  const newAccount = /parece que voc[eê] [eé] novo|looks like you(['’]re| are) new|sign up to continue|cadastre-se para continuar|link de inscri[cç][aã]o|n[aã]o (h[aá]|existe) (uma )?conta|no account (found|exists)|we couldn['’]?t find an account/i.test(text);
  // Bot checks that usually clear by themselves after a few seconds.
  const interstitial = /performing security verification|checking your browser|just a moment\.\.\.|verifying you are human|um momento\.\.\.|verificando seu navegador/i.test(text + ' ' + document.title);
  // The site refused this browser outright.
  const blocked = /n[aã]o [eé] poss[ií]vel acessar (a|esta) p[aá]gina|access denied|acesso negado|hubo un error accediendo|you have been blocked|request (was )?blocked|unusual traffic|sorry, you have been blocked|error 1020/i.test(text + ' ' + document.title);
  const signup = newAccount || /sign up for|create (your |an )?account|criar (sua |uma )?conta|cadastre-se|crie sua conta/i.test(text)
    && Array.from(document.querySelectorAll('input')).some(i => visible(i) && /first.?name|last.?name|given|family|nome completo|sobrenome|nome/i.test([i.name, i.id, i.placeholder, i.getAttribute('aria-label'), i.autocomplete].join(' ')));
  const passkey = /use sua chave de acesso|use your passkey|sign in with (a )?passkey|entrar com (a )?chave de acesso/i.test(text);
  const app = !!has(opts.app) || /aprove (a solicita[cç][aã]o|o login|no (seu )?(app|celular|aplicativo))|approve (the )?(sign-?in|request)|check your phone|verifique (o )?seu (celular|smartphone|telefone)/i.test(text);
  const chooser = !!has(opts.chooser) || /escolha (um|como|o) (m[eé]todo|voc[eê] quer)|choose (a |how )?(verification )?(method|you want)|selecione (um|uma) (m[eé]todo|op[cç][aã]o) de verifica|try another way/i.test(text);
  const codeText = !!has(opts.code) || /(insira|digite|informe) o c[oó]digo|enter (the )?(verification |security |one-time )?code|we sent (you )?a code|enviamos um c[oó]digo/i.test(text);
  const rejected = has(opts.rejected) || (text.match(/(senha|e-?mail|usu[aá]rio|password|username|credenciais|credentials)[^.]{0,60}(incorret|inv[aá]lid|errad|wrong|incorrect|not (be )?found|do(es)?n['’]?t match|did not match|do not match|n[aã]o (encontrad|reconhec|existe|correspond|conferem))[^.]{0,80}/i) || [''])[0].slice(0, 160)
    || (text.match(/(n[aã]o encontramos|couldn['’]?t find|we cannot find|no account|conta n[aã]o encontrada|invalid (username|email|login|credentials)|login (failed|failure|inv[aá]lido)|falha (no|de) login|your (username|password) is invalid)[^.]{0,100}/i) || [''])[0].slice(0, 160);
  const logoutLink = Array.from(document.querySelectorAll('a, button, [role=menuitem]')).some(e => /^(sair|logout|log out|sign out|signout|desconectar|encerrar sess[aã]o|cerrar sesi[oó]n)$/i.test((e.innerText || e.getAttribute('aria-label') || '').trim()) || /\/(logout|signout|sign_out|log_out|sair)\b/i.test(e.getAttribute('href') || ''));
  const loggedInSignal = sel(opts.loggedInSelectors) || !!has(opts.loggedInText);
  const loggedOutSignal = sel(opts.loggedOutSelectors) || !!has(opts.loggedOutText);
  return { captcha, passkey, app, chooser, codeText, rejected, logoutLink, loggedInSignal, loggedOutSignal, busy: busy || interstitial, signup, newAccount, interstitial, blocked, textLength: text.trim().length };
}`;

/** Clicks the first preferred verification method on a chooser page. Returns its label or ''. */
const METHOD = String.raw`(prefs) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  document.querySelectorAll('[data-inskit-method]').forEach(e => e.removeAttribute('data-inskit-method'));
  const options = Array.from(document.querySelectorAll('button, [role=button], a, li, label, [role=radio], [role=option]')).filter(visible);
  for (const p of prefs) {
    const el = options.find(o => (o.innerText || '').trim().toLowerCase().startsWith(p.toLowerCase()));
    if (el) { el.setAttribute('data-inskit-method', '1'); return (el.innerText || '').trim().split('\n')[0].slice(0, 60); }
  }
  return '';
}`;

const COOKIES = String.raw`() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none'; };
  document.querySelectorAll('[data-inskit-cookie]').forEach(e => e.removeAttribute('data-inskit-cookie'));
  const accept = /^(accept( all| all cookies| cookies)?|aceitar( todos)?( os)?( cookies)?|aceito|allow( all)?( cookies)?|permitir( todos)?|agree|concordo|ok|entendi|got it|i agree|continuar sem aceitar|accept and continue|aceitar e continuar)$/i;
  // Prefer refusing optional cookies when the banner offers it.
  const reject = /^(reject( all)?( cookies)?|decline( all)?|recusar( todos)?( os)?( cookies)?|rejeitar( todos)?|only (necessary|essential)( cookies)?|apenas (os )?(necess[aá]rios|essenciais)|necessary only|use necessary cookies only)$/i;
  const candidates = Array.from(document.querySelectorAll('button, [role=button], a, input[type=button]'));
  const ordered = candidates.filter(b => reject.test((b.innerText || b.value || '').trim())).concat(candidates);
  for (const b of ordered) {
    const label = (b.innerText || b.value || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!visible(b) || !(accept.test(label) || reject.test(label))) continue;
    let box = b, depth = 0;
    while (box && depth++ < 8 && !/cookie|privacidade|privacy|consent|lgpd|gdpr/i.test(box.innerText || box.id || box.className || '')) box = box.parentElement;
    if (box && depth <= 8) { b.setAttribute('data-inskit-cookie', '1'); return label; }
  }
  return '';
}`;

export const cookiesSource = () => '(' + COOKIES + ')()';

/** Finds and tags login/code fields. Recipe selectors win over heuristics. Returns no field values. */
export const scanSource = (opts: ScanOptions) => call(SCAN, opts);
export const classifySource = (opts: ClassifyOptions) => call(CLASSIFY, opts);
export const methodSource = (prefs: string[]) => call(METHOD, prefs);

