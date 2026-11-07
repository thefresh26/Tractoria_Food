// API única: /api?a=<accion>. Neon por HTTP; clave del panel en ADMIN_PASSWORD (variable de Vercel).
const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const sql = neon(process.env.DATABASE_URL);
const PASS = process.env.ADMIN_PASSWORD || '';
const TEXTOS = ['t_top', 't_nombre1', 't_nombre2', 't_lema', 't_aviso1', 't_aviso2', 't_pie'];
const PUBLICOS = ['nequi', 'wa', 'didi', 'qr', ...TEXTOS];

const sign = (exp) => crypto.createHmac('sha256', PASS).update(String(exp)).digest('hex');
function authed(req) {
  const [exp, sig] = String(req.headers['x-token'] || '').split('.');
  if (!PASS || !exp || !sig || +exp < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const img = (v) => (v == null || v === '' ? null : /^data:image\/(png|jpeg|webp);base64,/.test(v) && v.length < 900000 ? v : undefined);
const plato = (p) => ({ id: String(p.id), name: p.nombre, desc: p.descripcion || '', photo: p.foto, variants: p.variantes, active: p.activo });

async function menu(all) {
  const platos = await sql`SELECT * FROM platos WHERE activo OR ${!!all} ORDER BY orden, id`;
  const aj = await sql`SELECT clave, valor FROM ajustes WHERE clave = ANY(${PUBLICOS})`;
  // El costo solo lo ve la administradora.
  const m = platos.map(plato).map((d) => all ? d : { ...d, variants: d.variants.map(({ cost, ...v }) => v) });
  return { menu: m, settings: Object.fromEntries(aj.map((r) => [r.clave, r.valor])) };
}

const A = {
  async menu(req) { return menu(false); },

  async pedido(req, b) {
    const name = str(b.name, 120), phone = str(b.phone, 20).replace(/\D/g, ''), address = str(b.address, 255), barrio = str(b.barrio, 120);
    const pay = b.pay === 'efectivo' ? 'efectivo' : 'nequi';
    if (name.length < 2 || !/^3\d{9}$/.test(phone) || address.length < 5) throw [400, 'Datos incompletos'];
    if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 20) throw [400, 'Pedido vacío'];
    const proof = pay === 'nequi' ? img(b.proof) : null;
    if (proof === undefined) throw [400, 'Comprobante no válido'];
    // Precios siempre desde la base de datos, nunca desde el navegador.
    const platos = await sql`SELECT * FROM platos WHERE activo`;
    const lineas = b.lines.map((l) => {
      const p = platos.find((x) => String(x.id) === String(l.d));
      const v = p && p.variantes.find((x) => x.id === l.v);
      const q = Math.floor(+l.q);
      if (!v || !(q >= 1 && q <= 40)) throw [400, 'Plato no disponible'];
      return { n: p.nombre, l: v.label, q, p: v.price, c: Number.isFinite(v.cost) ? v.cost : null };
    });
    const total = lineas.reduce((s, l) => s + l.p * l.q, 0);
    const cash = pay === 'efectivo' ? Math.floor(+b.cash) : null;
    if (pay === 'efectivo' && !(cash >= total && cash < 10000000)) throw [400, 'Indica con cuánto vas a pagar'];
    const [r] = await sql`INSERT INTO pedidos (nombre, celular, direccion, barrio, referencia, pago, paga_con, comprobante, notas, lineas, total)
      VALUES (${name}, ${phone}, ${address}, ${barrio}, ${str(b.ref, 255) || null}, ${pay}, ${cash}, ${proof}, ${str(b.notes, 500) || null}, ${JSON.stringify(lineas)}, ${total})
      RETURNING id, extract(epoch from creado)*1000 AS ts`;
    return { id: r.id, ts: +r.ts, lines: lineas };
  },

  async login(req, b) {
    if (!PASS || typeof b.password !== 'string' || b.password !== PASS) { await new Promise((r) => setTimeout(r, 800)); throw [401, 'Contraseña incorrecta']; }
    const exp = Date.now() + 30 * 864e5;
    return { token: exp + '.' + sign(exp) };
  },

  // ── solo vendedora ──
  async panel() {
    const rows = await sql`SELECT id, extract(epoch from creado)*1000 AS ts, nombre, celular, direccion, barrio, referencia, pago, paga_con, notas, estado, lineas, comprobante IS NOT NULL AS tiene
      FROM pedidos WHERE creado > now() - interval '32 days' ORDER BY id`;
    return { orders: rows.map((o) => ({ num: o.id, ts: +o.ts, name: o.nombre, phone: o.celular, address: o.direccion, barrio: o.barrio, ref: o.referencia || '', pay: o.pago, cash: o.paga_con, notes: o.notas || '', st: o.estado, lines: o.lineas, proof: o.tiene })),
      ...(await menu(true)) };
  },
  async estado(req, b) {
    const st = Math.floor(+b.st);
    if (!(st >= 0 && st <= 3)) throw [400, 'Estado no válido'];
    await sql`UPDATE pedidos SET estado = ${st} WHERE id = ${+b.id}`;
    return {};
  },
  async comprobante(req, b) {
    const [r] = await sql`SELECT comprobante FROM pedidos WHERE id = ${+b.id}`;
    return { proof: r ? r.comprobante : null };
  },
  async plato(req, b) {
    const name = str(b.name, 120), desc = str(b.desc, 500), photo = img(b.photo);
    if (name.length < 2 || photo === undefined) throw [400, 'Datos del plato no válidos'];
    const vs = (Array.isArray(b.variants) ? b.variants : []).slice(0, 10)
      .map((v, i) => ({ id: str(v.id, 40) || 'v' + i, label: str(v.label, 60), price: Math.floor(+v.price),
        cost: v.cost === '' || v.cost == null || !(+v.cost >= 0) ? null : Math.min(Math.floor(+v.cost), 9999999) }))
      .filter((v) => v.price > 0 && v.price < 10000000);
    if (!vs.length) throw [400, 'Falta el precio'];
    const active = b.active !== false;
    if (b.id) {
      await sql`UPDATE platos SET nombre=${name}, descripcion=${desc}, foto=${photo}, variantes=${JSON.stringify(vs)}, activo=${active} WHERE id=${+b.id}`;
      return { id: String(b.id) };
    }
    const [r] = await sql`INSERT INTO platos (nombre, descripcion, foto, variantes, orden, activo)
      VALUES (${name}, ${desc}, ${photo}, ${JSON.stringify(vs)}, (SELECT coalesce(max(orden),0)+1 FROM platos), ${active}) RETURNING id`;
    return { id: String(r.id) };
  },
  async borrarpedido(req, b) { await sql`DELETE FROM pedidos WHERE id = ${+b.id}`; return {}; },
  async borrar(req, b) { await sql`DELETE FROM platos WHERE id = ${+b.id}`; return {}; },
  async ajustes(req, b) {
    for (const [k, v] of Object.entries(b || {})) {
      if (!PUBLICOS.includes(k)) continue;
      const val = k === 'qr' ? img(v) : str(v, 300);
      if (val === undefined) throw [400, 'Imagen no válida'];
      await sql`INSERT INTO ajustes (clave, valor) VALUES (${k}, ${val}) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`;
    }
    return {};
  },
};
const PUBLIC = ['menu', 'pedido', 'login'];

module.exports = async (req, res) => {
  // CORS: permite que la copia en GitHub Pages use esta API.
  const origin = req.headers.origin || '';
  if (/^https:\/\/thefresh26\.github\.io$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  const a = req.query.a;
  try {
    if (!A[a]) throw [404, 'No existe'];
    if (!PUBLIC.includes(a) && !authed(req)) throw [401, 'Sesión vencida'];
    if (a !== 'menu' && req.method !== 'POST') throw [405, 'Usa POST'];
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const out = await A[a](req, body);
    res.setHeader('Cache-Control', a === 'menu' ? 's-maxage=5, stale-while-revalidate=30' : 'no-store');
    res.status(200).json(out);
  } catch (e) {
    const [code, msg] = Array.isArray(e) ? e : [500, 'Error del servidor'];
    if (!Array.isArray(e)) console.error(e);
    res.status(code).json({ error: msg });
  }
};
