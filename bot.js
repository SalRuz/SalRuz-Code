const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============= НАСТРОЙКИ =============
const TELEGRAM_TOKEN = '8512207770:AAEKLtYEph7gleybGhF2lc7Gwq82Kj1yedM'; // Ваш токен
const ALLOWED_USERS = [1170970828]; // Ваш ID
const MC_BOT_FILE = 'bot.js';

// Проверка на уже запущенный процесс
const lockFile = '.bot.lock';
if (fs.existsSync(lockFile)) {
    const pid = fs.readFileSync(lockFile, 'utf8');
    console.log(`⚠️ Бот уже запущен (PID: ${pid})`);
    console.log('Остановите его или удалите файл .bot.lock');
    process.exit(1);
}

// Создаём lock файл
fs.writeFileSync(lockFile, process.pid.toString());

// Удаляем lock файл при выходе
process.on('exit', () => {
    if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
    }
});

process.on('SIGINT', () => {
    console.log('\n👋 Останавливаю бота...');
    if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
    }
    process.exit(0);
});

// Создание Telegram бота с обработкой ошибок
let bot;
try {
    bot = new TelegramBot(TELEGRAM_TOKEN, { 
        polling: {
            interval: 1000,
            autoStart: true,
            params: {
                timeout: 10
            }
        }
    });
    console.log('✅ Telegram бот успешно запущен!');
} catch (error) {
    console.error('❌ Ошибка запуска бота:', error.message);
    fs.unlinkSync(lockFile);
    process.exit(1);
}

// Обработка ошибок polling
bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error.message);
    if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
        console.log('\n⚠️ Другой экземпляр бота уже запущен!');
        console.log('Решение:');
        console.log('1. Закройте все окна с ботом');
        console.log('2. Выполните: taskkill /F /IM node.exe (Windows)');
        console.log('   или: killall node (Linux/Mac)');
        console.log('3. Запустите бота заново\n');
        process.exit(1);
    }
});

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
        bot.sendMessage(chatId, '⚠️ Minecraft бот уже запущен!');
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
        `Ник: TGHelper`, 
        mainKeyboard
    );
}

function stopMCBot(chatId) {
    if (!mcBotProcess) {
        bot.sendMessage(chatId, '⚠️ Minecraft бот не запущен!');
        return;
    }

    mcBotProcess.kill();
    mcBotProcess = null;
    botStatus = 'offline';
    bot.sendMessage(chatId, '🔴 Minecraft бот остановлен', mainKeyboard);
}

function sendCommandToMCBot(command) {
    if (!mcBotProcess) return false;
    
    // Записываем команду в файл
    fs.writeFileSync('mc_command.txt', command);
    return true;
}

function addLog(message) {
    const timestamp = new Date().toLocaleTimeString('ru-RU');
    botLogs.push(`[${timestamp}] ${message}`);
    if (botLogs.length > 50) {
        botLogs.shift();
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
    if (text.startsWith('/')) return; // Игнорируем команды

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

// Обработка inline кнопок (остальной код без изменений)
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    
    if (!isAllowed(query.from.id)) return;
    
    if (!mcBotProcess) {
        bot.answerCallbackQuery(query.id, { text: '⚠️ Бот не запущен!' });
        return;
    }
    
    // ... остальная логика обработки команд ...
    bot.answerCallbackQuery(query.id);
});

// Функция получения кода MC бота
function getMCBotCode() {
    // ... код Minecraft бота ...
    return '/* Minecraft bot code */';
}

console.log('========================================');
console.log('✅ Telegram бот успешно запущен!');
console.log('========================================');
console.log('Ваш Telegram ID:', ALLOWED_USERS[0]);
console.log('Бот готов к работе!');
console.log('Напишите /start в Telegram');
console.log('========================================');
