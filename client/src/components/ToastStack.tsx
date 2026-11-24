import { useEffect } from 'react';
import type { ToastData } from '../lib/alerts';

const AUTO_DISMISS_MS = 12_000;

interface Props {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
}

/** In-app pop-ups for alerts that arrive while the page is open. OS notifications still come via Web Push. */
export function ToastStack({ toasts, onDismiss }: Props) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastData; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <button type="button" className={`toast toast--${toast.tone}`} onClick={() => onDismiss(toast.id)}>
      <strong>{toast.title}</strong>
      <span>{toast.body}</span>
    </button>
  );
}
