import { describe, expect, it } from 'vitest';
import { demoDataset } from './dataset';
import { assertDemoIntegrity, demoIntegrityIssues } from './integrity';
import { buildAskAnswer, citationRange, demoAskSuggestions, demoKnownQuestions } from './ask';

/**
 * Fixture integrity. These assertions are the reason "the demo is internally consistent" is a fact rather an
 * adjective: every evidence reference must resolve, every count must match its children, and every Ask AI
 * citation must point at a record that exists.
 */

describe('demo dataset integrity', () => {
  it('has no dangling or inconsistent reference', () => {
    const issues = demoIntegrityIssues(demoDataset);
    expect(issues.map((issue) => `${issue.path}: ${issue.message}`)).toEqual([]);
    expect(() => assertDemoIntegrity(demoDataset)).not.toThrow();
  });

  it('keeps every artifact inside the meeting it cites', () => {
    const meetingIds = new Set(demoDataset.meetings.map((meeting) => meeting.id));
    for (const decision of demoDataset.decisions)
      expect(meetingIds.has(decision.meetingId)).toBe(true);
    expect(demoDataset.decisions.length).toBeGreaterThanOrEqual(15);
    expect(demoDataset.tasks.length).toBeGreaterThanOrEqual(15);
    expect(demoDataset.facts.length).toBeGreaterThanOrEqual(20);
    expect(demoDataset.ideas.length).toBeGreaterThanOrEqual(4);
    expect(demoDataset.commitments.length).toBeGreaterThanOrEqual(5);
  });

  it('cites transcript lines that exist, with a resolvable range and speakers', () => {
    const flagship = demoDataset.meetings.find(
      (meeting) => meeting.id === 'meeting_foodera_marketing_strategy',
    )!;
    const segments = demoDataset.transcripts[flagship.id]!.segments;
    expect(segments.length).toBe(59);
    const decision = demoDataset.decisions.find((item) => item.id === 'dec_foodera_budget_held')!;
    const evidence = decision.evidence[0]!;
    expect(evidence.meetingId).toBe(flagship.id);
    expect(evidence.segmentIds.length).toBeGreaterThan(0);
    expect(evidence.endMs).toBeGreaterThan(evidence.startMs);
    expect(evidence.quote).toContain('$5 000');
    expect(evidence.speakerPersonIds.length).toBeGreaterThan(0);
    for (const id of evidence.segmentIds)
      expect(segments.some((segment) => segment.id === id)).toBe(true);
  });

  it('keeps the flagship meeting’s own summary claim truthful', () => {
    const flagship = demoDataset.details['meeting_foodera_marketing_strategy']!;
    const wrapUp = demoDataset.transcripts[flagship.id]!.segments.at(-1)!.text;
    expect(wrapUp).toContain('6 ta decision');
    expect(flagship.counts.decisions).toBe(6);
    expect(flagship.counts.tasks).toBe(6);
    expect(flagship.stats.openQuestions).toBe(1);
  });

  it('separates canonical duration from captured duration', () => {
    const flagship = demoDataset.meetings.find((meeting) => meeting.capturedMs !== null)!;
    expect(flagship.durationMs).toBeGreaterThan(flagship.capturedMs!);
    expect(flagship.capturedMs!).toBeGreaterThan(0);
  });

  it('leaves one diarization label unattributed on purpose', () => {
    const nomad = demoDataset.details['meeting_nomad_q3_pipeline']!;
    expect(nomad.unmappedSpeakers).toEqual(['Speaker C']);
    const segments = demoDataset.transcripts['meeting_nomad_q3_pipeline']!.segments;
    const unmapped = segments.filter((segment) => segment.speakerPersonId === null);
    expect(unmapped.length).toBeGreaterThan(0);
    expect(unmapped.every((segment) => segment.speakerLabel === 'Speaker C')).toBe(true);
    expect(nomad.participants.some((participant) => participant.speakerLabel === 'Speaker C')).toBe(
      false,
    );
  });

  it('covers the processing states the product must render', () => {
    const states = demoDataset.meetings.map((meeting) => meeting.state);
    expect(new Set(states)).toEqual(new Set(['ready', 'analyzing', 'failed', 'draft']));
    const failed = demoDataset.processing['meeting_chirchik_export_review']!;
    expect(failed.error?.retryable).toBe(true);
    expect(failed.steps.some((step) => step.state === 'failed')).toBe(true);
  });

  it('models the desktop recorder as not validated, never as recording', async () => {
    const repositories = (await import('./repositories')).createDemoRepositories(demoDataset);
    const status = await repositories.desktop.status();
    expect(status.state).toBe('not_validated');
    expect(status.detail).toMatch(/not been validated/i);
  });

  it('gives every company an intelligence summary whose facts carry evidence', () => {
    for (const company of demoDataset.companies) {
      const record = demoDataset.intelligence[company.id]!;
      expect(record.derivedFrom).toBe('demo_fixtures');
      expect(record.goals.length).toBeGreaterThan(0);
      expect(record.painPoints.length).toBeGreaterThan(0);
      if (record.importantFacts.length > 0) {
        expect(record.importantFacts[0]!.evidence?.segmentIds.length).toBeGreaterThan(0);
      }
    }
  });

  it('links topics, segments, decisions and tasks in both directions', () => {
    const topics = demoDataset.topicsByMeeting['meeting_foodera_marketing_strategy']!;
    const parents = topics.filter((topic) => topic.parentId === null);
    expect(parents.length).toBeGreaterThanOrEqual(4);
    const marketing = parents.find((topic) => topic.title === 'Marketing')!;
    const children = topics.filter((topic) => topic.parentId === marketing.id);
    expect(children.length).toBe(3);
    expect(marketing.segmentIds.length).toBe(
      children.reduce((sum, child) => sum + child.segmentIds.length, 0),
    );
    const budget = topics.find((topic) => topic.id === 'topic_foodera_budget')!;
    expect(budget.decisionIds).toContain('dec_foodera_budget_held');
    expect(budget.taskIds.length).toBe(0);
    const nextSteps = parents.find((topic) => topic.title === 'Next steps')!;
    expect(nextSteps.taskIds.length).toBeGreaterThan(1);
  });
});

describe('Ask AI demo adapter', () => {
  it('answers every known example question with resolving citations', () => {
    for (const known of demoKnownQuestions) {
      const answer = buildAskAnswer(demoDataset, known.question);
      expect(answer.matchedKnownQuestion).toBe(true);
      expect(answer.adapter).toBe('demo_fixtures');
      expect(answer.citations.length).toBe(known.cites.length);
      expect(answer.answer.length).toBeGreaterThan(1);
      for (const citation of answer.citations) {
        expect(citationRange(citation)).toMatch(/^\d{2}:\d{2}/);
        const segments = demoDataset.transcripts[citation.meetingId]?.segments ?? [];
        expect(segments.length).toBeGreaterThan(0);
        // A known answer must cite lines, not just a time range, so its source card can deep-link.
        expect(citation.segmentIds.length).toBeGreaterThan(0);
        for (const segmentId of citation.segmentIds) {
          expect(segments.some((segment) => segment.id === segmentId)).toBe(true);
        }
      }
    }
  });

  it('is deterministic: the same question yields byte-identical answers', () => {
    const question = 'Which deadlines are overdue?';
    const first = buildAskAnswer(demoDataset, question);
    const second = buildAskAnswer(demoDataset, question);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('falls back to ranked retrieval and says so', () => {
    const answer = buildAskAnswer(demoDataset, 'certificates for the Almaty party');
    expect(answer.matchedKnownQuestion).toBe(false);
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.notes.join(' ')).toMatch(/deterministic retrieval/i);
  });

  it('admits when the corpus has nothing, instead of inventing an answer', () => {
    const answer = buildAskAnswer(demoDataset, 'quantic flux capacitor calibration');
    expect(answer.citations).toEqual([]);
    expect(answer.answer.join(' ')).toMatch(/Nothing in this workspace/i);
  });

  it('suggests questions that all resolve', () => {
    expect(demoAskSuggestions.length).toBeGreaterThanOrEqual(5);
    for (const suggestion of demoAskSuggestions) {
      const answer = buildAskAnswer(demoDataset, suggestion);
      expect(answer.citations.length).toBeGreaterThan(0);
    }
  });
});
