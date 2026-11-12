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
    return { test: label, ms: Date.now() - t, error: e.name === "TimeoutError" ? "15초 안에 응답 없음" : e.message };
  }
}

async function gen(body) {
  const res = await fetch(`${BASE}/models/${MODEL}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, error: text.slice(0, 400) };
  const parts = JSON.parse(text).candidates?.[0]?.content?.parts || [];
  return {
    status: res.status,
    answer: parts.map((p) => p.text || (p.functionCall ? `functionCall:${p.functionCall.name}` : "")).join("").slice(0, 120),
  };
}

module.exports = async function handler(req, res) {
  const env = {
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    KAKAO_REST_API_KEY: !!process.env.KAKAO_REST_API_KEY,
    GEMINI_MODEL: MODEL,
    GEMINI_THINKING_LEVEL: LEVEL,
  };
  if (!env.GEMINI_API_KEY) return res.status(200).json({ env, note: "GEMINI_API_KEY 가 없습니다. 추가 후 재배포하세요." });

  const think = { generationConfig: { thinkingConfig: { thinkingLevel: LEVEL } } };
  const ask = { contents: [{ role: "user", parts: [{ text: "안녕이라고만 답해." }] }] };
  const tests = await Promise.all([
    timed("models 목록", async () => {
      const r = await fetch(`${BASE}/models?pageSize=200`, {
        signal: AbortSignal.timeout(15000),
        headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
      });
      const j = await r.json();
      if (!r.ok) return { status: r.status, error: JSON.stringify(j).slice(0, 300) };
      return {
        status: r.status,
        flashModels: (j.models || [])
          .filter((m) => /gemini/.test(m.name) && m.supportedGenerationMethods?.includes("generateContent"))
          .map((m) => m.name.replace("models/", "")),
      };
    }),
    timed("기본 호출(도구 없음, 추론 설정 없음)", () => gen(ask)),
    timed(`추론 ${LEVEL} 설정`, () => gen({ ...ask, ...think })),
    timed("도구 선언 포함 + 날씨 질문", () =>
      gen({
        contents: [{ role: "user", parts: [{ text: "속초 날씨 알려줘" }] }],
        tools: [{ functionDeclarations: declarations }],
        ...think,
      })
    ),
  ]);
  res.status(200).json({ env, tests });
};
