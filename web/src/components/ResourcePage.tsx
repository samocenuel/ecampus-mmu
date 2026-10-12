import { FormEvent, ReactNode, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useFetch } from '../hooks';
import { useFeedback } from './feedback';
import { Button, Card, Checkbox, Column, DataTable, ErrorNote, Field, IconButton, Input, Modal, PageHeader, Select, Textarea } from './ui';

export interface FieldDef {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'number' | 'select' | 'checkbox' | 'textarea' | 'date' | 'password' | 'time' | 'url' | 'tel';
  options?: { value: string | number; label: string }[];
  required?: boolean;
  placeholder?: string;
  /** Selects only: don't offer an empty choice. */
  noPlaceholder?: boolean;
  help?: ReactNode;
  span?: 1 | 2;
  min?: number;
  max?: number;
  showIf?: (form: any, editing: boolean) => boolean;
  defaultValue?: any;
}

export function FormFields({ fields, form, setForm, editing = false }: { fields: FieldDef[]; form: any; setForm: (f: any) => void; editing?: boolean }) {
  const set = (name: string, value: any) => setForm({ ...form, [name]: value });
  return (
    <div className="form-grid">
      {fields
        .filter((f) => !f.showIf || f.showIf(form, editing))
        .map((f) => {
          const value = form[f.name] ?? '';
          if (f.type === 'checkbox') {
            return (
              <div key={f.name} className={f.span === 2 ? 'span-2' : ''}>
                <Checkbox label={f.label} checked={Boolean(form[f.name])} onChange={(v) => set(f.name, v)} />
                {f.help && <div className="field-help">{f.help}</div>}
              </div>
            );
          }
          return (
            <Field key={f.name} label={`${f.label}${f.required ? ' *' : ''}`} help={f.help} span={f.span}>
              {f.type === 'select' ? (
                <Select value={value} required={f.required} onChange={(e) => set(f.name, e.target.value)} options={f.options || []} placeholder={f.noPlaceholder ? undefined : (f.placeholder ?? 'Select...')} />
              ) : f.type === 'textarea' ? (
                <Textarea value={value} placeholder={f.placeholder} onChange={(e) => set(f.name, e.target.value)} />
              ) : (
                <Input
                  type={f.type || 'text'}
                  value={value}
                  required={f.required}
                  placeholder={f.placeholder}
                  min={f.min}
                  max={f.max}
                  onChange={(e) => set(f.name, e.target.value)}
                />
              )}
            </Field>
          );
        })}
    </div>
  );
}

export interface ResourceConfig<T> {
  title: string;
  subtitle?: ReactNode;
  noun: string;
  endpoint: string;
  query?: string;
  columns: Column<T>[];
  fields: FieldDef[];
  searchKeys?: string[];
  canCreate?: boolean;
  canEdit?: (row: T) => boolean;
  canDelete?: (row: T) => boolean;
  toPayload?: (form: any, editing: T | null) => any;
  fromRow?: (row: T) => any;
  rowActions?: (row: T, reload: () => void) => ReactNode;
  headerActions?: (reload: () => void) => ReactNode;
  toolbar?: ReactNode;
  before?: (rows: T[] | null, reload: () => void) => ReactNode;
  empty?: ReactNode;
  deleteMessage?: (row: T) => string;
  onSaved?: (result: any, created: boolean) => void;
  onRowClick?: (row: T) => void;
  /** Extra, resource-specific form controls rendered under the standard fields. */
  extraForm?: (form: any, setForm: (f: any) => void, editing: T | null) => ReactNode;
}

export function ResourcePage<T extends { id: number }>(cfg: ResourceConfig<T>) {
  const { data, loading, error, reload } = useFetch<T[]>(cfg.endpoint + (cfg.query || ''));
  const { toast, withConfirm, confirm, fail } = useFeedback();
  const [editing, setEditing] = useState<T | 'new' | null>(null);
  const [form, setForm] = useState<any>({});
  const [saving, setSaving] = useState(false);

  const openNew = () => {
    const f: any = {};
    for (const field of cfg.fields) if (field.defaultValue !== undefined) f[field.name] = field.defaultValue;
    setForm(f);
    setEditing('new');
  };
  const openEdit = (row: T) => {
    setForm(cfg.fromRow ? cfg.fromRow(row) : { ...row });
    setEditing(row);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const isNew = editing === 'new';
    const row = isNew ? null : (editing as T);
    const payload = cfg.toPayload
      ? cfg.toPayload(form, row)
      : Object.fromEntries(cfg.fields.filter((f) => !f.showIf || f.showIf(form, !isNew)).map((f) => [f.name, form[f.name] === '' ? null : form[f.name]]));
    setSaving(true);
    try {
      const result = await withConfirm((force) =>
        api(isNew ? cfg.endpoint : `${cfg.endpoint}/${row!.id}`, { method: isNew ? 'POST' : 'PUT', body: { ...payload, force } }),
      );
      if (result !== undefined) {
        toast(`${cfg.noun} ${isNew ? 'created' : 'saved'}`);
        setEditing(null);
        reload();
        cfg.onSaved?.(result, isNew);
      }
    } catch (err) {
      fail(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: T) => {
    const ok = await confirm({
      title: `Delete ${cfg.noun.toLowerCase()}?`,
      message: cfg.deleteMessage?.(row) || 'This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`${cfg.endpoint}/${row.id}`, { method: 'DELETE' });
      toast(`${cfg.noun} deleted`);
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const hasActions = cfg.canEdit || cfg.canDelete || cfg.rowActions;
  const columns: Column<T>[] = hasActions
    ? [
        ...cfg.columns,
        {
          key: '_actions',
          header: '',
          align: 'right',
          render: (row) => (
            <div className="row-actions" onClick={(e) => e.stopPropagation()}>
              {cfg.rowActions?.(row, reload)}
              {cfg.canEdit?.(row) && (
                <IconButton label="Edit" onClick={() => openEdit(row)}>
                  <Pencil size={16} />
                </IconButton>
              )}
              {cfg.canDelete?.(row) && (
                <IconButton label="Delete" className="danger" onClick={() => remove(row)}>
                  <Trash2 size={16} />
                </IconButton>
              )}
            </div>
          ),
        },
      ]
    : cfg.columns;

  return (
    <>
      <PageHeader
        title={cfg.title}
        subtitle={cfg.subtitle}
        actions={
          <>
            {cfg.headerActions?.(reload)}
            {cfg.canCreate && (
              <Button icon={<Plus size={16} />} onClick={openNew}>
                New {cfg.noun.toLowerCase()}
              </Button>
            )}
          </>
        }
      />
      <ErrorNote error={error} />
      {cfg.before?.(data, reload)}
      <Card padded={false}>
        <DataTable rows={data} columns={columns} loading={loading} searchKeys={cfg.searchKeys} toolbar={cfg.toolbar} empty={cfg.empty} onRowClick={cfg.onRowClick} />
      </Card>
      <Modal
        open={editing !== null}
        title={editing === 'new' ? `New ${cfg.noun.toLowerCase()}` : `Edit ${cfg.noun.toLowerCase()}`}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" form="resource-form" loading={saving}>
              {editing === 'new' ? 'Create' : 'Save changes'}
            </Button>
          </>
        }
      >
        <form id="resource-form" onSubmit={submit}>
          <FormFields fields={cfg.fields} form={form} setForm={setForm} editing={editing !== 'new'} />
          {editing !== null && cfg.extraForm?.(form, setForm, editing === 'new' ? null : editing)}
        </form>
      </Modal>
    </>
  );
}
