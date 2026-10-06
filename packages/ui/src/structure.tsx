/**
 * Page scaffolding: header, breadcrumb, tab navigation, filters, disclosure.
 *
 * These are deliberately free of client hooks — tabs are links and filters are GET forms, so the product
 * surface navigates and filters with no client state. Only `Modal` (see `./modal`) needs JS, and it is its own
 * module so importing it does not pull a page's header into the client bundle.
 */
import type { ReactNode } from 'react';
import { Icon } from './icons';
import { Button, ButtonLink, controlBase } from './primitives';
export function PageHeader({
  title,
  description,
  breadcrumbs,
  meta,
  actions,
  className = '',
  headingId,
}: {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: { label: ReactNode; href?: string }[];
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
  headingId?: string;
}) {
  return (
    <header className={`space-y-2 ${className}`}>
      {breadcrumbs && breadcrumbs.length > 0 ? <Breadcrumbs items={breadcrumbs} /> : null}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1
            id={headingId}
            className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-slate-950"
          >
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-3xl text-[13.5px] leading-relaxed text-slate-600">
              {description}
            </p>
          ) : null}
          {meta ? <div className="mt-2">{meta}</div> : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}

export function Breadcrumbs({ items }: { items: { label: ReactNode; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-[12.5px] text-slate-500">
        {items.map((item, index) => (
          <li key={index} className="flex items-center gap-1">
            {index > 0 ? (
              <span aria-hidden="true" className="text-slate-300">
                <Icon name="chevronRight" size={12} />
              </span>
            ) : null}
            {item.href && index !== items.length - 1 ? (
              <a
                href={item.href}
                className="rounded-sm hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
              >
                {item.label}
              </a>
            ) : (
              <span
                className={index === items.length - 1 ? 'font-medium text-slate-700' : undefined}
              >
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export type TabItem = {
  href: string;
  label: ReactNode;
  count?: number;
  id: string;
  active?: boolean;
};

/**
 * Tabs that are real routes. `role="tablist"` is intentionally not used: ARIA tabs imply panel switching in
 * one document, while these are links to separate pages. The `aria-current` marker carries the same meaning
 * honestly.
 */
export function TabNav({ tabs, className = '' }: { tabs: TabItem[]; className?: string }) {
  return (
    <nav aria-label="Sections" className={`-mb-px overflow-x-auto ${className}`}>
      <ul className="flex min-w-max items-center gap-1 border-b border-slate-200">
        {tabs.map((tab) => (
          <li key={tab.id}>
            <a
              href={tab.href}
              aria-current={tab.active ? 'page' : undefined}
              className={`flex items-center gap-1.5 rounded-t-md border-b-2 border-transparent px-3 py-2 text-[13px] font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 ${
                tab.active ? '!border-teal-700 !text-slate-900' : ''
              }`}
            >
              {tab.label}
              {typeof tab.count === 'number' ? (
                <span className="rounded-full bg-slate-100 px-1.5 py-px text-[11px] font-semibold tabular-nums text-slate-600">
                  {tab.count}
                </span>
              ) : null}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function FilterBar({
  children,
  resetHref,
  action,
  className = '',
  label = 'Filters',
}: {
  children: ReactNode;
  resetHref?: string;
  action?: string;
  className?: string;
  label?: string;
}) {
  return (
    <form
      action={action}
      method="get"
      role="search"
      aria-label={label}
      className={`rounded-xl border border-slate-200 bg-white p-3 shadow-sm ${className}`}
    >
      <div className="flex flex-wrap items-end gap-2.5">
        {children}
        <div className="ml-auto flex items-center gap-2">
          <Button type="submit" variant="primary" size="sm">
            <Icon name="search" size={14} />
            Apply
          </Button>
          {resetHref ? (
            <ButtonLink href={resetHref} variant="ghost" size="sm">
              Reset
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </form>
  );
}

export function FilterField({
  label,
  htmlFor,
  children,
  className = '',
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label htmlFor={htmlFor} className={`min-w-[9.5rem] flex-1 sm:flex-none ${className}`}>
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

export function FilterSelect({
  id,
  name,
  value,
  options,
  className = '',
}: {
  id: string;
  name: string;
  value?: string;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <select
      id={id}
      name={name}
      defaultValue={value ?? ''}
      className={`${controlBase} min-h-9 py-1.5 pr-7 text-[13px] ${className}`}
    >
      {options.map((option) => (
        <option key={`${name}-${option.value}`} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function FilterTextInput({
  id,
  name,
  value,
  placeholder,
  type = 'text',
  className = '',
}: {
  id: string;
  name: string;
  value?: string;
  placeholder?: string;
  type?: 'text' | 'date';
  className?: string;
}) {
  return (
    <input
      id={id}
      name={name}
      type={type}
      defaultValue={value ?? ''}
      placeholder={placeholder}
      className={`${controlBase} min-h-9 py-1.5 text-[13px] ${className}`}
    />
  );
}

/** Compact search box used in page headers; submits as a GET so it is linkable and back-button-friendly. */
export function SearchBox({
  action,
  name = 'q',
  value,
  placeholder = 'Search',
  id,
  className = '',
}: {
  action: string;
  name?: string;
  value?: string;
  placeholder?: string;
  id: string;
  className?: string;
}) {
  return (
    <form
      action={action}
      method="get"
      role="search"
      className={`flex items-center gap-1.5 ${className}`}
    >
      <label htmlFor={id} className="sr-only">
        {placeholder}
      </label>
      <div className="relative flex-1">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">
          <Icon name="search" size={14} />
        </span>
        <input
          id={id}
          name={name}
          type="search"
          defaultValue={value ?? ''}
          placeholder={placeholder}
          className={`${controlBase} min-h-9 py-1.5 pl-8 text-[13px]`}
        />
      </div>
      <Button type="submit" size="sm" variant="secondary">
        Search
      </Button>
    </form>
  );
}

/**
 * Progressive disclosure for secondary actions ("More" menus). `<details>` gives keyboard and screen-reader
 * behaviour for free, with no popover positioning code to get wrong.
 */
export function Disclosure({
  label,
  children,
  align = 'right',
  className = '',
}: {
  label: ReactNode;
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <details className={`group relative ${className}`}>
      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 [&::-webkit-details-marker]:hidden">
        {label}
        <span className="text-slate-400 group-open:rotate-180 transition-transform">
          <Icon name="chevronDown" size={13} />
        </span>
      </summary>
      <div
        className={`absolute z-20 mt-1 min-w-[13rem] rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg ${
          align === 'right' ? 'right-0' : 'left-0'
        }`}
      >
        {children}
      </div>
    </details>
  );
}

export function DisclosureItem({
  label,
  href,
  onClick,
  hint,
  disabled,
  icon,
}: {
  label: string;
  href?: string;
  onClick?: () => void;
  hint?: string;
  disabled?: boolean;
  icon?: 'link' | 'file' | 'mic' | 'user' | 'refresh';
}) {
  const content = (
    <>
      {icon ? <Icon name={icon} size={14} className="text-slate-400" /> : null}
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-[13px] font-medium">{label}</span>
        {hint ? (
          <span className="block text-[11.5px] leading-snug text-slate-500">{hint}</span>
        ) : null}
      </span>
    </>
  );
  const classes =
    'flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 disabled:cursor-not-allowed disabled:text-slate-400';
  if (href && !disabled) {
    return (
      <a href={href} className={classes}>
        {content}
      </a>
    );
  }
  return (
    <button type="button" className={classes} onClick={onClick} disabled={disabled}>
      {content}
    </button>
  );
}
