import {
  Badge,
  EmptyState,
  ErrorState,
  Icon,
  KeyValue,
  Notice,
  PageHeader,
  SectionCard,
  Table,
  TableScroller,
  Td,
  Th,
  Tr,
} from '@suhbat/ui';
import {
  languageLabels,
  routes,
  toRepositoryError,
  can,
  type DataCapabilities,
} from '@suhbat/product';
import type { SettingsSnapshot } from '@suhbat/product';
import { getRepositories } from '../../../../lib/repositories';
import { ui } from '../../../../copy/ui-copy';
import { Field, Input, Select } from '@suhbat/ui';
import { WriteForm } from '../../../components/write-form';
import { FlashNotice } from '../../../components/flash-notice';
import { ConfirmAction } from '../../../components/confirm-action';
import {
  inviteMemberAction,
  removeMemberAction,
  renameWorkspaceAction,
  saveMeetingTypeAction,
  saveVocabularyTermAction,
  setMemberRoleAction,
} from '../../../actions/product';

export const metadata = { title: ui.settings.title };

/**
 * Settings, section by section through the address bar rather than client tab state: every panel is linkable,
 * and the sections that would write somewhere state what is not connected instead of showing a form that
 * quietly does nothing.
 */
const sections = [
  'workspace',
  'members',
  'meetingTypes',
  'vocabulary',
  'recording',
  'ai',
  'integrations',
] as const;
type SettingsSection = (typeof sections)[number];

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const requested =
    (Array.isArray(query.section) ? query.section[0] : query.section) ?? 'workspace';
  const section: SettingsSection = (sections as readonly string[]).includes(requested)
    ? (requested as SettingsSection)
    : 'workspace';

  const repositories = getRepositories();
  const loaded = await repositories.settings.get(workspaceId).then(
    (settings) => ({ ok: true as const, settings }),
    (cause) => ({ ok: false as const, error: toRepositoryError(cause) }),
  );

  if (!loaded.ok) {
    return (
      <div className="space-y-5">
        <PageHeader title={ui.settings.title} description={ui.settings.intro} />
        <ErrorState
          title={
            loaded.error.code === 'not_found' ? ui.errors.notFoundTitle : ui.errors.providerTitle
          }
          message={loaded.error.message}
          code={loaded.error.code}
          detail={loaded.error.detail}
          retryHref={routes.settings({ workspaceId })}
        />
      </div>
    );
  }

  const { settings } = loaded;
  const capabilities = repositories.capabilities;
  // Only the vocabulary panel needs the company list, and only to offer a scope — so it is read for that section.
  const companies =
    section === 'vocabulary'
      ? await repositories.companies
          .list(workspaceId, { includeArchived: true })
          .then((rows) => rows.map((row) => ({ id: row.id, name: row.name })))
          .catch(() => [])
      : [];

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={ui.settings.title}
        description={ui.settings.intro}
        meta={
          <span className="text-[12.5px] text-slate-500">
            {settings.workspaceName} · {settings.members.length}{' '}
            {ui.settings.workspace.members.toLowerCase()} · {settings.meetingTypes.length}{' '}
            {ui.settings.meetingTypes.builtIn.toLowerCase()}
          </span>
        }
        actions={
          <Badge
            tone={capabilities.mode === 'demo' ? 'outline' : 'success'}
            title={capabilities.provenanceLabel}
          >
            {capabilities.mode === 'demo' ? ui.demo.badge : 'Live'}
          </Badge>
        }
      />

      <nav aria-label={ui.settings.sections.workspace} className="flex flex-wrap gap-1.5">
        {sections.map((key) => {
          const active = key === section;
          return (
            <a
              key={key}
              href={routes.settings({ workspaceId }, key)}
              aria-current={active ? 'page' : undefined}
              className={`rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 ${
                active ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:text-slate-900'
              }`}
            >
              {ui.settings.sections[key]}
            </a>
          );
        })}
      </nav>

      {section === 'workspace' || section === 'members' ? (
        <WorkspaceSection
          workspaceId={workspaceId}
          settings={settings}
          capabilities={capabilities}
          mode={section}
          query={query}
        />
      ) : null}
      {section === 'meetingTypes' ? (
        <MeetingTypesSection
          workspaceId={workspaceId}
          settings={settings}
          capabilities={capabilities}
          query={query}
        />
      ) : null}
      {section === 'vocabulary' ? (
        <VocabularySection
          settings={settings}
          capabilities={capabilities}
          workspaceId={workspaceId}
          companies={companies}
          query={query}
        />
      ) : null}
      {section === 'recording' ? (
        <RecordingSection workspaceId={workspaceId} settings={settings} />
      ) : null}
      {section === 'ai' ? <AiSection settings={settings} /> : null}
      {section === 'integrations' ? <IntegrationsSection settings={settings} /> : null}
    </div>
  );
}

type SectionProps = { settings: SettingsSnapshot };

function WorkspaceSection({
  workspaceId,
  settings,
  capabilities,
  mode,
  query,
}: SectionProps & {
  workspaceId: string;
  capabilities: DataCapabilities;
  /** `members` renders only the roster, so the nav has somewhere to point. */
  mode: 'workspace' | 'members';
  query: Record<string, string | string[] | undefined>;
}) {
  const canWrite = can(capabilities, 'workspace.rename');
  const canInvite = can(capabilities, 'workspace.members.invite');
  const canRemove = can(capabilities, 'workspace.members.remove');
  const canSetRole = can(capabilities, 'workspace.members.role');
  const settingsHref = routes.settings({ workspaceId }, mode);
  const removeTarget = (Array.isArray(query.person) ? query.person[0] : query.person) ?? '';
  return (
    <div className="space-y-5">
      <SectionCard
        title={ui.settings.sections.workspace}
        actions={
          capabilities.writes ? null : (
            <Badge tone="outline">{ui.settings.workspace.readOnly}</Badge>
          )
        }
      >
        <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
          <KeyValue term={ui.settings.workspace.name} value={settings.workspaceName} />
          <KeyValue
            term={ui.settings.workspace.slug}
            value={
              <code className="font-mono text-[12.5px] text-slate-600">
                {settings.workspaceSlug}
              </code>
            }
          />
          <KeyValue term={ui.settings.workspace.yourRole} value={settings.currentRole} />
          <KeyValue term={ui.settings.workspace.members} value={settings.members.length} />
        </dl>
        <p className="mt-3 text-[12.5px] leading-relaxed text-slate-500">
          {ui.settings.workspace.inviteNote}
        </p>
      </SectionCard>

      <SectionCard title={ui.settings.workspace.members} flush>
        {settings.members.length === 0 ? (
          <EmptyState
            icon="user"
            title={ui.common.none}
            description={ui.settings.workspace.inviteNote}
          />
        ) : (
          <TableScroller>
            <Table>
              <caption className="sr-only">{ui.settings.workspace.members}</caption>
              <thead>
                <tr>
                  <Th>{ui.speakers.person}</Th>
                  <Th>Email</Th>
                  <Th>{ui.settings.workspace.memberRole}</Th>
                  <Th>{ui.settings.workspace.memberStatus}</Th>
                </tr>
              </thead>
              <tbody>
                {settings.members.map((member) => (
                  <Tr key={member.personId}>
                    <Td className="font-medium text-slate-800">{member.name}</Td>
                    <Td className="text-slate-500">{member.email ?? '—'}</Td>
                    <Td>
                      {canSetRole && member.role !== 'owner' && member.status === 'active' ? (
                        <form
                          action={setMemberRoleAction}
                          className="inline-flex flex-wrap items-center gap-1.5"
                        >
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="personId" value={member.personId} />
                          <input type="hidden" name="next" value={settingsHref} />
                          <Badge tone="neutral">{member.role}</Badge>
                          <label className="sr-only" htmlFor={`role-${member.personId}`}>
                            {ui.settingsWrites.inviteRole}
                          </label>
                          <select
                            id={`role-${member.personId}`}
                            name="role"
                            defaultValue={member.role}
                            className="h-7 rounded-md border border-slate-200 bg-white px-1.5 text-[12.5px] text-slate-700"
                          >
                            <option value="admin">{ui.settingsWrites.roleAdmin}</option>
                            <option value="member">{ui.settingsWrites.roleMember}</option>
                          </select>
                          <button
                            type="submit"
                            className="rounded text-[12px] font-medium text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
                          >
                            {ui.writes.save}
                          </button>
                        </form>
                      ) : (
                        <Badge tone={member.role === 'owner' ? 'accent' : 'neutral'}>
                          {member.role}
                        </Badge>
                      )}
                    </Td>
                    <Td>
                      <span className="inline-flex flex-wrap items-center gap-2 text-[12.5px] text-slate-500">
                        {member.status === 'invited'
                          ? ui.settingsWrites.invitedBadge
                          : member.status}
                        {canRemove && member.role !== 'owner' ? (
                          <a
                            href={`${settingsHref}?person=${member.personId}`}
                            className="rounded text-[12px] font-medium text-slate-400 underline decoration-slate-200 underline-offset-2 hover:text-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                          >
                            {ui.settingsWrites.remove}
                          </a>
                        ) : null}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroller>
        )}
        <div className="border-t border-slate-100 px-4 py-3">
          <p className="mb-2 text-[12px] text-slate-500">{ui.settingsWrites.rosterNote}</p>
          <form action={inviteMemberAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="next" value={settingsHref} />
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <Field
              id="invite-email"
              label={ui.settingsWrites.inviteEmail}
              className="min-w-[14rem] flex-1"
            >
              <Input
                id="invite-email"
                name="email"
                type="email"
                placeholder="name@company.example"
                autoComplete="off"
                disabled={!canInvite}
              />
            </Field>
            <Field id="invite-role" label={ui.settingsWrites.inviteRole}>
              <Select id="invite-role" name="role" defaultValue="member" disabled={!canInvite}>
                <option value="admin">{ui.settingsWrites.roleAdmin}</option>
                <option value="member">{ui.settingsWrites.roleMember}</option>
              </Select>
            </Field>
            <button
              type="submit"
              disabled={!canInvite}
              className="inline-flex min-h-10 shrink-0 items-center rounded-lg bg-slate-950 px-3 text-[13px] font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
            >
              {ui.settingsWrites.invite}
            </button>
          </form>
        </div>
      </SectionCard>

      {mode === 'members' && removeTarget ? (
        <ConfirmAction
          title={ui.settingsWrites.remove}
          description={ui.settingsWrites.removeExplain}
          confirmLabel={ui.writes.delete}
          action={removeMemberAction}
          fields={[
            { name: 'workspaceId', value: workspaceId },
            { name: 'personId', value: removeTarget },
          ]}
          closeHref={settingsHref}
          canWrite={canRemove}
        />
      ) : null}

      {mode === 'workspace' ? (
        <WriteForm
          title={ui.settingsWrites.workspaceTitle}
          description={ui.settingsWrites.renameHint}
          action={renameWorkspaceAction}
          next={settingsHref}
          submitLabel={ui.settingsWrites.rename}
          capabilities={capabilities}
          canWrite={canWrite}
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <Field id="workspace-name" label={ui.settings.workspace.name} hint={ui.writes.nameHint}>
            <Input
              id="workspace-name"
              name="name"
              defaultValue={settings.workspaceName}
              minLength={2}
              maxLength={80}
              required={canWrite}
              disabled={!canWrite}
              data-autofocus
            />
          </Field>
        </WriteForm>
      ) : null}
    </div>
  );
}

function MeetingTypesSection({
  workspaceId,
  settings,
  capabilities,
  query,
}: {
  workspaceId: string;
  settings: SettingsSnapshot;
  capabilities: DataCapabilities;
  query: Record<string, string | string[] | undefined>;
}) {
  const canCreate = can(capabilities, 'meetingType.create');
  const canUpdate = can(capabilities, 'meetingType.update');
  const groups = [
    {
      label: ui.settings.meetingTypes.builtIn,
      rows: settings.meetingTypes.filter((type) => type.builtIn),
    },
    {
      label: ui.settings.meetingTypes.custom,
      rows: settings.meetingTypes.filter((type) => !type.builtIn),
    },
  ];
  return (
    <div className="space-y-5">
      <FlashNotice params={query} />

      <WriteForm
        title={ui.settingsWrites.addType}
        description={ui.settingsWrites.meetingTypesIntro}
        action={saveMeetingTypeAction}
        next={routes.settings({ workspaceId }, 'meetingTypes')}
        submitLabel={ui.writes.create}
        capabilities={capabilities}
        canWrite={canCreate}
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="type-key"
            label={ui.settingsWrites.typeKey}
            hint={ui.settingsWrites.typeKeyHint}
          >
            <Input
              id="type-key"
              name="key"
              placeholder="board-review"
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              minLength={2}
              maxLength={40}
              required={canCreate}
              disabled={!canCreate}
            />
          </Field>
          <Field id="type-name" label={ui.settingsWrites.typeName} hint={ui.writes.nameHint}>
            <Input
              id="type-name"
              name="displayName"
              placeholder="Board review"
              minLength={2}
              maxLength={60}
              required={canCreate}
              disabled={!canCreate}
            />
          </Field>
        </div>
      </WriteForm>

      {groups.map((group) => (
        <SectionCard
          key={group.label}
          title={group.label}
          description={`${group.rows.length} ${group.rows.length === 1 ? 'type' : 'types'}`}
          flush
        >
          {group.rows.length === 0 ? (
            <EmptyState
              icon="file"
              title={ui.common.none}
              description={
                group.label === ui.settings.meetingTypes.custom
                  ? 'No custom meeting types yet. A custom type carries its own prompt defaults, so it is created in the live workspace database.'
                  : 'This workspace has no built-in meeting types in its settings record.'
              }
            />
          ) : (
            <TableScroller>
              <Table>
                <thead>
                  <tr>
                    <Th>{ui.meetings.columns.type}</Th>
                    <Th>{ui.settings.meetingTypes.key}</Th>
                    <Th align="right">Order</Th>
                    <Th align="right">{ui.meetings.columns.status}</Th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((type) => (
                    <Tr key={type.id}>
                      <Td className="font-medium text-slate-800">{type.displayName}</Td>
                      <Td>
                        <code className="font-mono text-[12px] text-slate-500">{type.key}</code>
                      </Td>
                      <Td align="right" className="tabular-nums text-slate-500">
                        {type.sortOrder}
                      </Td>
                      <Td align="right">
                        <form
                          action={saveMeetingTypeAction}
                          className="inline-flex items-center gap-2"
                        >
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="meetingTypeId" value={type.id} />
                          <input type="hidden" name="key" value={type.key} />
                          <input
                            type="hidden"
                            name="activeState"
                            value={type.active ? 'inactive' : 'active'}
                          />
                          <input
                            type="hidden"
                            name="next"
                            value={routes.settings({ workspaceId }, 'meetingTypes')}
                          />
                          <Badge tone={type.active ? 'success' : 'neutral'}>
                            {type.active
                              ? ui.settings.meetingTypes.active
                              : ui.settings.meetingTypes.inactive}
                          </Badge>
                          <button
                            type="submit"
                            disabled={!canUpdate}
                            className="rounded text-[12px] font-medium text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-300 disabled:no-underline"
                          >
                            {type.active
                              ? ui.settingsWrites.disableType
                              : ui.settingsWrites.enableType}
                          </button>
                        </form>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableScroller>
          )}
        </SectionCard>
      ))}

      <p className="text-[12px] text-slate-400">
        <a href={routes.newMeeting({ workspaceId })} className="text-teal-800 hover:underline">
          {ui.newMeeting.title}
        </a>{' '}
        offers exactly these types when a meeting is prepared.
      </p>
    </div>
  );
}

function VocabularySection({
  settings,
  capabilities,
  workspaceId,
  companies,
  query,
}: SectionProps & {
  capabilities: DataCapabilities;
  workspaceId: string;
  companies: { id: string; name: string }[];
  query: Record<string, string | string[] | undefined>;
}) {
  const canCreate = can(capabilities, 'vocabulary.create');
  const canUpdate = can(capabilities, 'vocabulary.update');
  const canDelete = can(capabilities, 'vocabulary.delete');
  const vocabularyHref = routes.settings({ workspaceId }, 'vocabulary');
  const editing = (Array.isArray(query.term) ? query.term[0] : query.term) ?? '';
  const editingTerm = settings.vocabulary.find((item) => item.id === editing);
  return (
    <div className="space-y-5">
      <FlashNotice params={query} />

      <Notice tone="neutral" title={ui.settings.vocabulary.title}>
        <p>{ui.settings.vocabulary.note}</p>
        {capabilities.mode === 'demo' ? (
          <p className="text-[12px] opacity-80">{ui.settings.vocabulary.demoOnly}</p>
        ) : null}
      </Notice>

      <WriteForm
        title={editingTerm ? ui.settingsWrites.edit : ui.settingsWrites.addTerm}
        description={ui.settingsWrites.vocabularyIntro}
        action={saveVocabularyTermAction}
        next={vocabularyHref}
        submitLabel={editingTerm ? ui.writes.save : ui.writes.create}
        capabilities={capabilities}
        canWrite={editingTerm ? canUpdate : canCreate}
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="termId" value={editingTerm?.id ?? ''} />
        <input type="hidden" name="op" value={editingTerm ? 'update' : 'create'} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="vocab-term"
            label={ui.settingsWrites.term}
            hint={ui.newMeeting.validation}
            className="sm:col-span-2"
          >
            <Input
              id="vocab-term"
              name="term"
              defaultValue={editingTerm?.term ?? ''}
              placeholder="foodera"
              minLength={2}
              maxLength={60}
              required={canCreate}
              disabled={!canCreate}
            />
          </Field>
          <Field
            id="vocab-context"
            label={ui.settingsWrites.context}
            hint={ui.settingsWrites.contextHint}
            className="sm:col-span-2"
          >
            <Input
              id="vocab-context"
              name="context"
              defaultValue={editingTerm?.context ?? ''}
              maxLength={160}
              disabled={!canCreate}
            />
          </Field>
          {editingTerm ? null : (
            <>
              <Field id="vocab-scope" label={ui.settingsWrites.scope}>
                <Select
                  id="vocab-scope"
                  name="scope"
                  defaultValue="workspace"
                  disabled={!canCreate}
                >
                  <option value="workspace">{ui.settingsWrites.scopeWorkspace}</option>
                  <option value="company">{ui.settingsWrites.scopeCompany}</option>
                </Select>
              </Field>
              <Field
                id="vocab-company"
                label={ui.settingsWrites.scopeCompany}
                hint={ui.writes.optional}
              >
                <Select id="vocab-company" name="companyId" defaultValue="" disabled={!canCreate}>
                  <option value="">{ui.common.none}</option>
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          <label className="flex items-center gap-2 text-[13px] text-slate-700 sm:col-span-2">
            <input type="hidden" name="enabled" value="false" />
            <input
              type="checkbox"
              name="enabled"
              value="true"
              defaultChecked={editingTerm ? editingTerm.enabled : true}
              disabled={!canCreate}
              className="size-4 accent-teal-700"
            />
            {ui.settingsWrites.enabled}
          </label>
        </div>
        {editingTerm ? (
          <p className="text-[12px] text-slate-500">
            Editing{' '}
            <code className="font-mono text-[11.5px] text-slate-700">{editingTerm.term}</code> ·{' '}
            <a
              href={vocabularyHref}
              className="rounded underline decoration-slate-300 underline-offset-2 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
            >
              {ui.writes.cancel}
            </a>
          </p>
        ) : null}
      </WriteForm>

      <SectionCard
        title={ui.settings.vocabulary.title}
        description={ui.settings.vocabulary.intro}
        actions={
          <Badge tone="outline">
            {settings.vocabulary.length} {settings.vocabulary.length === 1 ? 'term' : 'terms'}
          </Badge>
        }
        flush
      >
        {settings.vocabulary.length === 0 ? (
          <EmptyState
            icon="file"
            title={ui.common.none}
            description={ui.settings.vocabulary.intro}
          />
        ) : (
          <TableScroller>
            <Table>
              <caption className="sr-only">{ui.settings.vocabulary.title}</caption>
              <thead>
                <tr>
                  <Th>{ui.settings.vocabulary.term}</Th>
                  <Th>{ui.settings.vocabulary.context}</Th>
                  <Th>{ui.settings.vocabulary.scope}</Th>
                  <Th align="right">{ui.settings.vocabulary.enabled}</Th>
                </tr>
              </thead>
              <tbody>
                {settings.vocabulary.map((term) => (
                  <Tr key={term.id}>
                    <Td className="font-medium text-slate-900">{term.term}</Td>
                    <Td className="text-slate-600">{term.context ?? '—'}</Td>
                    <Td>
                      <Badge tone="outline">{ui.settings.vocabulary.scopes[term.scope]}</Badge>
                    </Td>
                    <Td align="right">
                      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-slate-600">
                        <Icon name={term.enabled ? 'check' : 'alert'} size={14} />
                        {term.enabled
                          ? ui.settings.vocabulary.enabled
                          : ui.settings.vocabulary.disabled}
                      </span>
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      <a
                        href={`${vocabularyHref}?term=${term.id}`}
                        className="rounded text-[12.5px] font-medium text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                      >
                        {ui.settingsWrites.edit}
                      </a>
                      {canDelete ? (
                        <form
                          action={saveVocabularyTermAction}
                          className="ml-2 inline-flex items-center"
                        >
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="termId" value={term.id} />
                          <input type="hidden" name="op" value="delete" />
                          <input type="hidden" name="next" value={vocabularyHref} />
                          <button
                            type="submit"
                            className="rounded text-[12.5px] font-medium text-slate-400 underline decoration-slate-200 underline-offset-2 hover:text-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                          >
                            {ui.settingsWrites.delete}
                          </button>
                        </form>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroller>
        )}
      </SectionCard>
    </div>
  );
}

/**
 * Recording settings are read back from what the desktop app was built against. They are shown, not edited:
 * the values live on the recording machine, and the native path is still pending validation.
 */
function RecordingSection({ workspaceId, settings }: { workspaceId: string } & SectionProps) {
  const recording = settings.recording;
  return (
    <div className="space-y-5">
      <Notice tone="warning" title={ui.newMeeting.recordTitle}>
        <p>{ui.newMeeting.recordBody}</p>
      </Notice>

      <SectionCard title={ui.settings.recording.title} description={ui.settings.recording.intro}>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <KeyValue term={ui.settings.recording.input} value={recording.preferredInputLabel} />
          <KeyValue
            term={ui.settings.recording.systemAudio}
            value={
              recording.captureSystemAudio
                ? ui.settings.recording.systemAudioOn
                : ui.common.notAvailable
            }
          />
          <KeyValue term={ui.settings.recording.retention} value={recording.retentionLabel} />
          <KeyValue
            term={ui.settings.recording.screenContext}
            value={recording.screenContextDefault}
          />
          <KeyValue term={ui.settings.recording.format} value={recording.audioFormatLabel} />
          <KeyValue
            term={ui.settings.recording.chunk}
            value={`${recording.chunkLengthSeconds} s (frozen before checksumming, so an interrupted session loses at most one chunk)`}
          />
          <KeyValue
            term={ui.settings.recording.storage}
            value={
              <code className="font-mono text-[12.5px] text-slate-600">
                {recording.storageRootLabel}
              </code>
            }
          />
        </dl>
        <p className="mt-3 text-[12.5px] leading-relaxed text-slate-500">
          {ui.settings.recording.note}
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-slate-400">
          {ui.settings.recording.validation}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={routes.newMeeting({ workspaceId })}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
          >
            <Icon name="desktop" size={14} />
            {ui.newMeeting.openDesktop}
          </a>
        </div>
      </SectionCard>
    </div>
  );
}

function AiSection({ settings }: SectionProps) {
  const ai = settings.ai;
  return (
    <div className="space-y-5">
      <Notice tone="neutral" title={ui.settings.ai.provider}>
        <p>{ai.providerNote}</p>
        <p className="text-[12px] opacity-80">{ui.settings.ai.secretPolicy}</p>
      </Notice>

      <SectionCard title={ui.settings.ai.title} description={ui.settings.ai.intro}>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <KeyValue
            term={ui.settings.ai.languages}
            value={
              <span className="flex flex-wrap gap-1">
                {ai.transcriptionLanguages.map((code) => (
                  <Badge key={code} tone="outline">
                    {languageLabels[code]}
                  </Badge>
                ))}
              </span>
            }
          />
          <KeyValue
            term={ui.settings.ai.guessing}
            value={ai.speakerLanguageGuessing ? ui.settings.ai.on : ui.settings.ai.off}
          />
          <KeyValue
            term={ui.settings.ai.summaryStyle}
            value={ui.settings.ai.styles[ai.summaryStyle]}
          />
          <KeyValue term={ui.settings.ai.depth} value={ui.settings.ai.depths[ai.analysisDepth]} />
        </dl>
        <p className="mt-3 text-[12.5px] text-slate-500">{ui.settings.ai.noProvider}</p>
      </SectionCard>
    </div>
  );
}

function IntegrationsSection({ settings }: SectionProps) {
  return (
    <div className="space-y-5">
      <Notice tone="neutral" title={ui.settings.integrations.intro}>
        <p>{ui.settings.integrations.connectBlocked}</p>
      </Notice>
      <ul className="grid gap-2.5 sm:grid-cols-2">
        {settings.integrations.map((integration) => (
          <li key={integration.key}>
            <SectionCard
              title={integration.label}
              description={integration.detail}
              actions={
                <Badge
                  tone={
                    integration.state === 'connected'
                      ? 'success'
                      : integration.state === 'not_connected'
                        ? 'neutral'
                        : 'outline'
                  }
                >
                  {integration.state === 'connected'
                    ? 'Connected'
                    : integration.state === 'not_connected'
                      ? ui.settings.integrations.notConnected
                      : ui.settings.integrations.comingLater}
                </Badge>
              }
            >
              <p className="text-[12px] leading-relaxed text-slate-400">
                {ui.settings.integrations.connect}: {ui.common.notAvailable}. No request leaves this
                app for {integration.key.replace(/_/g, ' ')}.
              </p>
            </SectionCard>
          </li>
        ))}
      </ul>
    </div>
  );
}
