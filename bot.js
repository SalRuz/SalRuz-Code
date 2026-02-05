const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============= НАСТРОЙКИ =============
const TELEGRAM_TOKEN = '8512207770:AAEKLtYEph7gleybGhF2lc7Gwq82Kj1yedM';
const ALLOWED_USERS = [1170970828];
const MC_BOT_FILE = 'bot.js';

// ============= ПРОВЕРКА LOCK ФАЙЛА =============
const lockFile = '.bot.lock';

// Функция проверки живого процесса
function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

// Проверяем существующий lock файл
if (fs.existsSync(lockFile)) {
    try {
        const oldPid = parseInt(fs.readFileSync(lockFile, 'utf8'));
        
        // Проверяем, жив ли старый процесс
        if (isProcessRunning(oldPid)) {
            console.log('⚠️ Бот уже запущен (PID:', oldPid, ')');
            console.log('Остановите его командой:');
            console.log('  Windows: taskkill /PID', oldPid, '/F');
            console.log('  Linux/Mac: kill', oldPid);
            console.log('\nИли удалите файл .bot.lock вручную');
            process.exit(1);
        } else {
            // Старый процесс мёртв, удаляем lock
            console.log('🧹 Удаляю старый lock файл...');
            fs.unlinkSync(lockFile);
        }
    } catch (err) {
        // Ошибка чтения - удаляем lock
        fs.unlinkSync(lockFile);
    }
}

// Создаём новый lock файл
fs.writeFileSync(lockFile, process.pid.toString());
console.log('🔒 Lock файл создан (PID:', process.pid, ')');

// Очистка при выходе
function cleanup() {
    console.log('\n🧹 Очистка...');
    try {
        if (fs.existsSync(lockFile)) {
            fs.unlinkSync(lockFile);
        }
        if (fs.existsSync('mc_command.txt')) {
            fs.unlinkSync('mc_command.txt');
        }
        if (mcBotProcess) {
            mcBotProcess.kill();
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
        console.error('\n❌ ОШИБКА: Другой экземпляр бота уже работает!');
        console.log('\n🔧 Решение:');
        console.log('1. Закройте ВСЕ окна консоли');
        console.log('2. Выполните команду:');
        console.log('   Windows: taskkill /F /IM node.exe');
        console.log('   Linux/Mac: killall node');
        console.log('3. Удалите файл: del .bot.lock (или rm .bot.lock)');
        console.log('4. Запустите бота снова\n');
        cleanup();
        process.exit(1);
    } else if (error.code === 'ETELEGRAM' && error.message.includes('401')) {
        console.error('\n❌ ОШИБКА: Неверный токен бота!');
        console.log('Проверьте токен в настройках\n');
        cleanup();
        process.exit(1);
    } else {
        console.error('Polling error:', error.message);
    }
});

bot.on('error', (error) => {
    console.error('Bot error:', error.message);
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
            ['⚙️ Настройки сервера', '📝 Команды'],
            ['🔄 Перезапуск бота', '❌ Выключить всё']
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
    console.log('MC:', message.trim());
}

function startMCBot(chatId) {
    if (mcBotProcess) {
        bot.sendMessage(chatId, '⚠️ Minecraft бот уже запущен!');
        return;
    }

    // Проверяем наличие файла bot.js
    if (!fs.existsSync(MC_BOT_FILE)) {
        bot.sendMessage(chatId, 
            '❌ Файл bot.js не найден!\n\n' +
            'Убедитесь, что файл с Minecraft ботом называется bot.js и находится в той же папке.'
        );
        return;
    }

    // Запускаем процесс
    mcBotProcess = spawn('node', [MC_BOT_FILE], {
        env: { 
            ...process.env, 
            MC_HOST: currentServer.host, 
            MC_PORT: currentServer.port.toString(),
            MC_MASTER: 'SalRuzO'
        }
    });

    botStatus = 'online';
    botLogs = [];
    addLog('🚀 Запуск Minecraft бота...');

    // Обработка вывода
    mcBotProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
            if (line.trim()) addLog(line);
        });
    });

    mcBotProcess.stderr.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
            if (line.trim()) addLog('❌ ' + line);
        });
    });

    mcBotProcess.on('close', (code) => {
        mcBotProcess = null;
        botStatus = 'offline';
        const msg = `⚠️ Minecraft бот остановлен (код: ${code})`;
        addLog(msg);
        bot.sendMessage(chatId, msg);
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
    addLog('🔴 Бот остановлен вручную');
    bot.sendMessage(chatId, '🔴 Minecraft бот остановлен', mainKeyboard);
}

function sendCommandToMCBot(command) {
    if (!mcBotProcess) return false;
    
    // Записываем команду в файл, который читает MC бот
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
            `Ваш ID: \`${msg.from.id}\`\n` +
            'Этот бот приватный.',
            { parse_mode: 'Markdown' }
        );
        return;
    }

    bot.sendMessage(chatId, 
        '🤖 *Minecraft Bot Controller*\n\n' +
        '✅ Система управления активна!\n\n' +
        '*Возможности:*\n' +
        '• Запуск и остановка бота\n' +
        '• Отправка команд в игру\n' +
        '• Мониторинг состояния\n' +
        '• Просмотр логов\n\n' +
        'Используйте кнопки ниже для управления:', 
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
        `⚠️ Перезапустите бота для применения`,
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
        case '🟢 Запустить бота':
            startMCBot(chatId);
            break;
            
        case '🔴 Остановить бота':
            stopMCBot(chatId);
            break;
            
        case '📊 Статус':
            const statusEmoji = botStatus === 'online' ? '🟢' : '🔴';
            const processInfo = mcBotProcess ? 
                `PID: ${mcBotProcess.pid}\nUptime: ${Math.floor(process.uptime())}с` : 
                'Процесс не запущен';
                
            bot.sendMessage(chatId, 
                `*📊 Статус системы*\n\n` +
                `Бот: ${statusEmoji} ${botStatus}\n` +
                `Сервер: \`${currentServer.host}:${currentServer.port}\`\n` +
                `${processInfo}`,
                { parse_mode: 'Markdown' }
            );
            break;
            
        case '📜 Логи':
            if (botLogs.length === 0) {
                bot.sendMessage(chatId, '📜 Логи пусты');
            } else {
                const logs = botLogs.slice(-20).join('\n');
                // Разбиваем на части если слишком длинный
                if (logs.length > 4000) {
                    const part1 = logs.substring(0, 4000);
                    const part2 = logs.substring(4000);
                    bot.sendMessage(chatId, `📜 *Логи (часть 1):*\n\`\`\`\n${part1}\n\`\`\``, 
                        { parse_mode: 'Markdown' });
                    if (part2) {
                        bot.sendMessage(chatId, `📜 *Логи (часть 2):*\n\`\`\`\n${part2}\n\`\`\``, 
                            { parse_mode: 'Markdown' });
                    }
                } else {
                    bot.sendMessage(chatId, `📜 *Последние логи:*\n\`\`\`\n${logs}\n\`\`\``, 
                        { parse_mode: 'Markdown' });
                }
            }
            break;
            
        case '⚙️ Настройки сервера':
            bot.sendMessage(chatId, 
                `*⚙️ Настройки сервера*\n\n` +
                `IP: \`${currentServer.host}\`\n` +
                `Порт: \`${currentServer.port}\`\n\n` +
                `*Для изменения используйте:*\n` +
                `/server [IP] [порт]\n\n` +
                `*Примеры:*\n` +
                `/server localhost 25565\n` +
                `/server mc.hypixel.net 25565\n` +
                `/server 192.168.1.100 25565`,
                { parse_mode: 'Markdown' }
            );
            break;
            
        case '📝 Команды':
            if (!mcBotProcess) {
                bot.sendMessage(chatId, '⚠️ Сначала запустите бота!');
            } else {
                bot.sendMessage(chatId, 
                    '*📝 Выберите команду для отправки:*',
                    { ...commandsKeyboard, parse_mode: 'Markdown' }
                );
            }
            break;
            
        case '🔄 Перезапуск бота':
            if (mcBotProcess) {
                bot.sendMessage(chatId, '🔄 Перезапускаю бота...');
                stopMCBot(chatId);
                setTimeout(() => startMCBot(chatId), 2000);
            } else {
                bot.sendMessage(chatId, '⚠️ Бот не запущен');
            }
            break;
            
        case '❌ Выключить всё':
            bot.sendMessage(chatId, '👋 Выключаю систему...').then(() => {
                cleanup();
                process.exit(0);
            });
            break;
    }
});

// Обработка inline кнопок (команд)
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    
    if (!isAllowed(query.from.id)) {
        bot.answerCallbackQuery(query.id, { text: '❌ Доступ запрещён!' });
        return;
    }
    
    if (!mcBotProcess) {
        bot.answerCallbackQuery(query.id, { text: '⚠️ Бот не запущен!' });
        return;
    }
    
    switch(data) {
        case 'cmd_mine':
            bot.answerCallbackQuery(query.id);
            await bot.sendMessage(chatId, 
                '⛏ *Что добыть?*\n\n' +
                'Напишите название блока на русском:\n' +
                'Например: железная руда, алмаз, дерево, камень',
                { parse_mode: 'Markdown' }
            );
            bot.once('message', (msg) => {
                if (msg.from.id === query.from.id) {
                    sendCommandToMCBot(`добудь ${msg.text}`);
                    bot.sendMessage(chatId, `✅ Команда отправлена: добудь ${msg.text}`);
                }
            });
            break;
            
        case 'cmd_attack':
            bot.answerCallbackQuery(query.id);
            await bot.sendMessage(chatId, 
                '⚔️ *Кого атаковать?*\n\n' +
                'Напишите название моба:\n' +
                'Например: зомби, скелет, крипер, паук',
                { parse_mode: 'Markdown' }
            );
            bot.once('message', (msg) => {
                if (msg.from.id === query.from.id) {
                    sendCommandToMCBot(`убей ${msg.text}`);
                    bot.sendMessage(chatId, `✅ Команда отправлена: убей ${msg.text}`);
                }
            });
            break;
            
        case 'cmd_shelter':
            sendCommandToMCBot('построй убежище');
            bot.answerCallbackQuery(query.id, { text: '🏠 Строю убежище...' });
            bot.sendMessage(chatId, '✅ Команда отправлена: построй убежище');
            break;
            
        case 'cmd_guard':
            sendCommandToMCBot('будь на стороже');
            bot.answerCallbackQuery(query.id, { text: '🛡 Режим охраны!' });
            bot.sendMessage(chatId, '✅ Режим охраны активирован');
            break;
            
        case 'cmd_find':
            bot.answerCallbackQuery(query.id);
            await bot.sendMessage(chatId, 
                '📍 *Что найти?*\n\n' +
                'Напишите что искать:\n' +
                'Например: деревня, шахта, портал, храм',
                { parse_mode: 'Markdown' }
            );
            bot.once('message', (msg) => {
                if (msg.from.id === query.from.id) {
                    sendCommandToMCBot(`найди ${msg.text}`);
                    bot.sendMessage(chatId, `✅ Команда отправлена: найди ${msg.text}`);
                }
            });
            break;
            
        case 'cmd_come':
            sendCommandToMCBot('ко мне');
            bot.answerCallbackQuery(query.id, { text: '🏃 Иду к вам!' });
            bot.sendMessage(chatId, '✅ Бот идёт к вам');
            break;
            
        case 'cmd_stop':
            sendCommandToMCBot('стой');
            bot.answerCallbackQuery(query.id, { text: '🛑 Остановлен!' });
            bot.sendMessage(chatId, '✅ Бот остановлен');
            break;
            
        case 'cmd_inventory':
            sendCommandToMCBot('инвентарь');
            bot.answerCallbackQuery(query.id, { text: '🎒 Проверяю...' });
            bot.sendMessage(chatId, '✅ Запрос инвентаря отправлен');
            break;
            
        case 'cmd_health':
            sendCommandToMCBot('здоровье');
            bot.answerCallbackQuery(query.id, { text: '❤️ Проверяю...' });
            bot.sendMessage(chatId, '✅ Запрос здоровья отправлен');
            break;
            
        case 'cmd_coords':
            sendCommandToMCBot('координаты');
            bot.answerCallbackQuery(query.id, { text: '📍 Проверяю...' });
            bot.sendMessage(chatId, '✅ Запрос координат отправлен');
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
console.log('📱 Разрешённый ID:', ALLOWED_USERS[0]);
console.log('📁 MC бот файл:', MC_BOT_FILE);
console.log('📡 Сервер по умолчанию:', currentServer.host + ':' + currentServer.port);
console.log('========================================');
console.log('💬 Откройте Telegram и напишите /start');
console.log('========================================');
