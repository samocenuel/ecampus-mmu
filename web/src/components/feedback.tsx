import { createContext, ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { ApiError } from '../api';
import { Button, Modal } from './ui';

type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ConfirmOptions {
  title?: string;
  message: ReactNode;
  details?: ReactNode;
  confirmLabel?: string;
  tone?: 'primary' | 'danger';
}

interface FeedbackApi {
  toast: (message: string, tone?: ToastTone) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** Runs fn(false); if the API asks for confirmation, shows it and re-runs fn(true). */
  withConfirm: <T>(fn: (force: boolean) => Promise<T>) => Promise<T | undefined>;
  /** Shows any error as a toast. */
  fail: (err: unknown) => void;
}

const Ctx = createContext<FeedbackApi | null>(null);

function confirmDetails(err: ApiError): ReactNode {
  const d = err.data || {};
  if (Array.isArray(d.pending) && d.pending.length) {
    return (
      <ul className="detail-list">
        {d.pending.map((p: any) => (
          <li key={p.course_unit_id}>
            <strong>{p.code}</strong> {p.name}
            {p.pending_classes?.length ? <span className="muted"> - {p.pending_classes.join(', ')}</span> : null}
          </li>
        ))}
      </ul>
    );
  }
  if (Array.isArray(d.warnings) && d.warnings.length) {
    return (
      <ul className="detail-list">
        {d.warnings.map((w: string) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    );
  }
  return null;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const seq = useRef(0);

  const toast = useCallback((message: string, tone: ToastTone = 'success') => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3500);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setDialog(opts);
      }),
    [],
  );

  const close = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setDialog(null);
  };

  const fail = useCallback((err: unknown) => toast(err instanceof Error ? err.message : 'Something went wrong', 'error'), [toast]);

  const withConfirm = useCallback(
    async <T,>(fn: (force: boolean) => Promise<T>) => {
      try {
        return await fn(false);
      } catch (err) {
        if (err instanceof ApiError && err.needsConfirmation) {
          const ok = await confirm({
            title: err.data.code?.startsWith('CROSS_CUTTING') ? 'Cross-cutting units first' : 'Please confirm',
            message: err.message,
            details: confirmDetails(err),
            confirmLabel: 'Continue anyway',
          });
          if (ok) return await fn(true);
          return undefined;
        }
        throw err;
      }
    },
    [confirm],
  );

  return (
    <Ctx.Provider value={{ toast, confirm, withConfirm, fail }}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.tone === 'success' ? <CheckCircle2 size={18} /> : t.tone === 'error' ? <XCircle size={18} /> : <Info size={18} />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
      <Modal
        open={Boolean(dialog)}
        title={
          <span className="row gap-sm">
            <AlertTriangle size={18} className="text-warning" /> {dialog?.title || 'Are you sure?'}
          </span>
        }
        onClose={() => close(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant={dialog?.tone === 'danger' ? 'danger' : 'primary'} onClick={() => close(true)}>
              {dialog?.confirmLabel || 'Confirm'}
            </Button>
          </>
        }
      >
        <p>{dialog?.message}</p>
        {dialog?.details}
      </Modal>
    </Ctx.Provider>
  );
}

export function useFeedback() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useFeedback must be used inside FeedbackProvider');
  return ctx;
}
