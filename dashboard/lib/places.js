'use strict';
/**
 * Google Places API (New) client. Finds a business by name and location,
 * then pulls rating, reviews, contact details, opening hours and photos.
 *
 * Needs an API key with "Places API (New)" enabled:
 *   config.json → googlePlaces.apiKey, or env GOOGLE_PLACES_API_KEY
 */

const fsp = require('fs/promises');
const path = require('path');

const BASE = 'https://places.googleapis.com/v1';

const SEARCH_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.rating',
  'places.userRatingCount', 'places.primaryTypeDisplayName', 'places.googleMapsUri'
].join(',');

const DETAIL_FIELDS = [
  'id', 'displayName', 'formattedAddress', 'shortFormattedAddress', 'rating', 'userRatingCount',
  'websiteUri', 'nationalPhoneNumber', 'internationalPhoneNumber', 'regularOpeningHours',
  'primaryTypeDisplayName', 'editorialSummary', 'googleMapsUri', 'reviews', 'photos', 'location'
].join(',');

function apiKey(config) {
  return (config.googlePlaces && config.googlePlaces.apiKey) || process.env.GOOGLE_PLACES_API_KEY || '';
}

function isConfigured(config) {
  return !!apiKey(config);
}

async function gfetch(url, key, init = {}, fieldMask) {
  const headers = { 'X-Goog-Api-Key': key, ...(init.headers || {}) };
  if (fieldMask) headers['X-Goog-FieldMask'] = fieldMask;
  if (init.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    let msg = `Google Places HTTP ${res.status}`;
    try { const j = await res.json(); msg += `: ${j.error?.message || JSON.stringify(j)}`; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res;
}

/** Search candidates by free text ("Business name, city"). */
async function search(config, query, max = 5) {
  const key = apiKey(config);
  if (!key) throw new Error('Google Places API key is not configured');
  const res = await gfetch(`${BASE}/places:searchText`, key, {
    method: 'POST',
    body: JSON.stringify({ textQuery: query, maxResultCount: Math.min(Math.max(max, 1), 10) })
  }, SEARCH_FIELDS);
  const json = await res.json();
  return (json.places || []).map(p => ({
    placeId: p.id,
    name: p.displayName?.text || '',
    address: p.formattedAddress || '',
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? 0,
    type: p.primaryTypeDisplayName?.text || '',
    mapsUrl: p.googleMapsUri || ''
  }));
}

/** Full details for one place, with photos downloaded into photoDir. */
async function details(config, placeId, photoDir, opts = {}) {
  const key = apiKey(config);
  if (!key) throw new Error('Google Places API key is not configured');
  const maxPhotos = opts.maxPhotos ?? config.googlePlaces?.maxPhotos ?? 6;
  const maxReviews = opts.maxReviews ?? config.googlePlaces?.maxReviews ?? 5;
  const photoWidth = config.googlePlaces?.photoMaxWidth ?? 1400;

  const res = await gfetch(`${BASE}/places/${encodeURIComponent(placeId)}`, key, {}, DETAIL_FIELDS);
  const p = await res.json();

  const reviews = (p.reviews || [])
    .filter(r => r.text?.text)
    .sort((a, b) => (b.rating || 0) - (a.rating || 0))
    .slice(0, maxReviews)
    .map(r => ({
      author: r.authorAttribution?.displayName || 'Google user',
      rating: r.rating ?? null,
      text: r.text.text.trim(),
      when: r.relativePublishTimeDescription || '',
      publishTime: r.publishTime || ''
    }));

  const hours = p.regularOpeningHours?.weekdayDescriptions || [];

  // Download photos
  const photos = [];
  if (photoDir && maxPhotos > 0) {
    await fsp.rm(photoDir, { recursive: true, force: true });
    await fsp.mkdir(photoDir, { recursive: true });
    const list = (p.photos || []).slice(0, maxPhotos);
    for (let i = 0; i < list.length; i++) {
      const ph = list[i];
      try {
        const meta = await gfetch(`${BASE}/${ph.name}/media?maxWidthPx=${photoWidth}&skipHttpRedirect=true`, key);
        const { photoUri } = await meta.json();
        const img = await fetch(photoUri, { signal: AbortSignal.timeout(30000) });
        if (!img.ok) continue;
        const ct = img.headers.get('content-type') || 'image/jpeg';
        const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
        const file = `photo-${i + 1}.${ext}`;
        await fsp.writeFile(path.join(photoDir, file), Buffer.from(await img.arrayBuffer()));
        photos.push({
          file,
          width: ph.widthPx, height: ph.heightPx,
          credit: (ph.authorAttributions || []).map(a => a.displayName).filter(Boolean).join(', ')
        });
      } catch (err) {
        console.warn('[places] photo skipped:', err.message);
      }
    }
  }

  return {
    placeId: p.id,
    name: p.displayName?.text || '',
    type: p.primaryTypeDisplayName?.text || '',
    summary: p.editorialSummary?.text || '',
    address: p.formattedAddress || '',
    shortAddress: p.shortFormattedAddress || '',
    phone: p.nationalPhoneNumber || p.internationalPhoneNumber || '',
    website: p.websiteUri || '',
    mapsUrl: p.googleMapsUri || '',
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? 0,
    hours,
    reviews,
    photos,
    location: p.location || null,
    fetchedAt: new Date().toISOString(),
    source: 'google-places'
  };
}

module.exports = { search, details, isConfigured };
