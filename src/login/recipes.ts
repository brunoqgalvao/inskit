import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.ts';
import { hostOf, siteOf } from '../vault.ts';
import type { ClassifyOptions, ScanOptions } from './page-scripts.ts';

/**
 * A tuned deterministic path for one site. Built-ins live here; JSON files in <home>/recipes/
 * add or override them without a release (same id, higher version wins).
 */
export type Recipe = {
  id: string; version: number; sites: string[]; loginUrl?: string;
  username?: string[]; password?: string[]; submit?: string[];
  loggedInSelectors?: string[]; loggedInText?: string[]; loggedOutSelectors?: string[]; loggedOutText?: string[];
  rejected?: string[]; chooser?: string[]; code?: string[]; human?: string[]; app?: string[];
  /** On a verification-method chooser, click the first of these (by visible text prefix). */
  preferMethod?: string[];
  /** URL pattern (regex source) for pages that are still part of signing in. */
  loginPath?: string;
};

export const BUILT_IN: Recipe[] = [
  {
    id: 'mercadolivre', version: 2, sites: ['mercadolivre.com.br', 'mercadolivre.com'],
    loginUrl: 'https://www.mercadolivre.com/jms/mlb/lgz/login?platform_id=ML&go=https%3A%2F%2Fwww.mercadolivre.com.br%2F&loginType=explicit',
    username: ['input[name=user_id]', '#user_id'], password: ['input[name=password]', '#password'],
    chooser: ['Escolha um método de verificação'], code: ['Insira o código'],
    rejected: ['Revise seu e-mail ou telefone', 'Senha incorreta', 'Revise sua senha', 'Não encontramos'],
    loggedOutText: ['Crie a sua conta'], preferMethod: ['E-mail', 'SMS'],
    loginPath: '/jms/mlb/lgz|/login|/challenges|phone-validation|email-validation',
  },
  {
    id: 'amazon', version: 1, sites: ['amazon.com.br', 'amazon.com'],
    loginUrl: 'https://www.amazon.com.br/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com.br%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=brflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0',
    username: ['#ap_email', '#ap_email_login', 'input[name=email]'], password: ['#ap_password', 'input[name=password]'],
    submit: ['input#continue', '#continue input', 'input#signInSubmit', '#signInSubmit'],
    code: ['Verificação em duas etapas', 'Two-Step Verification', 'Insira o OTP', 'Enter OTP'],
    human: ['Digite os caracteres', 'Enter the characters', 'Resolva este quebra-cabeça', 'Solve this puzzle'],
    app: ['Aprove a notificação', 'Approve the notification'],
    rejected: ['Não encontramos uma conta', 'We cannot find an account', 'Parece que você é novo na Amazon', 'Looks like you are new to Amazon', 'Sua senha está incorreta', 'Your password is incorrect'],
    loggedInSelectors: ['#nav-link-accountList'], loggedOutText: ['Olá, faça seu login', 'Hello, sign in'],
    loginPath: '/ap/(signin|mfa|cvf)|/ax/claim',
  },
  {
    id: 'google', version: 1, sites: ['accounts.google.com', 'google.com'],
    loginUrl: 'https://accounts.google.com/signin',
    username: ['#identifierId', 'input[type=email]'], password: ['input[name=Passwd]'],
    submit: ['#identifierNext button', '#passwordNext button'],
    rejected: ['Não foi possível encontrar sua Conta do Google', 'Couldn’t find your Google Account', 'Senha incorreta', 'Wrong password'],
    chooser: ['Escolha como você quer fazer login', 'Choose how you want to sign in'],
    human: ['Este navegador ou app pode não ser seguro', 'This browser or app may not be secure', 'Digite o texto que você ouve ou vê', 'Type the text you hear or see'],
    app: ['Verifique seu smartphone', 'Check your phone', 'Abra o app Gmail', 'Open the Gmail app'],
    code: ['Digite o código', 'Enter the code', 'Receber um código de verificação'],
    loggedInText: [], loginPath: 'accounts\\.google\\.com/(v3/)?signin|ServiceLogin|/challenge',
  },
];

export type LoginPlan = { recipe?: Recipe; scan: ScanOptions; classify: ClassifyOptions; loginPath?: RegExp; preferMethod: string[] };

function userRecipes(home: string): Recipe[] {
  const dir = join(home, 'recipes');
  if (!existsSync(dir)) return [];
  const out: Recipe[] = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try { const r = JSON.parse(readFileSync(join(dir, f), 'utf8')); if (r?.id && Array.isArray(r.sites)) out.push(r); } catch {}
  }
  return out;
}

export function allRecipes(home: string) {
  const byId = new Map<string, Recipe>();
  for (const r of [...BUILT_IN, ...userRecipes(home)]) {
    const prev = byId.get(r.id);
    if (!prev || (r.version ?? 0) >= (prev.version ?? 0)) byId.set(r.id, r);
  }
  return [...byId.values()];
}

export function recipeFor(home: string, url: string) {
  const host = hostOf(url), site = siteOf(host);
  return allRecipes(home).find(r => r.sites.some(s => s === host || s === site || host.endsWith('.' + s)));
}

/** Button names that worked for this site when the model fallback had to step in. */
export function learnedSubmitNames(db: Db, url: string): string[] {
  return db.get<Record<string, string[]>>('login.learned_submit')?.[siteOf(hostOf(url))] ?? [];
}

export function learnSubmitName(db: Db, url: string, name: string) {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean || clean.length < 2) return;
  const all = db.get<Record<string, string[]>>('login.learned_submit') ?? {};
  const site = siteOf(hostOf(url));
  all[site] = [clean, ...(all[site] ?? []).filter(n => n !== clean)].slice(0, 5);
  db.set('login.learned_submit', all);
}

export function planFor(home: string, db: Db, url: string): LoginPlan {
  const recipe = recipeFor(home, url);
  const r = recipe ?? ({} as Partial<Recipe>);
  return {
    recipe,
    scan: { username: r.username, password: r.password, submit: r.submit, submitNames: learnedSubmitNames(db, url) },
    classify: { rejected: r.rejected, chooser: r.chooser, code: r.code, human: r.human, app: r.app,
      loggedInSelectors: r.loggedInSelectors, loggedInText: r.loggedInText, loggedOutSelectors: r.loggedOutSelectors, loggedOutText: r.loggedOutText },
    loginPath: r.loginPath ? new RegExp(r.loginPath, 'i') : undefined,
    preferMethod: r.preferMethod ?? [],
  };
}
