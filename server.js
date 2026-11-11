// PayAgent v2: guided AI shopping (questions -> ranked picks) + PayPal sandbox (create, capture, status, refund).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { openDB } from './db.js';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const l of fs.readFileSync(path.join(__dir, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const PORT = process.env.PORT || 3000;
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
const PP = process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const P = (sku, name, price, cat, colors, emoji, rating, features, tags = '') => ({ sku, name, price, cat, colors, emoji, rating, features, tags: `${cat} ${tags}` });
const CATALOG = [
  P('hoodie', 'Developer Hoodie', 45, 'clothing', ['Black', 'Grey', 'Navy'], '🧥', 4.7, ['Heavyweight cotton', 'Kangaroo pocket', 'Unisex fit'], 'hoodie sweatshirt wear jacket'),
  P('tshirt', 'Code Tee', 22, 'clothing', ['Black', 'White', 'Navy'], '👕', 4.4, ['Soft combed cotton', 'Pre-shrunk', 'Minimal print'], 'tshirt shirt tee wear'),
  P('cap', 'Dev Cap', 16, 'clothing', ['Black', 'Navy'], '🧢', 4.2, ['Adjustable strap', 'Embroidered logo', 'Breathable'], 'cap hat wear'),
  P('mug', 'Debug Coffee Mug', 12.5, 'drinkware', ['White', 'Black'], '☕', 4.6, ['350 ml ceramic', 'Dishwasher safe', 'Heat-proof handle'], 'mug coffee cup tea kitchen gift'),
  P('bottle', 'Steel Water Bottle', 24, 'drinkware', ['Black', 'Silver', 'Blue'], '🍶', 4.5, ['Keeps cold 24h', 'Leak-proof lid', '750 ml'], 'bottle water flask gym'),
  P('keyboard', 'Mechanical Keyboard', 89, 'desk', ['Black', 'White'], '⌨️', 4.8, ['Hot-swap switches', 'RGB backlight', 'USB-C'], 'keyboard typing computer setup'),
  P('mouse', 'Wireless Mouse', 27, 'desk', ['Black', 'White', 'Grey'], '🖱️', 4.3, ['2.4G + Bluetooth', '6 month battery', 'Silent clicks'], 'mouse computer setup'),
  P('lamp', 'Desk LED Lamp', 29.99, 'desk', ['White', 'Black'], '💡', 4.5, ['3 colour modes', 'Touch dimmer', 'Eye-care light'], 'lamp light led study setup'),
  P('stand', 'Laptop Stand', 34, 'desk', ['Silver', 'Black'], '💻', 4.6, ['Aluminium', 'Adjustable height', 'Folds flat'], 'laptop stand ergonomic setup'),
  P('notebook', 'Dot-Grid Notebook', 9.5, 'stationery', ['Black', 'Blue', 'Red'], '📓', 4.5, ['120 gsm paper', 'Lay-flat binding', '192 pages'], 'notebook journal paper study gift'),
  P('stickers', 'Sticker Pack (20)', 8, 'stationery', ['Multi'], '✨', 4.1, ['Waterproof vinyl', '20 designs', 'Laptop safe'], 'stickers laptop gift'),
  P('backpack', 'Laptop Backpack', 59, 'bags', ['Black', 'Grey', 'Navy'], '🎒', 4.7, ['Fits 16" laptop', 'Water resistant', 'USB charge port'], 'backpack bag travel college'),
];
const ALL_COLORS = ['Black', 'White', 'Grey', 'Navy', 'Silver', 'Blue', 'Red'];
const orders = new Map();
const store = await openDB(path.join(__dir, 'data'));
try { for (const o of store.loadOrders()) orders.set(o.id, o); } catch (e) { console.error('Could not load orders:', e.message); }
const saveOrders = () => { try { store.saveOrders([...orders.values()]); } catch (e) { console.error('Could not save orders:', e.message); } };
store.cleanSessions(); setInterval(() => store.cleanSessions(), 36e5).unref();
const clampScore = v => { const n = Math.round(+v); return n >= 50 && n <= 99 ? n : undefined; };
const productCache = new Map(); // live (Channel3) products by sku, so checkout can price them server-side

// ---------- PayPal ----------
async function ppToken() {
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: sec } = process.env;
  if (!id || !sec) throw new Error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env');
  const r = await fetch(PP + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json();
  if (!r.ok) throw new Error('PayPal auth failed: ' + JSON.stringify(j));
  return j.access_token;
}
async function pp(p, method = 'GET', body) {
  const t = await ppToken();
  const r = await fetch(PP + p, {
    method,
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', 'PayPal-Request-Id': randomUUID() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`PayPal ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}

// ---------- Tools (shared by the guided UI and the chat agent) ----------
const tools = {
  search_products({ query = '' }) {
    const q = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const hits = CATALOG.filter(p => !q.length || q.some(w => (p.name + ' ' + p.tags).toLowerCase().includes(w)));
    return (hits.length ? hits : CATALOG).map(({ sku, name, price, cat, colors }) => ({ sku, name, price, cat, colors }));
  },
  async create_checkout({ items, budget_usd, uid }) {
    const user = uid ? store.userById(uid) : null;
    if (!user) return { error: 'Please sign in to check out.' };
    if (!user.address?.line1) return { error: 'Please add your shipping address in Account before checking out.' };
    if (user.budget > 0) {
      const spent = [...orders.values()].filter(o => o.userId === user.id && o.status === 'COMPLETED').reduce((a, o) => a + o.total, 0);
      const rem = +(user.budget - spent).toFixed(2);
      if (rem <= 0) return { error: `Budget guardian: your monthly limit of $${user.budget} is used up.` };
      budget_usd = budget_usd ? Math.min(budget_usd, rem) : rem;
    }
    const lines = [];
    for (const it of items || []) {
      const p = CATALOG.find(c => c.sku === it.sku) || productCache.get(it.sku);
      if (!p) return { error: `Unknown sku ${it.sku}` };
      lines.push({ ...p, qty: Math.max(1, Math.min(10, it.qty || 1)) });
    }
    if (!lines.length) return { error: 'No items' };
    const total = +lines.reduce((s, l) => s + l.price * l.qty, 0).toFixed(2);
    if (budget_usd && total > budget_usd) return { error: `Blocked by budget guardrail: total $${total} exceeds budget $${budget_usd}.` };
    const t = total.toFixed(2);
    const o = await pp('/v2/checkout/orders', 'POST', {
      intent: 'CAPTURE',
      purchase_units: [{
        description: 'PayAgent order',
        amount: { currency_code: 'USD', value: t, breakdown: { item_total: { currency_code: 'USD', value: t } } },
        items: lines.map(l => ({ name: l.name, quantity: String(l.qty), unit_amount: { currency_code: 'USD', value: l.price.toFixed(2) } })),
      }],
      payment_source: { paypal: { experience_context: { brand_name: 'PayAgent', user_action: 'PAY_NOW', return_url: BASE + '/return', cancel_url: BASE + '/?cancelled=1' } } },
    });
    const link = (o.links || []).find(l => ['payer-action', 'approve'].includes(l.rel))?.href;
    orders.set(o.id, { id: o.id, userId: user.id, shipTo: { name: user.name, phone: user.phone, address: user.address }, items: lines.map(l => ({ sku: l.sku, name: l.name, qty: l.qty, price: l.price })), total, status: o.status, createdAt: Date.now() });
    saveOrders();
    return { order_id: o.id, total_usd: total, status: o.status, approve_url: link };
  },
  async order_status({ order_id, uid }) {
    if (!uid) return { error: 'Please sign in to view orders.' };
    const own = orders.get(order_id);
    if (!own || own.userId !== uid) return { error: 'Order not found on your account.' };
    const o = await pp('/v2/checkout/orders/' + order_id);
    const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
    const rec = orders.get(order_id);
    if (rec) {
      if (cap) rec.captureId = cap.id;
      rec.status = /REFUND/.test(cap?.status || '') ? 'REFUNDED' : (cap?.status === 'COMPLETED' ? 'COMPLETED' : o.status);
      saveOrders();
    }
    return { order_id, status: o.status, capture_id: cap?.id, capture_status: cap?.status, items: rec?.items, total: rec?.total, display_status: rec?.status, shipTo: rec?.shipTo };
  },
  async refund_order({ order_id, reason, uid }) {
    if (!uid) return { error: 'Please sign in to refund an order.' };
    if (orders.get(order_id)?.userId !== uid) return { error: 'Order not found on your account.' };
    let capId = orders.get(order_id)?.captureId;
    if (!capId) capId = (await tools.order_status({ order_id, uid })).capture_id;
    if (!capId) return { error: 'Order has not been paid/captured yet, nothing to refund.' };
let r;
try { r = await pp(`/v2/payments/captures/${capId}/refund`, 'POST', { note_to_payer: (reason || 'Refund requested via PayAgent').slice(0, 255) }); }
catch (e) { if (/CAPTURE_FULLY_REFUNDED/.test(e.message)) return { error: 'This order was already refunded.' }; throw e; }    const rrec = orders.get(order_id); if (rrec) { rrec.status = 'REFUNDED'; rrec.refundId = r.id; saveOrders(); }
    return { refund_id: r.id, status: r.status };
  },
};
async function runTool(name, input, ctx) { try { const a = { ...(input || {}) }; if (ctx?.uid) a.uid = ctx.uid; else delete a.uid; return await tools[name](a); } catch (e) { return { error: e.message }; } }

const toolDefs = [
  { name: 'search_products', description: 'Search the store catalog.', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'create_checkout', description: 'Create a PayPal checkout. Pass budget_usd if the user stated a maximum spend.', input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer' } }, required: ['sku'] } }, budget_usd: { type: 'number' } }, required: ['items'] } },
  { name: 'order_status', description: 'Check the status of a PayPal order.', input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } },
  { name: 'refund_order', description: 'Refund a paid order via PayPal.', input_schema: { type: 'object', properties: { order_id: { type: 'string' }, reason: { type: 'string' } }, required: ['order_id'] } },
];
const SYSTEM = `You are PayAgent, a concise shopping and payments agent. Catalog SKUs: ${CATALOG.map(c => `${c.sku} ($${c.price})`).join(', ')}. Use tools to search, create PayPal checkouts, check status and refund. Always pass budget_usd when the user states a budget. After create_checkout, show the total and approve_url as a plain link. Never invent order IDs.`;

// ---------- AI helpers ----------
function providers() {
  const e = process.env, p = [];
  if (e.AI_API_KEY) p.push({ name: 'Groq', kind: 'openai', base: e.AI_BASE_URL || 'https://api.groq.com/openai/v1', key: e.AI_API_KEY, model: e.AI_MODEL });
  if (e.GEMINI_API_KEY) p.push({ name: 'Gemini', kind: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: e.GEMINI_API_KEY, model: e.GEMINI_MODEL || 'gemini-2.0-flash' });
  if (e.OPENROUTER_API_KEY) p.push({ name: 'OpenRouter', kind: 'openai', base: 'https://openrouter.ai/api/v1', key: e.OPENROUTER_API_KEY, model: e.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free' });
  if (e.ANTHROPIC_API_KEY) p.push({ name: 'Claude', kind: 'anthropic', key: e.ANTHROPIC_API_KEY, model: CLAUDE_MODEL });
  return p;
}
const hasAI = () => providers().length > 0;
let lastAI = '';
async function oaiPost(p, body) {
  const r = await fetch(p.base + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + p.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: p.model, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p.name} ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
async function claudePost(p, body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: p.model, max_tokens: 1024, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Claude ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
// Multi-model router: tries each configured AI in order and fails over on errors or rate limits.
async function askAI(system, user) {
  for (const p of providers()) {
    try {
      const out = p.kind === 'anthropic'
        ? (await claudePost(p, { system, messages: [{ role: 'user', content: user }] })).content?.filter(b => b.type === 'text').map(b => b.text).join('\n')
        : (await oaiPost(p, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })).choices?.[0]?.message?.content;
      if (out) { lastAI = p.name; return out; }
    } catch (e) { console.error('AI provider failed, trying next:', e.message); }
  }
  return null;
}
function parseJSON(t) { try { const m = t && t.match(/[\[{][\s\S]*[\]}]/); return m ? JSON.parse(m[0]) : null; } catch { return null; } }

// ---------- Guided flow ----------
const BUDGET_Q = { id: 'budget', q: 'What is your budget?', options: ['Under $25', '$25 to $60', '$60 and up', 'No limit'] };
const COLOR_Q = { id: 'colour', q: 'Which colour do you prefer?', options: [...ALL_COLORS.slice(0, 6), 'Any'] };
const PRIORITY_Q = { id: 'priority', q: 'What matters most to you?', options: ['Best value', 'Premium quality', 'Highest rated', 'Most useful daily'] };

async function questionsFor(need) {
  let extra = null;
  if (hasAI()) {
    const t = await askAI('You are a shopping assistant. Output ONLY a JSON array of exactly 2 multiple-choice questions as [{"id":"q1","q":"...","options":["...","...","..."]}]. Each has 3 or 4 short options. Ask about use case, style or priority relevant to what the customer wants. Do NOT ask about budget or colour.', `Customer wants: ${need}`);
    const j = parseJSON(t);
    if (Array.isArray(j)) extra = j.filter(x => x && x.q && Array.isArray(x.options) && x.options.length >= 2).slice(0, 2).map((x, i) => ({ id: 'x' + i, q: String(x.q), options: x.options.slice(0, 4).map(String) }));
  }
  return [BUDGET_Q, COLOR_Q, ...(extra && extra.length ? extra : [PRIORITY_Q])];
}
function parseBudget(a) {
  const n = (a || '').match(/\d+/g)?.map(Number) || [];
  if (/under/i.test(a)) return { max: n[0] };
  if (/and up|\+/i.test(a)) return { min: n[0] };
  if (n.length === 2) return { min: n[0], max: n[1] };
  return {};
}
async function recommendCatalog(need, answers) {
  const words = need.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  let pool = CATALOG.filter(p => words.some(w => (p.name + ' ' + p.tags).toLowerCase().includes(w.replace(/s$/, ''))));
  if (!pool.length) pool = CATALOG;
  const b = parseBudget(answers.budget);
  const colour = answers.colour && answers.colour !== 'Any' ? answers.colour : null;
  const byBudget = l => l.filter(p => (b.max == null || p.price <= b.max) && (b.min == null || p.price >= b.min));
  const byColour = l => (colour ? l.filter(p => p.colors.includes(colour)) : l);
  let c = byColour(byBudget(pool));
  if (!c.length) c = byBudget(pool);
  if (!c.length) c = byColour(pool);
  if (!c.length) c = pool;
  const prio = Object.entries(answers).filter(([k]) => k !== 'budget' && k !== 'colour').map(([, v]) => v).join(' ').toLowerCase();
  const sorted = [...c].sort((x, y) => /value|cheap|afford/.test(prio) ? x.price - y.price : /premium|quality/.test(prio) ? y.price - x.price : y.rating - x.rating);
  let picks = sorted.slice(0, 3).map(p => ({ ...p, why: `Fits your ${answers.budget || 'budget'}${colour ? ' and ' + colour.toLowerCase() + ' choice' : ''}; rated ${p.rating}/5.` }));
  if (hasAI() && sorted.length > 1) {
    const cand = sorted.slice(0, 8).map(p => ({ sku: p.sku, name: p.name, price: p.price, rating: p.rating, features: p.features }));
    const t = await askAI('You are a shopping assistant. From the candidates, pick the best 3 (or fewer) for the customer. Output ONLY JSON: [{"sku":"...","why":"one friendly sentence under 20 words","score":85}] where score is your match percentage 60-99. Use only given skus.', `Customer wants: ${need}\nAnswers: ${JSON.stringify(answers)}\nCandidates: ${JSON.stringify(cand)}`);
    const j = parseJSON(t);
    if (Array.isArray(j)) {
      const ai = j.map(x => { const p = c.find(q => q.sku === x?.sku); return p && { ...p, why: String(x.why || picks[0].why).slice(0, 160), score: clampScore(x.score) }; }).filter(Boolean).slice(0, 3);
      if (ai.length) picks = ai;
    }
  }
  return { picks, budget_max: b.max || null, no_match: typeof matched !== 'undefined' ? !matched : false, source: 'catalog' };
}


// ---------- Live online product search (Channel3) ----------
function normC3(p) {
  const offers = p.offers || [];
  const get = x => ({ price: +(typeof x.price === 'object' ? x.price?.price : x.price), cur: typeof x.price === 'object' ? x.price?.currency : x.currency });
  const o = offers.find(x => { const g = get(x); return g.price > 0 && (!g.cur || g.cur === 'USD'); });
  if (!o) return null;
  const desc = (p.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const feats = desc.split(/(?<=[.!?])\s+/).filter(t => t.length > 8 && t.length < 140).slice(0, 3);
  const brand = p.brands?.[0]?.name || p.brand?.name || p.brand_name;
  if (brand) feats.unshift('Brand: ' + brand);
  const img = (p.images || []).find(i => i.is_cleaned_image) || (p.images || [])[0];
  return { sku: 'c3_' + p.id, name: String(p.title || 'Product').slice(0, 90), price: get(o).price, image: img?.url || null, url: o.url || null, merchant: o.merchant_domain || o.domain || '', features: feats.slice(0, 3), colors: [], rating: null, emoji: '🛍️' };
}
async function liveRecommend(need, answers) {
  const b = parseBudget(answers.budget);
  const colour = answers.colour && answers.colour !== 'Any' ? answers.colour : '';
  let q = await askAI('Turn the customer request into ONE short product search query (max 8 words, no quotes). Output only the query.', `Wants: ${need}\nAnswers: ${JSON.stringify(answers)}`);
  q = (q || `${colour} ${need}`).replace(/["\n]/g, ' ').trim().slice(0, 100);
  const call = async filters => {
    const r = await fetch('https://api.trychannel3.com/v1/search', { method: 'POST', headers: { 'x-api-key': process.env.CHANNEL3_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, limit: 20, ...(filters ? { filters } : {}) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Channel3 ' + r.status + ': ' + JSON.stringify(j).slice(0, 200));
    return j.products || [];
  };
  const f = {};
  if (b.min != null || b.max != null) f.price = { ...(b.min != null ? { min_price: b.min } : {}), ...(b.max != null ? { max_price: b.max } : {}) };
  let raw; try { raw = await call(Object.keys(f).length ? f : null); } catch (e) { console.error(e.message); raw = await call(null); }
  const items = raw.map(normC3).filter(Boolean).filter(p => (b.max == null || p.price <= b.max) && (b.min == null || p.price >= b.min));
  console.log('Channel3: query=%s raw=%d usable=%d', q, raw.length, items.length);
  if (!items.length) return { fail: `Channel3 returned ${raw.length} products, ${items.length} usable for query "${q}". Sample offer: ${JSON.stringify(raw[0]?.offers?.[0] ?? raw[0] ?? null).slice(0, 350)}` };
  items.forEach(p => productCache.set(p.sku, p));
  let picks = items.slice(0, 3).map(p => ({ ...p, why: `Matches "${q}" at $${p.price.toFixed(2)}${p.merchant ? ' from ' + p.merchant : ''}.` }));
  if (hasAI() && items.length > 3) {
    const cand = items.slice(0, 10).map(p => ({ sku: p.sku, name: p.name, price: p.price, features: p.features }));
    const j = parseJSON(await askAI('You are a shopping assistant. Pick the best 3 for the customer. Output ONLY JSON: [{"sku":"...","why":"one friendly sentence under 20 words","score":85}] where score is your match percentage 60-99. Use only given skus.', `Customer wants: ${need}\nAnswers: ${JSON.stringify(answers)}\nCandidates: ${JSON.stringify(cand)}`));
    if (Array.isArray(j)) {
      const ai = j.map(x => { const p = items.find(q => q.sku === x?.sku); return p && { ...p, why: String(x.why || '').slice(0, 160) || picks[0].why, score: clampScore(x.score) }; }).filter(Boolean).slice(0, 3);
      if (ai.length) picks = ai;
    }
  }
  return { picks, budget_max: b.max || null, source: 'live', query: q };
}
async function recommendRaw(need, answers) {
  if (process.env.CHANNEL3_API_KEY) {
    let note = '';
    try { const r = await liveRecommend(need, answers); if (r && !r.fail) return r; note = r?.fail || 'no results'; } catch (e) { note = e.message; console.error('Live search failed, using catalog:', e.message); }
    const out = await recommendCatalog(need, answers); out.live_note = note.replace(process.env.CHANNEL3_API_KEY, '***'); return out;
  }
  const out = await recommendCatalog(need, answers); out.live_note = 'CHANNEL3_API_KEY not loaded by the server'; return out;
}

async function recommend(need, answers) {
  const r = await recommendRaw(need, answers);
  (r.picks || []).forEach((p, i) => { if (!p.score) p.score = [94, 89, 84][i] || 80; });
  return r;
}

// ---------- Chat agent (status / refund / free-form) ----------
async function chatWith(p, messages, ctx) {
  if (p.kind === 'anthropic') {
    const msgs = messages.map(m => ({ role: m.role, content: m.content }));
    for (let i = 0; i < 6; i++) {
      const j = await claudePost(p, { system: SYSTEM, tools: toolDefs, messages: msgs });
      msgs.push({ role: 'assistant', content: j.content });
      if (j.stop_reason !== 'tool_use') return j.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const results = [];
      for (const b of j.content.filter(b => b.type === 'tool_use')) results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(await runTool(b.name, b.input, ctx)) });
      msgs.push({ role: 'user', content: results });
    }
    return 'Sorry, I could not finish that.';
  }
  const msgs = [{ role: 'system', content: SYSTEM }, ...messages.map(m => ({ role: m.role, content: m.content }))];
  const oaTools = toolDefs.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  for (let i = 0; i < 6; i++) {
    const m = (await oaiPost(p, { messages: msgs, tools: oaTools })).choices[0].message;
    msgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
    if (!m.tool_calls?.length) return m.content || '';
    for (const c of m.tool_calls) {
      let args = {}; try { args = JSON.parse(c.function.arguments || '{}'); } catch {}
      msgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(await runTool(c.function.name, args, ctx)) });
    }
  }
  return 'Sorry, I could not finish that.';
}
async function agentChat(messages, ctx) {
  let last;
  for (const p of providers()) { try { const r = await chatWith(p, messages, ctx); lastAI = p.name; return r; } catch (e) { last = e; console.error('Chat provider failed, trying next:', e.message); } }
  throw last || new Error('No AI configured');
}
async function demoChat(messages, ctx) {
  const text = messages[messages.length - 1].content.toLowerCase();
  const id = (text.match(/\b[0-9A-Z]{17}\b/i) || [])[0]?.toUpperCase();
  if (/refund/.test(text) && id) { const r = await runTool('refund_order', { order_id: id }, ctx); return r.error ? '⚠️ ' + r.error : `✅ Refund ${r.refund_id} is ${r.status}.`; }
  if (/status|paid/.test(text) && id) { const r = await runTool('order_status', { order_id: id }, ctx); return r.error ? '⚠️ ' + r.error : `Order ${id}: ${r.status}${r.capture_status ? ' (payment ' + r.capture_status + ')' : ''}`; }
  return 'Demo mode (no AI key). Use the shopping flow above, or type "status ORDERID" / "refund ORDERID".';
}


function smallTalk(t) {
  const s = t.trim().toLowerCase().replace(/[!?.,]+/g, '').replace(/\s+/g, ' ');
  if (/^(hi+|hello+|hey+|heyy+|yo|hola|namaste|sup|hi there|hey there|good (morning|afternoon|evening))$/.test(s)) return "Hi there! 👋 I'm PayAgent. Tell me what you'd like to buy, for example “a black pen under $10” or “a gift for a coder”, and I'll find the best options for you.";
  if (/^(thanks|thank you|thx|ok|okay|cool|nice|great|bye|good bye)$/.test(s)) return "You're welcome! 😊 Tell me anything else you'd like to shop for.";
  if (/^(help|who are you|what can you do|what do you do|how does this work|how are you|how are you doing)$/.test(s)) return "I'm PayAgent, an AI shopping assistant. Tell me what you want, answer a few quick questions, and I'll find the best products online and let you pay securely with PayPal (sandbox demo). What would you like to buy?";
  if (s.length < 2) return 'What would you like to buy? Try “wireless headphones” or “running shoes”.';
  return null;
}

// ---------- Auth ----------
const hashPw = pw => { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(pw, salt, 64).toString('hex'); };
const checkPw = (pw, stored) => { try { const [salt, h] = String(stored).split(':'); const a = Buffer.from(h, 'hex'), b = scryptSync(pw, salt, 64); return a.length === b.length && timingSafeEqual(a, b); } catch { return false; } };
const sha = t => createHash('sha256').update(t).digest('hex');
const cookieOf = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const pub = u => u && { id: u.id, name: u.name, email: u.email, phone: u.phone, address: u.address || {}, budget: u.budget || 0, isDemo: !!u.isDemo };
function getUser(req) { const t = cookieOf(req).pa_sid; if (!t) return null; const s = store.session(sha(t)); if (!s || s.expires < Date.now()) return null; return store.userById(s.userId); }
function startSession(res, userId) { const t = randomBytes(32).toString('hex'); store.addSession(sha(t), userId, Date.now() + 7 * 864e5); res.setHeader('Set-Cookie', `pa_sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${BASE.startsWith('https') ? '; Secure' : ''}`); }
const clean = (v, n) => String(v ?? '').trim().slice(0, n);
function validProfile(b, isNew) {
  const name = clean(b.name, 80), email = clean(b.email, 120).toLowerCase(), phone = clean(b.phone, 25), a = b.address || {};
  const address = { line1: clean(a.line1, 120), city: clean(a.city, 60), state: clean(a.state, 60), postal: clean(a.postal, 15), country: clean(a.country, 60) };
  if (name.length < 2) return { error: 'Please enter your full name.' };
  if (isNew && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'Please enter a valid email address.' };
  if (!/^\+?[0-9 ()-]{7,20}$/.test(phone)) return { error: 'Please enter a valid phone number (7 to 15 digits).' };
  if (!address.line1 || !address.city || !address.postal || !address.country) return { error: 'Please complete your shipping address (street, city, postal code and country).' };
  if (isNew && String(b.password || '').length < 8) return { error: 'Password must be at least 8 characters.' };
  return { name, email, phone, address };
}
const authHits = new Map();
function authRateOk(ip) { const now = Date.now(); const h = authHits.get(ip) || { n: 0, t: now }; if (now - h.t > 60000) { h.n = 0; h.t = now; } h.n++; authHits.set(ip, h); return h.n <= 20; }

// ---------- HTTP ----------
const hits = new Map();
function rateOk(ip) { const now = Date.now(); const h = hits.get(ip) || { n: 0, t: now }; if (now - h.t > 60000) { h.n = 0; h.t = now; } h.n++; hits.set(ip, h); return h.n <= 90; }
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  const readBody = async () => { let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e6) throw new Error('Request too large'); } return raw ? JSON.parse(raw) : {}; };
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const me = getUser(req);
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (url.pathname === '/health') return send(200, { ok: true });
    if (url.pathname.startsWith('/api/') && !rateOk(ip)) return send(429, { error: 'Too many requests, please slow down for a moment.' });
    if (url.pathname.startsWith('/api/auth/') && !authRateOk(ip)) return send(429, { error: 'Too many attempts, please wait a minute.' });
    if (url.pathname === '/api/me') return send(200, { user: pub(me) });
    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const b = await readBody(); const v = validProfile(b, true); if (v.error) return send(400, v);
      if (store.userByEmail(v.email)) return send(409, { error: 'An account with this email already exists. Please sign in.' });
      const u = { id: randomUUID(), email: v.email, name: v.name, phone: v.phone, address: v.address, hash: hashPw(String(b.password)), budget: 0, createdAt: Date.now() };
      try { store.addUser(u); } catch { return send(409, { error: 'An account with this email already exists. Please sign in.' }); }
      startSession(res, u.id); return send(200, { user: pub(u) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const b = await readBody(); const u = store.userByEmail(clean(b.email, 120).toLowerCase());
      if (!u || !checkPw(String(b.password || ''), u.hash)) return send(401, { error: 'Incorrect email or password.' });
      startSession(res, u.id); return send(200, { user: pub(u) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/demo') {
      const id = randomUUID();
      const u = { id, email: `demo-${id.slice(0, 8)}@payagent.demo`, name: 'Demo Shopper', phone: '+1 555 010 0199', address: { line1: '1 Market Street', city: 'San Francisco', state: 'CA', postal: '94105', country: 'United States' }, hash: hashPw(randomBytes(12).toString('hex')), budget: 0, createdAt: Date.now(), isDemo: true };
      store.addUser(u); startSession(res, u.id); return send(200, { user: pub(u) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const t = cookieOf(req).pa_sid; if (t) store.delSession(sha(t));
      res.setHeader('Set-Cookie', 'pa_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); return send(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/profile') {
      if (!me) return send(401, { error: 'Please sign in.' });
      const b = await readBody();
      if (b.budget !== undefined) me.budget = Math.max(0, Math.min(100000, +b.budget || 0));
      if (b.name !== undefined) { const v = validProfile({ ...b, email: me.email }, false); if (v.error) return send(400, v); Object.assign(me, { name: v.name, phone: v.phone, address: v.address }); }
      store.saveUser(me); return send(200, { user: pub(me) });
    }
    if (url.pathname === '/api/orders') { const list = me ? [...orders.values()].filter(o => o.userId === me.id).sort((a, b) => b.createdAt - a.createdAt) : []; return send(200, { orders: list, signedIn: !!me }); }
    if (req.method === 'POST' && url.pathname === '/api/questions') { const { need } = await readBody(); const talk = smallTalk(String(need || '')); if (talk) return send(200, { chat: true, reply: talk }); return send(200, { questions: await questionsFor(String(need || '')), ai: hasAI(), providers: providers().map(p => p.name) }); }
    if (req.method === 'POST' && url.pathname === '/api/recommend') { const { need, answers } = await readBody(); return send(200, await recommend(String(need || ''), answers || {})); }
    if (req.method === 'POST' && url.pathname === '/api/checkout') { const { sku, qty, budget_usd } = await readBody(); if (!me) return send(401, { error: 'Please sign in to check out.' }); return send(200, await runTool('create_checkout', { items: [{ sku, qty: qty || 1 }], budget_usd }, { uid: me.id })); }
    if (req.method === 'POST' && url.pathname === '/api/refund') { const { order_id } = await readBody(); return send(200, await runTool('refund_order', { order_id }, { uid: me?.id })); }
    if (req.method === 'POST' && url.pathname === '/api/status') { const { order_id } = await readBody(); return send(200, await runTool('order_status', { order_id }, { uid: me?.id })); }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const { messages } = await readBody(); const ctx = { uid: me?.id };
      let reply = null;
      if (hasAI()) { try { reply = await agentChat(messages, ctx); } catch (e) { console.error(e.message); } }
      if (reply == null) reply = await demoChat(messages, ctx);
      return send(200, { reply, mode: hasAI() ? 'ai' : 'demo', provider: lastAI || null });
    }
    if (url.pathname === '/api/catalog') return send(200, CATALOG);
    if (url.pathname === '/return') {
      const id = url.searchParams.get('token');
      try {
        const c = await pp(`/v2/checkout/orders/${id}/capture`, 'POST');
        const cap = c.purchase_units?.[0]?.payments?.captures?.[0];
        if (orders.has(id)) { Object.assign(orders.get(id), { status: c.status, captureId: cap?.id, paidAt: Date.now() }); saveOrders(); }
      } catch (e) { console.error(e.message); }
      res.writeHead(302, { Location: `/?paid=${id}` }); return res.end();
    }
    const f = path.join(__dir, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
    if (f.startsWith(path.join(__dir, 'public')) && fs.existsSync(f) && fs.statSync(f).isFile()) return send(200, fs.readFileSync(f), mime[path.extname(f)] || 'application/octet-stream');
    send(404, { error: 'not found' });
  } catch (e) { send(500, { error: e.message }); }
}).listen(PORT, () => console.log(`PayAgent running at ${BASE} (${hasAI() ? 'AI mode' : 'demo mode'})`));
