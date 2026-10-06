import { Badge, EmptyState, SectionCard, SourceCard } from '@suhbat/ui';
import {
  formatShortDate,
  formatTimestamp,
  intelligenceSectionLabels,
  routes,
  type CompanyIntelligence,
  type DataCapabilities,
} from '@suhbat/product';
import type { Lookup } from '../../../lib/lookup';
import { ui } from '../../../copy/ui-copy';

/** How many entries a section shows before the rest fold under a "more" disclosure. */
const visiblePerSection = 3;

/**
 * The company record: goals, pain points, important facts, decision makers, objections, commitments. Each entry
 * states where it came from, and the header says plainly that fixtures produced it — no model was called.
 *
 * Density without hiding: a section lists its first entries in full and folds the remainder into a native
 * `<details>`, which is openable by keyboard, present in the served HTML, and needs no JavaScript to exist. Empty
 * sections are collected into one line rather than seven italic paragraphs, so the length of the panel tracks how
 * much is actually known. Section anchors let a reader jump straight to what they came for on any screen width.
 */
export function IntelligencePanel({
  intelligence,
  workspaceId,
  lookup,
  capabilities,
}: {
  intelligence: CompanyIntelligence;
  workspaceId: string;
  lookup: Lookup;
  capabilities: DataCapabilities;
}) {
  const sections = (
    Object.entries(intelligenceSectionLabels) as [keyof typeof intelligenceSectionLabels, string][]
  ).map(([key, label]) => ({
    key,
    label,
    items: intelligence[key] as CompanyIntelligence['goals'],
  }));
  const populated = sections.filter((section) => section.items.length > 0);
  const empty = sections.filter((section) => section.items.length === 0);
  const total = populated.reduce((sum, section) => sum + section.items.length, 0);

  return (
    <SectionCard
      title={ui.companies.intelligence.title}
      description={ui.companies.intelligence.note}
      actions={
        <Badge tone={capabilities.mode === 'demo' ? 'outline' : 'accent'}>
          {ui.companies.intelligence.derivedFrom}:{' '}
          {intelligence.derivedFrom === 'demo_fixtures'
            ? ui.companies.intelligence.derivedFromDemo
            : ui.companies.intelligence.derivedFromPipeline}
        </Badge>
      }
    >
      {total === 0 ? (
        <EmptyState
          icon="file"
          title={ui.companies.intelligence.emptySection}
          description={ui.companies.emptyBody}
        />
      ) : (
        <>
          <nav
            aria-label={ui.companies.intelligence.sectionsNav}
            className="-mx-1 mb-3 flex flex-wrap gap-1"
          >
            {populated.map((section) => (
              <a
                key={section.key}
                href={`#intelligence-${section.key}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-50 px-2 py-1 text-[12px] text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
              >
                {section.label}
                <span className="font-semibold tabular-nums text-slate-400">
                  {section.items.length}
                </span>
              </a>
            ))}
          </nav>

          <div className="space-y-3">
            {populated.map((section) => {
              const shown = section.items.slice(0, visiblePerSection);
              const rest = section.items.slice(visiblePerSection);
              return (
                <section
                  key={section.key}
                  id={`intelligence-${section.key}`}
                  className="scroll-mt-24 border-t border-slate-100 pt-3 first:border-t-0 first:pt-0"
                >
                  <h3 className="mb-1.5 flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    {section.label}
                    <span className="text-[11px] font-normal normal-case tracking-normal text-slate-400">
                      {section.items.length === 1
                        ? ui.companies.intelligence.entryOne
                        : ui.companies.intelligence.entryOther}
                    </span>
                  </h3>
                  <ul className="space-y-1.5">
                    {shown.map((item, index) => (
                      <li key={`${section.key}-${index}`}>
                        <IntelligenceEntry
                          item={item}
                          label={section.label}
                          lookup={lookup}
                          position={index + 1}
                        />
                      </li>
                    ))}
                  </ul>
                  {rest.length > 0 ? (
                    <details className="group mt-1.5">
                      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-1.5 py-1 text-[12.5px] font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400">
                        <span
                          aria-hidden
                          className="text-slate-400 transition-transform group-open:rotate-90"
                        >
                          ›
                        </span>
                        {ui.companies.intelligence.more(rest.length)}
                      </summary>
                      <ul className="mt-1.5 space-y-1.5">
                        {rest.map((item, index) => (
                          <li key={`${section.key}-rest-${index}`}>
                            <IntelligenceEntry
                              item={item}
                              label={section.label}
                              lookup={lookup}
                              position={visiblePerSection + index + 1}
                            />
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </section>
              );
            })}
          </div>

          {empty.length > 0 ? (
            <details className="mt-3 rounded-lg bg-slate-50/70 px-3 py-2">
              <summary className="cursor-pointer list-none text-[12.5px] font-medium text-slate-500 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400">
                {ui.companies.intelligence.emptySections(empty.length)}
              </summary>
              <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-slate-500">
                {empty.map((section) => (
                  <li key={section.key}>{section.label}</li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] text-slate-400">
                {ui.companies.intelligence.emptySectionBody}
              </p>
            </details>
          ) : null}
        </>
      )}
      <p className="mt-3 text-[12px] text-slate-500">{ui.companies.intelligence.objectionNote}</p>
      <p className="mt-1 text-[12px] text-slate-400">
        {ui.companies.intelligence.updated}: {formatShortDate(intelligence.updatedAt)} · {total}{' '}
        {ui.companies.intelligence.entries} ·{' '}
        <a href={routes.knowledge({ workspaceId })} className="text-teal-800 hover:underline">
          {ui.knowledge.title}
        </a>
      </p>
    </SectionCard>
  );
}

/**
 * One entry, with its citation attached when there is one. A line without evidence is rendered plainly rather
 * than in a card, because an empty card frame would imply a source that does not exist.
 */
function IntelligenceEntry({
  item,
  label,
  lookup,
  position,
}: {
  item: CompanyIntelligence['goals'][number];
  label: string;
  lookup: Lookup;
  /** Ordinal inside its section, so the card's number matches the list the reader is scanning. */
  position: number;
}) {
  if (!item.evidence)
    return (
      <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] leading-relaxed text-slate-700">
        {item.text}
        {item.personId ? (
          <span className="ml-1.5 text-[11.5px] text-slate-400">
            {lookup.nameOf(item.personId)}
          </span>
        ) : null}
      </p>
    );

  return (
    <SourceCard
      position={position}
      kind={label}
      meetingTitle={item.evidence.meetingTitle}
      dateLabel={formatShortDate(item.evidence.occurredAt)}
      rangeLabel={`${formatTimestamp(item.evidence.startMs)}–${formatTimestamp(item.evidence.endMs)}`}
      quote={item.text}
      href={lookup.evidence.hrefOf(item.evidence)}
      speakerNames={lookup.evidence.namesOf(item.evidence)}
      footer={
        <span className="text-[11.5px] text-slate-400">
          {lookup.nameOf(item.personId) ?? 'not attributed to a person'}
        </span>
      }
    />
  );
}
