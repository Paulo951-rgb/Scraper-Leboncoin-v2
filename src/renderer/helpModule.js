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
    q: 'Comment fonctionne le mode Ultra rapide ?',
    a: `<p>Le logiciel fonctionne <strong>toujours</strong> en mode <strong>⚡ Ultra rapide</strong>. Ce mode traite jusqu'à <strong>25 annonces en parallèle</strong> avec un <strong>délai nominal de 400 ms</strong> entre deux pages de recherche successives.</p>
        <p>Cette configuration est <strong>fixe et appliquée automatiquement</strong> : vous n'avez rien à régler, et elle n'est pas modifiable depuis les Paramètres (elle est affichée en lecture seule).</p>
        <p>Le logiciel n'est pas fragile pour autant : en cas de limitation (403/429), il <strong>réduit automatiquement la concurrence</strong> et applique un <strong>backoff progressif</strong> (voir la question sur les erreurs 403/429).</p>`
  },
  {
    q: 'Pourquoi la concurrence est-elle fixée à 25 ?',
    a: `<p><strong>25</strong> est le nombre maximal de tâches parallèles que le logiciel s'autorise. C'est le meilleur compromis observé entre débit et stabilité : au-delà, le risque de blocage anti-bot (403/429) augmente fortement sans gain de débit réel.</p>
        <p>La concurrence est <strong>bornée par sécurité</strong> : même si une ancienne configuration ou un paramètre transmis demandait davantage, le logiciel ne dépasse jamais 25.</p>
        <p>En cas de limitation détectée, la concurrence <em>effective</em> est temporairement réduite (elle peut descendre en dessous de 25), mais elle ne remonte jamais au-dessus.</p>`
  },
  {
    q: 'Pourquoi le délai nominal est-il de 400 ms ?',
    a: `<p>Le <strong>délai nominal de 400 ms</strong> entre deux pages de recherche successives est un compromis entre rapidité et respect du serveur. Un délai trop faible multiplie les blocages (le backoff après un 403/429 devient lui aussi trop court pour être efficace).</p>
        <p>C'est un délai <strong>nominal</strong> : il n'autorise jamais à contourner une limitation explicite du site. Si le serveur renvoie un <code>Retry-After</code> (avec un 429), le logiciel <strong>attend le délai demandé</strong> avant toute nouvelle requête.</p>`
  },
  {
    q: 'Pourquoi un job peut-il ralentir automatiquement ?',
    a: `<p>Pour rester fiable face aux protections anti-bot du site. Le logiciel surveille les signaux du serveur et réagit automatiquement :</p>
        <ul>
          <li><strong>Ralentissement progressif</strong> (backoff exponentiel) dès qu'un blocage est détecté ;</li>
          <li><strong>Réduction de la concurrence</strong> : après un 429 elle est divisée par 2, après un 403 elle est réduite de 25 % ;</li>
          <li><strong>Respect du <code>Retry-After</code></strong> : pause inter-lot d'au moins le délai demandé par le serveur.</li>
        </ul>
        <p>Les résultats déjà collectés sont <strong>conservés</strong> à chaque étape : un ralentissement ne fait jamais perdre les annonces déjà extraites.</p>`
  },
  {
    q: 'Que signifient les erreurs 403 et 429 ?',
    a: `<p><strong>403 (accès refusé)</strong> : le serveur refuse la requête (blocage anti-bot temporaire). <strong>429 (trop de requêtes)</strong> : le serveur limite temporairement le débit et indique souvent un délai via l'en-tête <code>Retry-After</code>.</p>
        <p>Dans les deux cas le logiciel :</p>
        <ul>
          <li><strong>arrête préventivement</strong> l'enrichissement après plusieurs blocages consécutifs (disjoncteur) ;</li>
          <li><strong>conserve</strong> les annonces déjà récupérées (succès partiel explicite, jamais un faux « succès complet ») ;</li>
          <li><strong>respecte</strong> le <code>Retry-After</code> lorsqu'il est fourni.</li>
        </ul>
        <p>Il n'y a <strong>aucune reprise automatique agressive</strong> et aucun contournement de protection (pas de rotation d'identité ni de proxy d'évasion). Patientez quelques minutes avant de relancer.</p>`
  },
  {
    q: 'Comment arrêter ou annuler un job ?',
    a: `<p>Cliquez sur le bouton <strong>🛑 Arrêter</strong> dans l'onglet Scraper. L'arrêt est <strong>propre</strong> :</p>
        <ul>
          <li>la capture réseau et le processus d'enrichissement sont interrompus ;</li>
          <li>les <strong>résultats partiels déjà écrits sont conservés</strong> ;</li>
          <li>le navigateur est fermé (aucun processus orphelin) ;</li>
          <li>l'état affiché est <strong>« annulé »</strong> — distinct d'un succès ou d'une erreur.</li>
        </ul>
        <p>Vous pouvez aussi simplement fermer l'application : les jobs en cours sont arrêtés proprement.</p>`
  },
  {
    q: 'Où retrouver les résultats et comment exporter en JSON et TXT ?',
    a: `<p>Chaque job crée un dossier horodaté dans le dossier de sortie (<strong>bouton « Dossier principal »</strong> dans l'onglet Historique). Il contient :</p>
        <ul>
          <li><code>annonces.json</code> — données structurées, avec empreinte d'intégrité SHA-256 ;</li>
          <li><code>annonces.txt</code> — version lisible (une fiche par annonce) ;</li>
          <li><code>report.json</code> — durées par phase, compteurs réseau, état du disjoncteur.</li>
        </ul>
        <p>Les exports sont <strong>générés automatiquement</strong> en fin de job selon le <strong>profil de données</strong> choisi (Défaut / Maximum / Personnalisé). Le TXT et le JSON reflètent exactement les mêmes champs sélectionnés.</p>`
  },
  {
    q: 'Comment fonctionne l\'historique ?',
    a: `<p>L'onglet <strong>📁 Historique Jobs</strong> liste tous les scrapings passés (date, nombre d'annonces, accès aux fichiers JSON/TXT, suppression).</p>
        <p>Les jobs sont triés du plus récent au plus ancien. La suppression d'un job efface son dossier complet (HAR + résultats) après confirmation. Le nettoyage automatique des vieux jobs est configurable dans les Paramètres.</p>`
  },
  {
    q: 'Pourquoi certaines informations peuvent-elles être absentes ?',
    a: `<p>Le logiciel distingue strictement trois états : <strong>information présente</strong>, <strong>information absente</strong> (le site ne la fournit pas) et <strong>information non récupérée</strong> (erreur/blocage). Un champ introuvable vaut toujours <code>null</code> — <strong>jamais</strong> <code>0</code>, <code>''</code> ou une valeur inventée.</p>
        <p>Causes fréquentes d'absence : le vendeur n'expose pas de note, l'annonce n'a pas de description, ou l'enrichissement de la page de détail a été bloqué (403/429). Dans ce dernier cas, le job est signalé comme <strong>succès partiel</strong>.</p>`
  },
  {
    q: 'Comment interpréter les statistiques ?',
    a: `<p>L'onglet <strong>📊 Statistiques & Carte</strong> calcule les statistiques à partir des annonces réellement collectées : total, prix moyen, <strong>prix médian</strong> (souvent plus parlant que la moyenne car il ignore les extrêmes), prix min/max, répartition des modes de remise, vendeurs pro/particulier, top villes.</p>
        <p>Les annonces sans prix valide sont ignorées dans les calculs de prix (et comptées séparément). Les statistiques se recalculent après chaque job et lors du changement de session.</p>`
  },
  {
    q: 'Où sont stockées mes données et comment les supprimer ?',
    a: `<p>Tout reste <strong>local</strong> sur votre machine, dans le dossier de sortie : jobs, résultats, logs, session navigateur. Aucune donnée scrapée n'est envoyée sur Internet.</p>
        <p>Pour supprimer : utilisez le bouton <strong>🗑</strong> de l'historique pour un job précis, ou supprimez le dossier de sortie complet pour tout effacer. Les fichiers <code>.har</code> et les logs sont purgés automatiquement selon la rétention configurée.</p>`
  },
  {
    q: 'Comment consulter les logs et diagnostiquer un problème ?',
    a: `<p>L'onglet <strong>📜 Logs</strong> affiche la console en temps réel (filtrage normal/debug, export possible). Un <strong>résumé de session</strong> est produit en fin de job (pages, annonces, doublons, erreurs).</p>
        <p>Pour un diagnostic avancé : ouvrez <code>report.json</code> du job (durées par phase, compteurs réseau, blocages) et les logs dans le dossier <code>logs/</code>. Le bouton <strong>Signaler un problème</strong> pré-remplit un rapport avec la version et le système (aucune donnée personnelle).</p>`
  },
  {
    q: 'Comment mettre à jour l\'application ?',
    a: `<p>Téléchargez la dernière version depuis la page <strong>Releases</strong> du dépôt GitHub et réinstallez-la par-dessus l'installation existante (vos données locales sont conservées).</p>
        <p>Il n'y a pas de mise à jour automatique intégrée : la mise à jour est manuelle et documentée dans le <code>README.md</code>.</p>`
  },
  {
    q: 'Y a-t-il une analyse par intelligence artificielle (modèle local ou cloud) ?',
    a: `<p><strong>Non.</strong> Le logiciel ne contient <strong>aucune</strong> intelligence artificielle : pas de modèle de langage, pas de service cloud, pas d'analyse d'image. Il n'y a donc <strong>rien à configurer</strong> (aucune clé d'API, aucun serveur d'IA à installer).</p>
        <p>Le scraping et l'analyse sont <strong>100 % locaux et déterministes</strong> : extraction, normalisation, calcul du type de remise, statistiques de prix et exports. Les résultats sont reproductibles et ne dépendent d'aucun modèle externe. L'ancien module « IA Studio » et les fonctions d'estimation par IA ont été <strong>entièrement retirés</strong>.</p>`
  },
  {
    q: 'Comment signaler un bug ou proposer une amélioration ?',
    a: `<p>Utilisez le bouton <strong>💬 Feedback</strong> dans la barre latérale : le formulaire pré-remplit un rapport (version de l'application, système) <strong>sans donnée personnelle</strong>, prêt à être copié.</p>
        <p>Vous pouvez aussi ouvrir une <strong>issue</strong> sur le dépôt GitHub en décrivant : ce que vous faisiez, ce qui s'est passé, et si possible le <code>report.json</code> du job concerné. Pour un diagnostic, joignez l'extrait pertinent de l'onglet <strong>Logs</strong> (jamais de secrets).</p>`
  },
  {
    q: 'À quoi sert Leboncoin Scraper Pro ?',
    a: `<p>Leboncoin Scraper Pro est un logiciel de bureau (Windows / macOS / Linux) qui <strong>collecte automatiquement les annonces Leboncoin</strong> à partir d'une URL de recherche, puis les exporte.</p>
        <p>Il permet de :</p>
        <ul>
          <li>récupérer des dizaines, voire des centaines d'annonces en quelques minutes ;</li>
          <li>visualiser le marché (prix moyen, distribution, carte géographique, modes de transaction) ;</li>
          <li>comparer les annonces et exporter les résultats (JSON, TXT).</li>
        </ul>`
  },
  {
    q: 'Le logiciel envoie-t-il mes données sur Internet ?',
    a: `<p>Le logiciel se connecte uniquement à :</p>
        <ul>
          <li><strong>leboncoin.fr</strong> pour récupérer les annonces ;</li>
          <li>l'API de géocodage du gouvernement français (geo.api.gouv.fr) pour positionner les villes sur la carte ;</li>
          <li>les tuiles de fond de carte <strong>OpenStreetMap</strong> (openstreetmap.org) lorsque la carte est affichée.</li>
        </ul>
        <p>Les bibliothèques d'affichage (graphiques Chart.js, carte Leaflet) sont <strong>embarquées dans le logiciel</strong> : elles ne sont plus téléchargées depuis un CDN. L'interface fonctionne donc même hors ligne (seule la carte a besoin d'Internet pour ses tuiles).</p>
        <p>Vos annonces scrapées ne sont jamais envoyées à ces services : ils ne servent qu'à charger des fonds de carte.</p>
        <p>Aucune clé API payante n'est requise.</p>`
  },
  {
    q: 'Comment fonctionne le scraping ?',
    a: `<p>Le logiciel ouvre un navigateur (Chromium via Playwright) qui charge les pages de résultats Leboncoin, capture les données des annonces (titre, prix, ville, vendeur, photos…) puis enrichit éventuellement chaque annonce avec sa <strong>description détaillée</strong> en ouvrant la page de l'annonce.</p>
        <p>Si Leboncoin détecte une activité robotique, un <strong>CAPTCHA peut apparaître</strong> : le navigateur devient alors visible pour que vous le résolviez manuellement, après quoi le scraping reprend tout seul.</p>`
  },
  {
    q: 'Que signifie « Type de remise » (livraison, main propre, les deux) ?',
    a: `<p>Chaque annonce Leboncoin propose un ou plusieurs <strong>modes de remise</strong>. Le logiciel unifie ces informations dans un champ unique <code>deliveryType</code> :</p>
        <ul>
          <li><strong>📦 livraison</strong> — le vendeur propose l'envoi postal uniquement ;</li>
          <li><strong>🤝 main_propre</strong> — remise en main propre uniquement (pas de livraison) ;</li>
          <li><strong>📦🤝 les_deux</strong> — les deux modes sont disponibles ;</li>
          <li><strong>🚫 aucun</strong> — ni livraison ni main propre (rare) ;</li>
          <li><strong>❓ inconnu</strong> — l'information n'a pas pu être extraite.</li>
        </ul>
        <p>La carte propose un filtre « Remise en main propre uniquement » pour visualiser les annonces récupérables près de chez vous (main_propre + les_deux).</p>`
  },
  {
    q: `Pourquoi le nombre d'annonces sur la carte est-il parfois inférieur au total ?`,
    a: `<p>Plusieurs raisons possibles :</p>
        <ul>
          <li><strong>Filtre « main propre »</strong> activé par défaut sur la carte → seules les annonces avec remise en main propre (main_propre ou les_deux) sont affichées.</li>
          <li>Annonces <strong>sans ville détectée</strong> (pas de géocodage possible).</li>
          <li><strong>Déduplication</strong> : si la même annonce (même id Leboncoin) apparaît dans plusieurs sessions, elle n'est affichée qu'une seule fois.</li>
        </ul>`
  },
  {
    q: 'Pourquoi aucune description n\'a-t-elle été récupérée ?',
    a: `<p>Les descriptions sont <strong>toujours enrichies</strong> quand la page de détail de l'annonce est accessible. Si une description manque, c'est que la page de détail a été bloquée (403/429), que l'annonce a été supprimée, ou que le vendeur n'a pas rédigé de description.</p>
        <p>Le mode de performance (Ultra rapide) est identique dans tous les cas et applique la politique de scraping fixe du logiciel.</p>`
  },
  {
    q: 'J\'obtiens une erreur 403 / 429 pendant le scraping, que faire ?',
    a: `<p>Une erreur <strong>403</strong> (accès refusé) ou <strong>429</strong> (trop de requêtes) signifie que Leboncoin a temporairement limité l'accès. Le logiciel gère déjà cela automatiquement (réduction de concurrence + backoff + respect du <code>Retry-After</code>) et <strong>conserve les annonces déjà collectées</strong>.</p>
        <p>Si le blocage persiste :</p>
        <ul>
          <li>Attendez quelques minutes puis réessayez ;</li>
          <li>Réduisez le nombre de pages par job ;</li>
          <li>Ne relancez pas en boucle : cela aggrave la limitation.</li>
        </ul>
        <p>Le logiciel n'effectue <strong>aucun contournement</strong> des protections du site (pas de rotation d'identité ni de mécanisme d'évasion).</p>`
  },
  {
    q: 'Mes favoris ou filtres sont-ils conservés ?',
    a: `<p>Les <strong>favoris</strong> (⭐) sont enregistrés dans le navigateur et persistent entre les sessions. Les <strong>filtres de l'explorateur</strong> (mot-clé, prix, tag) sont également mémorisés localement.</p>
        <p>Les <strong>jobs scrapés</strong> (annonces + résultats) sont stockés sur le disque dans le dossier de sortie, avec un contrôle d'intégrité SHA-256.</p>`
  },
  {
    q: 'Comment fonctionne la minimisation des données ?',
    a: `<p>Le logiciel propose plusieurs niveaux de contrôle :</p>
        <ul>
          <li><strong>Mode d'export</strong> : choisissez entre Défaut (toutes les données) et Personnalisé (seuls les champs sélectionnés sont exportés).</li>
          <li><strong>Données vendeur</strong> : vous pouvez désactiver les données vendeur (nom, ID, note, avis, URL profil) dans les Paramètres ⚙️. Elles sont alors exclues de tous les exports et masquées dans l'interface.</li>
        </ul>
        <p>Consultez <code>docs/DATA_HANDLING.md</code> pour le tableau complet des catégories de données et leur traçabilité.</p>`
  },
  {
    q: 'Où sont stockés mes fichiers exportés ?',
    a: `<p>Dans le <strong>dossier de sortie</strong> du logiciel (bouton « Dossier principal » dans l'onglet Historique). Chaque job crée un sous-dossier horodaté contenant :</p>
        <ul>
          <li><code>annonces.json</code>, <code>annonces.txt</code> ;</li>
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
    body: `<p>Paramètres de recherche :</p>
      <ul>
        <li><strong>Pages</strong> — combien de pages de résultats parcourir (attention : trop de pages = risque de blocage).</li>
        <li><strong>Limite</strong> — plafond d'annonces (vide = toutes).</li>
      </ul>
      <p>La <strong>performance</strong> (mode ⚡ Ultra rapide, 25 parallèles, délai 400 ms) est <strong>fixe</strong> et appliquée automatiquement : elle n'est pas modifiable.</p>
      <p>Dans <strong>Paramètres ⚙️</strong> vous pouvez régler : le thème, le mode de capture (invisible / visible si CAPTCHA), les données vendeur, le nettoyage automatique.</p>`
  },
  {
    icon: '🔍', title: '3. Explorer les résultats',
    body: `<p>Onglet <strong>🔍 Explorateur Annonces</strong> :</p>
      <ul>
        <li><strong>Vue tableau / grille</strong> — basculez avec le bouton dédié ou la touche <code>Espace</code>.</li>
        <li><strong>Filtres</strong> — mot-clé (titre, description, ville), prix min/max, tag de deal (favoris).</li>
        <li><strong>Tri</strong> — prix croissant/décroissant, ordre d'origine.</li>
        <li><strong>Fiche détaillée</strong> — cliquez une annonce pour voir photos, description complète, et informations vendeur.</li>
        <li><strong>Comparateur</strong> — ajoutez des annonces aux favoris (⭐) puis comparez-les côte à côte.</li>
      </ul>
      <div class="help-tip">💡 Raccourci <code>Ctrl+N</code> pour aller vite au Scraper et focus sur l'URL.</div>`
  },
  {
    icon: '📊', title: '4. Comprendre les statistiques',
    body: `<p>Onglet <strong>📊 Statistiques & Carte</strong> :</p>
      <ul>
        <li><strong>8 cartes</strong> : Total, Prix Moyen, Prix Médian, Prix Min/Max, Livraison, Répartition remise, Professionnels, Particuliers.</li>
        <li><strong>3 graphiques</strong> : Distribution des prix, Vendeurs (pro/particulier), Top 10 Villes.</li>
        <li>Le sélecteur en haut permet de choisir <strong>une session précise</strong> ou toutes combinées.</li>
      </ul>
      <div class="help-tip">💡 Le prix <strong>médian</strong> est souvent plus parlant que la moyenne (il ignore les prix extrêmes).</div>`
  },
  {
    icon: '🗺️', title: '5. Utiliser la carte',
    body: `<p>La carte (Leaflet) affiche la <strong>répartition géographique</strong> des annonces en France.</p>
      <ul>
        <li>Cochez <strong>« Remise en main propre uniquement »</strong> pour ne voir que les annonces récupérables en personne (main_propre ou les_deux).</li>
        <li>Les annonces sont <strong>dédupliquées par id</strong> (pas de doublons si plusieurs sessions).</li>
        <li>Le géocodage (ville → coordonnées) utilise l'API gouvernementale, avec un cache et un timeout de 10 s.</li>
      </ul>
      <div class="help-warn">⚠️ Seules les annonces avec une ville détectée peuvent être positionnées.</div>`
  },
  {
    icon: '⚠️', title: '6. Erreurs courantes et solutions',
    body: `<ul>
        <li><strong>403 / 429</strong> — Leboncoin limite l'accès. Le logiciel ralentit et réduit la concurrence automatiquement, puis conserve les annonces déjà récupérées. Attendez et réessayez, ou réduisez les pages.</li>
        <li><strong>CAPTCHA</strong> — le navigateur devient visible : résolvez-le à la main, le scraping reprend.</li>
        <li><strong>0 annonce récupérée</strong> — vérifiez l'URL (catégorie/prix/filtres) et votre connexion.</li>
        <li><strong>Carte vide</strong> — décochez le filtre main propre ou scrapez des annonces avec une ville.</li>
        <li><strong>Badge Hors-ligne</strong> — pas de réseau : le scraping est désactivé mais l'historique reste consultable.</li>
      </ul>`
  },
  {
    icon: '💾', title: '7. Exporter et conserver',
    body: `<p>Chaque job est stocké dans le <strong>dossier de sortie</strong> (bouton « Dossier principal » dans l'onglet Historique).</p>
      <ul>
        <li><strong>JSON / TXT</strong> — formats lisibles pour réutilisation.</li>
        <li>Les fichiers <code>.har</code> sont nettoyés automatiquement (Paramètres → rétention).</li>
      </ul>
      <p>L'onglet <strong>📁 Historique Jobs</strong> liste tous les scrapings passés, avec accès aux fichiers et suppression.</p>`
  },
  {
    icon: '🛡️', title: '8. Données et responsabilités',
    body: `<p>Ce logiciel est un outil technique d'automatisation et d'analyse. Vous êtes responsable de l'utilisation que vous en faites.</p>
      <ul>
        <li>Vérifiez que votre utilisation est autorisée par le site concerné et respecte ses conditions d'utilisation.</li>
        <li>Les données vendeur peuvent contenir des informations permettant d'identifier une personne. Désactivez-les dans les Paramètres ⚙️ si elles ne sont pas nécessaires.</li>
        <li>Utilisez le <strong>Mode Personnalisé</strong> pour ne conserver que les champs strictement nécessaires.</li>
        <li>Consultez <code>LEGAL.md</code> et <code>docs/DATA_HANDLING.md</code> pour plus de détails.</li>
      </ul>`
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
