import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoDir, "dist");
const artifactsDir = process.env.TEST_ARTIFACTS_DIR || path.resolve(repoDir, "../../work/browser-artifacts");
const nameplateDir = process.env.NAMEPLATE_DIR || "";
const legacyXlsxPath = process.env.LEGACY_XLSX_PATH || "";
const plannerPort = Number(process.env.PLANNER_PORT || 43173);
const nameplatePort = plannerPort + 1;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
};

function serveDirectory(root, port, fallbackHtml = "") {
  const server = createServer(async (request, response) => {
    try {
      if (fallbackHtml) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(fallbackHtml);
        return;
      }
      const urlPath = decodeURIComponent(new URL(request.url, `http://localhost:${port}`).pathname);
      const requested = urlPath === "/" ? "/index.html" : urlPath;
      const resolved = path.resolve(root, `.${requested}`);
      if (!resolved.startsWith(path.resolve(root))) throw new Error("unsafe path");
      const info = await stat(resolved);
      const filePath = info.isDirectory() ? path.join(resolved, "index.html") : resolved;
      response.writeHead(200, { "content-type": contentTypes[path.extname(filePath)] || "application/octet-stream" });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const mockNameplate = `<!doctype html><meta charset="utf-8"><title>Nameplate receiver</title><div id="status">대기</div><dialog id="transfer"><p id="seat-planner-transfer-summary"></p><button id="seat-planner-transfer-cancel">취소 · 기존 명단 유지</button><button id="seat-planner-transfer-accept">백업 후 가져오기</button></dialog><script>
let pending = null;
window.addEventListener("message", event => {
  const data = event.data;
  if (event.origin !== "http://localhost:${plannerPort}" || event.source !== window.opener || data?.type !== "erica-seat-planner:nameplates:v1" || data?.source !== "erica-seat-planner" || typeof data.transferId !== "string" || !Array.isArray(data.people) || !data.people.length || data.people.length > 53) return;
  if (pending) return;
  pending = { event, data };
  document.querySelector("#seat-planner-transfer-summary").textContent = "받을 명단 " + data.people.length + "명";
  document.querySelector("#transfer").showModal();
});
document.querySelector("#seat-planner-transfer-cancel").addEventListener("click", () => {
  pending.event.source.postMessage({ type: "erica-seat-planner:nameplates:rejected", transferId: pending.data.transferId, count: pending.data.people.length }, pending.event.origin);
  pending = null;
  document.querySelector("#transfer").close();
});
document.querySelector("#seat-planner-transfer-accept").addEventListener("click", () => {
  document.querySelector("#status").textContent = "좌석배치기에서 " + pending.data.people.length + "명의 명단을 받았습니다.";
  pending.event.source.postMessage({ type: "erica-seat-planner:nameplates:accepted", transferId: pending.data.transferId, count: pending.data.people.length }, pending.event.origin);
  pending = null;
  document.querySelector("#transfer").close();
});
</script>`;

function makeState(institutionCount) {
  const institutions = [];
  const attendees = [];
  const upperRefs = ["SEOUL-UPPER-04", "SEOUL-UPPER-13", "SEOUL-UPPER-22"];
  const lowerRefs = ["SEOUL-LOWER-04", "SEOUL-LOWER-13", "SEOUL-LOWER-22"];
  for (let index = 0; index < institutionCount; index += 1) {
    const id = `institution-${index + 1}`;
    institutions.push({
      id,
      name: `가명기관 ${index + 1}`,
      role: index === 0 || index === 2 ? "host" : index % 3 === 1 ? "counterparty" : "other",
      displayOrder: index + 1,
      referenceSeatId: index % 2 === 0 ? upperRefs[Math.floor(index / 2)] : lowerRefs[Math.floor(index / 2)],
      note: "",
    });
    for (let rank = 1; rank <= 2; rank += 1) {
      attendees.push({
        id: `attendee-${index + 1}-${rank}`,
        name: `가명 ${index + 1}-${rank}`,
        org: `가명기관 ${index + 1}`,
        title: rank === 1 ? "대표" : "위원",
        type: "주요 참석자",
        group: `가명기관 ${index + 1}`,
        note: "",
        institutionId: id,
        institutionRank: rank,
        fixedSeatId: "",
        seatLocked: false,
      });
    }
  }
  return {
    schemaVersion: 1,
    roomTemplateId: "seoul-new-building-meeting-room-1",
    event: { title: "가명 행사", date: "", organizations: "", location: "신본관 회의실1", note: "" },
    institutions,
    attendees,
    assignments: {},
    settings: { showSeatNumbers: true, mode: "edit", includeHeadInAuto: false, autoFillStaff: true },
  };
}

async function loadState(page, state) {
  await page.evaluate((payload) => localStorage.setItem("seoul-seat-planner:v1", JSON.stringify(payload)), state);
  await page.reload({ waitUntil: "networkidle" });
}

async function applyAutoLayout(page, institutionCount) {
  await loadState(page, makeState(institutionCount));
  await page.click("#auto-layout-button");
  await page.waitForSelector("#auto-layout-dialog[open]");
  const errors = await page.locator("#auto-validation.has-error").count();
  assert.equal(errors, 0, `${institutionCount}개 기관 자동배치에 오류가 없어야 함`);
  assert.equal(await page.locator("#auto-preview-body tr").count(), institutionCount * 2);
  await page.click("#apply-auto-button");
  assert.equal(Number(await page.locator("#assigned-count").textContent()), institutionCount * 2);
}

async function createSyntheticXlsx(page) {
  return page.evaluate(() => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([]);
    sheet.C1 = { t: "s", v: "* 신본관 회의실1 가명회의의 좌석배치도" };
    sheet.N6 = { t: "s", v: "가온" };
    sheet.O6 = { t: "s", v: "나래" };
    sheet.P6 = { t: "s", v: "다온\n처장" };
    sheet.M12 = { t: "s", v: "라온" };
    sheet["!ref"] = "A1:AC19";
    sheet["!merges"] = [XLSX.utils.decode_range("P6:Q6")];
    XLSX.utils.book_append_sheet(workbook, sheet, "2024");
    const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    return Array.from(new Uint8Array(bytes));
  });
}

await mkdir(artifactsDir, { recursive: true });
const plannerServer = await serveDirectory(distDir, plannerPort);
const nameplateServer = nameplateDir
  ? await serveDirectory(nameplateDir, nameplatePort)
  : await serveDirectory("", nameplatePort, mockNameplate);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));

try {
  await page.goto(`http://localhost:${plannerPort}`, { waitUntil: "networkidle" });
  assert.equal(await page.locator("[data-seat-id]").count(), 53);
  assert.match(await page.locator("body").innerText(), /메인 49석 \+ 배석 4석 = 총 53석/);
  assert.equal(await page.locator("#nameplate-button").isDisabled(), true);
  assert.equal(await page.locator("#nameplate-action-help").textContent(), "배정된 참석자가 없습니다.");

  await page.click("#add-attendee-button");
  await page.click("#attendee-dialog .icon-button[data-close-dialog]");
  assert.equal(await page.locator("#attendee-dialog[open]").count(), 0);
  await page.click("#add-attendee-button");
  await page.click("#attendee-dialog .modal-actions [data-close-dialog]");
  assert.equal(await page.locator("#attendee-dialog[open]").count(), 0);
  await page.click("#add-attendee-button");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#attendee-dialog[open]").count(), 0);
  await page.click("#add-attendee-button");
  await page.mouse.click(5, 5);
  assert.equal(await page.locator("#attendee-dialog[open]").count(), 0);

  await page.click("#add-attendee-button");
  await page.fill("#attendee-name", "가명 직접등록");
  await page.fill("#attendee-org", "가명부서");
  await page.click("#save-attendee-button");
  assert.equal(Number(await page.locator("#total-count").textContent()), 1);
  await page.click(".attendee-item");
  await page.click('[data-seat-id="SEOUL-UPPER-01"]');
  assert.equal(Number(await page.locator("#assigned-count").textContent()), 1);
  assert.equal(await page.locator("#nameplate-button").isEnabled(), true);
  assert.equal(await page.locator("#nameplate-action-help").textContent(), "1명 전송 준비");
  await page.click('[data-filter="all"]');
  await page.click('[data-edit-attendee]');
  await page.fill("#attendee-title", "가명직위");
  await page.click("#save-attendee-button");
  assert.match(await page.locator(".attendee-copy").innerText(), /가명직위/);
  await page.click('[data-edit-attendee]');
  page.once("dialog", (dialog) => dialog.accept());
  await page.click("#delete-attendee-button");
  assert.equal(Number(await page.locator("#total-count").textContent()), 0);

  await page.click("#bulk-attendee-button");
  await page.setInputFiles("#csv-file-input", {
    name: "가명.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("\ufeff이름,소속,직위,기관,기관역할,기관내순위,좌석고정,참석구분,비고\r\nCSV가명,가명팀,위원,가명기관,주최,1,,주요 참석자,", "utf8"),
  });
  await page.waitForSelector("#bulk-dialog[open]");
  await page.waitForFunction(() => document.querySelectorAll("#bulk-preview-body tr").length === 1);
  assert.equal(await page.locator("#bulk-preview-body tr").count(), 1);
  await page.click("#bulk-register-button");
  assert.equal(Number(await page.locator("#total-count").textContent()), 1);
  const beforeInvalidJson = await page.evaluate(() => localStorage.getItem("seoul-seat-planner:v1"));
  await page.setInputFiles("#json-file-input", {
    name: "가명-잘못된-배치.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"schemaVersion":1,"attendees":[', "utf8"),
  });
  assert.equal(await page.evaluate(() => localStorage.getItem("seoul-seat-planner:v1")), beforeInvalidJson);

  const cancelledImport = new Promise((resolve) => page.once("dialog", async (dialog) => {
    await dialog.dismiss();
    resolve();
  }));
  await page.setInputFiles("#json-file-input", {
    name: "가명-취소-배치.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(makeState(1)), "utf8"),
  });
  await cancelledImport;
  assert.equal(await page.evaluate(() => localStorage.getItem("seoul-seat-planner:v1")), beforeInvalidJson);

  const acceptedImport = new Promise((resolve) => page.once("dialog", async (dialog) => {
    await dialog.accept();
    resolve();
  }));
  await page.setInputFiles("#json-file-input", {
    name: "가명-배치.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(makeState(1)), "utf8"),
  });
  await acceptedImport;
  await page.waitForFunction(() => document.querySelector("#total-count")?.textContent === "2");
  assert.equal(Number(await page.locator("#total-count").textContent()), 2);
  await loadState(page, makeState(0));

  if (legacyXlsxPath) {
    const beforeLegacyPreview = await page.evaluate(() => localStorage.getItem("seoul-seat-planner:v1"));
    await page.setInputFiles("#seoul-xlsx-file-input", legacyXlsxPath);
    await page.waitForSelector("#bulk-dialog[open]");
    assert.equal(await page.locator("#bulk-preview-body tr").count(), 13);
    assert.match(await page.locator("#bulk-file-name").textContent(), /양식 전용 Import/);
    await page.click('#bulk-dialog [data-close-dialog]');
    assert.equal(await page.evaluate(() => localStorage.getItem("seoul-seat-planner:v1")), beforeLegacyPreview);
  }

  const xlsxBytes = await createSyntheticXlsx(page);
  await page.setInputFiles("#seoul-xlsx-file-input", {
    name: "가명_서울_기존양식.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(xlsxBytes),
  });
  await page.waitForSelector("#bulk-dialog[open]");
  assert.equal(await page.locator("#bulk-preview-body tr").count(), 4);
  assert.match(await page.locator("#bulk-file-name").textContent(), /양식 전용 Import/);
  await page.click("#bulk-register-button");
  assert.equal(Number(await page.locator("#assigned-count").textContent()), 4);
  assert.equal(Number(await page.locator("#total-count").textContent()), 4);
  const importedState = JSON.parse(await page.evaluate(() => localStorage.getItem("seoul-seat-planner:v1")));
  assert.ok(importedState.attendees.every((attendee) => attendee.seatLocked));
  const lockedAttendee = importedState.attendees[0];
  const lockedSeat = Object.keys(importedState.assignments).find((seatId) => importedState.assignments[seatId] === lockedAttendee.id);
  await page.click('[data-filter="all"]');
  await page.locator(`[data-attendee-id="${lockedAttendee.id}"]`).click();
  await page.click('[data-seat-id="SEOUL-UPPER-01"]');
  const afterLockedMove = JSON.parse(await page.evaluate(() => localStorage.getItem("seoul-seat-planner:v1")));
  assert.equal(afterLockedMove.assignments[lockedSeat], lockedAttendee.id);
  assert.notEqual(afterLockedMove.assignments["SEOUL-UPPER-01"], lockedAttendee.id);

  await applyAutoLayout(page, 1);
  await page.click("#undo-button");
  assert.equal(Number(await page.locator("#assigned-count").textContent()), 0);
  await applyAutoLayout(page, 2);
  await applyAutoLayout(page, 3);

  const relationState = makeState(2);
  relationState.assignments = { "SEOUL-UPPER-04": "attendee-1-1", "SEOUL-LOWER-04": "attendee-2-1" };
  await loadState(page, relationState);
  await page.click("#institutions-button");
  await page.locator("#institutions-body tr").last().locator("[data-remove-institution]").click();
  const institutionRemoval = new Promise((resolve) => page.once("dialog", async (dialog) => {
    await dialog.accept();
    resolve();
  }));
  await page.click("#save-institutions-button");
  await institutionRemoval;
  const afterInstitutionRemoval = JSON.parse(await page.evaluate(() => localStorage.getItem("seoul-seat-planner:v1")));
  assert.equal(afterInstitutionRemoval.attendees.length, 4);
  assert.equal(afterInstitutionRemoval.assignments["SEOUL-LOWER-04"], "attendee-2-1");
  assert.ok(afterInstitutionRemoval.attendees.filter((attendee) => attendee.id.startsWith("attendee-2-")).every((attendee) => attendee.institutionId === ""));

  const collisionState = makeState(2);
  collisionState.institutions[0].referenceSeatId = "SEOUL-UPPER-13";
  collisionState.institutions[1].referenceSeatId = "SEOUL-UPPER-13";
  collisionState.attendees.push(
    { ...collisionState.attendees[1], id: "attendee-1-3", name: "가명 1-3", institutionId: "institution-1", institutionRank: 3 },
    { ...collisionState.attendees[3], id: "attendee-2-3", name: "가명 2-3", institutionId: "institution-2", institutionRank: 3 },
  );
  await loadState(page, collisionState);
  await page.click("#auto-layout-button");
  await page.waitForSelector("#auto-layout-dialog[open]");
  assert.match(await page.locator("#auto-validation").textContent(), /기관 기준 좌석이 중복/);
  assert.equal(await page.locator("#apply-auto-button").isDisabled(), true);
  await page.click('#auto-layout-dialog [data-close-dialog]');

  await applyAutoLayout(page, 6);
  await applyAutoLayout(page, 10);

  const swappedState = makeState(1);
  swappedState.assignments = { "SEOUL-UPPER-04": "attendee-1-1", "SEOUL-UPPER-05": "attendee-1-2" };
  await loadState(page, swappedState);
  const from = await page.locator('[data-seat-id="SEOUL-UPPER-04"]').boundingBox();
  const to = await page.locator('[data-seat-id="SEOUL-UPPER-05"]').boundingBox();
  assert.ok(from && to);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  const swapped = JSON.parse(await page.evaluate(() => localStorage.getItem("seoul-seat-planner:v1")));
  assert.equal(swapped.assignments["SEOUL-UPPER-05"], "attendee-1-1");
  assert.equal(swapped.assignments["SEOUL-UPPER-04"], "attendee-1-2");
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(Number(await page.locator("#assigned-count").textContent()), 2);

  const jsonDownload = page.waitForEvent("download");
  await page.click("#data-menu-button");
  await page.click('[data-action="json-export"]');
  assert.match((await jsonDownload).suggestedFilename(), /\.json$/);
  const csvDownload = page.waitForEvent("download");
  await page.click("#data-menu-button");
  await page.click('[data-action="csv-export"]');
  assert.match((await csvDownload).suggestedFilename(), /\.csv$/);

  let popupPromise = context.waitForEvent("page");
  await page.click("#nameplate-button");
  let nameplate = await popupPromise;
  await nameplate.waitForLoadState("domcontentloaded");
  await nameplate.locator("#seat-planner-transfer-cancel").waitFor({ state: "visible", timeout: 10000 });
  await nameplate.click("#seat-planner-transfer-cancel");
  await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((item) => item.textContent.includes("취소되었습니다")));
  await nameplate.close();

  popupPromise = context.waitForEvent("page");
  await page.click("#nameplate-button");
  nameplate = await popupPromise;
  await nameplate.waitForLoadState("domcontentloaded");
  await nameplate.locator("#seat-planner-transfer-accept").waitFor({ state: "visible", timeout: 10000 });
  await nameplate.click("#seat-planner-transfer-accept");
  await nameplate.waitForFunction(() => document.body.innerText.includes("2명의 명단을 받았습니다"), null, { timeout: 10000 });
  await nameplate.close();

  await page.evaluate(() => {
    const attendees = window.SEOUL_ROOM_TEMPLATE.seats.map((seat, index) => ({
      id: `full-${index + 1}`,
      name: `가상긴이름${String(index + 1).padStart(2, "0")}참석자`,
      org: `가상서울공동연구기관${(index % 10) + 1}`, title: `국제협력운영위원${(index % 7) + 1}`,
      type: seat.section === "staff" ? "배석" : "주요 참석자", group: "", note: "",
      institutionId: "", institutionRank: null, fixedSeatId: "", seatLocked: false,
    }));
    const assignments = Object.fromEntries(window.SEOUL_ROOM_TEMPLATE.seats.map((seat, index) => [seat.id, attendees[index].id]));
    localStorage.setItem("seoul-seat-planner:v1", JSON.stringify({
      schemaVersion: 1,
      roomTemplateId: "seoul-new-building-meeting-room-1",
      event: {
        title: "가상 서울 국제공동교육과정 발전협의회 장문 행사명 출력 안정성 점검",
        date: "2026-09-15T18:00",
        organizations: "가상서울대학교 · 가상국제공동연구기관 · 가상협력재단",
        location: "한양대학교 서울캠퍼스 신본관 회의실1",
        note: "출력 검증용 가상 데이터",
      },
      institutions: [], attendees, assignments,
      settings: { showSeatNumbers: true, mode: "edit", includeHeadInAuto: false, autoFillStaff: true },
    }));
  });
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(Number(await page.locator("#assigned-count").textContent()), 53);
  const overflowingSeatText = await page.locator("[data-seat-id]").evaluateAll((groups) => groups.filter((group) => {
    const width = Number(group.querySelector("rect")?.getAttribute("width") || 0);
    return [...group.querySelectorAll("text")].some((text) => text.getBBox().width > width - 2);
  }).length);
  assert.equal(overflowingSeatText, 0);

  await page.click('[data-mode="output"]');
  const pngDownload = page.waitForEvent("download");
  await page.click("#png-button");
  assert.match((await pngDownload).suggestedFilename(), /\.png$/);
  const pdf = await page.pdf({ format: "A4", landscape: true, printBackground: true });
  assert.ok(pdf.length > 10_000);
  await writeFile(path.join(artifactsDir, "print.pdf"), pdf);
  await page.waitForTimeout(3200);

  for (const viewport of [
    { width: 1440, height: 900, name: "desktop-1440x900" },
    { width: 1920, height: 1080, name: "desktop-1920x1080" },
    { width: 390, height: 844, name: "mobile-390x844" },
    { width: 412, height: 915, name: "mobile-412x915" },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.screenshot({ path: path.join(artifactsDir, `${viewport.name}.png`), fullPage: true });
  }

  assert.deepEqual(consoleErrors, []);
  console.log("browser regression passed");
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolve) => plannerServer.close(resolve));
  await new Promise((resolve) => nameplateServer.close(resolve));
}
