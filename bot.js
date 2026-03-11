require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mineflayer = require('mineflayer');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const sessions = {};

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = {
      server: null,
      version: null,
      mcBot: null,
      jumpInterval: null,
    };
  }
  return sessions[chatId];
}

function getMainMenu(session) {
  const serverText = session.server
    ? `${session.server.host}:${session.server.port}`
    : '❌ Не указан';
  const versionText = session.version || '❌ Не указана';
  const status = session.mcBot ? '🟢 Онлайн' : '🔴 Оффлайн';

  const text =
    `🤖 *Minecraft Bot*\n\n` +
    `📡 Сервер: \`${serverText}\`\n` +
    `🎮 Версия: \`${versionText}\`\n` +
    `📌 Статус: ${status}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📡 Сервер', callback_data: 'set_server' },
        { text: '🎮 Версия', callback_data: 'set_version' },
      ],
      [
        { text: '▶️ Старт', callback_data: 'start_bot' },
        { text: '⏹ Стоп', callback_data: 'stop_bot' },
      ],
    ],
  };

  return { text, keyboard };
}

function cleanupBot(session) {
  if (session.jumpInterval) {
    clearInterval(session.jumpInterval);
    session.jumpInterval = null;
  }
  session.mcBot = null;
}

// /start
bot.onText(/\/start/, (msg) => {
  const session = getSession(msg.chat.id);
  const { text, keyboard } = getMainMenu(session);
  bot.sendMessage(msg.chat.id, text, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
});

// Кнопки
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const session = getSession(chatId);

  if (query.data === 'set_server') {
    session._waiting = 'server';
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, '📡 Введите адрес сервера:\n`host:port` или просто `host`', {
      parse_mode: 'Markdown',
    });
    return;
  }

  if (query.data === 'set_version') {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, '🎮 Выберите версию:', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '1.8.9', callback_data: 'ver_1.8.9' },
            { text: '1.12.2', callback_data: 'ver_1.12.2' },
            { text: '1.16.5', callback_data: 'ver_1.16.5' },
          ],
          [
            { text: '1.17.1', callback_data: 'ver_1.17.1' },
            { text: '1.18.2', callback_data: 'ver_1.18.2' },
            { text: '1.19.4', callback_data: 'ver_1.19.4' },
          ],
          [
            { text: '1.20.1', callback_data: 'ver_1.20.1' },
            { text: '1.20.4', callback_data: 'ver_1.20.4' },
            { text: '1.21', callback_data: 'ver_1.21' },
          ],
          [
            { text: '🔄 Авто', callback_data: 'ver_auto' },
            { text: '✏️ Ввести вручную', callback_data: 'ver_custom' }
          ],
        ],
      },
    });
    return;
  }

  if (query.data.startsWith('ver_')) {
    const ver = query.data.replace('ver_', '');
    if (ver === 'custom') {
      session._waiting = 'version';
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, '✏️ Введите версию (например `1.19.2`):', {
        parse_mode: 'Markdown',
      });
      return;
    }
    session.version = ver;
    session._waiting = null;
    await bot.answerCallbackQuery(query.id);
    const { text, keyboard } = getMainMenu(session);
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
    return;
  }

  if (query.data === 'start_bot') {
    await bot.answerCallbackQuery(query.id);
    if (session.mcBot) return bot.sendMessage(chatId, '⚠️ Бот уже запущен.');
    if (!session.server) return bot.sendMessage(chatId, '❌ Укажите сервер.');
    if (!session.version) return bot.sendMessage(chatId, '❌ Укажите версию.');

    const name = `Bot_${Math.floor(Math.random() * 10000)}`;
    await bot.sendMessage(chatId, `🔄 Подключаюсь как \`${name}\`...`, { parse_mode: 'Markdown' });

    try {
      console.log(`[${chatId}] Попытка подключения к ${session.server.host}:${session.server.port} (версия: ${session.version})`);
      
      const mcBot = mineflayer.createBot({
        host: session.server.host,
        port: session.server.port,
        username: name,
        version: session.version === 'auto' ? false : session.version,
        auth: 'offline',
        checkTimeoutInterval: 30000, // Увеличиваем таймаут
      });

      session.mcBot = mcBot;

      // Таймер таймаута спавна
      const spawnTimeout = setTimeout(() => {
        if (session.mcBot && !session.mcBot.entity) {
          console.log(`[${chatId}] Тайм-аут ожидания спавна`);
          cleanupBot(session);
          bot.sendMessage(chatId, '❌ Ошибка: Превышено время ожидания подключения (Timeout).');
          try { mcBot.quit(); } catch {}
        }
      }, 40000);

      mcBot.on('login', () => {
        console.log(`[${chatId}] Бот вошел в сеть как ${name}`);
      });

      mcBot.once('spawn', async () => {
        clearTimeout(spawnTimeout);
        console.log(`[${chatId}] Бот заспавнился на сервере`);
        session.jumpInterval = setInterval(() => {
          try {
            mcBot.setControlState('jump', true);
            setTimeout(() => mcBot.setControlState('jump', false), 300);
          } catch {}
        }, 1500);

        const { text, keyboard } = getMainMenu(session);
        await bot.sendMessage(chatId, '✅ Бот подключён и прыгает!');
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
      });

      mcBot.on('kicked', (reason) => {
        clearTimeout(spawnTimeout);
        console.log(`[${chatId}] Бот кикнут: ${reason}`);
        cleanupBot(session);
        bot.sendMessage(chatId, '🚫 Бот кикнут с сервера.');
      });

      mcBot.on('error', (err) => {
        clearTimeout(spawnTimeout);
        console.error(`[${chatId}] Ошибка Mineflayer:`, err);
        cleanupBot(session);
        bot.sendMessage(chatId, `❌ Ошибка: \`${err.message}\``, { parse_mode: 'Markdown' });
      });

      mcBot.on('end', (reason) => {
        clearTimeout(spawnTimeout);
        console.log(`[${chatId}] Соединение разорвано: ${reason}`);
        if (session.mcBot) {
          cleanupBot(session);
          bot.sendMessage(chatId, '🔌 Бот отключён.');
        }
      });

    } catch (err) {
      cleanupBot(session);
      await bot.sendMessage(chatId, `❌ Ошибка: \`${err.message}\``, { parse_mode: 'Markdown' });
    }
    return;
  }

  if (query.data === 'stop_bot') {
    await bot.answerCallbackQuery(query.id);
    if (!session.mcBot) return bot.sendMessage(chatId, '⚠️ Бот не запущен.');
    try { session.mcBot.quit(); } catch {}
    cleanupBot(session);
    const { text, keyboard } = getMainMenu(session);
    await bot.sendMessage(chatId, '✅ Бот остановлен.');
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
    return;
  }
});

// Текстовый ввод
bot.on('message', (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (session._waiting === 'server') {
    let rawInput = msg.text.trim().replace(/^https?:\/\//, '');
    const parts = rawInput.split(':');
    const host = parts[0];
    const port = parts[1] ? parseInt(parts[1]) : 25565;
    if (!host || isNaN(port)) {
      return bot.sendMessage(chatId, '❌ Неверный формат.');
    }
    session.server = { host, port };
    session._waiting = null;
    const { text, keyboard } = getMainMenu(session);
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
    return;
  }

  if (session._waiting === 'version') {
    const ver = msg.text.trim();
    if (!/^\d+\.\d+(\.\d+)?$/.test(ver)) {
      return bot.sendMessage(chatId, '❌ Неверный формат. Пример: `1.20.4`', { parse_mode: 'Markdown' });
    }
    session.version = ver;
    session._waiting = null;
    const { text, keyboard } = getMainMenu(session);
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
    return;
  }
});

console.log('Бот запущен.');
