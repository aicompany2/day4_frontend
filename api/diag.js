// 진단용: /api/diag 를 브라우저로 열면 환경변수 설정 여부, Gemini 응답 시간, 사용 가능한 모델을 보여 준다.
// 키 값은 절대 출력하지 않는다. 원인 파악이 끝나면 이 파일은 지워도 된다.
const { declarations } = require("./_tools");

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const LEVEL = process.env.GEMINI_THINKING_LEVEL || "low";

async function timed(label, fn) {
  const t = Date.now();
  try {
    const r = await fn();
    return { test: label, ms: Date.now() - t, ...r };
  } catch (e) {
    return { test: label, ms: Date.now() - t, error: e.name === "TimeoutError" ? "12초 안에 응답 없음" : e.message };
  }
}

async function gen(body, model = MODEL, ms = 12000) {
  const res = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(ms),
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, error: text.slice(0, 200) };
  const parts = JSON.parse(text).candidates?.[0]?.content?.parts || [];
  return {
    status: res.status,
    answer: parts.map((p) => p.text || (p.functionCall ? `functionCall:${p.functionCall.name}(${JSON.stringify(p.functionCall.args)})` : "")).join("").slice(0, 120),
  };
}

// 어떤 모델이 빠르고 도구 호출까지 되는지 비교할 후보
const CANDIDATES = [
  "gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-flash-latest",
  "gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.7-flash",
  "gemini-2.5-flash-lite", "gemini-3-flash-preview", "gemini-3.8-flash",
];

module.exports = async function handler(req, res) {
  const env = {
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    KAKAO_REST_API_KEY: !!process.env.KAKAO_REST_API_KEY,
    GEMINI_MODEL: MODEL,
    GEMINI_THINKING_LEVEL: LEVEL,
  };
  if (!env.GEMINI_API_KEY) return res.status(200).json({ env, note: "GEMINI_API_KEY 가 없습니다. 추가 후 재배포하세요." });

  // 모델마다: 도구 선언을 포함한 실제 질문을 동시에 보내고 응답 시간을 잰다 (추론 설정은 보내지 않음)
  const body = {
    contents: [{ role: "user", parts: [{ text: "속초 날씨 알려줘" }] }],
    tools: [{ functionDeclarations: declarations }],
  };
  const tests = await Promise.all(CANDIDATES.map((m) => timed(m, () => gen(body, m))));
  tests.sort((x, y) => (x.error ? 1 : 0) - (y.error ? 1 : 0) || x.ms - y.ms);
  res.status(200).json({ env, tests });
};
