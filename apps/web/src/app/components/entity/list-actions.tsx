import { Button, ButtonLink } from '@suhbat/ui';
import { routes } from '@suhbat/product';
import { setCompanyArchivedAction, setProjectArchivedAction } from '../../actions/product';
import { ui } from '../../../copy/ui-copy';

/**
 * The two controls every company and project row owns: open the form that edits it, and move it in or out of
 * the default list.
 *
 * Both are real requests, not client state: the archive toggle is a POST to a server action that the adapter can
 * refuse, and the edit control is a link to a route, so a row's actions work with JavaScript off, survive a
 * reload, and can be handed to someone as a URL. A control the data source cannot honour is rendered as text
 * with the reason, never as a button that would fail on submit.
 */
export function EntityListActions({
  workspaceId,
  kind,
  id,
  status,
  nextHref,
  canEdit,
  canArchive,
  size = 'sm',
  /** On an edit page the edit control is where the reader already is, so only the lifecycle toggle shows. */
  showEdit = true,
}: {
  workspaceId: string;
  kind: 'company' | 'project';
  id: string;
  status: string;
  nextHref: string;
  canEdit: boolean;
  canArchive: boolean;
  size?: 'sm' | 'md';
  showEdit?: boolean;
}) {
  const editHref =
    kind === 'company'
      ? routes.editCompany({ workspaceId, companyId: id })
      : routes.editProject({ workspaceId, projectId: id });
  const archived = status !== 'active';
  const archiveAction = kind === 'company' ? setCompanyArchivedAction : setProjectArchivedAction;
  const fields =
    kind === 'company' ? { name: 'companyId', value: id } : { name: 'projectId', value: id };

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {canEdit && showEdit ? (
        <ButtonLink href={editHref} variant="ghost" size={size} className="whitespace-nowrap">
          {ui.writes.edit}
        </ButtonLink>
      ) : null}
      {canArchive ? (
        <form action={archiveAction} className="inline-flex">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name={fields.name} value={fields.value} />
          <input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
          <input type="hidden" name="next" value={nextHref} />
          <Button type="submit" variant="ghost" size={size}>
            {archived ? ui.writes.restore : ui.writes.archive}
          </Button>
        </form>
      ) : null}
      {!canArchive && !(canEdit && showEdit) ? (
        <span className="text-[12px] text-slate-400">{ui.common.notAvailable}</span>
      ) : null}
    </div>
  );
}
