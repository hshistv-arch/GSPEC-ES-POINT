import { kv } from '@vercel/kv';

const CONFIG_KEY = 'config';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const config = await kv.get(CONFIG_KEY);
      return res.status(200).json({ config: config || null });
    }

    if (req.method === 'POST') {
      const config = req.body;
      if (!config || !Array.isArray(config.ranks)) return res.status(400).json({ error: 'invalid config' });
      await kv.set(CONFIG_KEY, config);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
