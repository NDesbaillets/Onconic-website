-- Textes d'ordonnance per os : tous visibles et utilisables des utilisateurs ayant accès à l'outil, validés ou non
-- (les brouillons portent un avertissement « pas encore validée par le/la pharmacien.ne » dans l'app).
-- À exécuter après sl.sql. Sans danger si relancé.
drop policy if exists "sl_rx: read" on public.sl_rx;
create policy "sl_rx: read" on public.sl_rx for select to authenticated
  using ((select public.is_app_admin('limitations')) or (select public.has_tool('limitations')));

-- Repasse de tous les textes en brouillon (10.11.2026) : la validation se refait un par un dans l'éditeur admin
update public.sl_rx set status = 'draft', validated_at = null, validated_by = null where status = 'validated';
