// Import des vacances scolaires vaudoises dans l'agenda commun des absences.
// Appelée chaque mois par pg_cron (agenda_commun.sql) et par le bouton « Importer maintenant » de l'administration.
// Sans JWT : elle ne fait qu'importer des données publiques, au plus une fois toutes les 10 minutes.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { toPeriods, windowFor, type ApiHoliday } from "./holidays.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info" };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "GET" && req.method !== "POST") return json(405, { error: "Method not allowed" });
  const { data: allowed } = await admin.rpc("calendar_sync_allowed");
  if (allowed === false) return json(429, { error: "Import déjà effectué il y a moins de 10 minutes." });

  const { from, to } = windowFor();
  const url = `https://openholidaysapi.org/SchoolHolidays?countryIsoCode=CH&subdivisionCode=CH-VD&languageIsoCode=FR&validFrom=${from}&validTo=${to}`;
  let rows: ApiHoliday[];
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return json(502, { error: `OpenHolidays a répondu ${res.status}.` });
    rows = await res.json();
  } catch (_) {
    return json(502, { error: "OpenHolidays injoignable." });
  }
  // On ne garde que les périodes propres au canton de Vaud
  const vd = (rows ?? []).filter((r) => (r as unknown as { subdivisions?: { code: string }[] }).subdivisions?.some((s) => s.code === "CH-VD") ?? true);
  const { data, error } = await admin.rpc("calendar_import_school_holidays", { p_rows: toPeriods(vd) });
  if (error) return json(500, { error: error.message });
  return json(200, data);
});
