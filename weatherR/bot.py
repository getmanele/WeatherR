#!/usr/bin/env python3
"""Бот weatherR и локальный сервер мини-приложения."""

import json
import math
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

from sources.compare import compare_point

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "users.sqlite"
RADIUS_KM = 50
CACHE_SECONDS = 600
POINT_CACHE_SECONDS = 50
WARSAW = ZoneInfo("Europe/Warsaw")
RAIN_CODES = set(range(61, 68)) | set(range(80, 83)) | {95, 96, 99}
SNOW_CODES = set(range(71, 78)) | {85, 86}

PLACES = [
    {
        "id": "szczecin",
        "query": "Szczecin",
        "label": "Щецин",
        "center": True,
        "fallback": (53.42894, 14.55302),
    },
    {
        "id": "police",
        "query": "Police",
        "label": "Полице",
        "fallback": (53.5521, 14.5718),
    },
    {
        "id": "goleniow",
        "query": "Goleniów",
        "label": "Голенюв",
        "fallback": (53.5639, 14.8285),
    },
    {
        "id": "gryfino",
        "query": "Gryfino",
        "label": "Грыфино",
        "fallback": (53.2524, 14.4883),
    },
    {
        "id": "stargard",
        "query": "Stargard",
        "label": "Старгард",
        "fallback": (53.3367, 15.0499),
    },
    {
        "id": "choszczno",
        "query": "Choszczno",
        "label": "Хощно",
        "always": True,
        "fallback": (53.16905, 15.42054),
    },
    {
        "id": "khmelnytskyi",
        "query": "Khmelnytskyi",
        "label": "Хмельницкий",
        "always": True,
        "fallback": (49.41835, 26.97936),
    },
]

_cache = {"at": 0.0, "data": None}
_point_cache = {}


def load_env(path):
    values = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


ENV = load_env(ROOT / ".env")
TOKEN = ENV.get("BOT_TOKEN", "")
PORT = int(ENV.get("PORT") or 8080)
WEBAPP_URL = (ENV.get("WEBAPP_URL") or f"http://127.0.0.1:{PORT}").rstrip("/")


def http_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "weatherR/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def haversine(a, b):
    radius = 6371.0
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    hav = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(hav))


def condition_ru(code):
    code = int(code)
    if code == 0:
        return "ясно"
    if code == 1:
        return "преимущественно ясно"
    if code == 2:
        return "переменная облачность"
    if code == 3:
        return "пасмурно"
    if code in (45, 48):
        return "туман"
    if 51 <= code <= 55:
        return "морось"
    if code in (56, 57):
        return "ледяная морось"
    if 61 <= code <= 65:
        return "дождь"
    if code in (66, 67):
        return "ледяной дождь"
    if 71 <= code <= 75:
        return "снег"
    if code == 77:
        return "снежные зёрна"
    if 80 <= code <= 82:
        return "ливень"
    if code in (85, 86):
        return "снегопад"
    if code == 95:
        return "гроза"
    if code in (96, 99):
        return "гроза с градом"
    return "облачно"


def format_number(value, digits):
    number = round(float(value), digits)
    if digits == 0 or abs(number - round(number)) < 10 ** (-digits) / 2:
        return str(int(round(number)))
    return f"{number:.{digits}f}"


def geocode(name):
    query = urllib.parse.urlencode(
        {"name": name, "count": 8, "language": "ru", "format": "json"}
    )
    payload = http_json(f"https://geocoding-api.open-meteo.com/v1/search?{query}")
    return payload.get("results") or []


def pick_place(results, hint):
    ranked = []
    for item in results:
        if item.get("country_code") != "PL":
            continue
        point = (item["latitude"], item["longitude"])
        distance = haversine(hint, point)
        if distance > 80:
            continue
        ranked.append((-(item.get("population") or 0), distance, item))
    if not ranked:
        return None
    ranked.sort(key=lambda row: (row[0], row[1]))
    return ranked[0][2]


def is_rain(precip, code):
    try:
        code = int(code)
    except (TypeError, ValueError):
        code = -1
    if code in SNOW_CODES:
        return False
    if code in RAIN_CODES:
        return True
    try:
        return float(precip) >= 0.1
    except (TypeError, ValueError):
        return False


def rain_label(now, current, hourly):
    if is_rain(current.get("precipitation"), current.get("weather_code")):
        return "дождь сейчас"
    times = hourly.get("time") or []
    precips = hourly.get("precipitation") or []
    codes = hourly.get("weather_code") or []
    horizon = now + timedelta(hours=48)
    for index, stamp in enumerate(times):
        start = datetime.fromisoformat(stamp).replace(tzinfo=WARSAW)
        if start + timedelta(hours=1) <= now:
            continue
        if start >= horizon:
            break
        precip = precips[index] if index < len(precips) else None
        code = codes[index] if index < len(codes) else None
        if not is_rain(precip, code):
            continue
        clock = start.strftime("%H:%M")
        if start <= now:
            return f"дождь в этот час, в {clock}"
        minutes = int((start - now).total_seconds() // 60)
        if minutes < 60:
            return f"дождь через {max(minutes, 1)} мин, в {clock}"
        hours = max(1, round(minutes / 60))
        return f"дождь через {hours} ч, в {clock}"
    return "дождя не ожидается"


def forecast(lat, lon):
    query = urllib.parse.urlencode(
        {
            "latitude": lat,
            "longitude": lon,
            "current": "temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation",
            "hourly": "precipitation,weather_code",
            "forecast_hours": 48,
            "wind_speed_unit": "ms",
            "timezone": "Europe/Warsaw",
        }
    )
    return http_json(f"https://api.open-meteo.com/v1/forecast?{query}")


def locate(place, hint):
    try:
        found = pick_place(geocode(place["query"]), hint)
        if found:
            return found["latitude"], found["longitude"]
    except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError):
        pass
    return place["fallback"]


def describe(place, lat, lon, center):
    averaged = compare_point(lat, lon)
    distance = 0.0 if place.get("center") else haversine(center, (lat, lon))
    outside = (not place.get("center")) and distance > RADIUS_KM
    return {
        "id": place["id"],
        "label": place["label"],
        "lat": lat,
        "lon": lon,
        "temp_label": averaged["temp_label"],
        "condition": averaged["condition"],
        "wind_label": averaged["wind_label"],
        "wind_deg": averaged.get("wind_deg"),
        "gust_label": averaged.get("gust_label"),
        "humidity_label": averaged.get("humidity_label"),
        "distance_km": round(distance, 1),
        "distance_label": f"{format_number(distance, 1)} км",
        "rain_label": averaged["rain_label"],
        "rain_step_min": averaged.get("rain_step_min"),
        "rain_minutes": averaged.get("rain_minutes"),
        "rain_alert": averaged.get("rain_alert"),
        "sources_used": averaged["sources_used"],
        "sources_label": averaged["sources_label"],
        "sources": averaged["sources"],
        "open_meteo_at": averaged.get("open_meteo_at"),
        "open_meteo_step_min": averaged.get("open_meteo_step_min"),
        "outside_ring": outside,
        "observed": averaged.get("observed"),
    }


def fetch_report():
    center_meta = PLACES[0]
    hint = center_meta["fallback"]
    center_lat, center_lon = locate(center_meta, hint)
    center = (center_lat, center_lon)
    jobs = [(center_meta, center_lat, center_lon)]
    for place in PLACES[1:]:
        lat, lon = locate(place, center)
        if haversine(center, (lat, lon)) > RADIUS_KM and not place.get("always"):
            continue
        jobs.append((place, lat, lon))
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        rows = list(pool.map(lambda job: describe(job[0], job[1], job[2], center), jobs))
    center_row = rows[0]
    places = rows[1:]
    places.sort(key=lambda item: item["distance_km"])
    return {
        "radius_km": RADIUS_KM,
        "updated": center_row.get("observed"),
        "open_meteo_at": center_row.get("open_meteo_at"),
        "open_meteo_step_min": center_row.get("open_meteo_step_min") or 15,
        "center": center_row,
        "places": places,
    }


def get_weather():
    now = time.time()
    if _cache["data"] and now - _cache["at"] < CACHE_SECONDS:
        return _cache["data"]
    data = fetch_report()
    _cache["at"] = now
    _cache["data"] = data
    return data


def connect_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    columns = [row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()]
    if not columns:
        conn.execute(
            """
            CREATE TABLE users (
                telegram_id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                last_name TEXT,
                language_code TEXT,
                added_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                lat REAL,
                lon REAL,
                init_data TEXT
            )
            """
        )
    elif "telegram_id" not in columns and "user_id" in columns:
        now = datetime.now(WARSAW).replace(microsecond=0).isoformat()
        conn.execute("ALTER TABLE users RENAME TO users_old")
        conn.execute(
            """
            CREATE TABLE users (
                telegram_id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                last_name TEXT,
                language_code TEXT,
                added_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                lat REAL,
                lon REAL,
                init_data TEXT
            )
            """
        )
        conn.execute(
            """
            INSERT INTO users (telegram_id, init_data, lat, lon, added_at, last_seen_at)
            SELECT user_id, init_data, lat, lon, COALESCE(updated_at, ?), COALESCE(updated_at, ?)
            FROM users_old
            """,
            (now, now),
        )
        conn.execute("DROP TABLE users_old")
    columns = [row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()]
    if "rain_alert" not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN rain_alert TEXT")
    return conn


def clean_text(value, limit=64):
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:limit] or None


def remember_user(telegram_id, username=None, first_name=None, last_name=None, language_code=None, lat=None, lon=None, init_data="", keep_language=False):
    if isinstance(telegram_id, bool) or not isinstance(telegram_id, int) or telegram_id <= 0:
        raise ValueError("telegram_id")
    now = datetime.now(WARSAW).replace(microsecond=0).isoformat()
    language_set = (
        "COALESCE(users.language_code, excluded.language_code)"
        if keep_language
        else "COALESCE(excluded.language_code, users.language_code)"
    )
    with connect_db() as conn:
        conn.execute(
            f"""
            INSERT INTO users (
                telegram_id, username, first_name, last_name, language_code,
                added_at, last_seen_at, lat, lon, init_data
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET
                username = COALESCE(excluded.username, users.username),
                first_name = COALESCE(excluded.first_name, users.first_name),
                last_name = COALESCE(excluded.last_name, users.last_name),
                language_code = {language_set},
                last_seen_at = excluded.last_seen_at,
                lat = COALESCE(excluded.lat, users.lat),
                lon = COALESCE(excluded.lon, users.lon),
                init_data = CASE
                    WHEN excluded.init_data IS NOT NULL AND excluded.init_data != '' THEN excluded.init_data
                    ELSE users.init_data
                END
            """,
            (
                telegram_id,
                clean_text(username, 64),
                clean_text(first_name, 128),
                clean_text(last_name, 128),
                clean_text(language_code, 16),
                now,
                now,
                lat,
                lon,
                (init_data or "")[:4096],
            ),
        )
        row = conn.execute(
            """
            SELECT telegram_id, username, first_name, last_name, language_code,
                   added_at, last_seen_at, lat, lon
            FROM users WHERE telegram_id = ?
            """,
            (telegram_id,),
        ).fetchone()
    profile = {
        "telegram_id": row[0],
        "username": row[1],
        "first_name": row[2],
        "last_name": row[3],
        "language_code": row[4],
        "added_at": row[5],
        "last_seen_at": row[6],
        "lat": row[7],
        "lon": row[8],
    }
    folder = DATA_DIR / "users" / str(telegram_id)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "profile.json").write_text(
        json.dumps(profile, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return profile


def user_count():
    if not DB_PATH.exists():
        return 0
    with connect_db() as conn:
        return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def get_point(lat, lon):
    key = (round(lat, 3), round(lon, 3))
    cached = _point_cache.get(key)
    now = time.time()
    if cached and now - cached[0] < POINT_CACHE_SECONDS:
        return cached[1]
    report = _cache.get("data")
    if report and report.get("center"):
        center = (report["center"]["lat"], report["center"]["lon"])
    else:
        center = PLACES[0]["fallback"]
    row = describe({"id": "me", "label": "Моё место"}, lat, lon, center)
    _point_cache[key] = (now, row)
    return row


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/weather":
            self.serve_weather()
            return
        if path == "/api/point":
            self.serve_point()
            return
        if path == "/api/stats":
            self.send_json({"users": user_count()})
            return
        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path != "/api/me":
            self.send_json({"error": "not_found"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 8192:
            self.send_json({"error": "bad_body"}, 400)
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json({"error": "bad_body"}, 400)
            return
        user_id = payload.get("telegram_id", payload.get("user_id"))
        if isinstance(user_id, bool) or not isinstance(user_id, int) or user_id <= 0:
            self.send_json({"error": "no_user"}, 400)
            return
        init_data = payload.get("init_data") if isinstance(payload.get("init_data"), str) else ""
        lat = payload.get("lat")
        lon = payload.get("lon")
        if lat is None and lon is None:
            lat, lon = None, None
        else:
            try:
                lat = float(lat)
                lon = float(lon)
            except (TypeError, ValueError):
                self.send_json({"error": "bad_coordinates"}, 400)
                return
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                self.send_json({"error": "bad_coordinates"}, 400)
                return
        try:
            remember_user(
                user_id,
                username=payload.get("username"),
                first_name=payload.get("first_name"),
                last_name=payload.get("last_name"),
                language_code=payload.get("language_code"),
                lat=lat,
                lon=lon,
                init_data=init_data,
                keep_language=True,
            )
        except (sqlite3.Error, ValueError, OSError):
            self.send_json({"error": "store_failed"}, 500)
            return
        self.send_json({"ok": True})

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_weather(self):
        try:
            self.send_json(get_weather())
        except Exception:
            self.send_json({"error": "weather_unavailable"}, 502)

    def serve_point(self):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        try:
            lat = float(params.get("lat", [""])[0])
            lon = float(params.get("lon", [""])[0])
        except ValueError:
            self.send_json({"error": "bad_coordinates"}, 400)
            return
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            self.send_json({"error": "bad_coordinates"}, 400)
            return
        try:
            self.send_json(get_point(lat, lon))
        except Exception:
            self.send_json({"error": "weather_unavailable"}, 502)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))


def telegram(method, payload=None, timeout=20):
    url = f"https://api.telegram.org/bot{TOKEN}/{method}"
    data = None
    headers = {"User-Agent": "weatherR/1.0"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


WELCOME = {
    "ru": "weatherR — погода в Щецине и в радиусе 50 км.\nОткройте приложение кнопкой ниже. Справка: /help",
    "en": "weatherR — weather in Szczecin within 50 km.\nOpen the app with the button below. Help: /help",
    "pl": "weatherR — pogoda w Szczecinie w promieniu 50 km.\nOtwórz aplikację przyciskiem poniżej. Pomoc: /help",
    "uk": "weatherR — погода в Щецині в радіусі 50 км.\nВідкрийте застосунок кнопкою нижче. Довідка: /help",
    "de": "weatherR — Wetter in Stettin im Umkreis von 50 km.\nÖffnen Sie die App mit der Taste unten. Hilfe: /help",
}
HELP = {
    "ru": (
        "weatherR 0.13 — погода в Щецине ± 50 км.\n\n"
        "Открытие\n"
        "Синяя кнопка weatherR слева от поля ввода и «Открыть weatherR» открывают приложение. "
        "Язык выбирается внутри: русский, английский, польский, украинский, немецкий.\n\n"
        "Карта\n"
        "Кольцо 50 км занимает большую часть экрана и подстраивается под телефон. "
        "Подписи городов не наезжают друг на друга. О дожде на карте написано, только если он уже идёт или начнётся в ближайшие 5 минут. "
        "Штрихи ветра показывают ветер выбранной точки. "
        "Внизу слева тихое число: минуты до следующего обновления Open-Meteo. Новый ответ в среднем снова ставит 15.\n\n"
        "За кольцом\n"
        "Хощно и Хмельницкий стоят под кольцом, только названием, на стороне от вашего места.\n\n"
        "Список\n"
        "Прокрутите точки. В строке — средний ветер и порыв. На экране видно около трёх точек. Выбранная подсвечивается.\n\n"
        "Под заголовком\n"
        "weatherR и «Щецин ± 50 км» в одной строке. Ниже полная сводка и кнопки: дождь, средний ветер, порыв, влажность.\n\n"
        "Ваше место\n"
        "Сохраните место кнопкой внизу. Она сменится на GEO+. Если там примерно через 5 минут начнётся дождь, бот напишет в этот чат."
    ),
    "en": (
        "weatherR 0.13 — weather in Szczecin ± 50 km.\n\n"
        "Open\n"
        "The blue weatherR button left of the message field and “Open weatherR” open the app. "
        "The language is chosen inside: Russian, English, Polish, Ukrainian, German.\n\n"
        "Map\n"
        "The 50 km ring takes most of the screen and fits the phone. "
        "City labels do not overlap. A rain line appears on the map only if rain is falling or starts within 5 minutes. "
        "Wind streaks follow the selected place. "
        "A quiet number at the lower left is the minutes until the next Open-Meteo update. A new reading in the average sets it back to 15.\n\n"
        "Outside the ring\n"
        "Choszczno and Khmelnytskyi sit below the ring, name only, on the side away from your place.\n\n"
        "List\n"
        "Scroll the places. Each row shows average wind and gust. About three places fit on screen. The selected one is highlighted.\n\n"
        "Under the title\n"
        "weatherR and “Szczecin ± 50 km” are on one line. Below that: the full summary and buttons for rain, average wind, gust and humidity.\n\n"
        "Your place\n"
        "Save it with the button at the bottom. The button becomes GEO+. If rain is due there in about 5 minutes, the bot writes in this chat."
    ),
    "pl": (
        "weatherR 0.13 — pogoda w Szczecinie ± 50 km.\n\n"
        "Otwarcie\n"
        "Niebieski przycisk weatherR po lewej stronie pola wiadomości i „Otwórz weatherR” otwierają aplikację. "
        "Język wybiera się w środku: rosyjski, angielski, polski, ukraiński, niemiecki.\n\n"
        "Mapa\n"
        "Pierścień 50 km zajmuje większość ekranu i dopasowuje się do telefonu. "
        "Podpisy miast nie nachodzą na siebie. O deszczu na mapie jest napis tylko wtedy, gdy już pada albo zacznie się w ciągu 5 minut. "
        "Kreski wiatru pokazują wiatr wybranego punktu. "
        "Na dole po lewej cicha liczba: minuty do następnej aktualizacji Open-Meteo. Nowy odczyt w średniej znów daje 15.\n\n"
        "Poza pierścieniem\n"
        "Choszczno i Chmielnicki stoją pod pierścieniem, sama nazwa, po stronie dalszej od twojego miejsca.\n\n"
        "Lista\n"
        "Przewiń punkty. W wierszu jest średni wiatr i poryw. Na ekranie widać około trzech punktów. Wybrany jest podświetlony.\n\n"
        "Pod tytułem\n"
        "weatherR i „Szczecin ± 50 km” są w jednej linii. Niżej pełne podsumowanie i przyciski: deszcz, średni wiatr, poryw, wilgotność.\n\n"
        "Twoje miejsce\n"
        "Zapisz je przyciskiem na dole. Przycisk zmieni się w GEO+. Jeśli deszcz zacznie się tam za około 5 minut, bot napisze na tym czacie."
    ),
    "uk": (
        "weatherR 0.13 — погода в Щецині ± 50 км.\n\n"
        "Відкриття\n"
        "Синя кнопка weatherR ліворуч від поля повідомлення і «Відкрити weatherR» відкривають застосунок. "
        "Мову обирають усередині: російська, англійська, польська, українська, німецька.\n\n"
        "Карта\n"
        "Кільце 50 км займає більшу частину екрана і підлаштовується під телефон. "
        "Підписи міст не накладаються. Про дощ на карті написано, лише якщо він уже йде або почнеться протягом 5 хвилин. "
        "Риски вітру показують вітер вибраної точки. "
        "Знизу ліворуч тихе число: хвилини до наступного оновлення Open-Meteo. Нова відповідь у середньому знову ставить 15.\n\n"
        "За кільцем\n"
        "Хощно і Хмельницький стоять під кільцем, лише назвою, з боку від вашого місця.\n\n"
        "Список\n"
        "Прокрутіть точки. У рядку — середній вітер і порив. На екрані видно близько трьох точок. Вибрана підсвічується.\n\n"
        "Під заголовком\n"
        "weatherR і «Щецин ± 50 км» в одному рядку. Нижче повна сводка і кнопки: дощ, середній вітер, порив, вологість.\n\n"
        "Ваше місце\n"
        "Збережіть місце кнопкою внизу. Вона зміниться на GEO+. Якщо там приблизно за 5 хвилин почнеться дощ, бот напише в цей чат."
    ),
    "de": (
        "weatherR 0.13 — Wetter in Stettin ± 50 km.\n\n"
        "Öffnen\n"
        "Die blaue Taste weatherR links vom Eingabefeld und „weatherR öffnen“ öffnen die App. "
        "Die Sprache wird in der App gewählt: Russisch, Englisch, Polnisch, Ukrainisch, Deutsch.\n\n"
        "Karte\n"
        "Der 50-km-Ring nimmt den größten Teil des Bildschirms ein und passt sich dem Telefon an. "
        "Ortsnamen überlappen sich nicht. Regen steht auf der Karte nur, wenn er schon fällt oder in 5 Minuten beginnt. "
        "Die Windstriche zeigen den Wind des gewählten Ortes. "
        "Unten links eine leise Zahl: Minuten bis zur nächsten Open-Meteo-Aktualisierung. Eine neue Messung im Mittel setzt sie auf 15.\n\n"
        "Außerhalb des Rings\n"
        "Choszczno und Chmelnyzkyj stehen unter dem Ring, nur der Name, auf der Seite weg von Ihrem Ort.\n\n"
        "Liste\n"
        "Orte durchblättern. In der Zeile stehen mittlerer Wind und Böe. Etwa drei Orte passen auf den Bildschirm. Der gewählte ist hervorgehoben.\n\n"
        "Unter der Überschrift\n"
        "weatherR und „Stettin ± 50 km“ stehen in einer Zeile. Darunter die volle Zusammenfassung und Tasten: Regen, mittlerer Wind, Böe, Luftfeuchte.\n\n"
        "Ihr Ort\n"
        "Speichern Sie ihn mit der Taste unten. Sie wird zu GEO+. Wenn dort in etwa 5 Minuten Regen beginnt, schreibt der Bot in diesen Chat."
    ),
}
OPEN_APP = {
    "ru": "Открыть weatherR",
    "en": "Open weatherR",
    "pl": "Otwórz weatherR",
    "uk": "Відкрити weatherR",
    "de": "weatherR öffnen",
}


def language_id(code):
    short = str(code or "ru").replace("_", "-").split("-")[0].lower()
    return short if short in WELCOME else "ru"


def stored_language(telegram_id):
    if not DB_PATH.exists() or not isinstance(telegram_id, int):
        return None
    with connect_db() as conn:
        row = conn.execute(
            "SELECT language_code FROM users WHERE telegram_id = ?",
            (telegram_id,),
        ).fetchone()
    if not row or not row[0]:
        return None
    return language_id(row[0])


def app_url(lang):
    parts = urllib.parse.urlsplit(WEBAPP_URL)
    query = dict(urllib.parse.parse_qsl(parts.query, keep_blank_values=True))
    query["lang"] = language_id(lang)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(query), parts.fragment))


def reply_markup(lang):
    code = language_id(lang)
    rows = []
    if WEBAPP_URL.startswith("https://"):
        rows.append([{"text": OPEN_APP[code], "web_app": {"url": app_url(code)}}])
    rows.append([{"text": "/help"}])
    return {"keyboard": rows, "resize_keyboard": True, "is_persistent": True}


def welcome_text(lang):
    return WELCOME[language_id(lang)]


def help_text(lang):
    return HELP[language_id(lang)]


def command_name(text):
    return text.split()[0].split("@", 1)[0].lower()


def handle_update(update):
    message = update.get("message") or {}
    text = (message.get("text") or "").strip()
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    sender = message.get("from") or {}
    sender_id = sender.get("id")
    if not chat_id or not text:
        return
    command = command_name(text)
    if command not in ("/start", "/weather", "/app", "/help"):
        return
    lang = stored_language(sender_id) or language_id(sender.get("language_code"))
    if isinstance(sender_id, int) and sender_id > 0:
        try:
            remember_user(
                sender_id,
                username=sender.get("username"),
                first_name=sender.get("first_name"),
                last_name=sender.get("last_name"),
                language_code=sender.get("language_code"),
                keep_language=True,
            )
        except (sqlite3.Error, ValueError, OSError) as error:
            print(f"пользователь не записан: {type(error).__name__}", flush=True)
        lang = stored_language(sender_id) or lang
    answer = help_text(lang) if command == "/help" else welcome_text(lang)
    telegram("sendMessage", {
        "chat_id": chat_id,
        "text": answer,
        "reply_markup": reply_markup(lang),
    })


def rain_watch_loop():
    time.sleep(8)
    while True:
        try:
            check_rain_alerts()
        except Exception as error:
            print(f"проверка дождя: {type(error).__name__}", flush=True)
        time.sleep(60)


RAIN_SOON = {
    "ru": "через ~5 мин дождь",
    "pl": "za ~5 min deszcz",
    "en": "rain in ~5 min",
    "de": "in ~5 Min. Regen",
    "uk": "через ~5 хв дощ",
}
RAIN_NOW = {
    "ru": "дождь уже идёт",
    "pl": "deszcz już pada",
    "en": "rain is already falling",
    "de": "Regen fällt schon",
    "uk": "дощ уже йде",
}


def rain_message(kind, language_code):
    pack = RAIN_SOON if kind == "soon" else RAIN_NOW
    code = str(language_code or "ru").replace("_", "-").split("-")[0].lower()
    return pack.get(code) or pack["ru"]


def check_rain_alerts():
    with connect_db() as conn:
        rows = conn.execute(
            """
            SELECT telegram_id, lat, lon, language_code, rain_alert
            FROM users
            WHERE lat IS NOT NULL AND lon IS NOT NULL
            """
        ).fetchall()
    for telegram_id, lat, lon, language_code, prev in rows:
        try:
            point = get_point(lat, lon)
        except Exception as error:
            print(f"проверка дождя: {type(error).__name__}", flush=True)
            continue
        phase = point.get("rain_alert")
        prev = prev or None
        new = prev
        text = None
        if phase == "soon" and prev not in ("soon", "now"):
            text = rain_message("soon", language_code)
            new = "soon"
        elif phase == "now" and prev not in ("soon", "now"):
            text = rain_message("now", language_code)
            new = "now"
        elif phase == "now" and prev == "soon":
            new = "now"
        elif not phase:
            new = None
        if text:
            try:
                telegram("sendMessage", {"chat_id": telegram_id, "text": text})
                print("сигнал дождя отправлен", flush=True)
            except Exception as error:
                print(f"сигнал дождя не ушёл: {type(error).__name__}", flush=True)
                continue
        if new != prev:
            with connect_db() as conn:
                conn.execute(
                    "UPDATE users SET rain_alert = ? WHERE telegram_id = ?",
                    (new, telegram_id),
                )


def poll_loop():
    offset = None
    while True:
        try:
            params = {"timeout": 25}
            if offset is not None:
                params["offset"] = offset
            result = telegram("getUpdates", params, timeout=35)
            for update in result.get("result", []):
                offset = update["update_id"] + 1
                try:
                    handle_update(update)
                except Exception as error:
                    print(f"сообщение не отправлено: {type(error).__name__}", flush=True)
        except Exception as error:
            print(f"опрос Telegram: {type(error).__name__}", flush=True)
            time.sleep(3)


def configure_bot():
    me = telegram("getMe")
    username = me["result"]["username"]
    print(f"Бот @{username}", flush=True)
    telegram(
        "setMyCommands",
        {
            "commands": [
                {"command": "start", "description": "Открыть weatherR"},
                {"command": "help", "description": "Справка"},
            ]
        },
    )
    if WEBAPP_URL.startswith("https://"):
        telegram(
            "setChatMenuButton",
            {
                "menu_button": {
                    "type": "web_app",
                    "text": "weatherR",
                    "web_app": {"url": WEBAPP_URL},
                }
            },
        )
        print("Кнопка меню weatherR установлена", flush=True)
    else:
        print("Кнопка меню ждёт HTTPS-адрес в WEBAPP_URL", flush=True)
    return username


def main():
    if not TOKEN:
        sys.exit("В weatherR/.env нет BOT_TOKEN")
    try:
        configure_bot()
    except urllib.error.HTTPError as error:
        if error.code == 401:
            sys.exit("Telegram не принял токен из .env")
        sys.exit(f"Telegram API ответил {error.code}")
    try:
        report = get_weather()
        print(
            f"Погода Щецина: {report['center']['temp_label']}°, "
            f"в радиусе {len(report['places'])} городов",
            flush=True,
        )
    except Exception as error:
        print(f"Погоду при старте получить не удалось: {type(error).__name__}", flush=True)

    server = ThreadingHTTPServer(("127.0.0.1", PORT), AppHandler)
    print(f"Мини-приложение: {WEBAPP_URL}", flush=True)
    threading.Thread(target=poll_loop, daemon=True).start()
    threading.Thread(target=rain_watch_loop, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановка", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
