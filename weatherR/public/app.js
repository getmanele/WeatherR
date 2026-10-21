const SVG_NS = "http://www.w3.org/2000/svg";
const CX = 188;
const CY = 168;
const RING = 92;

const tg = window.Telegram && window.Telegram.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
  const green = "#0c241b";
  const deep = "#081710";
  try { tg.setHeaderColor(green); } catch (e) {}
  try { tg.setBackgroundColor(deep); } catch (e) {}
  if (typeof tg.setBottomBarColor === "function") {
    try { tg.setBottomBarColor(deep); } catch (e) {}
  }
}

const summaryEl = document.getElementById("summary");
const townsEl = document.getElementById("towns");
const centerLine = document.getElementById("center-line");
const countLine = document.getElementById("count-line");
const sourceEl = document.getElementById("source");
const markers = document.getElementById("markers");

let report = null;
let selectedId = null;
let myPlace = null;

function project(lat, lon, center, outside) {
  const north = (lat - center.lat) * 110.574;
  const east = (lon - center.lon) * 111.32 * Math.cos((center.lat * Math.PI) / 180);
  let x = CX + (east / 50) * RING;
  let y = CY - (north / 50) * RING;
  if (outside) {
    const dx = x - CX;
    const dy = y - CY;
    const len = Math.hypot(dx, dy) || 1;
    x = CX + (dx / len) * (RING + 10);
    y = CY + (dy / len) * (RING + 10);
  }
  return { x, y };
}

function svgEl(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}

function kmBetween(a, b) {
  const radius = 6371;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function pointsOf(data) {
  const origin = myPlace || data.center;
  const rest = [data.center, ...data.places].sort((a, b) => kmBetween(origin, a) - kmBetween(origin, b));
  return myPlace ? [myPlace, ...rest] : rest;
}

function mapRain(label) {
  return WR.rainShort(label);
}

function sentence(place, center) {
  return WR.summary(place, center);
}

function overlaps(a, b) {
  return !(a.x + a.w + 6 < b.x || b.x + b.w + 6 < a.x || a.y + a.h + 4 < b.y || b.y + b.h + 4 < a.y);
}

function labelBox(layout, width, height) {
  return {
    x: layout.anchor === "end" ? layout.x - width : layout.x,
    y: layout.y - height + 3,
    w: width,
    h: height,
  };
}

function labelCandidates(x, y, isCenter) {
  if (isCenter) {
    return [
      { x: x + 12, y: y - 4, anchor: "start" },
      { x: x - 12, y: y - 4, anchor: "end" },
      { x: x + 12, y: y + 18, anchor: "start" },
    ];
  }
  const dx = x - CX;
  const dy = y - CY;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const dirs = [
    [ux, uy],
    [-uy, ux],
    [uy, -ux],
    [-ux, -uy],
  ];
  const spots = [];
  [16, 28, 40].forEach((dist) => {
    dirs.forEach(([dirX, dirY]) => {
      const lx = x + dirX * dist;
      const ly = y + dirY * dist;
      spots.push({
        x: lx,
        y: ly,
        anchor: dirX < -0.2 ? "end" : "start",
      });
    });
  });
  return spots;
}

function layoutLabels(items) {
  const taken = [];
  items.forEach((item) => {
    const width = Math.max(item.text.length, (item.rain || "").length) * 6.2;
    const height = item.rain ? 28 : 14;
    const options = labelCandidates(item.x, item.y, item.isCenter);
    let chosen = options[0];
    let chosenBox = labelBox(chosen, width, height);
    for (const option of options) {
      const box = labelBox(option, width, height);
      const inside = box.x >= 6 && box.y >= 4 && box.x + box.w <= 354 && box.y + box.h <= 322;
      if (!inside) continue;
      if (taken.some((prev) => overlaps(prev, box))) continue;
      chosen = option;
      chosenBox = box;
      break;
    }
    taken.push(chosenBox);
    item.layout = chosen;
  });
}

function drawMarkers() {
  markers.replaceChildren();
  const ordered = pointsOf(report).slice().sort((a, b) => {
    if (a.id === "me") return 1;
    if (b.id === "me") return -1;
    if (a.id === report.center.id) return -1;
    if (b.id === report.center.id) return 1;
    return (b.distance_km || 0) - (a.distance_km || 0);
  });
  const items = ordered.map((place) => {
    const pos = project(place.lat, place.lon, report.center, place.outside_ring);
    return {
      place,
      x: pos.x,
      y: pos.y,
      isCenter: place.id === report.center.id,
      text: `${WR.placeName(place.id, place.label)} ${place.temp_label}°`,
      rain: mapRain(place.rain_label),
    };
  });
  layoutLabels(items);
  items.forEach((item) => {
    const place = item.place;
    const pos = { x: item.x, y: item.y };
    const isCenter = item.isCenter;
    const active = place.id === selectedId;
    const group = svgEl("g", { class: "marker", "data-id": place.id });
    group.style.cursor = "pointer";

    const hit = svgEl("circle", { cx: pos.x, cy: pos.y, r: 16, fill: "transparent" });
    group.appendChild(hit);

    if (active) {
      group.appendChild(svgEl("circle", {
        cx: pos.x,
        cy: pos.y,
        r: isCenter ? 11 : 9,
        fill: "none",
        stroke: "#9dffc4",
        "stroke-width": 1.5,
      }));
    }

    group.appendChild(svgEl("circle", {
      cx: pos.x,
      cy: pos.y,
      r: isCenter ? 7 : 4.5,
      fill: isCenter ? "#f4fff8" : "#b6ffd4",
    }));

    const caption = item.text;
    const layout = item.layout;
    const text = svgEl("text", {
      x: layout.x,
      y: layout.y,
      fill: "#f4fff8",
      "font-size": 12,
      "font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
      "text-anchor": layout.anchor,
    });
    text.textContent = caption;
    group.appendChild(text);
    let rainText = null;
    if (item.rain) {
      rainText = svgEl("text", {
        x: layout.x,
        y: Number(layout.y) + 13,
        fill: "#b7f5d0",
        "font-size": 10,
        "font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
        "text-anchor": layout.anchor,
      });
      rainText.textContent = item.rain;
      group.appendChild(rainText);
    }
    const box = text.getBBox();
    const rainBox = rainText ? rainText.getBBox() : null;
    const left = Math.min(box.x, rainBox ? rainBox.x : box.x);
    const top = Math.min(box.y, rainBox ? rainBox.y : box.y);
    const right = Math.max(box.x + box.width, rainBox ? rainBox.x + rainBox.width : box.x + box.width);
    const bottom = Math.max(box.y + box.height, rainBox ? rainBox.y + rainBox.height : box.y + box.height);
    const bg = svgEl("rect", {
      x: left - 5,
      y: top - 3,
      width: right - left + 10,
      height: bottom - top + 6,
      rx: 8,
      fill: "#10281c",
    });
    group.insertBefore(bg, text);
    group.addEventListener("click", () => select(place.id));
    markers.appendChild(group);
  });
}

function drawTowns() {
  townsEl.replaceChildren();
  pointsOf(report).forEach((place) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "town" + (place.id === selectedId ? " active" : "");
    const meta = document.createElement("span");
    const name = document.createElement("span");
    name.textContent = WR.placeName(place.id, place.label);
    const detail = document.createElement("small");
    detail.textContent = WR.townDetail(place, report.center);
    const rain = document.createElement("small");
    rain.className = "rain";
    rain.textContent = place.rain_label ? WR.rainFull(place.rain_label) : "";
    meta.append(name, detail, rain);
    if (place.eurozone) {
      const euro = document.createElement("small");
      euro.className = "euro";
      euro.textContent = place.eurozone;
      meta.append(euro);
    }
    const tempCol = document.createElement("span");
    tempCol.className = "tempcol";
    const temp = document.createElement("b");
    temp.textContent = `${place.temp_label}°`;
    const avg = document.createElement("small");
    avg.textContent = place.sources_label ? WR.sourcesLine(place.sources_label) : "";
    tempCol.append(temp, avg);
    button.append(meta, tempCol);
    button.addEventListener("click", () => select(place.id));
    townsEl.appendChild(button);
  });
}

function select(id) {
  selectedId = id;
  const place = pointsOf(report).find((item) => item.id === id) || report.center;
  summaryEl.textContent = sentence(place, report.center);
  showRainSoon();
  drawTowns();
  drawMarkers();
}

const PLACE_KEY = "weatherr-place";

function savedPlace() {
  try {
    const raw = JSON.parse(localStorage.getItem(PLACE_KEY) || "null");
    if (!raw || typeof raw.lat !== "number" || typeof raw.lon !== "number") return null;
    return raw;
  } catch (error) {
    return null;
  }
}

let locateTimer = 0;

function setHasPlace(has) {
  window.clearTimeout(locateTimer);
  document.body.classList.toggle("has-place", has);
  const locate = document.getElementById("locate");
  const plus = document.getElementById("geo-plus");
  if (locate) {
    locate.hidden = has;
    locate.disabled = false;
    if (!has && window.WR) locate.textContent = WR.t("locate");
  }
  if (plus) {
    plus.hidden = !has;
    plus.disabled = false;
    plus.textContent = "GEO+";
  }
}

function setLocateBusy(busy) {
  window.clearTimeout(locateTimer);
  const locate = document.getElementById("locate");
  const plus = document.getElementById("geo-plus");
  if (locate && !locate.hidden) {
    locate.disabled = busy;
    locate.textContent = busy ? WR.t("locate_busy") : WR.t("locate");
  }
  if (plus && !plus.hidden) plus.disabled = busy;
  if (busy) locateTimer = window.setTimeout(() => setLocateBusy(false), 35000);
}

function rememberPlace(lat, lon) {
  localStorage.setItem(PLACE_KEY, JSON.stringify({ lat, lon }));
  setHasPlace(true);
}

async function eurozoneLabel(lat, lon) {
  if (!window.weatherRArr || typeof weatherRArr.countryAt !== "function") return "";
  try {
    const country = await weatherRArr.countryAt(lat, lon);
    return country ? WR.euro(country) : "";
  } catch (error) {
    return "";
  }
}

function syncUser(place) {
  const user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  const userId = user && user.id;
  if (!userId) return;
  const body = {
    telegram_id: userId,
    username: user.username || null,
    first_name: user.first_name || null,
    last_name: user.last_name || null,
    language_code: user.language_code || null,
    init_data: tg.initData || "",
  };
  if (place) {
    body.lat = place.lat;
    body.lon = place.lon;
  }
  return fetch("/api/me", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

async function loadStats() {
  const node = document.getElementById("users");
  if (!node) return;
  try {
    const response = await fetch("/api/stats");
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    node.textContent = WR.users(data.users);
  } catch (error) {
    node.textContent = WR.t("users_empty");
  }
}

function show(data) {
  report = data;
  selectedId = myPlace ? myPlace.id : data.center.id;
  centerLine.textContent = WR.centerLine(data.center.temp_label);
  countLine.textContent = WR.cities(data.places.length);
  if (data.center && data.center.sources_label) {
    const clock = data.updated ? ` · ${data.updated.slice(11, 16)}` : "";
    sourceEl.textContent = WR.sourcesLine(data.center.sources_label, clock);
  }
  select(data.center.id);
}

async function restorePlace(lat, lon) {
  const response = await fetch(`/api/point?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
  if (!response.ok) throw new Error(String(response.status));
  const place = await response.json();
  place.eurozone = await eurozoneLabel(lat, lon);
  myPlace = place;
  setHasPlace(true);
  if (report) select(place.id);
}

async function load() {
  const saved = savedPlace();
  setHasPlace(Boolean(saved));
  await syncUser(saved);
  loadStats();
  try {
    const response = await fetch("/api/weather");
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    if (!data.center) throw new Error("empty");
    show(data);
    if (saved) await restorePlace(saved.lat, saved.lon);
  } catch (error) {
    summaryEl.textContent = WR.t("weather_error");
  }
}

function showRainSoon() {
  const node = document.getElementById("rain-soon");
  if (!node) return;
  node.hidden = !(myPlace && myPlace.rain_alert === "soon");
}

function showGeoError(text) {
  const node = document.getElementById("geo-error");
  if (node) node.textContent = text;
}

function finishLocateError(key) {
  showGeoError(WR.t(key));
  setHasPlace(Boolean(savedPlace()));
}

function useCoordinates(lat, lon) {
  showGeoError("");
  setLocateBusy(true);
  fetch(`/api/point?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`)
    .then((response) => {
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    })
    .then(async (place) => {
      place.eurozone = await eurozoneLabel(lat, lon);
      myPlace = place;
      rememberPlace(lat, lon);
      syncUser({ lat, lon });
      if (report) select(place.id);
    })
    .catch(() => {
      finishLocateError("geo_point_failed");
    });
}

function telegramLocationManager() {
  const manager = tg && tg.LocationManager;
  if (!manager || typeof manager.init !== "function" || typeof manager.getLocation !== "function") return null;
  if (tg.initData) return manager;
  if (tg.platform && tg.platform !== "unknown") return manager;
  return null;
}

function requestLocation() {
  showGeoError("");
  setLocateBusy(true);
  const manager = telegramLocationManager();
  if (manager) {
    manager.init(() => {
      manager.getLocation((location) => {
        if (!location || location.latitude == null || location.longitude == null) {
          finishLocateError("geo_denied");
          return;
        }
        useCoordinates(location.latitude, location.longitude);
      });
    });
    return;
  }
  if (!navigator.geolocation) {
    finishLocateError("geo_unavailable");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => useCoordinates(position.coords.latitude, position.coords.longitude),
    () => finishLocateError("geo_failed"),
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

const locateButton = document.getElementById("locate");
const geoPlusButton = document.getElementById("geo-plus");
if (locateButton) locateButton.addEventListener("click", requestLocation);
if (geoPlusButton) geoPlusButton.addEventListener("click", requestLocation);

WR.choose().then(() => load());
setInterval(() => {
  const saved = savedPlace();
  if (!saved || !report) return;
  restorePlace(saved.lat, saved.lon).catch(() => {});
}, 60000);
