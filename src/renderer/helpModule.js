'use strict';

/**
 * Module d'aide : FAQ, Guide d'utilisation et Formulaire de feedback.
 *
 * Logique renderer isolée, exposée sur window.helpModule.
 * - FAQ : accordéon cliquable généré depuis FAQ_DATA.
 * - Help : guide pédagogique progressif généré depuis HELP_SECTIONS.
 * - Feedback : formulaire avec auto-diagnostic (version/OS/date) non sensible.
 *
 * Le bouton "Envoyer" du feedback appelle submitFeedback(), clairement marquée
 * "à connecter à l'API backend" (V2). Aucune infrastructure serveur pour
 * l'instant — la fonction stocke le rapport localement et affiche un message.
 */

const FAQ_DATA = [
  {
    q: 'À quoi sert Leboncoin Scraper Pro ?',
    a: `<p>Leboncoin Scraper Pro est un logiciel de bureau (Windows / macOS / Linux) qui <strong>collecte automatiquement les annonces Leboncoin</strong> à partir d'une URL de recherche, puis les analyse et les exporte.</p>
        <p>Il permet de :</p>
        <ul>
          <li>récupérer des dizaines, voire des centaines d'annonces en quelques minutes ;</li>
          <li>estimer si chaque annonce est une <strong>bonne affaire</strong>, un prix correct ou <strong>trop cher</strong> grâce à une IA locale ;</li>
          <li>visualiser le marché (prix moyen, médian, distribution, carte géographique) ;</li>
          <li>comparer les annonces et exporter les résultats (Excel, JSON, CSV, TXT).</li>
        </ul>`
  },
  {
    q: 'Le logiciel envoie-t-il mes données sur Internet ?',
    a: `<p><strong>Non</strong> pour l'analyse par annonce. L'IA utilisée est <strong>Ollama, 100 % locale</strong> : elle tourne sur votre propre machine, aucune donnée n'est envoyée vers un serveur payant.</p>
        <p>Le logiciel se connecte uniquement à :</p>
        <ul>
          <li><strong>leboncoin.fr</strong> pour récupérer les annonces ;</li>
          <li>votre serveur <strong>Ollama local</strong> (127.0.0.1:11434) pour l'analyse IA ;</li>
          <li>l'API de géocodage du gouvernement français (data.gouv) pour positionner les villes sur la carte.</li>
        </ul>
        <p>Aucune clé API payante n'est requise.</p>`
  },
  {
    q: 'Comment fonctionne le scraping ?',
    a: `<p>Le logiciel ouvre un navigateur (Chromium via Playwright) qui charge les pages de résultats Leboncoin, capture les données des annonces (titre, prix, ville, vendeur, photos…) puis enrichit éventuellement chaque annonce avec sa <strong>description détaillée</strong> en ouvrant la page de l'annonce.</p>
        <p>Si Leboncoin détecte une activité robotique, un <strong>CAPTCHA peut apparaître</strong> : le navigateur devient alors visible pour que vous le résolviez manuellement, après quoi le scraping reprend tout seul.</p>`
  },
  {
    q: 'À quoi servent les vitesses de scraping (Rapide / Équilibré / Prudent / Ultra) ?',
    a: `<p>Elles contrôlent le compromis <strong>vitesse ↔ discrétion</strong> lors de l'enrichissement des descriptions :</p>
        <ul>
          <li><strong>Ultra</strong> — 20 annonces en parallèle, délais très courts. Très rapide mais risque élevé de blocage (403).</li>
          <li><strong>Rapide</strong> — 10 parallèle, délais courts. <strong>N'extrait pas les descriptions détaillées</strong> (titre + prix suffisent).</li>
          <li><strong>Équilibré</strong> — 5 parallèle, délais modérés. Bon compromis pour l'analyse IA.</li>
          <li><strong>Prudent</strong> — séquentiel, délais humains. Anti-blocage maximal, le plus discret.</li>
        </ul>
        <p>Si vous voulez l'analyse de marché IA, préférez <strong>Équilibré</strong> ou <strong>Prudent</strong> (les descriptions aident l'IA à mieux évaluer).</p>`
  },
  {
    q: 'Quelle est la différence entre "Prix Moyen" et "Prix Médian" ?',
    a: `<p>Le <strong>prix moyen</strong> est la somme des prix divisée par le nombre d'annonces. Il est sensible aux valeurs extrêmes : une seule annonce très chère peut le faire grimper.</p>
        <p>Le <strong>prix médian</strong> est le prix « du milieu » : autant d'annonces sont moins chères que lui que plus chères. Il est <strong>plus représentatif du marché réel</strong> car il ignore les extrêmes.</p>
        <p>Exemple : 5 annonces à 100, 110, 120, 130 et 900 € → moyenne 272 €, médiane 120 €. La médiane reflète mieux le marché « normal ».</p>`
  },
  {
    q: 'Que signifie "Remise en main propre" ?',
    a: `<p>Une annonce « main propre » signifie que le vendeur <strong>n'accepte pas la livraison</strong> (pas d'envoi postal) : l'acheteur doit aller chercher l'objet en personne.</p>
        <p>Dans les statistiques et sur la carte, seules les annonces explicitement <strong>sans livraison</strong> sont comptées. Si l'information n'a pas pu être extraite (cas du mode Rapide), l'annonce <strong>n'est pas comptée</strong> comme main propre — on ne devine pas.</p>
        <p>La carte propose un filtre « Remise en main propre uniquement » pour visualiser les annonces récupérables près de chez vous.</p>`
  },
  {
    q: `Comment interpréter le verdict de l'IA Marché ?`,
    a: `<p>L'<strong>IA Marché</strong> recherche les prix réels du produit sur Internet (moteur de recherche) puis donne un <strong>verdict en €</strong> — pas un score :</p>
        <ul>
          <li><strong>🟢🟢 Très bonne affaire</strong> — le prix demandé est bien en dessous de la valeur marché (bénéfice élevé en €).</li>
          <li><strong>🟢 Bonne affaire</strong> — prix en dessous de la valeur marché.</li>
          <li><strong>Prix correct</strong> — dans la moyenne du marché.</li>
          <li><strong>🔴 Trop cher</strong> — au-dessus du marché (perte si achat-revente).</li>
        </ul>
        <p>Le <strong>bénéfice/perte en €</strong> = valeur marché estimée − prix demandé. Plus de score 0-100, plus de pourcentage : l'IA parle en euros réels.</p>`
  },
  {
    q: `L'IA détecte-t-elle les arnaques ?`,
    a: `<p>Il n'y a plus de « scam score » chiffré. L'<strong>IA Analyse</strong> (texte + vision) identifie le produit, son état, les défauts visibles et le type de photo (constructeur vs réelles). Ces éléments, combinés au verdict de l'IA Marché, vous aident à juger la fiabilité :</p>
        <ul>
          <li>prix anormalement bas + photos génériques + description vague → prudence ;</li>
          <li>l'IA Marché indique le différentiel en €, ce qui révèle les annonces trop belles pour être vraies.</li>
        </ul>
        <p>À vous de croiser ces indices — le logiciel ne donne plus un score d'arnaque automatique.</p>`
  },
  {
    q: 'À quoi sert le « Bénéfice / Perte » ?',
    a: `<p>Pour les acheteurs-revendeurs (flipping), l'<strong>IA Marché</strong> estime la <strong>valeur réelle du produit en €</strong> (via recherche Internet) puis calcule le <strong>bénéfice ou la perte en euros</strong> : valeur marché − prix demandé.</p>
        <p>Exemple : une annonce à 80 € avec une valeur marché de 150 € → bénéfice +70 €.</p>
        <p>Plus de ROI en pourcentage ni de marge de revente séparée : un seul chiffre en €, clair et directement exploitable.</p>`
  },
  {
    q: `Pourquoi le nombre d'annonces sur la carte est-il parfois inférieur au total ?`,
    a: `<p>Plusieurs raisons possibles :</p>
        <ul>
          <li><strong>Filtre « main propre »</strong> activé par défaut sur la carte → seules les annonces sans livraison sont affichées.</li>
          <li>Annonces <strong>sans ville détectée</strong> (pas de géocodage possible).</li>
          <li><strong>Déduplication</strong> : si la même annonce (même id Leboncoin) apparaît dans plusieurs sessions, elle n'est affichée qu'une seule fois.</li>
        </ul>`
  },
  {
    q: `Le mode Rapide n'a pas récupéré les descriptions, est-ce normal ?`,
    a: `<p><strong>Oui</strong>. Le mode « Rapide » n'extrait volontairement que le titre et le prix (pas la description détaillée) pour aller plus vite. L'analyse de marché IA fonctionne quand même, mais avec moins de contexte.</p>
        <p>Pour les descriptions complètes, utilisez <strong>Équilibré</strong>, <strong>Prudent</strong> ou <strong>Ultra</strong>.</p>`
  },
  {
    q: 'J\'obtiens une erreur 403 / page blanche pendant le scraping, que faire ?',
    a: `<p>Une erreur <strong>403</strong> signifie que Leboncoin a temporairement bloqué la requête. Solutions :</p>
        <ul>
          <li>Attendez quelques minutes puis réessayez ;</li>
          <li>Choisissez une vitesse plus lente (<strong>Prudent</strong>) ;</li>
          <li>Augmentez le délai entre les pages (Paramètres → Délai entre les pages) ;</li>
          <li>Utilisez un <strong>proxy rotatif</strong> ;</li>
          <li>Ne scrapez pas trop de pages d'un coup.</li>
        </ul>`
  },
  {
    q: 'L\'analyse IA ne démarre pas, pourquoi ?',
    a: `<p>L'analyse utilise <strong>Ollama</strong> qui doit être installé et démarré sur votre machine. Vérifiez :</p>
        <ul>
          <li>qu'Ollama tourne en arrière-plan (icône / processus <code>ollama serve</code>) ;</li>
          <li>que le nom du modèle indiqué (ex: <code>llama3</code>) est bien installé (<code>ollama list</code>) ;</li>
          <li>l'URL du serveur Ollama (par défaut <code>http://127.0.0.1:11434</code>).</li>
        </ul>
        <p>Le logiciel propose un health-check Ollama pour vérifier la connexion.</p>`
  },
  {
    q: 'Mes favoris ou filtres sont-ils conservés ?',
    a: `<p>Les <strong>favoris</strong> (⭐) sont enregistrés dans le navigateur et persistent entre les sessions. Les <strong>filtres de l'explorateur</strong> (mot-clé, prix, tag) sont également mémorisés localement.</p>
        <p>Les <strong>jobs scrapés</strong> (annonces + résultats) sont stockés sur le disque dans le dossier de sortie, avec un contrôle d'intégrité SHA-256.</p>`
  },
  {
    q: 'Puis-je analyser les images des annonces ?',
    a: `<p>Oui, optionnellement. Cochez <strong>« Analyser les images par IA Vision »</strong> avant de lancer un scraping. Les <strong>3 premières photos</strong> de chaque annonce seront analysées (type de photo, état apparent, défauts, authenticité) par un modèle de vision Ollama (ex: <code>llava</code>).</p>
        <p>Cela consomme plus de ressources (RAM/VRAM) et ralentit l'analyse.</p>`
  },
  {
    q: 'Où sont stockés mes fichiers exportés ?',
    a: `<p>Dans le <strong>dossier de sortie</strong> du logiciel (bouton « Dossier principal » dans l'onglet Historique). Chaque job crée un sous-dossier horodaté contenant :</p>
        <ul>
          <li><code>annonces.xlsx</code> (Excel stylisé) ;</li>
          <li><code>annonces.json</code>, <code>annonces.csv</code>, <code>annonces.txt</code> ;</li>
          <li>les fichiers <code>.har</code> (capture réseau, nettoyés automatiquement après quelques jours).</li>
        </ul>`
  },
];

const HELP_SECTIONS = [
  {
    icon: '🚀', title: '1. Démarrer un scraping',
    body: `<div class="help-step"><span class="help-step-num">1</span><div>Allez dans l'onglet <strong>🚀 Scraper</strong>.</div></div>
      <div class="help-step"><span class="help-step-num">2</span><div>Collez l'<strong>URL de recherche Leboncoin</strong> (copiée depuis le site, avec vos filtres prix/catégorie).</div></div>
      <div class="help-step"><span class="help-step-num">3</span><div>Choisissez le <strong>nombre de pages</strong> à parcourir et, si besoin, une <strong>limite d'annonces</strong>.</div></div>
      <div class="help-step"><span class="help-step-num">4</span><div>Cliquez sur <strong>Lancer le scraping</strong>. Une barre de progression indique l'avancement.</div></div>
      <div class="help-tip">💡 Vous pouvez enregistrer une recherche comme <strong>preset 1-clic</strong> pour la relancer plus tard.</div>`
  },
  {
    icon: '⚙️', title: '2. Configurer le scraping',
    body: `<p>Paramètres clés :</p>
      <ul>
        <li><strong>Pages</strong> — combien de pages de résultats parcourir (attention : trop de pages = risque de blocage).</li>
        <li><strong>Limite</strong> — plafond d'annonces (vide = toutes).</li>
        <li><strong>Proxy</strong> — serveur HTTP/SOCKS5 pour masquer votre IP (optionnel, utile contre le blocage).</li>
        <li><strong>Vitesse</strong> — voir la FAQ pour le détail (Ultra/Rapide/Équilibré/Prudent).</li>
      </ul>
      <p>Dans <strong>Paramètres ⚙️</strong> vous pouvez aussi régler : le thème, le délai entre les pages, le mode de capture (invisible / visible si CAPTCHA), le parallélisme IA, le nettoyage automatique.</p>`
  },
  {
    icon: '🤖', title: '3. Utiliser l\'IA (analyse de marché)',
    body: `<p>L'analyse IA est <strong>100 % locale via Ollama</strong>. Deux options dans le Scraper :</p>
      <ul>
        <li><strong>🧠 Analyser automatiquement le marché</strong> — lance l'analyse IA juste après le scraping. <em>Décochée par défaut</em> : à activer si vous voulez l'analyse tout de suite.</li>
        <li><strong>🖼️ Analyser les images par IA Vision</strong> — analyse les 3 premières photos de chaque annonce (état, authenticité). Plus lent.</li>
      </ul>
      <p>Indiquez le <strong>moteur</strong> (Ollama) et le <strong>nom du modèle</strong> (ex: <code>llama3</code>). Le logiciel fait un health-check avant de démarrer.</p>
      <div class="help-warn">⚠️ Si l'IA ne démarre pas : vérifiez qu'Ollama tourne (<code>ollama serve</code>) et que le modèle est installé (<code>ollama list</code>).</div>
      <p>Vous pouvez aussi <strong>relancer l'analyse IA</strong> plus tard depuis l'Explorateur (bouton 🧠) sur un job déjà scrapé.</p>`
  },
  {
    icon: '🔍', title: '4. Explorer les résultats',
    body: `<p>Onglet <strong>🔍 Explorateur Annonces</strong> :</p>
      <ul>
        <li><strong>Vue tableau / grille</strong> — basculez avec le bouton dédié ou la touche <code>Espace</code>.</li>
        <li><strong>Filtres</strong> — mot-clé (titre, description, ville), prix min/max, tag de deal (favoris, très bonnes affaires, bonnes affaires, trop cher).</li>
        <li><strong>Tri</strong> — meilleures affaires d'abord, prix croissant/décroissant, ordre d'origine.</li>
        <li><strong>Fiche détaillée</strong> — cliquez une annonce pour voir photos, description complète, analyse IA (produit identifié, résumé, verdict marché en €, analyse visuelle), et justification.</li>
        <li><strong>Comparateur</strong> — ajoutez des annonces aux favoris (⭐) puis comparez-les côte à côte.</li>
      </ul>
      <div class="help-tip">💡 Raccourci <code>Ctrl+N</code> pour aller vite au Scraper et focus sur l'URL.</div>`
  },
  {
    icon: '📊', title: '5. Comprendre les statistiques',
    body: `<p>Onglet <strong>📊 Statistiques & Carte</strong> :</p>
      <ul>
        <li><strong>8 cartes</strong> : Total, Prix Moyen, Prix Médian, Prix Min/Max, Main Propre, Professionnels, Particuliers.</li>
        <li><strong>3 graphiques</strong> : Distribution des prix, Vendeurs (pro/particulier), Top 10 Villes.</li>
        <li>Le sélecteur en haut permet de choisir <strong>une session précise</strong> ou toutes combinées.</li>
      </ul>
      <div class="help-tip">💡 Le prix <strong>médian</strong> est souvent plus parlant que la moyenne (il ignore les prix extrêmes).</div>`
  },
  {
    icon: '🗺️', title: '6. Utiliser la carte',
    body: `<p>La carte (Leaflet) affiche la <strong>répartition géographique</strong> des annonces en France.</p>
      <ul>
        <li>Cochez <strong>« Remise en main propre uniquement »</strong> pour ne voir que les annonces récupérables en personne.</li>
        <li>Les annonces sont <strong>dédupliquées par id</strong> (pas de doublons si plusieurs sessions).</li>
        <li>Le géocodage (ville → coordonnées) utilise l'API gouvernementale, avec un cache et un timeout de 10 s.</li>
      </ul>
      <div class="help-warn">⚠️ Seules les annonces avec une ville détectée peuvent être positionnées.</div>`
  },
  {
    icon: '🤖', title: '7. Le module AI Studio',
    body: `<p>Onglet <strong>🤖 Navigateur IA Studio</strong> : il intègre <strong>Google AI Studio directement dans le logiciel</strong> (via un navigateur embarqué).</p>
      <ul>
        <li>Générez un <strong>prompt d'analyse personnalisé</strong> via Ollama (domaine, objectif, variables).</li>
        <li>Utilisez ce prompt dans AI Studio sans quitter le logiciel.</li>
        <li>Importez un fichier JSON de résultats pour le visualiser.</li>
      </ul>
      <p>Connexion à votre compte Google requise (fenêtre dédiée avec anti-détection).</p>`
  },
  {
    icon: '⚠️', title: '8. Erreurs courantes et solutions',
    body: `<ul>
        <li><strong>403 / page blanche</strong> — Leboncoin bloque. Ralentissez (Prudent), augmentez le délai, utilisez un proxy, attendez.</li>
        <li><strong>CAPTCHA</strong> — le navigateur devient visible : résolvez-le à la main, le scraping reprend.</li>
        <li><strong>IA ne démarre pas</strong> — Ollama doit tourner (<code>ollama serve</code>) et le modèle être installé (<code>ollama list</code>).</li>
        <li><strong>0 annonce récupérée</strong> — vérifiez l'URL (catégorie/prix/filtres) et votre connexion.</li>
        <li><strong>Carte vide</strong> — décochez le filtre main propre ou scrapez des annonces avec une ville.</li>
        <li><strong>Badge Hors-ligne</strong> — pas de réseau : le scraping est désactivé mais l'historique reste consultable.</li>
      </ul>`
  },
  {
    icon: '💾', title: '9. Exporter et conserver',
    body: `<p>Chaque job est stocké dans le <strong>dossier de sortie</strong> (bouton « Dossier principal » dans l'onglet Historique).</p>
      <ul>
        <li><strong>Excel (.xlsx)</strong> — stylisé, filtres auto, mise en forme conditionnelle.</li>
        <li><strong>JSON / CSV / TXT</strong> — formats lisibles pour réutilisation.</li>
        <li>Les fichiers <code>.har</code> sont nettoyés automatiquement (Paramètres → rétention).</li>
      </ul>
      <p>L'onglet <strong>📁 Historique Jobs</strong> liste tous les scrapings passés, avec accès aux fichiers et suppression.</p>`
  },
];

const $ = (id) => document.getElementById(id);

// ──────────────────────────────────────────────────────────────────────────
// OUVERTURE / FERMETURE DES MODALES (réutilise le pattern .modal-overlay)
// ──────────────────────────────────────────────────────────────────────────
function openModal(id) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('hidden');
}

function closeModal(id) {
  const el = $(id);
  if (!el) return;
  el.classList.add('hidden');
}

// ──────────────────────────────────────────────────────────────────────────
// FAQ — rendu de l'accordéon
// ──────────────────────────────────────────────────────────────────────────
function renderFaq() {
  const container = $('faqAccordion');
  if (!container) return;
  container.innerHTML = '';
  FAQ_DATA.forEach((item, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'faq-item';
    wrap.innerHTML = `
      <button class="faq-question" type="button" aria-expanded="false">
        <span>${item.q}</span>
        <span class="faq-chevron">▼</span>
      </button>
      <div class="faq-answer"><div class="faq-answer-inner">${item.a}</div></div>`;
    const btn = wrap.querySelector('.faq-question');
    const ans = wrap.querySelector('.faq-answer');
    btn.addEventListener('click', () => {
      const isOpen = wrap.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(isOpen));
      if (isOpen) {
        ans.style.maxHeight = ans.scrollHeight + 'px';
      } else {
        ans.style.maxHeight = '0';
      }
    });
    container.appendChild(wrap);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// HELP — rendu du guide
// ──────────────────────────────────────────────────────────────────────────
function renderHelp() {
  const container = $('helpContent');
  if (!container) return;
  container.innerHTML = '';
  HELP_SECTIONS.forEach((sec) => {
    const section = document.createElement('div');
    section.className = 'help-section';
    section.innerHTML = `<h4>${sec.icon} ${sec.title}</h4>${sec.body}`;
    container.appendChild(section);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// FEEDBACK — diagnostic + envoi (préparé pour future API, sans backend)
// ──────────────────────────────────────────────────────────────────────────
async function collectDiagnostics() {
  const fallback = {
    appVersion: 'inconnue',
    platform: navigator.platform || 'inconnu',
    timestamp: new Date().toISOString(),
  };
  try {
    if (window.api && typeof window.api.getDiagnostics === 'function') {
      return await window.api.getDiagnostics();
    }
  } catch (err) {
    console.warn('[Feedback] getDiagnostics indisponible :', err);
  }
  return fallback;
}

function formatDiag(diag) {
  const lines = [
    `Version du logiciel : ${diag.appVersion || 'inconnue'}`,
    `Électron : ${diag.electronVersion || 'n/a'}`,
    `Node : ${diag.nodeVersion || 'n/a'}`,
    `Système : ${diag.platform || 'n/a'} ${diag.arch || ''} ${diag.osRelease ? '(' + diag.osRelease + ')' : ''}`,
    `Langue : ${diag.locale || 'n/a'}`,
    `Date : ${diag.timestamp || new Date().toISOString()}`,
  ];
  return lines.join('\n');
}

async function refreshFeedbackDiag() {
  const preview = $('feedbackDiagPreview');
  if (!preview) return;
  const diag = await collectDiagnostics();
  preview.textContent = formatDiag(diag);
  preview.dataset.diag = JSON.stringify(diag);
}

function showFeedbackStatus(cls, msg) {
  const el = $('feedbackStatus');
  if (!el) return;
  el.className = 'feedback-status ' + cls;
  el.textContent = msg;
}

async function submitFeedback() {
  const type = $('feedbackType');
  const msg = $('feedbackMessage');
  const status = $('feedbackStatus');
  if (!type || !msg) return;

  const message = msg.value.trim();
  if (!message) {
    showFeedbackStatus('warn', '⚠️ Merci de décrire votre message avant d\'envoyer.');
    msg.focus();
    return;
  }

  const submitBtn = $('submitFeedbackBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Envoi…';
  }

  const diagRaw = $('feedbackDiagPreview')?.dataset.diag;
  let diag = {};
  try { diag = diagRaw ? JSON.parse(diagRaw) : await collectDiagnostics(); } catch (_) { /* garde diag vide */ }

  const payload = {
    type: type.value,
    message,
    diagnostics: diag,
    // Horodatage renderer (double sécurité si diag indisponible)
    clientTimestamp: new Date().toISOString(),
  };

  // ───────────────────────────────────────────────────────────────────────
  // ⚠️ V2 — Envoi vers API backend non implémenté pour l'instant.
  // Brancher ici l'envoi HTTP (fetch POST vers l'endpoint de feedback)
  // lorsque le backend sera disponible. Exemple à venir :
  //
  //   const res = await fetch('https://api.exemple.fr/feedback', {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify(payload),
  //   });
  //   if (!res.ok) throw new Error('Échec de l\'envoi');
  //   return res.json();
  //
  // Pour l'instant : on consigne le rapport en console + localStorage
  // afin qu'il ne soit pas perdu, et on informe l'utilisateur.
  // ───────────────────────────────────────────────────────────────────────
  try {
    const archive = JSON.parse(localStorage.getItem('feedback-archive') || '[]');
    archive.push(payload);
    // On limite à 20 rapports archivés pour ne pas saturer le localStorage.
    if (archive.length > 20) archive.shift();
    localStorage.setItem('feedback-archive', JSON.stringify(archive));
    console.info('[Feedback] Rapport archivé localement (envoi serveur pas encore disponible) :', payload);

    showFeedbackStatus('ok', '✅ Votre rapport a bien été préparé. Il sera envoyé automatiquement dès que le service en ligne sera activé (V2).');
    msg.value = '';
  } catch (err) {
    console.error('[Feedback] Erreur d\'archivage :', err);
    showFeedbackStatus('error', '❌ Impossible d\'enregistrer le rapport. Copiez votre message avant de fermer.');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '📤 Envoyer';
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────────────────────────────────
const HelpModule = {
  init() {
    renderFaq();
    renderHelp();

    // Boutons du header
    $('openFaqBtn')?.addEventListener('click', () => openModal('faqModal'));
    $('openHelpBtn')?.addEventListener('click', () => openModal('helpModal'));
    $('openFeedbackBtn')?.addEventListener('click', async () => {
      await refreshFeedbackDiag();
      openModal('feedbackModal');
    });

    // Boutons Fermer / Annuler génériques (data-close-modal)
    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
    });

    // Clic sur l'overlay ferme la modale
    ['faqModal', 'helpModal', 'feedbackModal'].forEach((id) => {
      const overlay = $(id);
      if (overlay) {
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) closeModal(id);
        });
      }
    });

    // Envoi feedback
    $('submitFeedbackBtn')?.addEventListener('click', submitFeedback);
  },
};

window.helpModule = HelpModule;
document.addEventListener('DOMContentLoaded', () => {
  try { HelpModule.init(); } catch (err) { console.error('[Help] init échoué :', err); }
});
