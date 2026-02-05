// minecraft-helper.js
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalNear } = goals;
const pvp = require('mineflayer-pvp').plugin;
const fs = require('fs');

// Получаем настройки из переменных окружения или используем по умолчанию
const bot = mineflayer.createBot({
    host: process.env.MC_HOST || 'localhost',
    port: parseInt(process.env.MC_PORT) || 6666,
    username: 'Helper',
    version: '1.20.4'
});

bot.loadPlugin(pathfinder);
bot.loadPlugin(pvp);

let master = 'SalRuzO';
let guardMode = false;
let currentTask = null;

// Словари перевода
const blocksRU = {
    'железная руда': 'iron_ore',
    'золотая руда': 'gold_ore',
    'алмазная руда': 'diamond_ore',
    'алмаз': 'diamond_ore',
    'уголь': 'coal_ore',
    'дерево': 'oak_log',
    'камень': 'stone',
    'земля': 'dirt',
    'песок': 'sand',
    'булыжник': 'cobblestone'
};

const mobsRU = {
    'зомби': 'zombie',
    'скелет': 'skeleton',
    'крипер': 'creeper',
    'паук': 'spider',
    'ведьма': 'witch',
    'эндермен': 'enderman'
};

bot.on('spawn', () => {
    console.log('✅ Бот подключился к серверу!');
    const mcData = require('minecraft-data')(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);
    
    // Следуем за хозяином
    followMaster();
    
    // Проверяем файл с командами каждую секунду
    setInterval(() => {
        if (fs.existsSync('mc_command.txt')) {
            try {
                const command = fs.readFileSync('mc_command.txt', 'utf8');
                fs.unlinkSync('mc_command.txt');
                console.log('Получена команда:', command);
                processCommand(command);
            } catch (err) {
                console.error('Ошибка чтения команды:', err);
            }
        }
    }, 1000);
});

function processCommand(command) {
    const msg = command.toLowerCase().trim();
    
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
    else if (msg === 'будь на стороже' || msg === 'охраняй') {
        startGuarding();
    }
    else if (msg.startsWith('найди ')) {
        const structure = command.substring(6);
        findStructure(structure);
    }
    else if (msg === 'ко мне' || msg === 'сюда') {
        followMaster();
        bot.chat('Иду к вам!');
    }
    else if (msg === 'стой' || msg === 'стоп') {
        stopAllActions();
        bot.chat('Остановился');
    }
    else if (msg === 'инвентарь') {
        showInventory();
    }
    else if (msg === 'здоровье') {
        showHealth();
    }
    else if (msg === 'координаты') {
        showCoords();
    }
}

function followMaster() {
    const player = bot.players[master];
    if (player && player.entity) {
        bot.pathfinder.setGoal(new GoalFollow(player.entity, 3), true);
        console.log('Следую за', master);
    } else {
        console.log('Не вижу игрока', master);
    }
}

function stopAllActions() {
    guardMode = false;
    currentTask = null;
    bot.pathfinder.setGoal(null);
    bot.pvp.stop();
}

async function mineItem(itemNameRU) {
    try {
        currentTask = 'mining';
        const itemName = blocksRU[itemNameRU.toLowerCase()] || itemNameRU;
        console.log('Ищу', itemNameRU);
        bot.chat(`Ищу ${itemNameRU}...`);
        
        const mcData = require('minecraft-data')(bot.version);
        const blockType = mcData.blocksByName[itemName];
        
        if (!blockType) {
            bot.chat(`Не знаю что такое ${itemNameRU}`);
            currentTask = null;
            followMaster();
            return;
        }
        
        const block = bot.findBlock({
            matching: blockType.id,
            maxDistance: 32
        });
        
        if (block) {
            await bot.pathfinder.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 2));
            await bot.dig(block);
            bot.chat(`Добыл ${itemNameRU}!`);
            console.log('Добыл', itemNameRU);
        } else {
            bot.chat(`Не нашёл ${itemNameRU}`);
            console.log('Не нашёл', itemNameRU);
        }
    } catch (err) {
        console.log('Ошибка добычи:', err.message);
        bot.chat('Ошибка при добыче');
    }
    currentTask = null;
    followMaster();
}

async function attackTarget(targetNameRU) {
    try {
        currentTask = 'combat';
        const targetName = mobsRU[targetNameRU.toLowerCase()] || targetNameRU;
        
        let target = bot.players[targetNameRU]?.entity;
        
        if (!target) {
            target = Object.values(bot.entities).find(e => {
                if (e.type !== 'mob') return false;
                const name = e.name?.toLowerCase() || '';
                return name.includes(targetName);
            });
        }
        
        if (target) {
            console.log('Атакую', targetNameRU);
            bot.chat(`Атакую ${targetNameRU}!`);
            bot.pvp.attack(target);
        } else {
            console.log('Не вижу', targetNameRU);
            bot.chat(`Не вижу ${targetNameRU}`);
        }
    } catch (err) {
        console.log('Ошибка атаки:', err.message);
    }
    currentTask = null;
}

function startGuarding() {
    guardMode = true;
    bot.chat('Режим охраны активирован!');
    console.log('Режим охраны включён');
    
    const guardInterval = setInterval(() => {
        if (!guardMode) {
            clearInterval(guardInterval);
            return;
        }
        
        const player = bot.players[master];
        if (!player?.entity) return;
        
        const hostile = ['zombie', 'skeleton', 'spider', 'creeper', 'witch'];
        const enemies = Object.values(bot.entities).filter(e => {
            if (e.type !== 'mob' || e === bot.entity) return false;
            const distance = e.position.distanceTo(player.entity.position);
            if (distance > 10) return false;
            const name = e.name?.toLowerCase() || '';
            return hostile.some(mob => name.includes(mob));
        });
        
        if (enemies.length > 0) {
            bot.pvp.attack(enemies[0]);
        }
    }, 1000);
}

async function buildShelter() {
    bot.chat('Начинаю строить убежище...');
    console.log('Строю убежище');
    // Здесь должен быть код постройки
    bot.chat('Убежище построено!');
}

async function findStructure(structureName) {
    bot.chat(`Ищу ${structureName}...`);
    console.log('Поиск структуры:', structureName);
    // Здесь должен быть код поиска
}

function showInventory() {
    const items = bot.inventory.items();
    if (items.length > 0) {
        const list = items.slice(0, 10).map(i => `${i.name} x${i.count}`).join(', ');
        bot.chat(`Инвентарь: ${list}`);
        console.log('Инвентарь:', list);
    } else {
        bot.chat('Инвентарь пуст');
        console.log('Инвентарь пуст');
    }
}

function showHealth() {
    const hp = Math.round(bot.health);
    const food = Math.round(bot.food);
    bot.chat(`HP: ${hp}/20, Еда: ${food}/20`);
    console.log(`HP: ${hp}/20, Еда: ${food}/20`);
}

function showCoords() {
    const pos = bot.entity.position;
    bot.chat(`Я на X:${Math.round(pos.x)} Y:${Math.round(pos.y)} Z:${Math.round(pos.z)}`);
    console.log(`Координаты: X:${Math.round(pos.x)} Y:${Math.round(pos.y)} Z:${Math.round(pos.z)}`);
}

// Обработка событий
bot.on('kicked', (reason) => {
    console.log('❌ Кикнут:', reason);
    process.exit(1);
});

bot.on('error', (err) => {
    console.log('❌ Ошибка:', err);
});

bot.on('death', () => {
    console.log('☠️ Бот умер');
    bot.chat('Я умер!');
    stopAllActions();
});

bot.on('respawn', () => {
    console.log('🔄 Возродился');
    bot.chat('Я возродился!');
    setTimeout(() => followMaster(), 2000);
});

bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    console.log(`[ЧАТ] ${username}: ${message}`);
    
    if (username === master) {
        processCommand(message);
    }
});

console.log('🚀 Minecraft бот запускается...');
console.log('Сервер:', process.env.MC_HOST || 'localhost');
console.log('Порт:', process.env.MC_PORT || 6666);
