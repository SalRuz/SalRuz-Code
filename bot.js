require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mineflayer = require('mineflayer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const https = require('https');

// Путь к папке data
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Путь к базе данных
const dbPath = path.join(dataDir, 'bot.db');

// Google Gemini API ключ
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Функция для запроса к Gemini API
async function askGemini(prompt) {
    if (!GEMINI_API_KEY) {
        console.log('⚠️ GEMINI_API_KEY не указан');
        return null;
    }

    return new Promise((resolve, reject) => {
        const systemPrompt = 'Ты дружелюбный помощник в игре Minecraft. Отвечай кратко и по делу на русском языке.';
        const userPrompt = 'Вопрос игрока: ' + prompt;
        
        const requestBody = {
            contents: [{
                parts: [{
                    text: systemPrompt + ' ' + userPrompt
                }]
            }],
            generationConfig: {
                maxOutputTokens: 500,
                temperature: 0.7
            }
        };
        
        const data = JSON.stringify(requestBody);
        console.log('📤 Запрос:', data.substring(0, 200) + '...');

        const options = {
            hostname: 'generativelanguage.googleapis.com',
            port: 443,
            path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => { responseData += chunk; });
            res.on('end', () => {
                try {
                    const result = JSON.parse(responseData);
                    console.log('📦 Ответ Gemini:', JSON.stringify(result, null, 2));
                    
                    // Проверяем на ошибку
                    if (result.error) {
                        console.error('❌ Ошибка API:', result.error.message);
                        resolve(null);
                        return;
                    }
                    
                    // Gemini возвращает: candidates[0].content.parts[0].text
                    const answer = result.candidates?.[0]?.content?.parts?.[0]?.text;
                    console.log('🤖 Gemini ответ:', answer);
                    resolve(answer || null);
                } catch (e) {
                    console.error('Ошибка парсинга ответа Gemini:', e.message);
                    console.log('Raw ответ:', responseData);
                    resolve(null);
                }
            });
        });

        req.on('error', (e) => {
            console.error('Ошибка запроса к Gemini:', e.message);
            resolve(null);
        });

        req.write(data);
        req.end();
    });
}

// Глобальные переменные
let db = null;
const sessions = {};
const serverConnections = {};
// Хранение последних сообщений из TG (чтобы не дублировать)
const recentTgMessages = new Set();

// Инициализация БД
function initDatabase() {
    return new Promise((resolve) => {
        db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('Ошибка открытия базы данных:', err);
                resolve(false);
                return;
            }
            console.log('✅ База данных подключена:', dbPath);

            let tablesCreated = 0;
            const checkInit = () => {
                tablesCreated++;
                if (tablesCreated === 3) {
                    resolve(true);
                }
            };

            db.run(`
                CREATE TABLE IF NOT EXISTS sessions (
                    chat_id TEXT PRIMARY KEY,
                    server_host TEXT,
                    server_port INTEGER,
                    version TEXT,
                    chat_enabled INTEGER DEFAULT 0
                )
            `, (err) => {
                if (err) console.error('Ошибка sessions:', err);
                else console.log('✅ Таблица sessions готова');
                checkInit();
            });

            db.run(`
                CREATE TABLE IF NOT EXISTS active_servers (
                    server_host TEXT,
                    server_port INTEGER,
                    owner_chat_id TEXT PRIMARY KEY,
                    bot_username TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) console.error('Ошибка active_servers:', err);
                else console.log('✅ Таблица active_servers готова');
                checkInit();
            });

            db.run(`
                CREATE TABLE IF NOT EXISTS chat_users (
                    chat_id TEXT PRIMARY KEY,
                    server_host TEXT,
                    server_port INTEGER,
                    tg_username TEXT,
                    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) console.error('Ошибка chat_users:', err);
                else console.log('✅ Таблица chat_users готова');
                checkInit();
            });
        });
    });
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Загрузка сессии из БД
function loadSessionFromDb(chatId) {
    return new Promise((resolve) => {
        db.get('SELECT * FROM sessions WHERE chat_id = ?', [chatId], (err, row) => {
            if (err || !row) resolve(null);
            else {
                resolve({
                    server: { host: row.server_host, port: row.server_port },
                    version: row.version,
                    chatEnabled: row.chat_enabled === 1
                });
            }
        });
    });
}

// Сохранение сессии в БД
function saveSessionToDb(chatId, session) {
    db.run(
        `INSERT OR REPLACE INTO sessions (chat_id, server_host, server_port, version, chat_enabled) VALUES (?, ?, ?, ?, ?)`,
        [chatId, session.server?.host || null, session.server?.port || null, session.version || null, session.chatEnabled ? 1 : 0],
        (err) => { if (err) console.error('Ошибка сохранения:', err); }
    );
}

// Проверка: занят ли сервер
function isServerOccupied(host, port, excludeChatId = null) {
    const key = `${host}:${port}`;
    if (serverConnections[key] && serverConnections[key].ownerChatId !== excludeChatId) {
        return serverConnections[key].ownerChatId;
    }
    return null;
}

// Проверка: занят ли сервер (асинхронная, с проверкой БД)
async function isServerOccupiedAsync(host, port, excludeChatId = null) {
    const key = `${host}:${port}`;
    // Сначала проверяем в памяти
    if (serverConnections[key] && serverConnections[key].ownerChatId !== excludeChatId) {
        return serverConnections[key].ownerChatId;
    }
    // Если в памяти нет, проверяем БД
    const ownerChatId = await getServerOwnerFromDb(host, port);
    if (ownerChatId && ownerChatId !== excludeChatId) {
        return ownerChatId;
    }
    return null;
}

// Получение информации о владельце сервера
function getServerOwnerInfo(host, port) {
    const key = `${host}:${port}`;
    if (serverConnections[key]) {
        return {
            ownerChatId: serverConnections[key].ownerChatId,
            botUsername: serverConnections[key].botUsername
        };
    }
    return null;
}

// Регистрация сервера за владельцем
function registerServer(host, port, chatId, botUsername) {
    const key = `${host}:${port}`;
    serverConnections[key] = {
        ownerChatId: chatId,
        botUsername: botUsername,
        chatUsers: new Set(),
        mcBot: null
    };
    db.run(
        `INSERT OR REPLACE INTO active_servers (server_host, server_port, owner_chat_id, bot_username) VALUES (?, ?, ?, ?)`,
        [host, port, chatId, botUsername],
        (err) => { if (err) console.error('Ошибка регистрации:', err); }
    );
}

// Освобождение сервера
function unregisterServer(host, port, chatId) {
    const key = `${host}:${port}`;
    if (serverConnections[key] && serverConnections[key].ownerChatId === chatId) {
        delete serverConnections[key];
    }
    db.run('DELETE FROM active_servers WHERE server_host = ? AND server_port = ? AND owner_chat_id = ?',
        [host, port, chatId], (err) => { if (err) console.error('Ошибка освобождения:', err); }
    );
}

// Добавление пользователя в чат
function addChatUser(chatId, host, port, tgUsername) {
    const key = `${host}:${port}`;
    if (serverConnections[key]) serverConnections[key].chatUsers.add(chatId);
    db.run(
        `INSERT OR REPLACE INTO chat_users (chat_id, server_host, server_port, tg_username) VALUES (?, ?, ?, ?)`,
        [chatId, host, port, tgUsername],
        (err) => { if (err) console.error('Ошибка добавления:', err); }
    );
}

// Получение всех пользователей чата
function getChatUsers(host, port) {
    const key = `${host}:${port}`;
    if (serverConnections[key]) return Array.from(serverConnections[key].chatUsers);
    return [];
}

// Получение владельца сервера (синхронная, из памяти)
function getServerOwner(host, port) {
    const key = `${host}:${port}`;
    if (serverConnections[key]) return serverConnections[key].ownerChatId;
    return null;
}

// Получение владельца сервера из БД
function getServerOwnerFromDb(host, port) {
    return new Promise((resolve) => {
        db.get('SELECT owner_chat_id FROM active_servers WHERE server_host = ? AND server_port = ?',
            [host, port], (err, row) => {
                if (err || !row) resolve(null);
                else resolve(row.owner_chat_id);
            });
    });
}

// Получение владельца сервера (асинхронная, с проверкой БД)
async function getServerOwnerAsync(host, port) {
    const key = `${host}:${port}`;
    if (serverConnections[key]) return serverConnections[key].ownerChatId;
    return await getServerOwnerFromDb(host, port);
}

// Получение сессии
async function getSession(chatId) {
    if (!sessions[chatId]) {
        const dbSession = await loadSessionFromDb(chatId);
        if (dbSession) {
            sessions[chatId] = {
                server: dbSession.server,
                version: dbSession.version,
                mcBot: null,
                jumpInterval: null,
                chatEnabled: dbSession.chatEnabled || false,
                _waiting: null,
                username: null
            };
        } else {
            sessions[chatId] = {
                server: null, version: null, mcBot: null, jumpInterval: null,
                chatEnabled: false, _waiting: null, username: null
            };
        }
    }
    return sessions[chatId];
}

// Главное меню
async function getMainMenu(session, isOwner = false) {
    const serverText = session.server ? `${session.server.host}:${session.server.port}` : '❌ Не указан';
    const versionText = session.version || '❌ Не указана';
    const chatText = session.chatEnabled ? '🟢 ВКЛ' : '🔴 ВЫКЛ';
    
    // Определяем статус
    let status = session.mcBot ? '🟢 Онлайн' : '🔴 Оффлайн';
    
    // Получаем информацию о владельце сервера
    let ownerText = '';
    if (session.server) {
        const ownerChatId = await getServerOwnerAsync(session.server.host, session.server.port);
        if (ownerChatId) {
            const ownerInfo = getServerOwnerInfo(session.server.host, session.server.port);
            // Проверяем, онлайн ли бот владельца
            const ownerSession = await getSession(ownerChatId);
            if (ownerSession && ownerSession.mcBot) {
                status = '🟢 Онлайн';
            }
            if (ownerInfo && ownerInfo.botUsername) {
                // Убираем "_bot" из username для отображения
                const ownerUsername = ownerInfo.botUsername.replace(/_bot$/, '');
                ownerText = `\n👤 Бот владельца: @\`${ownerUsername}\``;
            }
        }
    }

    const text = `🤖 *Minecraft Bot*\n\n` +
        `📡 Сервер: \`${serverText}\`\n` +
        `🎮 Версия: \`${versionText}\`\n` +
        `📌 Статус: ${status}\n` +
        `💬 Чат: ${chatText}${ownerText}\n\n` +
        `${isOwner ? '👑 Вы владелец бота' : '👥 Вы используете чат сервера'}\n` +
        `🔄 Авто-переподключение: ✅ Включено`;

    if (isOwner) {
        return {
            text,
            keyboard: {
                inline_keyboard: [
                    [{ text: '📡 Сервер', callback_data: 'set_server' }, { text: '🎮 Версия', callback_data: 'set_version' }],
                    [{ text: '▶️ Старт', callback_data: 'start_bot' }, { text: '⏹ Стоп', callback_data: 'stop_bot' }],
                    [{ text: '👥 Игроки', callback_data: 'list_players' }, { text: session.chatEnabled ? '💬 Откл. чат' : '💬 Вкл. чат', callback_data: 'toggle_chat' }],
                ],
            }
        };
    } else {
        // Не-владелец: показываем все кнопки, но старт работает только если сервер свободен
        const canStart = session.version && session.server;
        return {
            text,
            keyboard: {
                inline_keyboard: [
                    [{ text: '📡 Сервер', callback_data: 'set_server' }, { text: '🎮 Версия', callback_data: 'set_version' }],
                    [canStart ? { text: '▶️ Старт', callback_data: 'start_bot' } : { text: '⏳ Укажите сервер и версию', callback_data: 'wait_server' }],
                    [{ text: '👥 Игроки', callback_data: 'list_players' }, { text: session.chatEnabled ? '💬 Откл. чат' : '💬 Вкл. чат', callback_data: 'toggle_chat' }],
                ],
            }
        };
    }
}

function cleanupBot(session, chatId) {
    if (session.jumpInterval) { clearInterval(session.jumpInterval); session.jumpInterval = null; }
    session.mcBot = null;
}

// Отправка сообщения всем пользователям чата
async function sendToChatUsers(host, port, message, parseMode = null, extraOptions = {}) {
    const chatUsers = getChatUsers(host, port);
    for (const userChatId of chatUsers) {
        try {
            await bot.sendMessage(userChatId, message, { parse_mode: parseMode, ...extraOptions });
        } catch (err) {
            console.error(`Ошибка отправки ${userChatId}:`, err.message);
        }
    }
}

// Отправка сообщения всем пользователям чата кроме указанного
async function sendToChatUsersExcept(host, port, message, parseMode = null, excludeChatId = null, extraOptions = {}) {
    const chatUsers = getChatUsers(host, port);
    for (const userChatId of chatUsers) {
        if (userChatId === excludeChatId || userChatId === excludeChatId?.toString()) continue;
        try {
            await bot.sendMessage(userChatId, message, { parse_mode: parseMode, ...extraOptions });
        } catch (err) {
            console.error(`Ошибка отправки ${userChatId}:`, err.message);
        }
    }
}

// Функция подключения к серверу
async function connectToServer(chatId, session) {
    if (session.mcBot) { console.log(`[${chatId}] Бот уже подключен`); return; }
    if (!session.server || !session.server.host) { console.log(`[${chatId}] Сервер не указан`); return; }
    if (!session.version) { console.log(`[${chatId}] Версия не указана`); return; }

    const { host, port } = session.server;
    const occupiedBy = await isServerOccupiedAsync(host, port, chatId);

    if (occupiedBy) {
        // Сервер занят - подключаемся как пользователь чата (без подключения к Minecraft)
        console.log(`[${chatId}] Сервер занят владельцем ${occupiedBy}, подключаемся как чат-клиент`);
        
        // Добавляем пользователя в чат
        addChatUser(chatId, host, port, session.username || 'User');

        // Получаем сессию владельца для правильного меню
        const ownerSession = await getSession(occupiedBy);
        const { text, keyboard } = await getMainMenu(session, false);

        bot.sendMessage(chatId, `ℹ️ Сервер \`${host}:${port}\` уже используется владельцем.\nВы подключены в режиме чата.`, { parse_mode: 'Markdown' });
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
        return;
    }

    // Сервер свободен - запускаем как основной бот
    const tgUser = session.username || 'User';
    const name = `${tgUser}_bot`;
    console.log(`[${chatId}] Подключение к ${host}:${port}, версия: ${session.version}, ник: ${name}`);

    const mcBot = mineflayer.createBot({
        host, port, username: name,
        version: session.version === 'auto' ? false : session.version,
        auth: 'offline', checkTimeoutInterval: 60000, hideErrors: true
    });

    session.mcBot = mcBot;
    registerServer(host, port, chatId, name);
    addChatUser(chatId, host, port, chatId.toString());

    const spawnTimeout = setTimeout(async () => {
        if (session.mcBot && !session.mcBot.entity) {
            console.log(`[${chatId}] Тайм-аут спавна`);
            cleanupBot(session, chatId);
            unregisterServer(host, port, chatId);
            try { await sendToChatUsers(host, port, '❌ Сервер отключен.'); } catch (e) {}
            try { mcBot.quit(); } catch {}
            await sendToChatUsers(host, port, '🔄 Переподключение...');
            setTimeout(() => connectToServer(chatId, session), 5000);
        }
    }, 60000);

    mcBot.on('login', () => console.log(`[${chatId}] Вошел как ${name}`));

    mcBot.once('spawn', async () => {
        clearTimeout(spawnTimeout);
        console.log(`[${chatId}] Заспавнился`);
        session.jumpInterval = setInterval(() => {
            try { mcBot.setControlState('jump', true); setTimeout(() => mcBot.setControlState('jump', false), 300); } catch {}
        }, 1500);

        await sendToChatUsers(host, port, '✅ Бот подключён и прыгает!');
        const key = `${host}:${port}`;
        if (serverConnections[key]) serverConnections[key].mcBot = mcBot;

        const { text, keyboard } = await getMainMenu(session, true);
        await sendToChatUsers(host, port, text, 'Markdown', { reply_markup: keyboard });
    });

    mcBot.on('chat', async (username, message) => {
        if (username === name) return;
        // Проверяем, не было ли это сообщение отправлено из TG недавно
        const msgHash = `${username}:${message}`;
        if (recentTgMessages.has(msgHash)) {
            recentTgMessages.delete(msgHash);
            return;
        }
        
        // Проверяем, обращается ли игрок к боту (бот, Bot, @bot)
        const botMentionRegex = /^(бот|bot|@?\w*_bot)[,:]\s*(.+)/i;
        const match = message.match(botMentionRegex);
        
        if (match) {
            const question = match[2].trim();
            console.log(`[${chatId}] 🤖 Игрок ${username} спрашивает: ${question}`);
            
            // Отправляем запрос к Gemini
            const answer = await askGemini(question);
            
            if (answer) {
                // Отправляем ответ в чат игры
                mcBot.chat(answer);
                // И в Telegram
                await sendToChatUsers(host, port, `🤖 <b>Бот</b> → ${username}: ${answer}`, 'HTML');
            } else {
                mcBot.chat('Извините, я сейчас не могу ответить.');
            }
            return;
        }
        
        await sendToChatUsers(host, port, `🎮 <b>${username}</b>: ${message}`, 'HTML');
    });

    mcBot.on('playerJoined', async (player) => {
        if (!session.chatEnabled) return;
        await sendToChatUsers(host, port, `<b>➕ ${player.username} присоединился</b>`, 'HTML');
    });

    mcBot.on('playerLeft', async (player) => {
        if (!session.chatEnabled) return;
        await sendToChatUsers(host, port, `<b>➖ ${player.username} покинул игру</b>`, 'HTML');
    });

    mcBot.on('kicked', async (reason) => {
        clearTimeout(spawnTimeout);
        console.log(`[${chatId}] Кикнут: ${reason}`);
        cleanupBot(session, chatId);
        unregisterServer(host, port, chatId);
        await sendToChatUsers(host, port, '🚫 <b>Бот кикнут</b>.', 'HTML');
        await sendToChatUsers(host, port, '🔄 Переподключение...');
        setTimeout(() => connectToServer(chatId, session), 5000);
    });

    mcBot.on('error', async (err) => {
        clearTimeout(spawnTimeout);
        console.error(`[${chatId}] Ошибка:`, err);
        cleanupBot(session, chatId);
        unregisterServer(host, port, chatId);
        const serverOffline = err.message?.includes('ECONNREFUSED') || err.message?.includes('ENOTFOUND') || err.message?.includes('ETIMEDOUT');
        const socketClosed = err.message?.includes('Socket closed') || err.message?.includes('connection reset');
        if (serverOffline) {
            await sendToChatUsers(host, port, '❌ Сервер отключен.');
        } else if (socketClosed) {
            await sendToChatUsers(host, port, '🔌 Соединение разорвано. Переподключение...');
            setTimeout(() => connectToServer(chatId, session), 3000);
            return;
        } else {
            await sendToChatUsers(host, port, `❌ Ошибка: \`${err.message}\``, 'Markdown');
        }
        if (!serverOffline && !socketClosed) {
            await sendToChatUsers(host, port, '🔄 Переподключение...');
            setTimeout(() => connectToServer(chatId, session), 3000);
        }
    });

    mcBot.on('end', async (reason) => {
        clearTimeout(spawnTimeout);
        console.log(`[${chatId}] Разрыв: ${reason}`);
        if (session.mcBot) {
            cleanupBot(session, chatId);
            unregisterServer(host, port, chatId);
            const serverOffline = reason?.includes('Connection closed') || reason?.includes('ECONNREFUSED');
            const socketClosed = reason?.includes('Socket closed');
            if (serverOffline) {
                await sendToChatUsers(host, port, '❌ Сервер отключен.');
            } else if (socketClosed) {
                await sendToChatUsers(host, port, '🔌 Соединение разорвано. Переподключение...');
                setTimeout(() => connectToServer(chatId, session), 3000);
                return;
            } else {
                await sendToChatUsers(host, port, '🔌 Бот отключён.');
            }
            if (!serverOffline && !socketClosed) {
                await sendToChatUsers(host, port, '🔄 Переподключение...');
                setTimeout(() => connectToServer(chatId, session), 3000);
            }
        }
    });
}

// /start
bot.onText(/\/start/, async (msg) => {
    const session = await getSession(msg.chat.id);
    // Сохраняем username пользователя
    session.username = msg.from.username || msg.from.first_name || 'User';
    let isOwner = false;
    if (session.server) {
        const ownerChatId = await getServerOwnerAsync(session.server.host, session.server.port);
        isOwner = !ownerChatId || ownerChatId === msg.chat.id;
    } else {
        isOwner = true; // Нет сервера = владелец
    }
    const { text, keyboard } = await getMainMenu(session, isOwner);
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', reply_markup: keyboard });
});

// Кнопки
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const session = await getSession(chatId);

    let isOwner = false;
    if (session.server) {
        const ownerChatId = await getServerOwnerAsync(session.server.host, session.server.port);
        isOwner = !ownerChatId || ownerChatId === chatId;
    } else {
        isOwner = true; // Нет сервера = владелец
    }

    console.log(`[${chatId}] Callback: ${query.data}, владелец: ${isOwner}`);

    // Блокируем не-владельцев (кроме чата, игроков, версии, сервера и старта)
    if (!isOwner && query.data !== 'toggle_chat' && query.data !== 'list_players' && query.data !== 'set_version' && query.data !== 'set_server' && query.data !== 'start_bot' && query.data !== 'wait_version' && query.data !== 'wait_server') {
        await bot.answerCallbackQuery(query.id, { text: '⚠️ Только владелец может управлять.', show_alert: true });
        return;
    }

    if (query.data === 'set_server') {
        session._waiting = 'server';
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(chatId, '📡 Введите адрес сервера:\n`host:port` или `host`', { parse_mode: 'Markdown' });
        return;
    }

    if (query.data === 'wait_version') {
        await bot.answerCallbackQuery(query.id, { text: 'Сначала укажите версию', show_alert: true });
        return;
    }

    if (query.data === 'wait_server') {
        await bot.answerCallbackQuery(query.id, { text: 'Сначала укажите сервер и версию', show_alert: true });
        return;
    }

    if (query.data === 'set_version') {
        session._waiting = 'version';
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(chatId, '✏️ Введите версию вручную (например `1.19.2`):', { parse_mode: 'Markdown' });
        return;
    }

    if (query.data === 'toggle_chat') {
        session.chatEnabled = !session.chatEnabled;
        saveSessionToDb(chatId, session);
        const status = session.chatEnabled ? '✅ включен' : '❌ выключен';
        await bot.answerCallbackQuery(query.id, { text: `Чат ${status}` });
        const { text, keyboard } = await getMainMenu(session, isOwner);
        await bot.editMessageText(text, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown', reply_markup: keyboard });
        return;
    }

    if (query.data === 'list_players') {
        await bot.answerCallbackQuery(query.id);
        let targetSession = session;
        let hasAccess = false;

        if (session.server) {
            const ownerChatId = await getServerOwnerAsync(session.server.host, session.server.port);
            if (!ownerChatId || ownerChatId === chatId) {
                hasAccess = true;
            } else if (session.mcBot) {
                hasAccess = true;
            } else if (ownerChatId) {
                // Ищем сессию владельца
                const ownerSession = await getSession(ownerChatId);
                if (ownerSession && ownerSession.mcBot) {
                    targetSession = ownerSession;
                    hasAccess = true;
                }
            }
        }

        if (!hasAccess || !targetSession.mcBot) {
            return bot.sendMessage(chatId, '❌ Бот не подключён к серверу.');
        }

        const players = targetSession.mcBot.players;
        const playerList = Object.values(players).map(p => p.username).filter(name => name !== targetSession.mcBot.username);

        if (playerList.length === 0) {
            return bot.sendMessage(chatId, '👥 На сервере нет игроков (кроме бота).');
        }

        const text = `👥 *Игроки на сервере:* (${playerList.length})\n\n` + playerList.map(name => `• \`${name}\``).join('\n');
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        return;
    }

    if (query.data === 'start_bot') {
        await bot.answerCallbackQuery(query.id);
        if (session.mcBot) return bot.sendMessage(chatId, '⚠️ Бот уже запущен.');
        if (!session.server || !session.server.host) return bot.sendMessage(chatId, '❌ Укажите сервер.');
        if (!session.version) return bot.sendMessage(chatId, '❌ Укажите версию.');
        saveSessionToDb(chatId, session);
        await connectToServer(chatId, session);
        return;
    }

    if (query.data === 'stop_bot') {
        await bot.answerCallbackQuery(query.id);
        if (!session.mcBot) return bot.sendMessage(chatId, '⚠️ Бот не запущен.');
        const { host, port } = session.server;
        try { session.mcBot.quit(); } catch {}
        cleanupBot(session, chatId);
        unregisterServer(host, port, chatId);
        const { text, keyboard } = await getMainMenu(session, true);
        await bot.sendMessage(chatId, '✅ Бот остановлен.');
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
        return;
    }
});

// Текстовые сообщения
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const session = await getSession(chatId);

    console.log(`[${chatId}] Сообщение: ${msg.text}, _waiting=${session._waiting}`);

    if (session._waiting === 'server') {
        let rawInput = msg.text.trim().replace(/^https?:\/\//, '');
        const parts = rawInput.split(':');
        const host = parts[0];
        const port = parts[1] ? parseInt(parts[1]) : 25565;
        if (!host || isNaN(port)) return bot.sendMessage(chatId, '❌ Неверный формат.');
        session.server = { host, port };
        session.username = msg.from.username || msg.from.first_name || 'User';
        session._waiting = null;
        saveSessionToDb(chatId, session);
        const ownerChatId = await getServerOwnerAsync(host, port);
        const isOwner = !ownerChatId || ownerChatId === chatId;
        const { text, keyboard } = await getMainMenu(session, isOwner);
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
        return;
    }

    if (session._waiting === 'version') {
        const ver = msg.text.trim();
        if (!/^\d+\.\d+(\.\d+)?$/.test(ver)) {
            return bot.sendMessage(chatId, '❌ Неверный формат. Пример: `1.20.4`', { parse_mode: 'Markdown' });
        }
        session.version = ver;
        session.username = msg.from.username || msg.from.first_name || 'User';
        session._waiting = null;
        saveSessionToDb(chatId, session);
        const ownerChatId = session.server ? await getServerOwnerAsync(session.server.host, session.server.port) : null;
        const isOwner = !ownerChatId || ownerChatId === chatId;
        const { text, keyboard } = await getMainMenu(session, isOwner);
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
        return;
    }

    // Чат в Minecraft и TG
    if (session.chatEnabled && session.server) {
        let hasAccess = false;
        let targetSession = session;
        let targetHost = session.server.host;
        let targetPort = session.server.port;

        const ownerChatId = await getServerOwnerAsync(session.server.host, session.server.port);
        if (!ownerChatId || ownerChatId === chatId) {
            // Мы владелец
            hasAccess = true;
        } else if (session.mcBot) {
            // У нас есть бот
            hasAccess = true;
        } else if (ownerChatId) {
            // Мы не владелец, ищем сессию владельца
            const ownerSession = await getSession(ownerChatId);
            if (ownerSession && ownerSession.mcBot) {
                targetSession = ownerSession;
                targetHost = session.server.host;
                targetPort = session.server.port;
                hasAccess = true;
                // Добавляем пользователя в чат владельца
                addChatUser(chatId, targetHost, targetPort, msg.from.username || msg.from.first_name || 'Пользователь');
            }
        }

        if (hasAccess && targetSession.mcBot) {
            const tgUser = msg.from.username || msg.from.first_name || 'Пользователь';
            const minecraftMessage = `[${tgUser}] ${msg.text}`;
            // Добавляем хэш сообщения, чтобы не дублировать его из Minecraft
            const msgHash = `${tgUser}:${msg.text}`;
            recentTgMessages.add(msgHash);
            setTimeout(() => recentTgMessages.delete(msgHash), 5000);

            targetSession.mcBot.chat(minecraftMessage);
            console.log(`[${chatId}] В Minecraft: ${minecraftMessage}`);
            // Отправляем сообщение всем КРОМЕ отправителя
            const formattedMessage = `📨 <b>${tgUser}</b>: ${msg.text}`;
            await sendToChatUsersExcept(targetHost, targetPort, formattedMessage, 'HTML', chatId);
        } else {
            bot.sendMessage(chatId, '❌ Бот не подключён.');
        }
        return;
    }
});

// Восстановление сессий
async function restoreSessions() {
    await initDatabase();
    
    return new Promise((resolve) => {
        db.all('SELECT * FROM sessions', [], async (err, rows) => {
            if (err) {
                console.error('Ошибка восстановления:', err);
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
                    chatEnabled: row.chat_enabled === 1,
                    _waiting: null,
                    username: null
                };
                console.log(`[${chatId}] Восстановлена: ${row.server_host}:${row.server_port}`);
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
