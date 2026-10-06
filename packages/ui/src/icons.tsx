/**
 * Small inline icon set. Kept local instead of depending on an icon package: the web app already ships
 * `lucide-react`, but the shared UI package must stay dependency-light, and these are the only glyphs the
 * product surface needs.
 */
import type { ReactNode, SVGProps } from 'react';

const paths: Record<string, ReactNode> = {
  play: <path d="M5 3.5 12.5 8 5 12.5z" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 5v3.2l2.1 1.3" />
    </>
  ),
  quote: (
    <>
      <path d="M3.5 5.5h4v4a2.5 2.5 0 0 1-2.5 2.5" />
      <path d="M9.5 5.5h4v4a2.5 2.5 0 0 1-2.5 2.5" />
    </>
  ),
  check: <path d="m3.5 8.5 3 3 5-7" />,
  alert: (
    <>
      <path d="M8 2.75 14.25 13.5H1.75z" />
      <path d="M8 6.5v3" />
      <path d="M8 11.6v.4" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 7.4v3.4" />
      <path d="M8 5.2v.3" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.2 3.2" />
    </>
  ),
  chevronRight: <path d="m6.5 3.5 4 4.5-4 4.5" />,
  chevronDown: <path d="m3.5 6 4.5 4 4.5-4" />,
  arrowRight: (
    <>
      <path d="M2.75 8h10.5" />
      <path d="m10 4.5 3.5 3.5L10 11.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M13 6.5A5.2 5.2 0 0 0 3.6 5.4" />
      <path d="M3 9.5a5.2 5.2 0 0 0 9.4 1.1" />
      <path d="M13.2 3.4v3.1h-3.1" />
      <path d="M2.8 12.6v-3.1h3.1" />
    </>
  ),
  user: (
    <>
      <circle cx="8" cy="6" r="2.75" />
      <path d="M2.9 13.4c.6-2.3 2.6-3.6 5.1-3.6s4.5 1.3 5.1 3.6" />
    </>
  ),
  link: (
    <>
      <path d="M6.6 9.4 9.4 6.6" />
      <path d="M5.2 7.4 3.9 8.7a2.4 2.4 0 0 0 3.4 3.4l1.3-1.3" />
      <path d="M10.8 8.6 12.1 7.3a2.4 2.4 0 0 0-3.4-3.4L7.4 5.2" />
    </>
  ),
  dots: (
    <>
      <circle cx="4" cy="8" r=".8" />
      <circle cx="8" cy="8" r=".8" />
      <circle cx="12" cy="8" r=".8" />
    </>
  ),
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  layers: (
    <>
      <path d="M8 2.5 13.5 5.5 8 8.5 2.5 5.5z" />
      <path d="M2.5 8 8 11l5.5-3" />
      <path d="M2.5 10.5 8 13.5l5.5-3" />
    </>
  ),
  sparkles: (
    <>
      <path d="M6 2.5 6.9 5l2.6.9-2.6.9L6 9.4 5.1 6.8 2.5 5.9 5.1 5z" />
      <path d="M11.5 9.5l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4L9.6 11.4l1.4-.5z" />
    </>
  ),
  building: (
    <>
      <path d="M3 13.5V4.5L8 2.75l5 1.75v9" />
      <path d="M6 7h1M10 7h1M6 10h1M10 10h1" />
    </>
  ),
  folder: (
    <>
      <path d="M2.5 12.5v-7h4l1.2 1.5h5.8v5.5z" />
      <path d="M2.5 7h11" />
    </>
  ),
  mic: (
    <>
      <rect x="6.2" y="2" width="3.6" height="6.5" rx="1.8" />
      <path d="M3.8 7.6a4.2 4.2 0 0 0 8.4 0" />
      <path d="M8 11.9V14" />
    </>
  ),
  file: (
    <>
      <path d="M4 2.5h5l3 3v8.5H4z" />
      <path d="M9 2.5v3h3" />
    </>
  ),
};

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 16,
  className = '',
  ...props
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
