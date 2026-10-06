p = 'packages/product/src/demo/repositories.ts'
s = open(p).read()

old = """  const data = clone(source);
  const capabilities: DataCapabilities = { ...DEMO_CAPABILITIES, ...overrides };"""
new = """  const data = clone(source);
  // Overrides must not be able to leave the capability record claiming more than this instance can do: a
  // `writes: false` override disables every action too, so `can()` and the repository never disagree.
  const capabilities: DataCapabilities = (() => {
    const merged: DataCapabilities = { ...DEMO_CAPABILITIES, ...overrides };
    if (!merged.writes)
      return {
        ...merged,
        persistence: 'none',
        persistenceLabel: 'This adapter instance refuses every write; nothing typed here is kept.',
        actions: Object.fromEntries(writeActions.map((key) => [key, false])) as Record<
          WriteActionKey,
          boolean
        >,
      };
    return {
      ...merged,
      actions: {
        ...merged.actions,
        'demo.pipeline': merged.demoStateTransitions,
      },
    };
  })();"""
assert old in s
s = s.replace(old, new, 1)

s = s.replace(
    """import {
  RepositoryError,
  can,
  type DataCapabilities,""",
    """import {
  RepositoryError,
  can,
  writeActions,
  type DataCapabilities,""",
    1,
)

old = """      async advanceDemoState(meetingId) {
        const timeline = processingFor(meetingId);"""
new = """      async advanceDemoState(meetingId) {
        requireAction('demo.pipeline');
        const timeline = processingFor(meetingId);"""
assert old in s
s = s.replace(old, new, 1)

old = """      async updateStatus(taskId, status) {
        const task = data.tasks.find((item) => item.id === taskId);"""
new = """      async updateStatus(taskId, status) {
        requireAction('task.status');
        const task = data.tasks.find((item) => item.id === taskId);"""
assert old in s
s = s.replace(old, new, 1)
open(p, 'w').write(s)

# ------------------------------------------------------------------ test updates
p = 'packages/product/src/demo/repositories.test.ts'
s = open(p).read()

old = """  it('declares demo data with no write path and no real pipeline', () => {
    expect(DEMO_CAPABILITIES.mode).toBe('demo');
    expect(DEMO_CAPABILITIES.reads).toBe('demo');
    expect(DEMO_CAPABILITIES.writes).toBe(false);
    expect(DEMO_CAPABILITIES.pipeline).toBe('simulated');
    expect(DEMO_CAPABILITIES.demoStateTransitions).toBe(true);
    expect(DEMO_CAPABILITIES.playback).toBe('none');
    expect(DEMO_CAPABILITIES.provenanceLabel).toMatch(/no database, no network/i);
  });"""
new = """  it('declares in-memory writes and no real pipeline', () => {
    expect(DEMO_CAPABILITIES.mode).toBe('demo');
    expect(DEMO_CAPABILITIES.reads).toBe('demo');
    // Writes exist; the honesty lives in what the capability record says about where they go.
    expect(DEMO_CAPABILITIES.writes).toBe(true);
    expect(DEMO_CAPABILITIES.persistence).toBe('in_memory');
    expect(DEMO_CAPABILITIES.persistenceLabel).toMatch(/in memory/i);
    expect(DEMO_CAPABILITIES.pipeline).toBe('simulated');
    expect(DEMO_CAPABILITIES.demoStateTransitions).toBe(true);
    expect(DEMO_CAPABILITIES.playback).toBe('none');
    expect(DEMO_CAPABILITIES.provenanceLabel).toMatch(/no database, no network/i);
  });

  it('answers for every action the UI can gate, and none of them are invented keys', () => {
    const actions = DEMO_CAPABILITIES.actions;
    for (const key of writeActions) expect(key in actions).toBe(true);
    // Nothing the demo cannot do is advertised: no cloud persistence, no provider work.
    expect(can(DEMO_CAPABILITIES, 'company.create')).toBe(true);
    expect(can(DEMO_CAPABILITIES, 'transcript.speakerMapping')).toBe(true);
    const readOnly = createDemoRepositories(demoDataset, { writes: false });
    expect(readOnly.capabilities.writes).toBe(false);
    expect(can(readOnly.capabilities, 'company.create')).toBe(false);
  });"""
assert old in s
s = s.replace(old, new, 1)

old = """  it('exposes no write methods that would pretend to save', async () => {
    const repositories = adapter();
    expect(repositories.meetings.createDraft).toBeUndefined();
    expect(repositories.companies.create).toBeUndefined();
    expect(repositories.projects.create).toBeUndefined();
    expect(repositories.settings.createMeetingType).toBeUndefined();
    // Ticking a demo task and mapping a speaker are the two mutations the demo does support.
    expect(typeof repositories.tasks.updateStatus).toBe('function');
    expect(typeof repositories.transcripts.confirmSpeakerMapping).toBe('function');
  });"""
new = """  it('refuses every write when the adapter is configured not to write', async () => {
    const repositories = createDemoRepositories(demoDataset, { writes: false });
    await expect(
      repositories.companies.create({ workspaceId, name: 'Never Created', description: null }),
    ).rejects.toMatchObject({ code: 'unsupported_in_demo' });
    await expect(
      repositories.tasks.updateStatus(demoDataset.tasks[0]!.id, 'completed'),
    ).rejects.toMatchObject({ code: 'unsupported_in_demo' });
    // Reads still work: disabling writes must not turn a screen into an empty one.
    expect((await repositories.companies.list(workspaceId)).length).toBeGreaterThan(0);
  });"""
assert old in s
s = s.replace(old, new, 1)
open(p, 'w').write(s)
print('written')
