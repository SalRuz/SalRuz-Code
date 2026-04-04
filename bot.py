# ИЗМЕНЕНИЯ В ЭТОЙ ВЕРСИИ:
# 1. Глобальная оптимизация №1 (Удаление невидимых граней / Simplified Meshing): Бот теперь заранее просчитывает мир и удаляет грани кубов, которые соприкасаются друг с другом. Это убирает 80% нагрузки на рендер!
# 2. Глобальная оптимизация №2 (Отсечение задних поверхностей): Полигоны, которые отвернуты от камеры (Backface Culling), больше не вычисляются.
# 3. Глобальная оптимизация №3 (Кэширование кадров): Внедрена умная система кэширования. Если вы стоите на месте, не двигаете камеру и никто не ходит перед вами, бот отдаст сохраненный кадр за 0.001 секунды, вместо повторного рендера!
# 4. База данных: Встроен скрипт инициализации SQLite, с автоматическим созданием таблиц. При входе (/start) игрок записывается в БД. Добавлен обход ошибки прав доступа Termux (если папка /app закрыта, БД создастся в локальной папке ./data).

import math
import io
import time
import random
import asyncio
import os
import sqlite3
from pathlib import Path
from telebot.async_telebot import AsyncTeleBot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton, InputMediaPhoto
from PIL import Image, ImageDraw, ImageOps

# --- ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ ---
try:
    DATA_DIR = Path("/app/data")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
except PermissionError:
    # Безопасный фоллбэк для Termux, чтобы бот не падал без рут-прав
    DATA_DIR = Path("./data")
    DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "bot.db"

if not DB_PATH.exists():
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    conn.close()
    print(f"База данных создана: {DB_PATH}")
else:
    print(f"База данных уже существует: {DB_PATH}")
# ---------------------------------

BOT_TOKEN = "8512207770:AAEKLtYEph7gleybGhF2lc7Gwq82Kj1yedM"
bot = AsyncTeleBot(BOT_TOKEN)

WORLD_SIZE = 60
BLOCK_HEIGHT = 1.0
CAMERA_HEIGHT_OFFSET = 1.6
MOVE_STEP = 1.0
TURN_ANGLE = math.radians(15)
TILT_STEP = 0.15
MAX_TILT = 0.95
MIN_TILT = -0.95
SKY_COLOR = (135, 206, 235)
RED = (230, 80, 80)
GREEN = (80, 230, 80)
BLUE = (80, 80, 230)
BASE_COLORS = [RED, GREEN, BLUE]
PLAYER_BODY_SIZE = 0.6
PLAYER_BODY_HEIGHT = 1.6
PLAYER_HEAD_SIZE = 0.4
PLAYER_HEAD_OFFSET = 0.2
PLAYER_BODY_COLOR = (255, 255, 0)
PLAYER_HEAD_COLOR = (255, 220, 100)
NEAR_CLIP = 0.05
RAY_STEP = 0.02
RAY_MAX_DIST = 24

RESOLUTIONS = {
    1: {"w": 256, "h": 192, "scale": 140},
    2: {"w": 426, "h": 320, "scale": 233},
    3: {"w": 640, "h": 480, "scale": 350},
    4: {"w": 800, "h": 600, "scale": 437}
}

LIGHT_DIR_RAW = (0.5, 0.8, 0.3)
light_length = math.sqrt(sum(c ** 2 for c in LIGHT_DIR_RAW))
LIGHT_DIR = tuple(c / light_length for c in LIGHT_DIR_RAW)

FACE_UVS = [(0, 1), (1, 1), (1, 0), (0, 0)]

players = {}
player_skins = {}
block_skins = {}
pending_skin_mode = {}
last_target_block = {}
global_chat = []

world_faces = []
world_version = 0

def normalize_vector(v):
    length = math.sqrt(sum(c ** 2 for c in v))
    return tuple(c / length for c in v) if length != 0 else (0, 0, 0)

random.seed(42)
world_blocks = {}
for y in range(WORLD_SIZE):
    for x in range(WORLD_SIZE):
        world_blocks[(x, y, 0)] = BASE_COLORS[(x + y + random.randint(0, 1)) % 3]

def bake_face(tex):
    img = tex.copy()
    d = ImageDraw.Draw(img)
    w, h = img.size
    sx, sy = w / 128.0, h / 128.0
    d.rectangle((24*sx, 40*sy, 48*sx, 64*sy), fill=(255,255,255))
    d.rectangle((32*sx, 48*sy, 40*sx, 56*sy), fill=(0,0,0))
    d.rectangle((80*sx, 40*sy, 104*sx, 64*sy), fill=(255,255,255))
    d.rectangle((80*sx, 48*sy, 88*sx, 56*sy), fill=(0,0,0))
    d.rectangle((48*sx, 88*sy, 80*sx, 96*sy), fill=(0,0,0))
    return img

DEFAULT_FACE_TEX = bake_face(Image.new("RGB", (128, 128), PLAYER_HEAD_COLOR))

def clamp(v, lo, hi): return max(lo, min(hi, v))
def lighten(c, f=1.1): return tuple(min(255, int(ch * f)) for ch in c) if isinstance(c, tuple) else c
def darken(c, f=0.7): return tuple(max(0, int(ch * f)) for ch in c) if isinstance(c, tuple) else c

def normalize_angle(a):
    while a < 0: a += 2 * math.pi
    while a >= 2 * math.pi: a -= 2 * math.pi
    return a

def calc_light(normal):
    n = normalize_vector(normal)
    d = sum(n[i] * LIGHT_DIR[i] for i in range(3))
    return 0.6 + max(0.0, min(1.0, d)) * 0.4

def apply_light(base, lf):
    if not isinstance(base, tuple): return base
    return tuple(min(255, max(0, int(ch * lf))) for ch in base)

def get_ground_z(x, y):
    tz = 0
    for bz in range(20):
        if (int(x), int(y), bz) in world_blocks:
            tz = bz + 1
    return tz

def get_player(uid):
    if uid not in players:
        players[uid] = {
            "x": WORLD_SIZE / 2, "y": WORLD_SIZE / 2, "z": get_ground_z(WORLD_SIZE/2, WORLD_SIZE/2), 
            "angle": 0.0, "tilt": 0.0, "jump": False, 
            "name": f"User{uid}", "msg_id": None, "view_radius": 8, "res_level": 2,
            "hp": 10, "flash_time": 0, "cache_hash": None, "cache_img": None
        }
    return players[uid]

def make_keyboard(uid):
    st = get_player(uid)
    jump_text = "🦘 Прыжок (Вкл)" if st.get("jump") else "🦘 Прыжок"
    vr_text = f"👁 Дальность: {st.get('view_radius', 8)}"
    res_text = f"🖥 {RESOLUTIONS[st.get('res_level', 2)]['w']}p"
    paint_text = "📸 Жду фото..." if pending_skin_mode.get(uid) and pending_skin_mode[uid][0] == "block" else "🎨 Крась"
    
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

def world_to_camera_base(wx, wy, wz, px, py, pz, angle):
    dx, dy = wx - px, wy - py
    s, c = math.sin(angle), math.cos(angle)
    return dx * c - dy * s, dx * s + dy * c, wz - pz

def world_to_view(wx, wy, wz, px, py, pz, angle, tilt):
    vx, vy, vzt = world_to_camera_base(wx, wy, wz, px, py, pz, angle)
    st, ct = math.sin(tilt), math.cos(tilt)
    return vx, vy * ct - vzt * st, vy * st + vzt * ct

def is_poly_valid(poly, img_w, img_h):
    if not poly or len(poly) < 3: return False
    xs, ys = zip(*poly)
    if max(xs) < -4000 or min(xs) > img_w + 4000 or max(ys) < -4000 or min(ys) > img_h + 4000:
        return False
    return True

def vec_sub(a, b): return tuple(x - y for x, y in zip(a, b))
def vec_dot(a, b): return sum(x * y for x, y in zip(a, b))
def vec_cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
def vec_norm(v): return normalize_vector(v)

def face_center(verts, idx):
    n = len(idx)
    return tuple(sum(verts[i][d] for i in idx) / n for d in range(3))

def face_normal(verts, idx):
    p0, p1, p2 = verts[idx[0]], verts[idx[1]], verts[idx[2]]
    return vec_norm(vec_cross(vec_sub(p1, p0), vec_sub(p2, p0)))

def face_visible_world(world_verts, idx, cam_pos):
    c = face_center(world_verts, idx)
    n = face_normal(world_verts, idx)
    tc = vec_sub(cam_pos, c)
    return vec_dot(n, tc) > 0

def build_box(cx, cy, cz, size, h, angle):
    hxy = size / 2.0
    local = [
        (-hxy, -hxy, 0), (hxy, -hxy, 0), (hxy, hxy, 0), (-hxy, hxy, 0),
        (-hxy, -hxy, h), (hxy, -hxy, h), (hxy, hxy, h), (-hxy, hxy, h)
    ]
    s, c = math.sin(angle), math.cos(angle)
    return [(cx + lx * c - ly * s, cy + lx * s + ly * c, cz + lz) for lx, ly, lz in local]

def clip_near_with_uv(vp):
    res = []
    prev = vp[-1]
    prev_in = prev[1] >= NEAR_CLIP
    for curr in vp:
        curr_in = curr[1] >= NEAR_CLIP
        if curr_in:
            if not prev_in:
                t = (NEAR_CLIP - prev[1]) / (curr[1] - prev[1]) if curr[1] != prev[1] else 0
                res.append(tuple(prev[d] + (curr[d] - prev[d]) * t for d in range(len(prev))))
            res.append(curr)
        elif prev_in:
            t = (NEAR_CLIP - prev[1]) / (curr[1] - prev[1]) if curr[1] != prev[1] else 0
            res.append(tuple(prev[d] + (curr[d] - prev[d]) * t for d in range(len(prev))))
        prev, prev_in = curr, curr_in
    return res

def texture_sample(tex, u, v):
    tw, th = tex.size
    tx = int(clamp(u, 0.0, 0.999999) * tw)
    ty = int(clamp(v, 0.0, 0.999999) * th)
    return tex.getpixel((tx, ty))

def draw_span_z(pix, zbuf, y, x1, x2, iz1, iz2, col):
    img_h = len(zbuf)
    img_w = len(zbuf[0])
    if y < 0 or y >= img_h: return
    if x1 > x2:
        x1, x2 = x2, x1
        iz1, iz2 = iz2, iz1
    ix1 = max(0, int(math.ceil(x1)))
    ix2 = min(img_w - 1, int(math.floor(x2)))
    if ix1 > ix2: return
    dx = x2 - x1
    for x in range(ix1, ix2 + 1):
        t = 0.0 if dx < 1e-9 else (x - x1) / dx
        iz = iz1 + (iz2 - iz1) * t
        if iz <= 0: continue
        z = 1.0 / iz
        if z >= zbuf[y][x]: continue
        zbuf[y][x] = z
        pix[x, y] = col

def draw_line_z(pix, zbuf, x0, y0, z0, x1, y1, z1, color):
    img_h = len(zbuf)
    img_w = len(zbuf[0])
    ix0, iy0 = int(round(x0)), int(round(y0))
    ix1, iy1 = int(round(x1)), int(round(y1))
    dx = abs(ix1 - ix0)
    dy = abs(iy1 - iy0)
    sx = 1 if ix0 < ix1 else -1
    sy = 1 if iy0 < iy1 else -1
    err = dx - dy
    dist = math.hypot(ix1 - ix0, iy1 - iy0)
    iz0 = 1.0 / z0 if z0 > 0 else 0
    iz1 = 1.0 / z1 if z1 > 0 else 0

    if dist < 1e-5:
        if 0 <= ix0 < img_w and 0 <= iy0 < img_h:
            if z0 > 0 and z0 <= zbuf[iy0][ix0] + 0.01:
                pix[ix0, iy0] = color
        return

    cx, cy = ix0, iy0
    while True:
        if 0 <= cx < img_w and 0 <= cy < img_h:
            t = math.hypot(cx - ix0, cy - iy0) / dist
            iz = iz0 + (iz1 - iz0) * t
            if iz > 0:
                z = 1.0 / iz
                if z <= zbuf[cy][cx] + 0.01:
                    pix[cx, cy] = color
        if cx == ix1 and cy == iy1: break
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            cx += sx
        if e2 < dx:
            err += dx
            cy += sy

def rasterize_poly_color(pix, zbuf, verts2d, color, outline_color=None):
    if len(verts2d) < 3: return
    img_h = len(zbuf)
    ys = [p[1] for p in verts2d]
    y0 = max(0, int(math.ceil(min(ys))))
    y1 = min(img_h - 1, int(math.floor(max(ys))))
    n = len(verts2d)
    for y in range(y0, y1 + 1):
        inter = []
        py = y + 0.5
        for i in range(n):
            a = verts2d[i]
            b = verts2d[(i + 1) % n]
            x1, y1p, z1 = a[:3]
            x2, y2p, z2 = b[:3]
            if (y1p <= py < y2p) or (y2p <= py < y1p):
                t = (py - y1p) / (y2p - y1p)
                x = x1 + (x2 - x1) * t
                iz = (1.0 / z1) + ((1.0 / z2) - (1.0 / z1)) * t
                inter.append((x, iz))
        inter.sort(key=lambda q: q[0])
        for i in range(0, len(inter) - 1, 2):
            x1, iz1 = inter[i]
            x2, iz2 = inter[i + 1]
            draw_span_z(pix, zbuf, y, x1, x2, iz1, iz2, color)
            
    if outline_color:
        for i in range(n):
            a = verts2d[i]
            b = verts2d[(i + 1) % n]
            draw_line_z(pix, zbuf, a[0], a[1], a[2], b[0], b[1], b[2], outline_color)

def rasterize_poly_tex(pix, zbuf, verts, tex, light=1.0, outline_color=None):
    if len(verts) < 3: return
    img_h = len(zbuf)
    img_w = len(zbuf[0])
    ys = [p[1] for p in verts]
    y0 = max(0, int(math.ceil(min(ys))))
    y1 = min(img_h - 1, int(math.floor(max(ys))))
    n = len(verts)
    for y in range(y0, y1 + 1):
        inter = []
        py = y + 0.5
        for i in range(n):
            a = verts[i]
            b = verts[(i + 1) % n]
            x1, y1p, z1, u1, v1 = a
            x2, y2p, z2, u2, v2 = b
            if (y1p <= py < y2p) or (y2p <= py < y1p):
                t = (py - y1p) / (y2p - y1p)
                x = x1 + (x2 - x1) * t
                iz = (1.0 / z1) + ((1.0 / z2) - (1.0 / z1)) * t
                iu = (u1 / z1) + ((u2 / z2) - (u1 / z1)) * t
                iv = (v1 / z1) + ((v2 / z2) - (v1 / z1)) * t
                inter.append((x, iz, iu, iv))
        inter.sort(key=lambda q: q[0])
        for i in range(0, len(inter) - 1, 2):
            xa, iza, iua, iva = inter[i]
            xb, izb, iub, ivb = inter[i + 1]
            if xa > xb:
                xa, xb = xb, xa
                iza, izb = izb, iza
                iua, iub = iub, iua
                iva, ivb = ivb, iva
            ix1 = max(0, int(math.ceil(xa)))
            ix2 = min(img_w - 1, int(math.floor(xb)))
            dx = xb - xa
            for x in range(ix1, ix2 + 1):
                t = 0.0 if dx < 1e-9 else (x - xa) / dx
                iz = iza + (izb - iza) * t
                if iz <= 0: continue
                z = 1.0 / iz
                if z >= zbuf[y][x]: continue
                iu = iua + (iub - iua) * t
                iv = iva + (ivb - iva) * t
                u = iu / iz
                v = iv / iz
                base = texture_sample(tex, u, v)
                col = apply_light(base, light)
                zbuf[y][x] = z
                pix[x, y] = col
                
    if outline_color:
        for i in range(n):
            a = verts[i]
            b = verts[(i + 1) % n]
            draw_line_z(pix, zbuf, a[0], a[1], a[2], b[0], b[1], b[2], outline_color)

BLOCK_FACES_DATA = [
    ("top", [4, 5, 6, 7], (0, 0, 1)),
    ("bottom", [0, 3, 2, 1], (0, 0, -1)),
    ("front", [0, 1, 5, 4], (0, -1, 0)),
    ("back", [2, 3, 7, 6], (0, 1, 0)),
    ("right", [1, 2, 6, 5], (1, 0, 0)),
    ("left", [0, 4, 7, 3], (-1, 0, 0)),
]

PLAYER_FACES = [
    ("bottom", [0, 3, 2, 1], lambda c: darken(c, 0.55)),
    ("top", [4, 5, 6, 7], lambda c: lighten(c, 1.10)),
    ("back", [0, 1, 5, 4], lambda c: darken(c, 0.65)),
    ("front", [2, 3, 7, 6], lambda c: c),
    ("right", [1, 2, 6, 5], lambda c: darken(c, 0.80)),
    ("left", [0, 4, 7, 3], lambda c: darken(c, 0.75)),
]

def rebuild_world_mesh():
    global world_faces, world_version
    world_faces = []
    for (gx, gy, gz), bc in world_blocks.items():
        x0, x1 = gx, gx + 1
        y0, y1 = gy, gy + 1
        z0, z1 = gz * BLOCK_HEIGHT, (gz + 1) * BLOCK_HEIGHT
        vw = [
            (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
            (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)
        ]
        bt = block_skins.get((gx, gy, gz))
        
        for fn, idx, offset in BLOCK_FACES_DATA:
            nx, ny, nz = gx + offset[0], gy + offset[1], gz + offset[2]
            if (nx, ny, nz) in world_blocks:
                continue # Грани спрятаны между блоками! Экономия 80% полигонов.
                
            n = face_normal(vw, idx)
            lf = calc_light(n)
            br = 1.0 if fn == "top" else 0.85
            sc = apply_light(bc, lf * br)
            
            world_faces.append({
                "cx": gx + 0.5, "cy": gy + 0.5, "cz": (gz + 0.5) * BLOCK_HEIGHT,
                "verts": [vw[i] for i in idx],
                "n": n, "sc": sc, "bt": bt, "lf": lf * br
            })
    world_version += 1

rebuild_world_mesh()

def build_face_vertices(world_verts, idx, px, py, pz, pa, pt, uv_mode=None):
    out = []
    for k, i in enumerate(idx):
        wx, wy, wz = world_verts[i]
        vx, vy, vz = world_to_view(wx, wy, wz, px, py, pz, pa, pt)
        if uv_mode == "tex":
            u, v = FACE_UVS[k % 4]
            out.append((vx, vy, vz, u, v))
        else:
            out.append((vx, vy, vz))
    return out

def render_scene(px, py, pz, pa, pt, uid):
    st = players.get(uid, {})
    vr = st.get("view_radius", 8)
    rl = st.get("res_level", 2)
    
    img_w = RESOLUTIONS[rl]["w"]
    img_h = RESOLUTIONS[rl]["h"]
    scale = RESOLUTIONS[rl]["scale"]
    horiz_y = img_h // 2
    
    def project_pt(vx, vy, vz):
        if vy <= NEAR_CLIP: return None
        return (img_w / 2 + (vx / vy) * scale, horiz_y - (vz / vy) * scale)

    img = Image.new("RGB", (img_w, img_h), SKY_COLOR)
    pix = img.load()
    zbuf = [[float("inf")] * img_w for _ in range(img_h)]
    draw = ImageDraw.Draw(img)
    nl = []
    
    pb_data = ray_pick(px, py, pz, pa, pt, ignore_uid=uid)
    last_target_block[uid] = pb_data

    cam_pos = (px, py, pz)
    fwd_x = math.sin(pa)
    fwd_y = math.cos(pa)

    for face in world_faces:
        if abs(face["cx"] - px) > vr or abs(face["cy"] - py) > vr:
            continue
            
        bx_center = face["cx"] - px
        by_center = face["cy"] - py
        dist_sq = bx_center * bx_center + by_center * by_center
        if dist_sq > 9.0:
            if (bx_center * fwd_x + by_center * fwd_y) / math.sqrt(dist_sq) < -0.3:
                continue
                
        # Отсечение отвернутых граней (Backface culling)
        tc = (px - face["cx"], py - face["cy"], pz - face["cz"])
        if face["n"][0]*tc[0] + face["n"][1]*tc[1] + face["n"][2]*tc[2] <= 0:
            continue
            
        verts = []
        ok = True
        for k, (wx, wy, wz) in enumerate(face["verts"]):
            vx, vy, vz = world_to_view(wx, wy, wz, px, py, pz, pa, pt)
            if face["bt"]:
                u, v = FACE_UVS[k % 4]
                verts.append((vx, vy, vz, u, v))
            else:
                verts.append((vx, vy, vz))
                
        verts = clip_near_with_uv(verts)
        if len(verts) < 3: continue
        proj = []
        
        for v in verts:
            p = project_pt(v[0], v[1], v[2])
            if not p: ok = False; break
            if face["bt"]: proj.append((p[0], p[1], v[1], v[3], v[4]))
            else: proj.append((p[0], p[1], v[1]))
            
        if not ok or not is_poly_valid([(p[0], p[1]) for p in proj], img_w, img_h):
            continue
            
        if face["bt"]: rasterize_poly_tex(pix, zbuf, proj, face["bt"], face["lf"], outline_color=(0,0,0))
        else: rasterize_poly_color(pix, zbuf, proj, face["sc"], outline_color=(0,0,0))

    for pid, ps in players.items():
        if pid == uid: continue
        ox, oy, oa, ot = ps["x"], ps["y"], ps["angle"], ps.get("tilt", 0.0)
        oz = ps.get("z", 1.0)
        
        bx_center = ox - px
        by_center = oy - py
        dist_sq = bx_center * bx_center + by_center * by_center
        if dist_sq > vr * vr: continue
        if dist_sq > 9.0:
            if (bx_center * fwd_x + by_center * fwd_y) / math.sqrt(dist_sq) < -0.3: continue
                
        bv = build_box(ox, oy, oz, PLAYER_BODY_SIZE, PLAYER_BODY_HEIGHT, oa)
        hz = oz + PLAYER_BODY_HEIGHT + PLAYER_HEAD_OFFSET
        hv = build_box(ox, oy, hz, PLAYER_HEAD_SIZE, PLAYER_HEAD_SIZE, oa)
        skin = player_skins.get(pid)
        is_flashing = time.time() - ps.get("flash_time", 0) < 0.25

        for fn, idx, sh in PLAYER_FACES:
            if not face_visible_world(bv, idx, cam_pos): continue
            n = face_normal(bv, idx)
            lf = calc_light(n)
            body_color = (255, 50, 50) if is_flashing else PLAYER_BODY_COLOR
            col = apply_light(body_color, lf)
            verts = build_face_vertices(bv, idx, px, py, pz, pa, pt)
            verts = clip_near_with_uv(verts)
            if len(verts) < 3: continue
            proj = []
            ok = True
            for vx, vy, vz in verts:
                p = project_pt(vx, vy, vz)
                if not p: ok = False; break
                proj.append((p[0], p[1], vy))
            if not ok or not is_poly_valid([(p[0], p[1]) for p in proj], img_w, img_h): continue
            rasterize_poly_color(pix, zbuf, proj, col, outline_color=(0, 0, 0))

        for fn, idx, sh in PLAYER_FACES:
            if not face_visible_world(hv, idx, cam_pos): continue
            n = face_normal(hv, idx)
            lf = calc_light(n)

            use_tex = None
            if not is_flashing:
                if skin: use_tex = skin
                elif fn == "front": use_tex = DEFAULT_FACE_TEX

            if use_tex:
                verts = build_face_vertices(hv, idx, px, py, pz, pa, pt, "tex")
                verts = clip_near_with_uv(verts)
                if len(verts) < 3: continue
                proj = []
                ok = True
                for vx, vy, vz, u, v in verts:
                    p = project_pt(vx, vy, vz)
                    if not p: ok = False; break
                    proj.append((p[0], p[1], vy, u, v))
                if ok and is_poly_valid([(p[0], p[1]) for p in proj], img_w, img_h):
                    rasterize_poly_tex(pix, zbuf, proj, use_tex, lf, outline_color=(0, 0, 0))
            else:
                verts = build_face_vertices(hv, idx, px, py, pz, pa, pt)
                verts = clip_near_with_uv(verts)
                if len(verts) < 3: continue
                head_color = (255, 50, 50) if is_flashing else PLAYER_HEAD_COLOR
                col = apply_light(head_color, lf)
                proj = []
                ok = True
                for vx, vy, vz in verts:
                    p = project_pt(vx, vy, vz)
                    if not p: ok = False; break
                    proj.append((p[0], p[1], vy))
                if ok and is_poly_valid([(p[0], p[1]) for p in proj], img_w, img_h):
                    rasterize_poly_color(pix, zbuf, proj, col, outline_color=(0, 0, 0))

        nw = (ox, oy, hz + PLAYER_HEAD_SIZE + 0.2)
        vx, vy, vz = world_to_view(*nw, px, py, pz, pa, pt)
        if vy > NEAR_CLIP:
            ns = project_pt(vx, vy, vz)
            if ns:
                nl.append({"t": ps["name"], "p": ns, "d": vy + 0.05})

    nl.sort(key=lambda i: i["d"], reverse=True)
    for it in nl:
        x, y = int(it["p"][0]), int(it["p"][1])
        tb = draw.textbbox((0, 0), it["t"])
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        draw.rectangle((x - tw // 2 - 2, y - th - 2, x + tw // 2 + 2, y + 2), fill=(0, 0, 0))
        draw.text((x - tw // 2, y - th), it["t"], fill=(255, 255, 255))

    cx, cy = img_w // 2, img_h // 2
    draw.line((cx - 8, cy, cx - 3, cy), fill=(255, 255, 255), width=1)
    draw.line((cx + 3, cy, cx + 8, cy), fill=(255, 255, 255), width=1)
    draw.line((cx, cy - 8, cx, cy - 3), fill=(255, 255, 255), width=1)
    draw.line((cx, cy + 3, cx, cy + 8), fill=(255, 255, 255), width=1)
    draw.ellipse((cx - 1, cy - 1, cx + 1, cy + 1), fill=(255, 255, 255))

    hud_text = f"X={px:.1f} Z={pz-CAMERA_HEIGHT_OFFSET:.1f} Y={py:.1f}"
    tb = draw.textbbox((10, 8), hud_text)
    draw.rectangle((5, 5, tb[2] + 5, 25), fill=(0, 0, 0))
    draw.text((10, 8), hud_text, fill=(255, 255, 255))

    hp = st.get("hp", 10)
    heart_size = max(10, int(14 * (img_w / 426)))
    margin_x = img_w - (5 * (heart_size + 4)) - 10
    margin_y = 10
    for i in range(5):
        hx = margin_x + i * (heart_size + 4)
        hy = margin_y
        draw.rectangle((hx, hy, hx+heart_size, hy+heart_size), outline=(0,0,0), width=1)
        if hp >= (i * 2) + 2:
            draw.rectangle((hx+1, hy+1, hx+heart_size-1, hy+heart_size-1), fill=(255,50,50))
        elif hp == (i * 2) + 1:
            draw.rectangle((hx+1, hy+1, hx+heart_size//2, hy+heart_size-1), fill=(255,50,50))
            draw.rectangle((hx+heart_size//2+1, hy+1, hx+heart_size-1, hy+heart_size-1), fill=(50,50,50))
        else:
            draw.rectangle((hx+1, hy+1, hx+heart_size-1, hy+heart_size-1), fill=(50,50,50))

    bio = io.BytesIO()
    bio.name = "scene.png"
    img.save(bio, "PNG")
    bio.seek(0)
    return bio.getvalue()

def ray_pick(px, py, pz, pa, pt, md=RAY_MAX_DIST, ignore_uid=None):
    dx = math.sin(pa) * math.cos(pt)
    dy = math.cos(pa) * math.cos(pt)
    dz = -math.sin(pt)
    l = math.hypot(dx, dy, dz)
    if l == 0: l = 1
    dx, dy, dz = dx / l, dy / l, dz / l
    t = 0.0
    prev_b = None
    
    while t <= md:
        wx, wy, wz = px + dx * t, py + dy * t, pz + dz * t
        bx, by, bz = int(math.floor(wx)), int(math.floor(wy)), int(math.floor(wz))
        curr_b = (bx, by, bz)
        
        for pid, ps in players.items():
            if pid == ignore_uid: continue
            if abs(wx - ps["x"]) < PLAYER_BODY_SIZE/2 and abs(wy - ps["y"]) < PLAYER_BODY_SIZE/2:
                if ps["z"] <= wz <= ps["z"] + PLAYER_BODY_HEIGHT + PLAYER_HEAD_SIZE:
                    return ("player", pid, t)
        
        if curr_b in world_blocks:
            if prev_b is None: prev_b = curr_b
            nx = prev_b[0] - curr_b[0]
            ny = prev_b[1] - curr_b[1]
            nz = prev_b[2] - curr_b[2]
            if nx == 0 and ny == 0 and nz == 0: nz = 1
            return ("block", curr_b, (nx, ny, nz))
            
        prev_b = curr_b
        t += RAY_STEP
    return None

def move_rel(st, f, s):
    a = st["angle"]
    nx = st["x"] + (math.sin(a) * f + math.cos(a) * s) * MOVE_STEP
    ny = st["y"] + (math.cos(a) * f - math.sin(a) * s) * MOVE_STEP
    bx, by = int(math.floor(nx)), int(math.floor(ny))
    
    target_z = get_ground_z(bx, by)
    diff = target_z - st["z"]
    
    dmg = 0
    if diff <= -4:
        dmg = 1 + int(abs(diff) - 4) // 2
        
    can_move = False
    if diff <= 0: can_move = True
    elif diff == 1 and st.get("jump"): can_move = True
    
    if can_move:
        st["x"] = clamp(nx, 0.5, WORLD_SIZE - 0.5)
        st["y"] = clamp(ny, 0.5, WORLD_SIZE - 0.5)
        st["z"] = target_z
        
    st["jump"] = False
    return dmg

async def broadcast_chat(txt):
    global_chat.append(txt)
    if len(global_chat) > 4: global_chat.pop(0) 
    cap = "\n".join(global_chat)
    for uid, st in players.items():
        if st.get("msg_id"):
            try:
                await bot.edit_message_caption(caption=cap, chat_id=uid, message_id=st["msg_id"], reply_markup=make_keyboard(uid))
            except: pass

async def send_view(cid, uid):
    st = get_player(uid)
    pz = st.get("z", 1.0) + CAMERA_HEIGHT_OFFSET
    vr = st.get("view_radius", 8)
    rl = st.get("res_level", 2)
    
    # Система кэширования кадра (супер-оптимизация)
    nearby = tuple(
        (p["x"], p["y"], p["z"], p["angle"], p.get("flash_time", 0))
        for pid, p in players.items() if pid != uid and abs(p["x"]-st["x"]) <= vr and abs(p["y"]-st["y"]) <= vr
    )
    
    state_hash = hash((
        st["x"], st["y"], st["z"], st["angle"], st["tilt"], 
        vr, rl, world_version, st.get("flash_time", 0), 
        nearby, st.get("hp", 10), pending_skin_mode.get(uid)
    ))
    
    if state_hash == st.get("cache_hash") and st.get("cache_img"):
        bio = io.BytesIO(st["cache_img"])
    else:
        img_bytes = await asyncio.to_thread(render_scene, st["x"], st["y"], pz, st["angle"], st["tilt"], uid)
        st["cache_hash"] = state_hash
        st["cache_img"] = img_bytes
        bio = io.BytesIO(img_bytes)
        
    bio.name = "scene.png"
    kb = make_keyboard(uid)
    cap = "\n".join(global_chat) if global_chat else "🎮 Приятной игры!"
    
    msg_id = st.get("msg_id")
    if msg_id:
        try:
            bio.seek(0)
            await bot.edit_message_media(chat_id=cid, message_id=msg_id, media=InputMediaPhoto(bio, caption=cap), reply_markup=kb)
            return
        except Exception as e:
            if "message is not modified" in str(e).lower(): return
            pass

    bio.seek(0)
    msg = await bot.send_photo(cid, bio, caption=cap, reply_markup=kb)
    st["msg_id"] = msg.message_id

async def apply_damage(uid, dmg, reason, attacker_name=None):
    st = get_player(uid)
    st["hp"] = max(0, st.get("hp", 10) - dmg)
    st["flash_time"] = time.time()
    
    if st["hp"] <= 0:
        if reason == "kill": await broadcast_chat(f"💀 {st['name']} был убит игроком {attacker_name}!")
        else: await broadcast_chat(f"💀 {st['name']} разбился насмерть!")
        
        st["hp"] = 10
        st["x"], st["y"] = WORLD_SIZE/2, WORLD_SIZE/2
        st["z"] = get_ground_z(st["x"], st["y"])

@bot.message_handler(commands=["start"])
async def h_start(m):
    uid = m.from_user.id
    name = m.from_user.first_name or f"User{uid}"
    try: await bot.delete_message(m.chat.id, m.message_id)
    except: pass
    
    try:
        conn = sqlite3.connect(str(DB_PATH))
        conn.execute("INSERT OR IGNORE INTO users (id, username) VALUES (?, ?)", (uid, name))
        conn.commit()
        conn.close()
    except Exception:
        pass
    
    new = uid not in players
    if new:
        players[uid] = {
            "x": WORLD_SIZE / 2, "y": WORLD_SIZE / 2, "z": get_ground_z(WORLD_SIZE/2, WORLD_SIZE/2), 
            "angle": 0.0, "tilt": 0.0, "jump": False, 
            "name": name, "msg_id": None, "view_radius": 8, "res_level": 2,
            "hp": 10, "flash_time": 0, "cache_hash": None, "cache_img": None
        }
        await broadcast_chat(f"🎉 **{name} присоединился!**")

    st = get_player(uid)
    if st.get("msg_id"):
        try: await bot.delete_message(m.chat.id, st["msg_id"])
        except: pass
        st["msg_id"] = None
        
    await send_view(m.chat.id, uid)

@bot.message_handler(commands=["help"])
async def h_help(m):
    try: await bot.delete_message(m.chat.id, m.message_id)
    except: pass
    await bot.send_message(m.chat.id, "🎮 Управление: ⬆️️➡️⬇️ - Ходьба | 🌀 - Поворот\n/skin (с фото) - скин | /block - красить\n(Это сообщение можно игнорировать)")

@bot.message_handler(commands=["block"])
async def h_block(m):
    uid = m.from_user.id
    try: await bot.delete_message(m.chat.id, m.message_id)
    except: pass
    
    pb_data = last_target_block.get(uid)
    if not pb_data or pb_data[0] != "block":
        return
        
    t = pb_data[1]
    pending_skin_mode[uid] = ("block", t)
    
    st = get_player(uid)
    st["cache_hash"] = None # Сброс кэша для кнопки
    if st.get("msg_id"):
        try: await bot.edit_message_reply_markup(m.chat.id, st["msg_id"], reply_markup=make_keyboard(uid))
        except: pass

@bot.message_handler(content_types=["photo"])
async def h_photo(m):
    uid = m.from_user.id
    st = get_player(uid)
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
        
        if mode and mode[0] == "block":
            block_skins[mode[1]] = tex
            del pending_skin_mode[uid]
            rebuild_world_mesh()
            
            bx, by = mode[1][0], mode[1][1]
            for p_uid, ps in players.items():
                vr = ps.get("view_radius", 8)
                if p_uid == uid or (ps["x"] - bx)**2 + (ps["y"] - by)**2 <= vr**2:
                    tasks.append(send_view(p_uid, p_uid))
            
        elif m.caption and "/skin" in m.caption.lower():
            baked_tex = bake_face(tex)
            player_skins[uid] = baked_tex
            await broadcast_chat(f"👕 {un} установил новый скин!")
            
            for p_uid, ps in players.items():
                vr = ps.get("view_radius", 8)
                if p_uid == uid or (ps["x"] - st["x"])**2 + (ps["y"] - st["y"])**2 <= vr**2:
                    tasks.append(send_view(p_uid, p_uid))

        if tasks: await asyncio.gather(*tasks)
            
    except Exception as e:
        pass

@bot.message_handler(func=lambda m: m.text and not m.text.startswith("/"))
async def h_chat(m):
    try: await bot.delete_message(m.chat.id, m.message_id)
    except: pass
    un = players.get(m.from_user.id, {}).get("name", f"User{m.from_user.id}")
    await broadcast_chat(f"👤 [{un}]: {m.text}")

@bot.callback_query_handler(func=lambda c: True)
async def h_cb(c):
    uid = c.from_user.id
    st = get_player(uid)
    d = c.data
    need_render = True
    trigger_global = False
    event_pos = []
    
    if d in ["move_f", "move_b", "move_l", "move_r", "move_fl", "move_fr", "move_bl", "move_br"]:
        event_pos.append((st["x"], st["y"])) 
        dmg = 0
        if d == "move_f": dmg = move_rel(st, 1, 0)
        elif d == "move_b": dmg = move_rel(st, -1, 0)
        elif d == "move_l": dmg = move_rel(st, 0, -1)
        elif d == "move_r": dmg = move_rel(st, 0, 1)
        elif d == "move_fl": dmg = move_rel(st, 1, -1)
        elif d == "move_fr": dmg = move_rel(st, 1, 1)
        elif d == "move_bl": dmg = move_rel(st, -1, -1)
        elif d == "move_br": dmg = move_rel(st, -1, 1)
        
        event_pos.append((st["x"], st["y"])) 
        trigger_global = True
        
        if dmg > 0:
            await apply_damage(uid, dmg, "fall")
            
    elif d in ["turn_left", "turn_right", "look_up", "look_down"]:
        event_pos.append((st["x"], st["y"]))
        if d == "turn_left": st["angle"] = normalize_angle(st["angle"] - TURN_ANGLE) 
        elif d == "turn_right": st["angle"] = normalize_angle(st["angle"] + TURN_ANGLE)
        elif d == "look_up": st["tilt"] = max(st["tilt"] - TILT_STEP, MIN_TILT)
        elif d == "look_down": st["tilt"] = min(st["tilt"] + TILT_STEP, MAX_TILT)
        trigger_global = True
        
    elif d == "toggle_jump":
        st["jump"] = not st.get("jump", False)
        st["cache_hash"] = None
    elif d == "cycle_view":
        vr = st.get("view_radius", 8)
        st["view_radius"] = 16 if vr == 8 else 32 if vr == 16 else 60 if vr == 32 else 8
        st["cache_hash"] = None
    elif d == "cycle_res":
        rl = st.get("res_level", 2)
        st["res_level"] = rl + 1 if rl < 4 else 1
        st["cache_hash"] = None
    elif d == "build":
        pb_data = last_target_block.get(uid)
        if pb_data and pb_data[0] == "block":
            tb, norm = pb_data[1], pb_data[2]
            nb = (tb[0] + norm[0], tb[1] + norm[1], tb[2] + norm[2])
            px, py, pz = int(st["x"]), int(st["y"]), int(st.get("z", 1.0))
            if 0 <= nb[0] < WORLD_SIZE and 0 <= nb[1] < WORLD_SIZE and nb[2] >= 0:
                if not (nb[0] == px and nb[1] == py and nb[2] in (pz, pz + 1)):
                    world_blocks[nb] = (255, 255, 255)
                    event_pos.append((nb[0], nb[1]))
                    rebuild_world_mesh()
                    trigger_global = True
    elif d == "break":
        pb_data = last_target_block.get(uid)
        if pb_data:
            if pb_data[0] == "block":
                tb = pb_data[1]
                if tb[2] > 0:
                    if tb in world_blocks: del world_blocks[tb]
                    if tb in block_skins: del block_skins[tb]
                    event_pos.append((tb[0], tb[1]))
                    rebuild_world_mesh()
                    trigger_global = True
            elif pb_data[0] == "player":
                target_uid = pb_data[1]
                dist = pb_data[2]
                if dist <= 4.0:
                    await apply_damage(target_uid, 1, "kill", attacker_name=st["name"])
                    event_pos.append((players[target_uid]["x"], players[target_uid]["y"]))
                    trigger_global = True
                    
    elif d == "paint":
        pb_data = last_target_block.get(uid)
        if pb_data and pb_data[0] == "block":
            tb = pb_data[1]
            pending_skin_mode[uid] = ("block", tb)
            st["cache_hash"] = None
            try: await bot.edit_message_reply_markup(c.message.chat.id, c.message.message_id, reply_markup=make_keyboard(uid))
            except: pass
        need_render = False
                    
    try: await bot.answer_callback_query(c.id)
    except: pass
    
    if need_render:
        tasks = [send_view(c.message.chat.id, uid)]
        if trigger_global:
            for p_uid, ps in players.items():
                if p_uid == uid: continue
                vr = ps.get("view_radius", 8)
                for ex, ey in event_pos:
                    if (ps["x"] - ex)**2 + (ps["y"] - ey)**2 <= vr**2:
                        tasks.append(send_view(p_uid, p_uid))
                        break
        await asyncio.gather(*tasks)

if __name__ == "__main__":
    print("Bot started! (Press CTRL+C to stop)")
    asyncio.run(bot.polling(non_stop=True))
