// Verification codes and links in e-mail. Ported unchanged from intinct-clone-jit (src/sms.ts, src/html.ts, src/inbox.ts).

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ccedil: 'ç', atilde: 'ã', otilde: 'õ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', acirc: 'â', ecirc: 'ê', ocirc: 'ô', agrave: 'à' };
export function decodeEntities(s: string) {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string) {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '');
  const meta = (name: string) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i'))?.[1] ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`, 'i'))?.[1];
  const image = meta('og:image');
  const description = meta('og:description') ?? meta('description');
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1].trim()).filter(x => x.length < 6000).slice(0, 3);
  let body = html
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => ` ${inner} (${href}) `)
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/section|\/article|\/header|\/footer)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  body = decodeEntities(body).replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, image, description, ld, body };
}

export const KEYWORD = /(c[oó]d(igo)?|code|senha|token|pin\b|otp|verif|autentic|autoriz|valid|confirm|seguran[cç]a|acesso|login|entrar|cadastr)/i;

/**
 * Verification codes in an SMS, most likely first. Digits only (4 to 8, optionally split by a space or dash, and
 * prefixed like G-123456), skipping money, dates, times, phone numbers and long ids.
 */
export function extractCodes(text: string): string[] {
  // Bank and delivery notices are full of numbers ("cartão final 5959", "pedido 12345"); only messages that talk
  // about a code carry one.
  if (!KEYWORD.test(text)) return [];
  const found: { code: string; score: number; at: number }[] = [];
  const re = /(?<![\w\d.,:\/-])(?:[A-Z]{1,3}-)?(\d{3,4}[ -]\d{3,4}|\d{4,8})(?![\w\d]|[.,:\/-]\d)/g;
  for (const m of text.matchAll(re)) {
    const code = m[1].replace(/[ -]/g, '');
    if (code.length < 4 || code.length > 8) continue;
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 40), at);
    const after = text.slice(at + m[0].length, at + m[0].length + 20);
    if (/R\$\s*$|US\$\s*$/i.test(before) || /^\s*(reais|%)/i.test(after)) continue;
    if (/\b(final|terminad[oa] em|pedido|n[º°o]\.?)\s*$/i.test(before)) continue;
    // Phone numbers: "(11) 4003-1234", "SAC 4003 1234", "0800 723 1234".
    if (/\(\d{2}\)\s*$|\b(tel|telefone|fone|celular|whats\s?app|ligue|sac|central|atendimento)\b[^\d]{0,12}$/i.test(before) || /^0[38]00/.test(code)) continue;
    if (/^(19|20)\d\d$/.test(code) && /\b(de|em|ano)\s*$/i.test(before)) continue;
    let score = 0;
    if (KEYWORD.test(before)) score += 3;
    if (/[:é]\s*$|\bis\s*$/i.test(before)) score += 1;
    if (code.length === 6) score += 1;
    if (KEYWORD.test(after)) score += 1;
    found.push({ code, score, at });
  }
  found.sort((a, b) => b.score - a.score || a.at - b.at);
  return [...new Set(found.map(f => f.code))];
}

const LINK_WORDS = /(verif|confirm|ativa|activat|valid|magic|login|sign-?in|entrar|acess|auth|token|reset|redefin)/i;
const LINK_SKIP = /(unsubscribe|descadastr|opt-?out|privac|preferenc|cancelar-inscri)/i;

/**
 * Codes in an e-mail. The SMS rule (a code word anywhere, then any 4-8 digits) is too loose for mail: bodies nearly
 * always say "acesso" or "login" somewhere, and markup, links and footers carry numbers (color:#333333, tracking ids,
 * ©2026). Read the text without markup or URLs and keep only numbers with a code word right around them; a number
 * that reads as a year needs the word "código"/"code" just before it. Letter codes (Porkbun: "code is: OKTPTQOQNS")
 * count only in capitals right after "código:"/"code is".
 */
export function extractMailCodes(subject: string, body: string): string[] {
  const plain = (/<\/?[a-z][^>]*>/i.test(body) ? htmlToText(body).body : body).replace(/(?:https?:\/\/|mailto:)\S+/gi, ' ');
  const text = `${subject}\n${plain}`;
  const digits = extractCodes(text).filter(code => {
    const year = /^(19[89]\d|20[0-3]\d)$/.test(code);
    const re = new RegExp(`(?<![\\d#])${code.split('').join('[ -]?')}(?!\\d)`, 'g');
    return [...text.matchAll(re)].some(m => {
      const before = text.slice(Math.max(0, m.index - 80), m.index);
      if (year) return /(c[oó]d(igo)?|code|senha|pin|otp|token)[^\d\n]{0,25}$/i.test(before);
      return KEYWORD.test(before) || KEYWORD.test(text.slice(m.index + m[0].length, m.index + m[0].length + 40));
    });
  });
  if (digits.length) return digits;
  const labeled = /(?:c[oó]digo|code|token|senha)\b[^:\n]{0,40}?(?:[:：]|\s(?:é|is))\s*([A-Z0-9]{5,12})(?![\w-])/gi;
  return [...new Set([...text.matchAll(labeled)].map(m => m[1]).filter(t => /[A-Z]/.test(t) && t === t.toUpperCase()))];
}

/** Confirmation, magic-login and reset links in a message, most likely first. */
export function extractLinks(text: string, html?: string | null) {
  const hrefs = html ? [...html.matchAll(/href=["'](https?:\/\/[^"'\s>]+)["']/gi)].map(m => m[1]) : [];
  const found = new Set<string>();
  for (const u of [...hrefs, ...(text.match(/https?:\/\/[^\s<>()"']+/g) ?? [])]) {
    const url = u.replace(/&amp;/g, '&').replace(/[).,;]+$/, '');
    if (LINK_WORDS.test(url) && !LINK_SKIP.test(url)) found.add(url);
  }
  return [...found].slice(0, 3);
}
