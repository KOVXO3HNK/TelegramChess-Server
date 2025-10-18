import express from 'express';
import cors from 'cors';
import TelegramBot from 'node-telegram-bot-api';
import crypto from 'crypto';

// --------- конфиг через ENV ----------
const {
  BOT_TOKEN,              // токен бота @BotFather
  PORT = 8080,            // порт HTTP
  ALLOWED_ORIGINS = '*'   // CORS: список доменов через запятую
} = process.env;

if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN is not set');
  process.exit(1);
}

// В простоте используем long-polling. Для prod лучше webhook.
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const app = express();
app.use(express.json());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS === '*' || ALLOWED_ORIGINS.split(',').map(s => s.trim()).includes(origin)) {
      return cb(null, true);
    }
    cb(new Error('Not allowed by CORS'));
  }
}));

// --------- в памяти: очередь и активные матчи ----------
const queue = new Map();     // userId -> { id, name, rating, ts }
const matches = new Map();   // userId -> { opponent: { id, name, rating } }

// Утилита подбора ближайшего по рейтингу
function findBestOpponent(my) {
  let bestId = null;
  let bestDiff = Infinity;
  for (const [id, u] of queue) {
    if (id === my.id) continue;
    const diff = Math.abs((u.rating ?? 1500) - (my.rating ?? 1500));
    if (diff < bestDiff) { bestDiff = diff; bestId = id; }
  }
  return bestId ? queue.get(bestId) : null;
}

// (Опционально) проверка подписи initData из Telegram WebApp
// Рекомендуется ПЕРЕД тем как добавлять пользователя в очередь!
function verifyInitData(initData) {
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');
    const dataCheckString = [...urlParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(crypto.createHash('sha256').update(BOT_TOKEN).digest())
      .digest();

    const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return hmac === hash;
  } catch {
    return false;
  }
}

// --------- HTTP API для фронтенда ----------
app.post('/match', (req, res) => {
  const { id, name, rating, initData } = req.body || {};

  // (Опционально) в проде лучше включить:
  // if (!verifyInitData(initData)) return res.status(403).json({ error: 'bad initData' });

  if (!id) return res.status(400).json({ error: 'id required' });

  // Добавляем в очередь/обновляем
  queue.set(String(id), { id: String(id), name, rating: Number(rating) || 1500, ts: Date.now() });

  // Ищем лучшего по рейтингу
  const me = queue.get(String(id));
  const opponent = findBestOpponent(me);
  if (opponent) {
    // матч найден
    queue.delete(String(id));
    queue.delete(String(opponent.id));

    const a = { id: me.id, name: me.name, rating: me.rating };
    const b = { id: opponent.id, name: opponent.name, rating: opponent.rating };

    matches.set(me.id, { opponent: b });
    matches.set(opponent.id, { opponent: a });

    // Уведомим через Telegram (не обязательно, но полезно)
    bot.sendMessage(a.id, `Matched vs ${b.name} (${b.rating})`);
    bot.sendMessage(b.id, `Matched vs ${a.name} (${a.rating})`);

    return res.json({ matched: true, opponent: b });
  }
  res.json({ matched: false });
});

app.get('/match/:id', (req, res) => {
  const id = String(req.params.id);
  const m = matches.get(id);
  if (m) {
    matches.delete(id);
    return res.json({ matched: true, opponent: m.opponent });
  }
  res.json({ matched: false });
});

// --------- обработка web_app_data от клиента (если используете sendData) ----------
bot.on('message', async (msg) => {
  if (!msg?.web_app_data?.data) return;
  let payload;
  try { payload = JSON.parse(msg.web_app_data.data); } catch { return; }

  if (payload.action === 'findOpponent') {
    const { id, name, rating } = payload;
    queue.set(String(id), { id: String(id), name, rating: Number(rating) || 1500, ts: Date.now() });

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

app.listen(PORT, () => console.log(`Server is running on :${PORT}`));
