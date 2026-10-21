/* Модуль переводов WeatherR. Словари лежат рядом: ru, en, pl, uk, de. */
(function () {
  const LANGS = [
    { id: "ru", name: "Русский" },
    { id: "en", name: "English" },
    { id: "pl", name: "Polski" },
    { id: "uk", name: "Українська" },
    { id: "de", name: "Deutsch" },
  ];
  const KEY = "weatherr-lang";
  const CONDITION_KEY = {
    "ясно": "clear",
    "преимущественно ясно": "mostly_clear",
    "переменная облачность": "partly_cloudy",
    "пасмурно": "overcast",
    "туман": "fog",
    "морось": "drizzle",
    "ледяная морось": "freezing_drizzle",
    "дождь": "rain",
    "ледяной дождь": "freezing_rain",
    "снег": "snow",
    "снежные зёрна": "snow_grains",
    "ливень": "shower",
    "снегопад": "snowfall",
    "гроза": "thunder",
    "гроза с градом": "thunder_hail",
    "облачно": "cloudy",
    "сухо": "dry",
    "дождь со снегом": "sleet",
    "град": "hail",
  };

  let pack = null;
  let lang = "ru";

  function lookup(key) {
    const parts = key.split(".");
    let node = pack;
    for (const part of parts) {
      if (!node || typeof node !== "object") return null;
      node = node[part];
    }
    return typeof node === "string" ? node : null;
  }

  function fill(text, vars) {
    let result = text;
    Object.entries(vars || {}).forEach(([key, value]) => {
      result = result.replaceAll("{" + key + "}", String(value));
    });
    return result;
  }

  function t(key, vars) {
    const text = lookup(key);
    return text == null ? key : fill(text, vars);
  }

  function cap(text) {
    if (!text) return text;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function plural(n, one, few, many) {
    const value = Math.abs(Number(n)) || 0;
    const mod10 = value % 10;
    const mod100 = value % 100;
    if (lang === "en" || lang === "de") return value === 1 ? one : many;
    if (lang === "pl") {
      if (value === 1) return one;
      if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
      return many;
    }
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function placeName(id, fallback) {
    return lookup("place." + id) || fallback || id;
  }

  function numberOf(label) {
    const match = String(label == null ? "" : label).match(/[\d]+(?:[.,]\d+)?/);
    return match ? match[0].replace(",", ".") : null;
  }

  function wind(label) {
    const n = numberOf(label);
    return n == null ? String(label || "—") : t("wind_value", { n: n });
  }

  function km(label) {
    const n = numberOf(label);
    return n == null ? String(label || "") : t("km_value", { n: n });
  }

  function condition(text) {
    const key = CONDITION_KEY[String(text || "").trim()];
    return key ? t("condition." + key) : (text || "");
  }

  function rainParts(label) {
    const text = String(label || "");
    if (!text) return { kind: "unknown" };
    if (text === "дождь сейчас" || text.startsWith("дождь сейчас")) return { kind: "now" };
    if (text === "дождя не ожидается") return { kind: "none" };
    if (text === "нет данных о дожде") return { kind: "unknown" };
    let match = text.match(/в (\d{2}:\d{2})/);
    const clock = match ? match[1] : "";
    if (/в этот час/.test(text)) return { kind: "this_hour", clock: clock };
    match = text.match(/через (\d+) мин/);
    if (match) return { kind: "minutes", n: match[1], clock: clock };
    match = text.match(/через (\d+) ч/);
    if (match) return { kind: "hours", n: match[1], clock: clock };
    return { kind: "unknown" };
  }

  function rain(label, short) {
    const parts = rainParts(label);
    const prefix = short ? "rain.short_" : "rain.";
    if (parts.kind === "minutes" || parts.kind === "hours" || parts.kind === "this_hour") {
      return t(prefix + parts.kind, { n: parts.n || "", clock: parts.clock || "" });
    }
    return t(prefix + parts.kind);
  }

  function rainSentence(label) {
    if (!label) return "";
    return " " + rain(label, false) + ".";
  }

  function summary(place, center) {
    const city = placeName("szczecin", center && center.label);
    const name = placeName(place.id, place.label);
    const data = {
      city: city,
      name: name,
      distance: km(place.distance_label),
      from: t("from_city", { city: city }),
      condition: place.id === (center && center.id) ? condition(place.condition) : cap(condition(place.condition)),
      temp: place.temp_label,
      wind: wind(place.wind_label),
      rain: rainSentence(place.rain_label),
      outside: place.outside_ring ? t("outside") : "",
    };
    if (place.id === "me") return t("summary_me", data);
    if (center && place.id === center.id) return t("summary_center", data);
    return t("summary_place", data);
  }

  function townDetail(place, center) {
    const distance = center && place.id === center.id ? "" : t("detail_distance", { distance: km(place.distance_label) });
    return t("town_detail", {
      condition: condition(place.condition),
      wind_word: t("wind_word"),
      wind: wind(place.wind_label),
      distance: distance,
      ring: place.outside_ring ? t("detail_ring") : "",
    });
  }

  function cities(count) {
    const forms = (pack && pack.cities) || {};
    const template = plural(count, forms.one || "{n}", forms.few || "{n}", forms.many || "{n}");
    return fill(template, { n: count });
  }

  function sourcesLine(label, clock) {
    const match = String(label || "").match(/(\d+)/);
    const base = match ? t("sources_avg", { n: match[1] }) : t("sources_loading");
    return clock ? base + clock : base;
  }

  function euro(country) {
    if (!country) return "";
    const name = lookup("country." + country.code) || country.name;
    return t("eurozone", { country: name });
  }

  function users(value) {
    if (value == null || value === "") return t("users_empty");
    return t("users", { n: value });
  }

  function apply() {
    document.documentElement.lang = lang === "uk" ? "uk" : lang;
    document.title = t("title");
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      const key = node.getAttribute("data-i18n");
      if (key) node.textContent = t(key);
    });
    const map = document.querySelector(".map");
    if (map) map.setAttribute("aria-label", t("map_aria"));
  }

  function loadPack(id) {
    return fetch("/translate/" + id + ".json").then((response) => {
      if (!response.ok) throw new Error(id);
      return response.json();
    }).then((data) => {
      pack = data;
      lang = id;
      return data;
    });
  }

  function telegramLang() {
    const code = window.Telegram
      && Telegram.WebApp
      && Telegram.WebApp.initDataUnsafe
      && Telegram.WebApp.initDataUnsafe.user
      && Telegram.WebApp.initDataUnsafe.user.language_code;
    const id = String(code || "").slice(0, 2).toLowerCase();
    return LANGS.some((item) => item.id === id) ? id : null;
  }

  function choose() {
    const saved = localStorage.getItem(KEY);
    const initial = saved || telegramLang();
    if (initial && LANGS.some((item) => item.id === initial)) {
      return loadPack(initial).then(() => {
        apply();
        return initial;
      }).catch(() => ask(saved));
    }
    return ask(saved);
  }

  function ask(saved) {
    const gate = document.createElement("div");
    gate.className = "lang-gate";
    gate.innerHTML = '<div class="brand">weather<span>R</span></div>';
    const note = document.createElement("p");
    note.textContent = "Язык · Language · Język · Мова · Sprache";
    gate.appendChild(note);
    return new Promise((resolve) => {
      LANGS.forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = item.name;
        if (item.id === saved) button.classList.add("is-saved");
        button.addEventListener("click", () => {
          button.disabled = true;
          loadPack(item.id).then(() => {
            localStorage.setItem(KEY, item.id);
            apply();
            gate.remove();
            resolve(item.id);
          }).catch(() => {
            button.disabled = false;
          });
        });
        gate.appendChild(button);
      });
      document.body.appendChild(gate);
    });
  }

  window.WR = {
    t: t,
    choose: choose,
    apply: apply,
    placeName: placeName,
    wind: wind,
    km: km,
    condition: condition,
    rainShort: function (label) { return rain(label, true); },
    rainFull: function (label) { return rain(label, false); },
    summary: summary,
    townDetail: townDetail,
    cities: cities,
    sourcesLine: sourcesLine,
    euro: euro,
    users: users,
    centerLine: function (temp) {
      return t("center_line", { city: placeName("szczecin"), temp: temp });
    },
  };
})();
