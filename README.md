# 전국 날씨 · 미세먼지 지도 + AI 여행 도우미

- 프론트엔드: 정적 HTML/JS + Leaflet 2D 지도 (Open-Meteo 날씨·대기질, 키 불필요)
- 에이전트: `api/agent.js` (Vercel 서버리스) → Gemini 함수 호출
  - `get_weather`: 실시간 날씨·미세먼지 (Open-Meteo)
  - `find_spots`: 장소 검색 (카카오 로컬 API)

## Vercel 환경변수
| 이름 | 설명 |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio API 키 (필수) |
| `KAKAO_REST_API_KEY` | 카카오 developers REST API 키 (find_spots 필수) |
| `GEMINI_MODEL` | 선택. 기본값 `gemini-3.8-flash` |
| `GEMINI_THINKING_LEVEL` | 선택. `minimal`/`low`(기본)/`medium`/`high`/`off` — 낮을수록 빠름 |

키는 서버 함수에서만 사용되며 브라우저로 노출되지 않습니다. 환경변수를 추가/변경한 뒤에는 재배포해야 적용됩니다.
