import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const keys = await kv.keys('entry:*');
      const entries = keys.length ? await kv.mget(...keys) : [];
      return res.status(200).json({ entries: entries.filter(Boolean) });
    }

    if (req.method === 'POST') {
      const entry = req.body;
      if (!entry || !entry.id) return res.status(400).json({ error: 'invalid entry' });
      await kv.set(`entry:${entry.id}`, entry);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'missing id' });
      await kv.del(`entry:${id}`);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
