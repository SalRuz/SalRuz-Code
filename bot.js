require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mineflayer = require('mineflayer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Попытка загрузить prismarine-viewer для скриншотов
let headless = null;
let viewerModule = null;
let viewerEnabled = false;
try {
    const pvPath = __dirname + '\\node_modules\\prismarine-viewer';
    const prismarineViewer = require(pvPath);
    headless = prismarineViewer.headless;
    viewerModule = prismarineViewer.viewer;
    viewerEnabled = true;
    console.log('✅ prismarine-viewer загружен (скриншоты доступны)');
} catch (err) {
    console.log('⚠️ prismarine-viewer не найден (скриншоты недоступны)');
    console.log('Ошибка:', err.message);
}

// Путь к папке data
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Путь к базе данных
const dbPath = path.join(dataDir, 'bot.db');

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

// Проверка: занят ли сервер (синхронная)
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
    if (serverConnections[key] && serverConnections[key].ownerChatId !== excludeChatId) {
        return serverConnections[key].ownerChatId;
    }
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

// Удаление пользователя из чата
function removeChatUser(chatId, host, port) {
    const key = `${host}:${port}`;
    if (serverConnections[key]) {
        serverConnections[key].chatUsers.delete(chatId);
    }
    db.run('DELETE FROM chat_users WHERE chat_id = ?', [chatId], (err) => {
        if (err) console.error('Ошибка удаления пользователя:', err);
    });
}

// Получение всех пользователей чата
function getChatUsers(host, port) {
    const key = `${host}:${port}`;
    if (serverConnections[key]) return Array.from(serverConnections[key].chatUsers);
    return [];
}

// Получение владельца сервера (синхронная)
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

// Получение владельца сервера (асинхронная)
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
            const ownerSession = await getSession(ownerChatId);
            if (ownerSession && ownerSession.mcBot) {
                status = '🟢 Онлайн';
            }
            if (ownerInfo && ownerInfo.botUsername) {
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

function cleanupBot(session) {
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

// Функция создания скриншота через viewer API
async function takeScreenshot(mcBot) {
    const { createCanvas } = require('node-canvas-webgl/lib');
    const { WorldView, Viewer, getBufferFromStream } = viewerModule;
    const THREE = require('three');
    const os = require('os');

    const width = 1280;
    const height = 720;
    const viewDistance = 6;

    const tempDir = os.tmpdir();
    const viewerTempPath = path.join(tempDir, 'prismarine-viewer-textures');

    if (!fs.existsSync(viewerTempPath)) {
        fs.mkdirSync(viewerTempPath, { recursive: true });
        const texturesDir = path.join(viewerTempPath, 'textures');
        fs.mkdirSync(texturesDir, { recursive: true });

        const sourceTextures = path.join(__dirname, 'node_modules', 'prismarine-viewer', 'public', 'textures');
        const textureFiles = fs.readdirSync(sourceTextures);
        for (const file of textureFiles) {
            if (file.endsWith('.png')) {
                fs.copyFileSync(path.join(sourceTextures, file), path.join(texturesDir, file));
            }
        }
    }

    const canvas = createCanvas(width, height);
    const renderer = new THREE.WebGLRenderer({ canvas });
    const viewer = new Viewer(renderer);

    if (!viewer.setVersion(mcBot.version)) {
        throw new Error('Не удалось установить версию Minecraft');
    }

    viewer.setFirstPersonCamera(mcBot.entity.position, mcBot.entity.yaw, mcBot.entity.pitch);

    const worldView = new WorldView(mcBot.world, viewDistance, mcBot.entity.position);
    viewer.listen(worldView);
    worldView.init(mcBot.entity.position);

    await new Promise(resolve => setTimeout(resolve, 2000));

    viewer.update();
    renderer.render(viewer.scene, viewer.camera);

    const imageStream = canvas.createPNGStream();
    const buffer = await getBufferFromStream(imageStream);

    return buffer;
}

// Функция подключения к серверу
async function connectToServer(chatId, session) {
    if (session.mcBot) { console.log(`[${chatId}] Бот уже подключен`); return; }
    if (!session.server || !session.server.host) { console.log(`[${chatId}] Сервер не указан`); return; }
    if (!session.version) { console.log(`[${chatId}] Версия не указана`); return; }

    const { host, port } = session.server;
    const occupiedBy = await isServerOccupiedAsync(host, port, chatId);

    if (occupiedBy) {
        console.log(`[${chatId}] Сервер занят владельцем ${occupiedBy}, подключаемся как чат-клиент`);
        addChatUser(chatId, host, port, session.username || 'User');

        const ownerSession = await getSession(occupiedBy);
        const { text, keyboard } = await getMainMenu(session, false);

        bot.sendMessage(chatId, `ℹ️ Сервер \`${host}:${port}\` уже используется владельцем.\nВы подключены в режиме чата.`, { parse_mode: 'Markdown' });
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
        return;
    }

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
            cleanupBot(session);
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
        const msgHash = `${username}:${message}`;
        if (recentTgMessages.has(msgHash)) {
            recentTgMessages.delete(msgHash);
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

    mcBot.on('death', async () => {
        if (!session.chatEnabled) return;
        await sendToChatUsers(host, port, '<b>💀 Бот умер!</b>', 'HTML');
    });

    mcBot.on('messagestr', async (message, jsonMsg, type) => {
        if (!session.chatEnabled) return;
        if (type === 'chat' || type === 'system') {
            const deathPatterns = [
                /(.+) died$/,
                /(.+) was slain by (.+)/,
                /(.+) was killed by (.+)/,
                /(.+) went up in flames$/,
                /(.+) fell off a place$/,
                /(.+) fell from a high place$/,
                /(.+) hit the ground too hard$/,
                /(.+) drowned$/,
                /(.+) suffocated$/,
                /(.+) starved$/,
                /(.+) tried to swim in lava$/,
                /(.+) was shot by (.+)/,
                /(.+) was blown up by (.+)/,
            ];

            for (const pattern of deathPatterns) {
                const match = message.match(pattern);
                if (match) {
                    const deathMessage = `<b>💀 ${match[1]} умер${match[2] ? ` от ${match[2]}` : ''}</b>`;
                    await sendToChatUsers(host, port, deathMessage, 'HTML');
                    break;
                }
            }
        }
    });

    mcBot.on('kicked', async (reason) => {
        clearTimeout(spawnTimeout);
        console.log(`[${chatId}] Кикнут: ${reason}`);
        cleanupBot(session);
        unregisterServer(host, port, chatId);
        await sendToChatUsers(host, port, '🚫 <b>Бот кикнут</b>.', 'HTML');
        await sendToChatUsers(host, port, '🔄 Переподключение...');
        setTimeout(() => connectToServer(chatId, session), 5000);
    });

    mcBot.on('error', async (err) => {
        clearTimeout(spawnTimeout);
        console.error(`[${chatId}] Ошибка:`, err);
        cleanupBot(session);
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
            cleanupBot(session);
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
    session.username = msg.from.username || msg.from.first_name || 'User';
    let isOwner = false;
    if (session.server) {
        const ownerChatId = await getServerOwnerAsync(session.server.host, session.server.port);
        isOwner = !ownerChatId || ownerChatId === msg.chat.id;
    } else {
        isOwner = true;
    }
    const { text, keyboard } = await getMainMenu(session, isOwner);
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', reply_markup: keyboard });
});

// /chat
bot.onText(/\/chat/, async (msg) => {
    const chatId = msg.chat.id;
    const session = await getSession(chatId);

    let isOwner = false;
    if (session.server) {
        const ownerChatId = await getServerOwnerAsync(session.server.host, session.server.port);
        isOwner = !ownerChatId || ownerChatId === chatId;
    }

    if (!isOwner && (!session.server || !session.mcBot)) {
        for (const [key, conn] of Object.entries(serverConnections)) {
            if (conn.chatUsers.has(chatId.toString())) {
                const [host, port] = key.split(':');
                session.server = { host, port: parseInt(port) };
                session.mcBot = serverConnections[key].mcBot;
                break;
            }
        }
    }

    if (!session.server) {
        return bot.sendMessage(chatId, '❌ Сначала подключитесь к серверу.');
    }

    session.chatEnabled = !session.chatEnabled;
    saveSessionToDb(chatId, session);

    const status = session.chatEnabled ? '✅ включен' : '❌ выключен';
    bot.sendMessage(chatId, `Чат ${status}`);
});

// /screen
bot.onText(/\/скрин|\/screen|\/screenshot/i, async (msg) => {
    const chatId = msg.chat.id;
    const session = await getSession(chatId);

    let hasAccess = false;
    let targetSession = session;

    if (session.server) {
        const ownerChatId = await getServerOwnerAsync(session.server.host, session.server.port);
        if (!ownerChatId || ownerChatId === chatId) {
            hasAccess = true;
        } else if (session.chatEnabled) {
            hasAccess = true;
        }
    }

    if (!hasAccess) {
        for (const [key, conn] of Object.entries(serverConnections)) {
            if (conn.chatUsers.has(chatId.toString())) {
                const ownerSession = await getSession(conn.ownerChatId);
                if (ownerSession && ownerSession.mcBot) {
                    targetSession = ownerSession;
                    hasAccess = true;
                    break;
                }
            }
        }
    }

    if (!hasAccess || !targetSession.mcBot) {
        return bot.sendMessage(chatId, '❌ Бот не подключён к серверу.');
    }

    if (!viewerEnabled || !viewerModule) {
        return bot.sendMessage(chatId, '📸 Скриншоты недоступны.\n\nУстановите пакет:\n`npm install prismarine-viewer node-canvas-webgl canvas`');
    }

    bot.sendMessage(chatId, '📸 Делаю скриншот...');

    try {
        const screenshotBuffer = await takeScreenshot(targetSession.mcBot);
        await bot.sendPhoto(chatId, screenshotBuffer, { caption: '📸 Скриншот с сервера' });
    } catch (err) {
        console.error('Ошибка скриншота:', err);
        bot.sendMessage(chatId, '❌ Не удалось сделать скриншот.\n\nВозможно:\n• Бот ещё не загрузил чанки (подождите 5-10 сек)\n• Нет видеокарты или драйверов\n• Недостаточно памяти');
    }
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
        isOwner = true;
    }

    console.log(`[${chatId}] Callback: ${query.data}, владелец: ${isOwner}`);

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
            await bot.sendMessage(chatId, '✏️ Введите версию (например `1.19.2`):', { parse_mode: 'Markdown' });
            return;
        }
        session.version = ver;
        session._waiting = null;
        await bot.answerCallbackQuery(query.id);
        saveSessionToDb(chatId, session);
        const { text, keyboard } = await getMainMenu(session, isOwner);
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
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
        cleanupBot(session);
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
            hasAccess = true;
        } else if (session.mcBot) {
            hasAccess = true;
        } else if (ownerChatId) {
            const ownerSession = await getSession(ownerChatId);
            if (ownerSession && ownerSession.mcBot) {
                targetSession = ownerSession;
                targetHost = session.server.host;
                targetPort = session.server.port;
                hasAccess = true;
                addChatUser(chatId, targetHost, targetPort, msg.from.username || msg.from.first_name || 'Пользователь');
            }
        }

        if (hasAccess && targetSession.mcBot) {
            const tgUser = msg.from.username || msg.from.first_name || 'Пользователь';
            const minecraftMessage = `[${tgUser}] ${msg.text}`;
            const msgHash = `${tgUser}:${msg.text}`;
            recentTgMessages.add(msgHash);
            setTimeout(() => recentTgMessages.delete(msgHash), 5000);

            targetSession.mcBot.chat(minecraftMessage);
            console.log(`[${chatId}] В Minecraft: ${minecraftMessage}`);
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
