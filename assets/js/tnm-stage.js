// Calcul du stade à partir du TNM (aide à la saisie : le médecin vérifie toujours).
// Systèmes : poumon UICC/IASLC 9e éd. (2025) ; côlon-rectum, sein (stade anatomique), mélanome cutané,
// rein, vessie : AJCC/UICC 8e éd. Les autres tumeurs ne sont pas calculées (FIGO, PSA/ISUP, p16, grade…).
(function (root) {
  // Lecture d'une chaîne libre : « cT2b cN2a cM1c1 (9e éd.) », « pT3N1aM0 », « T1mi N1mi M0 »
  function parse(s) {
    const found = {};
    const re = /(y?[cpr]?)([TNM])(is|x|mi|a(?![a-z])|\d(?:mi|[a-e])?\d?)/gi;
    for (const m of String(s || "").matchAll(re)) {
      const k = m[2].toUpperCase();
      if (!found[k]) found[k] = { pre: m[1].toLowerCase(), v: m[3].toLowerCase() };
    }
    if (!found.T || !found.N) return null;
    return {
      y: /y/.test(found.T.pre + found.N.pre),
      pathological: /p/.test(found.T.pre),
      T: found.T.v, N: found.N.v, M: found.M ? found.M.v : "0", mAssumed: !found.M
    };
  }
  const tn = (x) => (x === "is" || x === "x" || x === "mi" ? x : parseInt(x, 10));
  const sub = (x) => x.replace(/^\d/, "");

  const SYSTEMS = {
    lung: { label: "Poumon, UICC/IASLC 9e éd.", fn: lung },
    colorectal: { label: "Côlon-rectum, AJCC 8e éd.", fn: colorectal },
    breast: { label: "Sein, stade anatomique AJCC 8e éd.", fn: breast },
    melanoma: { label: "Mélanome cutané, AJCC 8e éd.", fn: melanoma },
    kidney: { label: "Rein, AJCC 8e éd.", fn: kidney },
    bladder: { label: "Vessie (urothélial), AJCC 8e éd.", fn: bladder }
  };

  function lung(p) {
    const T = p.T, N = p.N, t = tn(T);
    if (p.M.startsWith("1")) return /^1c/.test(p.M) ? "IVB" : "IVA";
    if (T === "is" && N === "0") return "0";
    if (N === "0") {
      if (T === "mi" || T === "1a") return "IA1";
      if (T === "1b") return "IA2";
      if (T === "1c") return "IA3";
      if (T === "1") return "IA";
      if (T === "2a" || T === "2") return T === "2" ? null : "IB";
      if (T === "2b") return "IIA";
      if (t === 3) return "IIB";
      if (t === 4) return "IIIA";
    }
    if (N === "1") return { 1: "IIA", 2: "IIB", 3: "IIIA", 4: "IIIA" }[t] || null;
    if (N === "2a") return { 1: "IIB", 2: "IIIA", 3: "IIIA", 4: "IIIB" }[t] || null;
    if (N === "2b") return { 1: "IIIA", 2: "IIIB", 3: "IIIB", 4: "IIIB" }[t] || null;
    if (N === "2") return t === 4 ? "IIIB" : null; // N2a/N2b nécessaire en 9e édition
    if (N === "3") return { 1: "IIIB", 2: "IIIB", 3: "IIIC", 4: "IIIC" }[t] || null;
    return null;
  }

  function colorectal(p) {
    const T = p.T, N = p.N, t = tn(T);
    if (p.M.startsWith("1")) return { "1a": "IVA", "1b": "IVB", "1c": "IVC" }[p.M] || "IV";
    if (T === "is" && N === "0") return "0";
    if (N === "0") return (t === 1 || t === 2) ? "I" : T === "3" ? "IIA" : T === "4a" ? "IIB" : T === "4b" ? "IIC" : null;
    const n1 = /^1/.test(N), n2a = N === "2a", n2b = N === "2b";
    if (T === "4b" && (n1 || /^2/.test(N))) return "IIIC";
    if (n1) return t <= 2 ? "IIIA" : (T === "3" || T === "4a") ? "IIIB" : null;
    if (n2a) return t === 1 ? "IIIA" : (t === 2 || T === "3") ? "IIIB" : T === "4a" ? "IIIC" : null;
    if (n2b) return t <= 2 ? "IIIB" : (T === "3" || T === "4a") ? "IIIC" : null;
    return null;
  }

  function breast(p) {
    const T = p.T, N = p.N, t = tn(T);
    if (p.M.startsWith("1")) return "IV";
    if (/^3/.test(N)) return "IIIC";
    if (t === 4) return /^[0-2]/.test(N) ? "IIIB" : null;
    if (T === "is" && N === "0") return "0";
    const t01 = T === "0" || t === 1 || T === "mi";
    if (N === "0") return t01 && T !== "0" ? "IA" : t === 2 ? "IIA" : t === 3 ? "IIB" : null;
    if (N === "1mi") return t01 ? "IB" : t === 2 ? "IIB" : t === 3 ? "IIIA" : null;
    if (/^1/.test(N)) return t01 ? "IIA" : t === 2 ? "IIB" : t === 3 ? "IIIA" : null;
    if (/^2/.test(N)) return (t01 || t === 2 || t === 3) ? "IIIA" : null;
    return null;
  }

  // Mélanome : stade clinique (cTNM) ou pathologique (pTNM), AJCC 8e éd.
  function melanoma(p) {
    const T = p.T, N = p.N, t = tn(T);
    if (p.M.startsWith("1")) return "IV";
    if (T === "is" && N === "0") return "0";
    if (N === "0") {
      if (T === "1a") return "IA";
      if (T === "1b") return p.pathological ? "IA" : "IB";
      if (T === "2a") return "IB";
      if (T === "2b" || T === "3a") return "IIA";
      if (T === "3b" || T === "4a") return "IIB";
      if (T === "4b") return "IIC";
      return null;
    }
    if (!p.pathological) return "III"; // stade clinique III sans sous-groupe
    const n = N;
    const nGroup = { "1a": 1, "2a": 1, "1b": 2, "1c": 2, "2b": 2, "2c": 3, "3a": 3, "3b": 3, "3c": 3 }[n];
    if (!nGroup) return null;
    if (T === "0") return (n === "1b" || n === "1c") ? "IIIB" : "IIIC";
    const low = ["1a", "1b", "2a"].includes(T), mid = ["2b", "3a"].includes(T), high = ["3b", "4a"].includes(T);
    if (low) return nGroup === 1 ? "IIIA" : nGroup === 2 ? "IIIB" : "IIIC";
    if (mid) return nGroup <= 2 ? "IIIB" : "IIIC";
    if (high) return "IIIC";
    if (T === "4b") return /^3/.test(n) ? "IIID" : "IIIC";
    return null;
  }

  function kidney(p) {
    const t = tn(p.T);
    if (p.M.startsWith("1") || t === 4) return "IV";
    if (p.N.startsWith("1")) return t >= 1 && t <= 3 ? "III" : null;
    if (p.N === "0") return { 1: "I", 2: "II", 3: "III" }[t] || null;
    return null;
  }

  function bladder(p) {
    const T = p.T, N = p.N, t = tn(T);
    if (p.M === "1b") return "IVB";
    if (p.M.startsWith("1")) return "IVA";
    if (T === "4b") return "IVA";
    if (/^[23]/.test(N)) return (T === "a" || T === "is") ? null : "IIIB";
    if (N === "1") return (T === "a" || T === "is") ? null : "IIIA";
    if (N === "0") {
      if (T === "a") return "0a";
      if (T === "is") return "0is";
      if (t === 1) return "I";
      if (t === 2) return "II";
      if (t === 3 || T === "4a") return "IIIA";
    }
    return null;
  }

  // Système proposé selon la clinique et l'histologie saisie
  function guess(clinic, histo) {
    const h = String(histo || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    switch (clinic) {
      case "Thoracique": return /mesotheliom|thym/.test(h) ? null : "lung";
      case "Lower GI": return /anal|anus/.test(h) ? null : "colorectal";
      case "Sénologie": return "breast";
      case "Mélanome": return /uve|muqueu|merkel|basocell|epidermoide/.test(h) ? null : "melanoma";
      case "Urologie":
        if (/prostat|germinal|seminom|testic|penis|penien/.test(h)) return null;
        if (/urothel|vessie|vesical/.test(h)) return /haut appareil|pyel|uret[eè]re|uretere/.test(h) ? null : "bladder";
        if (/\brena|\brein\b|cellules claires|chromophobe/.test(h)) return "kidney";
        return null;
      default: return null;
    }
  }

  function stage(system, tnm) {
    const s = SYSTEMS[system];
    const p = parse(tnm);
    if (!s || !p) return null;
    if (p.y) return { stage: null, note: "TNM après traitement néoadjuvant (y) : stade non calculé." };
    if (p.T === "x" || p.N === "x" || p.M === "x") return { stage: null, note: "T, N ou M inconnu (x) : stade non calculé." };
    const st = s.fn(p);
    return {
      stage: st,
      label: s.label,
      note: st ? (p.mAssumed ? "M non précisé : M0 supposé." : "") : "Combinaison non reconnue pour ce système : saisissez le stade."
    };
  }

  const api = { parse, stage, guess, SYSTEMS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TnmStage = api;
})(this);
