import { Clock, MapPin, User as UserIcon, Users } from 'lucide-react';
import { DAY_NAMES, DAY_SHORT, Session, TimetableSettings } from '../types';
import { EmptyState } from './ui';

const HOUR = 60; // pixels per hour

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:00`;

// Soft categorical palette; cross-cutting units always use the amber swatch.
const PALETTE = [
  ['#EEF4FF', '#3E63DD'],
  ['#ECFDF3', '#12B76A'],
  ['#FDF2FA', '#C11574'],
  ['#F0F9FF', '#0086C9'],
  ['#F4F3FF', '#6938EF'],
  ['#FEF6EE', '#E04F16'],
  ['#F0FDF9', '#0E9384'],
  ['#FFF1F3', '#E31B54'],
];
const CC = ['#FFFAEB', '#DC6803'];

export function colourFor(s: Pick<Session, 'course_unit_id' | 'is_cross_cutting'>) {
  return s.is_cross_cutting ? CC : PALETTE[s.course_unit_id % PALETTE.length];
}

function layoutDay(sessions: Session[]) {
  const sorted = [...sessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
  const laneEnds: string[] = [];
  const placed = sorted.map((s) => {
    let lane = laneEnds.findIndex((e) => e <= s.start_time);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = s.end_time;
    return { s, lane };
  });
  return { placed, lanes: Math.max(1, laneEnds.length) };
}

export function WeekGrid({
  sessions,
  settings,
  onSelect,
  showClasses = true,
  todayDow,
}: {
  sessions: Session[];
  settings: TimetableSettings;
  onSelect?: (s: Session) => void;
  showClasses?: boolean;
  todayDow?: number;
}) {
  const days = [...new Set([...settings.teaching_days, ...sessions.map((s) => s.day_of_week)])].sort((a, b) => a - b);
  let start = toMin(settings.day_start);
  let end = toMin(settings.day_end);
  for (const s of sessions) {
    start = Math.min(start, Math.floor(toMin(s.start_time) / 60) * 60);
    end = Math.max(end, Math.ceil(toMin(s.end_time) / 60) * 60);
  }
  start = Math.floor(start / 60) * 60;
  end = Math.ceil(end / 60) * 60;
  const hours: number[] = [];
  for (let t = start; t < end; t += 60) hours.push(t);
  const height = hours.length * HOUR;
  // Days with parallel sessions get proportionally wider columns (the grid scrolls sideways).
  const layouts = new Map(days.map((d) => [d, layoutDay(sessions.filter((s) => s.day_of_week === d))]));
  const widths = days.map((d) => Math.max(132, layouts.get(d)!.lanes * 104));
  const cols = `64px ${days.map((d, i) => `minmax(${widths[i]}px, ${layouts.get(d)!.lanes}fr)`).join(' ')}`;
  const lunch = settings.lunch_start && settings.lunch_end ? [toMin(settings.lunch_start), toMin(settings.lunch_end)] : null;

  return (
    <div className="week" role="table" aria-label="Weekly timetable">
      <div className="week-inner" style={{ minWidth: 64 + widths.reduce((a, b) => a + b, 0) }}>
        <div className="week-head" style={{ gridTemplateColumns: cols }}>
          <div />
          {days.map((d) => (
            <div key={d} className={d === todayDow ? 'today' : ''}>
              <span className="hide-sm">{DAY_NAMES[d]}</span>
              <span className="show-sm">{DAY_SHORT[d]}</span>
            </div>
          ))}
        </div>
        <div className="week-body" style={{ gridTemplateColumns: cols }}>
          <div className="week-times">
            {hours.map((h) => (
              <div key={h} style={{ height: HOUR }}>
                {hh(h)}
              </div>
            ))}
          </div>
          {days.map((d) => {
            const { placed, lanes } = layouts.get(d)!;
            return (
              <div
                key={d}
                className={`week-day ${d === todayDow ? 'today' : ''}`}
                style={{
                  height,
                  backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR - 1}px, var(--grid-line) ${HOUR - 1}px, var(--grid-line) ${HOUR}px)`,
                }}
              >
                {lunch && (
                  <div className="week-lunch" style={{ top: ((lunch[0] - start) / 60) * HOUR, height: ((lunch[1] - lunch[0]) / 60) * HOUR }}>
                    Lunch
                  </div>
                )}
                {placed.map(({ s, lane }) => {
                  const [bg, bar] = colourFor(s);
                  const top = ((toMin(s.start_time) - start) / 60) * HOUR;
                  const h = ((toMin(s.end_time) - toMin(s.start_time)) / 60) * HOUR;
                  return (
                    <button
                      key={s.id}
                      className={`slot ${h < 90 ? 'slot-short' : ''}`}
                      onClick={onSelect ? () => onSelect(s) : undefined}
                      style={{
                        top: top + 2,
                        height: h - 4,
                        left: `calc(${(lane / lanes) * 100}% + 3px)`,
                        width: `calc(${100 / lanes}% - 6px)`,
                        background: bg,
                        borderLeftColor: bar,
                        cursor: onSelect ? 'pointer' : 'default',
                      }}
                      title={`${s.course_code} ${s.course_name}\n${s.start_time}-${s.end_time} · ${s.room_name}\n${s.lecturer_name}\n${s.classes.map((c) => c.name).join(', ')}`}
                    >
                      <span className="slot-code">
                        {s.course_code}
                        {s.is_cross_cutting ? <span className="cc-tag">CC</span> : null}
                      </span>
                      <span className="slot-time">
                        {s.start_time}-{s.end_time}
                      </span>
                      <span className="slot-name">{s.course_name}</span>
                      <span className="slot-meta">{s.room_name}</span>
                      <span className="slot-meta">{showClasses ? s.classes.map((c) => c.name).join(', ') : s.lecturer_name}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Day-by-day list - easier to read on phones. */
export function Agenda({ sessions, onSelect, showClasses = true }: { sessions: Session[]; onSelect?: (s: Session) => void; showClasses?: boolean }) {
  const days = [...new Set(sessions.map((s) => s.day_of_week))].sort((a, b) => a - b);
  if (!sessions.length) return <EmptyState title="No lectures scheduled" />;
  return (
    <div className="agenda">
      {days.map((d) => (
        <div key={d} className="agenda-day">
          <h4>{DAY_NAMES[d]}</h4>
          {sessions
            .filter((s) => s.day_of_week === d)
            .sort((a, b) => a.start_time.localeCompare(b.start_time))
            .map((s) => (
              <SessionRow key={s.id} s={s} onClick={onSelect ? () => onSelect(s) : undefined} showClasses={showClasses} />
            ))}
        </div>
      ))}
    </div>
  );
}

export function SessionRow({ s, onClick, showClasses = true, extra }: { s: Session; onClick?: () => void; showClasses?: boolean; extra?: React.ReactNode }) {
  const [, bar] = colourFor(s);
  return (
    <div className={`session-row ${onClick ? 'clickable' : ''}`} onClick={onClick} style={{ borderLeftColor: bar }}>
      <div className="session-time">
        <strong>{s.start_time}</strong>
        <span>{s.end_time}</span>
      </div>
      <div className="session-main">
        <div className="session-title">
          <strong>{s.course_code}</strong> {s.course_name} {s.is_cross_cutting ? <span className="cc-tag">CC</span> : null}
        </div>
        <div className="session-meta">
          <span>
            <MapPin size={13} /> {s.room_name}
            {s.room_building ? `, ${s.room_building}` : ''}
          </span>
          <span>
            <UserIcon size={13} /> {s.lecturer_title ? `${s.lecturer_title} ` : ''}
            {s.lecturer_name}
          </span>
          {showClasses && (
            <span>
              <Users size={13} /> {s.classes.map((c) => c.name).join(', ')}
            </span>
          )}
          {!showClasses && (
            <span>
              <Clock size={13} /> {(toMin(s.end_time) - toMin(s.start_time)) / 60} hrs
            </span>
          )}
        </div>
      </div>
      {extra}
    </div>
  );
}
