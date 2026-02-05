const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============= НАСТРОЙКИ =============
const TELEGRAM_TOKEN = '8512207770:AAEKLtYEph7gleybGhF2lc7Gwq82Kj1yedM';
const ALLOWED_USERS = [1170970828];
const MC_BOT_FILE = 'bot.js';

// ============= ИСПОЛЬЗУЕМ РАЗНЫЕ LOCK ФАЙЛЫ =============
const lockFile = '.telegram-bot.lock';
const mcLockFile = '.minecraft-bot.lock';

// Функция проверки живого процесса
function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

// Проверяем существующий lock файл TELEGRAM бота
if (fs.existsSync(lockFile)) {
    try {
        const oldPid = parseInt(fs.readFileSync(lockFile, 'utf8'));
        
        if (isProcessRunning(oldPid)) {
            console.log('⚠️ Telegram бот уже запущен (PID:', oldPid, ')');
            console.log('Остановите его командой:');
            console.log('  Windows: taskkill /PID', oldPid, '/F');
            console.log('  Linux/Mac: kill', oldPid);
            console.log('\nИли удалите файл', lockFile);
            process.exit(1);
        } else {
            console.log('🧹 Удаляю старый lock файл Telegram бота...');
            fs.unlinkSync(lockFile);
        }
    } catch (err) {
        fs.unlinkSync(lockFile);
    }
}

// Создаём lock файл для Telegram бота
fs.writeFileSync(lockFile, process.pid.toString());
console.log('🔒 Telegram lock файл создан (PID:', process.pid, ')');

// Очистка при выходе
function cleanup() {
    console.log('\n🧹 Очистка...');
    try {
        // Удаляем lock файл Telegram бота
        if (fs.existsSync(lockFile)) {
            fs.unlinkSync(lockFile);
        }
        // Удаляем временные файлы
        if (fs.existsSync('mc_command.txt')) {
            fs.unlinkSync('mc_command.txt');
        }
        // Останавливаем MC бота
        if (mcBotProcess) {
            mcBotProcess.kill();
        }
        // Удаляем lock файл MC бота
        if (fs.existsSync(mcLockFile)) {
            fs.unlinkSync(mcLockFile);
        }
    } catch (err) {
        console.error('Ошибка очистки:', err.message);
    }
}

process.on('exit', cleanup);
process.on('SIGINT', () => {
    console.log('\n👋 Получен сигнал остановки...');
    cleanup();
    process.exit(0);
});
process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
});
process.on('uncaughtException', (err) => {
    console.error('❌ Критическая ошибка:', err);
    cleanup();
    process.exit(1);
});

// Создание Telegram бота
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
    console.log('✅ Telegram бот подключен!');
} catch (error) {
    console.error('❌ Ошибка запуска:', error.message);
    cleanup();
    process.exit(1);
}

// Обработка ошибок polling
bot.on('polling_error', (error) => {
    if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
        console.error('\n❌ ОШИБКА: Другой экземпляр Telegram бота уже работает!');
        console.log('\n🔧 Решение:');
        console.log('1. Закройте ВСЕ окна консоли');
        console.log('2. Выполните команду:');
        console.log('   Windows: taskkill /F /IM node.exe');
        console.log('3. Удалите файлы:');
        console.log('   del .telegram-bot.lock');
        console.log('   del .minecraft-bot.lock');
        console.log('4. Запустите бота снова\n');
        cleanup();
        process.exit(1);
    } else if (error.code === 'ETELEGRAM' && error.message.includes('401')) {
        console.error('\n❌ ОШИБКА: Неверный токен бота!');
        cleanup();
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
            ['🟢 Запустить MC бота', '🔴 Остановить MC бота'],
            ['📊 Статус', '📜 Логи'],
            ['⚙️ Настройки сервера', '📝 Команды'],
            ['🔄 Перезапуск MC бота', '🧹 Очистить логи']
        ],
        resize_keyboard: true
    }
};

const commandsKeyboard = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '⛏ Добыть ресурс', callback_data: 'cmd_mine' }],
            [{ text: '⚔️ Атаковать моба', callback_data: 'cmd_attack' }],
            [{ text: '🏠 Построить убежище', callback_data: 'cmd_shelter' }],
            [{ text: '🛡 Режим охраны', callback_data: 'cmd_guard' }],
            [{ text: '📍 Найти структуру', callback_data: 'cmd_find' }],
            [{ text: '🏃 Следовать за мной', callback_data: 'cmd_come' }],
            [{ text: '🛑 Остановить действие', callback_data: 'cmd_stop' }],
            [{ text: '🎒 Показать инвентарь', callback_data: 'cmd_inventory' }],
            [{ text: '❤️ Проверить здоровье', callback_data: 'cmd_health' }],
            [{ text: '📍 Где ты?', callback_data: 'cmd_coords' }]
        ]
    }
};

// ============= ФУНКЦИИ УПРАВЛЕНИЯ БОТОМ =============

function addLog(message) {
    const timestamp = new Date().toLocaleTimeString('ru-RU');
    const logEntry = `[${timestamp}] ${message.trim()}`;
    botLogs.push(logEntry);
    if (botLogs.length > 100) {
        botLogs.shift();
    }
}

function startMCBot(chatId) {
    if (mcBotProcess) {
        bot.sendMessage(chatId, '⚠️ Minecraft бот уже запущен!');
        return;
    }

    // Удаляем старый lock файл MC бота если есть
    if (fs.existsSync(mcLockFile)) {
        fs.unlinkSync(mcLockFile);
    }

    // Проверяем наличие файла bot.js
    if (!fs.existsSync(MC_BOT_FILE)) {
        bot.sendMessage(chatId, 
            '❌ Файл bot.js не найден!\n\n' +
            'Убедитесь, что файл с Minecraft ботом называется bot.js'
        );
        return;
    }

    // Запускаем процесс
    mcBotProcess = spawn('node', [MC_BOT_FILE], {
        env: { 
            ...process.env, 
            MC_HOST: currentServer.host, 
            MC_PORT: currentServer.port.toString(),
            MC_LOCK_FILE: mcLockFile
        }
    });

    botStatus = 'online';
    addLog('🚀 Запуск Minecraft бота...');

    // Обработка вывода
    mcBotProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                addLog(line);
                console.log('MC:', line.trim());
            }
        });
    });

    mcBotProcess.stderr.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                addLog('❌ ' + line);
                console.error('MC Error:', line.trim());
            }
        });
    });

    mcBotProcess.on('close', (code) => {
        mcBotProcess = null;
        botStatus = 'offline';
        const msg = `⚠️ Minecraft бот остановлен (код: ${code})`;
        addLog(msg);
        bot.sendMessage(chatId, msg);
        
        // Удаляем lock файл MC бота
        if (fs.existsSync(mcLockFile)) {
            fs.unlinkSync(mcLockFile);
        }
    });

    bot.sendMessage(chatId, 
        `✅ *Minecraft бот запущен!*\n\n` +
        `📡 Сервер: \`${currentServer.host}:${currentServer.port}\`\n` +
        `🤖 Ник бота: Helper\n` +
        `👤 Хозяин: SalRuzO\n\n` +
        `Используйте кнопку "📝 Команды" для управления`, 
        { ...mainKeyboard, parse_mode: 'Markdown' }
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
    addLog('🔴 MC бот остановлен вручную');
    bot.sendMessage(chatId, '🔴 Minecraft бот остановлен', mainKeyboard);
    
    // Удаляем lock файл MC бота
    if (fs.existsSync(mcLockFile)) {
        fs.unlinkSync(mcLockFile);
    }
}

function sendCommandToMCBot(command) {
    if (!mcBotProcess) return false;
    
    // Записываем команду в файл
    fs.writeFileSync('mc_command.txt', command);
    addLog(`📤 Команда: ${command}`);
    return true;
}

function isAllowed(userId) {
    return ALLOWED_USERS.includes(userId);
}

// ============= ОБРАБОТЧИКИ TELEGRAM =============

// Команда /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAllowed(msg.from.id)) {
        bot.sendMessage(chatId, 
            '❌ *Доступ запрещён!*\n\n' +
            `Ваш ID: \`${msg.from.id}\``,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    bot.sendMessage(chatId, 
        '🤖 *Minecraft Bot Controller*\n\n' +
        '✅ Система управления активна!\n\n' +
        'Используйте кнопки для управления:', 
        { ...mainKeyboard, parse_mode: 'Markdown' }
    );
});

// Команда изменения сервера
bot.onText(/\/server (.+) (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!isAllowed(msg.from.id)) return;
    
    currentServer.host = match[1];
    currentServer.port = parseInt(match[2]);
    
    bot.sendMessage(chatId, 
        `✅ *Сервер изменён!*\n\n` +
        `IP: \`${currentServer.host}\`\n` +
        `Порт: \`${currentServer.port}\`\n\n` +
        `⚠️ Перезапустите MC бота`,
        { parse_mode: 'Markdown' }
    );
});

// Обработка текстовых сообщений
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (!isAllowed(msg.from.id)) return;
    if (!text || text.startsWith('/')) return;

    switch(text) {
        case '🟢 Запустить MC бота':
            startMCBot(chatId);
            break;
            
        case '🔴 Остановить MC бота':
            stopMCBot(chatId);
            break;
            
        case '📊 Статус':
            const statusEmoji = botStatus === 'online' ? '🟢' : '🔴';
            const processInfo = mcBotProcess ? 
                `PID: ${mcBotProcess.pid}` : 
                'Процесс не запущен';
                
            bot.sendMessage(chatId, 
                `*📊 Статус системы*\n\n` +
                `MC Бот: ${statusEmoji} ${botStatus}\n` +
                `Telegram Бот: 🟢 online\n` +
                `Сервер: \`${currentServer.host}:${currentServer.port}\`\n` +
                `${processInfo}`,
                { parse_mode: 'Markdown' }
            );
            break;
            
        case '📜 Логи':
            if (botLogs.length === 0) {
                bot.sendMessage(chatId, '📜 Логи пусты');
            } else {
                const logs = botLogs.slice(-15).join('\n');
                bot.sendMessage(chatId, `📜 *Последние логи:*\n\`\`\`\n${logs}\n\`\`\``, 
                    { parse_mode: 'Markdown' });
            }
            break;
            
        case '🧹 Очистить логи':
            botLogs = [];
            bot.sendMessage(chatId, '✅ Логи очищены');
            break;
            
        case '⚙️ Настройки сервера':
            bot.sendMessage(chatId, 
                `*⚙️ Настройки сервера*\n\n` +
                `IP: \`${currentServer.host}\`\n` +
                `Порт: \`${currentServer.port}\`\n\n` +
                `Изменить: /server [IP] [порт]`,
                { parse_mode: 'Markdown' }
            );
            break;
            
        case '📝 Команды':
            if (!mcBotProcess) {
                bot.sendMessage(chatId, '⚠️ Сначала запустите MC бота!');
            } else {
                bot.sendMessage(chatId, 
                    '*📝 Выберите команду:*',
                    { ...commandsKeyboard, parse_mode: 'Markdown' }
                );
            }
            break;
            
        case '🔄 Перезапуск MC бота':
            if (mcBotProcess) {
                bot.sendMessage(chatId, '🔄 Перезапускаю MC бота...');
                stopMCBot(chatId);
                setTimeout(() => startMCBot(chatId), 2000);
            } else {
                bot.sendMessage(chatId, '⚠️ MC бот не запущен');
            }
            break;
    }
});

// Обработка inline кнопок
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    
    if (!isAllowed(query.from.id)) {
        bot.answerCallbackQuery(query.id, { text: '❌ Доступ запрещён!' });
        return;
    }
    
    if (!mcBotProcess) {
        bot.answerCallbackQuery(query.id, { text: '⚠️ MC бот не запущен!' });
        return;
    }
    
    switch(data) {
        case 'cmd_mine':
            bot.answerCallbackQuery(query.id);
            await bot.sendMessage(chatId, 
                '⛏ *Что добыть?*\n\n' +
                'Примеры: железная руда, алмаз, дерево, камень',
                { parse_mode: 'Markdown' }
            );
            bot.once('message', (msg) => {
                if (msg.from.id === query.from.id) {
                    sendCommandToMCBot(`добудь ${msg.text}`);
                    bot.sendMessage(chatId, `✅ Отправлено: добудь ${msg.text}`);
                }
            });
            break;
            
        case 'cmd_attack':
            bot.answerCallbackQuery(query.id);
            await bot.sendMessage(chatId, 
                '⚔️ *Кого атаковать?*\n\n' +
                'Примеры: зомби, скелет, крипер, паук',
                { parse_mode: 'Markdown' }
            );
            bot.once('message', (msg) => {
                if (msg.from.id === query.from.id) {
                    sendCommandToMCBot(`убей ${msg.text}`);
                    bot.sendMessage(chatId, `✅ Отправлено: убей ${msg.text}`);
                }
            });
            break;
            
        case 'cmd_shelter':
            sendCommandToMCBot('построй убежище');
            bot.answerCallbackQuery(query.id, { text: '🏠 Строю...' });
            bot.sendMessage(chatId, '✅ Команда: построй убежище');
            break;
            
        case 'cmd_guard':
            sendCommandToMCBot('будь на стороже');
            bot.answerCallbackQuery(query.id, { text: '🛡 Охраняю!' });
            bot.sendMessage(chatId, '✅ Режим охраны активирован');
            break;
            
        case 'cmd_find':
            bot.answerCallbackQuery(query.id);
            await bot.sendMessage(chatId, 
                '📍 *Что найти?*\n\n' +
                'Примеры: деревня, шахта, портал, храм',
                { parse_mode: 'Markdown' }
            );
            bot.once('message', (msg) => {
                if (msg.from.id === query.from.id) {
                    sendCommandToMCBot(`найди ${msg.text}`);
                    bot.sendMessage(chatId, `✅ Отправлено: найди ${msg.text}`);
                }
            });
            break;
            
        case 'cmd_come':
            sendCommandToMCBot('ко мне');
            bot.answerCallbackQuery(query.id, { text: '🏃 Иду!' });
            bot.sendMessage(chatId, '✅ Бот идёт к вам');
            break;
            
        case 'cmd_stop':
            sendCommandToMCBot('стой');
            bot.answerCallbackQuery(query.id, { text: '🛑 Стоп!' });
            bot.sendMessage(chatId, '✅ Бот остановлен');
            break;
            
        case 'cmd_inventory':
            sendCommandToMCBot('инвентарь');
            bot.answerCallbackQuery(query.id, { text: '🎒 Проверяю...' });
            bot.sendMessage(chatId, '✅ Запрос инвентаря');
            break;
            
        case 'cmd_health':
            sendCommandToMCBot('здоровье');
            bot.answerCallbackQuery(query.id, { text: '❤️ Проверяю...' });
            bot.sendMessage(chatId, '✅ Запрос здоровья');
            break;
            
        case 'cmd_coords':
            sendCommandToMCBot('координаты');
            bot.answerCallbackQuery(query.id, { text: '📍 Проверяю...' });
            bot.sendMessage(chatId, '✅ Запрос координат');
            break;
            
        default:
            bot.answerCallbackQuery(query.id);
    }
});

// Прямая отправка команд через /cmd
bot.onText(/\/cmd (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!isAllowed(msg.from.id)) return;
    
    if (!mcBotProcess) {
        bot.sendMessage(chatId, '⚠️ Minecraft бот не запущен!');
        return;
    }
    
    const command = match[1];
    sendCommandToMCBot(command);
    bot.sendMessage(chatId, `✅ Команда отправлена: ${command}`);
});

// ============= ЗАПУСК =============
console.log('========================================');
console.log('✅ Telegram бот успешно запущен!');
console.log('========================================');
console.log('📱 ID пользователя:', ALLOWED_USERS[0]);
console.log('📁 MC бот файл:', MC_BOT_FILE);
console.log('📡 Сервер по умолчанию:', currentServer.host + ':' + currentServer.port);
console.log('========================================');
console.log('💬 Откройте Telegram и напишите /start');
console.log('========================================');
