// Configuration Supabase (backend : comptes, base de données, fichiers).
// Le projet est choisi selon l'adresse du site :
//   - onconic.ch (et www.onconic.ch) : production ;
//   - toute autre adresse (aperçu de branche, localhost, fichier local) : projet de test.
// Par défaut, c'est donc le projet de test : une adresse inconnue ne touche jamais la production.
// Les clés « publishable » sont publiques par conception ; la sécurité repose sur les règles RLS.
// Ne JAMAIS mettre ici une clé « secret » ou « service_role ».
(function () {
  var PROJETS = {
    production: {
      supabaseUrl: "https://icqrobnqvidusajburcu.supabase.co",
      supabaseAnonKey: "sb_publishable_8wGdtag16bgUeNgReIBDOg_EczFWtVH"
    },
    test: {
      supabaseUrl: "https://uubowlcyekbgmizrlyxb.supabase.co",
      supabaseAnonKey: "sb_publishable_C1E-Pgd5cCds8ozmCljB8g_r7RBfQJQ"
    }
  };
  var HOTES_PRODUCTION = ["onconic.ch", "www.onconic.ch"];

  var hote = (window.location && window.location.hostname || "").toLowerCase();
  var env = HOTES_PRODUCTION.indexOf(hote) !== -1 ? "production" : "test";

  window.ONCONIC_CONFIG = {
    env: env,
    supabaseUrl: PROJETS[env].supabaseUrl,
    supabaseAnonKey: PROJETS[env].supabaseAnonKey
  };

  // En test, bandeau permanent pour ne jamais confondre avec le site réel.
  if (env === "test") {
    var poser = function () {
      if (!document.body || document.getElementById("onconic-env-test")) return;
      var b = document.createElement("div");
      b.id = "onconic-env-test";
      b.setAttribute("role", "status");
      b.textContent = "Environnement de test : ce n’est pas le site Onconic réel";
      b.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;" +
        "padding:6px 12px;background:#b45309;color:#fff;font:600 13px/1.4 system-ui,sans-serif;" +
        "text-align:center;pointer-events:none";
      document.body.appendChild(b);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", poser);
    else poser();
  }
})();
