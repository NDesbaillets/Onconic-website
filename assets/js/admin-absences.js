// Administration des absences : cadres valideurs et seuil d'absents simultanés, par clinique. Réservé aux admins (contrôlé aussi en base).
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const $ = (id) => document.getElementById(id);
  const state = { clinics: [], cadres: [] };

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function say(text, kind) { const m = $("aa-msg"); m.className = "form-msg" + (kind ? " " + kind : ""); m.textContent = text; }
  const plur = (n, one, many) => `${n} ${n > 1 ? many : one}`;

  async function load() {
    const { data, error } = await sb.rpc("admin_absence_config");
    if (error) throw error;
    state.clinics = data.clinics || [];
    state.cadres = data.cadres || [];
  }

  function card(c) {
    const root = el("article", "card aa-card");
    const head = el("div", "aa-head");
    const title = el("div");
    title.append(el("h3", null, c.clinic), el("p", "muted am-meta", plur(c.members, "membre rattaché", "membres rattachés")));
    head.append(title);

    const max = el("label", "aa-max", "Absents simultanés au maximum");
    const input = el("input");
    input.type = "number"; input.min = "1"; input.max = "50"; input.value = c.max_absent;
    input.addEventListener("change", async () => {
      const n = Number(input.value);
      const { error } = await sb.rpc("admin_set_absence_threshold", { p_clinic: c.clinic, p_max: n });
      if (error) { input.value = c.max_absent; return say("Refusé : " + error.message, "error"); }
      c.max_absent = n;
      say(`${c.clinic} : avertissement au-delà de ${plur(n, "absent", "absents")} en même temps.`, "ok");
    });
    max.append(input);
    head.append(max);
    root.append(head);

    const fs = el("fieldset", "aa-cadres");
    fs.append(el("legend", null, "Cadres qui valident les absences de cette clinique"));
    const chosen = new Set(c.validators || []);
    if (!state.cadres.length) {
      fs.append(el("p", "muted", "Aucun membre n'a encore le rôle Cadre. Attribuez-le dans « Membres et accès »."));
    }
    for (const cadre of state.cadres) {
      const lab = el("label", "cg-check am-tool");
      const cb = el("input");
      cb.type = "checkbox"; cb.checked = chosen.has(cadre.id);
      cb.addEventListener("change", async () => {
        cb.disabled = true;
        const next = new Set(chosen);
        cb.checked ? next.add(cadre.id) : next.delete(cadre.id);
        const { data, error } = await sb.rpc("admin_set_absence_validators", { p_clinic: c.clinic, p_users: [...next] });
        cb.disabled = false;
        if (error) { cb.checked = !cb.checked; return say("Refusé : " + error.message, "error"); }
        chosen.clear(); (data || []).forEach((id) => chosen.add(id));
        c.validators = [...chosen];
        say(`${c.clinic} : ${chosen.size ? plur(chosen.size, "valideur désigné", "valideurs désignés") : "aucun valideur (les administrateurs décident)"}.`, "ok");
        note.hidden = chosen.size > 0;
      });
      lab.append(cb, el("span", null, cadre.name));
      fs.append(lab);
    }
    root.append(fs);
    const note = el("p", "muted am-note", "Aucun valideur désigné : les demandes de cette clinique vont aux administrateurs.");
    note.hidden = chosen.size > 0;
    root.append(note);
    return root;
  }

  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: role } = await sb.rpc("current_role_name");
    if (role !== "admin") return ($("ug-status").textContent = "Page réservée à l'administrateur.");
    try { await load(); } catch (e) { return ($("ug-status").textContent = "Chargement impossible : " + e.message); }
    $("ug-status").hidden = true;
    $("aa-tool").hidden = false;
    $("aa-list").replaceChildren(...state.clinics.map(card));
  })();
})();
