(() => {
  "use strict";

  const scene = Object.freeze({ width: 1600, height: 900 });
  const topCellUnits = [
    ["D6", 0, 1], ["E6", 1, 1], ["F6", 2, 1], ["G6", 3, 1], ["H6", 4, 1],
    ["I6", 5, 1], ["J6", 6, 1], ["K6", 7, 1], ["L6", 8, 1], ["M6", 9, 1],
    ["N6", 10, 1], ["O6", 11, 1], ["P6", 12, 2], ["R6", 14, 1], ["S6", 15, 1],
    ["T6", 16, 1], ["U6", 17, 1], ["V6", 18, 1], ["W6", 19, 1], ["X6", 20, 1],
    ["Y6", 21, 1], ["Z6", 22, 1], ["AA6", 23, 1], ["AB6", 24, 1],
  ];
  const lowerCells = Array.from({ length: 25 }, (_, index) => {
    const columnNumber = 4 + index;
    let column = "";
    let value = columnNumber;
    while (value > 0) {
      value -= 1;
      column = String.fromCharCode(65 + (value % 26)) + column;
      value = Math.floor(value / 26);
    }
    return `${column}12`;
  });
  const staffCells = ["S3", "U3", "W3", "Y3"];
  const xStart = 190;
  const xStep = 48;

  const topSeats = topCellUnits.map(([cell, unit, span], index) => Object.freeze({
    id: `SEOUL-UPPER-${String(index + 1).padStart(2, "0")}`,
    section: "main-left",
    displaySection: "upper-main",
    sectionLabel: "상단 메인석",
    number: index + 1,
    t: index / 23,
    x: xStart + (unit + (span - 1) / 2) * xStep,
    y: 320,
    direction: "down",
    width: span === 2 ? 82 : 42,
    height: 62,
    sourceCell: cell,
    sourceSpan: span,
    priorityCandidate: cell === "P6",
  }));

  const lowerSeats = lowerCells.map((cell, index) => Object.freeze({
    id: `SEOUL-LOWER-${String(index + 1).padStart(2, "0")}`,
    section: "main-right",
    displaySection: "lower-main",
    sectionLabel: "하단 메인석",
    number: index + 1,
    t: index / 24,
    x: xStart + index * xStep,
    y: 655,
    direction: "up",
    width: 42,
    height: 62,
    sourceCell: cell,
  }));

  const staffSeats = staffCells.map((cell, index) => Object.freeze({
    id: `SEOUL-STAFF-${String(index + 1).padStart(2, "0")}`,
    section: "staff",
    displaySection: "upper-staff",
    sectionLabel: "배석",
    staffTableId: `SEOUL-STAFF-MODULE-${String(index + 1).padStart(2, "0")}`,
    number: index + 1,
    x: xStart + (15 + index * 2) * xStep,
    y: 140,
    direction: "down",
    width: 48,
    height: 42,
    sourceCell: cell,
  }));

  window.SEOUL_ROOM_TEMPLATE = Object.freeze({
    id: "seoul-new-building-meeting-room-1",
    name: "신본관 회의실1",
    capacity: Object.freeze({ mainUpper: 24, mainLower: 25, staff: 4, total: 53 }),
    geometryConfidence: "spreadsheet-schematic",
    geometry: Object.freeze({
      scene,
      roomPath: "M70 55 H1530 V830 H70 Z",
      screen: Object.freeze({ x: 1482, y: 370, width: 20, height: 205 }),
      podium: Object.freeze({ x: 1370, y: 520, width: 95, height: 44 }),
      pc: Object.freeze({ x: 1370, y: 735, width: 78, height: 58 }),
      insideLabel: Object.freeze({ x: 760, y: 780 }),
      unconfirmedFixtures: Object.freeze([
        { x: 110, y: 400, width: 44, height: 42, sourceCell: "C7" },
        { x: 110, y: 480, width: 44, height: 42, sourceCell: "C9" },
        { x: 110, y: 560, width: 44, height: 42, sourceCell: "C11" },
        { x: 905, y: 760, width: 48, height: 42, sourceCell: "S14" },
        { x: 1001, y: 760, width: 48, height: 42, sourceCell: "U14" },
      ]),
      sourceDoors: Object.freeze([
        { x: 210, y: 810, width: 95, sourceRange: "D15:E15" },
        { x: 1180, y: 810, width: 95, sourceRange: "Y15:Z15" },
      ]),
    }),
    excelImport: Object.freeze({
      titleCell: "C1",
      titleIncludes: "신본관 회의실1",
      topCells: Object.freeze(topCellUnits.map(([cell]) => cell)),
      lowerCells: Object.freeze(lowerCells),
      staffCells: Object.freeze(staffCells),
    }),
    seats: Object.freeze([...topSeats, ...lowerSeats, ...staffSeats]),
  });
})();
