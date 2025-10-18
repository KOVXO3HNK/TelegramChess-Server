import express from 'express';
import cors from 'cors';
import TelegramBot from 'node-telegram-bot-api';
import crypto from 'crypto';

// --------- config via ENV ----------
// BOT_TOKEN is required; the server will exit if it's not provided.
const BOT_TOKEN = process.env.BOT_TOKEN;

// ALLOWED_ORIGINS — comma-separated list of allowed origins for CORS. Use '*' to allow any.
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';

// Determine port: parse process.env.PORT to a number; fallback to 8080 if not set or invalid.
const port = Number(process.env.PORT) || 8080;

if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN is not set');
  process.exit(1);
}

// Create Telegram bot in polling mode. Long polling will be used unless a webhook is configured.
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Optionally delete any existing webhook to prevent conflicts when using long polling.
// The method name is deleteWebHook (capital H) in node-telegram-bot-api.
bot.deleteWebHook()
  .then(() => console.log('Webhook deleted (if any)'))
  .catch(err => console.error('Failed to delete webhook', err));

const app = express();
app.use(express.json());
app.use(cors({
  origin: (origin, cb) => {
    if (
      !origin ||
      ALLOWED_ORIGINS === '*' ||
      ALLOWED_ORIGINS.split(',').map(s => s.trim()).includes(origin)
    ) {
      return cb(null, true);
    }
    cb(new Error('Not allowed by CORS'));
  }
}));

// --------- in-memory matchmaking data ---------
const queue = new Map();   // userId -> { id, name, rating, ts }
const matches = new Map(); // userId -> { opponent: { id, name, rating } }

// Helper to find the best opponent by rating difference.
function findBestOpponent(my) {
  let bestId = null;
  let bestDiff = Infinity;
  for (const [id, u] of queue) {
    if (id === my.id) continue;
    const diff = Math.abs((u.rating ?? 1500) - (my.rating ?? 1500));
    if (diff < bestDiff) {
      bestDiff = diff;
      bestId = id;
    }
  }
  return bestId ? queue.get(bestId) : null;
}

// (Optional) verification of initData from Telegram WebApps. Recommended for production.
function verifyInitData(initData) {
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');
    const dataCheckString = [...urlParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(crypto.createHash('sha256').update(BOT_TOKEN).digest())
      .digest();
    const hmac = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');
    return hmac === hash;
  } catch {
    return false;
  }
}

// --------- HTTP API for the frontend ---------
// Endpoint to add a player to the matchmaking queue and attempt to find a match.
app.post('/match', (req, res) => {
  const { id, name, rating, initData } = req.body || {};

  // Uncomment the following lines to verify initData in production.
  // if (!verifyInitData(initData)) {
  //   return res.status(403).json({ error: 'bad initData' });
  // }

  if (!id) return res.status(400).json({ error: 'id required' });

  queue.set(String(id), {
    id: String(id),
    name,
    rating: Number(rating) || 1500,
    ts: Date.now(),
  });

  const me = queue.get(String(id));
  const opponent = findBestOpponent(me);
  if (opponent) {
    // Remove both players from the queue and create a match.
    queue.delete(String(id));
    queue.delete(String(opponent.id));

    const a = { id: me.id, name: me.name, rating: me.rating };
    const b = { id: opponent.id, name: opponent.name, rating: opponent.rating };

    matches.set(me.id, { opponent: b });
    matches.set(opponent.id, { opponent: a });

    // Notify players via Telegram (optional but helpful).
    bot.sendMessage(a.id, `Matched vs ${b.name} (${b.rating})`);
    bot.sendMessage(b.id, `Matched vs ${a.name} (${a.rating})`);

    return res.json({ matched: true, opponent: b });
  }

  // No match found; keep the player in the queue.
  res.json({ matched: false });
});

// Endpoint to check if a match has been found for a given player.
app.get('/match/:id', (req, res) => {
  const id = String(req.params.id);
  const m = matches.get(id);
  if (m) {
    matches.delete(id);
    return res.json({ matched: true, opponent: m.opponent });
  }
  res.json({ matched: false });
});

// --------- Telegram WebApp data handler (if using sendData) ---------
bot.on('message', async (msg) => {
  if (!msg?.web_app_data?.data) return;
  let payload;
  try {
    payload = JSON.parse(msg.web_app_data.data);
  } catch {
    return;
  }

  if (payload.action === 'findOpponent') {
    const { id, name, rating } = payload;
    queue.set(String(id), {
      id: String(id),
      name,
      rating: Number(rating) || 1500,
      ts: Date.now(),
    });

    const me = queue.get(String(id));
    const opponent = findBestOpponent(me);
    if (opponent) {
      queue.delete(String(id));
      queue.delete(String(opponent.id));

      const a = { id: me.id, name: me.name, rating: me.rating };
      const b = { id: opponent.id, name: opponent.name, rating: opponent.rating };

      matches.set(me.id, { opponent: b });
      matches.set(opponent.id, { opponent: a });

      await bot.sendMessage(a.id, JSON.stringify({ action: 'matched', opponent: b }));
      await bot.sendMessage(b.id, JSON.stringify({ action: 'matched', opponent: a }));
    } else {
      await bot.sendMessage(msg.chat.id, 'Searching for opponent…');
    }
  }
});

// --------- start the server ---------
app.listen(port, () => {
  console.log(`Server is running on :${port}`);
});
