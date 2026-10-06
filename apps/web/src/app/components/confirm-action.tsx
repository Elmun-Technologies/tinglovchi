'use client';

import { useRouter } from 'next/navigation';
import { Button, Modal, Notice, type FormAction } from '@suhbat/ui';

/**
 * A destructive-or-consequential confirmation, as a native dialog whose openness is a URL param.
 *
 * The page decides whether to render this at all (`?dialog=…`), so the dialog can be linked, reloaded and
 * closed with the back button — and a closed dialog cannot be "stuck open" by a stale client state. The submit
 * is a POST to a server action, which is where the adapter's own refusal appears if the record cannot be
 * archived or deleted after all.
 */
export function ConfirmAction({
  title,
  description,
  confirmLabel,
  action,
  fields,
  closeHref,
  canWrite,
  warning,
  labelledById = 'confirm-title',
}: {
  title: string;
  description: string;
  confirmLabel: string;
  action: FormAction;
  fields: { name: string; value: string }[];
  closeHref: string;
  canWrite: boolean;
  /** What will still exist afterwards — stated here rather than assumed by the reader. */
  warning?: string;
  labelledById?: string;
}) {
  const router = useRouter();
  const dismiss = () => router.replace(closeHref);

  return (
    <Modal
      title={title}
      description={description}
      onDismiss={dismiss}
      labelledById={labelledById}
      footer={
        <>
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex min-h-9 items-center rounded-lg px-3 text-[13px] font-medium text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
          >
            Cancel
          </button>
          <Button
            type="submit"
            form="confirm-action-form"
            size="sm"
            variant="danger"
            disabled={!canWrite}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form id="confirm-action-form" action={action}>
        {fields.map((field) => (
          <input key={field.name} type="hidden" name={field.name} value={field.value} />
        ))}
        <input type="hidden" name="next" value={closeHref} />
        {warning ? (
          <p className="text-[13px] leading-relaxed text-slate-600" data-autofocus tabIndex={-1}>
            {warning}
          </p>
        ) : null}
        {!canWrite ? (
          <div className="mt-3">
            <Notice tone="warning" title="This screen cannot write to the current data source">
              <p>The action is unavailable, so nothing will change.</p>
            </Notice>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
