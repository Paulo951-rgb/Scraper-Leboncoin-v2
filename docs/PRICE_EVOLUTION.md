# Évolution des prix — documentation technique

Fonctionnalité **déterministe** (aucune IA) qui transforme les annonces
collectées par Vendra en une base historique exploitable, afin de suivre
l'évolution des prix de produits identiques ou suffisamment similaires — même
lorsque les vendeurs emploient des formulations différentes.

> Exemple : reconnaître « AMD Ryzen 5 9600X neuf », « Ryzen 5 9600X »,
> « Processeur AMD R5-9600X » et « Ryzen 5 9600 X vendu seul » comme le **même
> modèle**, tout en refusant de mélanger 9600 et 9600X, un processeur seul et un
> lot, un produit fonctionnel et un produit hors service.

---

## 1. Vue d'ensemble (5 couches)

| Couche | Module | Responsabilité |
|---|---|---|
| A — Collecte | scraper existant (`harCapturer` + pipeline) | Fournit les annonces ; **aucune** collecte supplémentaire n'est déclenchée. |
| B — Normalisation & identification | `history/normalizeText.js`, `history/lexicons.js`, `history/featureExtractor.js`, `history/productIdentity.js`, `history/productRegistry.js` | Nettoie le texte, extrait les caractéristiques, décide du rapprochement. Indépendant de l'UI. |
| C — Persistance | `history/priceHistoryDb.js` | Stocke annonces, produits, liens, observations, alias, corrections (SQLite). |
| D — Statistiques | `history/priceStats.js`, `history/priceRules.js` | Prix de référence, séries temporelles, qualité, règles d'exclusion. |
| E — Interface | `renderer/priceEvolutionModule.js` + section `tab-price-evolution` | Recherche, fiche produit, graphiques, file de rapprochement, corrections. |

Orchestration : `history/priceHistoryEngine.js` (moteur) et
`history/priceHistoryService.js` (façade, singleton côté main).

---

## 2. Modèle de données (SQLite)

Base : `<BASE_OUT_DIR>/price-history.sqlite` (à côté de `jobs/`, `logs/`,
`global-session.json`). Moteur : **`node:sqlite`** (DatabaseSync), disponible
nativement dans le Node.js embarqué par Electron 44 (Node 24). Aucune dépendance
externe, **aucun module natif à recompiler** (`npmRebuild:false` reste valable).

PRAGMA : `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`,
`busy_timeout=4000`.

### Tables

| Table | Rôle | Clés |
|---|---|---|
| `ads` | Annonces sources (une ligne par annonce, jamais dupliquée) | `source_id` (UNIQUE), `url_hash` (UNIQUE) |
| `products` | Produits canoniques | `canonical_key` (UNIQUE) |
| `ad_product_links` | Association annonce ↔ produit + décision | `ad_id` (UNIQUE) |
| `observations` | Observations datées (une par changement pertinent) | `ad_id` |
| `aliases` | Alias observés/manuels par produit | `(product_id, normalized)` |
| `ad_corrections` | Journal des corrections manuelles | `ad_id` |
| `product_aliases_index` | Index global alias → produit (génération de candidats) | `normalized` |
| `stats_cache` | Agrégats cachés (reconstructibles) | `cache_key` |
| `schema_migrations` | Versions de schéma appliquées | `version` |

### Identifiant d'annonce — stratégie de repli

1. **Identifiant source** (`source_id`) prioritaire quand il est présent.
2. Sinon **empreinte SHA-256 de l'URL** (`url_hash`).
3. Si **ni identifiant ni URL** : l'annonce est **refusée** (comptée dans
   `summary.errors`). On n'utilise **jamais** le titre comme clé (trop instable :
   fusionnerait deux annonces distinctes aux titres proches).

### Migrations

- Versionnées (`schema_migrations`), appliquées **dans l'ordre**, chacune dans
  une **transaction**.
- **Idempotentes** (`CREATE ... IF NOT EXISTS`).
- **Aucune donnée supprimée** : les migrations n'ajoutent que des tables/index.

---

## 3. Algorithme d'identification déterministe

### 3.1 Normalisation (`normalizeText.js`)

- Replie la casse, les accents (NFD + suppression des diacritiques) et les
  ligatures (`œ`→`oe`).
- Ramène tirets, ponctuation et séparateurs à des espaces.
- **Ne supprime JAMAIS** les chiffres, suffixes ou unités : `9600X ≠ 9600`,
  `8 Go ≠ 16 Go`.
- Deux vues : `normalizeText` (tokens séparés par espaces) et
  `normalizeReference` (alphanumérique majuscule, séparateurs retirés).
- **Reproductible** : même entrée → même sortie. Les données originales ne sont
  jamais modifiées.

### 3.2 Extraction de caractéristiques (`featureExtractor.js`)

Descripteurs **déclaratifs** (`lexicons.js`) : familles de produits, marques,
indices d'état, d'offre, unités. On étend le moteur en ajoutant une entrée, sans
toucher à la logique.

Extrait : marque, famille, **référence principale** (jeton alphanumérique le
plus discriminant, étendu par un suffixe de modèle adjacent : `3060` + `ti` →
`3060TI`), unités (capacité, puissance, fréquence…), état (`new` / `used` /
`for_parts`), type d'offre (`single` / `lot` / `with_accessories` /
`accessory_only` / `part` / `quantity`), quantité, contradictions titre/description.

### 3.3 Relation de référence (`compareReferences`)

| Relation | Exemple | Conséquence |
|---|---|---|
| `exact` | `9600X` ≡ `9600X` | Même modèle → peut confirmer |
| `partial` | `R59600X` ≡ `9600X` | Même modèle probable → peut confirmer |
| `conflict` | `9600` vs `9600X`, `3060` vs `3060TI` | **Modèles différents** → jamais fusionnés |
| `none` | `9600X` vs `5800X` | Aucune relation |

### 3.4 Score et décision (`productIdentity.js`)

Score pondéré (0..100), **purement interne** (aucune interprétation
probabiliste) : référence (50/40), unités (12), famille (10), marque (8),
similarité de titre (12), de description (8).

**Règles de contradiction PRIORITAIRES** — un score textuel élevé ne peut
**jamais** les annuler :
- `reference_model_variant` (9600 vs 9600X),
- `reference_incompatible`, `family_incompatible`, `units_incompatible`,
- `offer_type_incompatible` (lot, accessoire, pièce détachée),
- `condition_not_functional` (hors service / à réparer),
- `ad_*` (contradictions internes titre/description).

Seuils (`DEFAULT_THRESHOLDS`, surchargeables) : `CONFIRM_MIN=70`,
`REFERENCE_EXACT_FLOOR=55`, `REJECT_MAX=25`, `AMBIGUITY_MARGIN=8`.

**Trois niveaux de décision** : `confirmed` (association auto), `uncertain`
(file manuelle), `rejected` (contradiction majeure). S'y ajoute une
**recommandation** d'action : `link`, `new` (identité inédite), `pending`,
`reject`.

- Une **ambiguïté** entre deux candidats non rejetés empêche la confirmation
  automatique (marge < 8) → file manuelle.
- Un **état non fonctionnel** associe l'annonce au produit (fiche) mais l'exclut
  de la série de prix (segment « hors service »).
- Un produit naît **provisoire** (`status='provisional'`) ; il n'est confirmé que
  par une décision ou une correction.

### 3.5 Génération de candidats (`productRegistry.js`)

Index par référence normalisée + par famille. On ne compare **jamais**
naïvement l'annonce à tous les produits : l'index restreint l'ensemble
(référence exacte → référence partielle → famille+marque → famille seule).
L'index est **construit une fois par lot** puis maintenu (performance).

---

## 4. Segmentation et qualité des prix

- **État** : `new` / `used` / `for_parts` / inconnu. Un prix hors service est
  **exclu de la série principale** (non comparable) et affiché dans un segment
  dédié.
- **Type d'offre** : produit seul, lot, avec accessoires, accessoire seul,
  pièce détachée, vente en quantité. Un lot **n'est jamais** traité comme un
  produit seul au même prix ; le prix n'est **jamais** divisé par le nombre
  d'éléments.
- **Prix** (`priceRules.js`) : absence, zéro, négatif, non numérique, symbolique,
  aberrant, devise. Chaque exclusion porte un **motif** (`missing`, `zero`,
  `negative`, `non_numeric`, `absurd`). Un prix atypique est **signalé** (IQR),
  **jamais supprimé** automatiquement.
- **Coûts supplémentaires** : seule la **disponibilité** de la livraison est
  déduite (`deliveryType`). **Aucun montant de frais n'est inventé** et une
  estimation n'est jamais présentée comme un prix observé.

---

## 5. Statistiques (`priceStats.js`)

- Moyenne = somme / n ; médiane = valeur centrale (paire : moyenne des deux) ;
  dispersion = écart-type d'échantillon (n−1) et IQR.
- Variation absolue = finale − initiale ; variation relative (%) = (f − i)/i × 100,
  **calculée uniquement si i ≠ 0**.
- **Aucun prix valide → état « données insuffisantes »** (`sufficient:false`,
  `reason:'no_valid_prices'`), **jamais 0**.
- **Anti-biais** : une annonce observée N fois ne compte **qu'une fois** par
  période (dernière observation retenue). On distingue annonces distinctes,
  observations, produits.
- **Séries** : aucune période sans observation n'est **fabriquée** (trou, pas
  zéro). Périodes : jour / semaine / mois ; fenêtres : 7 / 30 / 90 / 365 jours /
  tout l'historique.
- **Qualité** : volume d'annonces distinctes, fraîcheur, ratio de prix exclus,
  dispersion, version de méthode. La fiabilité (`confidence`) est fondée sur le
  **volume**, pas sur une prétendue probabilité.
- **Recalculs** : le cache (`stats_cache`) est **invalidé** à chaque ingestion,
  correction ou recalcul. Tous les agrégats sont reconstructibles depuis
  `observations` + `ad_product_links`.

---

## 6. Historique et collectes futures

À la **première** collecte d'une annonce : créer/retrouver l'annonce, enregistrer
l'observation initiale, identifier le produit (identité provisoire au besoin).

À une **nouvelle** collecte : retrouver l'annonce (jamais dupliquée), comparer à
la dernière observation, enregistrer **toute évolution de prix**, mettre à jour
l'identité si justifié.

- Une observation **identique** n'est **pas** dupliquée : seule la date de
  dernière vue est actualisée (`touchAd`).
- Une **absence** lors d'une collecte n'est **jamais** une preuve de vente.
- Les observations historiques ne sont **jamais** supprimées parce que l'annonce
  n'est plus visible.

### Amorçage depuis les sessions existantes

`history:bootstrap` (bouton « Importer les sessions existantes ») intègre les
jobs **déjà présents** sur le disque, sans relancer de collecte. Chaque annonce
est datée par la **date réelle du job** (dérivée de son identifiant `job-<ISO>`),
**jamais** par une date inventée. Idempotent.

---

## 7. Sécurité

- Le **renderer n'accède jamais** à la base : aucun canal SQL générique, aucun
  `require('node:sqlite')` côté renderer.
- Toutes les options IPC sont **assainies** (`sanitizeHistoryOpts` : bornes de
  pagination, liste blanche de granularité) et les actions de correction
  limitées à une **liste blanche** (`confirm`, `reject`, `move`, `create`).
- **Requêtes préparées uniquement** (aucune concaténation SQL de valeurs).
- Les textes d'annonces sont **échappés** (`escapeHtml`) avant tout rendu :
  jamais traités comme du HTML fiable.
- L'ingestion est **isolée** du job de scraping : une erreur du moteur
  historique n'échoue jamais la collecte (try/catch + journalisation).

---

## 8. Intégration au scraper

Après une collecte **réussie**, `ipcHandlers` ingère les annonces lues depuis
`annonces.json` (validé par checksum SHA-256) dans la base historique. Aucune
requête supplémentaire n'est adressée à la plateforme. L'ingestion est
transactionnelle (tout le lot ou rien) et chaque annonce est isolée.

---

## 9. Limites connues

- **Pas de résolution DNS** dans la génération de candidats (non pertinente ici,
  aucun accès réseau).
- La reconnaissance dépend de la **qualité des titres/descriptions** collectés :
  une annonce très vague reste non identifiée (par conception).
- Les seuils sont **calibrés sur des cas de test** documentés ; ils ne
  constituent pas des probabilités validées statistiquement.
- Un prix hors service est exclu de la série principale mais reste consultable
  dans un segment dédié (jamais supprimé).
- `node:sqlite` nécessite Node ≥ 23.4 (Electron 44 = Node 24) : sur un runtime
  plus ancien, la fonctionnalité se **désactive proprement** (le reste de Vendra
  fonctionne normalement).
