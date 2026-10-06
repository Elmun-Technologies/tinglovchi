'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './icons';

/**
 * The only interactive island the product surface needs in this package: a modal dialog for speaker mapping.
 *
 * It is built on the native `<dialog>` element so focus trapping, `Esc` and the top layer come from the
 * browser rather than a dependency. Dismissing calls `onDismiss` (the app closes it by navigating away, which
 * keeps the URL the source of truth) and falls back to `close()` for local-only dialogs.
 */
export function Modal({
  title,
  description,
  children,
  footer,
  onDismiss,
  labelledById = 'modal-title',
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onDismiss?: () => void;
  labelledById?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const target =
      dialog.querySelector<HTMLElement>('[data-autofocus]') ??
      dialog.querySelector<HTMLElement>('input, select, button:not([data-modal-close])');
    target?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  const dismiss = () => {
    if (onDismiss) onDismiss();
    else dialogRef.current?.close();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={labelledById}
      onCancel={dismiss}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog itself, never on its content.
        if (event.target === event.currentTarget) dismiss();
      }}
      className="fixed inset-0 m-auto w-[min(40rem,calc(100vw-1.5rem))] rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/25"
    >
      <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-3.5">
        <div className="min-w-0">
          <h2 id={labelledById} className="text-[15px] font-semibold tracking-tight">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-[13px] leading-relaxed text-slate-600">{description}</p>
          ) : null}
        </div>
        <button
          type="button"
          data-modal-close
          onClick={dismiss}
          aria-label="Close"
          className="-mr-1.5 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="max-h-[65vh] overflow-y-auto px-5 py-4">{children}</div>
      {footer ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          {footer}
        </div>
      ) : null}
    </dialog>
  );
}
