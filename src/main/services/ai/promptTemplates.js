'use strict';

/**
 * promptTemplates.js — Bibliothèque de prompts préfaits (IA Studio).
 *
 * Remplace l'ancien générateur de prompts par IA (Ollama). Les prompts sont
 * désormais des templates statiques à trous : l'utilisateur remplit les
 * placeholders, le prompt est assemblé localement (instantané, aucune IA).
 *
 * Les prompts sont GÉNÉRIQUES et RÉUTILISABLES pour n'importe quel type de
 * produit (voiture, PC, meuble, vêtement, livre, électroménager…). Aucune
 * catégorie spécifique n'est codée en dur.
 *
 * Structure d'un template :
 *   id          identifiant unique
 *   title       titre court affiché dans le sélecteur
 *   category    groupe pour l'organisation (info utilisateur)
 *   description description d'une ligne du but du prompt
 *   placeholders champs à remplir par l'utilisateur
 *     key           nom de la variable (sans les crochets)
 *     label         libellé du champ
 *     placeholder   exemple/placeholder HTML
 *     type          'text' | 'number' | 'textarea'
 *     default       valeur par défaut (optionnel)
 *   template    texte du prompt avec [KEY] comme marqueurs de substitution
 */

const TEMPLATES = [

  // ──────────────────────────────────────────────────────────────────────
  // 1. ANALYSE COMPLÈTE & CLASSEMENT GLOBAL
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'analyse-complete',
    title: '🔍 Analyse complète & classement global',
    category: 'Analyse globale',
    description: 'Le prompt le plus polyvalent : analyse exhaustive, classements multi-catégories, opportunités directes et indirectes.',
    placeholders: [
      { key: 'TYPE_DE_PRODUIT', label: 'Type de produit', placeholder: 'Ex : PC fixes, cartes graphiques, voitures, meubles…', type: 'text', default: 'produits d\'occasion' },
      { key: 'NOMBRE_ANNONCES', label: 'Nombre d\'annonces', placeholder: 'Ex : 900', type: 'number', default: '900' },
      { key: 'OBJECTIF_ANALYSE', label: 'Objectif de l\'analyse', placeholder: 'Ex : Trouver les meilleures affaires et opportunités d\'achat-revente', type: 'textarea', default: 'Trouver les meilleures affaires, les opportunités d\'achat-revente et les produits sous-évalués' },
      { key: 'CATEGORIES_A_ANALYSER', label: 'Catégories à analyser', placeholder: 'Ex : produits neufs, d\'occasion, en panne, incomplets, lots…', type: 'text', default: 'toutes les catégories (neuf, occasion, panne, incomplet, lot)' },
      { key: 'BUDGET_MIN', label: 'Budget minimum (€)', placeholder: 'Ex : 0', type: 'number', default: '0' },
      { key: 'BUDGET_MAX', label: 'Budget maximum (€)', placeholder: 'Ex : 1000', type: 'number', default: '1000' },
      { key: 'TOP_AFFAIRES', label: 'Top meilleures affaires', placeholder: 'Ex : 50', type: 'number', default: '50' },
      { key: 'TOP_REVENTE', label: 'Top achat-revente', placeholder: 'Ex : 20', type: 'number', default: '20' },
      { key: 'TOP_PEPITES', label: 'Top pépites sous-évaluées', placeholder: 'Ex : 20', type: 'number', default: '20' },
      { key: 'TOP_A_EVITER', label: 'Top annonces à éviter', placeholder: 'Ex : 10', type: 'number', default: '10' },
      { key: 'CRITERES_CLASSEMENT', label: 'Critères de classement', placeholder: 'Ex : rapport qualité/prix, valeur de revente, rareté…', type: 'textarea', default: 'rapport qualité/prix, potentiel de revente, valeur réelle estimée, rareté' },
    ],
    template: `Tu es un expert en achat-revente et analyse d'annonces d'occasion sur Le Bon Coin.

Je te fournis un fichier texte contenant environ [NOMBRE_ANNONCES] annonces issues d'une recherche "[TYPE_DE_PRODUIT]". Les annonces peuvent contenir des [TYPE_DE_PRODUIT] mais aussi des produits annexes, des lots, des pièces détachées, des produits en panne ou incomplets.

Ta mission :
- Analyse 100 % des annonces sans en oublier aucune.
- Classe chaque annonce dans la bonne catégorie ([CATEGORIES_A_ANALYSER]).
- Ne supprime aucune annonce intéressante même si elle ne correspond pas exactement à la recherche initiale.

Objectif : [OBJECTIF_ANALYSE]

CHERCHE LES MEILLEURES OPPORTUNITÉS :
- Meilleur rapport qualité/prix ;
- Meilleures affaires pour achat-revente ;
- Produits fortement sous-évalués ;
- Annonces qui cachent une valeur supérieure au prix demandé.

PREND EN COMPTE LES OPPORTUNITÉS INDIRECTES :
- Produits intéressants uniquement pour récupérer des pièces/composants ;
- Machines ou appareils en panne ou incomplets qui peuvent être réparés ou démontés ;
- Lots dont la valeur des pièces dépasse le prix demandé.

FILTRE DE BUDGET : prends en priorité les annonces entre [BUDGET_MIN] € et [BUDGET_MAX] € (n'exclus pas les annonces hors budget si elles représentent une opportunité majeure, mais signale-les).

POUR CHAQUE ANNONCE INTÉRESSANTE, INDIQUE :
- Catégorie ;
- Prix demandé ;
- Valeur réelle estimée ;
- Score global /100 ;
- Rapport qualité/prix ;
- Potentiel de revente ;
- Pièces/composants intéressants à récupérer (le cas échéant) ;
- Points forts / points faibles ;
- Recommandation (Acheter / Négocier / Surveiller / Éviter).

DÉTECTE AUSSI LES RISQUES :
- Prix trop beau pour être vrai ;
- Description incohérente ;
- Informations manquantes ;
- Suspicion d'arnaque.
Donne un niveau de risque : Faible / Moyen / Élevé, sans affirmer une arnaque sans preuve.

CRITÈRES DE CLASSEMENT À PRIVILÉGIER : [CRITERES_CLASSEMENT]

À LA FIN, CRÉE LES CLASSEMENTS SUIVANTS :
- Top [TOP_AFFAIRES] meilleures affaires toutes catégories ;
- Top [TOP_REVENTE] achat-revente ;
- Top [TOP_PEPITES] pépites sous-évaluées ;
- Top [TOP_A_EVITER] annonces à éviter.

L'objectif est de trouver les vraies pépites cachées dans les [NOMBRE_ANNONCES] annonces : les meilleurs rapports valeur/prix, les meilleures opportunités de revente et les produits les plus rentables.`,
  },

  // ──────────────────────────────────────────────────────────────────────
  // 2. ACHAT-REVENTE & FLIP
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'achat-revente',
    title: '💰 Achat-revente & flip',
    category: 'Rentabilité',
    description: 'Optimisé pour maximiser le profit de revente : marge, ROI, liquidité, produits à fort potentiel de revente.',
    placeholders: [
      { key: 'TYPE_DE_PRODUIT', label: 'Type de produit', placeholder: 'Ex : smartphones, consoles, composants PC…', type: 'text', default: 'produits d\'occasion' },
      { key: 'NOMBRE_ANNONCES', label: 'Nombre d\'annonces', placeholder: 'Ex : 500', type: 'number', default: '500' },
      { key: 'MARGE_MINIMUM', label: 'Marge minimum visée (€)', placeholder: 'Ex : 30', type: 'number', default: '30' },
      { key: 'BUDGET_MAX_ACHAT', label: 'Budget max d\'achat (€)', placeholder: 'Ex : 300', type: 'number', default: '300' },
      { key: 'TOP_REVENTE', label: 'Nombre de résultats (Top)', placeholder: 'Ex : 30', type: 'number', default: '30' },
      { key: 'CANAUX_REVENTE', label: 'Canaux de revente envisagés', placeholder: 'Ex : Leboncoin, Vinted, eBay, Back Market…', type: 'text', default: 'Leboncoin, eBay, Vinted' },
      { key: 'CRITERES_LIQUIDITE', label: 'Critères de liquidité', placeholder: 'Ex : produits qui se vendent en moins d\'une semaine…', type: 'textarea', default: 'produits qui se revendent rapidement (moins d\'une semaine), forte demande' },
    ],
    template: `Tu es un expert en achat-revente (flip) sur Le Bon Coin et les plateformes de vente en ligne.

Je te fournis un fichier contenant environ [NOMBRE_ANNONCES] annonces de "[TYPE_DE_PRODUIT]".

OBJECTIF : Identifier les annonces avec le meilleur potentiel de profit à la revente.

Ton objectif est de trouver des produits achetés à un prix bas et revendables avec une marge minimum de [MARGE_MINIMUM] €, dans un budget d'achat maximum de [BUDGET_MAX_ACHAT] €.

CANAUX DE REVENTE À CONSIDÉRER : [CANAUX_REVENTE]

CRITÈRES DE LIQUIDITÉ : [CRITERES_LIQUIDITE]

POUR CHAQUE ANNONCE INTÉRESSANTE, CALCULE :
- Prix d'achat demandé ;
- Estimation du prix de revente (par canal) ;
- Marge nette estimée (en € et en %) ;
- ROI (retour sur investissement) ;
- Délai de revente estimé (rapide/moyen/lent) ;
- Risque (prix de revente incertain, marché saturé, etc.) ;
- Recommandation : Acheter pour flip / Surveiller / Éviter.

IDENTIFIE AUSSI :
- Les produits dont la valeur de revente dépasse largement le prix demandé ;
- Les lots achetables en bloc puis revendus à l'unité ;
- Les produits réparables ou nettoyables qui prennent de la valeur ;
- Les produits avec forte demande et faible offre sur les canaux de revente.

EXCLUS les produits :
- Dont la marge estimée est inférieure à [MARGE_MINIMUM] € ;
- Au-delà du budget de [BUDGET_MAX_ACHAT] € (sauf opportunité exceptionnelle).

À LA FIN, CRÉE :
- Top [TOP_REVENTE] meilleurs flips (classés par ROI décroissant) ;
- Top 10 lots à fractionner ;
- Top 10 produits réparables à fort potentiel ;
- 5 produits à éviter (mauvaise affaire / marché saturé).

Format de sortie : tableau Markdown avec colonnes (Produit | Prix achat | Prix revente estimé | Marge € | ROI % | Liquidité | Recommandation).`,
  },

  // ──────────────────────────────────────────────────────────────────────
  // 3. DÉTECTION DE PÉPITES SOUS-ÉVALUÉES
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'pepites-sous-evaluees',
    title: '💎 Pépites sous-évaluées',
    category: 'Opportunités',
    description: 'Trouve les annonces dont le prix est anormalement bas par rapport à la valeur réelle du produit.',
    placeholders: [
      { key: 'TYPE_DE_PRODUIT', label: 'Type de produit', placeholder: 'Ex : matériel audio, montres, vélos…', type: 'text', default: 'produits d\'occasion' },
      { key: 'NOMBRE_ANNONCES', label: 'Nombre d\'annonces', placeholder: 'Ex : 600', type: 'number', default: '600' },
      { key: 'SEUIL_SOUS_EVALUATION', label: 'Seuil de sous-évaluation (%)', placeholder: 'Ex : 40 (prix ≤ 60% de la valeur)', type: 'number', default: '40' },
      { key: 'TOP_PEPITES', label: 'Nombre de pépites à lister', placeholder: 'Ex : 25', type: 'number', default: '25' },
      { key: 'CRITERES_VALEUR', label: 'Critères de valeur', placeholder: 'Ex : marque, modèle, année, état, rareté, accessoires inclus…', type: 'textarea', default: 'marque, modèle, année, état, rareté, accessoires inclus, édition limitée' },
    ],
    template: `Tu es un expert en estimation de valeur de produits d'occasion sur Le Bon Coin.

Je te fournis un fichier d'environ [NOMBRE_ANNONCES] annonces de "[TYPE_DE_PRODUIT]".

OBJECTIF : Identifier les annonces SOUS-ÉVALUÉES, c'est-à-dire dont le prix demandé est inférieur d'au moins [SEUIL_SOUS_EVALUATION] % à la valeur réelle du produit.

CRITÈRES DE VALEUR À ÉVALUER : [CRITERES_VALEUR]

POUR CHAQUE ANNONCE, ESTIME :
- La valeur réelle du produit (prix marché moyen pour un produit équivalent en bon état) ;
- Le prix demandé ;
- L'écart en € et en % ;
- Les raisons de la sous-évaluation possible (vendeur non informé, erreur de prix, urgence, produit mal présenté, photos de mauvaise qualité…) ;
- Si c'est une vraie pépite ou un piège (produit défectueux caché, contrefaçon…).

IDENTIFIE PARTICULIÈREMENT :
- Les produits de marque/valeur vendus bien en dessous du marché ;
- Les annonces mal décrites ou mal photographiées qui cachent un produit de valeur ;
- Les lots contenant un objet de valeur non mentionné dans le titre ;
- Les produits rares ou recherchés proposés à bas prix ;
- Les annonces urgentes (déménagement, besoin rapide d'argent) avec prix cassés.

EXCLUS :
- Les produits dont la sous-évaluation s'explique par un défaut majeur non réparable ;
- Les contrefaçons probables (prix aberrant + marque de luxe).

À LA FIN, CRÉE :
- Top [TOP_PEPITES] pépites sous-évaluées (classées par écart de valeur décroissant) ;
- Top 10 annonces mal présentées mais à fort potentiel (description/ photos à améliorer) ;
- Top 5 lots avec valeur cachée.

Format : pour chaque pépite, indique le titre de l'annonce, le prix demandé, la valeur estimée, l'écart (€ et %), la raison de la sous-évaluation, et la recommandation (Acheter immédiatement / Négocier / Demander plus de photos).`,
  },

  // ──────────────────────────────────────────────────────────────────────
  // 4. LOTS & RÉCUPÉRATION DE PIÈCES
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'lots-pieces',
    title: '🔧 Lots & récupération de pièces',
    category: 'Opportunités',
    description: 'Analyse les lots, produits en panne ou incomplets : valeur des pièces détachées, potentiel de démontage.',
    placeholders: [
      { key: 'TYPE_DE_PRODUIT', label: 'Type de produit', placeholder: 'Ex : PC, électroménager, vélos, mobilier…', type: 'text', default: 'produits d\'occasion' },
      { key: 'NOMBRE_ANNONCES', label: 'Nombre d\'annonces', placeholder: 'Ex : 400', type: 'number', default: '400' },
      { key: 'PIECES_INTERESSANTES', label: 'Pièces/composants recherchés', placeholder: 'Ex : RAM, SSD, GPU, écran, moteur, cadre…', type: 'textarea', default: 'pièces détachées valorisables (précise le type)' },
      { key: 'BUDGET_MAX_LOT', label: 'Budget max par lot (€)', placeholder: 'Ex : 200', type: 'number', default: '200' },
      { key: 'TOP_LOTS', label: 'Nombre de résultats (Top)', placeholder: 'Ex : 20', type: 'number', default: '20' },
    ],
    template: `Tu es un expert en récupération de pièces détachées et valorisation de lots sur Le Bon Coin.

Je te fournis un fichier d'environ [NOMBRE_ANNONCES] annonces de "[TYPE_DE_PRODUIT]".

OBJECTIF : Identifier les lots et produits dont la valeur des pièces/composants récupérables dépasse le prix demandé.

PIÈCES/COMPOSANTS RECHERCHÉS : [PIECES_INTERESSANTES]

BUDGET MAX PAR LOT : [BUDGET_MAX_LOT] €

POUR CHAQUE LOT OU PRODUIT INTÉRESSANT, ANALYSE :
- Le prix demandé ;
- La liste des pièces/composants récupérables ;
- La valeur estimée de chaque pièce (prix de revente individuel) ;
- La valeur totale des pièces ;
- La marge potentielle (valeur des pièces - prix d'achat) ;
- L'effort nécessaire (démontage simple / complexe / outils requis) ;
- La facilité de revente des pièces (demande sur le marché).

IDENTIFIE :
- Les lots contenant plusieurs produits démontables ;
- Les machines en panne mais avec des composants fonctionnels et valorisables ;
- Les produits incomplets (manque une pièce non essentielle) mais réparables ou démontables ;
- Les annonces où le vendeur ne soupçonne pas la valeur des composants.

À LA FIN, CRÉE :
- Top [TOP_LOTS] lots à fort potentiel de récupération (classés par marge) ;
- Top 10 produits en panne réparables ;
- Top 10 produits incomplets à compléter.

Format : tableau avec (Annonce | Prix | Pièces récupérables | Valeur totale pièces | Marge € | Effort | Recommandation).`,
  },

  // ──────────────────────────────────────────────────────────────────────
  // 5. ANALYSE DE RISQUES & ARNAQUES
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'risques-arnaques',
    title: '🚨 Analyse de risques & arnaques',
    category: 'Sécurité',
    description: 'Détecte les annonces suspectes, les arnaques probables, les risques d\'achat (produit défectueux, faux, volé).',
    placeholders: [
      { key: 'TYPE_DE_PRODUIT', label: 'Type de produit', placeholder: 'Ex : smartphones de marque, luxe, électronique…', type: 'text', default: 'produits d\'occasion' },
      { key: 'NOMBRE_ANNONCES', label: 'Nombre d\'annonces', placeholder: 'Ex : 300', type: 'number', default: '300' },
      { key: 'TOP_SUSPECTES', label: 'Nombre d\'annonces suspectes à lister', placeholder: 'Ex : 20', type: 'number', default: '20' },
      { key: 'TOP_FIABLES', label: 'Nombre d\'annonces fiables à lister', placeholder: 'Ex : 15', type: 'number', default: '15' },
      { key: 'SIGNAUX_ALERTE', label: 'Signaux d\'alerte à surveiller', placeholder: 'Ex : prix anormalement bas, vendeur sans historique, photos volées…', type: 'textarea', default: 'prix anormalement bas, vendeur sans historique, photos volées, description vague, pression à l\'achat' },
    ],
    template: `Tu es un expert en détection de fraudes et analyse de risques sur les annonces de vente en ligne (Le Bon Coin).

Je te fournis un fichier d'environ [NOMBRE_ANNONCES] annonces de "[TYPE_DE_PRODUIT]".

OBJECTIF : Évaluer le niveau de risque de chaque annonce et identifier les arnaques probables.

SIGNAUX D'ALERTE À SURVEILLER : [SIGNAUX_ALERTE]

POUR CHAQUE ANNONCE, ÉVALUE :
- Le niveau de risque : Faible / Moyen / Élevé / Critique ;
- Les signaux d'alerte détectés (prix aberrant, photos suspectes, description incohérente, vendeur suspect…) ;
- La probabilité d'arnaque (en %) ;
- Le type de risque potentiel : contrefaçon, produit volé, produit défectueux caché, vendeur fantôme, phishing, etc. ;
- Les éléments manquants pour confirmer (photos supplémentaires, facture, numéro de série…).

IMPORTANT : Ne JAMAIS affirmer une arnaque sans preuve. Tu signales une SUSPICION, pas une certité. Utilise le conditionnel et précise ce qui doit être vérifié.

DÉTECTE PARTICULIÈREMENT :
- Les prix "trop beau pour être vrai" (écart > 50% sous le marché) ;
- Les annonces avec photos de mauvaise qualité ou provenant d'autres sites ;
- Les vendeurs avec plusieurs annonces identiques (potentiel revendeur professionnel non déclaré) ;
- Les descriptions copiées-collées ou génériques ;
- Les demandes de paiement hors plateforme.

À LA FIN, CRÉE :
- Top [TOP_SUSPECTES] annonces les plus suspectes (classées par niveau de risque) ;
- Top [TOP_FIABLES] annonces les plus fiables (transparentes, bon rapport qualité/prix, vendeur sérieux) ;
- Liste des arnaques types détectées dans ce lot d'annonces.

Format : pour chaque annonce suspecte, indique le titre, le prix, les signaux d'alerte, le niveau de risque, et la recommandation (Éviter / Demander des preuves / Négocier avec prudence).`,
  },

  // ──────────────────────────────────────────────────────────────────────
  // 6. COMPARAISON PRIX & ESTIMATION VALEUR
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'comparaison-prix',
    title: '📊 Comparaison prix & estimation valeur',
    category: 'Analyse de prix',
    description: 'Estime la valeur réelle de chaque produit et compare les prix pour identifier les écarts anormaux.',
    placeholders: [
      { key: 'TYPE_DE_PRODUIT', label: 'Type de produit', placeholder: 'Ex : électroménager, outillage, mobilier…', type: 'text', default: 'produits d\'occasion' },
      { key: 'NOMBRE_ANNONCES', label: 'Nombre d\'annonces', placeholder: 'Ex : 500', type: 'number', default: '500' },
      { key: 'BUDGET_MIN', label: 'Budget minimum (€)', placeholder: 'Ex : 10', type: 'number', default: '10' },
      { key: 'BUDGET_MAX', label: 'Budget maximum (€)', placeholder: 'Ex : 800', type: 'number', default: '800' },
      { key: 'TOP_BONNES_AFFAIRES', label: 'Top bonnes affaires', placeholder: 'Ex : 30', type: 'number', default: '30' },
      { key: 'TOP_SURPAYEES', label: 'Top annonces surpayées', placeholder: 'Ex : 15', type: 'number', default: '15' },
      { key: 'CRITERES_PRIX', label: 'Critères influençant le prix', placeholder: 'Ex : marque, état, année, garantie, accessoires…', type: 'textarea', default: 'marque, état, année, garantie, accessoires inclus' },
    ],
    template: `Tu es un expert en estimation de prix de produits d'occasion sur Le Bon Coin.

Je te fournis un fichier d'environ [NOMBRE_ANNONCES] annonces de "[TYPE_DE_PRODUIT]".

OBJECTIF : Estimer la valeur réelle de chaque produit et comparer les prix pour identifier les bonnes affaires et les annonces surpayées.

FOURCHETTE DE BUDGET : [BUDGET_MIN] € à [BUDGET_MAX] €

CRITÈRES INFLUENÇANT LE PRIX : [CRITERES_PRIX]

POUR CHAQUE ANNONCE, ESTIME :
- La valeur marché du produit (prix moyen pour un produit équivalent) ;
- Le prix demandé ;
- L'écart en € et en % (positif = bonne affaire, négatif = surpayé) ;
- La juste valeur (prix recommandé d'achat) ;
- Les facteurs qui justifient un prix plus élevé ou plus bas (état, marque, accessoires…) ;
- La qualité du rapport qualité/prix (Excellent / Bon / Moyen / Mauvais).

IDENTIFIE :
- Les annonces dont le prix est bien en dessous de la valeur marché (bonnes affaires) ;
- Les annonces dont le prix est bien au-dessus de la valeur marché (surpayées) ;
- Les annonces au prix juste (marché équilibré) ;
- Les produits dont la valeur est difficile à estimer (rareté, état inconnu) et qui nécessitent plus d'informations.

À LA FIN, CRÉE :
- Top [TOP_BONNES_AFFAIRES] bonnes affaires (prix le plus bas vs valeur, classées par écart décroissant) ;
- Top [TOP_SURPAYEES] annonces surpayées (prix le plus haut vs valeur) ;
- Un récapitulatif du marché : prix moyen, médiane, fourchette de prix par catégorie de produit.

Format : tableau Markdown (Annonce | Prix demandé | Valeur estimée | Écart € | Écart % | Rapport Q/P | Recommandation).`,
  },

  // ──────────────────────────────────────────────────────────────────────
  // 7. SÉLECTION & SHORTLIST PAR CRITÈRES
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'shortlist-criteres',
    title: '📋 Sélection & shortlist par critères',
    category: 'Filtrage',
    description: 'Filtre et classe les annonces selon des critères précis définis par l\'utilisateur.',
    placeholders: [
      { key: 'TYPE_DE_PRODUIT', label: 'Type de produit', placeholder: 'Ex : vélos, instruments de musique, outils…', type: 'text', default: 'produits d\'occasion' },
      { key: 'NOMBRE_ANNONCES', label: 'Nombre d\'annonces', placeholder: 'Ex : 700', type: 'number', default: '700' },
      { key: 'CRITERES_OBLIGATOIRES', label: 'Critères obligatoires', placeholder: 'Ex : état neuf ou très bon, marque reconnue, avec facture…', type: 'textarea', default: 'état neuf ou très bon, marque reconnue, avec facture' },
      { key: 'CRITERES_SOUPHAITES', label: 'Critères souhaités (bonus)', placeholder: 'Ex : garantie, accessoires, emballage d\'origine…', type: 'textarea', default: 'garantie, accessoires, emballage d\'origine' },
      { key: 'BUDGET_MIN', label: 'Budget minimum (€)', placeholder: 'Ex : 20', type: 'number', default: '20' },
      { key: 'BUDGET_MAX', label: 'Budget maximum (€)', placeholder: 'Ex : 500', type: 'number', default: '500' },
      { key: 'NOMBRE_RESULTATS', label: 'Nombre d\'annonces à retenir', placeholder: 'Ex : 40', type: 'number', default: '40' },
      { key: 'MODE_CLASSEMENT', label: 'Mode de classement', placeholder: 'Ex : par prix croissant, par qualité décroissante, par rapport Q/P…', type: 'text', default: 'par rapport qualité/prix décroissant' },
    ],
    template: `Tu es un expert en filtrage et sélection d'annonces sur Le Bon Coin.

Je te fournis un fichier d'environ [NOMBRE_ANNONCES] annonces de "[TYPE_DE_PRODUIT]".

OBJECTIF : Sélectionner et classer les meilleures annonces selon des critères précis.

CRITÈRES OBLIGATOIRES (l'annonce DOIT remplir ces critères) :
[CRITERES_OBLIGATOIRES]

CRITÈRES SOUHAITÉS (bonus, l'annonce gagne en priorité si elle les remplit) :
[CRITERES_SOUPHAITES]

FOURCHETTE DE BUDGET : [BUDGET_MIN] € à [BUDGET_MAX] €

PROCESSUS :
1. FILTRAGE : Élimine les annonces qui ne remplissent pas les critères obligatoires ou hors budget.
2. SCORING : Attribue un score à chaque annonce restante (sur 100) basé sur :
   - Correspondance aux critères obligatoires (50 points) ;
   - Critères souhaités remplis (30 points) ;
   - Rapport qualité/prix (20 points).
3. CLASSEMENT : Trie les annonces par [MODE_CLASSEMENT].

POUR CHAQUE ANNONCE RETENUE, INDIQUE :
- Titre de l'annonce ;
- Prix demandé ;
- Score global /100 ;
- Critères obligatoires remplis (✓/✗ pour chaque) ;
- Critères souhaités remplis ;
- Pourquoi elle est sélectionnée (résumé en une ligne) ;
- Points d'attention (ce qui manque ou pourrait poser problème).

À LA FIN, CRÉE :
- Une shortlist de [NOMBRE_RESULTATS] annonces (classement final) ;
- Un résumé : nombre total d'annonces, nombre filtré, nombre retenu ;
- Les 5 annonces "presque parfaites" (remplissent presque tous les critères, à surveiller).

Format : tableau Markdown classé avec colonnes (Rang | Titre | Prix | Score | Critères ✓ | Recommandation).`,
  },

];

// ─────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────

/**
 * Retourne tous les templates (sans le corps du prompt, pour l'UI).
 * @returns {Array<{id,title,category,description,placeholders}>}
 */
function listTemplates() {
  return TEMPLATES.map((t) => ({
    id: t.id,
    title: t.title,
    category: t.category,
    description: t.description,
    placeholders: t.placeholders,
  }));
}

/**
 * Récupère un template par son id.
 * @param {string} id
 * @returns {object|null}
 */
function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

/**
 * Assemble le prompt final en remplaçant les [PLACEHOLDERS] par les valeurs.
 * Les placeholders non remplis sont remplacés par leur valeur par défaut,
 * ou laissés tels quels si aucune valeur/default n'est fourni.
 * @param {string} templateId
 * @param {Object<string,string>} values - { KEY: 'value', ... }
 * @returns {{ prompt: string, template: object|null, error: string|null }}
 */
function buildPrompt(templateId, values = {}) {
  const tmpl = getTemplate(templateId);
  if (!tmpl) {
    return { prompt: '', template: null, error: `Template introuvable : ${templateId}` };
  }

  let prompt = tmpl.template;

  // Construit le map des valeurs finales (valeur utilisateur OU défaut).
  const finalValues = {};
  for (const ph of tmpl.placeholders) {
    const userVal = values[ph.key];
    const val = (userVal !== undefined && userVal !== null && String(userVal).trim() !== '')
      ? String(userVal).trim()
      : (ph.default !== undefined ? String(ph.default) : `[${ph.key}]`);
    finalValues[ph.key] = val;
  }

  // Remplace tous les [KEY] par la valeur correspondante.
  for (const [key, val] of Object.entries(finalValues)) {
    prompt = prompt.split(`[${key}]`).join(val);
  }

  return { prompt, template: tmpl, error: null };
}

module.exports = { TEMPLATES, listTemplates, getTemplate, buildPrompt };
