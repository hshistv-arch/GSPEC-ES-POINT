// Cloudflare Worker: serves /api/* backed by D1; everything else is static assets.

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
];

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map(sql => env.DB.prepare(sql))).catch(err => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return undefined;
  }
}

// D1 allows 100 bound parameters per statement; 2 per row => 40 rows is safe.
const ROWS_PER_INSERT = 40;

function insertEntryStatements(env, entries) {
  const statements = [];
  for (let i = 0; i < entries.length; i += ROWS_PER_INSERT) {
    const chunk = entries.slice(i, i + ROWS_PER_INSERT);
    const placeholders = chunk.map(() => '(?, ?)').join(', ');
    const params = chunk.flatMap(e => [String(e.id), JSON.stringify(e)]);
    statements.push(env.DB.prepare(`INSERT OR REPLACE INTO entries (id, data) VALUES ${placeholders}`).bind(...params));
  }
  return statements;
}

async function handleEntries(request, env, url) {
  if (request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT data FROM entries').all();
    return json({ entries: results.map(r => JSON.parse(r.data)) });
  }

  if (request.method === 'POST') {
    const entry = await readJson(request);
    if (!entry || !entry.id) return json({ error: 'invalid entry' }, 400);
    await env.DB.batch(insertEntryStatements(env, [entry]));
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'missing id' }, 400);
    await env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  return json({ error: 'method not allowed' }, 405);
}

async function handleConfig(request, env) {
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind('config').first();
    return json({ config: row ? JSON.parse(row.value) : null });
  }

  if (request.method === 'POST') {
    const config = await readJson(request);
    if (!config || !Array.isArray(config.ranks)) return json({ error: 'invalid config' }, 400);
    await env.DB.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
      .bind('config', JSON.stringify(config)).run();
    return json({ ok: true });
  }

  return json({ error: 'method not allowed' }, 405);
}

// One-time bootstrap used to move data over from the old backend.
// Refuses to run once any entry or config exists, so it cannot overwrite live data.
async function handleImport(request, env) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const body = await readJson(request);
  if (!body || !Array.isArray(body.entries)) return json({ error: 'invalid payload' }, 400);
  if (body.entries.some(e => !e || !e.id)) return json({ error: 'entry without id' }, 400);
  if (body.config && !Array.isArray(body.config.ranks)) return json({ error: 'invalid config' }, 400);

  const existingEntries = await env.DB.prepare('SELECT COUNT(*) AS n FROM entries').first();
  const existingConfig = await env.DB.prepare('SELECT COUNT(*) AS n FROM kv WHERE key = ?').bind('config').first();
  if (existingEntries.n > 0 || existingConfig.n > 0) {
    return json({ error: 'already initialized; import is only allowed into an empty database' }, 409);
  }

  const statements = insertEntryStatements(env, body.entries);
  if (body.config) {
    statements.push(env.DB.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
      .bind('config', JSON.stringify(body.config)));
  }
  if (statements.length) await env.DB.batch(statements);

  return json({ ok: true, entries: body.entries.length, config: !!body.config });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      await ensureSchema(env);
      if (url.pathname === '/api/entries') return await handleEntries(request, env, url);
      if (url.pathname === '/api/config') return await handleConfig(request, env);
      if (url.pathname === '/api/import') return await handleImport(request, env);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }
};
