// Motion Church: pagamento automático da colaboração (Cloudflare Worker).
// A pessoa paga pelo Mercado Pago (Pix ou cartão) e o programa recebe o código de colaborador sozinho.
//
// Segredos (wrangler secret put): MP_TOKEN = Access Token de produção do Mercado Pago;
//   LIC_PRIV = chave Ed25519 do pagamento (pkcs8 em base64). Ela é só deste serviço: não sai da senha de administrador.
// Variáveis: ORIGEM = endereço público deste serviço; MINIMO = valor mínimo (89.90);
//   MP_API = endereço da API do Mercado Pago (só muda nos testes). KV: PEDIDOS.
//
// Caminhos:
//   POST /pedido        {maq, valor, nome}  → cria o pedido e o pagamento no Mercado Pago → {id, url}
//   GET  /pedido/<id>   → {status: aguardando | pago | recusado, codigo?, ate?}  (confere no Mercado Pago a cada consulta)
//   POST /mp            aviso do Mercado Pago (pagamento aprovado) → gera o código na hora
//   GET  /obrigado?p=<id>  página de volta do pagamento
//   POST /ajuda         {p, ctx, v} → {r}  ajuda com IA (ajuda.js; binding AI do Workers AI)
//   POST /bonus/chave   {codigo, maq, cifrada} → {chave, iv}  bônus para colaboradores (bonus.js; BONUS_PRIV, LIC_PUBS)

import { ajuda } from './ajuda.js';
import { bonusChave } from './bonus.js';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ', BASE_DIA = Date.UTC(2024, 0, 1), DIA = 86400000, DIAS = 365;
const enc = new TextEncoder();

function paraB32(b) { let bits = 0, val = 0, s = ''; for (const x of b) { val = (val << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; s += B32[(val >> bits) & 31]; } } if (bits) s += B32[(val << (5 - bits)) & 31]; return s; }
function deB32(t) { t = String(t || '').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1'); let bits = 0, val = 0; const out = []; for (const ch of t) { const i = B32.indexOf(ch); if (i < 0) return null; val = (val << 5) | i; bits += 5; if (bits >= 8) { bits -= 8; out.push((val >> bits) & 255); } } return new Uint8Array(out); }
const maqOk = t => typeof t === 'string' && /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/i.test(t.trim());
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const minimo = env => +(env.MINIMO || 89.9);
const api = env => (env.MP_API || 'https://api.mercadopago.com').replace(/\/$/, '');

// mesmo formato do gerador do administrador (tools/chaves.js): versão 2, vence, emitido, computador, nome + assinatura
async function gerarCodigo(env, nome, maq, hoje) {
  const nb = enc.encode(String(nome || 'Colaborador').trim().slice(0, 60)).subarray(0, 60), mb = deB32(maq);
  if (!mb || mb.length !== 5) throw new Error('computador');
  const d0 = Math.floor((hoje - BASE_DIA) / DIA), vence = d0 + DIAS - 1;
  const dados = new Uint8Array(10 + nb.length), dv = new DataView(dados.buffer);
  dados[0] = 2; dv.setUint16(1, vence); dv.setUint16(3, d0); dados.set(mb, 5); dados.set(nb, 10);
  const key = await crypto.subtle.importKey('pkcs8', b64(env.LIC_PRIV), { name: 'Ed25519' }, false, ['sign']);
  const msg = new Uint8Array(5 + dados.length); msg.set(enc.encode('MCLIC'), 0); msg.set(dados, 5);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, msg));
  const tudo = new Uint8Array(dados.length + 64); tudo.set(dados, 0); tudo.set(sig, dados.length);
  return { codigo: 'MC-' + paraB32(tudo).match(/.{1,5}/g).join('-'), ate: BASE_DIA + (vence + 1) * DIA };
}

async function mp(env, caminho, opt) {
  const r = await fetch(api(env) + caminho, Object.assign({}, opt, { headers: Object.assign({ authorization: 'Bearer ' + env.MP_TOKEN, 'content-type': 'application/json' }, opt && opt.headers) }));
  if (!r.ok) throw new Error('mercado pago ' + r.status);
  return r.json();
}

// pagamento aprovado e com pelo menos o mínimo, em reais, para este pedido
const vale = (env, p, id) => p && p.status === 'approved' && String(p.external_reference) === id && (p.currency_id || 'BRL') === 'BRL' && +p.transaction_amount >= minimo(env) - 0.001;

async function liberar(env, id, ped, pag) {
  if (ped.codigo) return ped;
  // um pagamento libera um código só
  const usado = await env.PEDIDOS.get('pag:' + pag.id);
  if (usado && usado !== id) return ped;
  const nome = ped.nome || [pag.payer && pag.payer.first_name, pag.payer && pag.payer.last_name].filter(Boolean).join(' ') || 'Colaborador';
  const { codigo, ate } = await gerarCodigo(env, nome, ped.maq, Date.now());
  Object.assign(ped, { status: 'pago', codigo, ate, pagamento: String(pag.id), valorPago: +pag.transaction_amount, pagoEm: Date.now() });
  await env.PEDIDOS.put('pag:' + pag.id, id);
  await env.PEDIDOS.put('ped:' + id, JSON.stringify(ped));
  return ped;
}

async function conferir(env, id, ped) {
  if (ped.codigo) return ped;
  const r = await mp(env, '/v1/payments/search?sort=date_created&criteria=desc&external_reference=' + encodeURIComponent(id));
  const l = (r && r.results) || [];
  const ok = l.find(p => vale(env, p, id));
  if (ok) return liberar(env, id, ped, ok);
  const vivo = l.some(p => ['pending', 'in_process', 'authorized', 'in_mediation'].includes(p.status));
  ped.status = !vivo && l.some(p => ['rejected', 'cancelled', 'refunded', 'charged_back'].includes(p.status)) ? 'recusado' : 'aguardando';
  return ped;
}

async function criar(req, env) {
  let b = null; try { b = await req.json(); } catch (_) {}
  if (!b || !maqOk(b.maq)) return json({ erro: 'Código do computador inválido.' }, 400);
  const valor = Math.round(+b.valor * 100) / 100;
  if (!(valor >= minimo(env) - 0.001) || valor > 100000) return json({ erro: 'A colaboração é a partir de R$ ' + minimo(env).toFixed(2).replace('.', ',') + ' por ano.' }, 400);
  const id = [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, '0')).join('');
  const maq = b.maq.trim().toUpperCase().replace(/^(.{4})-?(.{4})$/, '$1-$2');
  const nome = String(b.nome || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60);
  const origem = (env.ORIGEM || new URL(req.url).origin).replace(/\/$/, '');
  const pref = await mp(env, '/checkout/preferences', { method: 'POST', headers: { 'x-idempotency-key': id }, body: JSON.stringify({
    items: [{ id: 'colaboracao', title: 'Colaboração Motion Church (1 ano)', description: 'Uso do Motion Church por um ano no computador ' + maq, quantity: 1, currency_id: 'BRL', unit_price: valor }],
    external_reference: id, notification_url: origem + '/mp',
    back_urls: { success: origem + '/obrigado?p=' + id, pending: origem + '/obrigado?p=' + id, failure: origem + '/obrigado?p=' + id }, auto_return: 'approved',
    statement_descriptor: 'MOTIONCHURCH', metadata: { maq, pedido: id },
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }], installments: 1 }
  }) });
  await env.PEDIDOS.put('ped:' + id, JSON.stringify({ maq, valor, nome, criado: Date.now(), status: 'aguardando' }), { expirationTtl: 60 * 86400 });
  return json({ id, url: pref.init_point });
}

async function consulta(env, id) {
  if (!/^[0-9a-f]{24}$/.test(id)) return json({ erro: 'pedido' }, 404);
  const t = await env.PEDIDOS.get('ped:' + id); if (!t) return json({ erro: 'pedido' }, 404);
  let ped = JSON.parse(t);
  try { ped = await conferir(env, id, ped); } catch (_) {}
  return json(ped.codigo ? { status: 'pago', codigo: ped.codigo, ate: ped.ate } : { status: ped.status || 'aguardando' });
}

// aviso assinado pelo Mercado Pago (x-signature, HMAC-SHA256), quando a chave secreta dos avisos estiver configurada.
// Mesmo sem ela, nada é liberado pelo que vem no aviso: o pagamento é sempre consultado de novo no Mercado Pago.
async function assinaturaOk(req, env, dataId) {
  if (!env.MP_WEBHOOK_SECRET) return true;
  const sig = req.headers.get('x-signature') || '', rid = req.headers.get('x-request-id') || '';
  const partes = Object.fromEntries(sig.split(',').map(x => x.trim().split('=')).filter(x => x.length === 2));
  if (!partes.ts || !partes.v1) return false;
  const manifesto = `id:${String(dataId).toLowerCase()};request-id:${rid};ts:${partes.ts};`;
  const key = await crypto.subtle.importKey('raw', enc.encode(env.MP_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const h = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(manifesto)))].map(x => x.toString(16).padStart(2, '0')).join('');
  if (h.length !== partes.v1.length) return false;
  let d = 0; for (let i = 0; i < h.length; i++) d |= h.charCodeAt(i) ^ partes.v1.charCodeAt(i);
  return d === 0;
}
async function aviso(req, env) {
  const u = new URL(req.url); let b = {}; try { b = await req.json(); } catch (_) {}
  const pid = u.searchParams.get('data.id') || (b && b.data && b.data.id) || (u.searchParams.get('topic') === 'payment' && u.searchParams.get('id'));
  if (!pid || !/^\d{1,20}$/.test(String(pid))) return new Response('ok');
  if (!(await assinaturaOk(req, env, pid))) return new Response('assinatura', { status: 401 });
  try {
    const p = await mp(env, '/v1/payments/' + pid), id = String(p.external_reference || '');
    const t = /^[0-9a-f]{24}$/.test(id) && await env.PEDIDOS.get('ped:' + id);
    if (t && vale(env, p, id)) await liberar(env, id, JSON.parse(t), p);
  } catch (_) {}
  return new Response('ok');
}

async function obrigado(env, id) {
  let ped = null; if (/^[0-9a-f]{24}$/.test(id || '')) { const t = await env.PEDIDOS.get('ped:' + id); if (t) { ped = JSON.parse(t); try { ped = await conferir(env, id, ped); } catch (_) {} } }
  const pago = ped && ped.codigo, ate = pago && new Date(ped.ate - DIA).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const corpo = !ped ? '<h1>Pedido não encontrado</h1><p>Volte ao Motion Church e clique em Seja colaborador.</p>'
    : pago ? `<h1>Obrigado pela colaboração!</h1><p>Pode voltar ao Motion Church: ele já ativa sozinho. A colaboração vale até <b>${esc(ate)}</b> no computador <b>${esc(ped.maq)}</b>.</p><p class="d">Se precisar, este é o seu código de colaborador:</p><code>${esc(ped.codigo)}</code>`
    : ped.status === 'recusado' ? '<h1>O pagamento não foi aprovado</h1><p>Nada foi cobrado. Volte ao Motion Church e tente de novo, com outro cartão ou com Pix.</p>'
    : '<h1>Quase lá</h1><p>Assim que o Mercado Pago confirmar o pagamento, o Motion Church ativa sozinho. Com Pix, costuma levar poucos segundos. Pode voltar ao programa.</p>';
  return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Motion Church · Colaboração</title>${pago ? '' : '<meta http-equiv="refresh" content="6">'}
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080c15;color:#e8ecf4;font:16px/1.5 -apple-system,system-ui,sans-serif;padding:24px;box-sizing:border-box}main{max-width:560px}h1{font-size:26px;margin:0 0 10px}p{color:#aab1c3}.d{margin-top:22px;font-size:14px}code{display:block;background:#12151c;border:1px solid #2a3142;border-radius:10px;padding:12px;font:13px/1.5 ui-monospace,Menlo,monospace;word-break:break-all;color:#fff}b{color:#fff}</style></head><body><main>${corpo}</main></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } });
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url), p = u.pathname;
    try {
      if (req.method === 'POST' && p === '/pedido') return await criar(req, env);
      if (req.method === 'GET' && p.startsWith('/pedido/')) return await consulta(env, p.slice(8));
      if (req.method === 'POST' && p === '/ajuda') return await ajuda(req, env, json);
      if (req.method === 'POST' && p === '/bonus/chave') return await bonusChave(req, env, json);
      if (p === '/mp') return await aviso(req, env);
      if (req.method === 'GET' && p === '/obrigado') return await obrigado(env, u.searchParams.get('p'));
      if (p === '/') return new Response('Motion Church · pagamento automático', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return json({ erro: 'não encontrado' }, 404);
    } catch (e) { return json({ erro: 'Não deu para falar com o Mercado Pago agora. Tente de novo em alguns minutos.' }, 502); }
  }
};
export { gerarCodigo, paraB32, deB32 };
