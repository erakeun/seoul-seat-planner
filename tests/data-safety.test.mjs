import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../dist/app.js", import.meta.url), "utf8");
const templateSource = readFileSync(new URL("../dist/room-template.js", import.meta.url), "utf8");
const templateContext = { window: {} };
vm.createContext(templateContext);
vm.runInContext(templateSource, templateContext);
const roomTemplate = templateContext.window.SEOUL_ROOM_TEMPLATE;
const copy = (value) => JSON.parse(JSON.stringify(value));

function element() {
  return {
    value: "", checked: false, disabled: false, dataset: {}, style: {}, children: [], innerHTML: "", textContent: "",
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, addEventListener() {}, append(...values) { this.children.push(...values); },
    replaceChildren(...values) { this.children = values; }, querySelector() { return element(); }, querySelectorAll() { return []; },
    close() {}, showModal() {}, remove() {},
  };
}

function setup(saved = null) {
  const nodes = new Map();
  const cards = [];
  const store = new Map(saved === null ? [] : [["seoul-seat-planner:v1", saved]]);
  const downloads = [];
  const get = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  const windowObject = { SEOUL_ROOM_TEMPLATE: roomTemplate, confirm: () => true, addEventListener() {} };
  const context = {
    crypto: { randomUUID: () => `test-${Math.random()}` }, setTimeout: () => 1, clearTimeout() {}, Blob,
    window: windowObject,
    document: {
      querySelector: get,
      querySelectorAll: (selector) => selector.includes("reference-card") ? cards : [],
      createElement: element,
      createElementNS: element,
    },
    localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    FileReader: class { readAsText(file) { this.result = file; this.onload(); } },
  };
  vm.createContext(context);
  vm.runInContext(source.replace("  init();", `
    renderAll = () => {};
    renderAutoDraft = () => {};
    syncEventInputs = () => {};
    downloadBlob = (blob, name) => globalThis.downloads.push({ blob, name });
    globalThis.api = {
      defaultState, sanitizeState, validateStateDocument, scheduleSave, applyMode, importJson, calculateAutoDraft,
      applyAutoDraft, restore, assignAttendee, unassignAttendee, renderAttendees, exportCsv, parseCsv,
      normalizeBulkRows, validateBulkRows, registerBulkRows, roomTemplate, suggestedReferenceMap,
      get state() { return state; }, set state(value) { state = value; }, get draft() { return autoDraft; },
      get undo() { return undoStack; }, set bulk(value) { bulkPreviewRows = value; },
    };
  `), context);
  context.downloads = downloads;
  return {
    api: context.api, get, store, downloads, context,
    refs(values) {
      cards.splice(0, cards.length, ...Object.entries(values).map(([id, value]) => ({ dataset: { institutionId: id }, querySelector: () => ({ value }) })));
    },
  };
}

const person = (id, institutionId = "A", rank = 1, extra = {}) => ({
  id, name: `가상-${id}`, org: "가상기관", title: "", type: "외부", group: institutionId, note: "",
  institutionId, institutionRank: rank, fixedSeatId: "", seatLocked: false, ...extra,
});
const institution = (id, displayOrder = 1, role = "other") => ({ id, name: id, role, displayOrder, referenceSeatId: "", note: "" });

function scenario(people, assignments = {}, refs = { A: "SEOUL-UPPER-13" }, institutions = [institution("A")]) {
  const harness = setup();
  harness.api.state = harness.api.sanitizeState({ ...harness.api.defaultState(), attendees: people, institutions, assignments });
  harness.refs(refs);
  harness.get("#auto-fill-staff").checked = true;
  harness.get("#auto-replace-existing").checked = false;
  return harness;
}

test("서울 Geometry는 24+25+4 총 53석과 고유 ID를 유지한다", () => {
  const template = setup().api.roomTemplate;
  assert.equal(template.seats.length, 53);
  assert.equal(new Set(template.seats.map((seat) => seat.id)).size, 53);
  assert.equal(template.seats.filter((seat) => seat.section === "main-left").length, 24);
  assert.equal(template.seats.filter((seat) => seat.section === "main-right").length, 25);
  assert.equal(template.seats.filter((seat) => seat.section === "staff").length, 4);
  assert.ok(template.seats.every((seat) => /^SEOUL-(UPPER|LOWER|STAFF)-/.test(seat.id)));
});

test("구버전 서울 V1은 기관·일부 설정 필드가 없어도 복원된다", () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    roomTemplateId: "seoul-new-building-meeting-room-1",
    event: { title: "가상 행사", date: "", organizations: "", location: "가상 장소", note: "" },
    attendees: [person("legacy", "", null)],
    assignments: { "SEOUL-UPPER-01": "legacy" },
  });
  const harness = setup(raw);
  assert.equal(harness.api.state.attendees.length, 1);
  assert.equal(harness.api.state.assignments["SEOUL-UPPER-01"], "legacy");
  assert.deepEqual(copy(harness.api.state.institutions), []);
});

test("구버전의 긴 텍스트는 새로고침에서 조용히 잘리지 않는다", () => {
  const harness = setup();
  const incoming = { ...harness.api.defaultState(), attendees: [person("long", "", null, { name: "가".repeat(100), org: "나".repeat(150) })] };
  harness.api.validateStateDocument(incoming);
  assert.equal(harness.api.sanitizeState(incoming).attendees[0].name.length, 100);
  assert.equal(harness.api.sanitizeState(incoming).attendees[0].org.length, 150);
});

for (const raw of ["{broken", JSON.stringify({ schemaVersion: 99, attendees: [], assignments: {} })]) {
  test(`손상·미지원 저장 원본을 덮어쓰지 않는다: ${raw.slice(0, 12)}`, () => {
    const harness = setup(raw);
    harness.api.applyMode();
    assert.equal(harness.store.get("seoul-seat-planner:v1"), raw);
  });
}

test("잘못된 JSON Import는 상태를 부분 변경하지 않는다", () => {
  const harness = scenario([person("a")]);
  const before = JSON.stringify(harness.api.state);
  const invalidDocuments = [
    { schemaVersion: 99, attendees: [], assignments: {} },
    { schemaVersion: 1, attendees: [], assignments: null },
    { schemaVersion: 1, attendees: [person("a"), person("a")], assignments: {} },
    { schemaVersion: 1, attendees: Array.from({ length: 54 }, (_, index) => person(`overflow-${index}`, "", null)), assignments: {} },
    { schemaVersion: 1, attendees: Array.from({ length: 5 }, (_, index) => person(`staff-${index}`, "", null, { type: "배석" })), assignments: {} },
    { schemaVersion: 1, attendees: [], assignments: {}, event: { title: { bad: true } } },
    { schemaVersion: 1, roomTemplateId: "erica-prime", attendees: [], assignments: {} },
  ];
  for (const invalid of invalidDocuments) {
    harness.api.importJson(JSON.stringify(invalid));
    assert.equal(JSON.stringify(harness.api.state), before);
  }
});

test("JSON Import 취소는 원본 유지, 성공은 백업 후 Undo 가능", () => {
  const harness = scenario([person("a")]);
  harness.api.scheduleSave();
  const before = JSON.stringify(harness.api.state);
  const incoming = JSON.stringify({ ...harness.api.defaultState(), attendees: [person("b")] });
  harness.context.window.confirm = () => false;
  harness.api.importJson(incoming);
  assert.equal(JSON.stringify(harness.api.state), before);
  harness.context.window.confirm = () => true;
  harness.api.importJson(incoming);
  assert.equal(harness.store.get("seoul-seat-planner:v1:before-replace"), before);
  harness.api.restore(harness.api.undo.pop());
  assert.equal(JSON.stringify(harness.api.state), before);
});

test("다른 탭의 최신 저장값을 오래된 탭이 덮어쓰지 않는다", () => {
  const harness = scenario([person("a")]);
  harness.api.scheduleSave();
  harness.store.set("seoul-seat-planner:v1", "external-newer");
  harness.api.assignAttendee("a", "SEOUL-UPPER-01");
  assert.equal(harness.store.get("seoul-seat-planner:v1"), "external-newer");
  assert.deepEqual(copy(harness.api.state.assignments), {});
});

test("참석자 ID는 HTML 속성에 삽입되기 전에 escape된다", () => {
  const harness = scenario([person('\"><img src=x onerror=alert(1)>')]);
  harness.api.renderAttendees();
  const markup = harness.get("#attendee-list").children[0].innerHTML;
  assert.ok(markup.includes("&lt;img"));
  assert.ok(!markup.includes("<img"));
});

test("고정 참석자는 이동·밀어내기·배정 해제가 불가능하다", () => {
  const harness = scenario(
    [person("a", "A", 1, { seatLocked: true, fixedSeatId: "SEOUL-UPPER-13" }), person("b")],
    { "SEOUL-UPPER-13": "a" },
  );
  harness.api.assignAttendee("b", "SEOUL-UPPER-13");
  harness.api.assignAttendee("a", "SEOUL-UPPER-14");
  harness.api.unassignAttendee("a");
  assert.deepEqual(copy(harness.api.state.assignments), { "SEOUL-UPPER-13": "a" });
});

test("일반 좌석 교환은 저장되고 Undo로 원복된다", () => {
  const harness = scenario([person("a"), person("b")], { "SEOUL-UPPER-01": "a", "SEOUL-LOWER-01": "b" });
  const before = copy(harness.api.state);
  harness.api.assignAttendee("a", "SEOUL-LOWER-01");
  assert.equal(harness.api.state.assignments["SEOUL-UPPER-01"], "b");
  assert.equal(JSON.parse(harness.store.get("seoul-seat-planner:v1")).assignments["SEOUL-LOWER-01"], "a");
  harness.api.restore(harness.api.undo.pop());
  assert.deepEqual(copy(harness.api.state), before);
});

test("기관 기준석의 고정 대표를 유지하며 다음 순위를 오른쪽부터 배치한다", () => {
  const harness = scenario(
    [person("a", "A", 1, { seatLocked: true, fixedSeatId: "SEOUL-UPPER-13" }), person("b", "A", 2)],
    { "SEOUL-UPPER-13": "a" },
  );
  harness.api.calculateAutoDraft();
  assert.equal(harness.api.draft.errors.length, 0);
  assert.equal(harness.api.draft.assignments["SEOUL-UPPER-14"], "b");
});

test("모든 기관 기준석을 확장 전에 예약한다", () => {
  const harness = scenario(
    [person("a1"), person("a2", "A", 2), person("a3", "A", 3), person("b", "B", 1)],
    {}, { A: "SEOUL-UPPER-13", B: "SEOUL-UPPER-14" },
    [institution("A"), institution("B", 2)],
  );
  harness.api.calculateAutoDraft();
  assert.equal(harness.api.draft.errors.length, 0);
  assert.equal(harness.api.draft.assignments["SEOUL-UPPER-14"], "b");
});

test("기존 수동 배정은 기본 자동배치에서 유지된다", () => {
  const harness = scenario([person("a")], { "SEOUL-UPPER-03": "a" });
  harness.api.calculateAutoDraft();
  assert.equal(harness.api.draft.assignments["SEOUL-UPPER-03"], "a");
  assert.ok(harness.api.draft.rows.some((row) => row.status === "유지"));
});

test("좌석 부족은 적용을 차단하고 기존 state를 유지한다", () => {
  const harness = scenario(Array.from({ length: 25 }, (_, index) => person(`p${index}`, "A", index + 1)));
  const before = copy(harness.api.state);
  harness.api.calculateAutoDraft();
  assert.ok(harness.api.draft.errors.length);
  harness.api.applyAutoDraft();
  assert.deepEqual(copy(harness.api.state), before);
});

test("Preview는 비파괴이고 적용/Undo 및 stale preview 방지가 동작한다", () => {
  const harness = scenario([person("a"), person("b", "A", 2)]);
  const before = copy(harness.api.state);
  harness.api.calculateAutoDraft();
  assert.deepEqual(copy(harness.api.state), before);
  harness.api.applyAutoDraft();
  assert.equal(Object.keys(harness.api.state.assignments).length, 2);
  harness.api.restore(harness.api.undo.pop());
  assert.deepEqual(copy(harness.api.state), before);
  harness.api.calculateAutoDraft();
  harness.api.state.event.note = "changed after preview";
  harness.api.applyAutoDraft();
  assert.equal(Object.keys(harness.api.state.assignments).length, 0);
});

test("중복 순위와 중복 기준석은 자동배치 적용을 차단한다", () => {
  const duplicateRank = scenario([person("a1", "A", 1), person("a2", "A", 1)]);
  duplicateRank.api.calculateAutoDraft();
  assert.ok(duplicateRank.api.draft.errors.some((message) => message.includes("순위 중복")));

  const duplicateReference = scenario(
    [person("a", "A", 1), person("b", "B", 1)], {},
    { A: "SEOUL-UPPER-13", B: "SEOUL-UPPER-13" },
    [institution("A"), institution("B", 2)],
  );
  duplicateReference.api.calculateAutoDraft();
  assert.ok(duplicateReference.api.draft.errors.some((message) => message.includes("기준 좌석이 중복")));
});

for (const [section, pivots] of [["UPPER", [1, 13, 24]], ["LOWER", [1, 13, 25]]]) {
  for (const pivot of pivots) {
    test(`${section} ${pivot}번 기준석의 홀수·짝수 확장이 좌석을 중복하지 않는다`, () => {
      for (const count of [3, 4]) {
        const harness = scenario(
          Array.from({ length: count }, (_, index) => person(`p${index}`, "A", index + 1)), {},
          { A: `SEOUL-${section}-${String(pivot).padStart(2, "0")}` },
        );
        harness.api.calculateAutoDraft();
        assert.equal(harness.api.draft.errors.length, 0);
        assert.equal(Object.keys(harness.api.draft.assignments).length, count);
        assert.equal(new Set(Object.values(harness.api.draft.assignments)).size, count);
      }
    });
  }
}

for (const count of [1, 2, 3, 6, 10]) {
  test(`${count}기관·공동주최·복수 상대기관에서도 중복 배정이 없다`, () => {
    const institutions = Array.from({ length: count }, (_, index) => institution(`I${index}`, index + 1, index % 4 === 0 ? "host" : index % 3 === 0 ? "other" : "counterparty"));
    const harness = scenario(
      institutions.flatMap((item) => [1, 2].map((rank) => person(`${item.id}-${rank}`, item.id, rank))),
      {}, Object.fromEntries(setup().api.suggestedReferenceMap(institutions)), institutions,
    );
    harness.api.calculateAutoDraft();
    assert.equal(harness.api.draft.errors.length, 0);
    assert.equal(Object.keys(harness.api.draft.assignments).length, count * 2);
    assert.equal(new Set(Object.values(harness.api.draft.assignments)).size, count * 2);
  });
}

test("기관 미정 참석자는 오류 없이 미배정 경고로 남는다", () => {
  const harness = scenario([person("unlinked", "", null)], {}, {}, []);
  harness.api.calculateAutoDraft();
  assert.equal(harness.api.draft.errors.length, 0);
  assert.ok(harness.api.draft.warnings.some((message) => message.includes("unlinked")));
});

test("CSV는 닫히지 않은 인용부호를 거부하고 일반 배정·그룹·수식 문자를 안전하게 왕복한다", async () => {
  const harness = scenario([person("a", "A", 1, { name: "=1+1", group: "대표단 A" })], { "SEOUL-UPPER-03": "a" });
  assert.throws(() => harness.api.parseCsv('이름\na,"broken'));
  harness.api.exportCsv();
  const csv = await harness.downloads[0].blob.text();
  assert.ok(csv.includes("배정좌석"));
  assert.ok(csv.includes("SEOUL-UPPER-03"));
  assert.ok(csv.includes("'=1+1"));
  const rows = harness.api.normalizeBulkRows(harness.api.parseCsv(csv));
  assert.equal(rows[0].assignedSeat, "SEOUL-UPPER-03");
  assert.equal(rows[0].fixedSeat, "");
  assert.equal(rows[0].legacyGroup, "대표단 A");
});

test("CSV 검증은 이름·순위·seat ID·고정석 중복·정원 초과를 차단한다", () => {
  const harness = scenario(Array.from({ length: 52 }, (_, index) => person(`existing-${index}`, "", null)), {}, {}, []);
  harness.api.bulk = [
    { name: "", org: "", title: "", institution: "", role: "", rank: "0", fixedSeat: "NO-SEAT", type: "기타", note: "", assignedSeat: "" },
    { name: "가상중복1", org: "", title: "", institution: "", role: "", rank: "", fixedSeat: "SEOUL-UPPER-01", type: "기타", note: "", assignedSeat: "" },
    { name: "가상중복2", org: "", title: "", institution: "", role: "", rank: "", fixedSeat: "SEOUL-UPPER-01", type: "기타", note: "", assignedSeat: "" },
  ];
  const issues = harness.api.validateBulkRows();
  assert.ok(issues.errors.some((message) => message.includes("이름 누락")));
  assert.ok(issues.errors.some((message) => message.includes("순위 오류")));
  assert.ok(issues.errors.some((message) => message.includes("유효하지 않은 좌석")));
  assert.ok(issues.errors.some((message) => message.includes("좌석 중복")));
  assert.ok(issues.errors.some((message) => message.includes("53명을 초과")));
});
