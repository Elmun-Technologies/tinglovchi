import type { Analysis } from '../../../lib/quick/types';

const BRANCH_COLORS = ['#0f766e', '#7c3aed', '#c2410c', '#2563eb', '#be123c', '#4d7c0f', '#a16207'];

type Branch = Analysis['mindMap']['branches'][number];

function BranchCard({
  branch,
  color,
  side,
}: {
  branch: Branch;
  color: string;
  side: 'left' | 'right';
}) {
  return (
    <div className={`relative flex items-center ${side === 'left' ? 'flex-row-reverse' : ''}`}>
      {/* Connector from the center column to this branch. */}
      <span
        className="hidden h-0.5 w-8 shrink-0 md:block"
        style={{ background: color }}
        aria-hidden
      />
      <div
        className="w-full rounded-xl border-2 bg-white p-3 shadow-sm"
        style={{ borderColor: color }}
      >
        <p className="font-semibold" style={{ color }}>
          {branch.title}
        </p>
        {branch.children.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {branch.children.map((child, index) => (
              <li
                key={index}
                className="rounded-md px-2 py-1 text-xs text-slate-800"
                style={{ background: `${color}14` }}
              >
                {child}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** Center topic in the middle, branches split to its left and right; a single column on phones. */
export function MindMap({ map }: { map: Analysis['mindMap'] }) {
  const colored = map.branches.map((branch, index) => ({
    branch,
    color: BRANCH_COLORS[index % BRANCH_COLORS.length]!,
  }));
  const half = Math.ceil(colored.length / 2);
  const left = colored.slice(0, half);
  const right = colored.slice(half);

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 md:p-8">
      <div className="grid items-center gap-4 md:grid-cols-[1fr_auto_1fr] md:gap-0">
        <div className="order-2 space-y-4 md:order-1">
          {left.map(({ branch, color }, index) => (
            <BranchCard key={index} branch={branch} color={color} side="left" />
          ))}
        </div>
        <div className="order-1 flex justify-center md:order-2">
          <div className="max-w-56 rounded-2xl bg-slate-900 px-5 py-4 text-center text-lg font-semibold text-white shadow-lg">
            {map.center}
          </div>
        </div>
        <div className="order-3 space-y-4">
          {right.map(({ branch, color }, index) => (
            <BranchCard key={index} branch={branch} color={color} side="right" />
          ))}
        </div>
      </div>
    </div>
  );
}
