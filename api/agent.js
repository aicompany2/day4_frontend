// Vercel 서버리스 함수: Gemini 함수 호출(tool calling) 에이전트
const { declarations, handlers } = require("./_tools");

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_STEPS = 6; // 도구 호출 왕복 상한
const MAX_MESSAGES = 20;
const MAX_CHARS = 2000;

const SYSTEM = `너는 한국 여행·나들이 추천 도우미다. 한국어로, 짧고 친근하게 답한다.
규칙:
- 장소를 추천하기 전에 get_weather 로 해당 지역의 실시간 날씨와 미세먼지를 확인한다.
- 장소는 반드시 find_spots 결과에서만 고른다. 도구 결과에 없는 장소 이름·주소를 지어내지 않는다.
- 비·눈이 오거나 강수확률이 높거나 미세먼지가 '나쁨' 이상이면 실내 장소를, 맑고 쾌적하면 야외 장소를 우선 추천하고 이유를 한 줄로 설명한다.
- 추천은 보통 3곳 안팎, 각각 이름과 한 줄 이유를 적는다. 지역이 불분명하면 되묻는다.
- 도구가 오류를 돌려주면 그 사실을 솔직히 알리고 가능한 범위에서 답한다.`;

async function callGemini(contents) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents,
        tools: [{ functionDeclarations: declarations }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini 오류 ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

const summarize = (r) =>
  r.error ? `오류: ${r.error}` : r.spots ? `${r.count}곳 검색됨` : `${r.location}: ${r.condition} ${r.temperature_c}°C`;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST 만 지원합니다." });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다." });
  }

  const msgs = req.body?.messages;
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > MAX_MESSAGES) {
    return res.status(400).json({ error: "messages 는 1~20개의 배열이어야 합니다." });
  }
  const contents = [];
  for (const m of msgs) {
    if ((m.role !== "user" && m.role !== "model") || typeof m.text !== "string" || !m.text.trim()) {
      return res.status(400).json({ error: "각 메시지는 role(user|model)과 text 가 필요합니다." });
    }
    contents.push({ role: m.role, parts: [{ text: m.text.slice(0, MAX_CHARS) }] });
  }
  if (contents[contents.length - 1].role !== "user") {
    return res.status(400).json({ error: "마지막 메시지는 user 여야 합니다." });
  }

  const steps = []; // 화면에 보여 줄 도구 호출 기록
  const spots = [];
  const weather = [];
  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      const data = await callGemini(contents);
      const content = data.candidates?.[0]?.content;
      if (!content?.parts?.length) {
        const why = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || "빈 응답";
        throw new Error(`Gemini 가 답을 만들지 못했습니다 (${why})`);
      }
      const calls = content.parts.filter((p) => p.functionCall);
      if (!calls.length) {
        const reply = content.parts.map((p) => p.text || "").join("").trim();
        return res.status(200).json({ reply, steps, spots, weather });
      }

      contents.push(content); // 모델 응답(함수 호출 포함)을 그대로 이어 붙인다
      const responses = [];
      for (const { functionCall: fc } of calls) {
        let result;
        try {
          const fn = handlers[fc.name];
          if (!fn) throw new Error(`알 수 없는 도구: ${fc.name}`);
          result = await fn(fc.args || {});
          if (fc.name === "find_spots") spots.push(...result.spots);
          if (fc.name === "get_weather") weather.push(result);
        } catch (e) {
          result = { error: e.message };
        }
        steps.push({ tool: fc.name, args: fc.args || {}, summary: summarize(result) });
        responses.push({ functionResponse: { name: fc.name, response: { result } } });
      }
      contents.push({ role: "user", parts: responses });
    }
    return res.status(200).json({
      reply: "도구 호출이 너무 많아 답을 마무리하지 못했습니다. 질문을 조금 더 구체적으로 해 주세요.",
      steps, spots, weather,
    });
  } catch (e) {
    return res.status(502).json({ error: e.message, steps });
  }
};
