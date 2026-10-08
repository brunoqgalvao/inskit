// Keeps secrets out of everything the model reads: page snapshots, page text and tool results.

export const HIDDEN = '[hidden by vault]';

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function luhnValid(digits: string) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Finds card-like digit runs (13–19 digits, optionally separated by spaces, dots or dashes). */
export function containsCardNumber(text: string) {
  for (const match of text.matchAll(/(?:\d[ .-]?){12,18}\d/g)) {
    if (luhnValid(match[0].replace(/\D/g, ''))) return true;
  }
  return false;
}

const SENSITIVE_FIELD = /(cart[aã]o|card|cvv|cvc|c[oó]d(igo)?\.? ?(de )?seguran[cç]a|security code|senha|password|passcode|validade|vencimento|expira|expiry|expiration|cpf|ssn)/i;

export class Redactor {
  private values = new Set<string>();
  private shortValues = new Set<string>();

  /** Register a secret that was typed into a page. Short values (CVV) are only hidden inside form fields. */
  add(secret: string) {
    const value = secret.trim();
    if (!value) return;
    if (value.length < 6) { this.shortValues.add(value); return; }
    this.values.add(value);
    const digits = value.replace(/\D/g, '');
    if (digits.length >= 6 && digits.length === value.replace(/[\s.-]/g, '').length) {
      this.values.add(digits);
      this.values.add(digits.replace(/(\d{4})(?=\d)/g, '$1 '));
      this.values.add(digits.replace(/(\d{4})(?=\d)/g, '$1-'));
    }
  }

  redact(text: string) {
    let out = text;
    for (const value of [...this.values].sort((a, b) => b.length - a.length)) {
      out = out.replace(new RegExp(escape(value), 'g'), HIDDEN);
    }
    // Any card number visible anywhere.
    out = out.replace(/(?:\d[ .-]?){12,18}\d/g, m => (luhnValid(m.replace(/\D/g, '')) ? HIDDEN : m));
    // CPF keeps only the last two digits.
    out = out.replace(/\b\d{3}\.\d{3}\.\d{3}-(\d{2})\b/g, '***.***.***-$1');
    // Values of sensitive form fields in aria snapshots: `textbox "Card number" [ref=e4]: 4111...`
    out = out.split('\n').map(line => {
      const m = line.match(/^(\s*- (?:textbox|combobox|spinbutton)\b[^:]*?(?:"([^"]*)")?[^:"]*):\s*(.+)$/);
      if (!m) return line;
      const value = m[3].trim();
      if ((m[2] && SENSITIVE_FIELD.test(m[2]) && value) || this.shortValues.has(value)) return `${m[1]}: ${HIDDEN}`;
      return line;
    }).join('\n');
    return out;
  }
}

