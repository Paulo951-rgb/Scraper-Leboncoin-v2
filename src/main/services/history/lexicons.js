'use strict';

/**
 * lexicons — descripteurs EXTENSIBLES utilisés par le moteur d'identification.
 *
 * Ce module ne prétend PAS cataloguer tous les produits du monde : il fournit
 * des descripteurs GÉNÉRIQUES et paramétrables (marques connues, familles de
 * produits, indicateurs d'état, d'offre, de quantité, d'unités). Le moteur
 * fonctionne sans ces listes : elles n'augmentent que la précision (marque,
 * famille, indices d'offre). Un produit inconnu est traité comme « référence
 * inédite » et reste exploitable.
 *
 * Chaque descripteur est une donnée déclarative : on étend le moteur en
 * ajoutant une entrée, sans toucher à la logique.
 */

// ─── Familles de produits ────────────────────────────────────────────────────
// Chaque famille porte des « indices » (mots) et des « attributs attendus »
// (types d'unités pertinents). L'extraction reste générique : on ne code pas
// de règles par famille.
const PRODUCT_FAMILIES = [
  { id: 'cpu', label: 'Processeur', hints: ['processeur', 'cpu', 'ryzen', 'core i3', 'core i5', 'core i7', 'core i9', 'threadripper', 'xeon', 'pentium', 'celeron', 'athlon'] },
  { id: 'gpu', label: 'Carte graphique', hints: ['carte graphique', 'gpu', 'geforce', 'radeon rx', 'rtx', 'gtx', 'quadro', 'rx ', 'arc a'] },
  { id: 'motherboard', label: 'Carte mère', hints: ['carte mere', 'motherboard', 'chipset', 'socket', 'am4', 'am5', 'lga'] },
  { id: 'ram', label: 'Mémoire RAM', hints: ['ram', 'memoire', 'dimm', 'ddr3', 'ddr4', 'ddr5', 'sodimm'] },
  { id: 'storage', label: 'Stockage', hints: ['ssd', 'disque dur', 'hdd', 'nvme', 'm.2', 'm2 pcie', 'sata'] },
  { id: 'psu', label: 'Alimentation', hints: ['alimentation', 'psu', 'watt', 'gold', 'platinum', 'bronze'] },
  { id: 'case', label: 'Boîtier', hints: ['boitier', 'case', 'tour', 'midi tower', 'mini itx'] },
  { id: 'cooler', label: 'Refroidissement', hints: ['ventirad', 'watercooling', 'refroidissement', 'aio', 'dissipateur', 'cooler'] },
  { id: 'laptop', label: 'Ordinateur portable', hints: ['pc portable', 'ordinateur portable', 'laptop', 'notebook', 'ultrabook', 'macbook', 'chromebook'] },
  { id: 'desktop', label: 'Ordinateur fixe', hints: ['pc fixe', 'ordinateur fixe', 'desktop', 'unite centrale', 'tour pc'] },
  { id: 'monitor', label: 'Écran', hints: ['ecran', 'moniteur', 'monitor', 'oled', 'ips', '144hz', '165hz'] },
  { id: 'phone', label: 'Téléphone', hints: ['smartphone', 'telephone', 'iphone', 'galaxy', 'pixel', 'xiaomi', 'redmi', 'oneplus', 'huawei', 'honor', 'oppo'] },
  { id: 'tablet', label: 'Tablette', hints: ['tablette', 'ipad', 'tab s', 'galaxy tab'] },
  { id: 'console', label: 'Console', hints: ['playstation', 'ps4', 'ps5', 'xbox', 'nintendo', 'switch', 'steam deck'] },
  { id: 'peripheral', label: 'Périphérique', hints: ['souris', 'clavier', 'casque', 'manette', 'webcam', 'enceinte'] },
  { id: 'camera', label: 'Photo / Vidéo', hints: ['appareil photo', 'reflex', 'objectif', 'boitier nu', 'hybride'] },
  { id: 'appliance', label: 'Électroménager', hints: ['lave linge', 'lave-vaisselle', 'refrigerateur', 'four', 'aspirateur', 'robot cuiseur'] },
  { id: 'bike', label: 'Vélo / Mobilité', hints: ['velo', 'vtt', 'vae', 'trottinette', 'scooter', 'trottinette electrique'] },
  { id: 'furniture', label: 'Meuble', hints: ['canape', 'table', 'chaise', 'armoire', 'commode', 'bureau'] },
];

// ─── Marques connues ─────────────────────────────────────────────────────────
// Sert à extraire une marque explicite. Liste NON exhaustive : l'absence d'une
// marque ne bloque jamais l'identification (elle est simplement inconnue).
const KNOWN_BRANDS = [
  'amd', 'intel', 'nvidia', 'asus', 'msi', 'gigabyte', 'asrock', 'evga', 'zotac',
  'sapphire', 'xfx', 'powercolor', 'palit', 'gainward', 'inno3d', 'pny',
  'corsair', 'g.skill', 'gskill', 'kingston', 'crucial', 'samsung', 'micron',
  'sandisk', 'seagate', 'western digital', 'wd', 'toshiba', 'lexar',
  'seasonic', 'be quiet', 'cooler master', 'thermaltake', 'fractal', 'nzxt',
  'noctua', 'arctic', 'deepcool', 'lian li', 'phanteks', 'antec',
  'apple', 'lenovo', 'dell', 'hp', 'acer', 'microsoft', 'xiaomi', 'huawei',
  'honor', 'oppo', 'oneplus', 'google', 'sony', 'lg', 'philips', 'benq',
  'aoc', 'iiyama', 'viewsonic', 'logitech', 'razer', 'steelseries', 'hyperx',
  'canon', 'nikon', 'fujifilm', 'panasonic', 'gopro', 'dji', 'bose', 'jbl',
  'sennheiser', 'audiotechnica', 'audio technica', 'dyson', 'bosch', 'miele',
  'whirlpool', 'siemens', 'electrolux', 'decathlon', 'btwin', 'specialized',
  'trek', 'cube', 'cannondale', 'giant', 'ikea',
];

// ─── Indicateurs d'ÉTAT ──────────────────────────────────────────────────────
// État produit déduit du texte. On ne devine JAMAIS : absence d'indice → null.
const CONDITION_HINTS = {
  new: ['neuf', 'neuve', 'jamais servi', 'jamais utilise', 'sous blister', 'scelle', 'sealed', 'new', 'sous emballage', 'dans son carton', 'non deballe'],
  for_parts: ['pour piece', 'pour pieces', 'a reparer', 'hs', 'hors service', 'ne fonctionne pas', 'ne fonctionne plus', 'en panne', 'non fonctionnel', 'defectueux', 'casse', 'bloque', 'mort', 'hs.'],
  used: ['occasion', 'tres bon etat', 'bon etat', 'etat correct', 'utilise', 'usage', 'd occasion', 'reconditionne', 'refurbished'],
};

// ─── Indicateurs de TYPE D'OFFRE ─────────────────────────────────────────────
const OFFER_HINTS = {
  lot: ['lot de', 'lot ', ' x2', ' x3', ' x4', ' x5', 'paire', 'les deux', 'pack de', 'set de', 'bundle', 'ensemble de', 'plusieurs', 'en lot', 'stock de'],
  accessory: ['ventirad', 'radiateur', 'pate thermique', 'adaptateur', 'cable', 'coque', 'etui', 'chargeur seul', 'support', 'bracket', 'socle', 'carte mere seule', 'backplate'],
  accessory_bundle: ['avec ventirad', 'avec radiateur', 'avec carte mere', 'avec cm', 'avec alimentation', 'avec boitier', 'avec accessoires', 'livre avec', 'complet avec', 'vendu avec', 'avec facture', 'avec garantie'],
  parts: ['piece detachee', 'piece detachees', 'pieces', 'pour piece', 'spare part'],
  quantity: ['x2', 'x3', 'x4', 'x5', 'x10', 'quantite', 'les 2', 'par lot de'],
};

// ─── Indicateurs d'UNITÉS / CAPACITÉS ────────────────────────────────────────
// Chaque unité est décrite par un motif (regex) et un normaliseur. On ne les
// fusionne pas : 8 Go et 16 Go restent des attributs distincts.
const UNIT_PATTERNS = [
  { key: 'capacity_gb', re: /\b(\d{1,4})\s?(go|gb|giga(?:octets?)?)\b/, unit: 'GB' },
  { key: 'capacity_tb', re: /\b(\d{1,3})\s?(to|tb|tera(?:octets?)?)\b/, unit: 'TB' },
  { key: 'capacity_mb', re: /\b(\d{2,6})\s?(mo|mb|mega(?:octets?)?)\b/, unit: 'MB' },
  { key: 'power_w', re: /\b(\d{2,4})\s?(w|watts?)\b/, unit: 'W' },
  { key: 'size_inch', re: /\b(\d{2}(?:[.,]\d)?)\s?("|pouces?|inch(?:es)?)\b/, unit: 'in' },
  { key: 'frequency_ghz', re: /\b(\d(?:[.,]\d{1,2})?)\s?(ghz|ghz)\b/, unit: 'GHz' },
  { key: 'frequency_mhz', re: /\b(\d{3,4})\s?(mhz)\b/, unit: 'MHz' },
  { key: 'cores', re: /\b(\d{1,3})\s?(coeurs?|cores?)\b/, unit: 'cores' },
  { key: 'threads', re: /\b(\d{1,3})\s?(threads?|fils)\b/, unit: 'threads' },
  { key: 'speed_mhz', re: /\b(\d{4})\s?mhz\b/, unit: 'MHz' },
];

// ─── Indicateurs de CONTRADICTION (états incompatibles) ──────────────────────
// Deux états de cette liste ne peuvent pas coexister sur une même annonce sans
// signaler une incohérence titre/description (ex. « neuf » + « hors service »).
const INCOMPATIBLE_CONDITIONS = [
  ['new', 'for_parts'],
];

// ─── Mots vides (stopwords FR/EN) ────────────────────────────────────────────
// Utilisés par la similarité textuelle pour ne pas gonfler un score sur des
// mots de liaison. Les chiffres/références ne sont JAMAIS retirés.
const STOPWORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'au', 'aux', 'et', 'ou',
  'en', 'pour', 'avec', 'sans', 'sur', 'dans', 'par', 'a', 'd', 'l', 'the',
  'of', 'and', 'for', 'with', 'very', 'tres', 'bon', 'etat', 'vendu', 'vend',
  'seul', 'seule', 'prix', 'occasion', 'neuf', 'neuve', 'comme', 'plus', 'tout',
]);

module.exports = {
  PRODUCT_FAMILIES,
  KNOWN_BRANDS,
  CONDITION_HINTS,
  OFFER_HINTS,
  UNIT_PATTERNS,
  INCOMPATIBLE_CONDITIONS,
  STOPWORDS,
};
