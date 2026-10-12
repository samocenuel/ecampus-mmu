import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { config } from '../config.js';
import { DAY_NAMES, toHHMM, toMinutes } from '../util.js';

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
  const stamp = `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
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
