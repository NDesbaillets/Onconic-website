-- Ordonnances per os : posologie différente selon l'indication.
-- Une même ligne produit (substance + product_line) peut avoir plusieurs textes, un par indication ; chacun a sa posologie,
-- ses paliers de dose, sa remarque et sa validation. À exécuter après sl.sql. Sans danger si relancé.

alter table public.sl_rx add column if not exists indication text check (indication is null or char_length(indication) between 3 and 200);
-- Mots-clés (séparés par « ; ») cherchés dans le texte de la limitation choisie et dans le type de cancer sélectionné,
-- pour présélectionner l'indication ; vide = choix manuel
alter table public.sl_rx add column if not exists indication_match text check (indication_match is null or char_length(indication_match) <= 300);

-- L'unicité porte désormais sur (substance, ligne produit, indication) ; sans indication, un seul texte par ligne produit comme avant
alter table public.sl_rx drop constraint if exists sl_rx_substance_product_line_key;
create unique index if not exists sl_rx_unique on public.sl_rx (substance, product_line, coalesce(indication, ''));
