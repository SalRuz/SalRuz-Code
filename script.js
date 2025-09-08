// Настройки
const BLOCK_SIZE = 50; // виртуальный размер блока в пикселях (для расчетов)
const GRAVITY = 0.5;
const JUMP_FORCE = -12;
const MOVE_SPEED = 3;

let player = {
    x: window.innerWidth / 2,
    y: 0, // начальная высота — 3 блока над землей
    vy: 0,
    grounded: false,
    mining: null, // текущий блок под добычей
    miningProgress: 0,
    walking: false
};

let inventory = [0, 0, 0]; // 3 ячейки
const MAX_STACK = 64;

let groundLayers = [];
let items = [];
let keys = {};

// Инициализация
window.onload = function() {
    initWorld();
    initControls();
    gameLoop();
};

function initWorld() {
    // Создаем 3 слоя земли
    const layers = document.querySelectorAll('.ground-layer');
    layers.forEach((layer, i) => {
        const z = i * -BLOCK_SIZE * 3; // расстояние между слоями
        layer.style.transform = `rotateX(60deg) translateZ(${z}px)`;
        groundLayers.push({
            element: layer,
            z: z,
            mined: false
        });
    });

    // Игрок спавнится на высоте 3 блоков
    player.y = -BLOCK_SIZE * 3;
}

function initControls() {
    const btnLeft = document.getElementById('btn-left');
    const btnRight = document.getElementById('btn-right');
    const btnJump = document.getElementById('btn-jump');
    const btnMine = document.getElementById('btn-mine');
    const walkSound = document.getElementById('walk-sound');

    btnLeft.addEventListener('touchstart', () => keys.left = true);
    btnLeft.addEventListener('touchend', () => keys.left = false);

    btnRight.addEventListener('touchstart', () => keys.right = true);
    btnRight.addEventListener('touchend', () => keys.right = false);

    btnJump.addEventListener('touchstart', jump);
    btnMine.addEventListener('touchstart', startMining);

    // Звук при ходьбе
    setInterval(() => {
        if ((keys.left || keys.right) && player.grounded && !walkSound.paused) {
            walkSound.currentTime = 0;
            walkSound.play().catch(e => console.log("Audio play failed:", e));
        }
    }, 500);
}

function jump() {
    if (player.grounded) {
        player.vy = JUMP_FORCE;
        player.grounded = false;
    }
}

function startMining() {
    // Ищем ближайший блок под ногами
    let targetLayer = null;
    for (let layer of groundLayers) {
        const screenY = getScreenYFromWorldZ(layer.z);
        if (Math.abs(player.y - screenY) < BLOCK_SIZE * 1.5 && !layer.mined) {
            targetLayer = layer;
            break;
        }
    }

    if (targetLayer && !player.mining) {
        player.mining = targetLayer;
        player.miningProgress = 0;

        const crack = document.createElement('div');
        crack.className = 'mine-animation';
        targetLayer.element.appendChild(crack);

        // Анимация 3 сек
        const interval = setInterval(() => {
            player.miningProgress += 1/60; // 60 FPS
            if (player.miningProgress >= 3) {
                clearInterval(interval);
                finishMining(targetLayer, crack);
            }
        }, 1000 / 60);
    }
}

function finishMining(layer, crackElement) {
    layer.mined = true;
    crackElement.remove();

    // Создаем предмет
    const item = document.createElement('div');
    item.className = 'item-earth';
    const worldX = player.x;
    const worldZ = layer.z;
    const screenY = getScreenYFromWorldZ(worldZ) - 50; // чуть выше блока

    item.style.left = `${worldX - 20}px`;
    item.style.top = `${screenY}px`;

    document.getElementById('items-container').appendChild(item);

    items.push({
        element: item,
        x: worldX,
        y: screenY,
        collected: false
    });
}

function collectItem(item) {
    if (item.collected) return;

    // Находим первую неполную ячейку
    let slotIndex = -1;
    for (let i = 0; i < inventory.length; i++) {
        if (inventory[i] < MAX_STACK) {
            slotIndex = i;
            break;
        }
    }

    if (slotIndex === -1) return; // инвентарь полон

    inventory[slotIndex]++;
    updateInventoryUI();

    item.collected = true;
    item.element.style.opacity = '0';
    setTimeout(() => {
        item.element.remove();
        items = items.filter(i => i !== item);
    }, 300);
}

function updateInventoryUI() {
    const slots = document.querySelectorAll('.slot');
    slots.forEach((slot, i) => {
        const count = inventory[i];
        const img = slot.querySelector('img');
        const counter = slot.querySelector('.count');

        if (count > 0) {
            if (!img.src) {
                img.src = 'https://sfo3.digitaloceanspaces.com/landocs/rp24/resourcepack-images-large/758207.webp';
            }
            img.style.display = 'block';
            counter.textContent = count;
        } else {
            img.style.display = 'none';
            counter.textContent = '0';
        }
    });
}

function getScreenYFromWorldZ(z) {
    // Простая проекция: чем дальше z, тем выше на экране
    // Подбираем коэффициент под перспективу
    const fov = 0.8;
    return window.innerHeight / 2 + z * fov;
}

function gameLoop() {
    // Гравитация
    if (!player.grounded) {
        player.vy += GRAVITY;
        player.y += player.vy;
    }

    // Проверка коллизии с землей
    player.grounded = false;
    for (let layer of groundLayers) {
        if (layer.mined) continue;
        const groundY = getScreenYFromWorldZ(layer.z);
        if (player.y >= groundY - BLOCK_SIZE && player.y <= groundY + 10) {
            player.y = groundY - BLOCK_SIZE;
            player.vy = 0;
            player.grounded = true;
            break;
        }
    }

    // Движение
    if (keys.left) player.x -= MOVE_SPEED;
    if (keys.right) player.x += MOVE_SPEED;

    // Ограничение по краям (по ширине мира)
    player.x = Math.max(100, Math.min(window.innerWidth - 100, player.x));

    // Сбор предметов
    for (let item of items) {
        if (item.collected) continue;
        const dx = Math.abs(player.x - item.x);
        const dy = Math.abs(player.y - item.y);
        if (dx < 50 && dy < 50) {
            collectItem(item);
        }
    }

    // Обновление позиции руки (визуально от первого лица)
    const hand = document.getElementById('player-hand');
    hand.style.transform = `translateX(-50%) scale(0.8) translateY(${player.vy * 0.5}px)`;

    requestAnimationFrame(gameLoop);
}
