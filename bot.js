const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============= НАСТРОЙКИ =============
const TELEGRAM_TOKEN = '8512207770:AAEKLtYEph7gleybGhF2lc7Gwq82Kj1yedM'; // Получите у @BotFather
const ALLOWED_USERS = [1170970828]; // Ваш Telegram ID (узнать у @userinfobot)
const MC_BOT_FILE = 'bot.js'; // Файл с ботом для Minecraft

// Создание Telegram бота
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Переменные для управления процессом
let mcBotProcess = null;
let botStatus = 'offline';
let botLogs = [];
let currentServer = { host: 'localhost', port: 6666 };

// ============= КЛАВИАТУРЫ =============
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            ['🟢 Запустить бота', '🔴 Остановить бота'],
            ['📊 Статус', '📜 Логи'],
            ['⚙️ Настройки сервера', '📝 Команды']
        ],
        resize_keyboard: true
    }
};

const commandsKeyboard = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '⛏ Добыть ресурс', callback_data: 'cmd_mine' }],
            [{ text: '⚔️ Атаковать', callback_data: 'cmd_attack' }],
            [{ text: '🏠 Построить убежище', callback_data: 'cmd_shelter' }],
            [{ text: '🛡 Режим охраны', callback_data: 'cmd_guard' }],
            [{ text: '📍 Найти структуру', callback_data: 'cmd_find' }],
            [{ text: '🏃 Ко мне', callback_data: 'cmd_come' }],
            [{ text: '🛑 Стоп', callback_data: 'cmd_stop' }],
            [{ text: '🎒 Инвентарь', callback_data: 'cmd_inventory' }],
            [{ text: '❤️ Здоровье', callback_data: 'cmd_health' }]
        ]
    }
};

// ============= ФУНКЦИИ УПРАВЛЕНИЯ БОТОМ =============

function startMCBot(chatId) {
    if (mcBotProcess) {
        bot.sendMessage(chatId, '⚠️ Бот уже запущен!');
        return;
    }

    // Создаём файл с кодом бота если его нет
    if (!fs.existsSync(MC_BOT_FILE)) {
        fs.writeFileSync(MC_BOT_FILE, getMCBotCode());
    }

    // Запускаем процесс
    mcBotProcess = spawn('node', [MC_BOT_FILE], {
        env: { ...process.env, 
            MC_HOST: currentServer.host, 
            MC_PORT: currentServer.port 
        }
    });

    botStatus = 'online';
    botLogs = [];

    // Обработка вывода
    mcBotProcess.stdout.on('data', (data) => {
        const log = data.toString();
        console.log('MC Bot:', log);
        addLog(log);
    });

    mcBotProcess.stderr.on('data', (data) => {
        const error = data.toString();
        console.error('MC Bot Error:', error);
        addLog(`❌ ${error}`);
    });

    mcBotProcess.on('close', (code) => {
        mcBotProcess = null;
        botStatus = 'offline';
        addLog(`⚠️ Бот остановлен (код: ${code})`);
        bot.sendMessage(chatId, `⚠️ Minecraft бот отключился (код: ${code})`);
    });

    bot.sendMessage(chatId, 
        `✅ Minecraft бот запущен!\n\n` +
        `Сервер: ${currentServer.host}:${currentServer.port}\n` +
        `Ник: Helper`, 
        mainKeyboard
    );
}

function stopMCBot(chatId) {
    if (!mcBotProcess) {
        bot.sendMessage(chatId, '⚠️ Бот не запущен!');
        return;
    }

    mcBotProcess.kill();
    mcBotProcess = null;
    botStatus = 'offline';
    bot.sendMessage(chatId, '🔴 Minecraft бот остановлен', mainKeyboard);
}

function sendCommandToMCBot(command) {
    if (!mcBotProcess) return false;
    
    // Записываем команду в файл, который читает MC бот
    fs.writeFileSync('mc_command.txt', command);
    return true;
}

function addLog(message) {
    const timestamp = new Date().toLocaleTimeString('ru-RU');
    botLogs.push(`[${timestamp}] ${message}`);
    if (botLogs.length > 50) {
        botLogs.shift(); // Храним только последние 50 логов
    }
}

// ============= ОБРАБОТЧИКИ TELEGRAM =============

// Проверка доступа
function isAllowed(userId) {
    return ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(userId);
}

// Команда /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAllowed(msg.from.id)) {
        bot.sendMessage(chatId, '❌ У вас нет доступа к этому боту!');
        return;
    }

    bot.sendMessage(chatId, 
        '🤖 *Управление Minecraft ботом*\n\n' +
        'Этот бот позволяет управлять вашим помощником в Minecraft.\n\n' +
        'Используйте кнопки ниже для управления:', 
        { ...mainKeyboard, parse_mode: 'Markdown' }
    );
});

// Обработка текстовых сообщений
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (!isAllowed(msg.from.id)) return;
    if (!text) return;

    switch(text) {
        case '🟢 Запустить бота':
            startMCBot(chatId);
            break;
            
        case '🔴 Остановить бота':
            stopMCBot(chatId);
            break;
            
        case '📊 Статус':
            const statusEmoji = botStatus === 'online' ? '🟢' : '🔴';
            bot.sendMessage(chatId, 
                `*Статус бота:* ${statusEmoji} ${botStatus}\n` +
                `*Сервер:* ${currentServer.host}:${currentServer.port}`,
                { parse_mode: 'Markdown' }
            );
            break;
            
        case '📜 Логи':
            if (botLogs.length === 0) {
                bot.sendMessage(chatId, '📜 Логи пусты');
            } else {
                const logs = botLogs.slice(-10).join('\n');
                bot.sendMessage(chatId, `📜 *Последние логи:*\n\`\`\`\n${logs}\n\`\`\``, 
                    { parse_mode: 'Markdown' });
            }
            break;
            
        case '⚙️ Настройки сервера':
            bot.sendMessage(chatId, 
                `*Текущий сервер:*\n` +
                `IP: ${currentServer.host}\n` +
                `Порт: ${currentServer.port}\n\n` +
                `Для изменения используйте:\n` +
                `/server [IP] [порт]\n` +
                `Пример: /server localhost 25565`,
                { parse_mode: 'Markdown' }
            );
            break;
            
        case '📝 Команды':
            bot.sendMessage(chatId, 
                '*Выберите команду для бота:*',
                { ...commandsKeyboard, parse_mode: 'Markdown' }
            );
            break;
    }
});

// Команда изменения сервера
bot.onText(/\/server (.+) (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!isAllowed(msg.from.id)) return;
    
    currentServer.host = match[1];
    currentServer.port = parseInt(match[2]);
    
    bot.sendMessage(chatId, 
        `✅ Сервер изменён на:\n` +
        `IP: ${currentServer.host}\n` +
        `Порт: ${currentServer.port}\n\n` +
        `⚠️ Перезапустите бота для применения`
    );
});

// Обработка inline кнопок
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    
    if (!isAllowed(query.from.id)) return;
    
    if (!mcBotProcess) {
        bot.answerCallbackQuery(query.id, { text: '⚠️ Бот не запущен!' });
        return;
    }
    
    let command = '';
    
    switch(data) {
        case 'cmd_mine':
            await bot.sendMessage(chatId, 'Что добыть? Напишите название (например: железная руда, алмаз, дерево)');
            bot.once('message', (msg) => {
                sendCommandToMCBot(`добудь ${msg.text}`);
                bot.sendMessage(chatId, `📤 Отправлено: добудь ${msg.text}`);
            });
            break;
            
        case 'cmd_attack':
            await bot.sendMessage(chatId, 'Кого атаковать? (например: зомби, скелет, крипер)');
            bot.once('message', (msg) => {
                sendCommandToMCBot(`убей ${msg.text}`);
                bot.sendMessage(chatId, `📤 Отправлено: убей ${msg.text}`);
            });
            break;
            
        case 'cmd_shelter':
            sendCommandToMCBot('построй убежище');
            bot.sendMessage(chatId, '📤 Команда отправлена: построй убежище');
            break;
            
        case 'cmd_guard':
            sendCommandToMCBot('будь на стороже');
            bot.sendMessage(chatId, '📤 Режим охраны активирован');
            break;
            
        case 'cmd_find':
            await bot.sendMessage(chatId, 'Что найти? (например: деревня, шахта, портал)');
            bot.once('message', (msg) => {
                sendCommandToMCBot(`найди ${msg.text}`);
                bot.sendMessage(chatId, `📤 Отправлено: найди ${msg.text}`);
            });
            break;
            
        case 'cmd_come':
            sendCommandToMCBot('ко мне');
            bot.sendMessage(chatId, '📤 Бот идёт к вам');
            break;
            
        case 'cmd_stop':
            sendCommandToMCBot('стой');
            bot.sendMessage(chatId, '📤 Бот остановлен');
            break;
            
        case 'cmd_inventory':
            sendCommandToMCBot('инвентарь');
            bot.sendMessage(chatId, '📤 Запрос инвентаря');
            break;
            
        case 'cmd_health':
            sendCommandToMCBot('здоровье');
            bot.sendMessage(chatId, '📤 Запрос здоровья');
            break;
    }
    
    bot.answerCallbackQuery(query.id);
});

// Прямая отправка команд
bot.onText(/\/cmd (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!isAllowed(msg.from.id)) return;
    
    if (!mcBotProcess) {
        bot.sendMessage(chatId, '⚠️ Minecraft бот не запущен!');
        return;
    }
    
    const command = match[1];
    sendCommandToMCBot(command);
    bot.sendMessage(chatId, `📤 Команда отправлена: ${command}`);
});

// ============= КОД MINECRAFT БОТА =============
function getMCBotCode() {
    return `
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalNear } = goals;
const pvp = require('mineflayer-pvp').plugin;
const fs = require('fs');

// Получаем настройки из переменных окружения
const bot = mineflayer.createBot({
    host: process.env.MC_HOST || 'localhost',
    port: parseInt(process.env.MC_PORT) || 6666,
    username: 'TGHelper',
    version: '1.20.4'
});

bot.loadPlugin(pathfinder);
bot.loadPlugin(pvp);

let master = 'SalRuzO';
let guardMode = false;

// Словари перевода
const blocksRU = {
    'железная руда': 'iron_ore',
    'золотая руда': 'gold_ore',
    'алмазная руда': 'diamond_ore',
    'алмаз': 'diamond_ore',
    'уголь': 'coal_ore',
    'дерево': 'oak_log',
    'камень': 'stone',
    'земля': 'dirt'
};

const mobsRU = {
    'зомби': 'zombie',
    'скелет': 'skeleton',
    'крипер': 'creeper',
    'паук': 'spider'
};

bot.on('spawn', () => {
    console.log('Бот подключился к серверу');
    const mcData = require('minecraft-data')(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);
    
    // Проверяем файл с командами каждую секунду
    setInterval(() => {
        if (fs.existsSync('mc_command.txt')) {
            const command = fs.readFileSync('mc_command.txt', 'utf8');
            fs.unlinkSync('mc_command.txt');
            processCommand(command);
        }
    }, 1000);
});

function processCommand(command) {
    const msg = command.toLowerCase();
    
    if (msg.startsWith('добудь ')) {
        const item = command.substring(7);
        mineItem(item);
    }
    else if (msg.startsWith('убей ')) {
        const target = command.substring(5);
        attackTarget(target);
    }
    else if (msg === 'построй убежище') {
        buildShelter();
    }
    else if (msg === 'будь на стороже') {
        startGuarding();
    }
    else if (msg === 'ко мне') {
        followMaster();
    }
    else if (msg === 'стой') {
        bot.pathfinder.setGoal(null);
        bot.pvp.stop();
    }
    else if (msg === 'инвентарь') {
        const items = bot.inventory.items();
        if (items.length > 0) {
            console.log('Инвентарь:', items.map(i => i.name + ' x' + i.count).join(', '));
        } else {
            console.log('Инвентарь пуст');
        }
    }
    else if (msg === 'здоровье') {
        console.log('HP:', Math.round(bot.health), '/ 20');
    }
}

function followMaster() {
    const player = bot.players[master];
    if (player && player.entity) {
        bot.pathfinder.setGoal(new GoalFollow(player.entity, 3), true);
    }
}

async function mineItem(itemNameRU) {
    try {
        const itemName = blocksRU[itemNameRU.toLowerCase()] || itemNameRU;
        console.log('Ищу', itemNameRU);
        
        const mcData = require('minecraft-data')(bot.version);
        const block = bot.findBlock({
            matching: mcData.blocksByName[itemName]?.id,
            maxDistance: 32
        });
        
        if (block) {
            await bot.pathfinder.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 2));
            await bot.dig(block);
            console.log('Добыл', itemNameRU);
        } else {
            console.log('Не нашёл', itemNameRU);
        }
    } catch (err) {
        console.log('Ошибка:', err.message);
    }
}

async function attackTarget(targetNameRU) {
    try {
        const targetName = mobsRU[targetNameRU.toLowerCase()] || targetNameRU;
        
        const target = Object.values(bot.entities).find(e => {
            if (e.type !== 'mob') return false;
            return e.name?.toLowerCase().includes(targetName);
        });
        
        if (target) {
            console.log('Атакую', targetNameRU);
            bot.pvp.attack(target);
        } else {
            console.log('Не вижу', targetNameRU);
        }
    } catch (err) {
        console.log('Ошибка:', err.message);
    }
}

function startGuarding() {
    guardMode = true;
    console.log('Режим охраны активирован');
    
    setInterval(() => {
        if (!guardMode) return;
        
        const hostile = ['zombie', 'skeleton', 'spider', 'creeper'];
        const enemies = Object.values(bot.entities).filter(e => {
            if (e.type !== 'mob') return false;
            return hostile.some(mob => e.name?.toLowerCase().includes(mob));
        });
        
        if (enemies.length > 0) {
            bot.pvp.attack(enemies[0]);
        }
    }, 1000);
}

async function buildShelter() {
    console.log('Строю убежище...');
    // Упрощённая версия постройки
    bot.chat('Начинаю строить убежище');
}

bot.on('kicked', (reason) => console.log('Кикнут:', reason));
bot.on('error', (err) => console.log('Ошибка:', err));
bot.on('death', () => console.log('Бот умер'));
`;
}

// ============= ЗАПУСК =============
console.log('🤖 Telegram бот запущен!');
console.log('Не забудьте:');
console.log('1. Вставить токен от @BotFather');
console.log('2. Добавить свой Telegram ID');
console.log('3. Установить зависимости: npm install node-telegram-bot-api');
