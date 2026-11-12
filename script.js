import { KR_REGIONS } from "./regions.js";
import { createMap3D } from "./map3d.js";

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const REFRESH_MS = 10 * 60 * 1000; // 선택 지점 10분마다 갱신
const REGION_TTL_MS = 30 * 60 * 1000; // 전국 76곳은 30분 캐시 (무료 호출 한도 절약)

// WMO 날씨 코드 → [아이콘, 설명]
const WMO = {
  0: ["☀️", "맑음"], 1: ["🌤️", "대체로 맑음"], 2: ["⛅", "부분적으로 흐림"], 3: ["☁️", "흐림"],
  45: ["🌫️", "안개"], 48: ["🌫️", "서리 안개"],
  51: ["🌦️", "약한 이슬비"], 53: ["🌦️", "이슬비"], 55: ["🌦️", "강한 이슬비"],
  56: ["🌧️", "약한 어는 이슬비"], 57: ["🌧️", "강한 어는 이슬비"],
  61: ["🌧️", "약한 비"], 63: ["🌧️", "비"], 65: ["🌧️", "강한 비"],
  66: ["🌧️", "약한 어는 비"], 67: ["🌧️", "강한 어는 비"],
  71: ["🌨️", "약한 눈"], 73: ["🌨️", "눈"], 75: ["❄️", "강한 눈"], 77: ["❄️", "싸락눈"],
  80: ["🌦️", "약한 소나기"], 81: ["🌦️", "소나기"], 82: ["⛈️", "강한 소나기"],
  85: ["🌨️", "약한 눈 소나기"], 86: ["❄️", "강한 눈 소나기"],
  95: ["⛈️", "뇌우"], 96: ["⛈️", "약한 우박 뇌우"], 99: ["⛈️", "강한 우박 뇌우"],
};

const $ = (id) => document.getElementById(id);
let current = null;
let timer = null;

/* ---------- 한글 → 영문 로마자 변환 (국어 로마자 표기법 단순 적용) ---------- */
const INITIALS = ["g","kk","n","d","tt","r","m","b","pp","s","ss","","j","jj","ch","k","t","p","h"];
const VOWELS = ["a","ae","ya","yae","eo","e","yeo","ye","o","wa","wae","oe","yo","u","wo","we","wi","yu","eu","ui","i"];
const FINALS = ["","k","k","k","n","n","n","t","l","k","m","l","l","l","p","l","m","p","p","t","t","ng","t","t","k","t","p","t"];

function romanize(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) { out += ch; continue; }
    out += INITIALS[Math.floor(code / 588)] + VOWELS[Math.floor((code % 588) / 28)] + FINALS[code % 28];
  }
  return out;
}
const hasHangul = (s) => /[가-힣ㄱ-ㅎ]/.test(s);

/* ---------- 자동완성 ---------- */
function toPlace(r) {
  return { lat: r[2], lon: r[3], label: `${r[0]} (${r[1]}) · ${r[4]}` };
}

function localMatches(q) {
  const low = q.toLowerCase();
  return KR_REGIONS.filter((r) => r[0].startsWith(q) || r[1].toLowerCase().startsWith(low)).map(toPlace);
}

// 목록에 없는 지역: 한글이면 영문으로 변환 후 Open-Meteo 지오코딩 (한국만)
async function remoteMatches(q) {
  const name = hasHangul(q) ? romanize(q) : q;
  const data = await fetchJson(`${GEO_URL}?name=${encodeURIComponent(name)}&count=10&language=ko`);
  return (data.results || [])
    .filter((r) => r.country_code === "KR")
    .map((r) => ({
      lat: r.latitude,
      lon: r.longitude,
      label: [r.name, r.admin1].filter(Boolean).join(" · "),
    }));
}

let suggestions = [];
let activeIdx = -1;
let debounce = null;
let reqId = 0;

function showSuggestions(list) {
  suggestions = list;
  activeIdx = -1;
  const ul = $("suggestions");
  ul.innerHTML = "";
  list.forEach((p, i) => {
    const li = document.createElement("li");
    li.textContent = p.label;
    li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(i); });
    ul.appendChild(li);
  });
  ul.hidden = list.length === 0;
}

function highlight() {
  [...$("suggestions").children].forEach((li, i) => li.classList.toggle("active", i === activeIdx));
}

function choose(i) {
  const p = suggestions[i];
  if (!p) return;
  $("city-input").value = p.label.split(/ [(·]/)[0];
  showSuggestions([]);
  startWeather(p);
}

function onInput() {
  const q = $("city-input").value.trim();
  clearTimeout(debounce);
  if (!q) return showSuggestions([]);
  const local = localMatches(q);
  showSuggestions(local); // 즉시 표시
  const id = ++reqId;
  debounce = setTimeout(async () => {
    try {
      const remote = await remoteMatches(q);
      if (id !== reqId) return; // 오래된 응답 무시
      const seen = new Set(local.map((p) => p.label.split(/ [(·]/)[0]));
      const extra = remote.filter((p) => !seen.has(p.label.split(" · ")[0]));
      showSuggestions([...local, ...extra].slice(0, 10));
    } catch { /* 자동완성 실패는 무시 */ }
  }, 300);
}

/* ---------- 등급 / 색상 ---------- */
const COLORS = ["#2f80ed", "#27ae60", "#f2994a", "#eb5757"];
const GRADES = ["좋음", "보통", "나쁨", "매우나쁨"];
const LIMITS = { pm10: [30, 80, 150], pm25: [15, 35, 75] }; // 환경부 기준

function gradeIdx(metric, v) {
  if (v == null) return -1;
  const i = LIMITS[metric].findIndex((lim) => v <= lim);
  return i === -1 ? 3 : i;
}
const colorOf = (metric, v) => COLORS[gradeIdx(metric, v)] ?? "#9aa0a6";
const gradeText = (metric, v) => GRADES[gradeIdx(metric, v)] ?? "";
const fmt = (v, unit = "") => (v == null ? "-" : `${v}${unit}`);

/* ---------- API ---------- */
function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status === 429 ? "API 요청 한도 초과 (429)" : `요청 실패 (${res.status})`);
  return res.json();
}

// Open-Meteo 무료 한도(시간당 호출 수) 절약: 응답을 localStorage에 잠시 저장한다
async function cachedJson(url, ttlMs) {
  const key = `om:${url}`;
  try {
    const hit = JSON.parse(localStorage.getItem(key));
    if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  } catch { /* 저장소 사용 불가 시 무시 */ }
  const v = await fetchJson(url);
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), v }));
  } catch { /* 용량 초과 등 무시 */ }
  return v;
}

// 좌표 여러 개를 한 번에 요청하면 배열로, 하나면 객체로 돌아오므로 항상 배열로 맞춘다
// 대기질 API가 실패해도 날씨는 보여 주도록 air 는 실패 시 null 배열 + airError 를 돌려준다
async function fetchPoints(points, wCurrent, aCurrent, ttlMs = 10 * 60 * 1000) {
  const lat = points.map((p) => p.lat).join(",");
  const lon = points.map((p) => p.lon).join(",");
  const q = `latitude=${lat}&longitude=${lon}&timezone=auto`;
  const [w, a] = await Promise.allSettled([
    cachedJson(`${WEATHER_URL}?${q}&current=${wCurrent}`, ttlMs),
    cachedJson(`${AIR_URL}?${q}&current=${aCurrent}`, ttlMs),
  ]);
  if (w.status === "rejected") throw w.reason;
  const weather = [].concat(w.value).map((x) => x.current);
  const air = a.status === "fulfilled"
    ? [].concat(a.value).map((x) => x.current)
    : points.map(() => null);
  return { weather, air, airError: a.status === "rejected" ? a.reason.message : null };
}

/* ---------- 3D 지도 ---------- */
let map3d;
let regionData = []; // 전국 기둥용 { place, w, a }
let metric = "pm10";
let selectedLabel = null;

function drawMarkers() {
  if (!map3d) return;
  map3d.setItems(
    regionData.map((d) => {
      const v = metric === "pm10" ? d.a?.pm10 : d.a?.pm2_5;
      const [icon] = WMO[d.w?.weather_code] || ["❓"];
      return {
        place: d.place,
        lat: d.place.lat,
        lon: d.place.lon,
        label: d.place.label,
        name: `${d.place.label.split(" (")[0]} · ${fmt(v)}㎍/㎥ ${gradeText(metric, v)}`,
        color: colorOf(metric, v),
        value: Math.min(v ?? 0, 150) / 150,
        text: `${icon}${d.w ? Math.round(d.w.temperature_2m) : "-"}°`,
      };
    }),
    selectedLabel
  );
}

async function loadRegions() {
  try {
    const places = KR_REGIONS.map(toPlace);
    const { weather, air, airError } = await fetchPoints(
      places, "temperature_2m,weather_code", "pm10,pm2_5", REGION_TTL_MS
    );
    regionData = places.map((place, i) => ({ place, w: weather[i], a: air[i] }));
    drawMarkers();
    if (airError) setStatus(`미세먼지를 불러오지 못했습니다: ${airError}. 잠시 후 다시 시도해 주세요.`, true);
  } catch (e) {
    setStatus(`전국 기둥을 불러오지 못했습니다: ${e.message}`, true);
  }
}

async function initMap() {
  map3d = await createMap3D({
    container: $("map"),
    geoUrl: "data/korea-provinces.json",
    onPickItem: (it) => startWeather(it.place),
    onPickPoint: (lat, lon) =>
      startWeather({ lat, lon, label: `선택 지점 (${lat.toFixed(2)}, ${lon.toFixed(2)})` }),
  });
  document.querySelectorAll('input[name="metric"]').forEach((r) =>
    r.addEventListener("change", () => { metric = r.value; drawMarkers(); })
  );
}

/* ---------- 상세 패널 ---------- */
function render(place, c, a) {
  const [icon, desc] = WMO[c.weather_code] || ["❓", "알 수 없음"];
  $("place").textContent = place.label;
  $("icon").textContent = icon;
  $("temp").textContent = `${Math.round(c.temperature_2m)}°C`;
  $("desc").textContent = desc;
  $("feels").textContent = `${Math.round(c.apparent_temperature)}°C`;
  $("humidity").textContent = `${c.relative_humidity_2m}%`;
  $("wind").textContent = `${c.wind_speed_10m} km/h`;
  $("precip").textContent = `${c.precipitation} mm`;
  for (const [id, key, m] of [["pm10", "pm10", "pm10"], ["pm25", "pm2_5", "pm25"]]) {
    const v = a?.[key];
    const el = $(id);
    el.textContent = `${fmt(v)} ㎍/㎥`;
    const g = document.createElement("span");
    g.className = "grade";
    g.style.color = colorOf(m, v);
    g.textContent = gradeText(m, v);
    el.appendChild(g);
  }
  $("updated").textContent = `기준 시각: ${c.time.replace("T", " ")} (현지)`;
  $("weather").hidden = false;
}

async function load(place) {
  setStatus("불러오는 중...");
  try {
    const { weather, air, airError } = await fetchPoints(
      [place],
      "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
      "pm10,pm2_5"
    );
    render(place, weather[0], air[0]);
    current = place;
    setStatus(airError ? `미세먼지 정보 없음: ${airError}` : "", !!airError);
  } catch (e) {
    setStatus(e.message, true);
  }
}

function startWeather(place) {
  selectedLabel = place.label;
  drawMarkers();
  const isRegion = regionData.some((d) => d.place.label === place.label);
  map3d?.focus(place.lat, place.lon, !isRegion);
  load(place);
  clearInterval(timer);
  timer = setInterval(() => { current && load(current); loadRegions(); }, REFRESH_MS); // loadRegions 는 캐시 덕에 30분마다만 실제 호출
}

/* ---------- 이벤트 ---------- */
const input = $("city-input");
input.addEventListener("input", onInput);
input.addEventListener("blur", () => setTimeout(() => showSuggestions([]), 100));
input.addEventListener("keydown", (e) => {
  if (!suggestions.length) return;
  if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = (activeIdx + 1) % suggestions.length; highlight(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = (activeIdx - 1 + suggestions.length) % suggestions.length; highlight(); }
  else if (e.key === "Escape") showSuggestions([]);
});

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (suggestions.length) return choose(activeIdx >= 0 ? activeIdx : 0);
  const q = input.value.trim();
  if (!q) return;
  setStatus("검색 중...");
  try {
    const list = [...localMatches(q), ...(await remoteMatches(q))];
    if (!list.length) throw new Error("지역을 찾을 수 없습니다.");
    startWeather(list[0]);
  } catch (err) {
    $("weather").hidden = true;
    setStatus(err.message, true);
  }
});

/* ---------- 시작 ---------- */
initMap()
  .then(loadRegions)
  .then(() => startWeather(toPlace(KR_REGIONS[0])))
  .catch((e) => setStatus(`3D 지도를 시작하지 못했습니다: ${e.message}`, true));
