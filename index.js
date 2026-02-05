const TelegramBot = require('node-telegram-bot-api');

// Ваш токен
const TELEGRAM_TOKEN = '8512207770:AAEKLtYEph7gleybGhF2lc7Gwq82Kj1yedM';
const ALLOWED_USERS = [1170970828];

// Создание бота
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log('✅ Бот запущен на BotHost!');

// Команда /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    
    if (!ALLOWED_USERS.includes(msg.from.id)) {
        bot.sendMessage(chatId, '❌ У вас нет доступа!');
        return;
    }
    
    bot.sendMessage(chatId, 
        '🤖 *Minecraft Bot Controller*\n\n' +
        '⚠️ *Внимание:*\n' +
        'Этот бот работает на хостинге и не может подключаться к Minecraft серверам.\n\n' +
        'Для полной функциональности запустите бота локально на вашем компьютере.\n\n' +
        '*Доступные команды:*\n' +
        '/start - Начало работы\n' +
        '/help - Помощь\n' +
        '/status - Статус\n' +
        '/info - Информация',
        { parse_mode: 'Markdown' }
    );
});

// Команда /help
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    
    if (!ALLOWED_USERS.includes(msg.from.id)) return;
    
    bot.sendMessage(chatId,
        '*📚 Инструкция по запуску локально:*\n\n' +
        '1. Скачайте файлы с GitHub\n' +
        '2. Установите Node.js\n' +
        '3. Выполните: `npm install`\n' +
        '4. Запустите: `node telegram-bot.js`\n\n' +
        '*Требуемые файлы:*\n' +
        '• telegram-bot.js\n' +
        '• bot.js\n' +
        '• package.json',
        { parse_mode: 'Markdown' }
    );
});

// Команда /status
bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    
    if (!ALLOWED_USERS.includes(msg.from.id)) return;
    
    bot.sendMessage(chatId,
        '*📊 Статус:*\n\n' +
        '🟢 Telegram бот: Работает\n' +
        '🔴 Minecraft бот: Недоступен на хостинге\n\n' +
        'Хостинг: BotHost\n' +
        'Версия Node.js: 18.20.8',
        { parse_mode: 'Markdown' }
    );
});

// Команда /info
bot.onText(/\/info/, (msg) => {
    const chatId = msg.chat.id;
    
    if (!ALLOWED_USERS.includes(msg.from.id)) return;
    
    bot.sendMessage(chatId,
        '*ℹ️ Информация:*\n\n' +
        'Этот бот предназначен для управления Minecraft ботом.\n\n' +
        '*Ограничения хостинга:*\n' +
        '• Нельзя подключаться к игровым серверам\n' +
        '• Нельзя запускать дочерние процессы\n' +
        '• Ограниченная память и CPU\n\n' +
        '*Рекомендация:*\n' +
        'Запустите бота на своём компьютере или VPS для полной функциональности.',
        { parse_mode: 'Markdown' }
    );
});

// Обработка ошибок
bot.on('polling_error', (error) => {
    console.log('Polling error:', error);
});

bot.on('error', (error) => {
    console.log('Error:', error);
});
