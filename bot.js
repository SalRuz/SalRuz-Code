require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mineflayer = require('mineflayer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Путь к папке data
const dataDir = '/app/data';
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Путь к базе данных
const dbPath = path.join(dataDir, 'bot.db');

// Создаем базу и таблицы при первом запуске
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка открытия базы данных:', err);
        return;
    }
    console.log('✅ База данных подключена:', dbPath);
    
    // Создаем таблицу сессий
    db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
            chat_id TEXT PRIMARY KEY,
            server_host TEXT,
            server_port INTEGER,
            version TEXT,
            auto_reconnect INTEGER DEFAULT 0
        )
    `, (err) => {
        if (err) {
            console.error('Ошибка создания таблицы:', err);
        } else {
            console.log('✅ Таблица sessions готова');
        }
    });
});

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Хранилище активных сессий в памяти
const sessions = {};

// Загрузка сессии из БД
function loadSessionFromDb(chatId) {
    return new Promise((resolve) => {
        db.get('SELECT * FROM sessions WHERE chat_id = ?', [chatId], (err, row) => {
            if (err || !row) {
                resolve(null);
            } else {
                resolve({
                    server: { host: row.server_host, port: row.server_port },
                    version: row.version,
                    autoReconnect: row.auto_reconnect === 1
                });
            }
        });
    });
}

// Сохранение сессии в БД
function saveSessionToDb(chatId, session) {
    db.run(
        `INSERT OR REPLACE INTO sessions (chat_id, server_host, server_port, version, auto_reconnect) 
         VALUES (?, ?, ?, ?, ?)`,
        [chatId, session.server?.host || null, session.server?.port || null, session.version || null, session.autoReconnect ? 1 : 0],
        (err) => {
            if (err) console.error('Ошибка сохранения сессии:', err);
        }
    );
}

// Удаление сессии из БД
function deleteSessionFromDb(chatId) {
    db.run('DELETE FROM sessions WHERE chat_id = ?', [chatId], (err) => {
        if (err) console.error('Ошибка удаления сессии:', err);
    });
}

// Получение сессии (сначала из памяти, потом из БД)
async function getSession(chatId) {
    if (!sessions[chatId]) {
        const dbSession = await loadSessionFromDb(chatId);
        if (dbSession) {
            sessions[chatId] = {
                server: dbSession.server,
                version: dbSession.version,
                mcBot: null,
                jumpInterval: null,
                autoReconnect: dbSession.autoReconnect || false,
                _waiting: null
            };
        } else {
            sessions[chatId] = {
                server: null,
                version: null,
                mcBot: null,
                jumpInterval: null,
                autoReconnect: false,
                _waiting: null
            };
        }
    }
    return sessions[chatId];
}

function getMainMenu(session) {
    const serverText = session.server
        ? `${session.server.host}:${session.server.port}`
        : '❌ Не указан';
    const versionText = session.version || '❌ Не указана';
    const status = session.mcBot ? '🟢 Онлайн' : '🔴 Оффлайн';
    const reconnectText = session.autoReconnect ? '🔔 ВКЛ' : '🔕 ВЫКЛ';

    const text =
        `🤖 *Minecraft Bot*\n\n` +
        `📡 Сервер: \`${serverText}\`\n` +
        `🎮 Версия: \`${versionText}\`\n` +
        `📌 Статус: ${status}\n` +
        `🔄 Авто-переподключение: ${reconnectText}`;

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
            [
                { text: session.autoReconnect ? '🔔 Откл. авто' : '🔕 Вкл. авто', callback_data: 'toggle_reconnect' },
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

// Функция подключения к серверу
async function connectToServer(chatId, session) {
    if (session.mcBot) {
        console.log(`[${chatId}] Бот уже подключен`);
        return;
    }
    if (!session.server || !session.server.host) {
        console.log(`[${chatId}] Сервер не указан`);
        return;
    }
    if (!session.version) {
        console.log(`[${chatId}] Версия не указана`);
        return;
    }

    const name = `Bot_${Math.floor(Math.random() * 10000)}`;
    console.log(`[${chatId}] Подключение к ${session.server.host}:${session.server.port}, версия: ${session.version}`);

    const mcBot = mineflayer.createBot({
        host: session.server.host,
        port: session.server.port,
        username: name,
        version: session.version === 'auto' ? false : session.version,
        auth: 'offline',
        checkTimeoutInterval: 60000,
        hideErrors: true
    });

    session.mcBot = mcBot;

    // Таймер таймаута спавна
    const spawnTimeout = setTimeout(() => {
        if (session.mcBot && !session.mcBot.entity) {
            console.log(`[${chatId}] Тайм-аут ожидания спавна`);
            cleanupBot(session);
            bot.sendMessage(chatId, '❌ Ошибка: Превышено время ожидания подключения (Timeout).');
            try { mcBot.quit(); } catch {}
            // Если включено авто-переподключение, пробуем снова
            if (session.autoReconnect) {
                setTimeout(() => connectToServer(chatId, session), 10000);
            }
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
        // Авто-переподключение при кике
        if (session.autoReconnect) {
            bot.sendMessage(chatId, '🔄 Попытка переподключения через 10 секунд...');
            setTimeout(() => connectToServer(chatId, session), 10000);
        }
    });

    mcBot.on('error', (err) => {
        clearTimeout(spawnTimeout);
        console.error(`[${chatId}] Ошибка Mineflayer:`, err);
        cleanupBot(session);
        bot.sendMessage(chatId, `❌ Ошибка: \`${err.message}\``);
        // Авто-переподключение при ошибке
        if (session.autoReconnect) {
            bot.sendMessage(chatId, '🔄 Попытка переподключения через 10 секунд...');
            setTimeout(() => connectToServer(chatId, session), 10000);
        }
    });

    mcBot.on('end', (reason) => {
        clearTimeout(spawnTimeout);
        console.log(`[${chatId}] Соединение разорвано: ${reason}`);
        if (session.mcBot) {
            cleanupBot(session);
            bot.sendMessage(chatId, '🔌 Бот отключён.');
            // Авто-переподключение при разрыве
            if (session.autoReconnect) {
                bot.sendMessage(chatId, '🔄 Попытка переподключения через 10 секунд...');
                setTimeout(() => connectToServer(chatId, session), 10000);
            }
        }
    });
}

// /start
bot.onText(/\/start/, async (msg) => {
    const session = await getSession(msg.chat.id);
    const { text, keyboard } = getMainMenu(session);
    bot.sendMessage(msg.chat.id, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
    });
});

// Кнопки
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const session = await getSession(chatId);

    console.log(`[${chatId}] Callback: ${query.data}, сессия: ${JSON.stringify({ server: session.server, version: session.version })}`);

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
        saveSessionToDb(chatId, session);
        const { text, keyboard } = getMainMenu(session);
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
        return;
    }

    if (query.data === 'toggle_reconnect') {
        session.autoReconnect = !session.autoReconnect;
        saveSessionToDb(chatId, session);
        await bot.answerCallbackQuery(query.id, {
            text: session.autoReconnect ? '✅ Авто-переподключение включено' : '❌ Авто-переподключение выключено'
        });
        const { text, keyboard } = getMainMenu(session);
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
        return;
    }

    if (query.data === 'start_bot') {
        await bot.answerCallbackQuery(query.id);

        if (session.mcBot) return bot.sendMessage(chatId, '⚠️ Бот уже запущен.');
        if (!session.server || !session.server.host) {
            return bot.sendMessage(chatId, '❌ Укажите сервер (нажмите 📡 Сервер).');
        }
        if (!session.version) return bot.sendMessage(chatId, '❌ Укажите версию.');

        saveSessionToDb(chatId, session);
        await connectToServer(chatId, session);
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
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const session = await getSession(chatId);

    console.log(`[${chatId}] Получено сообщение: ${msg.text}, _waiting=${session._waiting}`);

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
        saveSessionToDb(chatId, session);
        console.log(`[${chatId}] Сервер сохранён: ${JSON.stringify(session.server)}`);
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
        saveSessionToDb(chatId, session);
        const { text, keyboard } = getMainMenu(session);
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
        return;
    }
});

// Восстановление сессий при перезапуске бота
async function restoreSessions() {
    return new Promise((resolve) => {
        db.all('SELECT * FROM sessions WHERE auto_reconnect = 1', [], async (err, rows) => {
            if (err) {
                console.error('Ошибка восстановления сессий:', err);
                resolve();
                return;
            }
            if (rows.length === 0) {
                console.log('Нет сессий для восстановления');
                resolve();
                return;
            }
            console.log(`🔄 Восстанавливаю ${rows.length} сессий...`);
            for (const row of rows) {
                const chatId = row.chat_id;
                sessions[chatId] = {
                    server: { host: row.server_host, port: row.server_port },
                    version: row.version,
                    mcBot: null,
                    jumpInterval: null,
                    autoReconnect: true,
                    _waiting: null
                };
                console.log(`[${chatId}] Восстановлена сессия: ${row.server_host}:${row.server_port}`);
                // Ждем 2 секунды между подключениями
                await new Promise(r => setTimeout(r, 2000));
                await connectToServer(chatId, sessions[chatId]);
            }
            resolve();
        });
    });
}

// Запуск
console.log('🚀 Бот запущен...');
restoreSessions().then(() => {
    console.log('✅ Восстановление завершено');
});
