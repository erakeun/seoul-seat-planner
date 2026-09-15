# Hanyang Seoul Seat Planner

한양대학교 서울캠퍼스 신본관 회의실1 전용 좌석배치 제작기입니다. 기존 서울 Excel 배치도에서 확인한 상대 위치를 Room Template으로 분리하고, ERICA Seat Planner의 검증된 정적 웹앱 흐름을 재사용했습니다.

## 실행

별도 빌드 없이 `dist` 폴더를 정적 웹 서버로 제공합니다.

```bash
python3 -m http.server 4173 --directory dist
```

## 좌석 Template

- 상단 메인석 24석 (`SEOUL-UPPER-01` ~ `SEOUL-UPPER-24`)
- 하단 메인석 25석 (`SEOUL-LOWER-01` ~ `SEOUL-LOWER-25`)
- Excel에서 “배석”으로 명시된 상단 4석 (`SEOUL-STAFF-01` ~ `SEOUL-STAFF-04`)
- 총 53석
- Excel `P6:Q6` 병합·강조 위치를 넓은 강조석 후보로 표시하되, 의전상 상석으로 자동 판단하지 않음

좌측 무표기 사각형 3개와 하단 무표기 사각형 2개는 좌석 수에 포함하지 않고 `미확정` 설비로 표시합니다. 화면, 단상, PC, `내측` 표기는 Excel 상대 위치를 반영했습니다. 실제 방 치수와 문·창·가구 형상은 현장 자료 없이 확정하지 않습니다.

상세 근거는 [SEOUL_EXCEL_ANALYSIS.md](SEOUL_EXCEL_ANALYSIS.md)를 참조하세요.

## 주요 기능

- 행사 정보와 다기관 관리: 복수 주최기관·상대기관·기타 참여기관
- 참석자 직접 등록, UTF-8 BOM 예시 CSV, 편집 가능한 Preview와 검증
- 이번 신본관 회의실1 양식 전용 `.xlsx` Import
- 사용자가 입력한 기관 내 숫자 순위와 기관별 기준석을 이용한 자동배치 초안
- 기준석에서 화면 X좌표 기준 오른쪽·왼쪽 교차 확장
- 고정석 우선, 기관별 확장 충돌 경고, 적용 전 Preview, 전체 적용 1회 Undo
- Drag & Drop, 클릭 배정, 좌석 교환, LocalStorage, JSON/CSV Import/Export
- 출력 모드, PNG, 인쇄/PDF
- 기존 Nameplate Maker에 URL 개인정보 없이 origin-bound `postMessage`로 배정 명단 전달

## ERICA V2.1 Parity 안정화

- 손상되거나 지원하지 않는 저장 데이터는 원본을 보존하고 자동저장을 중지합니다. JSON 내보내기로 복구용 원본을 내려받을 수 있습니다.
- JSON 가져오기와 새 배치는 현재 원본을 `seoul-seat-planner:v1:before-replace`에 먼저 백업합니다. 가져오기 실패·취소는 확정 state를 변경하지 않습니다.
- 다른 탭에서 저장한 변경을 오래된 탭이 덮어쓰지 않도록 저장을 중지하고 새로고침을 안내합니다.
- 고정석은 수동 이동·교환·배정 해제 및 WebMCP 일괄 배정으로 변경할 수 없습니다. 참석자 수정에서 먼저 고정을 해제해야 합니다.
- 자동배치는 기존 수동 배정을 기본 유지하며, 명시적으로 재계산하더라도 고정석을 보존합니다. 모든 기관 기준석을 먼저 예약하고 좌석 부족·중복 기준석·중복 순위를 적용 불가로 처리합니다.
- 자동배치 Preview는 source snapshot을 보관하여 Preview 이후 행사가 바뀌면 다시 계산하도록 요구합니다.
- CSV는 일반 배정좌석과 보조 그룹도 왕복하며, 수식 시작 문자를 텍스트로 보호하고 닫히지 않은 인용부호·필드 길이·정원·좌석 충돌을 검증합니다.
- 명패 전달은 배정 참석자만 보내며 current Nameplate Maker의 명시적 수락·거절·이전 프로젝트 백업 흐름을 따릅니다. 30초 안에 수신 확인이 없으면 CSV fallback을 안내합니다.

상세 current-source 비교는 [GAP_ANALYSIS_ERICA_V2.md](GAP_ANALYSIS_ERICA_V2.md)를 참조하세요. PRIME 전용 Geometry·좌석 ID·현장 규칙은 이식하지 않았습니다.

## 기존 서울 Excel Import 지원 범위

첫 시트 `C1`에 `신본관 회의실1`이 포함된 이번 양식 계열만 받습니다. 메인석 `D6:AB6`(단 `P6:Q6` 병합)과 `D12:AB12`, 배석 표기 위치 `S3/U3/W3/Y3`를 고정 매핑합니다. 셀 첫 줄은 이름, 이후 줄은 직위로 읽고, 기관과 기관 내 순위는 Preview에서 사용자가 보완합니다. 범용 Excel parser로 추측하지 않으며 다른 양식은 표준 CSV 사용을 안내합니다.

## 개인정보

원본 Excel과 실명은 저장소에 포함하지 않습니다. 테스트 데이터는 가명만 사용합니다. 모든 행사 데이터는 브라우저 LocalStorage에 저장되며 별도 backend를 사용하지 않습니다. 교체 전 백업도 같은 브라우저 저장소에 가장 최근 1회만 남으므로 장기 보관에는 JSON 내보내기를 사용합니다.

## 테스트

```bash
node --test tests/*.test.mjs
```

브라우저 회귀 테스트는 `tests/browser-regression.mjs`를 실행합니다.

## 배포

GitHub Pages용 Actions workflow가 포함되어 있습니다. Pages Source를 GitHub Actions로 설정하면 `dist`가 배포됩니다.
