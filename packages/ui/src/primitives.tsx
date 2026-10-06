import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

/**
 * Layout- and form-level primitives. Everything else in the package is composed from these, which is what
 * keeps the visual language consistent without a theme object.
 */

export const controlBase =
  'min-h-10 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus-visible:border-teal-700 focus-visible:ring-2 focus-visible:ring-teal-600/25 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400';

const buttonVariants = {
  primary:
    'bg-slate-950 text-white hover:bg-slate-800 focus-visible:outline-slate-500 disabled:bg-slate-300',
  secondary:
    'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 focus-visible:outline-slate-400 disabled:text-slate-400',
  ghost:
    'text-slate-600 hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-slate-400 disabled:text-slate-300',
  quiet: 'border border-transparent bg-slate-100/70 text-slate-700 hover:bg-slate-200/70',
  /** Destructive or hard-to-undo actions only, so a red button always means something was removed. */
  danger:
    'bg-rose-700 text-white hover:bg-rose-800 focus-visible:outline-rose-500 disabled:bg-rose-300',
} as const;

export type ButtonVariant = keyof typeof buttonVariants;

const buttonSizes = {
  sm: 'min-h-8 px-2.5 text-[13px]',
  md: 'min-h-10 px-4 text-sm',
} as const;

const buttonClass =
  'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed';

/** A form action can be a URL or a server action; both are legal, and components should accept either. */
export type FormAction = string | ((formData: FormData) => Promise<void>);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: keyof typeof buttonSizes;
};

export function Button({
  className = '',
  variant = 'primary',
  size = 'md',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${buttonClass} ${buttonSizes[size]} ${buttonVariants[variant]} ${className}`}
      {...props}
    />
  );
}

/**
 * Navigation actions are links, not click handlers: they stay keyboard- and middle-click-friendly, and the
 * page renders them without a client bundle.
 */
export type ButtonLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  size?: keyof typeof buttonSizes;
  disabled?: boolean;
};

export function ButtonLink({
  className = '',
  variant = 'secondary',
  size = 'md',
  disabled = false,
  href,
  children,
  ...props
}: ButtonLinkProps) {
  if (disabled || !href) {
    return (
      <span
        aria-disabled="true"
        className={`${buttonClass} ${buttonSizes[size]} ${buttonVariants[variant]} pointer-events-none opacity-60 ${className}`}
        {...props}
      >
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      className={`${buttonClass} ${buttonSizes[size]} ${buttonVariants[variant]} ${className}`}
      {...props}
    >
      {children}
    </a>
  );
}

export function IconButton({
  label,
  className = '',
  variant = 'ghost',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`${buttonClass} min-h-8 gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium ${buttonVariants[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${controlBase} ${className}`} {...props} />;
}

export function Textarea({
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${controlBase} min-h-20 leading-relaxed ${className}`} {...props} />;
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${controlBase} pr-8 ${className}`} {...props} />;
}

export function FieldLabel({
  children,
  htmlFor,
  hint,
}: {
  children: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
}) {
  return (
    <span className="mb-1.5 block">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {children}
      </label>
      {hint ? <span className="mt-0.5 block text-xs text-slate-500">{hint}</span> : null}
    </span>
  );
}

/** Labelled control wrapper: keeps the `htmlFor`/`id` pair in one place so no field ships without a label. */
export function Field({
  id,
  label,
  hint,
  children,
  className = '',
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <FieldLabel htmlFor={id} hint={hint}>
        {label}
      </FieldLabel>
      {children}
    </div>
  );
}

export function Card({ children, className = '', ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}
      {...props}
    >
      {children}
    </section>
  );
}

/** `title` is omitted from the DOM props: a card header can hold a link, so it is a node, not a tooltip. */
export type SectionCardProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  /** Omit it for a container that is only a visual frame, e.g. a transcript list. */
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Rendered flush: tables manage their own padding and borders. */
  flush?: boolean;
  anchorId?: string;
};

export function SectionCard({
  title,
  description,
  actions,
  children,
  className = '',
  flush = false,
  anchorId,
  ...props
}: SectionCardProps) {
  return (
    <section
      id={anchorId}
      className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}
      {...props}
    >
      <header
        className={`flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 ${
          title ? '' : 'hidden'
        }`}
      >
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-slate-900">{title}</h2>
          {description ? <p className="mt-0.5 text-[13px] text-slate-500">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className={flush ? undefined : 'px-4 py-3.5'}>{children}</div>
    </section>
  );
}

export type BadgeTone =
  'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'outline';

export const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  accent: 'bg-teal-50 text-teal-800',
  success: 'bg-emerald-50 text-emerald-800',
  warning: 'bg-amber-50 text-amber-900',
  danger: 'bg-rose-50 text-rose-800',
  info: 'bg-sky-50 text-sky-800',
  outline: 'border border-slate-200 text-slate-600',
};

export function Badge({
  children,
  tone = 'neutral',
  className = '',
  title,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${badgeTones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Dot({
  tone = 'neutral',
  className = '',
}: {
  tone?: BadgeTone;
  className?: string;
}) {
  const color: Record<BadgeTone, string> = {
    neutral: 'bg-slate-400',
    accent: 'bg-teal-600',
    success: 'bg-emerald-600',
    warning: 'bg-amber-500',
    danger: 'bg-rose-600',
    info: 'bg-sky-600',
    outline: 'bg-slate-300',
  };
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${color[tone]} ${className}`}
      aria-hidden="true"
    />
  );
}

/** Two-line metric used on the dashboard and detail headers. No charts: a number with a unit beats a sparkline. */
export function Metric({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: BadgeTone;
}) {
  const accent: Record<BadgeTone, string> = {
    neutral: 'text-slate-900',
    accent: 'text-teal-800',
    success: 'text-emerald-800',
    warning: 'text-amber-900',
    danger: 'text-rose-800',
    info: 'text-sky-800',
    outline: 'text-slate-700',
  };
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className={`mt-0.5 text-xl font-semibold tabular-nums ${accent[tone]}`}>{value}</dd>
      {hint ? <p className="mt-0.5 truncate text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function KeyValue({ term, value }: { term: ReactNode; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-slate-100 py-1.5 last:border-0">
      <dt className="text-[13px] text-slate-500">{term}</dt>
      <dd className="text-[13px] font-medium text-slate-900">{value}</dd>
    </div>
  );
}

export function Meta({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-slate-500 ${className}`}
    >
      {children}
    </div>
  );
}

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <code className={`font-mono text-[12.5px] text-slate-600 ${className}`}>{children}</code>;
}

export function Divider({ className = '' }: { className?: string }) {
  return <hr className={`border-0 border-t border-slate-100 ${className}`} />;
}

export function Stack({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-col gap-3 ${className}`}>{children}</div>;
}

export function Row({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-2 ${className}`}>{children}</div>;
}

/**
 * Scroll container for dense tables. The table keeps its own min width instead of being squeezed into an
 * unreadable column stack on a phone.
 */
export function TableScroller({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`-mx-px overflow-x-auto ${className}`}>
      <div className="min-w-[680px]">{children}</div>
    </div>
  );
}

export function Table({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <table className={`w-full border-collapse text-left text-sm ${className}`}>{children}</table>
  );
}

export function Th({
  children,
  className = '',
  align = 'left',
  scope = 'col',
}: {
  children?: ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
  scope?: 'col' | 'row';
}) {
  return (
    <th
      scope={scope}
      className={`whitespace-nowrap border-b border-slate-200 bg-slate-50/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 ${
        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
      } ${className}`}
    >
      {children}
    </th>
  );
}

/**
 * A table cell. `label` is what makes the same markup usable on a narrow screen: inside a `.stacked` table each
 * row becomes a card and the label is printed beside its value, so nobody has to swipe a 6-column table to find
 * a number on a phone.
 */
export function Td({
  children,
  className = '',
  align = 'left',
  label,
  colSpan,
}: {
  children?: ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
  label?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      data-label={label}
      className={`border-b border-slate-100 px-3 py-2.5 align-top text-[13.5px] text-slate-700 ${
        align === 'right' ? 'text-right tabular-nums' : align === 'center' ? 'text-center' : ''
      } ${className}`}
    >
      {children}
    </td>
  );
}

export function Tr({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <tr className={`transition-colors hover:bg-slate-50/70 ${className}`}>{children}</tr>;
}
