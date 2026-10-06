import type { ReactNode } from 'react';
import { Button, ButtonLink, Field, Notice, SectionCard, type FormAction } from '@suhbat/ui';
import type { DataCapabilities } from '@suhbat/product';
import { ui } from '../../copy/ui-copy';

/**
 * The shared shape of every create/edit form on the product surface.
 *
 * One component holds the three things each form owes the reader: where the value will go (the adapter's own
 * `persistenceLabel`, not a sentence invented per page), whether this build can write at all, and a submit that
 * is a real POST to a server action rather than a client-side promise. Fields stay in the page because their
 * names, values and limits are the page's business.
 */
export function WriteForm({
  title,
  description,
  action,
  next,
  submitLabel,
  capabilities,
  canWrite,
  children,
  aside,
  formId = 'write-form',
  danger,
}: {
  title: string;
  description?: string;
  action: FormAction;
  next: string;
  submitLabel: string;
  capabilities: DataCapabilities;
  canWrite: boolean;
  children: ReactNode;
  /** Anything the form needs beside the fields: a duplicate check, a preview, a rule explanation. */
  aside?: ReactNode;
  formId?: string;
  /** An update that can undo something (an archive) reads as less final than one that cannot. */
  danger?: boolean;
}) {
  return (
    <SectionCard
      title={title}
      description={description}
      actions={
        capabilities.mode === 'demo' ? (
          <span className="text-[11px] uppercase tracking-wide text-slate-500">
            {ui.demo.badge}
          </span>
        ) : null
      }
    >
      <form id={formId} action={action} className="space-y-4">
        <input type="hidden" name="next" value={next} />
        <div className={aside ? 'grid gap-4 sm:grid-cols-[minmax(0,1fr)_15rem]' : 'space-y-4'}>
          <div className="space-y-4">{children}</div>
          {aside ? <div className="space-y-3 text-[13px] text-slate-600">{aside}</div> : null}
        </div>
        {!canWrite ? (
          <Notice tone="warning" title={ui.writes.readOnlyTitle}>
            <p>{capabilities.persistenceLabel}</p>
          </Notice>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={!canWrite}>
            {submitLabel}
          </Button>
          <ButtonLink href={next} variant="ghost">
            {ui.writes.cancel}
          </ButtonLink>
          <PersistenceLine capabilities={capabilities} />
        </div>
      </form>
    </SectionCard>
  );
}

/** One line, from the adapter: what "saved" means for the data source currently in use. */
export function PersistenceLine({ capabilities }: { capabilities: DataCapabilities }) {
  return (
    <p className="text-[12.5px] text-slate-500" title={capabilities.provenanceLabel}>
      <span className="font-medium text-slate-600">{ui.writes.persistenceNote}:</span>{' '}
      {capabilities.persistenceLabel}
    </p>
  );
}

/** A read-only line inside a form: a value the reader should see but not edit. */
export function StaticField({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <Field id={id} label={label}>
      <input
        id={id}
        value={value}
        readOnly
        aria-readonly="true"
        className="min-h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-800"
      />
    </Field>
  );
}
