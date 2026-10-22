import { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Inbox, Loader2, Search, X } from 'lucide-react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** "1 register", "3 registers"; pass the plural for irregular words. */
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button className={cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', className)} disabled={loading || rest.disabled} {...rest}>
      {loading ? <Loader2 className="spin" size={16} /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button className={cx('icon-btn', className)} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h3>{title}</h3>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'card-body' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'; children: ReactNode }) {
  return <span className={cx('badge', `badge-${tone}`)}>{children}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-row">
      <Loader2 className="spin" size={20} />
      {label && <span>{label}</span>}
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon || <Inbox size={28} />}</div>
      <h4>{title}</h4>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error?: string | null }) {
  if (!error) return null;
  return <div className="alert alert-danger">{error}</div>;
}

export function Alert({ tone = 'info', title, children, action }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx('alert', `alert-${tone}`)}>
      <div className="alert-text">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Field({ label, help, error, children, span }: { label?: ReactNode; help?: ReactNode; error?: string; children: ReactNode; span?: 1 | 2 }) {
  return (
    <label className={cx('field', span === 2 && 'span-2')}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {help && <span className="field-help">{help}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => <input className="input" {...props} />;
export const Textarea = (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className="input" rows={3} {...props} />;

export function Select({ options, placeholder, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string | number; label: string }[]; placeholder?: string }) {
  return (
    <select className="input" {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cx('checkbox', disabled && 'disabled')}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'modal-wide')} role="dialog" aria-modal="true">
        <header className="modal-head">
          <h3>{title}</h3>
          <IconButton label="Close" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={cx('tab', value === t.value && 'active')} onClick={() => onChange(t.value)}>
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function StatCard({ label, value, hint, icon, tone }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: 'primary' | 'success' | 'warning' | 'danger' }) {
  return (
    <div className={cx('stat', tone && `stat-${tone}`)}>
      {icon && <div className="stat-icon">{icon}</div>}
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
        {hint && <div className="stat-hint">{hint}</div>}
      </div>
    </div>
  );
}

export function Progress({ value, total, tone }: { value: number; total: number; tone?: 'success' | 'warning' | 'danger' }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className="progress" title={`${value} of ${total}`}>
      <div className={cx('progress-bar', tone && `bg-${tone}`)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function rateTone(rate: number | null | undefined): 'success' | 'warning' | 'danger' | undefined {
  if (rate === null || rate === undefined) return undefined;
  return rate >= 80 ? 'success' : rate >= 75 ? 'warning' : 'danger';
}

export function Avatar({ name, size = 32, src }: { name: string; size?: number; src?: string | null }) {
  if (src) return <img className="avatar avatar-img" src={src} alt="" style={{ width: size, height: size }} />;
  const initials = name
    .replace(/^(Dr|Prof|Mr|Ms|Mrs)\.?\s+/i, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {initials}
    </span>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number;
  width?: string;
  align?: 'left' | 'right' | 'center';
  hideOnMobile?: boolean;
}

export function DataTable<T = any>({
  rows,
  columns,
  loading,
  empty = 'Nothing here yet',
  searchKeys,
  toolbar,
  onRowClick,
  pageSize = 50,
}: {
  rows: T[] | null | undefined;
  columns: Column<T>[];
  loading?: boolean;
  empty?: ReactNode;
  searchKeys?: string[];
  toolbar?: ReactNode;
  onRowClick?: (row: T) => void;
  pageSize?: number;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [limit, setLimit] = useState(pageSize);

  const filtered = useMemo(() => {
    let list = rows || [];
    if (query && searchKeys?.length) {
      const q = query.toLowerCase();
      list = list.filter((r) => searchKeys.some((k) => String((r as any)[k] ?? '').toLowerCase().includes(q)));
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      const val = (r: T) => (col?.sortValue ? col.sortValue(r) : (r as any)[sort.key]) ?? '';
      list = [...list].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * sort.dir);
    }
    return list;
  }, [rows, query, searchKeys, sort, columns]);

  return (
    <div className="table-wrap">
      {(searchKeys || toolbar) && (
        <div className="table-toolbar">
          {searchKeys && (
            <div className="search">
              <Search size={16} />
              <input placeholder="Search..." value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
            </div>
          )}
          {toolbar}
        </div>
      )}
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{ width: c.width, textAlign: c.align }}
                  className={cx(c.hideOnMobile && 'hide-sm', 'sortable')}
                  onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: (s.dir * -1) as 1 | -1 } : { key: c.key, dir: 1 }))}
                >
                  {c.header}
                  {sort?.key === c.key && (sort.dir === 1 ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, limit).map((row, i) => (
              <tr key={(row as any).id ?? i} onClick={onRowClick ? () => onRowClick(row) : undefined} className={onRowClick ? 'clickable' : ''}>
                {columns.map((c) => (
                  <td key={c.key} style={{ textAlign: c.align }} className={c.hideOnMobile ? 'hide-sm' : ''}>
                    {c.render ? c.render(row) : ((row as any)[c.key] ?? '-')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {loading && !rows && <Spinner label="Loading..." />}
        {!loading && filtered.length === 0 && <EmptyState title={query ? 'No matches' : typeof empty === 'string' ? empty : 'Nothing here yet'}>{typeof empty === 'string' ? null : empty}</EmptyState>}
      </div>
      {filtered.length > limit && (
        <div className="table-more">
          <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + pageSize)}>
            Show more ({filtered.length - limit} remaining)
          </Button>
        </div>
      )}
    </div>
  );
}
