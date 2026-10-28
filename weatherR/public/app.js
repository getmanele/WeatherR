const SVG_NS = "http://www.w3.org/2000/svg";
const ART_CX = 188;
const ART_CY = 168;
const ART_RING = 92;
let CX = ART_CX;
let CY = ART_CY;
let RING = ART_RING;
let VB_W = 360;
let VB_H = 328;
let CHIP_W = 112;
let CHIP_H = 36;

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
const windLayer = document.getElementById("wind");

let report = null;
let selectedId = null;
let myPlace = null;

function circleHits(x, y, w, h, cx, cy, radius) {
  const nx = Math.max(x, Math.min(cx, x + w));
  const ny = Math.max(y, Math.min(cy, y + h));
  return Math.hypot(nx - cx, ny - cy) < radius;
}

function boxesOverlap(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function chipBlocked(x, y, mapH) {
  const chip = { x, y, w: CHIP_W, h: CHIP_H };
  const users = { x: 6, y: 6, w: 156, h: 40 };
  const tag = { x: 6, y: mapH - 44, w: 188, h: 38 };
  return boxesOverlap(chip, users) || boxesOverlap(chip, tag);
}

function sideSlots(side, mapW, mapH, cx, cy, radius) {
  const x = side === "left" ? 8 : mapW - CHIP_W - 8;
  const slots = [];
  for (let y = 4; y <= mapH - CHIP_H - 4; y += 4) {
    if (chipBlocked(x, y, mapH)) continue;
    if (circleHits(x, y, CHIP_W, CHIP_H, cx, cy, radius)) continue;
    slots.push({ x, y });
  }
  return slots;
}

function listFloor() {
  const sample = document.querySelector("#towns .town");
  const row = sample ? Math.ceil(sample.getBoundingClientRect().height) + 6 : 70;
  return row * 3;
}

function dockChrome() {
  const dock = document.querySelector(".dock");
  const towns = document.getElementById("towns");
  if (!dock || !towns) return 200;
  const townsH = towns.getBoundingClientRect().height;
  if (townsH < 24) return 200;
  return Math.max(150, Math.round(dock.getBoundingClientRect().height - townsH));
}

function layoutMap() {
  const map = document.querySelector(".map");
  const chart = document.getElementById("chart");
  if (!map || !chart) return false;
  const rect = map.getBoundingClientRect();
  const w = Math.round(rect.width);
  if (w < 80) return false;
  const wrap = document.querySelector(".wrap");
  const screenH = Math.round((wrap && wrap.clientHeight) || window.innerHeight || rect.height || 700);
  const margin = Math.max(12, Math.round(Math.min(w, screenH) * 0.03));
  CHIP_H = w >= 700 ? 40 : 36;
  const top = Math.max(28, 16 + margin);
  const below = CHIP_H * 2 + 8 + margin;
  const mapBudget = Math.max(top + 160 + below, screenH - dockChrome() - listFloor());
  const wanted = Math.round(Math.min(w, screenH) * 0.9);
  const maxDiameter = Math.max(150, mapBudget - top - below);
  const diameter = Math.max(140, Math.min(wanted, maxDiameter, w - 16));
  const mapH = Math.round(Math.min(mapBudget, top + diameter + below));
  if (Math.abs(w - VB_W) < 2 && Math.abs(mapH - VB_H) < 2 && chart.getAttribute("data-fit") === "1") return false;
  map.style.height = mapH + "px";
  CX = w / 2;
  RING = diameter / 2;
  CY = top + RING;
  const limit = Math.min(w / 2 - 8, CY - 8, mapH - CY - below + margin);
  RING = Math.max(80, Math.min(RING, limit));
  CY = top + RING;
  VB_W = w;
  VB_H = mapH;
  chart.setAttribute("viewBox", `0 0 ${w} ${mapH}`);
  chart.setAttribute("data-fit", "1");
  const land = document.getElementById("land");
  if (land) {
    const scale = RING / ART_RING;
    land.setAttribute("transform", `translate(${CX} ${CY}) scale(${scale}) translate(${-ART_CX} ${-ART_CY})`);
  }
  const ring = document.getElementById("ring");
  if (ring) {
    ring.setAttribute("cx", CX);
    ring.setAttribute("cy", CY);
    ring.setAttribute("r", RING);
  }
  return true;
}

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

function mapRain(place) {
  if (!place) return "";
  if (place.rain_alert === "now" || place.rain_label === "дождь сейчас") return WR.t("map_rain_now");
  const minutes = Number(place.rain_minutes);
  if (Number.isFinite(minutes) && minutes > 0 && minutes <= 5) {
    return WR.t("map_rain_soon", { n: Math.max(1, Math.round(minutes)) });
  }
  return "";
}

const MAP_FONT = "-apple-system, BlinkMacSystemFont, sans-serif";

function mapTypeSize() {
  const screen = Math.min(window.innerWidth || 390, window.innerHeight || 700);
  const byRing = RING / 16;
  const byScreen = screen / 38;
  return Math.round(Math.max(8, Math.min(13, Math.min(byRing, byScreen))));
}

function measureSvgText(text, fontSize) {
  const node = svgEl("text", {
    x: 0,
    y: 0,
    "font-size": fontSize,
    "font-family": MAP_FONT,
    visibility: "hidden",
  });
  node.textContent = text;
  markers.appendChild(node);
  const box = node.getBBox();
  node.remove();
  return { w: box.width, h: box.height };
}

function sentence(place, center) {
  return WR.summary(place, center);
}

function overlaps(a, b) {
  const gap = Math.max(4, (a.gap || 5));
  return !(a.x + a.w + gap < b.x || b.x + b.w + gap < a.x || a.y + a.h + gap < b.y || b.y + b.h + gap < a.y);
}

function overlapAmount(box, taken) {
  return taken.reduce((sum, prev) => {
    const width = Math.max(0, Math.min(box.x + box.w, prev.x + prev.w) - Math.max(box.x, prev.x));
    const height = Math.max(0, Math.min(box.y + box.h, prev.y + prev.h) - Math.max(box.y, prev.y));
    return sum + width * height;
  }, 0);
}

function labelBox(layout, width, height) {
  return {
    x: layout.anchor === "end" ? layout.x - width : layout.x,
    y: layout.y - layout.nameSize * 0.82,
    w: width,
    h: height,
    gap: Math.max(4, layout.nameSize * 0.45),
  };
}

function circleFits(box) {
  const pad = 3;
  const corners = [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x, box.y + box.h],
    [box.x + box.w, box.y + box.h],
  ];
  return corners.every(([x, y]) => Math.hypot(x - CX, y - CY) <= RING - pad);
}

function labelCandidates(x, y, isCenter, nameSize) {
  const near = Math.max(16, nameSize + 12);
  const mid = near + nameSize + 6;
  const far = mid + nameSize + 8;
  if (isCenter) {
    const side = near + 4;
    return [
      { x: x + side, y: y - 2, anchor: "start", nameSize },
      { x: x - side, y: y - 2, anchor: "end", nameSize },
      { x: x + side, y: y + nameSize + 10, anchor: "start", nameSize },
      { x: x - side, y: y + nameSize + 10, anchor: "end", nameSize },
    ];
  }
  const dx = x - CX;
  const dy = y - CY;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const dirs = [];
  for (let turn = 0; turn < 8; turn += 1) {
    const angle = Math.atan2(uy, ux) + turn * Math.PI / 4;
    dirs.push([Math.cos(angle), Math.sin(angle)]);
  }
  const spots = [];
  [near, mid, far].forEach((dist) => {
    dirs.forEach(([dirX, dirY]) => {
      spots.push({
        x: x + dirX * dist,
        y: y + dirY * dist,
        anchor: dirX < -0.15 ? "end" : "start",
        nameSize,
      });
    });
  });
  return spots;
}

function layoutLabels(items, obstacles) {
  const taken = (obstacles || []).map((box) => ({
    x: box.x - 4,
    y: box.y - 4,
    w: box.w + 8,
    h: box.h + 8,
    gap: 6,
  }));
  items.forEach((item) => {
    const options = labelCandidates(item.x, item.y, item.isCenter, item.nameSize);
    let best = null;
    options.forEach((option) => {
      const box = labelBox(option, item.labelW, item.labelH);
      if (!circleFits(box)) return;
      const hit = overlapAmount(box, taken) + (overlapsDot(box, item) ? 400 : 0);
      const dist = Math.hypot(option.x - item.x, option.y - item.y);
      if (!best || hit < best.hit || (hit === best.hit && dist < best.dist)) {
        best = { option, box, hit, dist };
      }
    });
    if (!best) {
      const option = options[0];
      best = { option, box: labelBox(option, item.labelW, item.labelH), hit: 1, dist: 0 };
    }
    taken.push(best.box);
    item.layout = best.option;
  });
}

function overlapsDot(box, item) {
  const pad = Math.max(7, item.nameSize);
  return item.x >= box.x - pad && item.x <= box.x + box.w + pad
    && item.y >= box.y - pad && item.y <= box.y + box.h + pad;
}

function windPlace(reportData) {
  const places = pointsOf(reportData).filter((place) => place);
  const chosen = places.find((place) => place.id === selectedId);
  if (chosen && chosen.wind_deg != null) return chosen;
  return places.find((place) => place.id === reportData.center.id && place.wind_deg != null) || null;
}

function windDegrees(reportData) {
  const place = windPlace(reportData);
  return place ? Number(place.wind_deg) : null;
}

function streakHits(x1, y1, x2, y2, boxes) {
  const samples = [
    [x1, y1],
    [(x1 + x2) / 2, (y1 + y2) / 2],
    [x2, y2],
  ];
  return boxes.some((box) => samples.some(([x, y]) => (
    x >= box.x - 8 && x <= box.x + box.w + 8 && y >= box.y - 8 && y <= box.y + box.h + 8
  )));
}

let windField = null;
let windBoxes = [];
let windClock = 0;
let windFrame = 0;

function windLength(speed) {
  const base = Number.isFinite(speed) ? Math.max(12, Math.min(22, 10 + speed)) : 16;
  return base * 1.5;
}

function seedWind(dx, dy, length) {
  const particles = [];
  const step = Math.max(26, RING / 5.4);
  const span = Math.ceil((RING * 2) / step);
  for (let row = 0; row <= span; row += 1) {
    for (let col = 0; col <= span; col += 1) {
      const x = CX - RING + col * step + (row % 2) * (step / 2);
      const y = CY - RING + row * step;
      if (Math.hypot(x - CX, y - CY) > RING - 10) continue;
      const shift = Math.random() * length;
      particles.push({
        x: x + dx * shift,
        y: y + dy * shift,
        tail: svgEl("line", { class: "tail" }),
        head: svgEl("line", { class: "head" }),
      });
    }
  }
  return particles;
}

function drawWind(boxes) {
  windBoxes = boxes || [];
  if (!windLayer) return;
  if (!report) {
    windField = null;
    windLayer.replaceChildren();
    return;
  }
  const from = windDegrees(report);
  if (from == null || Number.isNaN(from)) {
    windField = null;
    windLayer.replaceChildren();
    return;
  }
  const toward = (from + 180) % 360;
  const rad = toward * Math.PI / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const speed = parseFloat(String((windPlace(report) || {}).wind_label || "").replace(",", "."));
  const length = windLength(speed);
  const key = `${Math.round(from)}:${Math.round(length)}:${Math.round(RING)}`;
  if (!windField || windField.key !== key) {
    const particles = seedWind(dx, dy, length);
    windLayer.replaceChildren();
    particles.forEach((particle) => {
      windLayer.append(particle.tail, particle.head);
    });
    windField = {
      key,
      dx,
      dy,
      length,
      speed: Number.isFinite(speed) ? speed : 4,
      particles,
    };
  }
  if (!windFrame) windFrame = requestAnimationFrame(stepWind);
}

function parkWind(particle, x1, y1, x2, y2, hidden) {
  const tail = lengthPoint(x1, y1, x2, y2, 0.62);
  particle.tail.setAttribute("x1", x1);
  particle.tail.setAttribute("y1", y1);
  particle.tail.setAttribute("x2", tail.x);
  particle.tail.setAttribute("y2", tail.y);
  particle.head.setAttribute("x1", tail.x);
  particle.head.setAttribute("y1", tail.y);
  particle.head.setAttribute("x2", x2);
  particle.head.setAttribute("y2", y2);
  const show = hidden ? "none" : "";
  particle.tail.style.display = show;
  particle.head.style.display = show;
}

function lengthPoint(x1, y1, x2, y2, t) {
  return { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t };
}

function stepWind(now) {
  windFrame = requestAnimationFrame(stepWind);
  const field = windField;
  if (!field || !windLayer) return;
  const dt = Math.min(34, windClock ? now - windClock : 16);
  windClock = now;
  const travel = (16 + field.speed * 2.4) * dt / 1000;
  field.particles.forEach((particle) => {
    particle.x += field.dx * travel;
    particle.y += field.dy * travel;
    if (Math.hypot(particle.x - CX, particle.y - CY) > RING - 4) {
      particle.x -= field.dx * RING * 1.85;
      particle.y -= field.dy * RING * 1.85;
    }
    const x1 = particle.x - field.dx * field.length;
    const y1 = particle.y - field.dy * field.length;
    const inside = Math.hypot(particle.x - CX, particle.y - CY) <= RING + 2
      && Math.hypot(x1 - CX, y1 - CY) <= RING + 8;
    const hidden = !inside || streakHits(x1, y1, particle.x, particle.y, windBoxes);
    parkWind(particle, x1, y1, particle.x, particle.y, hidden);
  });
}

function outsidePlaces() {
  return (report.places || []).filter((place) => place.outside_ring && place.id !== "me");
}

function listPlaces() {
  return pointsOf(report).filter((place) => place.id === "me" || !place.outside_ring);
}

function awaySide() {
  if (!myPlace || !report || !report.center) return "right";
  return myPlace.lon <= report.center.lon ? "right" : "left";
}

function splitSides(places) {
  const side = awaySide();
  return {
    left: side === "left" ? places.slice() : [],
    right: side === "right" ? places.slice() : [],
  };
}

function pickSlots(slots, count) {
  const ranked = slots.slice().sort((a, b) => (
    Math.abs(a.y + CHIP_H / 2 - CY) - Math.abs(b.y + CHIP_H / 2 - CY)
  ));
  const chosen = [];
  ranked.forEach((slot) => {
    if (chosen.length >= count) return;
    if (chosen.some((prev) => Math.abs(prev.y - slot.y) < CHIP_H + 6)) return;
    chosen.push(slot);
  });
  return chosen.sort((a, b) => a.y - b.y);
}

function flankButton(place, slot) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "beyond" + (place.id === selectedId ? " active" : "");
  button.style.left = `${slot.x}px`;
  button.style.top = `${slot.y}px`;
  button.style.width = `${CHIP_W}px`;
  button.style.height = `${CHIP_H}px`;
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = WR.placeName(place.id, place.label);
  button.append(name);
  button.addEventListener("click", () => select(place.id));
  return button;
}

function planFlanks() {
  const places = outsidePlaces();
  const map = document.querySelector(".map");
  const side = awaySide();
  if (map) map.dataset.away = side;
  if (!places.length) return [];
  const margin = Math.max(12, Math.round(Math.min(VB_W, VB_H) * 0.03));
  const gap = 8;
  CHIP_W = Math.min(156, Math.max(120, Math.round(VB_W * 0.42)));
  const x = side === "right" ? VB_W - 12 - CHIP_W : 12;
  const y0 = CY + RING + margin;
  return places.map((place, index) => {
    const y = y0 + index * (CHIP_H + gap);
    return {
      place,
      slot: { x, y },
      box: { x, y, w: CHIP_W, h: CHIP_H },
    };
  });
}

function drawFlanks(plan) {
  const layer = document.getElementById("flanks");
  if (!layer) return;
  layer.replaceChildren();
  plan.forEach((item) => layer.appendChild(flankButton(item.place, item.slot)));
}

function leaderLine(box, city, gap) {
  const x = Math.max(box.x, Math.min(city.x, box.x + box.w));
  const y = Math.max(box.y, Math.min(city.y, box.y + box.h));
  const dx = city.x - x;
  const dy = city.y - y;
  const len = Math.hypot(dx, dy);
  if (len < gap + 4) return null;
  return svgEl("line", {
    class: "leader",
    x1: x,
    y1: y,
    x2: city.x - (dx / len) * gap,
    y2: city.y - (dy / len) * gap,
  });
}

function drawMarkers() {
  if (!report) return;
  layoutMap();
  markers.replaceChildren();
  const ordered = pointsOf(report).filter((place) => !place.outside_ring).slice().sort((a, b) => {
    if (a.id === "me") return 1;
    if (b.id === "me") return -1;
    if (a.id === report.center.id) return -1;
    if (b.id === report.center.id) return 1;
    return (b.distance_km || 0) - (a.distance_km || 0);
  });
  const nameSize = mapTypeSize();
  const rainSize = Math.max(7, nameSize - 2);
  const items = ordered.map((place) => {
    const pos = project(place.lat, place.lon, report.center, place.outside_ring);
    const text = `${WR.placeName(place.id, place.label)} ${place.temp_label}°`;
    const rain = mapRain(place);
    const nameBox = measureSvgText(text, nameSize);
    const rainBox = rain ? measureSvgText(rain, rainSize) : { w: 0, h: 0 };
    return {
      place,
      x: pos.x,
      y: pos.y,
      isCenter: place.id === report.center.id,
      text,
      rain,
      nameSize,
      rainSize,
      labelW: Math.max(nameBox.w, rainBox.w),
      labelH: rain ? nameBox.h + rainSize * 0.45 + rainBox.h : nameBox.h,
    };
  });
  const flanks = planFlanks();
  layoutLabels(items, flanks.map((item) => item.box));
  const labelBoxes = [];
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
      "font-size": item.nameSize,
      "font-family": MAP_FONT,
      "text-anchor": layout.anchor,
    });
    text.textContent = caption;
    group.appendChild(text);
    let rainText = null;
    if (item.rain) {
      rainText = svgEl("text", {
        x: layout.x,
        y: Number(layout.y) + item.nameSize * 1.15,
        fill: "#b7f5d0",
        "font-size": item.rainSize,
        "font-family": MAP_FONT,
        "text-anchor": layout.anchor,
      });
      rainText.textContent = item.rain;
      group.appendChild(rainText);
    }
    markers.appendChild(group);
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
    const leader = leaderLine(
      { x: left, y: top, w: right - left, h: bottom - top },
      pos,
      isCenter ? 10 : 7
    );
    if (leader) group.insertBefore(leader, group.firstChild);
    labelBoxes.push({
      x: left - 5,
      y: top - 3,
      w: right - left + 10,
      h: bottom - top + 6,
    });
    group.addEventListener("click", () => select(place.id));
  });
  drawWind(labelBoxes);
  drawFlanks(flanks);
}

function windGustLine(place) {
  const gust = place.gust_label ? WR.t("fact_gust", { n: WR.wind(place.gust_label) }) : "";
  const detail = WR.townDetail(place, report.center);
  return gust ? detail + " · " + gust : detail;
}

function drawTowns() {
  townsEl.replaceChildren();
  listPlaces().forEach((place) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.id = place.id;
    button.className = "town" + (place.id === selectedId ? " active" : "");
    const meta = document.createElement("span");
    const name = document.createElement("span");
    name.textContent = WR.placeName(place.id, place.label);
    const detail = document.createElement("small");
    detail.textContent = windGustLine(place);
    meta.append(name, detail);
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

const factsEl = document.getElementById("facts");
let lockTownScroll = false;

function factButton(text) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  return button;
}

function fillFacts(place) {
  if (!factsEl) return;
  factsEl.hidden = false;
  factsEl.replaceChildren(
    factButton(place.rain_label ? WR.rainShort(place.rain_label) : WR.t("rain.short_unknown")),
    factButton(WR.t("fact_wind", { n: WR.wind(place.wind_label) })),
    factButton(WR.t("fact_gust", { n: place.gust_label ? WR.wind(place.gust_label) : "—" })),
    factButton(WR.t("fact_humidity", { n: place.humidity_label || "—" }))
  );
}

function markActiveTown() {
  townsEl.querySelectorAll(".town").forEach((button) => {
    button.classList.toggle("active", button.dataset.id === selectedId);
  });
}

function townNode(id) {
  return [...townsEl.querySelectorAll(".town")].find((node) => node.dataset.id === id) || null;
}

function revealTown(id) {
  const node = townNode(id);
  if (!node) return;
  lockTownScroll = true;
  const top = node.getBoundingClientRect().top - townsEl.getBoundingClientRect().top + townsEl.scrollTop;
  townsEl.scrollTo({ top: top, behavior: "auto" });
  window.setTimeout(() => {
    lockTownScroll = false;
  }, 400);
}

function snappedTownId() {
  const buttons = [...townsEl.querySelectorAll(".town")];
  if (!buttons.length) return null;
  const top = townsEl.getBoundingClientRect().top;
  let best = buttons[0];
  let bestDist = Infinity;
  buttons.forEach((button) => {
    const dist = Math.abs(button.getBoundingClientRect().top - top);
    if (dist < bestDist) {
      best = button;
      bestDist = dist;
    }
  });
  return best.dataset.id;
}

function select(id, fromScroll) {
  selectedId = id;
  const place = pointsOf(report).find((item) => item.id === id) || report.center;
  summaryEl.textContent = sentence(place, report.center);
  showRainSoon();
  if (fromScroll) markActiveTown();
  else {
    lockTownScroll = true;
    drawTowns();
    revealTown(id);
  }
  fillFacts(place);
  drawMarkers();
}

let townScrollTimer = 0;
if (townsEl) {
  townsEl.addEventListener("scroll", () => {
    if (lockTownScroll || !report) return;
    window.clearTimeout(townScrollTimer);
    townScrollTimer = window.setTimeout(() => {
      const id = snappedTownId();
      if (!id || id === selectedId) return;
      select(id, true);
    }, 80);
  }, { passive: true });
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

const mapNode = document.querySelector(".map");
if (mapNode && typeof ResizeObserver === "function") {
  let frame = 0;
  const observer = new ResizeObserver(() => {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      if (!layoutMap()) return;
      if (report) drawMarkers();
    });
  });
  observer.observe(mapNode);
}

WR.choose().then(() => load());
setInterval(() => {
  const saved = savedPlace();
  if (!saved || !report) return;
  restorePlace(saved.lat, saved.lon).catch(() => {});
}, 60000);
