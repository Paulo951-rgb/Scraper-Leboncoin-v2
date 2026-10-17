'use strict';

const { ALL_FIELD_KEYS, ensureEssentialFields } = require('./exportFields');

// Profil Défaut : champs essentiels pour un scraping rapide et léger.
// Les URL de photos sont incluses : l'explorateur (vignettes + galerie) en a
// besoin quel que soit le profil — les images ne sont PAS un champ optionnel.
const DEFAULT_PROFILE_FIELDS = [
  'id', 'title', 'url', 'prix',
  'ville', 'codePostal',
  'deliveryType',
  'datePublication', 'dateScraping',
  'vendeurNom', 'vendeurType',
  'photosCount', 'photosUrls',
  'description',
];

// Profil Maximum : toutes les données disponibles
const MAXIMUM_PROFILE_FIELDS = [...ALL_FIELD_KEYS];

// Profil Personnalisé : choisi par l'utilisateur
// Stocké en localStorage côté renderer, transmis au main process

const PROFILES = {
  default: {
    id: 'default',
    label: 'Défaut',
    description: 'Récupération des données essentielles pour un scraping rapide et léger.',
    fields: DEFAULT_PROFILE_FIELDS,
  },
  maximum: {
    id: 'maximum',
    label: 'Maximum',
    description: 'Récupération de toutes les données disponibles techniquement.',
    fields: MAXIMUM_PROFILE_FIELDS,
  },
  custom: {
    id: 'custom',
    label: 'Personnalisé',
    description: 'Choisissez exactement les champs à récupérer.',
    fields: null, // Défini par l'utilisateur
  },
};

function getProfileFields(profileId, customFields) {
  if (profileId === 'custom') {
    if (!customFields || !Array.isArray(customFields) || customFields.length === 0) {
      return DEFAULT_PROFILE_FIELDS;
    }
    // Filtre les clés inconnues puis garantit les champs techniques essentiels
    // (URLs des photos) : l'explorateur doit pouvoir afficher les images même
    // si l'utilisateur n'a pas coché la catégorie « Photos ».
    return ensureEssentialFields(customFields.filter((k) => ALL_FIELD_KEYS.includes(k)));
  }
  return PROFILES[profileId]?.fields || DEFAULT_PROFILE_FIELDS;
}

function getProfileLabel(profileId) {
  return PROFILES[profileId]?.label || 'Défaut';
}

module.exports = {
  PROFILES,
  DEFAULT_PROFILE_FIELDS,
  MAXIMUM_PROFILE_FIELDS,
  getProfileFields,
  getProfileLabel,
};
