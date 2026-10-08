// Model fallback: a fast inner model operates the login page one action at a time.
// It only sees redacted snapshots and names a field to fill; secrets go page-ward through the vault.

export type ModelName = 'luna' | 'haiku';

/**
 * The inner model available on this machine, if any: luna needs an OpenAI-compatible Responses endpoint
 * (INSKIT_LUNA_BASE_URL, e.g. a local router), haiku needs ANTHROPIC_API_KEY. Nothing is assumed by default.
 */
export function configuredModel(preferred?: string): ModelName | undefined {
  if (preferred === 'luna' && process.env.INSKIT_LUNA_BASE_URL) return 'luna';
  if (preferred === 'haiku' && process.env.ANTHROPIC_API_KEY) return 'haiku';
  if (process.env.INSKIT_LUNA_BASE_URL) return 'luna';
  if (process.env.ANTHROPIC_API_KEY) return 'haiku';
  return undefined;
}
export type Usage = { calls: number; input_tokens: number; output_tokens: number; cost_usd: number };
export type ModelOutcome = 'logged_in' | 'code_requested' | 'method_choice' | 'needs_human' | 'rejected' | 'no_login_form';
type Action = { action: 'fill' | 'click' | 'select' | 'wait' | 'done'; ref?: string; field?: 'username' | 'password'; value?: string; outcome?: ModelOutcome; reason?: string };

const OUTCOMES: ModelOutcome[] = ['logged_in', 'code_requested', 'method_choice', 'needs_human', 'rejected', 'no_login_form'];
const AVOID = /google|apple|facebook|microsoft|github|criar|create|cadastr|sign ?up|registr|esqueci|forgot|reset|comprar|buy|pagar|pay|checkout|excluir|delete/i;

const SYSTEM = [
  'You operate one web login page for a user who already saved their credentials in a vault. You never see the values.',
  'Reply with ONE JSON object and nothing else:',
  '{"action":"fill","ref":"<ref>","field":"username"|"password"} types the saved value into that textbox.',
  '{"action":"click","ref":"<ref>"} clicks a button/link (continue, next, sign in, log in, accept cookies).',
  '{"action":"select","ref":"<ref>","value":"<visible option text>"} picks an option in a combobox (never for credentials). Checkboxes: click them.',
  '{"action":"wait"} waits 2 seconds for the page to react.',
  '{"action":"done","outcome":"<outcome>","reason":"<short>"} when you can tell the result. Outcomes:',
  'logged_in (an authenticated-only signal: logout link, account/profile name, orders, dashboard),',
  'code_requested (one-time code field), method_choice (choose SMS/e-mail/app), needs_human (CAPTCHA, passkey, approve on phone, unusual block),',
  'rejected (site says the account or password is wrong, or the account does not exist and it offers to create one), no_login_form (no way to log in on this page).',
  'Answer done as soon as the page state is clear; do not explore.',
  'Rules: fill username before password when both exist; a password is submitted at most once; never click social login, create account, forgot password, purchase or delete;',
  'if a cookie banner blocks the form, accept it; if the login form is behind a "Sign in"/"Entrar" link, click it. Refs come from the latest snapshot only.',
].join('\n');

/** First complete JSON object in a reply (models sometimes add fences or several actions). */
export function firstJson(text: string): any {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { break; } }
    }
  }
  return undefined;
}

function parse(text: string): Action | undefined {
  return firstJson(text);
}

export async function ask(model: ModelName, user: string, usage: Usage, system = SYSTEM, maxTokens = 200): Promise<string> {
  usage.calls++;
  if (model === 'haiku') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
      // Prefilling '{' makes the reply start as the JSON action instead of prose.
      body: JSON.stringify({ model: process.env.INSKIT_HAIKU_MODEL || 'claude-haiku-4-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }, { role: 'assistant', content: '{' }] }),
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error('Model fallback (haiku) failed: HTTP ' + res.status);
    usage.input_tokens += j.usage?.input_tokens ?? 0; usage.output_tokens += j.usage?.output_tokens ?? 0;
    // Claude Haiku 4.5 list price: $1 / MTok input, $5 / MTok output.
    usage.cost_usd += ((j.usage?.input_tokens ?? 0) * 1 + (j.usage?.output_tokens ?? 0) * 5) / 1e6;
    return '{' + (j.content?.map((c: any) => c.text ?? '').join('') ?? '');
  }
  if (!process.env.INSKIT_LUNA_BASE_URL) throw new Error('No inner model configured (set INSKIT_LUNA_BASE_URL or ANTHROPIC_API_KEY).');
  const base = process.env.INSKIT_LUNA_BASE_URL.replace(/\/+$/, '');
  const res = await fetch(base + '/responses', {
    method: 'POST', signal: AbortSignal.timeout(45_000), headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.INSKIT_LUNA_MODEL || 'gpt-6-luna', instructions: system, reasoning: { effort: 'low' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: user }] }], stream: false }),
  });
  const j: any = await res.json();
  if (!res.ok) throw new Error('Model fallback (luna) failed: HTTP ' + res.status);
  usage.input_tokens += j.usage?.input_tokens ?? 0; usage.output_tokens += j.usage?.output_tokens ?? 0;
  // Routed through the Codex app's ChatGPT subscription: no per-token charge.
  return j.output_text ?? (j.output ?? []).flatMap((o: any) => o.content ?? []).map((c: any) => c.text ?? '').join('');
}

export type ModelIO = {
  snapshot(): Promise<string>;
  fill(ref: string, field: 'username' | 'password'): Promise<void>;
  click(ref: string): Promise<void>;
  select(ref: string, value: string): Promise<void>;
  wait(seconds: number): Promise<void>;
};

export async function runModelDriver(model: ModelName, io: ModelIO, opts: { passwordSent: boolean; context: string; maxActions?: number; budgetMs?: number }) {
  const deadline = Date.now() + (opts.budgetMs ?? 40_000);
  const usage: Usage = { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const steps: string[] = [];
  const trace: { action: string; field?: string; name: string }[] = [];
  let passwordSent = opts.passwordSent, lastFillPassword = false;
  for (let i = 0; i < (opts.maxActions ?? 8) && Date.now() < deadline; i++) {
    const snap = await io.snapshot();
    const prompt = opts.context + '\nActions so far: ' + (steps.join(' → ') || 'none') + (passwordSent ? '\nThe password was already submitted once; do not fill it again.' : '') + '\n\nSnapshot:\n' + snap;
    const a = parse(await ask(model, prompt, usage));
    if (!a) { steps.push('unparseable'); continue; }
    const nameOf = (ref?: string) => (ref && snap.split('\n').find(l => l.includes('[ref=' + ref + ']'))?.match(/"([^"]*)"/)?.[1]) || '';
    if (a.action === 'done') return { outcome: OUTCOMES.includes(a.outcome as ModelOutcome) ? a.outcome! : 'no_login_form', reason: a.reason?.slice(0, 160), steps, usage, trace };
    if (a.action === 'wait') { steps.push('wait'); await io.wait(2); continue; }
    if (!a.ref || !/^(f\d+)?e\d+$/.test(a.ref)) { steps.push('bad ref'); continue; }
    if (a.action === 'fill') {
      const field = a.field === 'password' ? 'password' : 'username';
      if (field === 'password' && passwordSent) return { outcome: 'rejected' as ModelOutcome, reason: 'The site asked for the password again.', steps, usage, trace };
      await io.fill(a.ref, field);
      steps.push(field); trace.push({ action: 'fill', field, name: nameOf(a.ref) });
      lastFillPassword = field === 'password';
      continue;
    }
    if (a.action === 'select' && a.value) { await io.select(a.ref, String(a.value).slice(0, 100)); steps.push('select'); continue; }
    if (a.action === 'click') {
      const name = nameOf(a.ref);
      if (AVOID.test(name)) { steps.push('refused ' + name.slice(0, 30)); continue; }
      await io.click(a.ref);
      steps.push('click ' + name.slice(0, 30)); trace.push({ action: 'click', name });
      if (lastFillPassword) passwordSent = true;
      lastFillPassword = false;
    }
  }
  return { outcome: 'no_login_form' as ModelOutcome, reason: 'No clear result within the fallback budget.', steps, usage, trace };
}
