'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('../utils/helpers');
const ExcelJS = require('exceljs');

/**
 * Extracteur de description sûr : garantit qu'on n'envoie JAMAIS un objet
 * au writer XLSX/CSV (sinon Excel/CSV écrirait [object Object]).
 * Renvoie TOUJOURS une string (ou '' si absente).
 */
function _descString(ad) {
  if (typeof ad.description === 'string') return ad.description;
  if (ad && typeof ad.description === 'object' && typeof ad.description.originale === 'string') {
    return ad.description.originale;
  }
  return '';
}

function _fmtDate(val) {
  if (!val) return '';
  const d = new Date(val);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

class ExcelExporter {
  /**
   * Liste complète des colonnes XLSX/CSV (mode Défaut). L'ordre est FIXE pour
   * faciliter l'exploitation Python/pandas et la lecture humaine.
   * Chaque colonne décrit :
   *   - header : libellé affiché
   *   - key    : nom de l'attribut dans la colonne `data` ci-dessous
   *   - get    : extracteur (ad, adAnalysis, ma) => valeur ou null
   */
  static DEFAULT_COLUMNS = [
    { header: 'ID', key: 'id', get: (a) => a.id || '' },
    { header: 'Titre', key: 'title', get: (a) => a.title || '' },
    { header: 'Produit Identifié (IA)', key: 'identifiedProduct', get: (a) => (a.adAnalysis && a.adAnalysis.identifiedProduct) || '' },
    { header: 'Prix (€)', key: 'price', get: (a) => a.prix != null ? a.prix : '' },
    { header: 'Ville', key: 'city', get: (a) => a.city || '' },
    { header: 'Code Postal', key: 'zipcode', get: (a) => a.zipcode || '' },
    { header: 'Vendeur', key: 'vendeurNom', get: (a) => a.vendeurNom || '' },
    { header: 'Type Vendeur', key: 'vendeurType', get: (a) => a.vendeurType || '' },
    { header: 'ID Vendeur', key: 'vendeurId', get: (a) => a.vendeurId || '' },
    { header: 'Note Vendeur', key: 'vendeurNote', get: (a, aa, ma) => a.vendeurNote != null ? `${String(a.vendeurNote).replace('.', ',')}/5` : '' },
    { header: 'Nb Avis', key: 'nombreAvis', get: (a) => a.nombreAvis != null ? a.nombreAvis : '' },
    { header: 'URL Profil', key: 'vendeurUrlProfil', get: (a) => a.vendeurUrlProfil || '' },
    { header: 'Ancienneté (jours)', key: 'vendeurAncienneteJours', get: (a) => a.vendeurAncienneteJours != null ? a.vendeurAncienneteJours : '' },
    { header: 'Livraison', key: 'livraison', get: (a) => a.livraison === true ? 'OUI' : (a.livraison === false ? 'NON' : '') },
    { header: 'Main Propre', key: 'mainPropre', get: (a) => a.mainPropre === true ? 'OUI' : (a.mainPropre === false ? 'NON' : '') },
    { header: 'Likes', key: 'likes', get: (a) => a.likes != null ? a.likes : '' },
    { header: 'État', key: 'etat', get: (a) => a.etat || '' },
    { header: 'Nb Photos', key: 'photosCount', get: (a) => a.photosCount != null ? a.photosCount : '' },
    { header: 'Description', key: 'description', get: (a) => _descString(a) },
    { header: 'Verdict IA Marché', key: 'verdictLabel', get: (a, aa, ma) => (ma && ma.verdictLabel) || '' },
    { header: 'Valeur Marché (€)', key: 'marketValue', get: (a, aa, ma) => (ma && ma.realValue != null) ? `${ma.realValue} €` : '' },
    { header: 'Fourchette Marché (€)', key: 'marketRange', get: (a, aa, ma) => (ma && ma.valueRangeLow != null && ma.valueRangeHigh != null) ? `${ma.valueRangeLow} € - ${ma.valueRangeHigh} €` : '' },
    { header: 'Bénéfice/Perte (€)', key: 'deltaEur', get: (a, aa, ma) => (ma && ma.deltaEur != null) ? `${ma.deltaEur > 0 ? '+' : ''}${ma.deltaEur} €` : '' },
    { header: 'Résumé IA Analyse', key: 'adSummary', get: (a, aa) => (aa && aa.summary) || '' },
    { header: 'Justification IA Marché', key: 'maRationale', get: (a, aa, ma) => (ma && ma.rationale) || '' },
    { header: 'Date Publication', key: 'datePublication', get: (a) => _fmtDate(a.datePublication) },
    { header: 'Date Modification', key: 'dateModification', get: (a) => _fmtDate(a.dateModification) },
    { header: 'Date Scraping', key: 'dateScraping', get: (a) => _fmtDate(a.dateScraping) },
    { header: 'Lien Leboncoin', key: 'url', get: (a) => a.url || '' },
  ];

  /**
   * Filtre les colonnes en fonction des clés sélectionnées (mode Personnalisé).
   * Si `fields` est null/undefined → toutes les colonnes (mode Défaut).
   * `fields` est une liste de clés (correspondant aux clés du module
   * services/exporting/exportFields.js) mappées vers les colonnes XLSX/CSV.
   */
  static _selectColumns(fields) {
    if (!Array.isArray(fields) || fields.length === 0) return ExcelExporter.DEFAULT_COLUMNS;
    // Mapping des clés exportFields → clés de colonnes XLSX/CSV.
    // Plusieurs clés de l'exporteur ne sont pas des colonnes dédiées (par ex.
    // `vendeurAnciennete` → 'vendeurAncienneteJours') — on accepte les deux.
    const KEY_TO_COL = {
      id: 'id',
      title: 'title',
      url: 'url',
      produitIdentifie: 'identifiedProduct',
      resumeIA: 'adSummary',
      prix: 'price',
      ville: 'city',
      codePostal: 'zipcode',
      vendeurNom: 'vendeurNom',
      vendeurType: 'vendeurType',
      vendeurId: 'vendeurId',
      vendeurNote: 'vendeurNote',
      vendeurNbAvis: 'nombreAvis',
      vendeurUrlProfil: 'vendeurUrlProfil',
      vendeurAnciennete: 'vendeurAncienneteJours',
      livraison: 'livraison',
      mainPropre: 'mainPropre',
      likes: 'likes',
      datePublication: 'datePublication',
      dateModification: 'dateModification',
      dateScraping: 'dateScraping',
      etat: 'etat',
      photosCount: 'photosCount',
      description: 'description',
      verdict: 'verdictLabel',
      valeurMarche: 'marketValue',
      fourchette: 'marketRange',
      benefice: 'deltaEur',
      justification: 'maRationale',
    };
    const selectedKeys = new Set();
    for (const f of fields) {
      const col = KEY_TO_COL[f];
      if (col) selectedKeys.add(col);
    }
    // Si rien ne matche (sécurité) → on garde les essentiels.
    if (selectedKeys.size === 0) {
      return ExcelExporter.DEFAULT_COLUMNS.filter((c) => ['id', 'title', 'url', 'price'].includes(c.key));
    }
    return ExcelExporter.DEFAULT_COLUMNS.filter((c) => selectedKeys.has(c.key));
  }

  static async exportToXlsx(ads, outputPath, options = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Leboncoin Scraper Pro';

    const sheet = workbook.addWorksheet('Annonces Leboncoin', {
      views: [{ showGridLines: true }],
    });

    const columns = ExcelExporter._selectColumns(options.fields);
    sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: Math.max(10, c.header.length + 4) }));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: '0F172A' },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 25;

    ads.forEach((ad) => {
      const ma = ad.marketAnalysis || {};
      const adAnalysis = ad.adAnalysis || {};

      const rowData = {};
      for (const c of columns) {
        let v = c.get(ad, adAnalysis, ma);
        if (c.key === 'url' && v) v = { text: "Ouvrir l'annonce", hyperlink: v };
        rowData[c.key] = v == null ? '' : v;
      }
      const row = sheet.addRow(rowData);

      row.alignment = { vertical: 'middle', wrapText: true };

      const verdictCell = row.getCell('verdictLabel');
      if (ma.verdictLabel === 'Très bonne affaire' || ma.verdictLabel === 'Bonne affaire') {
        verdictCell.font = { color: { argb: '15803D' }, bold: true };
      } else if (ma.verdictLabel === 'Trop cher' || ma.verdictLabel === 'Très cher') {
        verdictCell.font = { color: { argb: 'B91C1C' }, bold: true };
      }

      const urlCell = row.getCell('url');
      if (urlCell) urlCell.font = { color: { argb: '0284C7' }, underline: true };
    });

    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: sheet.rowCount, column: sheet.columnCount },
    };

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    await workbook.xlsx.writeFile(outputPath);

    return outputPath;
  }

  static _csvField(value, sep = ';') {
    const s = value == null ? '' : String(value);
    if (s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  static async exportToCsv(ads, outputPath, options = {}) {
    const sep = ';';
    const columns = ExcelExporter._selectColumns(options.fields);
    const headers = columns.map((c) => c.header);

    const rows = [headers.map((h) => this._csvField(h, sep)).join(sep)];

    for (const ad of ads) {
      const ma = ad.marketAnalysis || {};
      const adAnalysis = ad.adAnalysis || {};
      const row = columns.map((c) => {
        let v = c.get(ad, adAnalysis, ma);
        if (c.key === 'price' && typeof v === 'number') v = String(v).replace('.', ',');
        if (v == null) return '';
        return v;
      });
      rows.push(row.map((v) => this._csvField(v, sep)).join(sep));
    }

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(outputPath, '\uFEFF' + rows.join('\r\n'));
    return outputPath;
  }
}

module.exports = { ExcelExporter };
