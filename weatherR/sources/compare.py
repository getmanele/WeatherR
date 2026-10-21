"""Сравнение прогноза одной точки по нескольким источникам.

IMGW (danepubliczne.imgw.pl) не отдаёт почасовой прогноз по координатам.
Доступно вот что:
- /api/data/synop — текущие наблюдения станций: температура, ветер (м/с),
  сумма осадков. В ответе нет широты и долготы.
- /api/data/forecast — прогноз по станциям с lat/lon, но это не почасовой ряд,
  а периоды k0–k4 и s1–s5 (мин/макс температуры и ветер) с одной датой выпуска.
  Поля суммы осадков по часам нет, поэтому срок дождя IMGW в среднее не входит.
Ближайшую станцию ищем по координатам из forecast и берём её synop.
"""

import json
import math
import threading
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

USER_AGENT = "weatherR/1.0 github.com/weatherr"
WARSAW = ZoneInfo("Europe/Warsaw")
RAIN_CODES = set(range(61, 68)) | set(range(80, 83)) | {95, 96, 99}
SNOW_CODES = set(range(71, 78)) | {85, 86}
HORIZON = timedelta(hours=48)

_imgw_lock = threading.Lock()
_imgw_cache = {"at": 0.0, "synop": None, "forecast": None}


def http_json(url, timeout=15):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def haversine(a, b):
    radius = 6371.0
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    hav = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(hav))


def parse_time(stamp, naive_zone=None):
    text = str(stamp).replace("Z", "+00:00")
    moment = datetime.fromisoformat(text)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=naive_zone or WARSAW)
    return moment


def format_number(value, digits):
    number = round(float(value), digits)
    if abs(number - round(number)) < 10 ** (-digits) / 2:
        return str(int(round(number)))
    return f"{number:.{digits}f}"


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
    if 51 <= code <= 57:
        return "морось"
    if 61 <= code <= 67:
        return "дождь"
    if 71 <= code <= 77:
        return "снег"
    if 80 <= code <= 82:
        return "ливень"
    if code in (85, 86):
        return "снегопад"
    if code == 95:
        return "гроза"
    if code in (96, 99):
        return "гроза с градом"
    return "облачно"


def failed(source, error):
    return {
        "source": source,
        "ok": False,
        "error": error,
        "temp_c": None,
        "wind_ms": None,
        "condition": None,
        "raining_now": None,
        "rain_hours": None,
        "rain_assessed": False,
        "rain_step_min": None,
        "note": None,
    }


def is_rain_code(precip, code, min_precip=0.1):
    try:
        code = int(code)
    except (TypeError, ValueError):
        code = -1
    if code in SNOW_CODES:
        return False
    if code in RAIN_CODES:
        return True
    try:
        return float(precip) >= min_precip
    except (TypeError, ValueError):
        return False


def symbol_is_rain(symbol, precip):
    text = (symbol or "").lower()
    snow = "snow" in text and "rain" not in text and "sleet" not in text
    if snow:
        return False
    if any(word in text for word in ("rain", "thunder", "sleet")):
        return True
    try:
        return float(precip) >= 0.1
    except (TypeError, ValueError):
        return False


def rain_from_hours(now, current_rain, slots):
    """slots: список (начало, дождь, длительность в часах)."""
    if current_rain:
        return {"raining_now": True, "rain_hours": 0.0, "rain_assessed": True, "rain_step_min": None}
    horizon = now + HORIZON
    for start, rainy, duration in slots:
        end = start + timedelta(hours=duration)
        if end <= now:
            continue
        if start >= horizon:
            break
        if not rainy:
            continue
        step = max(1, int(round(float(duration) * 60)))
        if start <= now:
            return {"raining_now": False, "rain_hours": 0.0, "rain_assessed": True, "rain_step_min": step}
        hours = (start - now).total_seconds() / 3600
        return {"raining_now": False, "rain_hours": hours, "rain_assessed": True, "rain_step_min": step}
    return {"raining_now": False, "rain_hours": None, "rain_assessed": True, "rain_step_min": None}


def fetch_open_meteo(lat, lon):
    source = "open-meteo"
    try:
        query = urllib.parse.urlencode(
            {
                "latitude": lat,
                "longitude": lon,
                "current": "temperature_2m,weather_code,wind_speed_10m,precipitation",
                "minutely_15": "precipitation,weather_code",
                "hourly": "precipitation,weather_code",
                "forecast_minutely_15": 192,
                "forecast_hours": 48,
                "wind_speed_unit": "ms",
                "timezone": "Europe/Warsaw",
            }
        )
        payload = http_json(f"https://api.open-meteo.com/v1/forecast?{query}")
        current = payload["current"]
        minutely = payload.get("minutely_15") or {}
        hourly = payload.get("hourly") or {}
        now = datetime.now(WARSAW)
        slots = []
        last_end = None
        for index, stamp in enumerate(minutely.get("time") or []):
            precip = (minutely.get("precipitation") or [None])[index]
            code = (minutely.get("weather_code") or [None])[index]
            start = parse_time(stamp, WARSAW)
            slots.append((start, is_rain_code(precip, code, 0.025), 0.25))
            last_end = start + timedelta(minutes=15)
        for index, stamp in enumerate(hourly.get("time") or []):
            start = parse_time(stamp, WARSAW)
            if last_end and start < last_end:
                continue
            precip = (hourly.get("precipitation") or [None])[index]
            code = (hourly.get("weather_code") or [None])[index]
            slots.append((start, is_rain_code(precip, code), 1))
        current_step = 0.25 if int(current.get("interval") or 3600) <= 900 else 1
        rain = rain_from_hours(
            now,
            is_rain_code(current.get("precipitation"), current.get("weather_code"), 0.1 * current_step),
            slots,
        )
        return {
            "source": source,
            "ok": True,
            "error": None,
            "temp_c": float(current["temperature_2m"]),
            "wind_ms": float(current["wind_speed_10m"]),
            "condition": condition_ru(current["weather_code"]),
            "note": None,
            **rain,
        }
    except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError, ValueError) as error:
        return failed(source, type(error).__name__)


def fetch_met(lat, lon):
    source = "met-norway"
    try:
        url = (
            "https://api.met.no/weatherapi/locationforecast/2.0/compact?"
            + urllib.parse.urlencode({"lat": f"{lat:.4f}", "lon": f"{lon:.4f}"})
        )
        payload = http_json(url)
        series = payload["properties"]["timeseries"]
        if not series:
            return failed(source, "empty")
        now = datetime.now(timezone.utc)
        first = series[0]["data"]
        details = first["instant"]["details"]
        current_block = first.get("next_1_hours") or first.get("next_6_hours") or {}
        current_symbol = (current_block.get("summary") or {}).get("symbol_code")
        current_precip = (current_block.get("details") or {}).get("precipitation_amount")
        slots = []
        for step in series:
            if step["data"].get("next_1_hours"):
                block = step["data"]["next_1_hours"]
                duration = 1
            elif step["data"].get("next_6_hours"):
                block = step["data"]["next_6_hours"]
                duration = 6
            else:
                continue
            symbol = (block.get("summary") or {}).get("symbol_code")
            precip = (block.get("details") or {}).get("precipitation_amount")
            slots.append((parse_time(step["time"]), symbol_is_rain(symbol, precip), duration))
        rain = rain_from_hours(now, symbol_is_rain(current_symbol, current_precip), slots)
        condition = "дождь" if rain["raining_now"] else None
        return {
            "source": source,
            "ok": True,
            "error": None,
            "temp_c": float(details["air_temperature"]),
            "wind_ms": float(details["wind_speed"]),
            "condition": condition,
            "note": None,
            **rain,
        }
    except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError, ValueError) as error:
        return failed(source, type(error).__name__)


def fetch_brightsky(lat, lon):
    source = "brightsky"
    try:
        now = datetime.now(timezone.utc)
        current_url = "https://api.brightsky.dev/current_weather?" + urllib.parse.urlencode(
            {"lat": lat, "lon": lon}
        )
        current = http_json(current_url)["weather"]
        forecast_url = "https://api.brightsky.dev/weather?" + urllib.parse.urlencode(
            {
                "lat": lat,
                "lon": lon,
                "date": now.date().isoformat(),
                "last_date": (now + timedelta(days=2)).date().isoformat(),
            }
        )
        hours = http_json(forecast_url).get("weather") or []
        nearest = min(
            hours,
            key=lambda row: abs((parse_time(row["timestamp"]) - now).total_seconds()),
            default=None,
        )

        def wind_ms(row):
            if not row:
                return None
            for key in ("wind_speed", "wind_speed_60", "wind_speed_30", "wind_speed_10"):
                if row.get(key) is not None:
                    return float(row[key]) / 3.6
            return None

        precip_now = current.get("precipitation_60")
        if precip_now is None:
            precip_now = current.get("precipitation")
        condition = current.get("condition")
        raining = symbol_is_rain(condition, precip_now)
        slots = []
        for row in hours:
            amount = row.get("precipitation")
            slots.append((parse_time(row["timestamp"]), symbol_is_rain(row.get("condition"), amount), 1))
        rain = rain_from_hours(now, raining, slots)
        temp = current.get("temperature")
        if temp is None and nearest:
            temp = nearest.get("temperature")
        wind = wind_ms(current) 
        if wind is None:
            wind = wind_ms(nearest)
        words = {
            "dry": "сухо",
            "rain": "дождь",
            "snow": "снег",
            "sleet": "дождь со снегом",
            "hail": "град",
            "thunderstorm": "гроза",
            "fog": "туман",
        }
        return {
            "source": source,
            "ok": True,
            "error": None,
            "temp_c": None if temp is None else float(temp),
            "wind_ms": wind,
            "condition": words.get(condition),
            "note": None,
            **rain,
        }
    except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError, ValueError) as error:
        return failed(source, type(error).__name__)


def imgw_tables():
    now = datetime.now(timezone.utc).timestamp()
    with _imgw_lock:
        if _imgw_cache["synop"] and now - _imgw_cache["at"] < 600:
            return _imgw_cache["synop"], _imgw_cache["forecast"]
    synop = http_json("https://danepubliczne.imgw.pl/api/data/synop")
    forecast = http_json("https://danepubliczne.imgw.pl/api/data/forecast")
    with _imgw_lock:
        _imgw_cache["at"] = now
        _imgw_cache["synop"] = synop
        _imgw_cache["forecast"] = forecast
    return synop, forecast


def fetch_imgw(lat, lon):
    source = "imgw"
    try:
        synop, forecast = imgw_tables()
        nearest = None
        nearest_km = None
        for row in forecast:
            try:
                point = (float(row["lat"]), float(row["lon"]))
            except (TypeError, ValueError, KeyError):
                continue
            distance = haversine((lat, lon), point)
            if nearest is None or distance < nearest_km:
                nearest = row
                nearest_km = distance
        if nearest is None:
            return failed(source, "no_station")
        name = nearest.get("stacja")
        observation = next((row for row in synop if row.get("stacja") == name), None)
        temp = None
        wind = None
        raining_now = None
        if observation:
            if observation.get("temperatura") not in (None, ""):
                temp = float(str(observation["temperatura"]).replace(",", "."))
            if observation.get("predkosc_wiatru") not in (None, ""):
                wind = float(str(observation["predkosc_wiatru"]).replace(",", "."))
            if observation.get("suma_opadu") not in (None, ""):
                raining_now = float(str(observation["suma_opadu"]).replace(",", ".")) > 0
        if temp is None and nearest.get("temperatura_max") not in (None, ""):
            temp = float(str(nearest["temperatura_max"]).replace(",", "."))
        if wind is None and nearest.get("predkosc_wiatru") not in (None, ""):
            wind = float(str(nearest["predkosc_wiatru"]).replace(",", "."))
        note = (
            f"ближайшая станция {name}, {format_number(nearest_km, 1)} км; "
            "почасового прогноза по координатам нет"
        )
        return {
            "source": source,
            "ok": temp is not None or wind is not None,
            "error": None if temp is not None or wind is not None else "empty",
            "temp_c": temp,
            "wind_ms": wind,
            "condition": None,
            "raining_now": True if raining_now else None,
            "rain_hours": 0.0 if raining_now else None,
            "rain_assessed": bool(raining_now),
            "rain_step_min": None,
            "note": note,
        }
    except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError, ValueError) as error:
        return failed(source, type(error).__name__)


def hours_to_label(hours, now):
    if hours is None:
        return "дождя не ожидается"
    if hours <= 0:
        return "дождь в этот час"
    start = now + timedelta(hours=hours)
    clock = start.astimezone(WARSAW).strftime("%H:%M")
    minutes = int(round(hours * 60))
    if minutes < 60:
        return f"дождь через {max(minutes, 1)} мин, в {clock}"
    whole = max(1, int(round(hours)))
    return f"дождь через {whole} ч, в {clock}"


def finest_rain(assessed):
    timed = []
    for row in assessed:
        if row.get("rain_hours") is None and not row.get("raining_now"):
            continue
        hours = 0.0 if row.get("rain_hours") is None else float(row["rain_hours"])
        step = row.get("rain_step_min") or 60
        timed.append((hours, step))
    if not timed:
        return None, None
    fine = min(step for _, step in timed)
    chosen = [hours for hours, step in timed if step == fine]
    return sum(chosen) / len(chosen), fine


def rain_alert_phase(raining_now, rain_hours, step_min):
    if raining_now or (rain_hours is not None and rain_hours <= 0):
        return "now"
    if rain_hours is None:
        return None
    minutes = rain_hours * 60
    step = step_min or 60
    if step >= 15:
        if 0 < minutes <= step + 0.5:
            return "soon"
        return None
    if 3 <= minutes <= 7:
        return "soon"
    return None


def average_readings(readings):
    ok = [row for row in readings if row.get("ok")]
    temps = [row["temp_c"] for row in ok if row.get("temp_c") is not None]
    winds = [row["wind_ms"] for row in ok if row.get("wind_ms") is not None]
    assessed = [row for row in ok if row.get("rain_assessed")]
    now = datetime.now(timezone.utc)
    rain_label = "нет данных о дожде"
    raining = False
    rain_hours = None
    rain_step = None
    if assessed:
        count = len(assessed)
        now_votes = sum(1 for row in assessed if row.get("raining_now"))
        none_votes = sum(
            1
            for row in assessed
            if not row.get("raining_now") and row.get("rain_hours") is None
        )
        if now_votes > count / 2:
            rain_label = "дождь сейчас"
            raining = True
            rain_hours = 0.0
        elif none_votes > count / 2:
            rain_label = "дождя не ожидается"
        else:
            rain_hours, rain_step = finest_rain(assessed)
            rain_label = hours_to_label(rain_hours, now) if rain_hours is not None else "дождя не ожидается"
            raining = rain_hours is not None and rain_hours <= 0
    condition = next((row["condition"] for row in ok if row.get("condition")), "облачно")
    used = len(ok)
    minutes = None if rain_hours is None else round(rain_hours * 60, 1)
    return {
        "temp_c": sum(temps) / len(temps) if temps else None,
        "temp_label": format_number(sum(temps) / len(temps), 1) if temps else "—",
        "wind_ms": sum(winds) / len(winds) if winds else None,
        "wind_label": f"{format_number(sum(winds) / len(winds), 1)} м/с" if winds else "—",
        "condition": condition,
        "rain_label": rain_label,
        "rain_hours": rain_hours,
        "rain_minutes": minutes,
        "rain_step_min": rain_step,
        "rain_alert": rain_alert_phase(raining, rain_hours, rain_step),
        "sources_used": used,
        "sources_label": f"среднее из {used}",
        "sources": [row["source"] for row in ok],
        "source_notes": {row["source"]: row.get("note") for row in ok if row.get("note")},
        "observed": datetime.now(WARSAW).replace(microsecond=0).isoformat(),
    }


def compare_point(lat, lon):
    fetchers = (fetch_open_meteo, fetch_met, fetch_brightsky, fetch_imgw)
    with ThreadPoolExecutor(max_workers=len(fetchers)) as pool:
        readings = list(pool.map(lambda fn: fn(lat, lon), fetchers))
    averaged = average_readings(readings)
    averaged["readings"] = [
        {
            "source": row["source"],
            "ok": row["ok"],
            "temp_c": row.get("temp_c"),
            "wind_ms": row.get("wind_ms"),
            "rain_hours": row.get("rain_hours"),
            "rain_step_min": row.get("rain_step_min"),
            "raining_now": row.get("raining_now"),
            "note": row.get("note"),
            "error": row.get("error"),
        }
        for row in readings
    ]
    return averaged
