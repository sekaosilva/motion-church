// Bônus do Motion Church: motions e contagens regressivas, liberados para quem tem a colaboração em dia.
// Cada vídeo é publicado trancado (AES-256-CTR, chave só dele). No catálogo público, a chave de cada vídeo vai
// cifrada com a chave pública do bônus (RSA-OAEP); só este serviço tem a privada (segredo BONUS_PRIV).
// O programa manda o código de colaborador e o computador; se o código vale (assinado pelo gerador do
// administrador ou pelo pagamento automático), não venceu e é deste computador, devolve a chave.
//
// POST /bonus/chave {codigo, maq, cifrada} → {chave, iv}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ', BASE_DIA = Date.UTC(2024, 0, 1), DIA = 86400000;
const hex = h => new Uint8Array(String(h).match(/../g).map(x => parseInt(x, 16)));
const tohex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const b64 = s => Uint8Array.from(atob(String(s)), c => c.charCodeAt(0));
function deB32(t) { t = String(t || '').toUpperCase().replace(/^MC-/, '').replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1'); let bits = 0, val = 0; const out = []; for (const ch of t) { const i = B32.indexOf(ch); if (i < 0) return null; val = (val << 5) | i; bits += 5; if (bits >= 8) { bits -= 8; out.push((val >> bits) & 255); } } return new Uint8Array(out); }

// o código de colaborador vale? (mesma regra do programa)
export async function codigoValido(codigo, maq, pubs, agora) {
  const b = deB32(codigo), m = deB32(maq);
  if (!b || b.length < 75 || b[0] !== 2 || !m || m.length !== 5) return null;
  const dados = b.subarray(0, b.length - 64), sig = b.subarray(b.length - 64);
  const msg = new Uint8Array(5 + dados.length); msg.set(new TextEncoder().encode('MCLIC')); msg.set(dados, 5);
  let ok = false;
  for (const p of pubs) {
    try { const k = await crypto.subtle.importKey('raw', hex(p), { name: 'Ed25519' }, false, ['verify']); if (await crypto.subtle.verify({ name: 'Ed25519' }, k, sig, msg)) { ok = true; break; } } catch (_) {}
  }
  if (!ok) return null;
  const vence = (dados[1] << 8) | dados[2], ate = vence === 0xffff ? null : BASE_DIA + (vence + 1) * DIA;
  if (ate != null && (agora || Date.now()) >= ate) return { vencido: true };
  for (let i = 0; i < 5; i++) if (dados[5 + i] !== m[i]) return { outroComputador: true };
  return { ok: true, ate };
}

let chavePriv = null;
async function privada(env) {
  if (!chavePriv) chavePriv = await crypto.subtle.importKey('pkcs8', b64(env.BONUS_PRIV), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  return chavePriv;
}

export async function bonusChave(req, env, json) {
  if (!env.BONUS_PRIV) return json({ erro: 'O bônus ainda não está ligado.' }, 503);
  let b; try { b = await req.json(); } catch (_) { return json({ erro: 'pedido inválido' }, 400); }
  const pubs = String(env.LIC_PUBS || '').split(',').map(s => s.trim()).filter(s => /^[0-9a-f]{64}$/.test(s));
  const v = await codigoValido(b && b.codigo, b && b.maq, pubs);
  if (!v) return json({ erro: 'Código de colaborador inválido.' }, 403);
  if (v.vencido) return json({ erro: 'A colaboração venceu. Renove para baixar o bônus.' }, 403);
  if (v.outroComputador) return json({ erro: 'Este código é de outro computador.' }, 403);
  try {
    const t = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, await privada(env), b64(b.cifrada));
    const s = new TextDecoder().decode(t), [chave, iv] = s.split(':');
    if (!/^[0-9a-f]{64}$/.test(chave) || !/^[0-9a-f]{32}$/.test(iv)) throw new Error('formato');
    return json({ chave, iv });
  } catch (_) { return json({ erro: 'Arquivo do bônus desconhecido.' }, 400); }
}
export { tohex };
