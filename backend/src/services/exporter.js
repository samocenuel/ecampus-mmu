import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
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

/** Report tables (one per section) shared by the Excel and PDF exports. Columns: [header, key, Excel width, PDF weight, kind]. */
function reportTables(report) {
  const has = (k) => report.sections.includes(k);
  const rate = (v) => (v === null || v === undefined ? '-' : v);
  const t = [];
  if (has('departments') && report.departments.length) {
    t.push({
      title: 'Departments',
      columns: [['Department', 'name', 30, 3], ['Faculty', 'faculty_name', 30, 3], ['HoD', 'hod_name', 24, 2.2], ['Programmes', 'programs', 12, 1.3], ['Classes', 'classes', 10, 1], ['Students', 'students', 10, 1], ['Lecturers', 'lecturers', 10, 1], ['Units', 'allocations', 8, 0.8], ['Attendance %', 'attendance_rate', 14, 1.2, 'rate']],
      rows: report.departments.map((d) => ({ ...d, attendance_rate: rate(d.attendance_rate) })),
    });
  }
  if (has('workload')) {
    t.push({
      title: 'Lecturer workload',
      columns: [['Lecturer', 'name', 28, 2.6], ['Department', 'department', 26, 2.4], ['Units', 'units', 8, 0.8], ['Allocated hrs/wk', 'allocated_hours', 16, 1.3], ['Scheduled hrs/wk', 'scheduled_hours', 16, 1.3], ['Min-max hrs/wk', 'limits', 14, 1.2], ['Internal part-time hrs/wk', 'part_time_hours', 18, 1.5], ['Load', 'status', 16, 1.5]],
      rows: report.workload.map((w) => ({ ...w, limits: `${w.min_hours}-${w.max_hours}`, part_time_hours: w.part_time_hours || '' })),
    });
  }
  if (has('course_attendance')) {
    t.push({
      title: 'Attendance by course unit',
      columns: [['Code', 'code', 12, 1], ['Course unit', 'name', 34, 3], ['Classes', 'classes', 30, 2.6], ['Lecturer', 'lecturer', 24, 2], ['Lectures recorded', 'registers', 16, 1.1], ['Attendance %', 'rate', 14, 1.1, 'rate']],
      rows: report.attendance.by_course.map((c) => ({ ...c, code: c.is_cross_cutting ? `${c.code} (CC)` : c.code, rate: rate(c.rate) })),
    });
  }
  if (has('class_attendance')) {
    t.push({
      title: 'Attendance by class',
      columns: [['Class', 'name', 28, 3], ['Programme', 'program', 14, 1.4], ['Students', 'students', 10, 1], ['Lectures recorded', 'registers', 16, 1.2], ['Attendance %', 'rate', 14, 1.2, 'rate']],
      rows: report.attendance.by_class.map((c) => ({ ...c, rate: rate(c.rate) })),
    });
  }
  if (has('at_risk')) {
    t.push({
      title: `Students at risk (below ${report.attendance.at_risk_threshold}%)`,
      columns: [['Student', 'name', 28, 3], ['Reg. no', 'identifier', 16, 1.6], ['Class', 'class_name', 24, 2.4], ['Attended', 'attended', 10, 1], ['Lectures', 'total', 10, 1], ['Attendance %', 'rate', 14, 1.2, 'rate']],
      rows: report.attendance.at_risk,
      empty: 'No students below the threshold',
    });
  }
  if (has('missed')) {
    t.push({
      title: `Lectures with no attendance (${report.missed.from || ''} to ${report.missed.to || ''})`,
      columns: [['Date', 'date', 12, 1.1], ['Time', 'time', 13, 1.1], ['Code', 'course_code', 12, 1], ['Course unit', 'course_name', 32, 3], ['Classes', 'class_names', 28, 2.4], ['Lecturer', 'lecturer_name', 24, 2], ['Room', 'room_name', 14, 1.2]],
      rows: report.missed.items.map((o) => ({ ...o, time: `${o.start_time}-${o.end_time}`, class_names: o.classes.map((c) => c.name).join(', ') })),
      empty: 'Every lecture had attendance taken',
    });
  }
  if (has('rooms') && report.rooms.length) {
    t.push({
      title: 'Room utilisation',
      columns: [['Room', 'name', 20, 2], ['Building', 'building', 18, 2], ['Capacity', 'capacity', 10, 1], ['Booked hrs/wk', 'booked_hours', 14, 1.2], ['Utilisation %', 'utilisation', 14, 1.2]],
      rows: report.rooms,
    });
  }
  return t;
}

/** Headline figures for the summary sheet / page. */
function reportSummary(report) {
  const c = report.counts;
  const a = report.attendance;
  const al = report.allocation;
  const lecturer = report.role === 'lecturer';
  const rows = [];
  if (report.sections.includes('summary')) {
    if (['admin', 'dean'].includes(report.role)) rows.push(['Departments', c.departments]);
    if (!lecturer) rows.push(['Programmes', c.programs]);
    rows.push(['Classes', c.classes], ['Students', c.students]);
    if (!lecturer) rows.push(['Lecturers', c.lecturers]);
    rows.push(
      ['Course units allocated', `${c.course_units_allocated} (${c.cross_cutting_allocated} cross-cutting)`],
      ['Weekly teaching', `${c.weekly_teaching_hours} h in ${c.weekly_sessions} sessions`],
      ['Average attendance', a.average_rate === null ? '-' : `${a.average_rate}%`],
      ['Registers approved / awaiting / rejected', `${a.approved_registers} / ${a.pending_registers} / ${a.rejected_registers}`],
      ['Students at risk', `${a.at_risk.length} below ${a.at_risk_threshold}%`],
    );
  }
  if (report.sections.includes('allocation') && !lecturer) {
    rows.push(['Cross-cutting units allocated', `${al.cross_cutting_allocated} of ${al.cross_cutting_pairs}`]);
    rows.push(['Programme units allocated', `${al.other_allocated} of ${al.other_pairs}`]);
  }
  return rows;
}

const reportSubtitle = (report) => [report.scope, report.term?.name || 'All terms', ...report.filters.labels].join(' · ');

/** Excel workbook of a scoped, filtered report (see services/reports.js): a summary sheet and one sheet per section. */
export async function reportXlsx(university, report) {
  const wb = new ExcelJS.Workbook();
  const primary = hex(university.primary_color);
  const head = (row) =>
    row.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${primary}` } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });
  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 40 }, { width: 70 }];
  summary.addRow([university.name]).font = { bold: true, size: 13 };
  summary.addRow(['Report', reportSubtitle(report)]);
  summary.addRow(['Generated', localStamp(university)]);
  summary.addRow([]);
  for (const r of [2, 3]) summary.getRow(r).getCell(1).font = { bold: true };
  const figures = reportSummary(report);
  if (figures.length) {
    head(summary.addRow(['Measure', 'Value']));
    for (const [k, v] of figures) summary.addRow([k, v]);
  }
  const threshold = report.attendance.at_risk_threshold;
  const used = new Set(['Summary']);
  for (const table of reportTables(report)) {
    let name = table.title.replace(/[\\/?*[\]:]/g, '').slice(0, 31);
    while (used.has(name)) name = `${name.slice(0, 28)} ${used.size}`;
    used.add(name);
    const ws = wb.addWorksheet(name);
    ws.columns = table.columns.map(([header, key, width]) => ({ header, key, width: width || 18 }));
    head(ws.getRow(1));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const row of table.rows) {
      const added = ws.addRow(Object.fromEntries(table.columns.map(([, key]) => [key, row[key] ?? ''])));
      table.columns.forEach(([, key, , , kind], i) => {
        if (kind === 'rate' && typeof row[key] === 'number' && row[key] < threshold) added.getCell(i + 1).font = { color: { argb: 'FFB42318' }, bold: true };
      });
    }
    if (table.rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.columns.length } };
    else ws.addRow([table.empty || 'Nothing to show for these filters']);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The same report as a landscape PDF: summary figures, then a table per section. */
export function reportPdf(university, report) {
  const primary = `#${hex(university.primary_color)}`;
  const threshold = report.attendance.at_risk_threshold;
  return pdfToBuffer((doc) => {
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 14;
    let y = pdfHeader(doc, university, 'Report', reportSubtitle(report));
    const ensure = (h) => {
      if (y + h <= bottom()) return false;
      doc.addPage();
      y = doc.page.margins.top;
      return true;
    };
    const figures = reportSummary(report);
    if (figures.length) {
      const per = 4;
      const boxW = (width - (per - 1) * 8) / per;
      figures.forEach(([k, v], i) => {
        const col = i % per;
        if (col === 0 && i) y += 44;
        if (col === 0) ensure(40);
        const x = left + col * (boxW + 8);
        doc.roundedRect(x, y, boxW, 38, 4).fillAndStroke('#F7F8FA', '#E4E7EC');
        doc.font('Helvetica').fontSize(7.5).fillColor('#667085').text(k, x + 8, y + 6, { width: boxW - 16, lineBreak: false, ellipsis: true });
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#101828').text(String(v), x + 8, y + 19, { width: boxW - 16, lineBreak: false, ellipsis: true });
      });
      y += 54;
    }
    for (const table of reportTables(report)) {
      const total = table.columns.reduce((n, c) => n + c[3], 0);
      const cols = table.columns.map((c) => ({ header: c[0], key: c[1], kind: c[4], w: (c[3] / total) * width }));
      const drawHead = () => {
        doc.rect(left, y, width, 17).fill(primary);
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF');
        let x = left;
        for (const c of cols) {
          doc.text(c.header, x + 4, y + 5, { width: c.w - 8, height: 9, lineBreak: false, ellipsis: true });
          x += c.w;
        }
        y += 19;
      };
      ensure(60);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#101828').text(table.title, left, y, { lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor('#667085').text(`${table.rows.length} row${table.rows.length === 1 ? '' : 's'}`, left, y + 2, { width, align: 'right', lineBreak: false });
      y += 17;
      drawHead();
      if (!table.rows.length) {
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#667085').text(table.empty || 'Nothing to show for these filters', left + 4, y + 2, { lineBreak: false });
        y += 18;
      }
      table.rows.forEach((row, i) => {
        doc.font('Helvetica').fontSize(8);
        const cells = cols.map((c) => String(row[c.key] ?? ''));
        const h = Math.max(14, ...cells.map((text, k) => doc.heightOfString(text, { width: cols[k].w - 8 }) + 5));
        if (ensure(h)) drawHead();
        if (i % 2) doc.rect(left, y - 1, width, h).fill('#F7F8FA');
        let x = left;
        cells.forEach((text, k) => {
          const low = cols[k].kind === 'rate' && typeof row[cols[k].key] === 'number' && row[cols[k].key] < threshold;
          doc.font(low ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(low ? '#B42318' : '#222222').text(text, x + 4, y + 2, { width: cols[k].w - 8 });
          x += cols[k].w;
        });
        y += h;
      });
      y += 14;
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7.5).fillColor('#98A2B3').text(`${university.name} · ${reportSubtitle(report)} · page ${i + 1} of ${range.count}`, left, doc.page.height - keep + 8, { width, align: 'center', lineBreak: false, ellipsis: true });
      doc.page.margins.bottom = keep;
    }
  });
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

const METHOD_TEXT = { qr: 'Phone', manual: 'Manual', rep: 'Class rep', correction: 'Correction' };
const shortDate = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const pct = (a, t) => (t ? Math.round((a / t) * 1000) / 10 : null);

function styleHead(row, primary) {
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${primary}` } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
}

/** One lecture's attendance list for one class. */
export async function registerXlsx(university, reg, students) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Attendance');
  const primary = hex(university.primary_color);
  ws.addRow([university.name]).font = { bold: true, size: 14, color: { argb: `FF${primary}` } };
  ws.addRow([`Attendance: ${reg.course_code} ${reg.course_name}`]).font = { bold: true, size: 12 };
  ws.addRow([`${reg.class_name} · ${reg.lecture_date} ${reg.start_time}-${reg.end_time} · ${reg.room_name} · ${reg.lecturer_name}`]);
  const present = students.filter((s) => s.present).length;
  ws.addRow([`${present} of ${students.length} present · register ${reg.status}${reg.reviewed_by_name ? ` (${reg.reviewed_by_name})` : ''}${reg.topic ? ` · Topic: ${reg.topic}` : ''}`]);
  ws.addRow([]);
  styleHead(ws.addRow(['No.', 'Reg. No', 'Name', 'Attendance', 'How']), primary);
  [6, 18, 32, 13, 13].forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
  students.forEach((s, i) => {
    const row = ws.addRow([i + 1, s.identifier || '', s.name, s.present ? 'Present' : 'Absent', s.present ? METHOD_TEXT[s.method] || '' : '']);
    row.getCell(4).font = { color: { argb: s.present ? 'FF067647' : 'FFB42318' }, bold: true };
  });
  ws.views = [{ state: 'frozen', ySplit: 6 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function registerPdf(university, reg, students) {
  const primary = `#${hex(university.primary_color)}`;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      let y = pdfHeader(doc, university, `Attendance: ${reg.course_code} ${reg.course_name}`, `${reg.class_name} · ${reg.lecture_date} ${reg.start_time}-${reg.end_time}`);
      const left = doc.page.margins.left;
      const width = doc.page.width - left - doc.page.margins.right;
      const present = students.filter((s) => s.present).length;
      const taken = reg.source === 'qr' ? ' (QR check-in)' : reg.submitted_by_name ? `, taken by ${reg.submitted_by_name}` : '';
      const info = [
        ['Lecturer', reg.lecturer_name],
        ['Room', reg.room_name],
        ['Students present', `${present} of ${students.length}`],
        ['Register', `${reg.status}${reg.reviewed_by_name ? ` by ${reg.reviewed_by_name}` : ''}${taken}`],
        ...(reg.topic ? [['Topic', reg.topic]] : []),
      ];
      doc.font('Helvetica').fontSize(9.5);
      for (const [k, v] of info) {
        doc.fillColor('#667085').text(k, left, y, { width: 110 });
        doc.fillColor('#101828').text(String(v ?? '-'), left + 110, y, { width: width - 110 });
        y += 15;
      }
      y += 8;
      const cols = [['No.', 32], ['Reg. No', 110], ['Name', width - 32 - 110 - 80 - 80], ['Attendance', 80], ['How', 80]];
      const head = () => {
        doc.rect(left, y, width, 18).fill(primary);
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF');
        let x = left;
        for (const [h, w] of cols) {
          doc.text(h, x + 4, y + 5, { width: w - 8, lineBreak: false });
          x += w;
        }
        y += 20;
      };
      head();
      students.forEach((s, i) => {
        if (y + 16 > doc.page.height - 70) {
          doc.addPage();
          y = doc.page.margins.top;
          head();
        }
        if (i % 2) doc.rect(left, y - 2, width, 16).fill('#F9FAFB');
        const cells = [String(i + 1), s.identifier || '', s.name, s.present ? 'Present' : 'Absent', s.present ? METHOD_TEXT[s.method] || '' : ''];
        let x = left;
        cells.forEach((c, ci) => {
          doc.font(ci === 3 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(ci === 3 ? (s.present ? '#067647' : '#B42318') : '#101828');
          doc.text(c, x + 4, y + 2, { width: cols[ci][1] - 8, lineBreak: false, ellipsis: true });
          x += cols[ci][1];
        });
        y += 16;
      });
      y += 30;
      if (y > doc.page.height - 60) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      doc.font('Helvetica').fontSize(9).fillColor('#344054');
      doc.text(
        reg.status === 'approved' && reg.reviewed_at
          ? `Approved in eCampus by ${reg.reviewed_by_name || 'the lecturer'} on ${localStamp(university, reg.reviewed_at)}.`
          : `Not yet approved: ${reg.status}.`,
        left,
        y,
        { width },
      );
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * A course unit's attendance for one class over the term: one column per lecture (P / A),
 * then lectures attended, total and percentage. `lectures` are approved registers in date order;
 * `students[i].marks` maps register id to 1 (present) or 0.
 */
export async function attendanceSheetXlsx(university, meta, lectures, students) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Attendance', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  const primary = hex(university.primary_color);
  const threshold = Number(university.exam_min_attendance ?? 75);
  ws.addRow([university.name]).font = { bold: true, size: 14, color: { argb: `FF${primary}` } };
  ws.addRow([`Attendance: ${meta.course_code} ${meta.course_name} · ${meta.class_name}`]).font = { bold: true, size: 12 };
  ws.addRow([`${meta.term_name || ''} · Lecturer: ${meta.lecturer_name} · ${lectures.length} lectures with approved attendance · P = present, A = absent`]);
  ws.addRow([]);
  const head = ws.addRow(['No.', 'Reg. No', 'Name', ...lectures.map((l) => `${shortDate(l.lecture_date)}\n${l.start_time}`), 'Attended', 'Lectures', '%']);
  styleHead(head, primary);
  head.height = 30;
  ws.getColumn(1).width = 6;
  ws.getColumn(2).width = 18;
  ws.getColumn(3).width = 30;
  lectures.forEach((_, i) => {
    ws.getColumn(4 + i).width = 7;
  });
  const end = 4 + lectures.length;
  ws.getColumn(end).width = 10;
  ws.getColumn(end + 1).width = 10;
  ws.getColumn(end + 2).width = 8;
  students.forEach((s, i) => {
    const marks = lectures.map((l) => (s.marks.get(l.id) === undefined ? '' : s.marks.get(l.id) ? 'P' : 'A'));
    const attended = marks.filter((m) => m === 'P').length;
    const total = marks.filter((m) => m).length;
    const rate = pct(attended, total);
    const row = ws.addRow([i + 1, s.identifier || '', s.name, ...marks, attended, total, rate ?? '']);
    marks.forEach((m, mi) => {
      const cell = row.getCell(4 + mi);
      cell.alignment = { horizontal: 'center' };
      if (m === 'A') cell.font = { color: { argb: 'FFB42318' }, bold: true };
    });
    const rc = row.getCell(end + 2);
    if (rate !== null && rate < threshold) {
      rc.font = { color: { argb: 'FFB42318' }, bold: true };
      rc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE4E2' } };
    }
  });
  ws.views = [{ state: 'frozen', ySplit: 5, xSplit: 3 }];
  ws.addRow([]);
  ws.addRow([`Students below ${threshold}% are highlighted (exam attendance requirement).`]).font = { italic: true, size: 9, color: { argb: 'FF666666' } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function attendanceSheetPdf(university, meta, lectures, students) {
  const primary = `#${hex(university.primary_color)}`;
  const threshold = Number(university.exam_min_attendance ?? 75);
  const PER_PAGE = 20;
  const parts = [];
  for (let i = 0; i < Math.max(lectures.length, 1); i += PER_PAGE) parts.push(lectures.slice(i, i + PER_PAGE));
  return pdfToBuffer((doc) => {
    parts.forEach((part, pi) => {
      if (pi) doc.addPage();
      const title = `Attendance: ${meta.course_code} ${meta.course_name} · ${meta.class_name}`;
      const range = parts.length > 1 ? ` · lectures ${pi * PER_PAGE + 1}-${pi * PER_PAGE + part.length}` : '';
      const subtitle = `${meta.term_name || ''} · ${meta.lecturer_name} · ${lectures.length} lectures${range} · P present, A absent`;
      let y = pdfHeader(doc, university, title, subtitle);
      const left = doc.page.margins.left;
      const fixed = [['No.', 22], ['Reg. No', 78], ['Name', 130]];
      const dateW = 24;
      const tail = [['Att.', 34], ['Of', 30], ['%', 36]];
      const rowW = fixed.reduce((t, [, w]) => t + w, 0) + part.length * dateW + tail.reduce((t, [, w]) => t + w, 0);
      const drawHead = () => {
        let x = left;
        doc.rect(left, y, rowW, 24).fill(primary);
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#FFFFFF');
        for (const [h, w] of fixed) {
          doc.text(h, x + 3, y + 8, { width: w - 6, lineBreak: false });
          x += w;
        }
        for (const l of part) {
          doc.font('Helvetica-Bold').text(shortDate(l.lecture_date), x, y + 4, { width: dateW, align: 'center', lineBreak: false });
          doc.font('Helvetica').text(l.start_time, x, y + 13, { width: dateW, align: 'center', lineBreak: false });
          x += dateW;
        }
        doc.font('Helvetica-Bold');
        for (const [h, w] of tail) {
          doc.text(h, x, y + 8, { width: w, align: 'center', lineBreak: false });
          x += w;
        }
        y += 26;
      };
      drawHead();
      students.forEach((s, i) => {
        if (y + 14 > doc.page.height - doc.page.margins.bottom - 14) {
          doc.addPage();
          y = doc.page.margins.top;
          drawHead();
        }
        const all = lectures.map((l) => s.marks.get(l.id)).filter((m) => m !== undefined);
        const attended = all.filter(Boolean).length;
        const rate = pct(attended, all.length);
        if (i % 2) doc.rect(left, y - 2, rowW, 14).fill('#F9FAFB');
        let x = left;
        doc.font('Helvetica').fontSize(7.5).fillColor('#101828');
        [String(i + 1), s.identifier || '', s.name].forEach((c, ci) => {
          doc.text(c, x + 3, y + 1, { width: fixed[ci][1] - 6, lineBreak: false, ellipsis: true });
          x += fixed[ci][1];
        });
        for (const l of part) {
          const m = s.marks.get(l.id);
          doc.font('Helvetica-Bold').fillColor(m === undefined ? '#98A2B3' : m ? '#067647' : '#B42318');
          doc.text(m === undefined ? '-' : m ? 'P' : 'A', x, y + 1, { width: dateW, align: 'center', lineBreak: false });
          x += dateW;
        }
        doc.font('Helvetica').fillColor('#101828');
        [String(attended), String(all.length)].forEach((c, ci) => {
          doc.text(c, x, y + 1, { width: tail[ci][1], align: 'center', lineBreak: false });
          x += tail[ci][1];
        });
        const low = rate !== null && rate < threshold;
        doc.font('Helvetica-Bold').fillColor(low ? '#B42318' : '#101828').text(rate === null ? '-' : `${rate}%`, x, y + 1, { width: tail[2][1], align: 'center', lineBreak: false });
        y += 14;
      });
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#667085').text(`Percentages in red are below the ${threshold}% needed to sit exams.`, left, y + 8, { lineBreak: false });
    });
  });
}

// ---------------------------------------------------------------- Funds requisition

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const CURRENCY_WORDS = { UGX: 'Uganda Shillings', KES: 'Kenya Shillings', TZS: 'Tanzania Shillings', RWF: 'Rwanda Francs', USD: 'US Dollars', EUR: 'Euros', GBP: 'Pounds Sterling' };

function hundreds(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? `-${ONES[r % 10]}` : ''}`;
  return [h ? `${ONES[h]} hundred` : '', rest].filter(Boolean).join(' and ');
}

function numberWords(n) {
  if (n === 0) return 'zero';
  const scales = ['', 'thousand', 'million', 'billion', 'trillion'];
  const parts = [];
  for (let i = 0; n > 0; i++, n = Math.floor(n / 1000)) {
    const c = n % 1000;
    if (c) parts.unshift({ c, text: `${hundreds(c)}${scales[i] ? ` ${scales[i]}` : ''}` });
  }
  // British style: "one million and fifty".
  return parts.map((p, i) => (i && i === parts.length - 1 && p.c < 100 ? `and ${p.text}` : p.text)).join(' ');
}

/** "Two hundred and forty thousand Uganda Shillings only". */
export function amountInWords(amount, currency = 'UGX') {
  const whole = Math.floor(Math.abs(amount || 0));
  const cents = Math.round((Math.abs(amount || 0) - whole) * 100);
  const text = `${numberWords(whole)} ${CURRENCY_WORDS[currency] || currency}${cents ? ` and ${numberWords(cents)} cents` : ''} only`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A QR code drawn as vector squares (sharp when printed), with a one-module quiet zone. */
function drawQr(doc, text, x, y, size) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'L' });
  const n = qr.modules.size;
  const cell = size / (n + 2);
  doc.save();
  doc.rect(x, y, size, size).fill('#FFFFFF');
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) doc.rect(x + (c + 1) * cell, y + (r + 1) * cell, cell + 0.15, cell + 0.15);
  }
  doc.fill('#000000');
  doc.restore();
}
const dmy = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');

/**
 * The funds requisition form for a part-time pay claim, in the layout of a university requisition:
 * letterhead with a verification QR code, claimant and vote, the items claimed, the amount in words,
 * and the sign-offs (claimant, HoD, Dean as Vote Controller, HR final approval) as digital
 * footprints, followed by blank finance blocks and a schedule of every lecture and task.
 */
export function requisitionPdf(university, claim, lines, { lecturer, vote, voteBalance, signers, cleared, verify }) {
  const primary = `#${hex(university.primary_color)}`;
  const money = (n) => `${claim.currency} ${Number(n || 0).toLocaleString('en', { maximumFractionDigits: 2 })}`;
  const stampOf = (s) => {
    if (!s?.at) return '';
    const t = localStamp(university, s.at);
    return `${dmy(t.slice(0, 10))} ${t.slice(11)}`;
  };
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      const left = doc.page.margins.left;
      const width = doc.page.width - left - doc.page.margins.right;
      const bottom = () => doc.page.height - doc.page.margins.bottom;
      let y = doc.page.margins.top;
      const ensure = (h) => {
        if (y + h > bottom()) {
          doc.addPage();
          y = doc.page.margins.top;
        }
      };

      // Letterhead: logo and address on the left, web, email and date on the right.
      const logo = logoFile(university);
      let x = left;
      if (logo) {
        try {
          doc.image(logo, left, y, { fit: [64, 64] });
          x += 74;
        } catch {
          /* unreadable logo */
        }
      }
      const qrSize = 84;
      const leftW = width * 0.5 - (x - left);
      doc.font('Helvetica-Bold').fontSize(13).fillColor(primary).text(university.name, x, y, { width: leftW });
      const address = String(university.address || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      doc.font('Helvetica').fontSize(9).fillColor('#344054');
      for (const line of [...address, university.phone ? `Tel. ${university.phone}` : null].filter(Boolean)) doc.text(line, x, doc.y, { width: leftW });
      const leftEnd = Math.max(doc.y, y + 64);
      const rx = left + width * 0.5;
      const rw = width * 0.5 - qrSize - 10;
      drawQr(doc, verify.qrText, left + width - qrSize, y - 4, qrSize);
      doc.font('Helvetica').fontSize(6.5).fillColor('#667085').text(`Scan to verify · ${verify.code}`, left + width - qrSize - 10, y + qrSize - 2, { width: qrSize + 10, align: 'center', lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor('#344054');
      let ry = y + 4;
      for (const [k, v] of [['Web Site', university.website], ['Email', university.email], ['Date', dmy(cleared ? signers.hr?.at : null) || dmy(new Date().toISOString())]]) {
        if (!v) continue;
        doc.font('Helvetica-Bold').text(`${k}:`, rx, ry, { width: 52, continued: false });
        doc.font('Helvetica').text(v, rx + 54, ry, { width: rw - 54 });
        ry = doc.y + 3;
      }
      y = Math.max(leftEnd, ry, y + qrSize + 8) + 6;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1.5).strokeColor(primary).stroke();
      y += 12;

      if (!cleared) {
        doc.save();
        doc.rotate(-32, { origin: [doc.page.width / 2, doc.page.height / 2] });
        doc.font('Helvetica-Bold').fontSize(64).fillColor('#D92D20').fillOpacity(0.08);
        doc.text('NOT YET APPROVED', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center' });
        doc.restore();
        doc.fillOpacity(1);
      }
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#101828').text('Funds Requisition Form', left, y, { width, align: 'center', underline: true });
      y = doc.y + 4;
      doc.font('Helvetica').fontSize(8.5).fillColor(cleared ? '#067647' : '#B42318').text(cleared ? `Approved for payment · requisition #${claim.id}` : `Not yet approved for payment: ${claim.status_label} · requisition #${claim.id}`, left, y, { width, align: 'center' });
      y = doc.y + 12;

      // Claimant and vote, as label / value pairs on a ruled line.
      const field = (label, value, fx, fw) => {
        doc.font('Helvetica').fontSize(9.5).fillColor('#475467').text(label, fx, y, { width: 82, lineBreak: false });
        doc.font('Helvetica-Bold').fillColor('#101828').text(String(value || ''), fx + 84, y, { width: fw - 88, height: 13, ellipsis: true });
        doc.moveTo(fx + 84, y + 12).lineTo(fx + fw - 6, y + 12).lineWidth(0.5).strokeColor('#98A2B3').dash(1, { space: 1.5 }).stroke().undash();
      };
      const half = width / 2;
      const designation = lecturer?.designation || (lecturer?.employment_type === 'part_time' ? 'Part-time Lecturer' : 'Lecturer');
      field('Name', [lecturer?.title, claim.lecturer_name].filter(Boolean).join(' '), left, half);
      field('Designation', designation, left + half, half);
      y += 18;
      field('Phone No', lecturer?.phone || '', left, half);
      field('Department', claim.department_name, left + half, half);
      y += 18;
      const purpose = `Payment for part-time teaching and related tasks: ${claim.title} (${dmy(claim.period_start)} to ${dmy(claim.period_end)}), ${claim.faculty_name || ''}`;
      doc.font('Helvetica').fontSize(9.5).fillColor('#475467').text('Purpose', left, y, { width: 82 });
      doc.font('Helvetica-Bold').fillColor('#101828').text(purpose, left + 84, y, { width: width - 88 });
      y = doc.y + 6;
      field('Vote', vote ? `${vote.code} - ${vote.name}${vote.financial_year ? ` (${vote.financial_year})` : ''}` : 'Not yet assigned (Dean)', left, width);
      y += 18;
      field('Balance on Vote', vote ? `${money(voteBalance)} before this claim · ${money(voteBalance - claim.total)} after` : '', left, width);
      y += 22;

      // Items: teaching grouped per course unit and rate; tasks one per line.
      const items = [];
      const groups = new Map();
      for (const l of lines.filter((l) => l.kind === 'teaching')) {
        const key = `${l.course_unit_code}|${l.unit_price}`;
        if (!groups.has(key)) groups.set(key, { lines: [], l });
        groups.get(key).lines.push(l);
      }
      for (const { lines: g, l } of groups.values()) {
        const dates = g.map((x) => x.work_date).sort();
        const hours = g.reduce((t, x) => t + Number(x.quantity), 0);
        const classes = [...new Set(g.flatMap((x) => String(x.class_names || '').split(', ').filter(Boolean)))].join(', ');
        items.push([
          dates[0] === dates[dates.length - 1] ? dmy(dates[0]) : `${dmy(dates[0])} - ${dmy(dates[dates.length - 1])}`,
          `Teaching ${l.course_unit_name || ''}: ${g.length} lecture${g.length === 1 ? '' : 's'}, ${hours} contact hour${hours === 1 ? '' : 's'}${classes ? ` (${classes})` : ''}${l.program_level ? `, ${l.program_level}` : ''}`,
          l.course_unit_code || '',
          `${money(l.unit_price)}/hour`,
          money(g.reduce((t, x) => t + Number(x.amount), 0)),
        ]);
      }
      for (const l of lines.filter((l) => l.kind !== 'teaching')) {
        items.push([dmy(l.work_date), `${l.rate_name}${l.description ? `: ${l.description}` : ''} (${Number(l.quantity)} ${l.unit}${Number(l.quantity) === 1 ? '' : 's'})`, l.course_unit_code || '', `${money(l.unit_price)}/${l.unit}`, money(l.amount)]);
      }
      const cols = [['Date', 92], ['Description/Purpose', width - 92 - 62 - 92 - 86], ['Code', 62], ['Rate', 92], ['Total', 86]];
      const row = (cells, { bold = false, fill = null, color = '#101828' } = {}) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
        const h = Math.max(...cells.map((c, i) => doc.heightOfString(String(c), { width: cols[i][1] - 8 }))) + 8;
        ensure(h);
        if (fill) doc.rect(left, y, width, h).fill(fill);
        let cx = left;
        cells.forEach((c, i) => {
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(color).text(String(c), cx + 4, y + 4, { width: cols[i][1] - 8, align: i >= 3 ? 'right' : 'left' });
          doc.rect(cx, y, cols[i][1], h).lineWidth(0.5).strokeColor('#98A2B3').stroke();
          cx += cols[i][1];
        });
        y += h;
      };
      row(cols.map(([h]) => h), { bold: true, fill: primary, color: '#FFFFFF' });
      for (const it of items) row(it);
      row(['', 'Total', '', '', money(claim.total)], { bold: true, fill: '#F2F4F7' });
      y += 10;

      ensure(40);
      doc.font('Helvetica').fontSize(9.5).fillColor('#475467').text('Amount in words', left, y, { width: 90 });
      doc.font('Helvetica-Bold').fillColor('#101828').text(amountInWords(claim.total, claim.currency), left + 92, y, { width: width - 92 });
      y = doc.y + 14;

      // Sign-off blocks: name, digital signature (sign-off footprint) and date.
      const signBlock = (title, s, note) => {
        ensure(44);
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#101828').text(title, left, y, { width });
        y = doc.y - 4;
        const third = width / 3;
        const cells = [['Name', s?.name || ''], ['Digital signature', null], ['Date', stampOf(s)]];
        cells.forEach(([label, value], i) => {
          const cx = left + third * i;
          const lw = label === 'Digital signature' ? 46 : 30;
          doc.font('Helvetica').fontSize(label === 'Digital signature' ? 7.5 : 9).fillColor('#475467').text(label, cx, label === 'Digital signature' ? y + 10 : y + 14, { width: lw });
          const vx = cx + lw + 2;
          const vw = third - lw - 10;
          if (label === 'Digital signature' && s?.footprint) {
            doc.font('Courier-Bold').fontSize(9.5).fillColor('#067647').text(s.footprint, vx, y + 14, { width: vw, lineBreak: false });
          } else if (value) {
            doc.font('Helvetica-Bold').fontSize(9).fillColor('#101828').text(value, vx, y + 14, { width: vw, height: 12, ellipsis: true });
          }
          doc.moveTo(vx, y + 26).lineTo(vx + vw, y + 26).lineWidth(0.5).strokeColor('#98A2B3').dash(1, { space: 1.5 }).stroke().undash();
        });
        y += 27;
        if (note) {
          doc.font('Helvetica').fontSize(7.5).fillColor('#667085').text(note, left, y + 3, { width });
          y = doc.y;
        }
        y += 6;
      };

      signBlock('Name & Digital Signature of Claimant', signers.claimant, signers.claimant?.footprint ? 'Signed off and submitted in eCampus.' : null);
      ensure(40);
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#344054').text(
        `I certify that the information provided herein above is correct to the best of my knowledge and the claim herein truly conforms to the established expenditure estimates and the finance regulations governing ${university.name}.`,
        left,
        y,
        { width },
      );
      y = doc.y + 8;
      signBlock('Verified by Head of Department', signers.hod);
      signBlock('Signed off by Vote Controller (Dean)', signers.dean, vote ? `Charged to vote ${vote.code} - ${vote.name}.` : null);
      signBlock('Final approval by HR Officer', signers.hr, cleared ? 'Approved for payment and printed for submission.' : null);

      // Finance completes these on paper after HR submits the form.
      const blank = (title, text) => {
        ensure(text ? 56 : 40);
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#101828').text(title, left, y, { width });
        y = doc.y + 2;
        if (text) {
          doc.font('Helvetica').fontSize(8).fillColor('#344054').text(text, left, y, { width });
          y = doc.y - 4;
        }
        const third = width / 3;
        ['Name', 'Signature', 'Date'].forEach((label, i) => {
          const cx = left + third * i;
          doc.font('Helvetica').fontSize(9).fillColor('#475467').text(label, cx, y + 12, { width: 50, lineBreak: false });
          doc.moveTo(cx + 52, y + 24).lineTo(cx + third - 8, y + 24).lineWidth(0.5).strokeColor('#98A2B3').dash(1, { space: 1.5 }).stroke().undash();
        });
        y += 28;
      };
      blank('Checked by Accountant');
      blank('Passed for payment by University Bursar', 'It is hereby certified that the claimant accounted for the last advance of funds of UGX ............................ and therefore this is passed for payment.');
      blank('Authorized by University Secretary');
      ensure(30);
      doc.font('Helvetica').fontSize(7.5).fillColor('#475467').text(
        `Digital signatures are eCampus sign-off footprints: each records who signed, in which role, when and for what amount. Check them, the amount and the approval status at ${verify.url} (code ${verify.code}).`,
        left,
        y,
        { width },
      );
      y = doc.y + 4;

      // Schedule: every lecture and task on the claim.
      doc.addPage();
      y = doc.page.margins.top;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(primary).text(`Schedule attached to requisition: claim #${claim.id}`, left, y, { width });
      doc.font('Helvetica').fontSize(9).fillColor('#475467').text(`${claim.lecturer_name} · ${claim.department_name || ''} · ${dmy(claim.period_start)} to ${dmy(claim.period_end)}`, left, doc.y + 2, { width });
      y = doc.y + 10;
      const scols = [['Date', 62], ['Item', width - 62 - 64 - 64 - 86 - 80], ['Students', 64], ['Quantity', 64], ['Rate', 86], ['Amount', 80]];
      const srow = (cells, { bold = false, fill = null, color = '#101828' } = {}) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
        const h = Math.max(...cells.map((c, i) => doc.heightOfString(String(c), { width: scols[i][1] - 8 }))) + 6;
        if (y + h > bottom()) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        if (fill) doc.rect(left, y, width, h).fill(fill);
        let cx = left;
        cells.forEach((c, i) => {
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(color).text(String(c), cx + 4, y + 3, { width: scols[i][1] - 8, align: i >= 3 ? 'right' : 'left' });
          cx += scols[i][1];
        });
        doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.4).strokeColor('#E4E7EC').stroke();
        y += h;
      };
      srow(scols.map(([h]) => h), { bold: true, fill: primary, color: '#FFFFFF' });
      for (const l of [...lines].sort((a, b) => `${a.work_date}${a.start_time || ''}`.localeCompare(`${b.work_date}${b.start_time || ''}`))) {
        const item = l.kind === 'teaching'
          ? `${l.course_unit_code} ${l.course_unit_name || ''}, ${l.start_time}-${l.end_time} (${l.class_names || ''})${l.self_checkins ? ` · ${l.self_checkins} QR check-ins` : ''}`
          : `${l.rate_name}${l.description ? `: ${l.description}` : ''}`;
        srow([dmy(l.work_date), item, l.students_total ? `${l.students_present}/${l.students_total}` : '', `${Number(l.quantity)} ${l.unit}${Number(l.quantity) === 1 ? '' : 's'}`, money(l.unit_price), money(l.amount)]);
      }
      srow(['', 'Total', '', '', '', money(claim.total)], { bold: true, fill: '#F2F4F7' });

      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const keep = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font('Helvetica').fontSize(7.5).fillColor('#98A2B3').text(
          `${university.short_name || university.name} · Funds requisition #${claim.id} · verify code ${verify.code} · generated ${localStamp(university)} · page ${i + 1} of ${range.count}`,
          left,
          doc.page.height - 28,
          { width, align: 'center', lineBreak: false },
        );
        doc.page.margins.bottom = keep;
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Research clearance certificate: the student, the work, supervisors, every sign-off as a digital
 * footprint, and a QR code (student, work, status and a link) to check it against the system.
 */
export function researchCertificatePdf(university, project, { supervisors, signOffs, verify }) {
  const primary = `#${hex(university.primary_color)}`;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      const left = doc.page.margins.left;
      const width = doc.page.width - left - doc.page.margins.right;
      let y = doc.page.margins.top;
      const qrSize = 92;
      const logo = logoFile(university);
      if (logo) {
        try {
          doc.image(logo, left, y, { fit: [70, 70] });
        } catch {
          /* unreadable logo */
        }
      }
      drawQr(doc, verify.qrText, left + width - qrSize, y - 4, qrSize);
      doc.font('Helvetica').fontSize(6.5).fillColor('#667085').text(`Scan to verify · ${verify.code}`, left + width - qrSize - 10, y + qrSize - 2, { width: qrSize + 10, align: 'center', lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(16).fillColor(primary).text(university.name, left + 80, y + 4, { width: width - 80 - qrSize - 12, align: 'center' });
      const contact = [university.address, university.phone ? `Tel. ${university.phone}` : null, university.email].filter(Boolean).join(' · ');
      doc.font('Helvetica').fontSize(8.5).fillColor('#475467').text(contact, left + 80, doc.y + 2, { width: width - 80 - qrSize - 12, align: 'center' });
      y = Math.max(doc.y, y + qrSize + 10) + 8;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1.5).strokeColor(primary).stroke();
      y += 22;

      doc.font('Helvetica-Bold').fontSize(18).fillColor('#101828').text('Research Clearance Certificate', left, y, { width, align: 'center' });
      y = doc.y + 4;
      doc.font('Helvetica').fontSize(9.5).fillColor('#475467').text(`${project.kind_label} · certificate #${project.id} · verification code ${verify.code}`, left, y, { width, align: 'center' });
      y = doc.y + 20;

      doc.font('Helvetica').fontSize(11).fillColor('#101828').text('This is to certify that', left, y, { width, align: 'center' });
      y = doc.y + 6;
      doc.font('Helvetica-Bold').fontSize(15).text(`${project.student_name}${project.student_identifier ? ` (${project.student_identifier})` : ''}`, left, y, { width, align: 'center' });
      y = doc.y + 6;
      doc.font('Helvetica').fontSize(11).text(`of ${project.program_name || project.program_code || ''}, ${project.department_name || ''}, has completed and defended the ${project.kind_label.toLowerCase()} entitled`, left, y, { width, align: 'center' });
      y = doc.y + 8;
      doc.font('Helvetica-BoldOblique').fontSize(13).fillColor(primary).text(`"${project.title}"`, left + 20, y, { width: width - 40, align: 'center' });
      y = doc.y + 8;
      doc.font('Helvetica').fontSize(11).fillColor('#101828').text(`and has been approved and cleared${project.cleared_at ? ` on ${localStamp(university, project.cleared_at).slice(0, 10)}` : ''}.`, left, y, { width, align: 'center' });
      y = doc.y + 18;

      const info = [
        ['Supervisors', supervisors.map((s) => `${[s.title, s.name].filter(Boolean).join(' ')}${s.role === 'co' ? ' (co-supervisor)' : ''}`).join(', ') || '-'],
        ['Defence', [project.defence_at, project.defence_venue].filter(Boolean).join(', ') || '-'],
        ['Panel', project.defence_panel || '-'],
      ];
      doc.fontSize(9.5);
      for (const [k, v] of info) {
        doc.font('Helvetica').fillColor('#475467').text(k, left, y, { width: 90 });
        doc.font('Helvetica-Bold').fillColor('#101828').text(v, left + 92, y, { width: width - 92 });
        y = doc.y + 5;
      }
      y += 8;

      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(primary).text('Digital signatures', left, y);
      y = doc.y + 6;
      const cols = [['Sign-off', 215], ['Name', 130], ['Date', 82], ['Digital signature', width - 427]];
      doc.rect(left, y, width, 16).fill(primary);
      let cx = left;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
      for (const [h, w] of cols) {
        doc.text(h, cx + 4, y + 4, { width: w - 8, lineBreak: false });
        cx += w;
      }
      y += 18;
      signOffs.forEach((s, i) => {
        if (i % 2) doc.rect(left, y - 2, width, 15).fill('#F9FAFB');
        const cells = [s.label, s.name || 'Not recorded', s.at ? localStamp(university, s.at).slice(0, 10) : '', s.footprint || ''];
        cx = left;
        cells.forEach((c, ci) => {
          doc.font(ci === 3 ? 'Courier-Bold' : 'Helvetica').fontSize(ci === 3 ? 8.5 : 8).fillColor(ci === 3 ? '#067647' : s.name ? '#101828' : '#98A2B3');
          doc.text(c, cx + 4, y + 1, { width: cols[ci][1] - 8, lineBreak: false, ellipsis: true });
          cx += cols[ci][1];
        });
        y += 15;
      });
      y += 12;
      doc.font('Helvetica').fontSize(7.5).fillColor('#475467').text(
        `Digital signatures are eCampus sign-off footprints: each records who signed, in which role and when. Check this certificate, its status and every footprint at ${verify.url} (code ${verify.code}).`,
        left,
        y,
        { width },
      );

      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const keep = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font('Helvetica').fontSize(7.5).fillColor('#98A2B3').text(`${university.short_name || university.name} · research clearance #${project.id} · verify code ${verify.code} · generated ${localStamp(university)}`, left, doc.page.height - 28, { width, align: 'center', lineBreak: false });
        doc.page.margins.bottom = keep;
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
