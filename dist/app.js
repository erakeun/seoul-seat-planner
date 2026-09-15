(() => {
  "use strict";

  const STORAGE_KEY = "seoul-seat-planner:v1";
  const SCENE = { width: 1600, height: 900 };
  const FULL_VIEW = { x: 0, y: 0, width: SCENE.width, height: SCENE.height, zoom: 1 };
  const GROUP_COLORS = ["#1268b3", "#7b4ca0", "#b55725", "#2b7a65", "#8f3e55", "#556b2f"];
  const roomTemplate = window.SEOUL_ROOM_TEMPLATE;
  if (!roomTemplate) throw new Error("서울 회의실 Template을 불러오지 못했습니다.");

  const sectionCounts = roomTemplate.seats.reduce((counts, seat) => {
    const key = seat.section.startsWith("staff") ? "staff" : seat.section;
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});

  if (
    roomTemplate.seats.length !== 53 ||
    sectionCounts["main-left"] !== 24 ||
    sectionCounts["main-right"] !== 25 ||
    sectionCounts.staff !== 4
  ) {
    throw new Error("신본관 회의실1 좌석 Geometry 검증 실패");
  }

  const uniqueSeatIds = new Set(roomTemplate.seats.map((seat) => seat.id));
  const monitorSeats = roomTemplate.seats.filter((seat) => !seat.section.startsWith("staff"));
  const staffSeatIds = new Set(roomTemplate.seats.filter((seat) => seat.section === "staff").map((seat) => seat.id));
  if (
    uniqueSeatIds.size !== 53 ||
    monitorSeats.length !== 49 ||
    staffSeatIds.size !== 4 ||
    roomTemplate.seats.filter((seat) => seat.section === "staff").some((seat) => seat.y > 220) ||
    roomTemplate.seats.some((seat) => !seat.sourceCell)
  ) {
    throw new Error("신본관 회의실1 Geometry 방향 또는 수량 검증 실패");
  }

  const defaultState = () => ({
    schemaVersion: 1,
    roomTemplateId: roomTemplate.id,
    event: {
      title: "신본관 회의실1 좌석배치",
      date: "",
      organizations: "",
      location: "한양대학교 서울캠퍼스 신본관 회의실1",
      note: "",
    },
    attendees: [],
    institutions: [],
    assignments: {},
    settings: { showSeatNumbers: true, mode: "edit", includeHeadInAuto: false, autoFillStaff: true },
  });

  const seatById = new Map(roomTemplate.seats.map((seat) => [seat.id, seat]));
  let state = loadState();
  let selectedAttendeeId = null;
  let attendeeFilter = "unassigned";
  let searchTerm = "";
  let view = { ...FULL_VIEW };
  let undoStack = [];
  let redoStack = [];
  let saveTimer = null;
  let dragCandidate = null;
  let panCandidate = null;
  let bulkPreviewRows = [];
  let bulkPreviewIssues = { errors: [], warnings: [] };
  let bulkImportContext = null;
  let autoDraft = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const elements = {
    shell: $("#app-shell"),
    roomSvg: $("#room-svg"),
    roomViewport: $("#room-viewport"),
    roomShell: $("#room-shell"),
    fixtureLayer: $("#fixture-layer"),
    seatLayer: $("#seat-layer"),
    attendeeList: $("#attendee-list"),
    selectedCard: $("#selected-card"),
    dragGhost: $("#drag-ghost"),
    attendeeDialog: $("#attendee-dialog"),
    resetDialog: $("#reset-dialog"),
    attendeeForm: $("#attendee-form"),
    bulkDialog: $("#bulk-dialog"),
    institutionsDialog: $("#institutions-dialog"),
    autoLayoutDialog: $("#auto-layout-dialog"),
    dataMenu: $("#data-menu"),
    toastRegion: $("#toast-region"),
  };

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || saved.schemaVersion !== 1 || !Array.isArray(saved.attendees)) return defaultState();
      return sanitizeState(saved);
    } catch {
      return defaultState();
    }
  }

  function sanitizeState(input) {
    const base = defaultState();
    const institutions = Array.isArray(input.institutions)
      ? input.institutions
          .filter((item) => item && typeof item.id === "string")
          .map((item, index) => ({
            id: item.id,
            name: String(item.name || "").slice(0, 120),
            role: ["host", "counterparty", "other"].includes(item.role) ? item.role : "other",
            displayOrder: Number.isInteger(Number(item.displayOrder)) ? Number(item.displayOrder) : index + 1,
            referenceSeatId: seatById.has(item.referenceSeatId) && !staffSeatIds.has(item.referenceSeatId) ? item.referenceSeatId : "",
            note: String(item.note || "").slice(0, 300),
          }))
      : [];
    const institutionIds = new Set(institutions.map((item) => item.id));
    const attendees = Array.isArray(input.attendees)
      ? input.attendees
          .filter((item) => item && typeof item.id === "string" && typeof item.name === "string")
          .map((item) => ({
            id: item.id,
            name: item.name.slice(0, 80),
            org: String(item.org || "").slice(0, 120),
            title: String(item.title || "").slice(0, 80),
            type: String(item.type || "기타").slice(0, 40),
            group: String(item.group || "").slice(0, 100),
            note: String(item.note || "").slice(0, 500),
            institutionId: institutionIds.has(item.institutionId) ? item.institutionId : "",
            institutionRank: Number.isInteger(Number(item.institutionRank)) && Number(item.institutionRank) > 0 ? Number(item.institutionRank) : null,
            fixedSeatId: seatById.has(item.fixedSeatId) ? item.fixedSeatId : "",
            seatLocked: Boolean(item.seatLocked),
          }))
      : [];
    const attendeeIds = new Set(attendees.map((item) => item.id));
    const usedAttendees = new Set();
    const assignments = {};
    for (const [seatId, attendeeId] of Object.entries(input.assignments || {})) {
      if (seatById.has(seatId) && attendeeIds.has(attendeeId) && !usedAttendees.has(attendeeId)) {
        assignments[seatId] = attendeeId;
        usedAttendees.add(attendeeId);
      }
    }
    return {
      schemaVersion: 1,
      roomTemplateId: roomTemplate.id,
      event: { ...base.event, ...(input.event || {}) },
      attendees,
      institutions,
      assignments,
      settings: { ...base.settings, ...(input.settings || {}) },
    };
  }

  function snapshot() {
    return JSON.stringify(state);
  }

  function transact(mutator, message) {
    undoStack.push(snapshot());
    if (undoStack.length > 80) undoStack.shift();
    redoStack = [];
    mutator();
    scheduleSave();
    renderAll();
    if (message) toast(message);
  }

  function restore(serialized) {
    state = sanitizeState(JSON.parse(serialized));
    selectedAttendeeId = null;
    syncEventInputs();
    applyMode();
    renderAll();
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    $("#save-status").textContent = "저장 중…";
    $(".save-dot").style.background = "#c38a24";
    try {
      localStorage.setItem(STORAGE_KEY, snapshot());
    } catch {
      $("#save-status").textContent = "저장 실패";
      $(".save-dot").style.background = "#b52f39";
      return;
    }
    saveTimer = setTimeout(() => {
      $("#save-status").textContent = "자동저장됨";
      $(".save-dot").style.background = "#178459";
    }, 260);
  }

  function attendeeById(id) {
    return state.attendees.find((attendee) => attendee.id === id) || null;
  }

  function institutionById(id) {
    return state.institutions.find((institution) => institution.id === id) || null;
  }

  function institutionRoleLabel(role) {
    return ({ host: "주최", counterparty: "상대기관", other: "기타" })[role] || "기타";
  }

  function assignedSeatFor(attendeeId) {
    return Object.keys(state.assignments).find((seatId) => state.assignments[seatId] === attendeeId) || null;
  }

  function getInitials(name) {
    const compact = name.trim().replace(/\s+/g, "");
    return compact.slice(0, 2) || "—";
  }

  function truncate(text, max) {
    const value = String(text || "");
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function displaySeatCode(seat) {
    const prefix = seat.section === "main-left" ? "상" : seat.section === "main-right" ? "하" : "배";
    return `${prefix}${String(seat.number).padStart(2, "0")}`;
  }

  function colorFor(attendee) {
    const source = institutionById(attendee.institutionId)?.name || attendee.group || attendee.org || attendee.type || attendee.name;
    let hash = 0;
    for (const char of source) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return GROUP_COLORS[hash % GROUP_COLORS.length];
  }

  function svgNode(name, attrs = {}, text = "") {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (text) node.textContent = text;
    return node;
  }

  function renderSeoulRoom() {
    const geometry = roomTemplate.geometry;
    elements.roomShell.replaceChildren();
    elements.fixtureLayer.replaceChildren();
    elements.roomShell.setAttribute("pointer-events", "none");
    elements.fixtureLayer.setAttribute("pointer-events", "none");

    elements.roomShell.append(
      svgNode("rect", { x: 18, y: 18, width: 1564, height: 864, rx: 18, fill: "#30363c" }),
      svgNode("path", { d: geometry.roomPath, fill: "url(#roomFloor)", stroke: "#171c21", "stroke-width": 12, "stroke-linejoin": "round" }),
      svgNode("text", { x: 92, y: 88, "font-size": 13, "font-weight": 800, fill: "#3c5266", class: "svg-label" }, "EXCEL 배치도 기준 상대 위치"),
    );

    const tableTopY = 362;
    const tableBottomY = 613;
    elements.fixtureLayer.append(
      svgNode("rect", { x: 160, y: tableTopY, width: 1215, height: 72, rx: 4, fill: "url(#tableWood)", stroke: "#492316", "stroke-width": 7 }),
      svgNode("rect", { x: 160, y: tableBottomY - 72, width: 1215, height: 72, rx: 4, fill: "url(#tableWood)", stroke: "#492316", "stroke-width": 7 }),
      svgNode("text", { x: 175, y: 285, "font-size": 12, "font-weight": 800, fill: "#786b60", class: "svg-label" }, "상단 메인석 · 24석"),
      svgNode("text", { x: 175, y: 720, "font-size": 12, "font-weight": 800, fill: "#786b60", class: "svg-label" }, "하단 메인석 · 25석"),
      svgNode("text", { x: 905, y: 94, "font-size": 12, "font-weight": 800, fill: "#786b60", class: "svg-label" }, "배석 · 4석"),
      svgNode("text", { x: geometry.insideLabel.x, y: geometry.insideLabel.y, "text-anchor": "middle", "font-size": 18, "font-weight": 900, fill: "#6d655d", class: "svg-label" }, "내측"),
    );

    const screen = geometry.screen;
    elements.fixtureLayer.append(
      svgNode("rect", { x: screen.x, y: screen.y, width: screen.width, height: screen.height, rx: 3, fill: "#132a44" }),
      svgNode("text", { x: screen.x - 12, y: screen.y + screen.height / 2, transform: `rotate(-90 ${screen.x - 12} ${screen.y + screen.height / 2})`, "text-anchor": "middle", "font-size": 14, "font-weight": 800, fill: "#183d60", class: "svg-label" }, "화면"),
    );

    const podium = geometry.podium;
    elements.fixtureLayer.append(
      svgNode("rect", { x: podium.x, y: podium.y, width: podium.width, height: podium.height, rx: 4, fill: "#8b654b", stroke: "#4a2418", "stroke-width": 3 }),
      svgNode("text", { x: podium.x + podium.width / 2, y: podium.y + podium.height / 2 + 5, "text-anchor": "middle", "font-size": 13, "font-weight": 800, fill: "#fff7ef", class: "svg-label" }, "단상"),
    );

    const pc = geometry.pc;
    elements.fixtureLayer.append(
      svgNode("rect", { x: pc.x, y: pc.y, width: pc.width, height: pc.height, rx: 6, fill: "#734229", stroke: "#4a2418", "stroke-width": 3 }),
      svgNode("rect", { x: pc.x + 19, y: pc.y + 9, width: 40, height: 25, rx: 3, fill: "#26323c" }),
      svgNode("text", { x: pc.x + pc.width / 2, y: pc.y + pc.height - 9, "text-anchor": "middle", "font-size": 12, "font-weight": 800, fill: "#f4e9df", class: "svg-label" }, "PC"),
    );

    for (const fixture of geometry.unconfirmedFixtures) {
      const group = svgNode("g", { "data-source-cell": fixture.sourceCell, opacity: .7 });
      group.append(
        svgNode("rect", { x: fixture.x, y: fixture.y, width: fixture.width, height: fixture.height, rx: 3, fill: "#f6f2e9", stroke: "#8b8479", "stroke-width": 2, "stroke-dasharray": "6 4" }),
        svgNode("text", { x: fixture.x + fixture.width / 2, y: fixture.y + fixture.height / 2 + 4, "text-anchor": "middle", "font-size": 11, fill: "#716a62", class: "svg-label" }, "미확정"),
      );
      elements.fixtureLayer.append(group);
    }

    for (const door of geometry.sourceDoors) {
      elements.fixtureLayer.append(
        svgNode("path", { d: `M${door.x} ${door.y}h${door.width}M${door.x} ${door.y}l${door.width * .55}-${door.width * .42}M${door.x + door.width} ${door.y}l-${door.width * .55}-${door.width * .42}`, fill: "none", stroke: "#7f684d", "stroke-width": 3, "data-source-range": door.sourceRange }),
      );
    }

    elements.fixtureLayer.append(
      svgNode("text", { x: 88, y: 855, "font-size": 10, fill: "#8b8479", class: "svg-label" }, "신본관 회의실1 · Excel 셀 배치 기반 시제품"),
      svgNode("text", { x: 1510, y: 855, "text-anchor": "end", "font-size": 10, fill: "#8b8479", class: "svg-label" }, "실제 치수·문·창·가구 형상 미확정"),
    );
  }

  function renderRoom() {
    renderSeoulRoom();
  }

  function renderSeats() {
    elements.seatLayer.replaceChildren();
    for (const seat of roomTemplate.seats) {
      const attendee = attendeeById(state.assignments[seat.id]);
      const isStaff = seat.section.startsWith("staff");
      const isHead = seat.section === "head";
      const isUpper = seat.direction === "down";
      const isLower = seat.direction === "up";
      const group = svgNode("g", {
        class: `seat-group${selectedAttendeeId && attendee?.id === selectedAttendeeId ? " selected" : ""}`,
        transform: `translate(${seat.x - seat.width / 2} ${seat.y - seat.height / 2})`,
        tabindex: "0",
        role: "button",
        "data-seat-id": seat.id,
        "aria-label": attendee
          ? `${seat.id}, ${attendee.name}, ${attendee.org} ${attendee.title}`.trim()
          : `${seat.id}, 빈 좌석${seat.priorityCandidate ? ", 기존 Excel 강조석" : ""}`,
      });

      const border = attendee ? colorFor(attendee) : seat.priorityCandidate ? "#d8ad50" : isStaff ? "#5e6973" : isHead ? "#b98a39" : "#49545e";
      const fill = attendee ? "#ffffff" : seat.priorityCandidate ? "#4a3c22" : isStaff ? "#35414b" : "#28343e";
      group.append(svgNode("rect", {
        class: "seat-hit",
        x: 0,
        y: 0,
        width: seat.width,
        height: seat.height,
        rx: isHead ? 9 : 6,
        fill,
        stroke: border,
        "stroke-width": attendee ? 2.2 : 1.2,
      }));

      if (attendee) {
        const accent = isLower
          ? { x: 0, y: seat.height - 5, width: seat.width, height: 5 }
          : isHead
            ? { x: 0, y: 0, width: 5, height: seat.height }
            : { x: 0, y: 0, width: seat.width, height: 5 };
        group.append(svgNode("rect", { ...accent, rx: 3, fill: border }));
      } else {
        const back = isLower
          ? { x: 3, y: seat.height - 8, width: seat.width - 6, height: 6 }
          : isHead
            ? { x: 2, y: 3, width: 7, height: seat.height - 6 }
            : { x: 3, y: 2, width: seat.width - 6, height: 6 };
        group.append(svgNode("rect", { ...back, rx: 2, fill: "#111a22", opacity: .78 }));
      }

      if (!isStaff) {
        const monitorGroup = svgNode("g", { "data-monitor-seat-id": seat.id });
        if (isHead) {
          monitorGroup.append(
            svgNode("rect", { x: seat.width + 28, y: seat.height / 2 - 11, width: 10, height: 22, rx: 2, fill: "#111a22", stroke: "#75808b" }),
            svgNode("path", { d: `M${seat.width + 26} ${seat.height / 2}h-8`, stroke: "#5e6871", "stroke-width": 2 }),
            svgNode("path", { d: `M${seat.width + 17} ${seat.height / 2 + 8}q8 0 8-7`, fill: "none", stroke: "#35414a", "stroke-width": 1.3 }),
          );
        } else {
          const monitorY = isUpper ? seat.height + 25 : -34;
          const standY = isUpper ? monitorY + 13 : monitorY + 18;
          const angle = (seat.t - .5) * (isUpper ? 6 : -6);
          monitorGroup.setAttribute("transform", `rotate(${angle} ${seat.width / 2} ${monitorY + 9})`);
          monitorGroup.append(
            svgNode("rect", { x: seat.width / 2 - 11, y: monitorY, width: 22, height: 13, rx: 2, fill: "#111a22", stroke: "#75808b", "stroke-width": 1 }),
            svgNode("path", { d: `M${seat.width / 2} ${monitorY + 13}v5`, stroke: "#5e6871", "stroke-width": 2 }),
            svgNode("path", { d: `M${seat.width / 2 - 6} ${standY}h12`, stroke: "#5e6871", "stroke-width": 2 }),
            svgNode("path", { d: isUpper ? `M${seat.width / 2 + 14} ${monitorY + 13}q7 6 0 12` : `M${seat.width / 2 + 14} ${monitorY + 8}q7-6 0-12`, fill: "none", stroke: "#35414a", "stroke-width": 1.2 }),
          );
        }
        group.append(monitorGroup);
      }

      const textAnchor = "middle";
      const centerX = seat.width / 2;
      if (attendee) {
        const nameY = seat.height / 2 + (isHead ? -2 : 3);
        group.append(svgNode("text", {
          class: "seat-text",
          x: centerX,
          y: nameY,
          "text-anchor": textAnchor,
          "font-size": isStaff || isHead ? 9.5 : 8.5,
          "font-weight": 800,
          fill: "#12263a",
        }, truncate(attendee.name, isStaff || isHead ? 8 : 5)));
        if ((isStaff || isHead || view.zoom >= 1.6) && (attendee.org || attendee.title)) {
          group.append(svgNode("text", {
            class: "seat-text",
            x: centerX,
            y: isStaff || isHead ? seat.height / 2 + 11 : seat.height - 4,
            "text-anchor": textAnchor,
            "font-size": 7.4,
            fill: "#687586",
          }, truncate([attendee.org, attendee.title].filter(Boolean).join(" · "), isStaff || isHead ? 12 : 7)));
        }
      } else {
        group.append(svgNode("text", {
          class: "seat-text",
          x: centerX,
          y: seat.height / 2 + 3.5,
          "text-anchor": textAnchor,
          "font-size": isStaff ? 7.4 : isHead ? 8.2 : 6.8,
          "font-weight": 700,
          fill: "#e9eef2",
        }, state.settings.showSeatNumbers ? displaySeatCode(seat) : "+"));
      }

      if (attendee) {
        group.append(svgNode("title", {}, `${attendee.name}\n${attendee.org}${attendee.title ? ` · ${attendee.title}` : ""}\n${attendee.type}${attendee.group ? ` · ${attendee.group}` : ""}${attendee.note ? `\n${attendee.note}` : ""}`));
      }

      group.addEventListener("pointerdown", onSeatPointerDown);
      group.addEventListener("keydown", onSeatKeyDown);
      elements.seatLayer.append(group);
    }
  }

  function renderAttendees() {
    const assignedIds = new Set(Object.values(state.assignments));
    const term = searchTerm.trim().toLocaleLowerCase("ko");
    const attendees = state.attendees.filter((attendee) => {
      if (attendeeFilter === "unassigned" && assignedIds.has(attendee.id)) return false;
      if (!term) return true;
      return [attendee.name, attendee.org, attendee.title, attendee.type, attendee.group]
        .join(" ")
        .toLocaleLowerCase("ko")
        .includes(term);
    });

    elements.attendeeList.replaceChildren();
    if (!attendees.length) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      if (!state.attendees.length) {
        empty.innerHTML = "<i>＋</i><strong>참석자를 추가하세요</strong><p>이름과 소속을 입력한 뒤 좌석으로 끌거나, 참석자를 선택하고 좌석을 클릭해 배정할 수 있습니다.</p>";
      } else if (attendeeFilter === "unassigned" && !term) {
        empty.innerHTML = "<i>✓</i><strong>모두 배정되었습니다</strong><p>전체 탭에서 참석자의 배정 좌석을 확인하거나 자리 이동을 할 수 있습니다.</p>";
      } else {
        empty.innerHTML = "<i>⌕</i><strong>검색 결과가 없습니다</strong><p>검색어 또는 목록 필터를 확인해 주세요.</p>";
      }
      elements.attendeeList.append(empty);
    }

    for (const attendee of attendees) {
      const seatId = assignedSeatFor(attendee.id);
      const institution = institutionById(attendee.institutionId);
      const item = document.createElement("div");
      item.className = `attendee-item${selectedAttendeeId === attendee.id ? " selected" : ""}${seatId ? " assigned" : ""}`;
      item.dataset.attendeeId = attendee.id;
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("aria-label", `${attendee.name}${seatId ? `, ${seatId} 배정됨` : ", 미배정"}`);
      item.innerHTML = `
        <div class="avatar" style="background:${colorFor(attendee)}">${escapeHtml(getInitials(attendee.name))}</div>
        <div class="attendee-copy">
          <strong>${escapeHtml(attendee.name)}</strong>
          <span>${escapeHtml([institution?.name || attendee.org, attendee.title, attendee.institutionRank ? `기관 ${attendee.institutionRank}순위` : ""].filter(Boolean).join(" · ") || attendee.type)}</span>
          ${seatId ? `<em class="seat-chip">${escapeHtml(seatId)}${attendee.seatLocked ? `<b class="lock-badge">고정</b>` : ""}</em>` : ""}
        </div>
        <div class="attendee-actions">
          <button class="mini-action" type="button" data-edit-attendee="${attendee.id}" aria-label="${escapeHtml(attendee.name)} 수정">•••</button>
        </div>`;
      item.addEventListener("pointerdown", onAttendeePointerDown);
      item.addEventListener("click", (event) => {
        if (event.target.closest("[data-edit-attendee]")) return;
        selectAttendee(attendee.id);
      });
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectAttendee(attendee.id);
        }
      });
      item.querySelector("[data-edit-attendee]").addEventListener("click", () => openAttendeeDialog(attendee.id));
      elements.attendeeList.append(item);
    }
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  function renderCounts() {
    const assigned = Object.keys(state.assignments).length;
    const unassigned = Math.max(0, state.attendees.length - assigned);
    $("#total-count").textContent = state.attendees.length;
    $("#assigned-count").textContent = assigned;
    $("#unassigned-count").textContent = unassigned;
    $("#available-count").textContent = roomTemplate.seats.length - assigned;
    $("#tab-unassigned-count").textContent = unassigned;
    $("#tab-all-count").textContent = state.attendees.length;
  }

  function renderSelected() {
    const attendee = attendeeById(selectedAttendeeId);
    elements.selectedCard.hidden = !attendee;
    if (!attendee) return;
    $("#selected-name").textContent = attendee.name;
    $("#selected-meta").textContent = [institutionById(attendee.institutionId)?.name || attendee.org, attendee.title, assignedSeatFor(attendee.id) || "미배정", attendee.seatLocked ? "자리 고정" : ""].filter(Boolean).join(" · ");
  }

  function renderUndoRedo() {
    $("#undo-button").disabled = undoStack.length === 0;
    $("#redo-button").disabled = redoStack.length === 0;
  }

  function renderPrintHeading() {
    const meta = [formatDate(state.event.date), state.event.organizations, state.event.location, state.event.note].filter(Boolean);
    $("#print-event-title").textContent = state.event.title || "신본관 회의실1 좌석배치";
    $("#print-event-meta").textContent = meta.join(" · ");
  }

  function renderAll() {
    renderSeats();
    renderAttendees();
    renderCounts();
    renderSelected();
    renderUndoRedo();
    renderPrintHeading();
  }

  function selectAttendee(attendeeId) {
    selectedAttendeeId = selectedAttendeeId === attendeeId ? null : attendeeId;
    renderSeats();
    renderAttendees();
    renderSelected();
  }

  function assignAttendee(attendeeId, targetSeatId) {
    if (!attendeeById(attendeeId) || !seatById.has(targetSeatId)) return;
    const sourceSeatId = assignedSeatFor(attendeeId);
    const displacedAttendeeId = state.assignments[targetSeatId];
    if (sourceSeatId === targetSeatId) return;

    transact(() => {
      if (sourceSeatId) delete state.assignments[sourceSeatId];
      if (displacedAttendeeId && sourceSeatId) state.assignments[sourceSeatId] = displacedAttendeeId;
      state.assignments[targetSeatId] = attendeeId;
      const moved = attendeeById(attendeeId);
      if (moved?.seatLocked) moved.fixedSeatId = targetSeatId;
      const displaced = attendeeById(displacedAttendeeId);
      if (displaced?.seatLocked && sourceSeatId) displaced.fixedSeatId = sourceSeatId;
      selectedAttendeeId = attendeeId;
    }, displacedAttendeeId && sourceSeatId ? "두 좌석을 교환했습니다." : displacedAttendeeId ? "기존 참석자를 미배정으로 이동했습니다." : `${targetSeatId}에 배정했습니다.`);
  }

  function unassignAttendee(attendeeId) {
    const seatId = assignedSeatFor(attendeeId);
    if (!seatId) return;
    transact(() => {
      delete state.assignments[seatId];
      const attendee = attendeeById(attendeeId);
      if (attendee?.seatLocked) {
        attendee.seatLocked = false;
        attendee.fixedSeatId = "";
      }
      selectedAttendeeId = attendeeId;
    }, "좌석 배정을 해제했습니다.");
  }

  function onSeatPointerDown(event) {
    if (state.settings.mode !== "edit" || event.button !== 0) return;
    event.stopPropagation();
    const seatId = event.currentTarget.dataset.seatId;
    const attendeeId = state.assignments[seatId];
    dragCandidate = attendeeId
      ? { attendeeId, sourceSeatId: seatId, startX: event.clientX, startY: event.clientY, dragging: false }
      : { attendeeId: null, sourceSeatId: seatId, startX: event.clientX, startY: event.clientY, dragging: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onSeatKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleSeatClick(event.currentTarget.dataset.seatId);
  }

  function handleSeatClick(seatId) {
    const occupantId = state.assignments[seatId];
    if (selectedAttendeeId) {
      assignAttendee(selectedAttendeeId, seatId);
    } else if (occupantId) {
      selectAttendee(occupantId);
    } else {
      toast("먼저 참석자를 선택해 주세요.");
    }
  }

  function onAttendeePointerDown(event) {
    if (event.button !== 0 || event.target.closest("button")) return;
    const attendeeId = event.currentTarget.dataset.attendeeId;
    dragCandidate = {
      attendeeId,
      sourceSeatId: assignedSeatFor(attendeeId),
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function beginDrag(candidate, clientX, clientY) {
    candidate.dragging = true;
    const attendee = attendeeById(candidate.attendeeId);
    elements.dragGhost.textContent = `${attendee?.name || "참석자"} · 놓을 좌석을 선택하세요`;
    elements.dragGhost.hidden = false;
    moveDragGhost(clientX, clientY);
    document.body.style.cursor = "grabbing";
  }

  function moveDragGhost(clientX, clientY) {
    elements.dragGhost.style.left = `${clientX}px`;
    elements.dragGhost.style.top = `${clientY}px`;
    $$(".seat-group.drop-target").forEach((seat) => seat.classList.remove("drop-target"));
    elements.attendeeList.classList.remove("drag-over");
    const target = document.elementFromPoint(clientX, clientY);
    const seat = target?.closest?.("[data-seat-id]");
    if (seat) seat.classList.add("drop-target");
    if (target?.closest?.("[data-unassigned-drop]")) elements.attendeeList.classList.add("drag-over");
  }

  function finishDrag(clientX, clientY) {
    const candidate = dragCandidate;
    dragCandidate = null;
    elements.dragGhost.hidden = true;
    document.body.style.cursor = "";
    $$(".seat-group.drop-target").forEach((seat) => seat.classList.remove("drop-target"));
    elements.attendeeList.classList.remove("drag-over");
    if (!candidate) return;

    if (!candidate.dragging) {
      if (candidate.sourceSeatId) handleSeatClick(candidate.sourceSeatId);
      return;
    }

    const target = document.elementFromPoint(clientX, clientY);
    const seatTarget = target?.closest?.("[data-seat-id]");
    if (seatTarget && candidate.attendeeId) {
      assignAttendee(candidate.attendeeId, seatTarget.dataset.seatId);
    } else if (target?.closest?.("[data-unassigned-drop]") && candidate.attendeeId) {
      unassignAttendee(candidate.attendeeId);
    }
  }

  function onGlobalPointerMove(event) {
    if (dragCandidate) {
      const distance = Math.hypot(event.clientX - dragCandidate.startX, event.clientY - dragCandidate.startY);
      if (!dragCandidate.dragging && dragCandidate.attendeeId && distance > 6) beginDrag(dragCandidate, event.clientX, event.clientY);
      if (dragCandidate.dragging) {
        event.preventDefault();
        moveDragGhost(event.clientX, event.clientY);
      }
    }
    if (panCandidate) {
      event.preventDefault();
      const rect = elements.roomSvg.getBoundingClientRect();
      view.x = panCandidate.viewX - ((event.clientX - panCandidate.startX) / rect.width) * view.width;
      view.y = panCandidate.viewY - ((event.clientY - panCandidate.startY) / rect.height) * view.height;
      clampView();
      updateViewBox();
    }
  }

  function onGlobalPointerUp(event) {
    if (dragCandidate) finishDrag(event.clientX, event.clientY);
    if (panCandidate) {
      panCandidate = null;
      elements.roomViewport.classList.remove("panning");
    }
  }

  function populateInstitutionSelect(select, selectedId = "") {
    select.replaceChildren(new Option("기관 없음", ""));
    [...state.institutions]
      .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name, "ko"))
      .forEach((institution) => select.add(new Option(`${institution.name} · ${institutionRoleLabel(institution.role)}`, institution.id)));
    select.value = selectedId;
  }

  function openAttendeeDialog(attendeeId = null) {
    const attendee = attendeeById(attendeeId);
    $("#attendee-dialog-title").textContent = attendee ? "참석자 수정" : "참석자 추가";
    $("#attendee-id").value = attendee?.id || "";
    $("#attendee-name").value = attendee?.name || "";
    $("#attendee-org").value = attendee?.org || "";
    $("#attendee-title").value = attendee?.title || "";
    $("#attendee-type").value = attendee?.type || "교내";
    $("#attendee-group").value = attendee?.group || "";
    populateInstitutionSelect($("#attendee-institution"), attendee?.institutionId || "");
    $("#attendee-rank").value = attendee?.institutionRank || "";
    $("#attendee-fixed-seat").value = attendee?.fixedSeatId || assignedSeatFor(attendee?.id) || "";
    $("#attendee-locked").checked = Boolean(attendee?.seatLocked);
    $("#attendee-note").value = attendee?.note || "";
    $("#delete-attendee-button").hidden = !attendee;
    elements.attendeeDialog.showModal();
    requestAnimationFrame(() => $("#attendee-name").focus());
  }

  function saveAttendee() {
    const id = $("#attendee-id").value;
    const name = $("#attendee-name").value.trim();
    if (!name) {
      $("#attendee-name").reportValidity();
      return;
    }
    const values = {
      name,
      org: $("#attendee-org").value.trim(),
      title: $("#attendee-title").value.trim(),
      type: $("#attendee-type").value,
      group: $("#attendee-group").value.trim(),
      note: $("#attendee-note").value.trim(),
      institutionId: $("#attendee-institution").value,
      institutionRank: $("#attendee-rank").value ? Number($("#attendee-rank").value) : null,
      fixedSeatId: $("#attendee-fixed-seat").value.trim().toUpperCase(),
      seatLocked: $("#attendee-locked").checked,
    };
    if (values.institutionId && !values.group) values.group = institutionById(values.institutionId)?.name || "";
    if (values.institutionRank !== null && (!Number.isInteger(values.institutionRank) || values.institutionRank < 1)) {
      toast("기관 내 순위는 1 이상의 정수로 입력해 주세요.", true);
      return;
    }
    if (values.fixedSeatId && !seatById.has(values.fixedSeatId)) {
      toast("유효한 좌석 ID를 입력해 주세요.", true);
      return;
    }
    if (values.seatLocked && !values.fixedSeatId) {
      values.fixedSeatId = id ? assignedSeatFor(id) || "" : "";
      if (!values.fixedSeatId) {
        toast("자리 고정에는 고정 좌석 ID가 필요합니다.", true);
        return;
      }
    }
    const occupiedBy = values.fixedSeatId ? state.assignments[values.fixedSeatId] : null;
    if (values.seatLocked && occupiedBy && occupiedBy !== id) {
      toast(`${values.fixedSeatId} 좌석은 이미 사용 중입니다.`, true);
      return;
    }
    transact(() => {
      let attendeeId = id;
      if (id) Object.assign(attendeeById(id), values);
      else {
        attendeeId = crypto.randomUUID();
        state.attendees.push({ id: attendeeId, ...values });
      }
      if (values.seatLocked && values.fixedSeatId) {
        const previousSeat = assignedSeatFor(attendeeId);
        if (previousSeat) delete state.assignments[previousSeat];
        state.assignments[values.fixedSeatId] = attendeeId;
      }
    }, id ? "참석자 정보를 수정했습니다." : "참석자를 추가했습니다.");
    elements.attendeeDialog.close();
  }

  function deleteCurrentAttendee() {
    const id = $("#attendee-id").value;
    const attendee = attendeeById(id);
    if (!attendee || !window.confirm(`${attendee.name} 참석자를 삭제할까요?`)) return;
    transact(() => {
      const seatId = assignedSeatFor(id);
      if (seatId) delete state.assignments[seatId];
      state.attendees = state.attendees.filter((item) => item.id !== id);
      if (selectedAttendeeId === id) selectedAttendeeId = null;
    }, "참석자를 삭제했습니다.");
    elements.attendeeDialog.close();
  }

  function syncEventInputs() {
    $("#event-title").value = state.event.title;
    $("#event-date").value = state.event.date;
    const institutionSummary = [...state.institutions].sort((a, b) => a.displayOrder - b.displayOrder).map((item) => item.name).filter(Boolean).join(" · ");
    $("#event-organizations").value = institutionSummary || state.event.organizations;
    $("#event-location").value = state.event.location;
    $("#event-note").value = state.event.note;
    $("#seat-number-toggle").checked = state.settings.showSeatNumbers;
  }

  function bindEventInputs() {
    const bindings = [
      ["event-title", "title"],
      ["event-date", "date"],
      ["event-organizations", "organizations"],
      ["event-location", "location"],
      ["event-note", "note"],
    ];
    for (const [id, key] of bindings) {
      $(`#${id}`).addEventListener("input", (event) => {
        state.event[key] = event.target.value;
        renderPrintHeading();
        scheduleSave();
      });
    }
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("ko-KR", { dateStyle: "long", timeStyle: "short" }).format(date);
  }

  function applyMode() {
    const output = state.settings.mode === "output";
    elements.shell.classList.toggle("output-mode", output);
    $$("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === state.settings.mode));
    if (output) fitView();
    scheduleSave();
  }

  function setMode(mode) {
    state.settings.mode = mode;
    selectedAttendeeId = null;
    applyMode();
    renderAll();
  }

  function updateViewBox() {
    elements.roomSvg.setAttribute("viewBox", `${view.x} ${view.y} ${view.width} ${view.height}`);
    $("#zoom-output").textContent = `${Math.round(view.zoom * 100)}%`;
  }

  function clampView() {
    const paddingX = view.width * .2;
    const paddingY = view.height * .2;
    view.x = Math.min(SCENE.width - view.width + paddingX, Math.max(-paddingX, view.x));
    view.y = Math.min(SCENE.height - view.height + paddingY, Math.max(-paddingY, view.y));
  }

  function zoomTo(nextZoom, anchorX = SCENE.width / 2, anchorY = SCENE.height / 2) {
    const zoom = Math.min(2.4, Math.max(.72, nextZoom));
    const worldAnchorX = view.x + (anchorX / SCENE.width) * view.width;
    const worldAnchorY = view.y + (anchorY / SCENE.height) * view.height;
    view.zoom = zoom;
    view.width = SCENE.width / zoom;
    view.height = SCENE.height / zoom;
    view.x = worldAnchorX - (anchorX / SCENE.width) * view.width;
    view.y = worldAnchorY - (anchorY / SCENE.height) * view.height;
    clampView();
    updateViewBox();
    renderSeats();
  }

  function fitView() {
    view = { ...FULL_VIEW };
    updateViewBox();
    renderSeats();
  }

  function startPan(event) {
    if (event.button !== 0 || event.target.closest("[data-seat-id]")) return;
    panCandidate = { startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y };
    elements.roomViewport.classList.add("panning");
    elements.roomSvg.setPointerCapture?.(event.pointerId);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function safeFilename(extension) {
    const title = (state.event.title || "서울-신본관-회의실1-좌석배치").replace(/[\\/:*?"<>|]/g, "-").trim();
    return `${title || "서울-신본관-회의실1-좌석배치"}.${extension}`;
  }

  function exportJson() {
    const payload = {
      ...state,
      exportedAt: new Date().toISOString(),
      seatValidation: { mainUpper: 24, mainLower: 25, staff: 4, total: 53 },
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), safeFilename("json"));
    toast("배치 데이터를 내보냈습니다.");
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed.attendees) || typeof parsed.assignments !== "object") throw new Error("invalid");
        undoStack.push(snapshot());
        redoStack = [];
        state = sanitizeState(parsed);
        selectedAttendeeId = null;
        syncEventInputs();
        applyMode();
        renderAll();
        scheduleSave();
        toast("JSON 배치 데이터를 불러왔습니다.");
      } catch {
        toast("올바른 좌석배치 JSON 파일이 아닙니다.", true);
      }
    };
    reader.readAsText(file);
  }

  function csvEscape(value) {
    const text = String(value || "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function exportCsv() {
    const headers = ["이름", "소속", "직위", "기관", "기관역할", "기관내순위", "좌석고정", "참석구분", "비고"];
    const rows = state.attendees.map((attendee) => [
      attendee.name,
      attendee.org,
      attendee.title,
      institutionById(attendee.institutionId)?.name || attendee.group,
      institutionRoleLabel(institutionById(attendee.institutionId)?.role),
      attendee.institutionRank || "",
      attendee.seatLocked ? attendee.fixedSeatId || assignedSeatFor(attendee.id) : "",
      attendee.type,
      attendee.note,
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
    downloadBlob(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }), safeFilename("csv"));
    toast("참석자 명단을 CSV로 내보냈습니다.");
  }

  const BULK_HEADERS = ["이름", "소속", "직위", "기관", "기관역할", "기관내순위", "좌석고정", "참석구분", "비고"];

  function downloadExampleCsv() {
    const rows = [
      BULK_HEADERS,
      ["가온", "대외협력팀", "팀장", "푸른대학교", "주최", "1", "SEOUL-UPPER-13", "주요 참석자", "예시 데이터"],
      ["나래", "국제처", "처장", "푸른대학교", "주최", "2", "", "교내", ""],
      ["다온", "전략기획실", "실장", "새봄연구원", "상대기관", "1", "", "외부", ""],
      ["라온", "지원팀", "매니저", "새봄연구원", "상대기관", "", "SEOUL-STAFF-01", "배석", ""],
    ];
    const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
    downloadBlob(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }), "서울_신본관_회의실1_참석자_등록_예시.csv");
    toast("UTF-8 BOM 예시 CSV를 저장했습니다.");
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") { row.push(field); field = ""; }
      else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
      else field += char;
    }
    if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
    return rows;
  }

  function roleFromCsv(value) {
    const text = String(value || "").trim().toLowerCase();
    if (["주최", "host"].includes(text)) return "host";
    if (["상대기관", "상대", "counterparty", "guest"].includes(text)) return "counterparty";
    return "other";
  }

  function normalizeBulkRows(rows) {
    const headers = rows.shift().map((header) => header.trim().replace(/^\ufeff/, ""));
    const aliases = {
      name: ["이름", "성명", "name"], org: ["소속", "organization", "org"], title: ["직위", "직책", "title"],
      institution: ["기관", "기관·그룹", "기관/그룹", "그룹", "group"], role: ["기관역할", "기관 역할", "role"],
      rank: ["기관내순위", "기관 내 순위", "순위", "rank"], fixedSeat: ["좌석고정", "고정좌석", "좌석id", "좌석", "seat", "seatid"],
      type: ["참석구분", "구분", "type"], note: ["비고", "note"],
    };
    const indexes = Object.fromEntries(Object.entries(aliases).map(([key, values]) => [key, headers.findIndex((header) => values.some((value) => value.toLowerCase() === header.toLowerCase()))]));
    if (indexes.name < 0) throw new Error("name");
    return rows.map((row) => ({
      name: (row[indexes.name] || "").trim(),
      org: indexes.org >= 0 ? (row[indexes.org] || "").trim() : "",
      title: indexes.title >= 0 ? (row[indexes.title] || "").trim() : "",
      institution: indexes.institution >= 0 ? (row[indexes.institution] || "").trim() : "",
      role: indexes.role >= 0 ? (row[indexes.role] || "").trim() : "",
      rank: indexes.rank >= 0 ? (row[indexes.rank] || "").trim() : "",
      fixedSeat: indexes.fixedSeat >= 0 ? (row[indexes.fixedSeat] || "").trim().toUpperCase() : "",
      type: indexes.type >= 0 ? (row[indexes.type] || "기타").trim() || "기타" : "기타",
      note: indexes.note >= 0 ? (row[indexes.note] || "").trim() : "",
    })).filter((row) => Object.values(row).some(Boolean));
  }

  function validateBulkRows() {
    const errors = [];
    const warnings = [];
    const seatClaims = new Map();
    const existingNames = new Set(state.attendees.map((a) => `${a.name}|${a.org}`.toLowerCase()));
    const seenNames = new Set();
    bulkPreviewRows.forEach((row, index) => {
      const line = index + 2;
      row._errors = [];
      row._warnings = [];
      if (!row.name.trim()) row._errors.push("이름 누락");
      if (row.rank && (!/^\d+$/.test(row.rank) || Number(row.rank) < 1)) row._errors.push("기관 내 순위 오류");
      if (row.fixedSeat && !seatById.has(row.fixedSeat)) row._errors.push("유효하지 않은 좌석 ID");
      if (row.type === "배석" && row.fixedSeat && !staffSeatIds.has(row.fixedSeat)) row._warnings.push("배석 참석자에게 메인 좌석 지정");
      if (row.fixedSeat) {
        if (seatClaims.has(row.fixedSeat)) row._errors.push(`${seatClaims.get(row.fixedSeat)}행과 고정 좌석 중복`);
        else seatClaims.set(row.fixedSeat, line);
        const occupant = state.assignments[row.fixedSeat];
        if (occupant) row._errors.push("현재 배정과 고정 좌석 충돌");
      }
      const identity = `${row.name}|${row.org}`.toLowerCase();
      if (row.name && (existingNames.has(identity) || seenNames.has(identity))) row._warnings.push("중복 참석자 가능성");
      if (row.name) seenNames.add(identity);
      row._errors.forEach((message) => errors.push(`${line}행: ${message}`));
      row._warnings.forEach((message) => warnings.push(`${line}행: ${message}`));
    });
    if (state.attendees.length + bulkPreviewRows.length > 53) errors.push("전체 참석자가 53명을 초과합니다.");
    const staffCount = state.attendees.filter((a) => a.type === "배석").length + bulkPreviewRows.filter((row) => row.type === "배석").length;
    if (staffCount > 4) errors.push("배석 참석자가 4명을 초과합니다.");
    bulkPreviewIssues = { errors, warnings };
    return bulkPreviewIssues;
  }

  function renderBulkPreview() {
    validateBulkRows();
    $("#bulk-preview-head").innerHTML = `<tr><th>#</th>${BULK_HEADERS.map((header) => `<th>${header}</th>`).join("")}</tr>`;
    const body = $("#bulk-preview-body");
    body.replaceChildren();
    bulkPreviewRows.forEach((row, index) => {
      const tr = document.createElement("tr");
      tr.className = row._errors.length ? "row-error" : row._warnings.length ? "row-warning" : "";
      tr.innerHTML = `<td>${index + 1}</td>${[
        ["name", ""], ["org", ""], ["title", ""], ["institution", ""], ["role", ""], ["rank", "narrow-input"], ["fixedSeat", "seat-input"], ["type", ""], ["note", ""],
      ].map(([key, className]) => `<td><input class="${className}" data-bulk-row="${index}" data-bulk-key="${key}" value="${escapeHtml(row[key])}" aria-label="${BULK_HEADERS[["name","org","title","institution","role","rank","fixedSeat","type","note"].indexOf(key)]}" /></td>`).join("")}`;
      body.append(tr);
    });
    const summary = $("#bulk-validation");
    summary.className = `validation-summary${bulkPreviewIssues.errors.length ? " has-error" : bulkPreviewIssues.warnings.length ? " has-warning" : ""}`;
    summary.textContent = bulkPreviewIssues.errors.length
      ? `등록 불가 · ${bulkPreviewIssues.errors.join(" · ")}`
      : bulkPreviewIssues.warnings.length
        ? `확인 필요 · ${bulkPreviewIssues.warnings.join(" · ")}`
        : bulkPreviewRows.length ? `${bulkPreviewRows.length}명 검증 완료` : "CSV 파일을 선택해 주세요.";
    $("#bulk-register-button").disabled = !bulkPreviewRows.length || bulkPreviewIssues.errors.length > 0;
    $("#bulk-register-auto-button").disabled = !bulkPreviewRows.length || bulkPreviewIssues.errors.length > 0;
  }

  function openBulkDialog() {
    bulkPreviewRows = [];
    bulkImportContext = null;
    $("#bulk-file-name").textContent = "파일을 선택하면 편집 가능한 미리보기가 표시됩니다.";
    renderBulkPreview();
    elements.bulkDialog.showModal();
  }

  function importCsv(file) {
    bulkImportContext = null;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = parseCsv(String(reader.result).replace(/^\ufeff/, "")).filter((row) => row.some((field) => field.trim()));
        if (rows.length < 2) throw new Error("empty");
        bulkPreviewRows = normalizeBulkRows(rows);
        if (!bulkPreviewRows.length) throw new Error("empty");
        $("#bulk-file-name").textContent = `${file.name} · ${bulkPreviewRows.length}행`;
        if (!elements.bulkDialog.open) elements.bulkDialog.showModal();
        renderBulkPreview();
      } catch (error) {
        toast(error.message === "name" ? "CSV 첫 행에 ‘이름’ 열이 필요합니다." : "CSV 명단을 읽지 못했습니다.", true);
      }
    };
    reader.readAsText(file, "UTF-8");
  }

  function legacyCellText(sheet, address) {
    const value = sheet[address]?.v;
    return value === undefined || value === null
      ? ""
      : String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  }

  function legacyAttendeeRow(sheet, seat, sheetName) {
    const raw = legacyCellText(sheet, seat.sourceCell);
    if (!raw || (seat.section === "staff" && raw === "배석")) return null;
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const name = (lines.shift() || "").slice(0, 80);
    if (!name) return null;
    return {
      name,
      org: "",
      title: lines.join(" ").slice(0, 80),
      institution: "",
      role: "",
      rank: "",
      fixedSeat: seat.id,
      type: seat.section === "staff" ? "배석" : "주요 참석자",
      note: `서울 기존 양식 ${sheetName}!${seat.sourceCell}`,
    };
  }

  function importSeoulXlsx(file) {
    if (!window.XLSX) {
      toast("Excel 읽기 모듈을 불러오지 못했습니다.", true);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast("10MB 이하의 Excel 파일을 선택해 주세요.", true);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const workbook = window.XLSX.read(reader.result, { type: "array", cellFormula: false, cellHTML: false, cellNF: false });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) throw new Error("sheet");
        const title = legacyCellText(sheet, roomTemplate.excelImport.titleCell);
        if (!title.includes(roomTemplate.excelImport.titleIncludes)) throw new Error("template");
        bulkPreviewRows = roomTemplate.seats
          .map((seat) => legacyAttendeeRow(sheet, seat, sheetName))
          .filter(Boolean);
        if (!bulkPreviewRows.length) throw new Error("empty");
        bulkImportContext = {
          kind: "seoul-legacy-xlsx",
          eventTitle: title.replace(/^\*\s*/, "").replace(/의\s*좌석배치도$/, "좌석배치"),
          sheetName,
        };
        $("#bulk-file-name").textContent = `${file.name} · ${sheetName} · ${bulkPreviewRows.length}명 · 양식 전용 Import`;
        if (!elements.bulkDialog.open) elements.bulkDialog.showModal();
        renderBulkPreview();
      } catch (error) {
        const message = error.message === "template"
          ? "신본관 회의실1 기존 양식으로 확인되지 않습니다. 표준 CSV를 사용해 주세요."
          : error.message === "empty"
            ? "기존 양식에서 배정된 참석자 이름을 찾지 못했습니다."
            : "Excel 파일을 읽지 못했습니다.";
        toast(message, true);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function registerBulkRows(openAutoAfter = false) {
    validateBulkRows();
    if (!bulkPreviewRows.length || bulkPreviewIssues.errors.length) return;
    const createdIds = [];
    transact(() => {
      for (const row of bulkPreviewRows) {
        let institution = row.institution
          ? state.institutions.find((item) => item.name.toLocaleLowerCase("ko") === row.institution.toLocaleLowerCase("ko"))
          : null;
        if (row.institution && !institution) {
          institution = { id: crypto.randomUUID(), name: row.institution, role: roleFromCsv(row.role), displayOrder: state.institutions.length + 1, referenceSeatId: "", note: "" };
          state.institutions.push(institution);
        }
        const attendee = {
          id: crypto.randomUUID(), name: row.name, org: row.org, title: row.title, type: row.type, group: row.institution, note: row.note,
          institutionId: institution?.id || "", institutionRank: row.rank ? Number(row.rank) : null,
          fixedSeatId: row.fixedSeat, seatLocked: Boolean(row.fixedSeat),
        };
        state.attendees.push(attendee);
        createdIds.push(attendee.id);
        if (row.fixedSeat) state.assignments[row.fixedSeat] = attendee.id;
      }
      state.event.organizations = [...state.institutions].sort((a, b) => a.displayOrder - b.displayOrder).map((item) => item.name).join(" · ");
      if (bulkImportContext?.eventTitle) state.event.title = bulkImportContext.eventTitle;
    }, `${createdIds.length}명의 참석자를 등록했습니다.`);
    syncEventInputs();
    elements.bulkDialog.close();
    bulkPreviewRows = [];
    bulkImportContext = null;
    if (openAutoAfter) openAutoLayoutDialog();
  }

  function institutionRowTemplate(institution = {}) {
    const id = institution.id || crypto.randomUUID();
    const role = institution.role || "other";
    const seatOptions = ['<option value="">선택 안 함</option>', ...roomTemplate.seats.filter((seat) => seat.section !== "staff").map((seat) => `<option value="${seat.id}"${seat.id === institution.referenceSeatId ? " selected" : ""}>${seat.id}</option>`)].join("");
    const tr = document.createElement("tr");
    tr.dataset.institutionId = id;
    tr.innerHTML = `
      <td><input data-inst="name" value="${escapeHtml(institution.name)}" placeholder="기관명" /></td>
      <td><select data-inst="role"><option value="host"${role === "host" ? " selected" : ""}>주최</option><option value="counterparty"${role === "counterparty" ? " selected" : ""}>상대기관</option><option value="other"${role === "other" ? " selected" : ""}>기타</option></select></td>
      <td><input class="narrow-input" data-inst="displayOrder" type="number" min="1" step="1" value="${institution.displayOrder || state.institutions.length + 1}" /></td>
      <td><select class="seat-input" data-inst="referenceSeatId">${seatOptions}</select></td>
      <td><input data-inst="note" value="${escapeHtml(institution.note)}" placeholder="메모" /></td>
      <td><button class="mini-action" data-remove-institution type="button" aria-label="기관 삭제">×</button></td>`;
    tr.querySelector("[data-remove-institution]").addEventListener("click", () => tr.remove());
    return tr;
  }

  function openInstitutionsDialog() {
    const body = $("#institutions-body");
    body.replaceChildren();
    [...state.institutions].sort((a, b) => a.displayOrder - b.displayOrder).forEach((institution) => body.append(institutionRowTemplate(institution)));
    elements.institutionsDialog.showModal();
  }

  function saveInstitutions() {
    const rows = $$("#institutions-body tr");
    const institutions = rows.map((row, index) => ({
      id: row.dataset.institutionId,
      name: row.querySelector('[data-inst="name"]').value.trim(),
      role: row.querySelector('[data-inst="role"]').value,
      displayOrder: Number(row.querySelector('[data-inst="displayOrder"]').value) || index + 1,
      referenceSeatId: row.querySelector('[data-inst="referenceSeatId"]').value,
      note: row.querySelector('[data-inst="note"]').value.trim(),
    }));
    if (institutions.some((item) => !item.name)) {
      toast("모든 참여기관에 기관명을 입력해 주세요.", true);
      return;
    }
    const names = institutions.map((item) => item.name.toLocaleLowerCase("ko"));
    if (new Set(names).size !== names.length) {
      toast("같은 이름의 참여기관이 중복되어 있습니다.", true);
      return;
    }
    const kept = new Set(institutions.map((item) => item.id));
    transact(() => {
      state.institutions = institutions;
      state.event.organizations = [...institutions].sort((a, b) => a.displayOrder - b.displayOrder).map((item) => item.name).join(" · ");
      state.attendees.forEach((attendee) => {
        if (attendee.institutionId && !kept.has(attendee.institutionId)) attendee.institutionId = "";
      });
    }, `${institutions.length}개 참여기관을 저장했습니다.`);
    syncEventInputs();
    elements.institutionsDialog.close();
  }

  function suggestedReferenceMap(institutions) {
    const map = new Map();
    const sectionGroups = [
      institutions.filter((_, index) => index % 2 === 0),
      institutions.filter((_, index) => index % 2 === 1),
    ];
    ["main-left", "main-right"].forEach((section, sectionIndex) => {
      const seats = roomTemplate.seats.filter((seat) => seat.section === section).sort((a, b) => a.x - b.x);
      const group = sectionGroups[sectionIndex];
      group.forEach((institution, slot) => {
        const position = Math.round(((slot + 1) * (seats.length - 1)) / (group.length + 1));
        map.set(institution.id, seats[position]?.id || "");
      });
    });
    return map;
  }

  function openAutoLayoutDialog() {
    const list = $("#auto-reference-list");
    list.replaceChildren();
    const institutions = [...state.institutions].sort((a, b) => a.displayOrder - b.displayOrder);
    const suggestions = suggestedReferenceMap(institutions);
    const usedSuggestions = new Set(state.institutions.map((item) => item.referenceSeatId).filter(Boolean));
    institutions.forEach((institution) => {
      let selected = institution.referenceSeatId;
      if (!selected) {
        selected = suggestions.get(institution.id) || "";
        if (selected) usedSuggestions.add(selected);
      }
      const card = document.createElement("label");
      card.className = "reference-card";
      card.dataset.institutionId = institution.id;
      const options = roomTemplate.seats
        .filter((seat) => seat.section === "main-left" || seat.section === "main-right")
        .sort((a, b) => a.x - b.x || a.section.localeCompare(b.section))
        .map((seat) => `<option value="${seat.id}"${seat.id === selected ? " selected" : ""}>${seat.id}</option>`).join("");
      card.innerHTML = `<span><strong>${escapeHtml(institution.name)}</strong><small>${institutionRoleLabel(institution.role)}</small></span><select aria-label="${escapeHtml(institution.name)} 기준 좌석"><option value="">미지정</option>${options}</select>`;
      list.append(card);
    });
    $("#auto-include-head").checked = Boolean(state.settings.includeHeadInAuto);
    $("#auto-fill-staff").checked = state.settings.autoFillStaff !== false;
    elements.autoLayoutDialog.showModal();
    calculateAutoDraft();
  }

  function alternatingSeats(referenceSeat) {
    const sectionSeats = roomTemplate.seats.filter((seat) => seat.section === referenceSeat.section).sort((a, b) => a.x - b.x);
    const pivot = sectionSeats.findIndex((seat) => seat.id === referenceSeat.id);
    const ordered = [referenceSeat];
    for (let offset = 1; ordered.length < sectionSeats.length; offset += 1) {
      if (pivot + offset < sectionSeats.length) ordered.push(sectionSeats[pivot + offset]);
      if (pivot - offset >= 0) ordered.push(sectionSeats[pivot - offset]);
    }
    return ordered;
  }

  function calculateAutoDraft() {
    const errors = [];
    const warnings = [];
    const rows = [];
    const assignments = {};
    const usedSeats = new Set();
    const placedAttendees = new Set();
    const fixedAttendees = state.attendees.filter((attendee) => attendee.seatLocked && (attendee.fixedSeatId || assignedSeatFor(attendee.id)));
    for (const attendee of fixedAttendees) {
      const seatId = attendee.fixedSeatId || assignedSeatFor(attendee.id);
      if (!seatById.has(seatId)) {
        errors.push(`${attendee.name}: 고정 좌석이 유효하지 않습니다.`);
        continue;
      }
      if (usedSeats.has(seatId)) {
        errors.push(`${seatId}: 고정 좌석이 중복되었습니다.`);
        continue;
      }
      assignments[seatId] = attendee.id;
      usedSeats.add(seatId);
      placedAttendees.add(attendee.id);
      rows.push({ status: "고정", institution: institutionById(attendee.institutionId)?.name || "-", attendee: attendee.name, seatId, reason: "자리 고정" });
    }
    for (const [seatId, attendeeId] of Object.entries(state.assignments)) {
      const attendee = attendeeById(attendeeId);
      const isAutoEligible = attendee && attendee.type !== "배석" && attendee.institutionId && attendee.institutionRank;
      const isStaffEligible = attendee && attendee.type === "배석" && $("#auto-fill-staff").checked;
      if (!attendee || placedAttendees.has(attendeeId) || isAutoEligible || isStaffEligible) continue;
      if (!usedSeats.has(seatId)) {
        assignments[seatId] = attendeeId;
        usedSeats.add(seatId);
        placedAttendees.add(attendeeId);
      }
    }
    const referenceMap = new Map();
    $$("#auto-reference-list .reference-card").forEach((card) => referenceMap.set(card.dataset.institutionId, card.querySelector("select").value));
    const claimedReferences = new Map();
    for (const institution of [...state.institutions].sort((a, b) => a.displayOrder - b.displayOrder)) {
      const rankedAttendees = state.attendees
        .filter((attendee) => attendee.institutionId === institution.id && attendee.type !== "배석" && attendee.institutionRank)
        .sort((a, b) => a.institutionRank - b.institutionRank || a.name.localeCompare(b.name, "ko"));
      const attendees = rankedAttendees.filter((attendee) => !placedAttendees.has(attendee.id));
      if (!attendees.length) continue;
      const duplicateRanks = [...new Set(rankedAttendees
        .filter((attendee, index, all) => all.some((other, otherIndex) => otherIndex !== index && other.institutionRank === attendee.institutionRank))
        .map((attendee) => attendee.institutionRank))];
      if (duplicateRanks.length) errors.push(`${institution.name}: 기관 내 순위 중복 (${duplicateRanks.join(", ")})`);
      const referenceId = referenceMap.get(institution.id) || "";
      const referenceSeat = seatById.get(referenceId);
      if (!referenceSeat || !["main-left", "main-right"].includes(referenceSeat.section)) {
        errors.push(`${institution.name}: 기준 좌석을 지정해 주세요.`);
        attendees.forEach((attendee) => rows.push({ status: "충돌", institution: institution.name, attendee: attendee.name, seatId: "-", reason: "기준 좌석 없음" }));
        continue;
      }
      if (claimedReferences.has(referenceId)) {
        errors.push(`${referenceId}: ${claimedReferences.get(referenceId)}와 ${institution.name}의 기준 좌석이 중복됩니다.`);
      } else claimedReferences.set(referenceId, institution.name);
      if (usedSeats.has(referenceId)) {
        errors.push(`${institution.name}: 기준 좌석 ${referenceId}가 고정 또는 기존 배정과 충돌합니다.`);
        attendees.forEach((attendee) => rows.push({ status: "충돌", institution: institution.name, attendee: attendee.name, seatId: referenceId, reason: "기준 좌석 사용 중" }));
        continue;
      }
      const orderedSeats = alternatingSeats(referenceSeat);
      for (const attendee of attendees) {
        const seat = orderedSeats[rankedAttendees.indexOf(attendee)];
        if (!seat) {
          warnings.push(`${institution.name}: ${attendee.name}을 배치할 같은 장변 좌석이 부족합니다.`);
          rows.push({ status: "부족", institution: institution.name, attendee: attendee.name, seatId: "-", reason: "같은 장변 좌석 부족" });
          continue;
        }
        if (usedSeats.has(seat.id)) {
          errors.push(`${institution.name}: ${attendee.name}의 예정 좌석 ${seat.id}가 다른 기관 또는 고정석과 충돌합니다.`);
          rows.push({ status: "충돌", institution: institution.name, attendee: attendee.name, seatId: seat.id, reason: "기관별 확장 영역 충돌" });
          continue;
        }
        assignments[seat.id] = attendee.id;
        usedSeats.add(seat.id);
        placedAttendees.add(attendee.id);
        rows.push({ status: "초안", institution: institution.name, attendee: attendee.name, seatId: seat.id, reason: attendee.institutionRank === 1 ? "기관 기준 좌석" : `${attendee.institutionRank}순위 · 좌우 교차 확장` });
      }
    }
    if ($("#auto-include-head").checked && seatById.has("HEAD-01")) {
      const candidate = state.attendees.find((attendee) => attendee.type !== "배석" && !placedAttendees.has(attendee.id));
      if (candidate && !usedSeats.has("HEAD-01")) {
        assignments["HEAD-01"] = candidate.id;
        usedSeats.add("HEAD-01");
        placedAttendees.add(candidate.id);
        rows.push({ status: "초안", institution: institutionById(candidate.institutionId)?.name || "-", attendee: candidate.name, seatId: "HEAD-01", reason: "HEAD-01 사용 옵션" });
      }
    }
    if ($("#auto-fill-staff").checked) {
      const staffAttendees = state.attendees.filter((attendee) => attendee.type === "배석" && !placedAttendees.has(attendee.id));
      const staffSeats = roomTemplate.seats.filter((seat) => seat.section === "staff" && !usedSeats.has(seat.id)).sort((a, b) => a.number - b.number);
      staffAttendees.forEach((attendee, index) => {
        const seat = staffSeats[index];
        if (!seat) {
          warnings.push(`배석 부족: ${attendee.name}`);
          rows.push({ status: "부족", institution: institutionById(attendee.institutionId)?.name || "-", attendee: attendee.name, seatId: "-", reason: "배석 좌석 부족" });
          return;
        }
        assignments[seat.id] = attendee.id;
        usedSeats.add(seat.id);
        placedAttendees.add(attendee.id);
        rows.push({ status: "초안", institution: institutionById(attendee.institutionId)?.name || "-", attendee: attendee.name, seatId: seat.id, reason: `배석 빈자리 · ${seat.staffTableId || ""}` });
      });
    }
    autoDraft = { assignments, rows, errors, warnings, referenceMap };
    renderAutoDraft();
  }

  function renderAutoDraft() {
    const body = $("#auto-preview-body");
    body.replaceChildren();
    autoDraft.rows.forEach((row) => {
      const tr = document.createElement("tr");
      const tone = row.status === "충돌" ? "error" : row.status === "부족" ? "warning" : "";
      tr.innerHTML = `<td><span class="status-badge ${tone}">${row.status}</span></td><td>${escapeHtml(row.institution)}</td><td>${escapeHtml(row.attendee)}</td><td>${escapeHtml(row.seatId)}</td><td>${escapeHtml(row.reason)}</td>`;
      body.append(tr);
    });
    const summary = $("#auto-validation");
    summary.className = `validation-summary${autoDraft.errors.length ? " has-error" : autoDraft.warnings.length ? " has-warning" : ""}`;
    summary.textContent = autoDraft.errors.length ? `적용 불가 · ${autoDraft.errors.join(" · ")}` : autoDraft.warnings.length ? `확인 필요 · ${autoDraft.warnings.join(" · ")}` : `${autoDraft.rows.length}개 배정 초안 검증 완료`;
    $("#apply-auto-button").disabled = autoDraft.errors.length > 0;
  }

  function applyAutoDraft() {
    if (!autoDraft || autoDraft.errors.length) return;
    transact(() => {
      state.assignments = { ...autoDraft.assignments };
      state.settings.includeHeadInAuto = $("#auto-include-head").checked;
      state.settings.autoFillStaff = $("#auto-fill-staff").checked;
      for (const institution of state.institutions) institution.referenceSeatId = autoDraft.referenceMap.get(institution.id) || "";
    }, "자동배치 초안을 한 번의 작업으로 적용했습니다.");
    elements.autoLayoutDialog.close();
  }

  function openNameplateMaker() {
    const people = roomTemplate.seats
      .map((seat) => attendeeById(state.assignments[seat.id]))
      .filter(Boolean)
      .map((attendee) => ({ name: attendee.name, organization: attendee.org || institutionById(attendee.institutionId)?.name || "", position: attendee.title, logoKey: "default" }))
      .filter((person) => person.name || person.organization || person.position);
    if (!people.length) {
      toast("명패로 보낼 참석자가 없습니다.", true);
      return;
    }
    const localPreview = ["localhost", "127.0.0.1"].includes(location.hostname);
    const localNameplatePort = String((Number(location.port) || 4173) + 1);
    const targetOrigin = localPreview ? `${location.protocol}//${location.hostname}:${localNameplatePort}` : "https://erakeun.github.io";
    const child = window.open(`${targetOrigin}${localPreview ? "/" : "/nameplate-maker/"}`, "erica-nameplate-maker");
    if (!child) {
      toast("팝업이 차단되었습니다. 이 사이트의 팝업을 허용해 주세요.", true);
      return;
    }
    const payload = { type: "erica-seat-planner:nameplates:v1", source: "erica-seat-planner", transferId: crypto.randomUUID(), people };
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      child.postMessage(payload, targetOrigin);
      if (attempts >= 40) clearInterval(timer);
    }, 250);
    const onMessage = (event) => {
      if (event.origin === targetOrigin && event.source === child && event.data?.type === "erica-seat-planner:nameplates:accepted" && event.data.transferId === payload.transferId) {
        clearInterval(timer);
        window.removeEventListener("message", onMessage);
        toast(`${people.length}명의 명패 데이터를 전달했습니다.`);
      }
    };
    window.addEventListener("message", onMessage);
    child.postMessage(payload, targetOrigin);
  }

  async function exportPng() {
    try {
      const clone = elements.roomSvg.cloneNode(true);
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("viewBox", `0 0 ${SCENE.width} ${SCENE.height}`);
      clone.setAttribute("width", "1920");
      clone.setAttribute("height", "1080");
      const svgText = new XMLSerializer().serializeToString(clone);
      const image = new Image();
      image.decoding = "sync";
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 1920;
      canvas.height = 1240;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#1268b3";
      context.font = "700 18px sans-serif";
      context.textAlign = "center";
      context.fillText("HANYANG UNIVERSITY SEOUL", 960, 35);
      context.fillStyle = "#182638";
      context.font = "700 36px sans-serif";
      context.fillText(state.event.title || "신본관 회의실1 좌석배치", 960, 80);
      context.fillStyle = "#687586";
      context.font = "20px sans-serif";
      const meta = [formatDate(state.event.date), state.event.organizations, state.event.location].filter(Boolean).join(" · ");
      context.fillText(meta, 960, 116);
      context.drawImage(image, 0, 160, 1920, 1080);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 1));
      if (!blob) throw new Error("png-encode-failed");
      downloadBlob(blob, safeFilename("png"));
      toast("PNG 이미지를 저장했습니다.");
    } catch {
      toast("PNG 생성 중 문제가 발생했습니다.", true);
    }
  }

  function toast(message, error = false) {
    const item = document.createElement("div");
    item.className = `toast${error ? " error" : ""}`;
    item.textContent = message;
    elements.toastRegion.append(item);
    setTimeout(() => item.remove(), 2900);
  }

  function closeDataMenu() {
    elements.dataMenu.hidden = true;
    $("#data-menu-button").setAttribute("aria-expanded", "false");
  }

  function bindControls() {
    $("#add-attendee-button").addEventListener("click", () => openAttendeeDialog());
    $("#bulk-attendee-button").addEventListener("click", openBulkDialog);
    $("#institutions-button").addEventListener("click", openInstitutionsDialog);
    $("#institution-inline-button").addEventListener("click", openInstitutionsDialog);
    $("#auto-layout-button").addEventListener("click", openAutoLayoutDialog);
    $("#nameplate-button").addEventListener("click", openNameplateMaker);
    $("#save-attendee-button").addEventListener("click", saveAttendee);
    $("#delete-attendee-button").addEventListener("click", deleteCurrentAttendee);
    $("#clear-selection-button").addEventListener("click", () => selectAttendee(selectedAttendeeId));
    $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog")?.close()));
    $$('dialog').forEach((dialog) => dialog.addEventListener("pointerdown", (event) => {
      const rect = dialog.getBoundingClientRect();
      const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
      if (event.target === dialog || outside) dialog.close();
    }));
    elements.attendeeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      saveAttendee();
    });
    $("#download-example-csv-button").addEventListener("click", downloadExampleCsv);
    $("#choose-csv-button").addEventListener("click", () => $("#csv-file-input").click());
    $("#choose-seoul-xlsx-button").addEventListener("click", () => $("#seoul-xlsx-file-input").click());
    $("#bulk-preview-body").addEventListener("change", (event) => {
      const rowIndex = Number(event.target.dataset.bulkRow);
      const key = event.target.dataset.bulkKey;
      if (!Number.isInteger(rowIndex) || !key || !bulkPreviewRows[rowIndex]) return;
      bulkPreviewRows[rowIndex][key] = key === "fixedSeat" ? event.target.value.trim().toUpperCase() : event.target.value;
      renderBulkPreview();
    });
    $("#bulk-register-button").addEventListener("click", () => registerBulkRows(false));
    $("#bulk-register-auto-button").addEventListener("click", () => registerBulkRows(true));
    $("#add-institution-button").addEventListener("click", () => $("#institutions-body").append(institutionRowTemplate()));
    $("#save-institutions-button").addEventListener("click", saveInstitutions);
    $("#recalculate-auto-button").addEventListener("click", calculateAutoDraft);
    $("#apply-auto-button").addEventListener("click", applyAutoDraft);
    $("#auto-reference-list").addEventListener("change", calculateAutoDraft);
    $("#auto-include-head").addEventListener("change", calculateAutoDraft);
    $("#auto-fill-staff").addEventListener("change", calculateAutoDraft);
    $("#new-button").addEventListener("click", () => elements.resetDialog.showModal());
    $("#confirm-reset-button").addEventListener("click", () => {
      undoStack.push(snapshot());
      redoStack = [];
      state = defaultState();
      selectedAttendeeId = null;
      syncEventInputs();
      applyMode();
      fitView();
      renderAll();
      scheduleSave();
      toast("새 배치를 만들었습니다.");
    });

    $("#undo-button").addEventListener("click", () => {
      if (!undoStack.length) return;
      redoStack.push(snapshot());
      restore(undoStack.pop());
      toast("이전 상태로 되돌렸습니다.");
    });
    $("#redo-button").addEventListener("click", () => {
      if (!redoStack.length) return;
      undoStack.push(snapshot());
      restore(redoStack.pop());
      toast("다음 상태를 복원했습니다.");
    });

    $$("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
    $$("[data-filter]").forEach((button) => button.addEventListener("click", () => {
      attendeeFilter = button.dataset.filter;
      $$("[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
      renderAttendees();
    }));
    $("#attendee-search").addEventListener("input", (event) => {
      searchTerm = event.target.value;
      renderAttendees();
    });
    $("#seat-number-toggle").addEventListener("change", (event) => {
      state.settings.showSeatNumbers = event.target.checked;
      scheduleSave();
      renderSeats();
    });

    $("#zoom-in-button").addEventListener("click", () => zoomTo(view.zoom * 1.18));
    $("#zoom-out-button").addEventListener("click", () => zoomTo(view.zoom / 1.18));
    $("#fit-button").addEventListener("click", fitView);
    $("#reset-view-button").addEventListener("click", fitView);
    elements.roomSvg.addEventListener("pointerdown", startPan);
    elements.roomViewport.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = elements.roomSvg.getBoundingClientRect();
      const anchorX = ((event.clientX - rect.left) / rect.width) * SCENE.width;
      const anchorY = ((event.clientY - rect.top) / rect.height) * SCENE.height;
      zoomTo(view.zoom * (event.deltaY < 0 ? 1.12 : .89), anchorX, anchorY);
    }, { passive: false });

    $("#data-menu-button").addEventListener("click", (event) => {
      event.stopPropagation();
      elements.dataMenu.hidden = !elements.dataMenu.hidden;
      event.currentTarget.setAttribute("aria-expanded", String(!elements.dataMenu.hidden));
    });
    elements.dataMenu.addEventListener("click", (event) => {
      const action = event.target.dataset.action;
      if (!action) return;
      closeDataMenu();
      if (action === "json-export") exportJson();
      if (action === "json-import") $("#json-file-input").click();
      if (action === "csv-export") exportCsv();
      if (action === "csv-import") openBulkDialog();
      if (action === "seoul-xlsx-import") $("#seoul-xlsx-file-input").click();
    });
    document.addEventListener("click", closeDataMenu);
    $("#json-file-input").addEventListener("change", (event) => {
      if (event.target.files[0]) importJson(event.target.files[0]);
      event.target.value = "";
    });
    $("#csv-file-input").addEventListener("change", (event) => {
      if (event.target.files[0]) importCsv(event.target.files[0]);
      event.target.value = "";
    });
    $("#seoul-xlsx-file-input").addEventListener("change", (event) => {
      if (event.target.files[0]) importSeoulXlsx(event.target.files[0]);
      event.target.value = "";
    });
    $("#print-button").addEventListener("click", () => window.print());
    $("#png-button").addEventListener("click", exportPng);

    document.addEventListener("pointermove", onGlobalPointerMove, { passive: false });
    document.addEventListener("pointerup", onGlobalPointerUp);
    document.addEventListener("pointercancel", onGlobalPointerUp);
    document.addEventListener("keydown", (event) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
      if (event.key === "Escape" && selectedAttendeeId) selectAttendee(selectedAttendeeId);
      if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        (event.shiftKey ? $("#redo-button") : $("#undo-button")).click();
      }
      if (!typing && (event.key === "Backspace" || event.key === "Delete") && selectedAttendeeId && assignedSeatFor(selectedAttendeeId)) {
        event.preventDefault();
        unassignAttendee(selectedAttendeeId);
      }
    });
  }

  function registerWebMcpTools() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const controller = new AbortController();
    const reportError = () => {};

    try {
      void Promise.resolve(context.registerTool({
        name: "add_attendees",
        title: "참석자 일괄 추가",
        description: "신본관 회의실1 좌석배치에 한 명 이상의 참석자를 미배정 상태로 추가합니다.",
        inputSchema: {
          type: "object",
          properties: {
            attendees: {
              type: "array",
              minItems: 1,
              maxItems: 53,
              items: {
                type: "object",
                properties: {
                  name: { type: "string", minLength: 1, maxLength: 80 },
                  org: { type: "string", maxLength: 120 },
                  title: { type: "string", maxLength: 80 },
                  type: { type: "string", maxLength: 40 },
                  group: { type: "string", maxLength: 100 },
                  note: { type: "string", maxLength: 500 },
                },
                required: ["name"],
                additionalProperties: false,
              },
            },
          },
          required: ["attendees"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          if (!input || !Array.isArray(input.attendees) || !input.attendees.length) throw new Error("attendees 배열이 필요합니다.");
          const additions = input.attendees.map((item) => {
            if (!item || typeof item.name !== "string" || !item.name.trim()) throw new Error("모든 참석자에게 이름이 필요합니다.");
            return {
              id: crypto.randomUUID(),
              name: item.name.trim().slice(0, 80),
              org: String(item.org || "").trim().slice(0, 120),
              title: String(item.title || "").trim().slice(0, 80),
              type: String(item.type || "기타").trim().slice(0, 40),
              group: String(item.group || "").trim().slice(0, 100),
              note: String(item.note || "").trim().slice(0, 500),
            };
          });
          transact(() => state.attendees.push(...additions));
          return { added: additions.length, attendeeIds: additions.map((item) => item.id), totalAttendees: state.attendees.length };
        },
      }, { signal: controller.signal })).catch(reportError);

      void Promise.resolve(context.registerTool({
        name: "assign_seats",
        title: "좌석 일괄 배정",
        description: "참석자 ID를 신본관 회의실1 좌석 ID에 일괄 배정합니다. 기존 배정 좌석은 이동되며 대상 좌석 점유자는 미배정 처리됩니다.",
        inputSchema: {
          type: "object",
          properties: {
            assignments: {
              type: "array",
              minItems: 1,
              maxItems: 53,
              items: {
                type: "object",
                properties: { attendeeId: { type: "string" }, seatId: { type: "string" } },
                required: ["attendeeId", "seatId"],
                additionalProperties: false,
              },
            },
          },
          required: ["assignments"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          if (!input || !Array.isArray(input.assignments) || !input.assignments.length) throw new Error("assignments 배열이 필요합니다.");
          const attendeeIds = new Set();
          const seatIds = new Set();
          for (const assignment of input.assignments) {
            if (!attendeeById(assignment.attendeeId)) throw new Error(`참석자 ID를 찾을 수 없습니다: ${assignment.attendeeId}`);
            if (!seatById.has(assignment.seatId)) throw new Error(`좌석 ID를 찾을 수 없습니다: ${assignment.seatId}`);
            if (attendeeIds.has(assignment.attendeeId) || seatIds.has(assignment.seatId)) throw new Error("한 요청 안에서 참석자 또는 좌석이 중복되었습니다.");
            attendeeIds.add(assignment.attendeeId);
            seatIds.add(assignment.seatId);
          }
          transact(() => {
            for (const assignment of input.assignments) {
              const sourceSeat = assignedSeatFor(assignment.attendeeId);
              if (sourceSeat) delete state.assignments[sourceSeat];
              state.assignments[assignment.seatId] = assignment.attendeeId;
            }
          });
          return { assigned: input.assignments.length, totalAssigned: Object.keys(state.assignments).length };
        },
      }, { signal: controller.signal })).catch(reportError);
    } catch {
      controller.abort();
    }
  }

  function init() {
    $("#seat-id-list").replaceChildren(...roomTemplate.seats.map((seat) => new Option(seat.id, seat.id)));
    syncEventInputs();
    bindEventInputs();
    bindControls();
    applyMode();
    updateViewBox();
    renderRoom();
    renderAll();
    registerWebMcpTools();
  }

  init();
})();
