-- Development-safe reference configuration only; no fictitious customer/user records are seeded.
-- Built-in defaults also live in the versioned migration so production workspace creation is complete.
insert into public.meeting_type_templates (key, display_name, sort_order)
values
  ('general', 'General', 10),
  ('client_sales', 'Client sales', 20),
  ('marketing', 'Marketing', 30),
  ('internal', 'Internal', 40),
  ('brainstorm', 'Brainstorm', 50),
  ('project_planning', 'Project planning', 60),
  ('interview', 'Interview', 70)
on conflict (key) do nothing;
