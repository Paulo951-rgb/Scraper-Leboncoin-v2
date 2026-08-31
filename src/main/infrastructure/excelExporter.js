'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('../utils/helpers');
const ExcelJS = require('exceljs');

class ExcelExporter {
  static async exportToXlsx(ads, outputPath) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Leboncoin Scraper Pro';

    const sheet = workbook.addWorksheet('Annonces Leboncoin', {
      views: [{ showGridLines: true }],
    });

    sheet.columns = [
      { header: 'ID', key: 'id', width: 14 },
      { header: 'Titre de l\'annonce', key: 'title', width: 35 },
      { header: 'Produit Identifié (IA)', key: 'identifiedName', width: 30 },
      { header: 'Prix Demande (€)', key: 'price', width: 12 },
      { header: 'Prix Original (€)', key: 'priceOriginal', width: 12 },
      { header: 'Négociable', key: 'negociable', width: 11 },
      { header: 'Catégorie', key: 'category', width: 18 },
      { header: 'Sous-catégorie', key: 'subCategory', width: 14 },
      { header: 'Ville', key: 'city', width: 16 },
      { header: 'Code Postal', key: 'zipcode', width: 10 },
      { header: 'Département', key: 'department', width: 10 },
      { header: 'Vendeur', key: 'seller', width: 16 },
      { header: 'Type Vendeur', key: 'sellerType', width: 12 },
      { header: 'Note Vendeur', key: 'sellerRating', width: 14 },
      { header: 'Nb Avis Vendeur', key: 'sellerRatingCount', width: 11 },
      { header: 'Livraison', key: 'shipping', width: 10 },
      { header: 'Main Propre', key: 'handDelivery', width: 10 },
      { header: 'Transporteur', key: 'deliveryLabel', width: 16 },
      { header: 'Likes', key: 'likes', width: 8 },
      { header: 'Vues', key: 'vues', width: 10 },
      { header: 'Marque', key: 'brand', width: 14 },
      { header: 'Modèle', key: 'model', width: 16 },
      { header: 'État', key: 'condition', width: 14 },
      { header: 'Nb Photos', key: 'photoCount', width: 9 },
      { header: 'Verdict IA Marché', key: 'verdictLabel', width: 20 },
      { header: 'Valeur Marché (€)', key: 'marketValue', width: 14 },
      { header: 'Fourchette Marché (€)', key: 'marketRange', width: 20 },
      { header: 'Bénéfice/Perte (€)', key: 'deltaEur', width: 14 },
      { header: 'Résumé IA Analyse', key: 'adSummary', width: 40 },
      { header: 'Justification IA Marché', key: 'maRationale', width: 40 },
      { header: 'Date Publication', key: 'datePublication', width: 20 },
      { header: 'Date Scraping', key: 'dateScraping', width: 20 },
      { header: 'Statut Annonce', key: 'adStatus', width: 12 },
      { header: 'Statut Scraping', key: 'scrapingStatus', width: 12 },
      { header: 'Lien Leboncoin', key: 'url', width: 30 },
    ];

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

      const livraison = ad.transaction?.livraison ?? ad.shipping;
      const mainPropre = ad.transaction?.mainPropre ?? ad.handDelivery;
      const transporteur = ad.transaction?.transporteur ?? ad.deliveryLabel;
      const livraisonText = livraison === true ? 'OUI' : (livraison === false ? 'NON' : 'null');
      const mainPropreText = mainPropre === true ? 'OUI' : (mainPropre === false ? 'NON' : 'null');

      // Note vendeur formatée (ex: "4,8/5 (27 avis)") depuis le champ structuré
      // ou legacy. Toujours null (string vide) si non disponible — JAMAIS '-'.
      let ratingText = '';
      const note = ad.vendeur?.note ?? ad.sellerRating;
      const nbAvis = ad.vendeur?.nombreAvis ?? ad.sellerRatingCount;
      if (note != null) {
        ratingText = `${String(note).replace('.', ',')}/5`;
        if (nbAvis != null) ratingText += ` (${nbAvis} avis)`;
      }

      const fmtDate = (val) => {
        if (!val) return '';
        const d = new Date(val);
        if (!Number.isFinite(d.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };

      const negociable = ad.prix?.negociable;
      const negociableText = negociable === true ? 'OUI' : (negociable === false ? 'NON' : '');
      const brand = ad.produit?.brand ?? '';
      const modelField = ad.produit?.model ?? '';
      const conditionField = ad.produit?.condition ?? ad.detection?.etatInferreLabel ?? '';
      const photoCount = ad.photos?.count ?? (Array.isArray(ad.images) ? ad.images.length : 0);
      const typeVendeur = ad.vendeur?.type ?? (ad.isPro ? 'pro' : 'particulier');
      const subCategory = ad.produit?.type ?? '';

      const row = sheet.addRow({
        id: ad.id || '',
        title: ad.title || '',
        identifiedName: adAnalysis.identifiedProduct || '',
        price: typeof ad.price === 'number' ? ad.price : parseFloat(ad.price) || 0,
        priceOriginal: ad.prix?.original ?? '',
        negociable: negociableText,
        category: ad.category || '',
        subCategory,
        city: ad.city || '',
        zipcode: ad.zipcode || '',
        department: ad.localisation?.departement || '',
        seller: ad.seller || '',
        sellerType: typeVendeur,
        sellerRating: ratingText,
        sellerRatingCount: nbAvis ?? '',
        shipping: livraisonText,
        handDelivery: mainPropreText,
        deliveryLabel: transporteur || '',
        likes: ad.statistiques?.likes ?? '',
        vues: ad.statistiques?.vues ?? '',
        brand,
        model: modelField,
        condition: conditionField,
        photoCount,
        verdictLabel: ma.verdictLabel || 'Non analysé',
        marketValue: ma.realValue != null ? `${ma.realValue} €` : '',
        marketRange: (ma.valueRangeLow != null && ma.valueRangeHigh != null) ? `${ma.valueRangeLow} € - ${ma.valueRangeHigh} €` : '',
        deltaEur: ma.deltaEur != null ? `${ma.deltaEur > 0 ? '+' : ''}${ma.deltaEur} €` : '',
        adSummary: adAnalysis.summary || 'Analyse IA non effectuée',
        maRationale: ma.rationale || '',
        datePublication: fmtDate(ad.dates?.publication || ad.date),
        dateScraping: fmtDate(ad.dates?.scraping),
        adStatus: ad.dates?.statut || '',
        scrapingStatus: ad.scraping?.statut || '',
        url: { text: 'Ouvrir l\'annonce', hyperlink: ad.url || '#' },
      });

      row.alignment = { vertical: 'middle', wrapText: true };

      const verdictCell = row.getCell('verdictLabel');
      if (ma.verdictLabel === 'Très bonne affaire' || ma.verdictLabel === 'Bonne affaire') {
        verdictCell.font = { color: { argb: '15803D' }, bold: true };
      } else if (ma.verdictLabel === 'Trop cher' || ma.verdictLabel === 'Très cher') {
        verdictCell.font = { color: { argb: 'B91C1C' }, bold: true };
      }

      const urlCell = row.getCell('url');
      urlCell.font = { color: { argb: '0284C7' }, underline: true };
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

  /**
   * Échappe une valeur pour un champ CSV conforme RFC 4180 :
   * entourer de guillemets si la valeur contient un séparateur, un guillemet,
   * un retour à la ligne ; et doubler les guillemets internes.
   */
  static _csvField(value, sep = ';') {
    const s = value == null ? '' : String(value);
    if (s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  /**
   * Exporte les annonces au format CSV (compatible Excel FR : séparateur « ; »,
   * encodage UTF-8 avec BOM pour que les accents s'affichent correctement à
   * l'ouverture dans Excel). Représente les mêmes colonnes que le .xlsx, en
   * version texte plat. Utile pour un import dans un tableur alternatif ou un
   * script.
   *
   * IMPORTANT : l'ordre des colonnes est FIXE et identique pour toutes les
   * annonces (exigence Python/pandas/Excel). Les champs absents restent vides
   * (jamais décalés, jamais remplacés par des sentinelles type 'null' —
   * cellule vide = valeur absente).
   *
   * @returns {string} chemin du fichier écrit.
   */
  static async exportToCsv(ads, outputPath) {
    const sep = ';';
    const headers = [
      'ID', 'Titre', 'Produit Identifié (IA)', 'Prix (€)', 'Prix Original (€)', 'Négociable',
      'Catégorie', 'Sous-catégorie',
      'Ville', 'Code Postal', 'Département',
      'Vendeur', 'Type Vendeur', 'Note Vendeur', 'Nb Avis Vendeur',
      'Livraison', 'Main Propre', 'Transporteur',
      'Likes', 'Vues',
      'Marque', 'Modèle', 'État',
      'Nb Photos', 'Facture', 'Garantie', 'Échange', 'Urgent', 'État Détecté',
      'Verdict IA Marché', 'Valeur Marché (€)', 'Fourchette Marché (€)', 'Bénéfice/Perte (€)',
      'Résumé IA', 'Justification Marché',
      'Date Publication', 'Date Scraping', 'Statut Annonce', 'Statut Scraping',
      'Lien',
    ];

    const rows = [headers.map((h) => this._csvField(h, sep)).join(sep)];

    const fmtDate = (val) => {
      if (!val) return '';
      const d = new Date(val);
      if (!Number.isFinite(d.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    const fmtTri = (v) => v === true ? 'OUI' : (v === false ? 'NON' : '');

    for (const ad of ads) {
      const ma = ad.marketAnalysis || {};
      const aa = ad.adAnalysis || {};

      const note = ad.vendeur?.note ?? ad.sellerRating;
      const nbAvis = ad.vendeur?.nombreAvis ?? ad.sellerRatingCount;
      let rating = '';
      if (note != null) {
        rating = `${String(note).replace('.', ',')}/5`;
        if (nbAvis != null) rating += ` (${nbAvis} avis)`;
      }

      const livraison = ad.transaction?.livraison ?? ad.shipping;
      const mainPropre = ad.transaction?.mainPropre ?? ad.handDelivery;
      const marketRange = (ma.valueRangeLow != null && ma.valueRangeHigh != null)
        ? `${ma.valueRangeLow} € - ${ma.valueRangeHigh} €` : '';
      const delta = ma.deltaEur != null ? `${ma.deltaEur > 0 ? '+' : ''}${ma.deltaEur} €` : '';

      const row = [
        ad.id || '',
        ad.title || '',
        aa.identifiedProduct || '',
        typeof ad.price === 'number' ? String(ad.price).replace('.', ',') : (ad.price || ''),
        ad.prix?.original != null ? String(ad.prix.original).replace('.', ',') : '',
        fmtTri(ad.prix?.negociable),
        ad.category || '',
        ad.produit?.type || '',
        ad.city || '',
        ad.zipcode || '',
        ad.localisation?.departement || '',
        ad.seller || '',
        ad.vendeur?.type ?? (ad.isPro ? 'pro' : 'particulier'),
        rating,
        nbAvis != null ? String(nbAvis) : '',
        fmtTri(livraison),
        fmtTri(mainPropre),
        ad.transaction?.transporteur || ad.deliveryLabel || '',
        ad.statistiques?.likes != null ? String(ad.statistiques.likes) : '',
        ad.statistiques?.vues != null ? String(ad.statistiques.vues) : '',
        ad.produit?.brand || '',
        ad.produit?.model || '',
        ad.produit?.condition || '',
        ad.photos?.count ?? (Array.isArray(ad.images) ? String(ad.images.length) : '0'),
        fmtTri(ad.detection?.facture),
        fmtTri(ad.detection?.garantie),
        fmtTri(ad.detection?.echangeAccepte),
        fmtTri(ad.detection?.urgent),
        ad.detection?.etatInferreLabel || '',
        ma.verdictLabel || '',
        ma.realValue != null ? `${ma.realValue} €` : '',
        marketRange,
        delta,
        aa.summary || '',
        ma.rationale || '',
        fmtDate(ad.dates?.publication || ad.date),
        fmtDate(ad.dates?.scraping),
        ad.dates?.statut || '',
        ad.scraping?.statut || '',
        ad.url || '',
      ];
      rows.push(row.map((v) => this._csvField(v, sep)).join(sep));
    }

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    // BOM UTF-8 (\uFEFF) : indispensable pour qu'Excel Windows reconnaisse
    // l'UTF-8 et affiche correctement les accents.
    atomicWriteFileSync(outputPath, '\uFEFF' + rows.join('\r\n'));
    return outputPath;
  }
}

module.exports = { ExcelExporter };