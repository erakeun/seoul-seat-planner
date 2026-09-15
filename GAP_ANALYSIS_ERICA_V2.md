# ERICA V2 ↔ 서울 V1 Current Gap Analysis

조사 기준: 2026-09-15 현재 `main`과 Production 파일의 SHA-256 일치 확인.

- 서울 `main`: `1ba10cb5f5e08a1af1e067417cd6e6911a1f78b4`
- ERICA `main` (Golden Reference): `7e68c9d9551e1ca735e2c524f953de0afd9198bc`
- Nameplate Maker `main`: `93529c71f59110fea464b6c932b9450972446f29`

| 기능 | ERICA current | 서울 current | 차이 | 서울 적용 필요 | 적용 방식 |
|---|---|---|---|---|---|
| 참석자 모달/CRUD | 추가·수정·삭제, 저장 시 검증, 모든 닫기 경로 | 기본 기능 보유 | 정원·길이 보호와 출력모드 키보드 차단 부족 | 필요 | 서울 정원 53명/배석 4명 한도와 필드 길이 검증, 기존 모달 종료 동작 회귀검증 |
| 기관 관리 | 복수 역할·순서·기준석, 삭제 시 관계 해제 확인 | 동일 데이터 모델 | 기관 삭제 시 즉시 관계 해제 | 필요 | 참석자·소속·배정은 유지한다는 확인 후 관계만 해제 |
| 공동주최/복수 상대/기타/미정 | 역할 배열 기반 | 역할 배열 기반 | 기능은 있으나 10기관/공동주최 회귀 부족 | 필요 | Geometry 비의존 fixture와 브라우저 테스트 확대 |
| CSV Preview/표 편집 | BOM, 편집, 길이·좌석·정원 검증, 배정좌석/그룹 왕복 | BOM, 편집, 기본 검증 | 닫히지 않은 인용부호, 길이, 일반 배정좌석 왕복, 수식 보호 부족 | 필요 | ERICA 공통 검증 포팅, 서울 seat ID/배석 용어로 적용 |
| 기관 내 순위 | 숫자 순위 | 숫자 순위 | 경고·대규모 회귀 부족 | 필요 | 기관 있으나 순위 없는 참석자 경고, 중복 순위 적용 차단 |
| 기관별 기준석 | 실제 좌표 기반 선택 | 서울 상·하단 좌석 기반 선택 | 기본 구현됨 | 유지/보강 | 중복 기준석 선예약, 타기관 확장 침범 차단 |
| 자동배치 | 고정/기존 배정 유지, 재계산 선택, source snapshot | 고정석 우선이나 기존 자동대상 재배치, snapshot 검증 없음 | 초안 후 state 변경과 좌석 부족 보호 부족 | 필요 | 서울 기준석→오른쪽→왼쪽 유지, 기존 배정 유지 기본, 비파괴 snapshot 검증 |
| 고정석 | 이동·교환·해제 방지 | 수동 이동 시 고정석도 이동 가능 | 데이터 불일치 위험 | 필요 | 클릭·Drag·WebMCP 모두 고정석 이동 차단 |
| Preview/Undo/Redo | 적용 전 state 불변, 적용 1회 Undo | 기본 구현 | stale preview 검증 부족 | 필요 | source snapshot 일치 확인 후 적용 |
| 저장 원본 보호 | 손상 원본 보존, 자동저장 중지, 탭 경합 차단 | parse 실패 시 빈 state를 자동저장할 수 있음 | 원본 유실 위험 | 필수 | strict validation, storage guard, 복구 원본 내보내기, storage event 감지 |
| Import rollback | JSON 교체 확인·백업·사전검증 | 즉시 교체 | 취소/실패 rollback·백업 부족 | 필수 | 완전 검증→확인→백업→단일 교체, 실패 시 state 불변 |
| 구버전 JSON | schema v1·기존 키 유지, 선택 필드 기본값 보완 | schema v1·기존 키 유지 | 잘못된 문서와 구버전 누락 필드 구분 미흡 | 필요 | 필수 구조만 엄격 검증, 선택 필드는 migration/sanitize |
| LocalStorage | 구버전 키 유지, corrupt/multi-tab 보호 | 동일 키 사용 | 보호 계층 부족 | 필수 | `seoul-seat-planner:v1` 유지, `:before-replace` 최신 1회 백업 |
| 서울 Excel Import | 없음 | 전용 SheetJS Preview·셀 매핑·고정석 | 서울 고유 기능 | 반드시 유지 | CSV 보강과 분리된 import context 유지, 실제 파일 회귀검증 |
| 명패 연동 | 수신 수락/거절, 30초 재시도, 실패 fallback | 배정 참석자만 전달, 짧은 재시도, 수락만 처리 | current Nameplate 안전 확인/백업 UX와 불일치 | 필수 | 배정 참석자만 유지, 수락·거절 처리, `_blank`, 30초 재시도, CSV fallback 안내 |
| Nameplate 수신/백업 | Production에서 payload 검증·명시적 수락·이전 프로젝트 백업 | 수신측 공용 | 수정 불필요 | 불필요 | Nameplate Maker는 READ ONLY 유지, current Production과 통합 테스트 |
| PNG/PDF/Print | 긴 제목/meta 최대폭, 인쇄 모드 | 기본 출력 | 긴 제목 clipping 위험 | 필요 | Canvas `maxWidth`, 53석·한글·긴 텍스트 브라우저/PDF 회귀 |
| 모바일 | 반응형 | 반응형 | 공통 회귀 범위 부족 | 필요 | 390×844, 412×915 및 데스크톱 2종 검증 |
| postMessage origin | 고정 origin·opener·payload/transfer 검증 | 송신 origin 고정·ack 검증 | reject/timeout UX 부족 | 필요 | current 수신 프로토콜에 맞춘 ack/reject/timeout 처리 |

## 이식하지 않는 ERICA 전용 요소

`MAIN-L/R`, `HEAD-01`, `STAFF-01~14`, PRIME 63석/모니터 49대, 수행원 7×2, PRIME ㄷ자 Geometry, 현장 문·창·스크린·복도 및 `MAIN-R-11~14` 관행은 서울에 이식하지 않는다.

서울 Source of Truth는 `SEOUL-UPPER-01~24`, `SEOUL-LOWER-01~25`, `SEOUL-STAFF-01~04`, 총 53석과 기존 Excel `sourceCell` 매핑이다.
