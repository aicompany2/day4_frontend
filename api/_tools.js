// Gemini 가 호출하는 두 가지 도구: get_weather(실시간 날씨·미세먼지), find_spots(장소 검색)
const WMO = {
  0: "맑음", 1: "대체로 맑음", 2: "부분적으로 흐림", 3: "흐림", 45: "안개", 48: "서리 안개",
  51: "약한 이슬비", 53: "이슬비", 55: "강한 이슬비", 56: "어는 이슬비", 57: "강한 어는 이슬비",
  61: "약한 비", 63: "비", 65: "강한 비", 66: "어는 비", 67: "강한 어는 비",
  71: "약한 눈", 73: "눈", 75: "강한 눈", 77: "싸락눈",
  80: "약한 소나기", 81: "소나기", 82: "강한 소나기", 85: "약한 눈 소나기", 86: "강한 눈 소나기",
  95: "뇌우", 96: "우박 동반 뇌우", 99: "강한 우박 동반 뇌우",
};

const PM_LIMITS = { pm10: [30, 80, 150], pm25: [15, 35, 75] }; // 환경부 기준
const GRADES = ["좋음", "보통", "나쁨", "매우나쁨"];
function grade(kind, v) {
  if (v == null) return null;
  const i = PM_LIMITS[kind].findIndex((lim) => v <= lim);
  return GRADES[i === -1 ? 3 : i];
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const e = new Error(res.status === 429 ? "외부 API 요청 한도 초과(429)" : `외부 API 오류(${res.status})`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

const kakaoHeaders = () => ({ Authorization: `KakaoAK ${process.env.KAKAO_REST_API_KEY}` });

/* ---------- 위치 해석: 좌표 직접 > 카카오 > Open-Meteo 지오코딩 ---------- */
async function resolveLocation({ place, latitude, longitude }) {
  if (typeof latitude === "number" && typeof longitude === "number") {
    return { name: place || `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`, lat: latitude, lon: longitude };
  }
  if (!place) throw new Error("place 또는 latitude/longitude 가 필요합니다.");
  if (process.env.KAKAO_REST_API_KEY) {
    const d = await getJson(
      `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(place)}&size=1`,
      { headers: kakaoHeaders() }
    );
    const doc = d.documents?.[0];
    if (doc) return { name: doc.place_name, lat: Number(doc.y), lon: Number(doc.x) };
  }
  const g = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=ko`
  );
  const r = g.results?.[0];
  if (!r) throw new Error(`'${place}' 위치를 찾지 못했습니다. 영문 이름이나 좌표로 다시 시도하세요.`);
  return { name: [r.name, r.admin1].filter(Boolean).join(", "), lat: r.latitude, lon: r.longitude };
}

/* ---------- 도구 1: get_weather ---------- */
async function get_weather(args) {
  const loc = await resolveLocation(args);
  const base = `latitude=${loc.lat}&longitude=${loc.lon}&timezone=auto`;
  const [w, a] = await Promise.allSettled([
    getJson(
      `https://api.open-meteo.com/v1/forecast?${base}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1`
    ),
    getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?${base}&current=pm10,pm2_5`),
  ]);
  if (w.status === "rejected") throw w.reason;
  const c = w.value.current;
  const d = w.value.daily;
  const out = {
    location: loc.name,
    latitude: loc.lat,
    longitude: loc.lon,
    time: c.time,
    condition: WMO[c.weather_code] ?? "알 수 없음",
    temperature_c: c.temperature_2m,
    feels_like_c: c.apparent_temperature,
    humidity_pct: c.relative_humidity_2m,
    wind_kmh: c.wind_speed_10m,
    precipitation_mm: c.precipitation,
    today_max_c: d?.temperature_2m_max?.[0],
    today_min_c: d?.temperature_2m_min?.[0],
    today_rain_probability_pct: d?.precipitation_probability_max?.[0],
  };
  if (a.status === "fulfilled") {
    const p = a.value.current;
    out.pm10 = p.pm10;
    out.pm10_grade = grade("pm10", p.pm10);
    out.pm25 = p.pm2_5;
    out.pm25_grade = grade("pm25", p.pm2_5);
  } else {
    out.air_quality = `조회 실패: ${a.reason.message}`;
  }
  return out;
}

/* ---------- 도구 2: find_spots (카카오 로컬 API) ---------- */
const CATEGORY_CODE = { tourist: "AT4", cafe: "CE7", restaurant: "FD6", culture: "CT1" };

async function find_spots({ region, keyword, category, limit }) {
  if (!process.env.KAKAO_REST_API_KEY) throw new Error("서버에 KAKAO_REST_API_KEY 가 설정되어 있지 않습니다.");
  const query = [region, keyword].filter(Boolean).join(" ").trim();
  if (!query) throw new Error("region 또는 keyword 가 필요합니다.");
  const size = Math.min(Math.max(Number(limit) || 5, 1), 10);
  let url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=${size}`;
  if (CATEGORY_CODE[category]) url += `&category_group_code=${CATEGORY_CODE[category]}`;
  const d = await getJson(url, { headers: kakaoHeaders() });
  return {
    query,
    count: d.documents.length,
    spots: d.documents.map((x) => ({
      name: x.place_name,
      category: x.category_name,
      address: x.road_address_name || x.address_name,
      latitude: Number(x.y),
      longitude: Number(x.x),
      url: x.place_url,
    })),
  };
}

/* ---------- Gemini 함수 선언 ---------- */
const declarations = [
  {
    name: "get_weather",
    description:
      "한국 또는 세계 지역의 실시간 날씨(기온, 체감온도, 습도, 풍속, 강수량, 오늘 최고/최저, 강수확률)와 미세먼지(PM10, PM2.5)를 조회한다. " +
      "추천 전에 해당 지역의 날씨를 확인할 때 사용한다.",
    parameters: {
      type: "OBJECT",
      properties: {
        place: { type: "STRING", description: "지역·도시 이름. 예: 속초, 제주, 부산 해운대" },
        latitude: { type: "NUMBER", description: "위도. find_spots 결과의 좌표를 그대로 넘길 수 있다." },
        longitude: { type: "NUMBER", description: "경도" },
      },
    },
  },
  {
    name: "find_spots",
    description:
      "지역과 키워드로 실제 장소(관광지, 카페, 음식점, 문화시설 등)를 검색한다. 이름, 주소, 좌표를 돌려준다. " +
      "장소를 추천하려면 반드시 이 도구의 결과에서 고른다.",
    parameters: {
      type: "OBJECT",
      properties: {
        region: { type: "STRING", description: "검색할 지역. 예: 속초, 제주시, 전주 한옥마을" },
        keyword: { type: "STRING", description: "찾을 것. 예: 박물관, 실내 데이트, 해산물, 산책로, 전망 좋은 카페" },
        category: {
          type: "STRING",
          enum: ["tourist", "cafe", "restaurant", "culture"],
          description: "선택. 관광명소 tourist / 카페 cafe / 음식점 restaurant / 문화시설 culture",
        },
        limit: { type: "NUMBER", description: "결과 개수 (1~10, 기본 5)" },
      },
      required: ["region"],
    },
  },
];

const handlers = { get_weather, find_spots };

module.exports = { declarations, handlers };
