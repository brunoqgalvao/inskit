import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentInbox, type InboxMessage } from '../src/inbox.ts';
import { extractLinks, extractMailCodes } from '../src/mail-codes.ts';

const meli = (over: Partial<InboxMessage> = {}): InboxMessage => ({
  id: 'm_1', to: 'agente@inbox.example', from: 'no-reply@mercadolivre.com', fromName: 'Mercado Livre', subject: 'Confirme seu e-mail',
  text: 'Olá! Use o código 482913 para confirmar seu e-mail no Mercado Livre. Ele vale por 10 minutos.\nSeu pedido 2000012345678 vai para o CEP 04510-001. Dúvidas: (11) 4003-1234.\nNão quer mais receber? https://www.mercadolivre.com.br/unsubscribe?u=1',
  html: '', receivedAt: Date.now() - 30_000, ...over,
});

function fakeInbox(box: InboxMessage[], seen: string[] = []) {
  const fetcher = (async (url: URL, init: RequestInit) => {
    seen.push(String((init.headers as Record<string, string>).authorization));
    const since = Number(url.searchParams.get('since'));
    return new Response(JSON.stringify({ messages: box.filter(m => m.receivedAt >= since).sort((a, b) => b.receivedAt - a.receivedAt) }));
  }) as unknown as typeof fetch;
  return new AgentInbox({ url: 'https://inbox.example', token: 'tok', address: 'agente@inbox.example' }, fetcher);
}

test('mail extraction keeps the code and the confirmation link, drops order numbers, phones and unsubscribe links', () => {
  const m = meli();
  assert.deepEqual(extractMailCodes(m.subject, m.text), ['482913']);
  const html = '<p>Confirme sua conta</p><a href="https://www.amazon.com.br/ap/verify?token=abc&amp;x=1">Confirmar</a> <a href="https://www.amazon.com.br/gp/unsubscribe?u=2">Sair da lista</a>';
  assert.deepEqual(extractLinks('Confirme sua conta', html), ['https://www.amazon.com.br/ap/verify?token=abc&x=1']);
});

test('inbox_read filters by sender, waits for late mail and returns one full message by id', async () => {
  const seen: string[] = [];
  const box = [meli(), meli({ id: 'm_2', from: 'news@loja.com', fromName: 'Loja', subject: 'Ofertas', text: 'Promo 50% off' })];
  const inbox = fakeInbox(box, seen);
  const out = await inbox.read({ match: 'Mercado Livre' });
  assert.match(out, /Codes: 482913/);
  assert.doesNotMatch(out, /Ofertas/);
  assert.ok(seen.every(h => h === 'Bearer tok'));
  assert.match(await inbox.read({ match: 'amazon' }), /^No mail matching "amazon"/);
  setTimeout(() => box.push(meli({ id: 'm_3', from: 'conta@amazon.com.br', fromName: 'Amazon', subject: 'Seu código', text: 'Seu código de verificação é 739214', receivedAt: Date.now() })), 500);
  const late = await inbox.read({ match: 'amazon', wait_seconds: 10 });
  assert.match(late, /Codes: 739214/);
  assert.match(await inbox.read({ id: 'm_1' }), /pedido 2000012345678/);
  await assert.rejects(() => inbox.read({ id: 'm_404' }));
});

test('without a configured mailbox the tools say so instead of inventing an address', async () => {
  const inbox = new AgentInbox(undefined);
  assert.throws(() => inbox.address, /no mailbox/);
  await assert.rejects(() => inbox.read({}), /no mailbox/);
});

