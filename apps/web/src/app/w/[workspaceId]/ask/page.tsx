import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  Input,
  Notice,
  PageHeader,
  SectionCard,
  SourceCard,
} from '@suhbat/ui';
import {
  formatTimestamp,
  RepositoryError,
  routes,
  type AskAiAnswer,
  type AskAiCitation,
} from '@suhbat/product';
import { getRepositories } from '../../../../lib/repositories';
import { ui } from '../../../../copy/ui-copy';

export const metadata = { title: ui.ask.title };

/**
 * Ask AI. The UI is complete; the answer comes from an isolated adapter (`askAi.ask`) whose demo implementation
 * is fixture-backed and deterministic. Nothing here performs a network call, and the screen says which adapter
 * produced an answer instead of letting a fixture read like a model.
 */
export default async function AskPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const asked = (Array.isArray(query.q) ? query.q[0] : query.q) ?? '';
  const repositories = getRepositories();

  const suggestions = await repositories.askAi.suggestions(workspaceId);
  let answer: AskAiAnswer | null = null;
  let failure: RepositoryError | null = null;
  if (asked.trim().length > 0) {
    try {
      answer = await repositories.askAi.ask(workspaceId, asked);
    } catch (cause) {
      failure =
        cause instanceof RepositoryError
          ? cause
          : new RepositoryError('provider_unavailable', 'The question could not be answered.');
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={ui.ask.title}
        description={ui.ask.intro}
        meta={<span className="text-[12.5px] text-slate-500">{ui.ask.disclaimer}</span>}
      />

      <SectionCard flush className="border-0 bg-transparent p-0 shadow-none">
        <form
          action={routes.ask({ workspaceId })}
          method="get"
          className="flex flex-wrap items-start gap-2"
        >
          <div className="min-w-[16rem] flex-1">
            <label htmlFor="ask-q" className="sr-only">
              {ui.ask.placeholder}
            </label>
            <Input
              id="ask-q"
              name="q"
              defaultValue={asked}
              placeholder={ui.ask.placeholder}
              className="min-h-11 text-[14px]"
            />
            {asked.trim().length === 0 ? (
              <p className="mt-1.5 text-[12px] text-slate-500">{ui.ask.questionError}</p>
            ) : null}
          </div>
          <Button type="submit" className="min-h-11">
            {ui.ask.submit}
          </Button>
          {asked ? (
            <ButtonLink href={routes.ask({ workspaceId })} variant="ghost" className="min-h-11">
              {ui.ask.clear}
            </ButtonLink>
          ) : null}
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {ui.ask.suggestions}
          </span>
          {suggestions.map((suggestion) => (
            <a
              key={suggestion}
              href={routes.ask({ workspaceId }, { q: suggestion })}
              className={`rounded-full border px-2.5 py-1 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 ${
                suggestion === asked
                  ? 'border-teal-700/40 bg-teal-50 text-teal-950'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'
              }`}
            >
              {suggestion}
            </a>
          ))}
        </div>
      </SectionCard>

      {failure ? (
        <ErrorState
          title={ui.errors.providerTitle}
          message={failure.message}
          code={failure.code}
          hint={failure.hint}
          retryHref={routes.ask({ workspaceId }, { q: asked })}
        />
      ) : null}

      {answer ? <AnswerView answer={answer} workspaceId={workspaceId} /> : null}

      {!answer && !failure ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState icon="sparkles" title={ui.ask.noAnswer} description={ui.ask.emptyBody} />
        </div>
      ) : null}
    </div>
  );
}

function AnswerView({ answer, workspaceId }: { answer: AskAiAnswer; workspaceId: string }) {
  // The wording follows the adapter the answer actually came from, so a later real pipeline reads correctly
  // without anyone editing this screen — and the demo answer never claims to have been generated.
  const isDemoAdapter = answer.adapter === 'demo_fixtures';
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <SectionCard
        title={answer.question}
        description={`${ui.ask.asked} ${answer.generatedAt.slice(0, 16).replace('T', ' ')}`}
        actions={
          <Badge tone={answer.matchedKnownQuestion ? 'accent' : 'outline'}>
            {answer.matchedKnownQuestion
              ? ui.ask.authoredDemo
              : isDemoAdapter
                ? ui.ask.retrievalDemo
                : ui.ask.adapterRag}
          </Badge>
        }
      >
        <div className="space-y-2.5">
          {answer.answer.map((line, index) => (
            <p
              key={index}
              className={
                index === 0
                  ? 'text-[14.5px] leading-relaxed text-slate-900'
                  : 'border-l-2 border-slate-200 pl-3 text-[13.5px] leading-relaxed text-slate-700'
              }
            >
              {line}
            </p>
          ))}
        </div>
        <Notice
          tone={isDemoAdapter ? 'neutral' : 'info'}
          className="mt-3"
          title={ui.ask.provenanceTitle}
        >
          <p>
            {isDemoAdapter ? ui.ask.provenanceDemo : ui.ask.provenancePipeline}{' '}
            {isDemoAdapter ? ui.ask.deterministicBadge + '.' : ''}
          </p>
          {answer.notes.map((note, index) => (
            <p key={index} className="text-slate-500">
              {note}
            </p>
          ))}
          <p className="text-slate-500">
            {ui.ask.adapterLabel}:{' '}
            <span className="font-medium">
              {isDemoAdapter ? ui.ask.adapterDemo : ui.ask.adapterRag}
            </span>{' '}
            · <code className="font-mono text-[11.5px]">{answer.adapter}</code>
          </p>
        </Notice>
      </SectionCard>

      <SectionCard
        title={ui.ask.sources}
        description={`${answer.citations.length} ${answer.citations.length === 1 ? 'record' : 'records'} behind this answer.`}
      >
        {answer.citations.length === 0 ? (
          <p className="text-[13px] text-slate-500">{ui.ask.noSources}</p>
        ) : (
          <ol className="space-y-2.5">
            {answer.citations.map((citation, index) => (
              <SourceListItem
                key={`${citation.kind}-${citation.id}`}
                citation={citation}
                index={index + 1}
                workspaceId={workspaceId}
              />
            ))}
          </ol>
        )}
      </SectionCard>
    </div>
  );
}

function SourceListItem({
  citation,
  index,
  workspaceId,
}: {
  citation: AskAiCitation;
  index: number;
  workspaceId: string;
}) {
  const segment = citation.segmentIds[0];
  const href = segment
    ? routes.evidence({
        workspaceId,
        meetingId: citation.meetingId,
        segmentId: segment,
        startMs: citation.startMs,
      })
    : routes.meetingTab(
        { workspaceId, meetingId: citation.meetingId, tab: citation.target },
        { t: citation.startMs },
      );
  return (
    <SourceCard
      position={index}
      kind={citation.kind}
      meetingTitle={citation.meetingTitle}
      dateLabel={citation.occurredAt.slice(0, 10)}
      rangeLabel={`${formatTimestamp(citation.startMs)}–${formatTimestamp(citation.endMs)}`}
      speakerNames={citation.speakerNames}
      quote={citation.quote}
      href={href}
      footer={
        <span className="text-[11.5px] text-slate-400">
          {citation.segmentIds.length > 0
            ? `${citation.segmentIds.length} cited ${citation.segmentIds.length === 1 ? 'line' : 'lines'}`
            : 'time range only'}
        </span>
      }
    />
  );
}
