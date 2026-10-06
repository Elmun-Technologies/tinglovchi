import { Badge, Field, Input, Select, Textarea } from '@suhbat/ui';
import { projectStatusLabels, type Company, type Project } from '@suhbat/product';
import { ui } from '../../../copy/ui-copy';

/**
 * The field sets for the two entity forms, shared by create and edit.
 *
 * Both modes of a form are the same questions with different starting answers, and a create page that quietly
 * enforces different limits from the edit page is how a product ends up with records that disagree. Ids come in
 * as props, so a half-filled form can be shown again with what the reader typed.
 */
export function CompanyFields({
  company,
  canWrite,
}: {
  company?: Pick<Company, 'name' | 'description'>;
  canWrite: boolean;
}) {
  return (
    <>
      <Field id="company-name" label={ui.companies.columns.company} hint={ui.writes.nameHint}>
        <Input
          id="company-name"
          name="name"
          defaultValue={company?.name ?? ''}
          autoComplete="off"
          spellCheck={false}
          minLength={2}
          maxLength={120}
          required={canWrite}
          disabled={!canWrite}
        />
      </Field>
      <Field
        id="company-description"
        label={ui.companies.detail.overview}
        hint={ui.writes.descriptionHint}
      >
        <Textarea
          id="company-description"
          name="description"
          defaultValue={company?.description ?? ''}
          rows={5}
          maxLength={1000}
          disabled={!canWrite}
        />
      </Field>
    </>
  );
}

export function ProjectFields({
  project,
  companies,
  defaultCompanyId,
  canWrite,
}: {
  project?: Project;
  /** Archived companies are included: an existing link to one must still render its name. */
  companies: Company[];
  /** Set when the form was opened from a company page, so the reader does not repeat themselves. */
  defaultCompanyId?: string;
  canWrite: boolean;
}) {
  return (
    <>
      <Field id="project-name" label={ui.projects.title} hint={ui.writes.nameHint}>
        <Input
          id="project-name"
          name="name"
          defaultValue={project?.name ?? ''}
          autoComplete="off"
          spellCheck={false}
          minLength={2}
          maxLength={120}
          required={canWrite}
          disabled={!canWrite}
        />
      </Field>
      <Field id="project-company" label={ui.projects.company} hint={ui.writes.projectHint}>
        <Select
          id="project-company"
          name="companyId"
          defaultValue={project?.companyId ?? defaultCompanyId ?? ''}
          disabled={!canWrite}
        >
          <option value="">{ui.common.noCompany}</option>
          {companies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
              {company.status === 'archived' ? ` (${ui.writes.archivedBadge})` : ''}
            </option>
          ))}
        </Select>
      </Field>
      {project ? (
        <Field
          id="project-status"
          label="Status"
          hint="Closing a project keeps its meetings and decisions; it only leaves the default list."
        >
          <Select
            id="project-status"
            name="status"
            defaultValue={project.status}
            disabled={!canWrite}
          >
            {(Object.keys(projectStatusLabels) as Project['status'][]).map((key) => (
              <option key={key} value={key}>
                {projectStatusLabels[key]}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field
        id="project-description"
        label={ui.projects.detail.overview}
        hint={ui.writes.descriptionHint}
      >
        <Textarea
          id="project-description"
          name="description"
          defaultValue={project?.description ?? ''}
          rows={5}
          maxLength={1000}
          disabled={!canWrite}
        />
      </Field>
    </>
  );
}

/** The current lifecycle, stated once, next to the control that changes it. */
export function LifecycleBadge({ status }: { status: string }) {
  if (status === 'active') return null;
  return (
    <Badge tone={status === 'paused' ? 'info' : 'neutral'}>
      {status === 'closed'
        ? projectStatusLabels.closed
        : status === 'archived'
          ? ui.writes.archivedBadge
          : status}
    </Badge>
  );
}
