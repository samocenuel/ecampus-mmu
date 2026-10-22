import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { config } from '../config.js';
import { DAY_NAMES, toHHMM, toMinutes, zonedNow } from '../util.js';

/** A UTC timestamp (Date or SQLite 'YYYY-MM-DD HH:MM:SS') as local 'YYYY-MM-DD HH:MM' in the university's timezone. */
function localStamp(university, at = new Date()) {
  const d = at instanceof Date ? at : new Date(String(at).replace(' ', 'T') + (String(at).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return String(at).slice(0, 16);
  const z = zonedNow(university?.timezone || 'UTC', d);
  return `${z.date} ${toHHMM(z.minutes)}`;
}

const hex = (c) => (/^#?[0-9a-f]{6}$/i.test(c || '') ? c.replace('#', '').toUpperCase() : '1E5AA8');

/** Mix a hex colour with white; amount 0 = original, 1 = white. */
function tint(c, amount) {
  const h = hex(c);
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return ch
    .map((v) => Math.round(v + (255 - v) * amount).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function gridShape(university, sessions) {
  const teaching = university.teaching_days.split(',').map(Number);
  const days = [...new Set([...teaching, ...sessions.map((s) => s.day_of_week)])].sort((a, b) => a - b);
  let start = toMinutes(university.day_start);
  let end = toMinutes(university.day_end);
  for (const s of sessions) {
    start = Math.min(start, Math.floor(toMinutes(s.start_time) / 60) * 60);
    end = Math.max(end, Math.ceil(toMinutes(s.end_time) / 60) * 60);
  }
  const slots = [];
  for (let t = start; t < end; t += 60) slots.push(t);
  return { days, slots, start, end };
}

const classNames = (s) => s.classes.map((c) => c.name).join(', ');
const lecturerName = (s) => [s.lecturer_title, s.lecturer_name].filter(Boolean).join(' ');

function sessionText(s, { showClasses = true } = {}) {
  return [
    `${s.course_code}${s.is_cross_cutting ? ' (CC)' : ''}`,
    s.course_name,
    lecturerName(s),
    `${s.room_name}${s.room_building ? ` - ${s.room_building}` : ''}`,
    showClasses ? classNames(s) : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function logoFile(university) {
  if (!university.logo_path) return null;
  const file = path.join(config.uploadDir, university.logo_path.replace(/^\/?uploads\//, ''));
  return /\.(png|jpe?g)$/i.test(file) && fs.existsSync(file) ? file : null;
}

export async function timetableXlsx({ university, title, subtitle, sessions, showClasses = true }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = university.name;
  wb.created = new Date();
  const primary = hex(university.primary_color);
  const { days, slots } = gridShape(university, sessions);

  const ws = wb.addWorksheet('Timetable', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    views: [{ state: 'frozen', ySplit: 5, xSplit: 1 }],
  });
  const lastCol = days.length + 1;
  ws.columns = [{ width: 14 }, ...days.map(() => ({ width: 30 }))];

  const banner = (row, text, size, bold, color) => {
    ws.mergeCells(row, 1, row, lastCol);
    const cell = ws.getCell(row, 1);
    cell.value = text;
    cell.font = { size, bold, color: { argb: `FF${color}` } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  };
  banner(1, university.name, 16, true, primary);
  banner(2, title, 13, true, '222222');
  banner(3, subtitle, 10, false, '666666');
  ws.getRow(1).height = 24;

  const header = ws.getRow(5);
  header.values = ['Time', ...days.map((d) => DAY_NAMES[d])];
  header.height = 22;
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${primary}` } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  const firstRow = 6;
  const border = { style: 'thin', color: { argb: 'FFD0D5DD' } };
  slots.forEach((t, i) => {
    const row = ws.getRow(firstRow + i);
    row.height = 62;
    row.getCell(1).value = `${toHHMM(t)} - ${toHHMM(t + 60)}`;
    row.getCell(1).font = { bold: true, color: { argb: 'FF444444' } };
    row.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
    for (let c = 1; c <= lastCol; c++) row.getCell(c).border = { top: border, left: border, bottom: border, right: border };
  });

  // occupancy[dayIdx][slotIdx] -> sessions covering that hour
  const span = (s) => {
    const a = slots.findIndex((t) => t <= toMinutes(s.start_time) && toMinutes(s.start_time) < t + 60);
    const b = slots.findIndex((t) => t < toMinutes(s.end_time) && toMinutes(s.end_time) <= t + 60);
    return [Math.max(a, 0), b < 0 ? slots.length - 1 : b];
  };
  const occ = days.map(() => slots.map(() => []));
  for (const s of sessions) {
    const d = days.indexOf(s.day_of_week);
    const [a, b] = span(s);
    for (let i = a; i <= b; i++) occ[d][i].push(s);
  }
  const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${tint(primary, 0.85)}` } };
  const ccFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4D6' } };
  const done = new Set();
  for (const s of sessions) {
    const d = days.indexOf(s.day_of_week);
    const [a, b] = span(s);
    const col = d + 2;
    const alone = occ[d].slice(a, b + 1).every((list) => list.length === 1);
    if (alone) {
      if (b > a) ws.mergeCells(firstRow + a, col, firstRow + b, col);
      const cell = ws.getCell(firstRow + a, col);
      cell.value = `${s.start_time}-${s.end_time}\n${sessionText(s, { showClasses })}`;
      cell.fill = s.is_cross_cutting ? ccFill : fill;
      cell.alignment = { wrapText: true, vertical: 'top' };
      cell.font = { size: 9 };
    } else {
      for (let i = a; i <= b; i++) {
        const key = `${d}:${i}`;
        if (done.has(key)) continue;
        done.add(key);
        const cell = ws.getCell(firstRow + i, col);
        cell.value = occ[d][i].map((x) => `${x.start_time}-${x.end_time} ${x.course_code} | ${x.room_name} | ${lecturerName(x)}`).join('\n');
        cell.fill = fill;
        cell.alignment = { wrapText: true, vertical: 'top' };
        cell.font = { size: 8 };
      }
    }
  }
  const legendRow = firstRow + slots.length + 1;
  ws.getCell(legendRow, 1).value = 'CC = cross-cutting course unit (shared across programmes)';
  ws.getCell(legendRow, 1).font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  const list = wb.addWorksheet('Sessions');
  list.columns = [
    { header: 'Day', key: 'day', width: 12 },
    { header: 'Start', key: 'start', width: 8 },
    { header: 'End', key: 'end', width: 8 },
    { header: 'Code', key: 'code', width: 12 },
    { header: 'Course unit', key: 'name', width: 36 },
    { header: 'Cross-cutting', key: 'cc', width: 13 },
    { header: 'Classes', key: 'classes', width: 40 },
    { header: 'Lecturer', key: 'lecturer', width: 26 },
    { header: 'Room', key: 'room', width: 18 },
    { header: 'Building', key: 'building', width: 18 },
  ];
  for (const s of sessions) {
    list.addRow({
      day: DAY_NAMES[s.day_of_week],
      start: s.start_time,
      end: s.end_time,
      code: s.course_code,
      name: s.course_name,
      cc: s.is_cross_cutting ? 'Yes' : 'No',
      classes: classNames(s),
      lecturer: lecturerName(s),
      room: s.room_name,
      building: s.room_building || '',
    });
  }
  list.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${primary}` } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });
  list.autoFilter = { from: 'A1', to: 'J1' };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function pdfToBuffer(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      build(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function pdfHeader(doc, university, title, subtitle) {
  const primary = `#${hex(university.primary_color)}`;
  const logo = logoFile(university);
  let x = doc.page.margins.left;
  const top = doc.page.margins.top;
  if (logo) {
    try {
      doc.image(logo, x, top, { fit: [42, 42] });
      x += 52;
    } catch {
      /* unreadable image - skip the logo */
    }
  }
  doc.font('Helvetica-Bold').fontSize(16).fillColor(primary).text(university.name, x, top, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#222222').text(title, x, top + 20, { lineBreak: false });
  doc.font('Helvetica').fontSize(8.5).fillColor('#666666').text(subtitle, x, top + 34, { lineBreak: false });
  const stamp = `Generated ${localStamp(university)}`;
  doc.fontSize(8).text(stamp, doc.page.width - doc.page.margins.right - 200, top, { width: 200, align: 'right' });
  return top + 52;
}

export function timetablePdf({ university, title, subtitle, sessions, showClasses = true }) {
  const primary = `#${hex(university.primary_color)}`;
  const light = `#${tint(primary, 0.86)}`;
  const { days, slots, start } = gridShape(university, sessions);

  return pdfToBuffer((doc) => {
    const gridTop = pdfHeader(doc, university, title, subtitle);
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const timeW = 52;
    const colW = (width - timeW) / days.length;
    const headH = 18;
    const bottom = doc.page.height - doc.page.margins.bottom - 14;
    const rowH = Math.min(56, (bottom - gridTop - headH) / Math.max(slots.length, 1));

    doc.rect(left, gridTop, width, headH).fill(primary);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF');
    doc.text('Time', left, gridTop + 5, { width: timeW, align: 'center' });
    days.forEach((d, i) => doc.text(DAY_NAMES[d], left + timeW + i * colW, gridTop + 5, { width: colW, align: 'center' }));

    const y0 = gridTop + headH;
    doc.lineWidth(0.5).strokeColor('#D0D5DD');
    slots.forEach((t, i) => {
      const y = y0 + i * rowH;
      if (i % 2 === 1) doc.rect(left, y, width, rowH).fill('#F7F8FA');
      doc.font('Helvetica').fontSize(7.5).fillColor('#444444').text(`${toHHMM(t)}\n${toHHMM(t + 60)}`, left, y + 4, { width: timeW, align: 'center' });
    });
    for (let i = 0; i <= slots.length; i++) doc.moveTo(left, y0 + i * rowH).lineTo(left + width, y0 + i * rowH).stroke();
    for (let i = 0; i <= days.length; i++) {
      const x = left + timeW + i * colW;
      doc.moveTo(x, y0).lineTo(x, y0 + slots.length * rowH).stroke();
    }
    doc.moveTo(left, y0).lineTo(left, y0 + slots.length * rowH).stroke();

    // Lay overlapping sessions side by side within a day column.
    for (const [di, d] of days.entries()) {
      const daySessions = sessions.filter((s) => s.day_of_week === d).sort((a, b) => a.start_time.localeCompare(b.start_time));
      const laneEnds = [];
      const placed = daySessions.map((s) => {
        let lane = laneEnds.findIndex((e) => e <= s.start_time);
        if (lane < 0) lane = laneEnds.length;
        laneEnds[lane] = s.end_time;
        return { s, lane };
      });
      const lanes = Math.max(laneEnds.length, 1);
      for (const { s, lane } of placed) {
        const w = colW / lanes;
        const x = left + timeW + di * colW + lane * w + 1.5;
        const y = y0 + ((toMinutes(s.start_time) - start) / 60) * rowH + 1.5;
        const h = ((toMinutes(s.end_time) - toMinutes(s.start_time)) / 60) * rowH - 3;
        doc.roundedRect(x, y, w - 3, h, 3).fill(s.is_cross_cutting ? '#FFF4D6' : light);
        doc.rect(x, y, 2.5, h).fill(primary);
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#111111');
        doc.text(`${s.course_code}${s.is_cross_cutting ? ' (CC)' : ''}  ${s.start_time}-${s.end_time}`, x + 5, y + 3, { width: w - 10, height: 10, ellipsis: true, lineBreak: false });
        const detail = [s.course_name, lecturerName(s), s.room_name, showClasses ? classNames(s) : null].filter(Boolean).join('\n');
        doc.font('Helvetica').fontSize(6.5).fillColor('#333333');
        doc.text(detail, x + 5, y + 13, { width: w - 10, height: Math.max(h - 15, 8), ellipsis: true });
      }
    }
    doc.font('Helvetica-Oblique').fontSize(7).fillColor('#666666')
      .text('CC = cross-cutting course unit (shared across programmes)', left, y0 + slots.length * rowH + 4, { lineBreak: false });

    if (sessions.length) {
      doc.addPage();
      let y = pdfHeader(doc, university, `${title} - session list`, subtitle);
      const cols = [
        ['Day', 70], ['Time', 70], ['Code', 70], ['Course unit', 170], ['Classes', 170], ['Lecturer', 140], ['Room', 96],
      ];
      const row = (values, bold, fillColor) => {
        if (y > doc.page.height - doc.page.margins.bottom - 20) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        if (fillColor) doc.rect(left, y - 3, width, 16).fill(fillColor);
        let x = left;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(bold ? '#FFFFFF' : '#222222');
        values.forEach((v, i) => {
          doc.text(String(v ?? ''), x + 3, y, { width: cols[i][1] - 6, height: 11, ellipsis: true, lineBreak: false });
          x += cols[i][1];
        });
        y += 16;
      };
      row(cols.map((c) => c[0]), true, primary);
      sessions.forEach((s, i) =>
        row(
          [DAY_NAMES[s.day_of_week], `${s.start_time}-${s.end_time}`, s.course_code, s.course_name, classNames(s), lecturerName(s), s.room_name],
          false,
          i % 2 ? '#F7F8FA' : null,
        ),
      );
    }
  });
}

/** Multi-sheet Excel workbook of a scoped report (see services/reports.js). */
export async function reportXlsx(university, report) {
  const wb = new ExcelJS.Workbook();
  const primary = hex(university.primary_color);
  const sheet = (name, columns, rows) => {
    const ws = wb.addWorksheet(name);
    ws.columns = columns.map(([header, key, width]) => ({ header, key, width: width || 18 }));
    rows.forEach((r) => ws.addRow(r));
    ws.getRow(1).eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${primary}` } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });
    return ws;
  };
  const summary = sheet('Summary', [['Metric', 'metric', 36], ['Value', 'value', 20]], [
    { metric: 'University', value: university.name },
    { metric: 'Scope', value: report.scope },
    { metric: 'Term', value: report.term?.name || '-' },
    ...Object.entries(report.counts).map(([k, v]) => ({ metric: k.replace(/_/g, ' '), value: v })),
    { metric: 'Average attendance (%)', value: report.attendance.average_rate ?? '-' },
    { metric: 'Registers pending approval', value: report.attendance.pending_registers },
  ]);
  summary.getColumn(1).font = { bold: true };
  sheet('Lecturer workload', [['Lecturer', 'name', 28], ['Department', 'department', 26], ['Units', 'units', 8], ['Allocated hrs/wk', 'allocated_hours', 16], ['Scheduled hrs/wk', 'scheduled_hours', 16]], report.workload);
  sheet('Course attendance', [['Code', 'code', 12], ['Course unit', 'name', 34], ['Classes', 'classes', 30], ['Lecturer', 'lecturer', 24], ['Lectures recorded', 'registers', 16], ['Attendance %', 'rate', 14]], report.attendance.by_course);
  sheet('Class attendance', [['Class', 'name', 28], ['Programme', 'program', 14], ['Students', 'students', 10], ['Lectures recorded', 'registers', 16], ['Attendance %', 'rate', 14]], report.attendance.by_class);
  sheet('Students at risk', [['Student', 'name', 28], ['Reg. no', 'identifier', 16], ['Class', 'class_name', 24], ['Attended', 'attended', 10], ['Lectures', 'total', 10], ['Attendance %', 'rate', 14]], report.attendance.at_risk);
  sheet('Room utilisation', [['Room', 'name', 20], ['Building', 'building', 18], ['Capacity', 'capacity', 10], ['Booked hrs/wk', 'booked_hours', 14], ['Utilisation %', 'utilisation', 14]], report.rooms);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Payment schedule for part-time claims: one row per claim, plus every claimed lecture and task. */
export async function claimsXlsx(university, title, claims, lines) {
  const wb = new ExcelJS.Workbook();
  const primary = hex(university.primary_color);
  const money = '#,##0.00';
  const sheet = (name, columns, rows) => {
    const ws = wb.addWorksheet(name);
    ws.addRow([`${university.name} - ${title}`]).font = { bold: true, size: 13 };
    ws.addRow([]);
    const head = ws.addRow(columns.map(([header]) => header));
    head.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${primary}` } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });
    columns.forEach(([, key, width, fmt], i) => {
      ws.getColumn(i + 1).width = width || 16;
      if (fmt) ws.getColumn(i + 1).numFmt = fmt;
    });
    rows.forEach((r) => ws.addRow(columns.map(([, key]) => r[key] ?? '')));
    return ws;
  };
  const schedule = sheet(
    'Payment schedule',
    [
      ['Claim', 'id', 8], ['Lecturer', 'lecturer_name', 26], ['Staff no.', 'lecturer_identifier', 12], ['Department', 'department_name', 24],
      ['Faculty', 'faculty_name', 26], ['Period', 'title', 18], ['Lectures', 'lecture_count', 10], ['Teaching hours', 'teaching_hours', 14],
      ['Tasks', 'task_count', 8], [`Amount (${university.currency || 'UGX'})`, 'total', 16, money], ['Status', 'status_label', 18], ['Payment ref.', 'payment_reference', 16],
    ],
    claims,
  );
  const sum = claims.reduce((t, c) => t + Number(c.total || 0), 0);
  const totalRow = schedule.addRow(['', 'Total', '', '', '', '', '', '', '', sum]);
  totalRow.font = { bold: true };
  totalRow.getCell(10).numFmt = money;
  sheet(
    'Claim details',
    [
      ['Claim', 'claim_id', 8], ['Lecturer', 'lecturer_name', 24], ['Date', 'work_date', 12], ['Time', 'time', 13], ['Item', 'rate_name', 22],
      ['Course unit', 'course_unit', 30], ['Classes', 'class_names', 26], ['Students present', 'attendance', 16], ['Details', 'description', 30],
      ['Quantity', 'quantity', 10], ['Unit', 'unit', 10], ['Rate', 'unit_price', 12, money], ['Amount', 'amount', 14, money],
    ],
    lines.map((l) => ({
      ...l,
      time: l.start_time ? `${l.start_time}-${l.end_time}` : '',
      course_unit: l.course_unit_code ? `${l.course_unit_code} ${l.course_unit_name}` : '',
      attendance: l.students_total ? `${l.students_present} of ${l.students_total}` : '',
    })),
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Examination timetable as a spreadsheet: one row per exam room. */
export async function examsXlsx(university, title, exams) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Exams');
  const primary = hex(university.primary_color);
  ws.addRow([`${university.name} - ${title}`]).font = { bold: true, size: 13 };
  ws.addRow([]);
  const columns = [['Date', 12], ['Day', 11], ['Time', 13], ['Code', 10], ['Course unit', 32], ['Classes', 30], ['Students', 10], ['Room', 18], ['Seats', 8], ['Invigilators', 34]];
  const head = ws.addRow(columns.map(([h]) => h));
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${primary}` } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });
  columns.forEach(([, w], i) => {
    ws.getColumn(i + 1).width = w;
  });
  for (const e of exams) {
    const day = DAY_NAMES[new Date(`${e.exam_date}T12:00:00Z`).getUTCDay() || 7];
    const rooms = e.rooms.length ? e.rooms : [{ name: '-', seats: '' }];
    rooms.forEach((r, i) => {
      ws.addRow([
        i ? '' : e.exam_date,
        i ? '' : day,
        i ? '' : `${e.start_time}-${e.end_time}`,
        i ? '' : e.course_code,
        i ? '' : e.course_name,
        i ? '' : e.classes.map((c) => c.name).join(', '),
        i ? '' : e.students,
        r.name,
        r.seats,
        e.invigilators.filter((p) => p.room_id === r.id || (!p.room_id && i === 0)).map((p) => p.name).join(', '),
      ]);
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function examsPdf(university, title, exams) {
  const primary = `#${hex(university.primary_color)}`;
  return pdfToBuffer((doc) => {
    let y = pdfHeader(doc, university, title, `${exams.length} exams`);
    const left = doc.page.margins.left;
    const cols = [['Date / time', 110], ['Course unit', 210], ['Classes', 170], ['Rooms (seats)', 130], ['Invigilators', 160]];
    const drawHead = () => {
      let x = left;
      doc.rect(left, y, cols.reduce((t, [, w]) => t + w, 0), 18).fill(primary);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
      for (const [h, w] of cols) {
        doc.text(h, x + 4, y + 5, { width: w - 8, lineBreak: false });
        x += w;
      }
      y += 20;
    };
    drawHead();
    doc.font('Helvetica').fontSize(8.5).fillColor('#222222');
    for (const e of exams) {
      const day = DAY_NAMES[new Date(`${e.exam_date}T12:00:00Z`).getUTCDay() || 7];
      const cells = [
        `${day} ${e.exam_date}\n${e.start_time}-${e.end_time}`,
        `${e.course_code} ${e.course_name}\n${e.students} students`,
        e.classes.map((c) => c.name).join(', '),
        e.rooms.map((r) => `${r.name} (${r.seats})`).join(', '),
        e.invigilators.map((p) => p.name).join(', '),
      ];
      const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: cols[i][1] - 8 }))) + 8;
      if (y + h > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHead();
        doc.font('Helvetica').fontSize(8.5).fillColor('#222222');
      }
      let x = left;
      cells.forEach((c, i) => {
        doc.text(c, x + 4, y + 4, { width: cols[i][1] - 8 });
        x += cols[i][1];
      });
      doc.moveTo(left, y + h).lineTo(x, y + h).strokeColor('#E4E7EC').lineWidth(0.5).stroke();
      y += h;
    }
  });
}

/** A paid claim's payslip (or, before payment, the claim form) with the approval trail. */
export function payslipPdf(university, claim, lines, events) {
  const primary = `#${hex(university.primary_color)}`;
  const money = (n) => `${claim.currency} ${Number(n || 0).toLocaleString('en', { maximumFractionDigits: 2 })}`;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      let y = pdfHeader(doc, university, claim.status === 'paid' ? 'Part-time payslip' : 'Part-time pay claim', `${claim.title} · ${claim.status_label || claim.status}`);
      const left = doc.page.margins.left;
      const width = doc.page.width - left - doc.page.margins.right;
      const info = [
        ['Lecturer', [claim.lecturer_title, claim.lecturer_name].filter(Boolean).join(' ')],
        ['Staff number', claim.lecturer_identifier || '-'],
        ['Department', claim.department_name || '-'],
        ['Faculty', claim.faculty_name || '-'],
        ['Period', `${claim.period_start} to ${claim.period_end}`],
        ['Payment reference', claim.payment_reference || '-'],
      ];
      doc.font('Helvetica').fontSize(9.5);
      for (const [k, v] of info) {
        doc.fillColor('#667085').text(k, left, y, { width: 120 });
        doc.fillColor('#101828').text(v, left + 120, y, { width: width - 120 });
        y += 15;
      }
      y += 8;
      const cols = [['Date', 70], ['Item', 210], ['Quantity', 70], ['Rate', 80], ['Amount', width - 430]];
      const row = (cells, bold = false, fill = null) => {
        const h = Math.max(...cells.map((c, i) => doc.heightOfString(String(c), { width: cols[i][1] - 8 }))) + 8;
        if (y + h > doc.page.height - 60) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        if (fill) doc.rect(left, y, width, h).fill(fill);
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(fill === primary ? '#FFFFFF' : '#101828');
        let x = left;
        cells.forEach((c, i) => {
          doc.text(String(c), x + 4, y + 4, { width: cols[i][1] - 8, align: i >= 2 ? 'right' : 'left' });
          x += cols[i][1];
        });
        y += h;
      };
      row(cols.map(([h]) => h), true, primary);
      for (const l of lines) {
        const item = l.kind === 'teaching' ? `Teaching ${l.course_unit_code || ''} ${l.start_time || ''}-${l.end_time || ''} (${l.class_names || ''})` : `${l.rate_name}: ${l.description || ''}`;
        row([l.work_date, item, `${Number(l.quantity)} ${l.unit}${Number(l.quantity) === 1 ? '' : 's'}`, money(l.unit_price), money(l.amount)]);
      }
      row(['', 'Total', '', '', money(claim.total)], true, '#F2F4F7');
      y += 14;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(primary).text('Approvals', left, y);
      y += 16;
      doc.font('Helvetica').fontSize(9).fillColor('#101828');
      for (const e of events) {
        doc.text(`${localStamp(university, e.created_at)}  ${e.action}${e.stage ? ` (${e.stage})` : ''} by ${e.actor_name || '-'}${e.note ? ` - ${e.note}` : ''}`, left, y, { width });
        y = doc.y + 4;
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
