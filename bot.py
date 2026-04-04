import math
import io
import time
import random
import asyncio
import os
import sqlite3
import pickle
from pathlib import Path
from telebot.async_telebot import AsyncTeleBot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton, InputMediaPhoto
from PIL import Image, ImageDraw, ImageOps

ADMIN_ID = 1170970828
BOT_TOKEN = "8512207770:AAEKLtYEph7gleybGhF2lc7Gwq82Kj1yedM"
bot = AsyncTeleBot(BOT_TOKEN)

# Лимит одновременных рендеров (спасает процессор от зависания)
RENDER_SEMAPHORE = asyncio.Semaphore(2)

# --- ИНИЦИАЛИЗАЦИЯ ДАННЫХ И БД ---
try:
    DATA_DIR = Path("/app/data")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
except PermissionError:
    DATA_DIR = Path("./data")
    DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "bot.db"
if not DB_PATH.exists():
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)')
    conn.commit()
    conn.close()

TEX_DIR = Path("textures")
TEX_DIR.mkdir(exist_ok=True)

# --- КОНСТАНТЫ И НАСТРОЙКИ ---
CAMERA_HEIGHT_OFFSET = 1.6
MOVE_STEP = 1.0
TURN_ANGLE = math.radians(15)
TILT_STEP = 0.15
MAX_TILT = 0.95
MIN_TILT = -0.95
SKY_COLOR = (135, 206, 235)
NEAR_CLIP = 0.05
RAY_STEP = 0.02
RAY_MAX_DIST = 24
PLAYER_BODY_SIZE = 0.6
PLAYER_BODY_HEIGHT = 1.6
PLAYER_HEAD_SIZE = 0.4
PLAYER_HEAD_OFFSET = 0.2
PLAYER_BODY_COLOR = (255, 255, 0)
PLAYER_HEAD_COLOR = (255, 220, 100)

RESOLUTIONS = {
    1: {"w": 256, "h": 192, "scale": 140},
    2: {"w": 426, "h": 320, "scale": 233},
    3: {"w": 640, "h": 480, "scale": 350},
    4: {"w": 800, "h": 600, "scale": 437}
}

LIGHT_DIR_RAW = (0.5, 0.8, 0.3)
ll = math.sqrt(sum(c**2 for c in LIGHT_DIR_RAW))
LIGHT_DIR = tuple(c/ll for c in LIGHT_DIR_RAW)
FACE_UVS = [(0, 1), (1, 1), (1, 0), (0, 0)]
BLOCK_FACES_DATA = [
    ("top", [4, 5, 6, 7], (0, 0, 1)),
    ("bottom", [0, 3, 2, 1], (0, 0, -1)),
    ("front", [0, 1, 5, 4], (0, -1, 0)),
    ("back", [2, 3, 7, 6], (0, 1, 0)),
    ("right", [1, 2, 6, 5], (1, 0, 0)),
    ("left", [0, 4, 7, 3], (-1, 0, 0)),
]
PLAYER_FACES = [
    ("bottom", [0, 3, 2, 1], lambda c: c),
    ("top", [4, 5, 6, 7], lambda c: c),
    ("back", [0, 1, 5, 4], lambda c: c),
    ("front", [2, 3, 7, 6], lambda c: c),
    ("right", [1, 2, 6, 5], lambda c: c),
    ("left", [0, 4, 7, 3], lambda c: c),
]

# --- МАТЕМАТИКА ---
def clamp(v, lo, hi): return max(lo, min(hi, v))
def apply_light(c, lf): return tuple(min(255, max(0, int(ch*lf))) for ch in c)
def normalize_vector(v):
    l = math.sqrt(sum(c**2 for c in v))
    return tuple(c/l for c in v) if l!=0 else (0,0,0)
def vec_sub(a, b): return tuple(x-y for x, y in zip(a, b))
def vec_dot(a, b): return sum(x*y for x, y in zip(a, b))
def vec_cross(a, b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
def vec_norm(v): return normalize_vector(v)
def face_normal(verts, idx): return vec_norm(vec_cross(vec_sub(verts[idx[1]], verts[idx[0]]), vec_sub(verts[idx[2]], verts[idx[0]])))
def calc_light(normal):
    n = normalize_vector(normal)
    d = sum(n[i] * LIGHT_DIR[i] for i in range(3))
    return 0.6 + max(0.0, min(1.0, d)) * 0.4
def normalize_angle(a):
    while a < 0: a += 2*math.pi
    while a >= 2*math.pi: a -= 2*math.pi
    return a

# --- ТЕКСТУРЫ ---
def create_fallback_tex(name, color, draw_func=None):
    p = TEX_DIR / name
    if not p.exists():
        img = Image.new("RGB", (128, 128), color)
        if draw_func: draw_func(ImageDraw.Draw(img))
        img.save(p)

def draw_grass_top(d):
    for _ in range(300): d.point((random.randint(0,127), random.randint(0,127)), fill=(80, 200, 80))

def draw_grass_side(d):
    d.rectangle((0, 0, 128, 128), fill=(139, 94, 52))
    d.rectangle((0, 0, 128, 32), fill=(100, 220, 100)) # Трава сверху (Y от 0 до 32)
    for i in range(15):
        x = random.randint(0, 120)
        d.polygon([(x, 32), (x+4, 48), (x+8, 32)], fill=(100, 220, 100))

def draw_dirt(d):
    for _ in range(400): d.point((random.randint(0,127), random.randint(0,127)), fill=(100, 70, 40))

create_fallback_tex("trava.png", (100, 220, 100), draw_grass_top)
create_fallback_tex("trava_bok.png", (139, 94, 52), draw_grass_side)
create_fallback_tex("zemlya.png", (139, 94, 52), draw_dirt)
create_fallback_tex("drevesina.png", (110, 70, 30))
create_fallback_tex("drevesina_vn.png", (150, 100, 50))

def load_tex(name, fallback_color=(255,0,255)):
    p = TEX_DIR / name
    if p.exists(): return Image.open(p).convert("RGBA").resize((128, 128), Image.Resampling.NEAREST)
    return Image.new("RGBA", (128, 128), fallback_color)

TEX_CACHE = {
    "trava_top": load_tex("trava.png", (100, 220, 100)),
    "trava_side": load_tex("trava_bok.png", (120, 180, 80)),
    "zemlya": load_tex("zemlya.png", (139, 94, 52)),
    "stone": load_tex("stone.png", (120, 120, 120)),
    "wood_side": load_tex("drevesina.png", (110, 70, 30)),
    "wood_top": load_tex("drevesina_vn.png", (150, 100, 50)),
    "leaves": load_tex("leaves.png", (50, 150, 50)),
    "planks": load_tex("planks.png", (180, 140, 80)),
    "workbench": load_tex("workbench.png", (200, 100, 50)),
    "bedrock": load_tex("bedrock.png", (40, 40, 40))
}

CRACK_TEX = []
for i in range(5):
    img = Image.new("RGBA", (128, 128), (0,0,0,0))
    d = ImageDraw.Draw(img)
    for _ in range((i + 1) * 4):
        x1, y1 = random.randint(20, 108), random.randint(20, 108)
        d.line((x1, y1, x1+random.randint(-40,40), y1+random.randint(-40,40)), fill=(0,0,0, 180), width=3)
    CRACK_TEX.append(img)

def bake_face(tex):
    img = tex.copy().convert("RGBA")
    d = ImageDraw.Draw(img)
    w, h = img.size; sx, sy = w/128.0, h/128.0
    d.rectangle((24*sx, 40*sy, 48*sx, 64*sy), fill=(255,255,255,255)); d.rectangle((32*sx, 48*sy, 40*sx, 56*sy), fill=(0,0,0,255))
    d.rectangle((80*sx, 40*sy, 104*sx, 64*sy), fill=(255,255,255,255)); d.rectangle((80*sx, 48*sy, 88*sx, 56*sy), fill=(0,0,0,255))
    d.rectangle((48*sx, 88*sy, 80*sx, 96*sy), fill=(0,0,0,255))
    return img

DEFAULT_FACE_TEX = bake_face(Image.new("RGB", (128, 128), (255, 220, 100)))
BLOCK_STATS = {"dirt": 3, "grass": 3, "wood": 6, "leaves": 2, "stone": 12, "planks": 4, "workbench": 6, "bedrock": 9999}

# --- КЛАСС СЕРВЕРА ---
class Server:
    def __init__(self, s_id, s_type):
        self.id = s_id
        self.type = s_type
        self.size = 60 if s_type == "classic" else 64
        self.blocks = {}
        self.faces = []
        self.version = 0
        self.block_damage = {}
        self.players = {}
        self.chat = []
        self.generate()

    def generate(self):
        self.blocks.clear()
        self.block_damage.clear()
        random.seed(42 + self.id)
        if self.type == "classic":
            colors = [(230, 80, 80), (80, 230, 80), (80, 80, 230)]
            for y in range(self.size):
                for x in range(self.size):
                    self.blocks[(x, y, 0)] = {"color": colors[(x + y + random.randint(0, 1)) % 3]}
        else:
            for y in range(self.size):
                for x in range(self.size):
                    h = int(math.sin(x/5.0)*2 + math.cos(y/4.0)*2)
                    self.blocks[(x, y, h)] = {"type": "grass"}
                    self.blocks[(x, y, h-1)] = {"type": "dirt"}
                    self.blocks[(x, y, h-2)] = {"type": "dirt"}
                    for z in range(h-3, -64, -1): 
                        self.blocks[(x, y, z)] = {"type": "stone"}
                    self.blocks[(x, y, -64)] = {"type": "bedrock"}
                    
                    if random.random() < 0.02 and 2 < x < self.size-2 and 2 < y < self.size-2:
                        for tz in range(1, 5): self.blocks[(x, y, h+tz)] = {"type": "wood"}
                        for dx in [-1,0,1]:
                            for dy in [-1,0,1]:
                                for dz in [4,5]:
                                    if dx==0 and dy==0 and dz==4: continue
                                    if (x+dx, y+dy, h+dz) not in self.blocks:
                                        self.blocks[(x+dx, y+dy, h+dz)] = {"type": "leaves"}

        self.rebuild_mesh()

    def rebuild_mesh(self):
        self.faces = []
        for (gx, gy, gz), bdata in self.blocks.items():
            vw = [
                (gx, gy, gz), (gx+1, gy, gz), (gx+1, gy+1, gz), (gx, gy+1, gz),
                (gx, gy, gz+1), (gx+1, gy, gz+1), (gx+1, gy+1, gz+1), (gx, gy+1, gz+1)
            ]
            for fn, idx, offset in BLOCK_FACES_DATA:
                nb = (gx + offset[0], gy + offset[1], gz + offset[2])
                if nb in self.blocks: continue
                
                n = face_normal(vw, idx)
                lf = calc_light(n)
                br = 1.0 if fn == "top" else 0.85
                
                face_info = {"cx": gx+0.5, "cy": gy+0.5, "cz": gz+0.5, "verts": [vw[i] for i in idx], "n": n, "lf": lf*br, "pos": (gx,gy,gz)}
                
                if self.type == "classic":
                    face_info["sc"] = apply_light(bdata.get("color", (255,255,255)), lf*br)
                    face_info["tex"] = bdata.get("tex")
                else:
                    btype = bdata["type"]
                    tex = None
                    if btype == "grass": tex = TEX_CACHE["trava_top"] if fn=="top" else TEX_CACHE["trava_side"] if fn not in ["top","bottom"] else TEX_CACHE["zemlya"]
                    elif btype == "wood": tex = TEX_CACHE["wood_top"] if fn in ["top","bottom"] else TEX_CACHE["wood_side"]
                    elif btype in ["dirt", "stone", "leaves", "planks", "workbench", "bedrock"]:
                        tex = TEX_CACHE.get(btype, TEX_CACHE["zemlya"])
                    face_info["tex"] = tex
                
                dmg = self.block_damage.get((gx,gy,gz), 0)
                if dmg > 0 and self.type == "survival" and bdata["type"] != "bedrock":
                    mhp = BLOCK_STATS.get(bdata["type"], 3)
                    stage = min(4, int((dmg / mhp) * 5))
                    if face_info.get("tex"):
                        combined = face_info["tex"].copy()
                        combined.alpha_composite(CRACK_TEX[stage])
                        face_info["tex"] = combined
                
                self.faces.append(face_info)
        self.version += 1

    def broadcast(self, txt):
        self.chat.append(txt)
        if len(self.chat) > 4: self.chat.pop(0)

# --- ГЛОБАЛЬНЫЕ ДАННЫЕ И СОХРАНЕНИЕ ---
SERVERS = {1: Server(1, "classic"), 2: Server(2, "survival")}
user_server_map = {}
player_skins = {}
pending_skin_mode = {}
last_target_block = {}

def save_all_data():
    try:
        s1_data = {"players": SERVERS[1].players, "blocks": {}}
        for pos, bd in SERVERS[1].blocks.items():
            s1_data["blocks"][pos] = {"color": bd.get("color")}
            if bd.get("tex"):
                bio = io.BytesIO()
                bd["tex"].save(bio, "PNG")
                s1_data["blocks"][pos]["tex_bytes"] = bio.getvalue()
        with open(DATA_DIR / "srv1.pkl", "wb") as f: pickle.dump(s1_data, f)
        
        s2_data = {"players": SERVERS[2].players, "blocks": SERVERS[2].blocks, "damage": SERVERS[2].block_damage}
        with open(DATA_DIR / "srv2.pkl", "wb") as f: pickle.dump(s2_data, f)
    except Exception as e:
        print("Ошибка сохранения:", e)

def load_all_data():
    try:
        if (DATA_DIR / "srv1.pkl").exists():
            with open(DATA_DIR / "srv1.pkl", "rb") as f:
                data = pickle.load(f)
                SERVERS[1].players = data.get("players", {})
                for p_uid in list(SERVERS[1].players.keys()): user_server_map[p_uid] = 1
                for pos, bd in data.get("blocks", {}).items():
                    SERVERS[1].blocks[pos] = {"color": bd["color"]}
                    if "tex_bytes" in bd:
                        SERVERS[1].blocks[pos]["tex"] = Image.open(io.BytesIO(bd["tex_bytes"])).convert("RGBA")
            SERVERS[1].rebuild_mesh()
            
        if (DATA_DIR / "srv2.pkl").exists():
            with open(DATA_DIR / "srv2.pkl", "rb") as f:
                data = pickle.load(f)
                SERVERS[2].players = data.get("players", {})
                for p_uid in list(SERVERS[2].players.keys()): user_server_map[p_uid] = 2
                SERVERS[2].blocks = data.get("blocks", {})
                SERVERS[2].block_damage = data.get("damage", {})
            SERVERS[2].rebuild_mesh()
    except Exception as e:
        print("Ошибка загрузки, генерируем заново:", e)

async def auto_saver():
    while True:
        await asyncio.sleep(30)
        save_all_data()

def get_st(uid):
    s_id = user_server_map.get(uid)
    return SERVERS[s_id].players.get(uid) if s_id else None

def get_ground_z(x, y, srv):
    tz = -64
    for bz in range(20, -65, -1):
        if (int(x), int(y), bz) in srv.blocks:
            tz = bz + 1; break
    return tz

def init_player(uid, s_id, name):
    srv = SERVERS[s_id]
    user_server_map[uid] = s_id
    if uid not in srv.players:
        srv.players[uid] = {
            "x": srv.size/2, "y": srv.size/2, "z": get_ground_z(srv.size/2, srv.size/2, srv), 
            "angle": 0.0, "tilt": 0.0, "jump": False,
            "name": name, "msg_id": None, "view_radius": 8, "res_level": 2, "hp": 10, "flash_time": 0,
            "inv": {0: {"type": "wood", "count": 10}}, "inv_open": False, "inv_cursor": 0, "drag_item": None,
            "cache_hash": None, "cache_img": None, "is_busy": False
        }
    return srv.players[uid]

def make_keyboard(uid):
    st = get_st(uid)
    s_id = user_server_map.get(uid)
    srv = SERVERS[s_id]
    
    jump_text = "🦘 Прыжок (Вкл)" if st.get("jump") else "🦘 Прыжок"
    vr_text = f"👁 Дальность: {st.get('view_radius', 8)}"
    res_text = f"🖥 {RESOLUTIONS[st.get('res_level', 2)]['w']}p"
    
    if srv.type == "classic":
        paint_text = "📸 Жду фото..." if pending_skin_mode.get(uid) and pending_skin_mode[uid][0] == "block" else "🎨 Крась"
    else: paint_text = "🎒 Инвентарь"
    
    kb = InlineKeyboardMarkup(row_width=3)
    kb.add(
        InlineKeyboardButton("↖️", callback_data="move_fl"),
        InlineKeyboardButton("⬆️", callback_data="move_f"),
        InlineKeyboardButton("↗️", callback_data="move_fr")
    )
    kb.add(
        InlineKeyboardButton("⬅️", callback_data="move_l"),
        InlineKeyboardButton("🔄", callback_data="refresh"),
        InlineKeyboardButton("➡️", callback_data="move_r")
    )
    kb.add(
        InlineKeyboardButton("↙️", callback_data="move_bl"),
        InlineKeyboardButton("⬇️", callback_data="move_b"),
        InlineKeyboardButton("↘️", callback_data="move_br")
    )
    kb.add(
        InlineKeyboardButton("🌀⬅️", callback_data="turn_left"),
        InlineKeyboardButton("🌀➡️", callback_data="turn_right")
    )
    kb.add(
        InlineKeyboardButton("👀⬆️", callback_data="look_up"),
        InlineKeyboardButton("👀⬇️", callback_data="look_down")
    )
    kb.add(
        InlineKeyboardButton("🔨 Строй", callback_data="build"),
        InlineKeyboardButton(paint_text, callback_data="paint"),
        InlineKeyboardButton("⛏️/🗡 Ломай", callback_data="break")
    )
    kb.add(
        InlineKeyboardButton(jump_text, callback_data="toggle_jump"),
        InlineKeyboardButton(vr_text, callback_data="cycle_view"),
        InlineKeyboardButton(res_text, callback_data="cycle_res")
    )
    return kb

# --- ОПТИМИЗИРОВАННЫЙ РЕНДЕР ---
def clip_near(vp):
    r = []; p = vp[-1]; p_in = p[1] >= NEAR_CLIP
    for c in vp:
        c_in = c[1] >= NEAR_CLIP
        if c_in:
            if not p_in:
                t = (NEAR_CLIP - p[1]) / (c[1] - p[1]) if c[1]!=p[1] else 0
                r.append(tuple(p[d] + (c[d]-p[d])*t for d in range(len(p))))
            r.append(c)
        elif p_in:
            t = (NEAR_CLIP - p[1]) / (c[1] - p[1]) if c[1]!=p[1] else 0
            r.append(tuple(p[d] + (c[d]-p[d])*t for d in range(len(p))))
        p, p_in = c, c_in
    return r

def draw_poly_color(pix, zb, v2d, col):
    if len(v2d)<3: return
    w, h = len(zb[0]), len(zb)
    ys = [p[1] for p in v2d]
    y0, y1 = max(0, int(math.ceil(min(ys)))), min(h-1, int(math.floor(max(ys))))
    for y in range(y0, y1+1):
        inter = []; py = y+0.5
        for i in range(len(v2d)):
            a, b = v2d[i], v2d[(i+1)%len(v2d)]
            if (a[1]<=py<b[1]) or (b[1]<=py<a[1]):
                t = (py-a[1])/(b[1]-a[1])
                inter.append((a[0]+(b[0]-a[0])*t, 1.0/a[2] + (1.0/b[2]-1.0/a[2])*t))
        inter.sort(key=lambda q:q[0])
        for i in range(0, len(inter)-1, 2):
            x1, z1 = inter[i]; x2, z2 = inter[i+1]
            ix1, ix2 = max(0, int(math.ceil(x1))), min(w-1, int(math.floor(x2)))
            dx = x2-x1
            for x in range(ix1, ix2+1):
                iz = z1 + (z2-z1)*(x-x1)/dx if dx>1e-9 else z1
                if iz>0 and (1.0/iz)<zb[y][x]: zb[y][x] = 1.0/iz; pix[x,y] = col

def draw_poly_tex(pix, zb, v2d, tex, lf):
    if len(v2d)<3: return
    w, h = len(zb[0]), len(zb)
    tw, th = tex.size
    t_dat = tex.getdata()
    ys = [p[1] for p in v2d]
    y0, y1 = max(0, int(math.ceil(min(ys)))), min(h-1, int(math.floor(max(ys))))
    for y in range(y0, y1+1):
        inter = []; py = y+0.5
        for i in range(len(v2d)):
            a, b = v2d[i], v2d[(i+1)%len(v2d)]
            if (a[1]<=py<b[1]) or (b[1]<=py<a[1]):
                t = (py-a[1])/(b[1]-a[1])
                iz = 1.0/a[2] + (1.0/b[2]-1.0/a[2])*t
                iu = a[3]/a[2] + (b[3]/b[2]-a[3]/a[2])*t
                iv = a[4]/a[2] + (b[4]/b[2]-a[4]/a[2])*t
                inter.append((a[0]+(b[0]-a[0])*t, iz, iu, iv))
        inter.sort(key=lambda q:q[0])
        for i in range(0, len(inter)-1, 2):
            x1, z1, u1, v1 = inter[i]; x2, z2, u2, v2 = inter[i+1]
            ix1, ix2 = max(0, int(math.ceil(x1))), min(w-1, int(math.floor(x2)))
            dx = x2-x1
            for x in range(ix1, ix2+1):
                t2 = (x-x1)/dx if dx>1e-9 else 0
                iz = z1 + (z2-z1)*t2
                if iz>0 and (1.0/iz)<zb[y][x]:
                    zb[y][x] = 1.0/iz
                    tu, tv = (u1+(u2-u1)*t2)/iz, (v1+(v2-v1)*t2)/iz
                    tx, ty = int(clamp(tu,0,0.999)*tw), int(clamp(tv,0,0.999)*th)
                    c = t_dat[ty*tw + tx]
                    if c[3]>100: pix[x,y] = apply_light(c[:3], lf)

def draw_inv(d, w, h, st):
    d.rectangle((0,0, w, h), fill=(0,0,0, 200))
    slots = {}
    cx, cy = w//2 - 60, h//2 - 120
    for i, (dx, dy) in enumerate([(0,0), (40,0), (0,40), (40,40)]): slots[20+i] = (cx+dx, cy+dy)
    slots[24] = (cx+100, cy+20)
    d.text((cx, cy-15), "Crafting", fill=(255,255,255))
    d.line((cx+85, cy+30, cx+95, cy+30), fill=(255,255,255), width=2)
    
    mx, my = w//2 - 100, h//2
    for r in range(3):
        for c in range(5): slots[5 + r*5 + c] = (mx+c*40, my+r*40)
            
    hx, hy = w//2 - 100, h - 50
    for c in range(5): slots[c] = (hx+c*40, hy)

    for sid, (sx, sy) in slots.items():
        color = (100,100,100) if sid != 24 else (150,150,50)
        d.rectangle((sx, sy, sx+36, sy+36), fill=color, outline=(255,255,255) if st["inv_cursor"]==sid else (50,50,50), width=2 if st["inv_cursor"]==sid else 1)
        item = st["inv"].get(sid)
        if item:
            d.text((sx+2, sy+2), item["type"][:3], fill=(255,255,255))
            d.text((sx+20, sy+20), str(item["count"]), fill=(255,255,0))
            
    if st["drag_item"]:
        d.text((10, 10), f"Dragging: {st['drag_item']['count']}x {st['drag_item']['type']}", fill=(0,255,0))

def update_crafting(st):
    c_slots = [st["inv"].get(i) for i in range(20, 24)]
    res = None
    woods = sum(1 for i in c_slots if i and i["type"]=="wood")
    planks = sum(1 for i in c_slots if i and i["type"]=="planks")
    total = sum(1 for i in c_slots if i)
    
    if woods == 1 and total == 1: res = {"type": "planks", "count": 4}
    elif planks == 4 and total == 4: res = {"type": "workbench", "count": 1}
    
    if res: st["inv"][24] = res
    elif 24 in st["inv"]: del st["inv"][24]

def render_scene(px, py, pz, pa, pt, uid, s_id):
    srv = SERVERS[s_id]
    st = srv.players[uid]
    vr = st["view_radius"]
    rl = st["res_level"]
    img_w, img_h, scale = RESOLUTIONS[rl]["w"], RESOLUTIONS[rl]["h"], RESOLUTIONS[rl]["scale"]
    horiz_y = img_h // 2
    
    img = Image.new("RGBA", (img_w, img_h), SKY_COLOR)
    pix = img.load()
    zbuf = [[float("inf")] * img_w for _ in range(img_h)]
    d = ImageDraw.Draw(img)

    fwd_x, fwd_y = math.sin(pa), math.cos(pa)
    
    for face in srv.faces:
        if abs(face["cx"] - px) > vr or abs(face["cy"] - py) > vr: continue
        bx, by = face["cx"]-px, face["cy"]-py
        d_sq = bx*bx + by*by
        if d_sq > 9.0 and (bx*fwd_x + by*fwd_y)/math.sqrt(d_sq) < -0.3: continue
        tc = (px-face["cx"], py-face["cy"], pz-face["cz"])
        if face["n"][0]*tc[0] + face["n"][1]*tc[1] + face["n"][2]*tc[2] <= 0: continue
            
        v_clip = clip_near([world_to_view(wx,wy,wz, px,py,pz, pa,pt) + ((FACE_UVS[k%4][0], FACE_UVS[k%4][1]) if face.get("tex") else ()) for k, (wx,wy,wz) in enumerate(face["verts"])])
        if len(v_clip)<3: continue
        proj = []
        for v in v_clip:
            py_p = horiz_y - (v[2]/v[1])*scale
            px_p = img_w/2 + (v[0]/v[1])*scale
            proj.append((px_p, py_p, v[1]) + (v[3:] if len(v)>3 else ()))
        
        if face.get("tex"): draw_poly_tex(pix, zbuf, proj, face["tex"], face["lf"])
        else: draw_poly_color(pix, zbuf, proj, face["sc"])

    for pid, ps in srv.players.items():
        if pid == uid: continue
        ox, oy, oa = ps["x"], ps["y"], ps["angle"]
        oz = ps.get("z", 1.0)
        d_sq = (ox-px)**2 + (oy-py)**2
        if d_sq > vr**2 or (d_sq > 9.0 and ((ox-px)*fwd_x + (oy-py)*fwd_y)/math.sqrt(d_sq) < -0.3): continue
        
        bv = build_box(ox, oy, oz, PLAYER_BODY_SIZE, PLAYER_BODY_HEIGHT, oa)
        hv = build_box(ox, oy, oz+PLAYER_BODY_HEIGHT+PLAYER_HEAD_OFFSET, PLAYER_HEAD_SIZE, PLAYER_HEAD_SIZE, oa)
        flash = time.time() - ps.get("flash_time", 0) < 0.25
        
        for b_verts, col, tex_mode in [(bv, (255,50,50) if flash else PLAYER_BODY_COLOR, False), (hv, (255,50,50) if flash else PLAYER_HEAD_COLOR, True)]:
            for fn, idx, _ in PLAYER_FACES:
                n = face_normal(b_verts, idx)
                if vec_dot(n, (px-ox, py-oy, pz-(oz+1))) <= 0: continue
                lf = calc_light(n)
                vc = clip_near([world_to_view(wx,wy,wz, px,py,pz, pa,pt) + ((FACE_UVS[k%4][0], FACE_UVS[k%4][1]) if tex_mode else ()) for k, (wx,wy,wz) in enumerate([b_verts[i] for i in idx])])
                if len(vc)<3: continue
                proj = [(img_w/2 + (v[0]/v[1])*scale, horiz_y - (v[2]/v[1])*scale, v[1]) + (v[3:] if len(v)>3 else ()) for v in vc]
                
                if tex_mode and not flash and (fn=="front" or pid in player_skins):
                    t = player_skins.get(pid, DEFAULT_FACE_TEX)
                    draw_poly_tex(pix, zbuf, proj, t, lf)
                else: draw_poly_color(pix, zbuf, proj, apply_light(col, lf))

    d.line((img_w/2-5, img_h/2, img_w/2+5, img_h/2), fill=(255,255,255))
    d.line((img_w/2, img_h/2-5, img_w/2, img_h/2+5), fill=(255,255,255))

    d.rectangle((5,5, 150,25), fill=(0,0,0,150))
    d.text((10,8), f"X:{px:.1f} Y:{py:.1f} Z:{pz-1.6:.1f}", fill=(255,255,255))

    for i in range(5):
        hx, hy = img_w - 90 + i*16, 10
        d.rectangle((hx, hy, hx+12, hy+12), outline=(0,0,0))
        if st["hp"] >= i*2+2: d.rectangle((hx+1, hy+1, hx+11, hy+11), fill=(255,50,50))
        elif st["hp"] == i*2+1: d.rectangle((hx+1, hy+1, hx+6, hy+11), fill=(255,50,50))

    if srv.type == "survival":
        hx = img_w//2 - 100
        for i in range(5):
            d.rectangle((hx+i*40, img_h-45, hx+i*40+36, img_h-9), fill=(100,100,100,150), outline=(255,255,255) if i==st["inv_cursor"] and not st["inv_open"] else None)
            item = st["inv"].get(i)
            if item:
                d.text((hx+i*40+2, img_h-43), item["type"][:3], fill=(255,255,255))
                d.text((hx+i*40+20, img_h-25), str(item["count"]), fill=(255,255,0))

    if st["inv_open"]: draw_inv(d, img_w, img_h, st)

    bio = io.BytesIO()
    img.convert("RGB").save(bio, "PNG")
    return bio.getvalue()

def ray_pick(px, py, pz, pa, pt, s_id, ignore_uid=None):
    srv = SERVERS[s_id]
    dx, dy, dz = math.sin(pa)*math.cos(pt), math.cos(pa)*math.cos(pt), -math.sin(pt)
    t = 0.0
    while t <= RAY_MAX_DIST:
        wx, wy, wz = px+dx*t, py+dy*t, pz+dz*t
        for pid, ps in srv.players.items():
            if pid == ignore_uid: continue
            if abs(wx-ps["x"])<0.3 and abs(wy-ps["y"])<0.3 and ps["z"]<=wz<=ps["z"]+2.0:
                return ("player", pid, t)
        cb = (int(math.floor(wx)), int(math.floor(wy)), int(math.floor(wz)))
        if cb in srv.blocks: return ("block", cb, None)
        t += RAY_STEP
    return None

async def broadcast_chat(s_id, txt):
    SERVERS[s_id].broadcast(txt)
    cap = "\n".join(SERVERS[s_id].chat)
    for uid, st in SERVERS[s_id].players.items():
        if st.get("msg_id"):
            try: await bot.edit_message_caption(caption=cap, chat_id=uid, message_id=st["msg_id"], reply_markup=make_keyboard(uid))
            except: pass

async def send_view(cid, uid):
    s_id = user_server_map.get(uid)
    if not s_id: return
    st = get_st(uid)
    
    # Анти-спам система (Семафор и блокировка кликов)
    if st.get("is_busy"): return
    st["is_busy"] = True
    
    try:
        kb = make_keyboard(uid)
        if st["inv_open"]:
            kb = InlineKeyboardMarkup(row_width=3)
            kb.add(InlineKeyboardButton("Вверх ⬆️", callback_data="inv_u"))
            kb.add(InlineKeyboardButton("Влево ⬅️", callback_data="inv_l"), InlineKeyboardButton("Взять/Класть ✋", callback_data="inv_click"), InlineKeyboardButton("Вправо ➡️", callback_data="inv_r"))
            kb.add(InlineKeyboardButton("Вниз ⬇️", callback_data="inv_d"))
            kb.add(InlineKeyboardButton("❌ Закрыть", callback_data="inv_close"))

        async with RENDER_SEMAPHORE:
            img_bytes = await asyncio.to_thread(render_scene, st["x"], st["y"], st["z"]+1.6, st["angle"], st["tilt"], uid, s_id)
            
        bio = io.BytesIO(img_bytes)
        bio.name = "s.png"
        cap = "\n".join(SERVERS[s_id].chat) if SERVERS[s_id].chat else "🎮 Приятной игры!"
        
        if st.get("msg_id"):
            try:
                await bot.edit_message_media(chat_id=cid, message_id=st["msg_id"], media=InputMediaPhoto(bio, caption=cap), reply_markup=kb)
                st["is_busy"] = False
                return
            except: pass

        bio.seek(0)
        msg = await bot.send_photo(cid, bio, caption=cap, reply_markup=kb)
        st["msg_id"] = msg.message_id
    finally:
        st["is_busy"] = False

def server_menu():
    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton(f"🌈 Классика [{len(SERVERS[1].players)} чел]", callback_data="join_1"))
    kb.add(InlineKeyboardButton(f"🌲 Выживание [{len(SERVERS[2].players)} чел]", callback_data="join_2"))
    return kb

@bot.message_handler(commands=["start", "leave"])
async def h_start(m):
    uid = m.from_user.id
    try: await bot.delete_message(m.chat.id, m.message_id)
    except: pass
    
    if m.text.startswith("/start"):
        try:
            conn = sqlite3.connect(str(DB_PATH))
            conn.execute("INSERT OR IGNORE INTO users (id, username) VALUES (?, ?)", (uid, m.from_user.first_name))
            conn.commit(); conn.close()
        except: pass
        
    old_s = user_server_map.get(uid)
    if old_s and old_s in SERVERS:
        if uid in SERVERS[old_s].players: del SERVERS[old_s].players[uid]
        user_server_map.pop(uid, None)
        save_all_data()
        
    await bot.send_message(m.chat.id, "Выбери сервер:", reply_markup=server_menu())

@bot.message_handler(commands=["reset"])
async def h_reset(m):
    if m.from_user.id != ADMIN_ID: return
    parts = m.text.split()
    if len(parts)==3 and parts[2] in ["1","2"]:
        s_id = int(parts[2])
        SERVERS[s_id].generate()
        for p in SERVERS[s_id].players.values():
            p["x"], p["y"] = SERVERS[s_id].size/2, SERVERS[s_id].size/2
            p["z"] = get_ground_z(p["x"], p["y"], SERVERS[s_id])
            p["hp"] = 10
            p["inv"].clear()
        await bot.send_message(m.chat.id, f"Сервер {s_id} сброшен!")
        for uid in SERVERS[s_id].players: await send_view(uid, uid)

@bot.callback_query_handler(func=lambda c: c.data.startswith("join_"))
async def cb_join(c):
    s_id = int(c.data.split("_")[1])
    uid = c.from_user.id
    try: await bot.delete_message(c.message.chat.id, c.message.message_id)
    except: pass
    
    st = init_player(uid, s_id, c.from_user.first_name)
    await broadcast_chat(s_id, f"🎉 {st['name']} присоединился!")
    await send_view(c.message.chat.id, uid)

@bot.message_handler(commands=["block"])
async def h_block(m):
    uid = m.from_user.id
    try: await bot.delete_message(m.chat.id, m.message_id)
    except: pass
    
    s_id = user_server_map.get(uid)
    if not s_id or s_id != 1: return
    
    pb_data = last_target_block.get(uid)
    if not pb_data or pb_data[0] != "block": return
        
    t = pb_data[1]
    pending_skin_mode[uid] = ("block", t)
    st = get_st(uid)
    st["cache_hash"] = None
    if st.get("msg_id"):
        try: await bot.edit_message_reply_markup(m.chat.id, st["msg_id"], reply_markup=make_keyboard(uid))
        except: pass

@bot.message_handler(content_types=["photo"])
async def h_photo(m):
    uid = m.from_user.id
    st = get_st(uid)
    if not st: return
    s_id = user_server_map.get(uid)
    un = st["name"]
    try: await bot.delete_message(m.chat.id, m.message_id)
    except: pass
    
    try:
        fi = await bot.get_file(m.photo[-1].file_id)
        down_file = await bot.download_file(fi.file_path)
        im = Image.open(io.BytesIO(down_file)).convert("RGB")
        tex = ImageOps.fit(im, (128, 128), Image.Resampling.LANCZOS)
        
        mode = pending_skin_mode.get(uid)
        tasks = []
        
        if mode and mode[0] == "block" and s_id == 1:
            SERVERS[1].blocks[mode[1]]["tex"] = tex
            del pending_skin_mode[uid]
            SERVERS[1].rebuild_mesh()
            
            bx, by = mode[1][0], mode[1][1]
            for p_uid, ps in SERVERS[1].players.items():
                vr = ps.get("view_radius", 8)
                if p_uid == uid or (ps["x"] - bx)**2 + (ps["y"] - by)**2 <= vr**2:
                    tasks.append(send_view(p_uid, p_uid))
            
        elif m.caption and "/skin" in m.caption.lower():
            baked_tex = bake_face(tex)
            player_skins[uid] = baked_tex
            await broadcast_chat(s_id, f"👕 {un} установил новый скин!")
            
            for p_uid, ps in SERVERS[s_id].players.items():
                vr = ps.get("view_radius", 8)
                if p_uid == uid or (ps["x"] - st["x"])**2 + (ps["y"] - st["y"])**2 <= vr**2:
                    tasks.append(send_view(p_uid, p_uid))

        if tasks: await asyncio.gather(*tasks)
            
    except Exception as e: pass

@bot.callback_query_handler(func=lambda c: True)
async def h_cb(c):
    uid = c.from_user.id
    s_id = user_server_map.get(uid)
    if not s_id: return
    st = get_st(uid)
    if st.get("is_busy"): 
        try: await bot.answer_callback_query(c.id, "⏳ Рендер...")
        except: pass
        return
        
    srv = SERVERS[s_id]
    d = c.data
    ev = False
    
    if st["inv_open"]:
        c_idx = st["inv_cursor"]
        if d == "inv_u":
            if 0<=c_idx<=4: st["inv_cursor"]+=15
            elif 5<=c_idx<=19: st["inv_cursor"] = 20 if c_idx-5 < 5 else c_idx-5
        elif d == "inv_d":
            if 20<=c_idx<=24: st["inv_cursor"]=5
            elif 5<=c_idx<=14: st["inv_cursor"]+=5
            elif 15<=c_idx<=19: st["inv_cursor"]-=15
        elif d == "inv_l":
            if c_idx not in [0,5,10,15,20]: st["inv_cursor"]-=1
        elif d == "inv_r":
            if c_idx not in [4,9,14,19,23,24]: st["inv_cursor"]+=1
        elif d == "inv_click":
            c_id = st["inv_cursor"]
            if c_id == 24 and st.get("drag_item") is None and 24 in st["inv"]:
                st["drag_item"] = st["inv"].pop(24)
                for i in range(20, 24):
                    if i in st["inv"]:
                        st["inv"][i]["count"]-=1
                        if st["inv"][i]["count"]<=0: del st["inv"][i]
            else:
                tmp = st["inv"].get(c_id)
                if st["drag_item"]:
                    if tmp and tmp["type"] == st["drag_item"]["type"]:
                        tmp["count"] += st["drag_item"]["count"]
                        st["drag_item"] = None
                    else:
                        st["inv"][c_id] = st["drag_item"]
                        st["drag_item"] = tmp
                else:
                    if tmp:
                        st["drag_item"] = tmp
                        del st["inv"][c_id]
            update_crafting(st)
        elif d == "inv_close": st["inv_open"] = False
        await send_view(c.message.chat.id, uid)
        try: await bot.answer_callback_query(c.id)
        except: pass
        return

    if d in ["move_f", "move_b", "move_l", "move_r", "move_fl", "move_fr", "move_bl", "move_br"]:
        f, s = 0, 0
        if "f" in d: f=1
        if "b" in d: f=-1
        if "l" in d: s=-1
        if "r" in d: s=1
        a = st["angle"]
        nx = clamp(st["x"] + (math.sin(a)*f + math.cos(a)*s)*MOVE_STEP, 0.5, srv.size-0.5)
        ny = clamp(st["y"] + (math.cos(a)*f - math.sin(a)*s)*MOVE_STEP, 0.5, srv.size-0.5)
        tz = get_ground_z(nx, ny, srv)
            
        diff = tz - st["z"]
        if diff <= 0 or (diff == 1 and st["jump"]):
            st["x"], st["y"], st["z"] = nx, ny, tz
            ev = True
            if diff <= -4:
                st["hp"] -= (1 + int(abs(diff)-4)//2)
                st["flash_time"] = time.time()
                if st["hp"]<=0:
                    await broadcast_chat(s_id, f"💀 {st['name']} разбился!")
                    st["x"], st["y"], st["z"], st["hp"] = srv.size/2, srv.size/2, get_ground_z(srv.size/2, srv.size/2, srv), 10
        st["jump"] = False
        
    elif d == "turn_left": st["angle"] = normalize_angle(st["angle"] - TURN_ANGLE); ev = True
    elif d == "turn_right": st["angle"] = normalize_angle(st["angle"] + TURN_ANGLE); ev = True
    elif d == "look_up": st["tilt"] = max(st["tilt"] - TILT_STEP, MIN_TILT); ev = True
    elif d == "look_down": st["tilt"] = min(st["tilt"] + TILT_STEP, MAX_TILT); ev = True
    elif d == "toggle_jump": st["jump"] = not st["jump"]
    elif d == "cycle_view": st["view_radius"] = 16 if st["view_radius"]==8 else 32 if st["view_radius"]==16 else 8
    elif d == "cycle_res": st["res_level"] = st["res_level"]+1 if st["res_level"]<4 else 1
    elif d == "paint":
        if srv.type == "classic":
            pb = ray_pick(st["x"], st["y"], st["z"]+1.6, st["angle"], st["tilt"], s_id, uid)
            if pb and pb[0]=="block": pending_skin_mode[uid] = ("block", pb[1])
            try: await bot.edit_message_reply_markup(c.message.chat.id, c.message.message_id, reply_markup=make_keyboard(uid))
            except: pass
        else: st["inv_open"] = True

    elif d == "build":
        pb = ray_pick(st["x"], st["y"], st["z"]+1.6, st["angle"], st["tilt"], s_id, uid)
        if pb and pb[0]=="block":
            c_slot = st["inv_cursor"] if st["inv_cursor"] < 5 else 0
            item = st["inv"].get(c_slot)
            if item or srv.type == "classic":
                btype = item["type"] if item else "planks"
                bx, by, bz = pb[1]
                for offset in [(0,0,1),(0,0,-1),(0,1,0),(0,-1,0),(1,0,0),(-1,0,0)]:
                    nb = (bx+offset[0], by+offset[1], bz+offset[2])
                    if nb not in srv.blocks:
                        srv.blocks[nb] = {"type": btype} if srv.type=="survival" else {"color":(255,255,255)}
                        if item:
                            item["count"] -= 1
                            if item["count"] <= 0: del st["inv"][c_slot]
                        srv.rebuild_mesh()
                        ev = True
                        break

    elif d == "break":
        pb = ray_pick(st["x"], st["y"], st["z"]+1.6, st["angle"], st["tilt"], s_id, uid)
        if pb:
            if pb[0] == "block":
                bx, by, bz = pb[1]
                if srv.type == "survival":
                    if srv.blocks[pb[1]]["type"] != "bedrock":
                        btype = srv.blocks[pb[1]]["type"]
                        mhp = BLOCK_STATS.get(btype, 3)
                        srv.block_damage[pb[1]] = srv.block_damage.get(pb[1], 0) + 1
                        if srv.block_damage[pb[1]] >= mhp:
                            del srv.blocks[pb[1]]
                            del srv.block_damage[pb[1]]
                            for i in range(20):
                                if i in st["inv"] and st["inv"][i]["type"] == btype and st["inv"][i]["count"]<64:
                                    st["inv"][i]["count"] += 1; break
                            else:
                                for i in range(20):
                                    if i not in st["inv"]:
                                        st["inv"][i] = {"type": btype, "count": 1}; break
                        srv.rebuild_mesh()
                else:
                    del srv.blocks[pb[1]]
                    srv.rebuild_mesh()
                ev = True
            elif pb[0] == "player":
                tgt = srv.players[pb[1]]
                if pb[2] <= 4.0:
                    tgt["hp"] -= 1
                    tgt["flash_time"] = time.time()
                    if tgt["hp"] <= 0:
                        await broadcast_chat(s_id, f"💀 {tgt['name']} был убит игроком {st['name']}!")
                        tgt["hp"], tgt["x"], tgt["y"], tgt["z"] = 10, srv.size/2, srv.size/2, get_ground_z(srv.size/2, srv.size/2, srv)
                    ev = True
                    await send_view(c.message.chat.id, pb[1])

    try: await bot.answer_callback_query(c.id)
    except: pass

    tasks = [send_view(c.message.chat.id, uid)]
    if ev:
        for p_uid, ps in srv.players.items():
            if p_uid != uid and abs(ps["x"]-st["x"])<ps["view_radius"] and abs(ps["y"]-st["y"])<ps["view_radius"]:
                tasks.append(send_view(p_uid, p_uid))
    await asyncio.gather(*tasks)

async def main():
    print("Bot is starting! Loading data...")
    load_all_data()
    asyncio.create_task(auto_saver())
    print("Bot running!")
    await bot.polling(non_stop=True)

if __name__ == "__main__":
    asyncio.run(main())
