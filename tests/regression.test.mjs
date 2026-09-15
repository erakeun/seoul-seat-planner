import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const app = readFileSync(new URL("../dist/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const templateSource = readFileSync(new URL("../dist/room-template.js", import.meta.url), "utf8");

const templateContext = { window: {} };
vm.createContext(templateContext);
vm.runInContext(templateSource, templateContext);
const roomTemplate = templateContext.window.SEOUL_ROOM_TEMPLATE;

function declaration(name) {
  const match = app.match(new RegExp(`  function ${name}\\([^]*?(?=\\n  function |\\n  async function )`));
  assert.ok(match, `${name} declaration should exist`);
  return match[0];
}

test("서울 회의실 Template 좌석 수와 Excel 셀 대응이 고정되어 있다", () => {
  assert.equal(roomTemplate.id, "seoul-new-building-meeting-room-1");
  assert.equal(roomTemplate.seats.length, 53);
  assert.deepEqual(JSON.parse(JSON.stringify(roomTemplate.capacity)), {
    mainUpper: 24,
    mainLower: 25,
    staff: 4,
    total: 53,
  });
  assert.equal(new Set(roomTemplate.seats.map((seat) => seat.id)).size, 53);
  assert.equal(new Set(roomTemplate.seats.map((seat) => seat.sourceCell)).size, 53);
  assert.equal(roomTemplate.excelImport.topCells.length, 24);
  assert.equal(roomTemplate.excelImport.lowerCells.length, 25);
  assert.equal(roomTemplate.excelImport.staffCells.length, 4);
  const highlighted = roomTemplate.seats.find((seat) => seat.priorityCandidate);
  assert.equal(highlighted.sourceCell, "P6");
  assert.equal(highlighted.sourceSpan, 2);
});

test("서울판은 별도 저장 키와 정적 Room Template을 사용한다", () => {
  assert.match(app, /const STORAGE_KEY = "seoul-seat-planner:v1"/);
  assert.match(app, /const roomTemplate = window\.SEOUL_ROOM_TEMPLATE/);
  assert.match(html, /\.\/room-template\.js/);
  assert.match(html, /Hanyang Seoul Seat Planner/);
});

test("기관 기준석 확장은 기준석 다음 오른쪽, 왼쪽 순서다", () => {
  const context = { roomTemplate };
  vm.createContext(context);
  vm.runInContext(`${declaration("alternatingSeats")}\nthis.alternatingSeats = alternatingSeats;`, context);
  const reference = roomTemplate.seats.find((seat) => seat.id === "SEOUL-UPPER-13");
  const ordered = JSON.parse(JSON.stringify(context.alternatingSeats(reference).slice(0, 5).map((seat) => seat.sourceCell)));
  assert.deepEqual(ordered, ["P6", "R6", "O6", "S6", "N6"]);
});

test("CSV 파서는 따옴표 쉼표와 이중 따옴표를 처리한다", () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${declaration("parseCsv")}\nthis.parseCsv = parseCsv;`, context);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.parseCsv('이름,비고\r\n"가,온","말 ""인용"""\r\n'))),
    [["이름", "비고"], ["가,온", '말 "인용"']],
  );
});

test("서울 기존 양식 Excel Import는 양식 식별과 고정 좌석 Preview를 사용한다", () => {
  assert.match(html, /id="seoul-xlsx-file-input"/);
  assert.match(html, /서울 기존 양식 Excel 불러오기/);
  const importer = declaration("importSeoulXlsx");
  assert.match(importer, /title\.includes\(roomTemplate\.excelImport\.titleIncludes\)/);
  assert.match(importer, /bulkPreviewRows = roomTemplate\.seats/);
  assert.match(app, /fixedSeat: seat\.id/);
  assert.match(app, /서울 기존 양식 \$\{sheetName\}!\$\{seat\.sourceCell\}/);
});

test("자동배치는 중복 순위·기준석·좌석 부족을 적용 불가로 표시한다", () => {
  const draft = declaration("calculateAutoDraft");
  assert.match(draft, /기관 내 순위 중복/);
  assert.match(draft, /기관 기준 좌석이 중복/);
  assert.match(draft, /같은 장변 좌석이 부족/);
  assert.match(draft, /claimedReferences\.has\(candidate\.id\)/);
  assert.match(app, /autoDraft\.sourceSnapshot = snapshot\(\)/);
});

test("명패 전달은 배정된 참석자만 origin-bound postMessage로 전송한다", () => {
  const handoff = declaration("openNameplateMaker");
  assert.match(handoff, /roomTemplate\.seats/);
  assert.match(handoff, /state\.assignments\[seat\.id\]/);
  assert.match(handoff, /postMessage\(payload, targetOrigin\)/);
  assert.match(handoff, /transferId: crypto\.randomUUID\(\)/);
  assert.match(handoff, /event\.origin === targetOrigin/);
  assert.match(handoff, /event\.source === child/);
  assert.match(handoff, /nameplates:accepted/);
  assert.match(handoff, /nameplates:rejected/);
  assert.match(handoff, /event\.data\.transferId === payload\.transferId/);
  assert.doesNotMatch(handoff, /URLSearchParams|location\.search|encodeURIComponent\(.*people/);
});

test("Excel 원본 바이너리와 운영 명단 seed는 저장소에 포함되지 않는다", () => {
  const files = readdirSync(new URL("..", import.meta.url), { recursive: true }).map(String);
  assert.equal(files.some((file) => /\.xls(x)?$/i.test(file)), false);
  assert.doesNotMatch([html, app, templateSource].join("\n"), /data:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet;base64/i);
  assert.doesNotMatch(app, /const\s+(sample|seed|production)Attendees\s*=/i);
});
