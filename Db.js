// Storage layer. Uses built-in SQLite (node:sqlite, Node 22.5+) when available, otherwise a JSON-file database.
import fs from 'node:fs';
import path from 'node:path';

export async function openDB(dir) {
  fs.mkdirSync(dir, { recursive: true });
  let DatabaseSync = null;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}
  if (DatabaseSync) {
    try { return sqliteStore(new DatabaseSync(path.join(dir, 'payagent.db'))); } catch (e) { console.error('SQLite unavailable, using JSON store:', e.message); }
  }
  return jsonStore(path.join(dir, 'db.json'));
}

function sqliteStore(db) {
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);`);
  const q = {
    addU: db.prepare('INSERT INTO users(id,email,data) VALUES(?,?,?)'),
    updU: db.prepare('UPDATE users SET data=? WHERE id=?'),
    uE: db.prepare('SELECT * FROM users WHERE email=?'),
    uI: db.prepare('SELECT * FROM users WHERE id=?'),
    addS: db.prepare('INSERT OR REPLACE INTO sessions(token,user_id,expires) VALUES(?,?,?)'),
    gS: db.prepare('SELECT * FROM sessions WHERE token=?'),
    dS: db.prepare('DELETE FROM sessions WHERE token=?'),
    xS: db.prepare('DELETE FROM sessions WHERE expires<?'),
    allO: db.prepare('SELECT data FROM orders'),
    upO: db.prepare('INSERT INTO orders(id,user_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, data=excluded.data'),
  };
  const row = r => r && { ...JSON.parse(r.data), id: r.id, email: r.email };
  const body = u => { const { id, email, ...rest } = u; return JSON.stringify(rest); };
  return {
    kind: 'sqlite',
    addUser: u => { q.addU.run(u.id, u.email, body(u)); },
    saveUser: u => { q.updU.run(body(u), u.id); },
    userByEmail: e => row(q.uE.get(e)),
    userById: id => row(q.uI.get(id)),
    addSession: (token, userId, expires) => { q.addS.run(token, userId, expires); },
    session: token => { const r = q.gS.get(token); return r && { userId: r.user_id, expires: r.expires }; },
    delSession: token => { q.dS.run(token); },
    cleanSessions: () => { q.xS.run(Date.now()); },
    loadOrders: () => q.allO.all().map(r => JSON.parse(r.data)),
    saveOrders: list => { db.exec('BEGIN'); try { for (const o of list) q.upO.run(o.id, o.userId || null, JSON.stringify(o)); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
}

function jsonStore(file) {
  let d = { users: {}, sessions: {}, orders: {} };
  try { d = { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  let t = null;
  const flush = () => { try { fs.writeFileSync(file + '.tmp', JSON.stringify(d)); fs.renameSync(file + '.tmp', file); } catch (e) { console.error('DB write failed', e.message); } };
  const save = () => { clearTimeout(t); t = setTimeout(flush, 150); };
  return {
    kind: 'json',
    addUser: u => { d.users[u.id] = u; save(); },
    saveUser: u => { d.users[u.id] = u; save(); },
    userByEmail: e => Object.values(d.users).find(u => u.email === e) || null,
    userById: id => d.users[id] || null,
    addSession: (token, userId, expires) => { d.sessions[token] = { userId, expires }; save(); },
    session: token => d.sessions[token] || null,
    delSession: token => { delete d.sessions[token]; save(); },
    cleanSessions: () => { for (const k of Object.keys(d.sessions)) if (d.sessions[k].expires < Date.now()) delete d.sessions[k]; save(); },
    loadOrders: () => Object.values(d.orders),
    saveOrders: list => { d.orders = Object.fromEntries(list.map(o => [o.id, o])); save(); },
  };
}
