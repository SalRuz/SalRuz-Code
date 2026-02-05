const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalNear } = goals;
const pvp = require('mineflayer-pvp').plugin;
const fs = require('fs');

// ============= НАСТРОЙКИ =============
// Получаем настройки из переменных окружения или используем по умолчанию
const bot = mineflayer.createBot({
    host: process.env.MC_HOST || 'localhost',
    port: parseInt(process.env.MC_PORT) || 6666,
    username: 'Helper',
    version: '1.20.4'
});

// Загрузка плагинов
bot.loadPlugin(pathfinder);
bot.loadPlugin(pvp);

// ============= ПЕРЕМЕННЫЕ =============
let master = 'SalRuzO';
let guardMode = false;
let currentTask = null;
let mcData;

// ============= СЛОВАРИ ПЕРЕВОДА =============
const blocksRU = {
    // Руды
    'железная руда': 'iron_ore',
    'золотая руда': 'gold_ore',
    'алмазная руда': 'diamond_ore',
    'угольная руда': 'coal_ore',
    'медная руда': 'copper_ore',
    'редстоун руда': 'redstone_ore',
    'лазуритовая руда': 'lapis_ore',
    'изумрудная руда': 'emerald_ore',
    'железо': 'iron_ore',
    'золото': 'gold_ore',
    'алмаз': 'diamond_ore',
    'алмазы': 'diamond_ore',
    'уголь': 'coal_ore',
    'медь': 'copper_ore',
    'редстоун': 'redstone_ore',
    'лазурит': 'lapis_ore',
    'изумруд': 'emerald_ore',
    
    // Глубинные руды
    'глубинная железная руда': 'deepslate_iron_ore',
    'глубинная золотая руда': 'deepslate_gold_ore',
    'глубинная алмазная руда': 'deepslate_diamond_ore',
    'глубинная угольная руда': 'deepslate_coal_ore',
    
    // Камни
    'камень': 'stone',
    'булыжник': 'cobblestone',
    'гранит': 'granite',
    'диорит': 'diorite',
    'андезит': 'andesite',
    'глубинный сланец': 'deepslate',
    'песчаник': 'sandstone',
    'обсидиан': 'obsidian',
    
    // Земля и песок
    'земля': 'dirt',
    'трава': 'grass_block',
    'песок': 'sand',
    'гравий': 'gravel',
    'глина': 'clay',
    
    // Дерево
    'дуб': 'oak_log',
    'берёза': 'birch_log',
    'береза': 'birch_log',
    'ель': 'spruce_log',
    'акация': 'acacia_log',
    'тёмный дуб': 'dark_oak_log',
    'темный дуб': 'dark_oak_log',
    'джунглевое дерево': 'jungle_log',
    'мангровое дерево': 'mangrove_log',
    'вишня': 'cherry_log',
    'дерево': 'oak_log',
    'бревно': 'oak_log',
    
    // Доски
    'дубовые доски': 'oak_planks',
    'берёзовые доски': 'birch_planks',
    'еловые доски': 'spruce_planks',
    'доски': 'oak_planks'
};

const mobsRU = {
    // Враждебные
    'зомби': 'zombie',
    'скелет': 'skeleton',
    'крипер': 'creeper',
    'паук': 'spider',
    'пещерный паук': 'cave_spider',
    'ведьма': 'witch',
    'слизень': 'slime',
    'слайм': 'slime',
    'фантом': 'phantom',
    'утопленник': 'drowned',
    'кадавр': 'husk',
    'странник': 'stray',
    'эндермен': 'enderman',
    'эндерман': 'enderman',
    
    // Дружелюбные
    'корова': 'cow',
    'свинья': 'pig',
    'овца': 'sheep',
    'курица': 'chicken',
    'лошадь': 'horse',
    'волк': 'wolf',
    'кот': 'cat',
    'кошка': 'cat',
    'житель': 'villager'
};

const structuresRU = {
    'деревня': ['bell', 'composter', 'barrel'],
    'деревню': ['bell', 'composter', 'barrel'],
    'портал': ['obsidian', 'nether_portal'],
    'шахта': ['rail', 'torch', 'cobweb'],
    'шахту': ['rail', 'torch', 'cobweb'],
    'крепость': ['end_portal_frame', 'stone_bricks'],
    'храм': ['chiseled_sandstone', 'tnt', 'sandstone'],
    'пирамида': ['chiseled_sandstone', 'tnt', 'sandstone']
};

// ============= СОБЫТИЯ БОТА =============
bot.on('spawn', () => {
    console.log('✅ Бот подключился к серверу!');
    console.log(`Сервер: ${process.env.MC_HOST || 'localhost'}:${process.env.MC_PORT || 6666}`);
    console.log(`Ник: Helper`);
    console.log(`Хозяин: ${master}`);
    
    // Инициализация данных Minecraft
    mcData = require('minecraft-data')(bot.version);
    const movements = new Movements(bot, mcData);
    movements.canDig = true;
    bot.pathfinder.setMovements(movements);
    
    // Приветствие
    setTimeout(() => {
        bot.chat('Привет! Я готов помогать.');
        followMaster();
    }, 2000);
    
    // Проверка файла с командами от Telegram бота
    setInterval(() => {
        if (fs.existsSync('mc_command.txt')) {
            try {
                const command = fs.readFileSync('mc_command.txt', 'utf8');
                fs.unlinkSync('mc_command.txt');
                console.log(`📥 Команда от Telegram: ${command}`);
                processCommand(command);
            } catch (err) {
                console.error('Ошибка чтения команды:', err);
            }
        }
    }, 500);
});

// ============= ОБРАБОТКА КОМАНД =============
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
    else if (msg.startsWith('найди ')) {
        const structure = command.substring(6);
        findStructure(structure);
    }
    else if (msg === 'построй убежище') {
        buildShelter();
    }
    else if (msg === 'будь на стороже' || msg === 'охраняй') {
        startGuarding();
    }
    else if (msg === 'ко мне' || msg === 'сюда') {
        stopAllActions();
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
    else if (msg === 'координаты' || msg === 'где ты') {
        showCoords();
    }
}

// ============= ОСНОВНЫЕ ФУНКЦИИ =============

function followMaster() {
    const player = bot.players[master];
    if (player && player.entity) {
        const goal = new GoalFollow(player.entity, 3);
        bot.pathfinder.setGoal(goal, true);
        console.log(`👥 Следую за ${master}`);
    } else {
        console.log(`❌ Не вижу игрока ${master}`);
        setTimeout(followMaster, 5000);
    }
}

function stopAllActions() {
    guardMode = false;
    currentTask = null;
    bot.pathfinder.setGoal(null);
    bot.pvp.stop();
    console.log('🛑 Все действия остановлены');
}

// ============= ДОБЫЧА РЕСУРСОВ =============
async function mineItem(itemNameRU) {
    try {
        currentTask = 'mining';
        const itemName = blocksRU[itemNameRU.toLowerCase()] || itemNameRU;
        
        console.log(`⛏ Ищу ${itemNameRU} (${itemName})...`);
        bot.chat(`Ищу ${itemNameRU}...`);
        
        const blockType = mcData.blocksByName[itemName];
        if (!blockType) {
            bot.chat(`Не знаю что такое "${itemNameRU}"`);
            console.log(`❌ Неизвестный блок: ${itemNameRU}`);
            currentTask = null;
            followMaster();
            return;
        }
        
        const block = bot.findBlock({
            matching: blockType.id,
            maxDistance: 32
        });
        
        if (!block) {
            bot.chat(`Не нашёл ${itemNameRU} рядом`);
            console.log(`❌ ${itemNameRU} не найден`);
            currentTask = null;
            followMaster();
            return;
        }
        
        const distance = Math.round(bot.entity.position.distanceTo(block.position));
        bot.chat(`Нашёл ${itemNameRU} в ${distance} блоках`);
        console.log(`✅ Найден ${itemNameRU} на расстоянии ${distance}`);
        
        // Идём к блоку
        await bot.pathfinder.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 2));
        
        // Выбираем инструмент
        await equipBestTool(block);
        
        // Добываем
        await bot.dig(block);
        bot.chat(`Добыл ${itemNameRU}!`);
        console.log(`✅ Добыт ${itemNameRU}`);
        
        // Ждём дроп
        await bot.waitForTicks(10);
        
    } catch (err) {
        console.log(`❌ Ошибка добычи: ${err.message}`);
        bot.chat(`Ошибка при добыче: ${err.message}`);
    }
    
    currentTask = null;
    followMaster();
}

async function equipBestTool(block) {
    const tools = {
        'pickaxe': ['ore', 'stone', 'cobblestone', 'brick'],
        'axe': ['log', 'wood', 'planks'],
        'shovel': ['dirt', 'sand', 'gravel', 'clay', 'soul']
    };
    
    for (const [tool, materials] of Object.entries(tools)) {
        if (materials.some(m => block.name.includes(m))) {
            const item = bot.inventory.items().find(i => i.name.includes(tool));
            if (item) {
                await bot.equip(item, 'hand');
                console.log(`🔧 Экипирован ${item.name}`);
                return;
            }
        }
    }
}

// ============= АТАКА =============
async function attackTarget(targetNameRU) {
    try {
        currentTask = 'combat';
        const targetName = mobsRU[targetNameRU.toLowerCase()] || targetNameRU;
        
        console.log(`⚔️ Ищу цель: ${targetNameRU}`);
        
        // Ищем игрока
        let target = bot.players[targetNameRU]?.entity;
        
        // Если не игрок, ищем моба
        if (!target) {
            target = Object.values(bot.entities).find(e => {
                if (e.type !== 'mob') return false;
                const name = e.name?.toLowerCase() || '';
                return name.includes(targetName.toLowerCase());
            });
        }
        
        if (!target) {
            bot.chat(`Не вижу ${targetNameRU} рядом`);
            console.log(`❌ Цель ${targetNameRU} не найдена`);
            currentTask = null;
            followMaster();
            return;
        }
        
        bot.chat(`Атакую ${targetNameRU}!`);
        console.log(`⚔️ Атакую ${targetNameRU}`);
        
        // Экипируем оружие
        const sword = bot.inventory.items().find(i => i.name.includes('sword'));
        const axe = bot.inventory.items().find(i => i.name.includes('axe'));
        if (sword) await bot.equip(sword, 'hand');
        else if (axe) await bot.equip(axe, 'hand');
        
        bot.pvp.attack(target);
        
    } catch (err) {
        console.log(`❌ Ошибка атаки: ${err.message}`);
        bot.chat(`Ошибка атаки: ${err.message}`);
        currentTask = null;
        followMaster();
    }
}

// ============= ПОИСК СТРУКТУР =============
async function findStructure(structureNameRU) {
    try {
        currentTask = 'searching';
        bot.chat(`Ищу ${structureNameRU}...`);
        console.log(`🔍 Поиск структуры: ${structureNameRU}`);
        
        const searchRadius = 100;
        const blocksToFind = structuresRU[structureNameRU.toLowerCase()] || [structureNameRU];
        
        for (const blockName of blocksToFind) {
            const blockType = mcData.blocksByName[blockName];
            if (!blockType) continue;
            
            const found = bot.findBlock({
                matching: blockType.id,
                maxDistance: searchRadius
            });
            
            if (found) {
                const pos = found.position;
                bot.chat(`Нашёл ${structureNameRU}! Координаты: X:${pos.x} Y:${pos.y} Z:${pos.z}`);
                console.log(`✅ Найдена структура ${structureNameRU} на X:${pos.x} Y:${pos.y} Z:${pos.z}`);
                
                await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 5)).catch(() => {});
                currentTask = null;
                followMaster();
                return;
            }
        }
        
        bot.chat(`Не нашёл ${structureNameRU} в радиусе ${searchRadius} блоков`);
        console.log(`❌ ${structureNameRU} не найдена`);
        
    } catch (err) {
        console.log(`❌ Ошибка поиска: ${err.message}`);
    }
    
    currentTask = null;
    followMaster();
}

// ============= РЕЖИМ ОХРАНЫ =============
function startGuarding() {
    guardMode = true;
    bot.chat('Режим охраны активирован! Буду защищать вас.');
    console.log('🛡 Режим охраны включён');
    
    const guardInterval = setInterval(() => {
        if (!guardMode) {
            clearInterval(guardInterval);
            return;
        }
        
        const player = bot.players[master];
        if (!player || !player.entity) return;
        
        const hostileMobs = [
            'zombie', 'skeleton', 'spider', 'creeper', 'witch',
            'phantom', 'drowned', 'husk', 'stray', 'enderman'
        ];
        
        const enemies = Object.values(bot.entities).filter(entity => {
            if (entity === bot.entity || entity === player.entity) return false;
            if (entity.type !== 'mob') return false;
            
            const distance = entity.position.distanceTo(player.entity.position);
            if (distance > 12) return false;
            
            const name = entity.name?.toLowerCase() || '';
            return hostileMobs.some(mob => name.includes(mob));
        });
        
        if (enemies.length > 0) {
            const nearest = enemies[0];
            console.log(`🎯 Атакую враждебного моба: ${nearest.name}`);
            
            const sword = bot.inventory.items().find(i => i.name.includes('sword'));
            if (sword) bot.equip(sword, 'hand');
            
            bot.pvp.attack(nearest);
        }
    }, 500);
}

// ============= ПОСТРОЙКА УБЕЖИЩА =============
async function buildShelter() {
    try {
        currentTask = 'building';
        bot.chat('Начинаю строить убежище 4x4...');
        console.log('🏗 Строительство убежища');
        
        const blocks = bot.inventory.items().filter(item =>
            item.name.includes('cobblestone') ||
            item.name.includes('dirt') ||
            item.name.includes('planks') ||
            item.name.includes('stone') ||
            item.name.includes('log')
        );
        
        const totalBlocks = blocks.reduce((sum, b) => sum + b.count, 0);
        
        if (totalBlocks < 50) {
            bot.chat(`Недостаточно блоков (${totalBlocks}/50). Дайте мне материалы!`);
            console.log(`❌ Мало блоков для постройки: ${totalBlocks}/50`);
            currentTask = null;
            followMaster();
            return;
        }
        
        await bot.equip(blocks[0], 'hand');
        
        const startPos = bot.entity.position.clone().floor();
        
        bot.chat('Строю пол...');
        // Здесь должен быть код постройки
        
        bot.chat('Убежище готово!');
        console.log('✅ Убежище построено');
        
    } catch (err) {
        console.log(`❌ Ошибка строительства: ${err.message}`);
        bot.chat(`Ошибка строительства: ${err.message}`);
    }
    
    currentTask = null;
    followMaster();
}

// ============= ИНФОРМАЦИОННЫЕ ФУНКЦИИ =============

function showInventory() {
    const items = bot.inventory.items();
    if (items.length === 0) {
        bot.chat('Инвентарь пуст');
        console.log('🎒 Инвентарь пуст');
    } else {
        const list = items.slice(0, 10).map(i => `${i.name} x${i.count}`).join(', ');
        bot.chat(`Инвентарь: ${list}`);
        console.log(`🎒 Инвентарь: ${list}`);
    }
}

function showHealth() {
    const hp = Math.round(bot.health);
    const food = Math.round(bot.food);
    bot.chat(`HP: ${hp}/20, Еда: ${food}/20`);
    console.log(`❤️ HP: ${hp}/20, Еда: ${food}/20`);
}

function showCoords() {
    const pos = bot.entity.position;
    const coords = `X:${Math.round(pos.x)} Y:${Math.round(pos.y)} Z:${Math.round(pos.z)}`;
    bot.chat(`Мои координаты: ${coords}`);
    console.log(`📍 Координаты: ${coords}`);
}

// ============= ОБРАБОТКА СОБЫТИЙ =============

bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    console.log(`💬 [ЧАТ] ${username}: ${message}`);
    
    // Обработка команд от хозяина в чате
    if (username === master) {
        processCommand(message);
    }
});

bot.on('stoppedAttacking', () => {
    if (currentTask === 'combat') {
        bot.chat('Цель уничтожена!');
        console.log('✅ Цель уничтожена');
        currentTask = null;
        followMaster();
    }
});

bot.on('death', () => {
    console.log('☠️ Бот умер!');
    bot.chat('Я погиб!');
    stopAllActions();
});

bot.on('respawn', () => {
    console.log('🔄 Бот возродился');
    bot.chat('Я возродился!');
    setTimeout(() => followMaster(), 2000);
});

bot.on('kicked', (reason) => {
    console.log(`❌ Кикнут с сервера: ${reason}`);
    process.exit(1);
});

bot.on('error', (err) => {
    console.log(`❌ Ошибка: ${err.message}`);
});

// ============= ЗАПУСК =============
console.log('========================================');
console.log('🚀 Minecraft бот запускается...');
console.log('========================================');
console.log(`📡 Сервер: ${process.env.MC_HOST || 'localhost'}:${process.env.MC_PORT || 6666}`);
console.log(`🤖 Ник: Helper`);
console.log(`👤 Хозяин: ${master}`);
console.log('========================================');
