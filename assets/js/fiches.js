// Fiches tumeurs : liste et recherche (fiches.html), lecture d'une fiche (fiche.html).
// Le contenu vient de la table hive_pages, écrite uniquement par le dépôt privé onconic-content ;
// les règles RLS le réservent aux membres validés (brouillons : admins seulement).
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const REVUE_MAX_JOURS = 365;
  const $ = (id) => document.getElementById(id);

  const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const date = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("fr-CH") : "");
  const vieille = (d) => d && (Date.now() - Date.parse(d)) / 864e5 > REVUE_MAX_JOURS;

  function status(text) {
    $("fiches-status").textContent = text;
    $("fiches-status").hidden = false;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function carte(p) {
    const a = el("a", "fiche-carte");
    a.href = "/app/fiche.html?p=" + encodeURIComponent(p.slug);
    a.append(el("span", "fiche-carte-titre", p.titre));
    if (p.resume) a.append(el("span", "fiche-carte-resume", p.resume));
    const meta = el("span", "ug-meta");
    if (p.statut === "brouillon") meta.append(el("span", "ug-badge ug-warn", "Brouillon"));
    if (vieille(p.derniere_revue)) meta.append(el("span", "ug-badge ug-warn", "Revue > 12 mois"));
    meta.append(el("span", "ug-badge", "Revue le " + date(p.derniere_revue)));
    a.append(meta);
    return a;
  }

  // ----- Liste et recherche -----
  async function liste() {
    const { data: pages, error } = await sb.from("hive_pages")
      .select("slug, titre, domaine_libelle, domaine_ordre, situation, resume, derniere_revue, statut")
      .order("domaine_ordre").order("titre");
    if (error) return status("Les fiches sont indisponibles pour le moment.");
    if (!pages.length) return status("Aucune fiche disponible pour votre compte. Les fiches sont réservées aux membres validés.");

    $("fiches-status").hidden = true;
    $("fiches-outil").hidden = false;
    const out = $("fiches-liste");

    function tout() {
      out.replaceChildren();
      let courant = null, grille = null;
      for (const p of pages) {
        if (p.domaine_libelle !== courant) {
          courant = p.domaine_libelle;
          out.append(el("h2", "fiches-domaine", courant));
          grille = el("div", "fiches-grille");
          out.append(grille);
        }
        grille.append(carte(p));
      }
      $("fiches-compte").textContent = `${pages.length} fiche${pages.length > 1 ? "s" : ""}`;
    }

    let jeton = 0, minuterie;
    async function chercher() {
      const q = norm($("q").value).trim();
      if (q.length < 2) return tout();
      const n = ++jeton;
      const { data, error } = await sb.rpc("hive_search", { q });
      if (n !== jeton) return; // une frappe plus récente a pris le relais
      // Repli si la recherche plein texte échoue : filtre sur les titres
      const hits = error ? pages.filter((p) => norm(p.titre + " " + p.resume).includes(q)) : data;
      out.replaceChildren();
      const grille = el("div", "fiches-grille");
      hits.forEach((p) => grille.append(carte(p)));
      out.append(grille);
      $("fiches-compte").textContent = hits.length ? `${hits.length} résultat${hits.length > 1 ? "s" : ""}` : "Aucun résultat.";
    }

    $("q").addEventListener("input", () => { clearTimeout(minuterie); minuterie = setTimeout(chercher, 200); });
    tout();
    $("q").focus();
  }

  // ----- Lecture d'une fiche -----
  async function fiche() {
    const slug = new URLSearchParams(location.search).get("p");
    if (!slug) return (location.href = "/app/fiches.html");
    const { data: p, error } = await sb.from("hive_pages").select("*").eq("slug", slug).maybeSingle();
    if (error) return status("La fiche est indisponible pour le moment.");
    if (!p) return status("Fiche introuvable ou réservée.");

    document.title = p.titre + " · Onconic";
    $("fiche-domaine").textContent = p.domaine_libelle + (p.statut === "brouillon" ? " · brouillon" : "");
    $("fiche-titre").textContent = p.titre;
    $("fiche-meta").textContent = [
      "Revue le " + date(p.derniere_revue),
      p.date_limite_preuves && "littérature jusqu'au " + date(p.date_limite_preuves),
      p.recommandations.length && "Références : " + p.recommandations.join(", ")
    ].filter(Boolean).join(" · ");
    if (vieille(p.derniere_revue)) {
      $("fiche-alerte").textContent = "Cette fiche n'a pas été revue depuis plus de 12 mois. Vérifiez les données récentes avant de l'appliquer.";
      $("fiche-alerte").hidden = false;
    }

    // HTML produit par le build du dépôt privé (seule la clé secrète peut écrire dans la table)
    $("fiche-corps").innerHTML = p.html;

    const toc = $("fiche-sommaire");
    p.sommaire.filter((s) => s.niveau === 2).forEach((s) => {
      const li = el("li");
      const a = el("a", null, s.titre);
      a.href = "#" + s.id;
      li.append(a);
      toc.append(li);
    });

    // Figures du bucket privé : URL signées, valables une heure
    const imgs = [...$("fiche-corps").querySelectorAll("img[data-hive]")];
    if (imgs.length) {
      const { data: urls } = await sb.storage.from("hive").createSignedUrls(imgs.map((i) => i.dataset.hive), 3600);
      (urls || []).forEach((u, i) => { if (u.signedUrl) imgs[i].src = u.signedUrl; });
    }

    $("fiches-status").hidden = true;
    $("fiche").hidden = false;
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }

  // ----- Démarrage -----
  (async () => {
    if (!sb) return status("Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/ruche.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    if ($("fiche")) fiche(); else liste();
  })();
})();
