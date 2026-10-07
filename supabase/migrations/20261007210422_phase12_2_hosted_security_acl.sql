-- Hosted Supabase security hardening.
-- Keep create_workspace callable only by authenticated users.
-- Trigger functions must not be exposed as client-callable RPCs.

revoke execute
  on function public.create_workspace(text, text)
  from public, anon;

grant execute
  on function public.create_workspace(text, text)
  to authenticated;

revoke execute
  on function public.handle_new_user()
  from public, anon, authenticated;

revoke execute
  on function public.write_workspace_audit_log()
  from public, anon, authenticated;
