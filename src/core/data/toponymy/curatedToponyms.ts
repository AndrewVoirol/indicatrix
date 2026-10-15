// ============================================================================
// File: src/core/data/toponymy/curatedToponyms.ts
// Architecture: Curated Archival Toponymic Dataset & Spot Elevation Inscriptions
// Reference: visual_quality_phase_roadmap.md (M13-P3-T2), ZOOM_DETAIL_SPEC_LEDGER.md (§5.2)
// Description: Global summits with spot heights, oceanic trenches, sounding depths,
//              major geographic straits, capes, continental shields, mountain ranges,
//              and celestial parallels.
// ============================================================================

import { ToponymLabel, ToponymCategory, ToponymTier } from './types';
import { ARCHIVAL_SOUNDINGS, GEODETIC_BENCHMARKS } from '../archivalSoundings';

// ----------------------------------------------------------------------------
// Hierarchical Zoom-Gating Camera Distance Thresholds (ZOOM_DETAIL_SPEC_LEDGER §5.2)
// ----------------------------------------------------------------------------
/** Orbital scale: Always visible from macro orbital view down to surface (0.0 = no distance culling) */
export const TOPONYM_CAM_DIST_ORBITAL = 0.0;
/** Regional scale: Appears when camera approaches continental scale (camDist <= 14.0) */
export const TOPONYM_CAM_DIST_REGIONAL = 14.0;
/** Local scale: High-detail spot elevations, soundings, and straits (camDist <= 8.5) */
export const TOPONYM_CAM_DIST_LOCAL = 8.5;

// ----------------------------------------------------------------------------
// 1. Global Mountain Summits & Spot Heights (M13-P3-T2)
// ----------------------------------------------------------------------------
/**
 * Curated prominent global mountain summits with official spot heights.
 * Inscription format: "▲ [Name] [Height] m"
 */
export const GLOBAL_SUMMITS: ToponymLabel[] = [
  // Eight-Thousanders & Central Asian Giants
  { id: 'EVEREST', text: '▲ Mt. Everest 8,848 m', lat: 27.9881, lon: 86.9250, elevationMeters: 8848, fontSize: 11.5, priority: 1, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'K2', text: '▲ K2 8,611 m', lat: 35.8808, lon: 76.5133, elevationMeters: 8611, fontSize: 11.0, priority: 1, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'KANGCHENJUNGA', text: '▲ Kangchenjunga 8,586 m', lat: 27.7025, lon: 88.1475, elevationMeters: 8586, fontSize: 10.5, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'LHOTSE', text: '▲ Lhotse 8,516 m', lat: 27.9617, lon: 86.9333, elevationMeters: 8516, fontSize: 10.5, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'MAKALU', text: '▲ Makalu 8,485 m', lat: 27.8892, lon: 87.0889, elevationMeters: 8485, fontSize: 10.5, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CHO_OYU', text: '▲ Cho Oyu 8,188 m', lat: 28.0942, lon: 86.6608, elevationMeters: 8188, fontSize: 10.0, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'DHAULAGIRI', text: '▲ Dhaulagiri 8,167 m', lat: 28.6983, lon: 83.4875, elevationMeters: 8167, fontSize: 10.0, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'MANASLU', text: '▲ Manaslu 8,163 m', lat: 28.5500, lon: 84.5556, elevationMeters: 8163, fontSize: 10.0, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'NANGA_PARBAT', text: '▲ Nanga Parbat 8,126 m', lat: 35.2375, lon: 74.5892, elevationMeters: 8126, fontSize: 10.0, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'ANNAPURNA', text: '▲ Annapurna I 8,091 m', lat: 28.5956, lon: 83.8203, elevationMeters: 8091, fontSize: 10.0, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },

  // Seven Continental Summits & Western Hemisphere Peaks
  { id: 'ACONCAGUA', text: '▲ Aconcagua 6,961 m', lat: -32.6532, lon: -70.0109, elevationMeters: 6961, fontSize: 11.0, priority: 1, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'HUASCARAN', text: '▲ Huascaran 6,768 m', lat: -9.1233, lon: -77.6044, elevationMeters: 6768, fontSize: 10.5, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CHIMBORAZO', text: '▲ Chimborazo 6,263 m', lat: -1.4693, lon: -78.8169, elevationMeters: 6263, fontSize: 10.5, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'DENALI', text: '▲ Mt. Denali 6,190 m', lat: 63.0692, lon: -151.0070, elevationMeters: 6190, fontSize: 11.0, priority: 1, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'LOGAN', text: '▲ Mt. Logan 5,959 m', lat: 60.5672, lon: -140.4056, elevationMeters: 5959, fontSize: 10.5, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'KILIMANJARO', text: '▲ Mt. Kilimanjaro 5,895 m', lat: -3.0674, lon: 37.3556, elevationMeters: 5895, fontSize: 11.0, priority: 1, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'ELBRUS', text: '▲ Mt. Elbrus 5,642 m', lat: 43.3499, lon: 42.4453, elevationMeters: 5642, fontSize: 10.5, priority: 1, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'ORIZABA', text: '▲ Pico de Orizaba 5,636 m', lat: 19.0300, lon: -97.2683, elevationMeters: 5636, fontSize: 10.0, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'DAMAVAND', text: '▲ Mt. Damavand 5,609 m', lat: 35.9510, lon: 52.1090, elevationMeters: 5609, fontSize: 10.0, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'ARARAT', text: '▲ Mt. Ararat 5,137 m', lat: 39.7020, lon: 44.2990, elevationMeters: 5137, fontSize: 10.0, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'VINSON', text: '▲ Mt. Vinson 4,892 m', lat: -78.5256, lon: -85.6172, elevationMeters: 4892, fontSize: 10.5, priority: 1, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'PUNCAK_JAYA', text: '▲ Puncak Jaya 4,884 m', lat: -4.0833, lon: 137.1833, elevationMeters: 4884, fontSize: 10.5, priority: 1, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },

  // Iconic Alpine, Pacific & Volcanic Summits
  { id: 'MONT_BLANC', text: '▲ Mont Blanc 4,809 m', lat: 45.8326, lon: 6.8652, elevationMeters: 4809, fontSize: 10.5, priority: 1, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'MATTERHORN', text: '▲ Matterhorn 4,478 m', lat: 45.9520, lon: 7.6586, elevationMeters: 4478, fontSize: 11.5, priority: 1, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'WHITNEY', text: '▲ Mt. Whitney 4,421 m', lat: 36.5785, lon: -118.2923, elevationMeters: 4421, fontSize: 10.0, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'RAINIER', text: '▲ Mt. Rainier 4,392 m', lat: 46.7920, lon: -121.7350, elevationMeters: 4392, fontSize: 11.5, priority: 1, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'MAUNA_KEA', text: '▲ Mauna Kea 4,207 m', lat: 19.8207, lon: -155.4681, elevationMeters: 4207, fontSize: 10.0, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'TOUBKAL', text: '▲ Mt. Toubkal 4,167 m', lat: 31.0600, lon: -7.9158, elevationMeters: 4167, fontSize: 10.0, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'EIGER', text: '▲ Eiger 3,967 m', lat: 46.5775, lon: 8.0053, elevationMeters: 3967, fontSize: 10.0, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'FUJI', text: '▲ Mt. Fuji 3,776 m', lat: 35.3606, lon: 138.7274, elevationMeters: 3776, fontSize: 10.5, priority: 1, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'AORAKI', text: '▲ Aoraki Mt. Cook 3,724 m', lat: -43.5950, lon: 170.1419, elevationMeters: 3724, fontSize: 10.0, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'TEIDE', text: '▲ Mt. Teide 3,715 m', lat: 28.2723, lon: -16.6425, elevationMeters: 3715, fontSize: 10.0, priority: 2, category: 'summit', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
];

// ----------------------------------------------------------------------------
// 2. Global Ocean Trenches & Abyssal Deeps (M13-P3-T2)
// ----------------------------------------------------------------------------
/**
 * Curated deep ocean trenches and abyssal soundings with negative spot depths.
 * Inscription format: "▼ [Name] -[Depth] m"
 */
export const GLOBAL_TRENCHES: ToponymLabel[] = [
  { id: 'CHALLENGER_DEEP', text: '▼ Challenger Deep -10,994 m', lat: 11.3733, lon: 142.2533, elevationMeters: -10994, fontSize: 11.0, priority: 1, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'MARIANA_TRENCH', text: '▼ Mariana Trench -10,924 m', lat: 16.0000, lon: 147.5000, elevationMeters: -10924, fontSize: 11.0, priority: 1, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'TONGA_TRENCH', text: '▼ Tonga Trench -10,820 m', lat: -22.9500, lon: -174.7500, elevationMeters: -10820, fontSize: 10.5, priority: 1, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'KURIL_KAMCHATKA', text: '▼ Kuril-Kamchatka -10,542 m', lat: 44.0000, lon: 150.0000, elevationMeters: -10542, fontSize: 10.5, priority: 2, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'PHILIPPINE_TRENCH', text: '▼ Philippine Trench -10,540 m', lat: 10.1500, lon: 126.7000, elevationMeters: -10540, fontSize: 10.5, priority: 2, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'KERMADEC_TRENCH', text: '▼ Kermadec Trench -10,047 m', lat: -32.5000, lon: -179.0000, elevationMeters: -10047, fontSize: 10.5, priority: 2, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'IZU_OGASAWARA', text: '▼ Izu-Ogasawara Trench -9,780 m', lat: 29.5000, lon: 142.8000, elevationMeters: -9780, fontSize: 10.0, priority: 2, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'YAP_TRENCH', text: '▼ Yap Trench -8,527 m', lat: 9.5000, lon: 138.5000, elevationMeters: -8527, fontSize: 10.0, priority: 3, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'PUERTO_RICO', text: '▼ Puerto Rico Trench -8,376 m', lat: 19.8400, lon: -66.5000, elevationMeters: -8376, fontSize: 10.5, priority: 1, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'SANDWICH_TRENCH', text: '▼ South Sandwich -8,266 m', lat: -55.4000, lon: -26.5000, elevationMeters: -8266, fontSize: 10.0, priority: 2, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'PERU_CHILE_TRENCH', text: '▼ Peru-Chile Trench -8,065 m', lat: -23.0000, lon: -71.0000, elevationMeters: -8065, fontSize: 10.5, priority: 2, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'ROMANCHE', text: '▼ Romanche Trench -7,761 m', lat: -0.2200, lon: -18.3500, elevationMeters: -7761, fontSize: 10.5, priority: 2, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CAYMAN_TROUGH', text: '▼ Cayman Trough -7,686 m', lat: 19.3000, lon: -81.5000, elevationMeters: -7686, fontSize: 10.0, priority: 3, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'ALEUTIAN_TRENCH', text: '▼ Aleutian Trench -7,679 m', lat: 52.0000, lon: -173.0000, elevationMeters: -7679, fontSize: 10.0, priority: 2, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'RYUKYU_TRENCH', text: '▼ Ryukyu Trench -7,507 m', lat: 26.3300, lon: 128.6700, elevationMeters: -7507, fontSize: 10.0, priority: 3, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'JAVA_TRENCH', text: '▼ Java Trench -7,450 m', lat: -10.3200, lon: 111.4500, elevationMeters: -7450, fontSize: 10.5, priority: 1, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'DIAMANTINA_DEEP', text: '▼ Diamantina Deep -7,079 m', lat: -35.0000, lon: 104.0000, elevationMeters: -7079, fontSize: 10.0, priority: 2, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'MOLLOY_DEEP', text: '▼ Molloy Deep -5,550 m', lat: 79.1400, lon: 2.7800, elevationMeters: -5550, fontSize: 10.5, priority: 2, category: 'trench', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
];

// ----------------------------------------------------------------------------
// 3. Major Geographic Straits & Passages (M13-P3-T2)
// ----------------------------------------------------------------------------
/**
 * Curated major maritime straits, narrows, and passages of historical cartography.
 */
export const GEOGRAPHIC_STRAITS: ToponymLabel[] = [
  { id: 'STRAIT_GIBRALTAR', text: 'Strait of Gibraltar', lat: 35.9600, lon: -5.6000, elevationMeters: -300, fontSize: 10.5, priority: 1, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'STRAIT_MALACCA', text: 'Strait of Malacca', lat: 2.5000, lon: 101.5000, elevationMeters: -50, fontSize: 10.5, priority: 1, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'BERING_STRAIT', text: 'Bering Strait', lat: 65.8000, lon: -168.9000, elevationMeters: -45, fontSize: 10.5, priority: 1, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'BOSPHORUS', text: 'Bosphorus Strait', lat: 41.1200, lon: 29.0800, elevationMeters: -50, fontSize: 10.0, priority: 1, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'DARDANELLES', text: 'Dardanelles Strait', lat: 40.2200, lon: 26.4000, elevationMeters: -70, fontSize: 10.0, priority: 2, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'STRAIT_MAGELLAN', text: 'Strait of Magellan', lat: -53.4700, lon: -70.7600, elevationMeters: -100, fontSize: 10.5, priority: 1, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'DRAKE_PASSAGE', text: 'Drake Passage', lat: -58.5000, lon: -65.0000, elevationMeters: -3500, fontSize: 11.0, priority: 1, category: 'strait', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STRAIT_HORMUZ', text: 'Strait of Hormuz', lat: 26.5600, lon: 56.2500, elevationMeters: -80, fontSize: 10.5, priority: 1, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'BAB_EL_MANDEB', text: 'Bab-el-Mandeb', lat: 12.5800, lon: 43.3300, elevationMeters: -180, fontSize: 10.0, priority: 1, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'DOVER_STRAIT', text: 'Strait of Dover', lat: 51.0200, lon: 1.4500, elevationMeters: -35, fontSize: 10.0, priority: 1, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'COOK_STRAIT', text: 'Cook Strait', lat: -41.2300, lon: 174.4800, elevationMeters: -130, fontSize: 10.0, priority: 2, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'BASS_STRAIT', text: 'Bass Strait', lat: -39.5000, lon: 145.5000, elevationMeters: -60, fontSize: 10.0, priority: 2, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'TAIWAN_STRAIT', text: 'Taiwan Strait', lat: 24.0000, lon: 119.5000, elevationMeters: -60, fontSize: 10.5, priority: 2, category: 'strait', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'SUNDA_STRAIT', text: 'Sunda Strait', lat: -5.9000, lon: 105.7500, elevationMeters: -100, fontSize: 10.0, priority: 2, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'MOZAMBIQUE_CHANNEL', text: 'Mozambique Channel', lat: -18.0000, lon: 41.0000, elevationMeters: -3000, fontSize: 11.0, priority: 2, category: 'strait', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'FLORIDA_STRAIT', text: 'Straits of Florida', lat: 24.0000, lon: -80.5000, elevationMeters: -800, fontSize: 10.0, priority: 2, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'TORRES_STRAIT', text: 'Torres Strait', lat: -10.2500, lon: 142.1500, elevationMeters: -15, fontSize: 10.0, priority: 2, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'DANISH_STRAITS', text: 'Great Belt', lat: 55.3300, lon: 11.0000, elevationMeters: -30, fontSize: 9.5, priority: 3, category: 'strait', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
];

// ----------------------------------------------------------------------------
// 4. Major Geographic Capes & Promontories (M13-P3-T2)
// ----------------------------------------------------------------------------
/**
 * Curated iconic geographical capes, headlands, and navigational benchmarks.
 */
export const GEOGRAPHIC_CAPES: ToponymLabel[] = [
  { id: 'CAPE_HORN', text: 'Cape Horn', lat: -55.9800, lon: -67.2700, elevationMeters: 424, fontSize: 10.5, priority: 1, category: 'cape', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CAPE_GOOD_HOPE', text: 'Cape of Good Hope', lat: -34.3500, lon: 18.4700, elevationMeters: 245, fontSize: 10.5, priority: 1, category: 'cape', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CAPE_AGULHAS', text: 'Cape Agulhas', lat: -34.8300, lon: 20.0000, elevationMeters: 140, fontSize: 10.5, priority: 1, category: 'cape', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CAPE_LEEUWIN', text: 'Cape Leeuwin', lat: -34.3700, lon: 115.1400, elevationMeters: 120, fontSize: 10.0, priority: 1, category: 'cape', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'NORTH_CAPE', text: 'North Cape', lat: 71.1700, lon: 25.7800, elevationMeters: 307, fontSize: 10.0, priority: 1, category: 'cape', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CAPE_CANAVERAL', text: 'Cape Canaveral', lat: 28.4600, lon: -80.5300, elevationMeters: 3, fontSize: 10.0, priority: 2, category: 'cape', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CAPE_FAREWELL', text: 'Cape Farewell', lat: 59.7700, lon: -43.9100, elevationMeters: 650, fontSize: 10.0, priority: 1, category: 'cape', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CAPE_COMORIN', text: 'Cape Comorin', lat: 8.0800, lon: 77.5500, elevationMeters: 10, fontSize: 10.0, priority: 2, category: 'cape', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CAPE_VERDE', text: 'Cape Verde Promontory', lat: 14.7400, lon: -17.5200, elevationMeters: 20, fontSize: 10.0, priority: 1, category: 'cape', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CAPE_DEZHNEV', text: 'Cape Dezhnev', lat: 66.0800, lon: -169.6500, elevationMeters: 741, fontSize: 10.0, priority: 1, category: 'cape', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CAPE_YORK', text: 'Cape York', lat: -10.6800, lon: 142.5300, elevationMeters: 10, fontSize: 10.0, priority: 2, category: 'cape', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CAPE_BABA', text: 'Cape Baba', lat: 39.4800, lon: 26.0600, elevationMeters: 45, fontSize: 9.5, priority: 2, category: 'cape', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CAPE_FINISTERRE', text: 'Cape Finisterre', lat: 42.8800, lon: -9.2600, elevationMeters: 143, fontSize: 9.5, priority: 2, category: 'cape', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
  { id: 'CAPE_HATTERAS', text: 'Cape Hatteras', lat: 35.2500, lon: -75.5200, elevationMeters: 3, fontSize: 9.5, priority: 2, category: 'cape', tier: 'local', minCamDist: TOPONYM_CAM_DIST_LOCAL },
];

// ----------------------------------------------------------------------------
// 5. Continental Shields, Cratons & High Plateaus (M13-P3-T2)
// ----------------------------------------------------------------------------
/**
 * Curated ancient crystalline shields, cratons, and geomorphological plateaus.
 */
export const CONTINENTAL_SHIELDS: ToponymLabel[] = [
  { id: 'CANADIAN_SHIELD', text: 'Canadian Shield', lat: 55.0000, lon: -85.0000, elevationMeters: 400, fontSize: 12.0, priority: 1, category: 'shield', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'BALTIC_SHIELD', text: 'Baltic Shield', lat: 64.0000, lon: 26.0000, elevationMeters: 350, fontSize: 11.5, priority: 1, category: 'shield', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'GUIANA_SHIELD', text: 'Guiana Shield', lat: 5.0000, lon: -61.0000, elevationMeters: 800, fontSize: 11.5, priority: 1, category: 'shield', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'BRAZILIAN_SHIELD', text: 'Brazilian Shield', lat: -12.0000, lon: -52.0000, elevationMeters: 600, fontSize: 11.5, priority: 1, category: 'shield', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'AFRICAN_SHIELD', text: 'African Shield', lat: 0.0000, lon: 22.0000, elevationMeters: 450, fontSize: 12.0, priority: 1, category: 'shield', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'AUSTRALIAN_SHIELD', text: 'Australian Shield', lat: -26.0000, lon: 128.0000, elevationMeters: 450, fontSize: 12.0, priority: 1, category: 'shield', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'SIBERIAN_CRATON', text: 'Siberian Craton', lat: 62.0000, lon: 105.0000, elevationMeters: 500, fontSize: 12.0, priority: 1, category: 'shield', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'INDIAN_SHIELD', text: 'Indian Shield', lat: 20.0000, lon: 78.0000, elevationMeters: 600, fontSize: 11.5, priority: 1, category: 'shield', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'ANTARCTIC_SHIELD', text: 'East Antarctic Shield', lat: -75.0000, lon: 60.0000, elevationMeters: 2500, fontSize: 12.0, priority: 1, category: 'shield', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'TIBETAN_PLATEAU', text: 'Tibetan Plateau', lat: 33.0000, lon: 85.0000, elevationMeters: 4500, fontSize: 12.5, priority: 1, category: 'shield', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'COLORADO_PLATEAU', text: 'Colorado Plateau', lat: 37.5000, lon: -109.8000, elevationMeters: 1900, fontSize: 11.0, priority: 2, category: 'shield', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'DECCAN_TRAPS', text: 'Deccan Plateau', lat: 16.5000, lon: 76.0000, elevationMeters: 700, fontSize: 11.0, priority: 2, category: 'shield', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'PATAGONIAN_PLATEAU', text: 'Patagonian Plateau', lat: -45.0000, lon: -69.0000, elevationMeters: 1000, fontSize: 11.0, priority: 2, category: 'shield', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'ETHIOPIAN_HIGHLANDS', text: 'Ethiopian Highlands', lat: 11.0000, lon: 39.5000, elevationMeters: 2500, fontSize: 11.0, priority: 2, category: 'shield', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
];

// ----------------------------------------------------------------------------
// 6. Major Mountain Ranges & Cordilleras (ZOOM_DETAIL_SPEC_LEDGER §5.2)
// ----------------------------------------------------------------------------
/**
 * Regional mountain range labels.
 */
export const MOUNTAIN_RANGES: ToponymLabel[] = [
  { id: 'HIMALAYA', text: 'Himalaya Range', lat: 30.2000, lon: 78.5000, elevationMeters: 5000, fontSize: 13.0, priority: 1, category: 'range', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'ALPS', text: 'Alps', lat: 46.5000, lon: 9.5000, elevationMeters: 3000, fontSize: 12.0, priority: 1, category: 'range', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'ANDES', text: 'Andes Cordillera', lat: -21.0000, lon: -68.0000, elevationMeters: 4000, fontSize: 13.0, priority: 1, category: 'range', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'ROCKIES', text: 'Rocky Mountains', lat: 43.2000, lon: -110.5000, elevationMeters: 3000, fontSize: 12.5, priority: 1, category: 'range', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'ATLAS_MTS', text: 'Atlas Mountains', lat: 31.5000, lon: -6.0000, elevationMeters: 2500, fontSize: 11.5, priority: 2, category: 'range', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'URALS', text: 'Ural Mountains', lat: 60.0000, lon: 59.0000, elevationMeters: 1200, fontSize: 11.5, priority: 2, category: 'range', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'GREAT_DIVIDING', text: 'Great Dividing Range', lat: -31.0000, lon: 150.0000, elevationMeters: 1500, fontSize: 11.5, priority: 2, category: 'range', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'TIAN_SHAN', text: 'Tian Shan', lat: 42.0000, lon: 80.0000, elevationMeters: 4000, fontSize: 11.5, priority: 2, category: 'range', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'CAUCASUS', text: 'Caucasus Mountains', lat: 42.5000, lon: 44.5000, elevationMeters: 3500, fontSize: 11.5, priority: 2, category: 'range', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'APPALACHIANS', text: 'Appalachian Mountains', lat: 37.0000, lon: -80.0000, elevationMeters: 1200, fontSize: 11.5, priority: 2, category: 'range', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'GRAND_CANYON_GORGE', text: 'Grand Canyon Gorge', lat: 36.1300, lon: -112.1400, elevationMeters: 2100, fontSize: 12.0, priority: 1, category: 'range', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'MAUNA_LOA_SHIELD', text: 'Mauna Loa Shield', lat: 19.5500, lon: -155.8300, elevationMeters: 1850, fontSize: 12.0, priority: 1, category: 'range', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
];

// ----------------------------------------------------------------------------
// 7. Oceans, Marginal Seas & Major Hydrographic Basins (ZOOM_DETAIL_SPEC_LEDGER §5.2)
// ----------------------------------------------------------------------------
/**
 * Global oceans and major marginal seas.
 */
export const OCEANIC_FEATURES: ToponymLabel[] = [
  // Primary World Oceans (Orbital Tier)
  { id: 'PACIFIC_OCEAN', text: 'Pacific Ocean', lat: 0.0000, lon: -160.0000, elevationMeters: -4000, fontSize: 15.0, priority: 1, category: 'water', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'ATLANTIC_OCEAN', text: 'Atlantic Ocean', lat: 0.0000, lon: -30.0000, elevationMeters: -3800, fontSize: 15.0, priority: 1, category: 'water', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'INDIAN_OCEAN', text: 'Indian Ocean', lat: -20.0000, lon: 80.0000, elevationMeters: -3800, fontSize: 14.5, priority: 1, category: 'water', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'ARCTIC_OCEAN', text: 'Arctic Ocean', lat: 85.0000, lon: 0.0000, elevationMeters: -1200, fontSize: 14.0, priority: 1, category: 'water', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'SOUTHERN_OCEAN', text: 'Southern Ocean', lat: -65.0000, lon: 0.0000, elevationMeters: -4000, fontSize: 14.0, priority: 1, category: 'water', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },

  // Marginal Seas (Regional Tier)
  { id: 'MEDITERRANEAN', text: 'Mediterranean Sea', lat: 35.0000, lon: 18.0000, elevationMeters: -1500, fontSize: 12.5, priority: 1, category: 'water', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'CARIBBEAN', text: 'Caribbean Sea', lat: 15.0000, lon: -75.0000, elevationMeters: -2500, fontSize: 12.0, priority: 1, category: 'water', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'SOUTH_CHINA_SEA', text: 'South China Sea', lat: 12.0000, lon: 114.0000, elevationMeters: -1500, fontSize: 12.0, priority: 1, category: 'water', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'ARABIAN_SEA', text: 'Arabian Sea', lat: 15.0000, lon: 65.0000, elevationMeters: -3000, fontSize: 11.5, priority: 2, category: 'water', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'CORAL_SEA', text: 'Coral Sea', lat: -18.0000, lon: 152.0000, elevationMeters: -2000, fontSize: 11.5, priority: 2, category: 'water', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'BERING_SEA', text: 'Bering Sea', lat: 58.0000, lon: -175.0000, elevationMeters: -1600, fontSize: 11.5, priority: 2, category: 'water', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'BALTIC_SEA', text: 'Baltic Sea', lat: 58.0000, lon: 20.0000, elevationMeters: -55, fontSize: 11.0, priority: 2, category: 'water', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'NORTH_SEA', text: 'North Sea', lat: 56.0000, lon: 3.0000, elevationMeters: -95, fontSize: 11.0, priority: 2, category: 'water', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'RED_SEA', text: 'Red Sea', lat: 20.0000, lon: 38.0000, elevationMeters: -500, fontSize: 11.0, priority: 2, category: 'water', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
];

// ----------------------------------------------------------------------------
// 8. Archival Parallels & Great Circles (ZOOM_DETAIL_SPEC_LEDGER §5.2)
// ----------------------------------------------------------------------------
/**
 * Classical cartographic parallels and astronomical reference lines.
 * Uses fontStyle: 1 (Technical DIN / blueprint aesthetic).
 */
export const GREAT_CIRCLES: ToponymLabel[] = [
  { id: 'EQUATOR', text: 'Equator 0°', lat: 0.0000, lon: 0.0000, elevationMeters: 0, fontSize: 11.5, fontStyle: 1, priority: 1, category: 'celestial', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'TROPIC_CANCER', text: 'Tropic of Cancer 23°26′N', lat: 23.4367, lon: 0.0000, elevationMeters: 0, fontSize: 10.5, fontStyle: 1, priority: 2, category: 'celestial', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'TROPIC_CAPRICORN', text: 'Tropic of Capricorn 23°26′S', lat: -23.4367, lon: 0.0000, elevationMeters: 0, fontSize: 10.5, fontStyle: 1, priority: 2, category: 'celestial', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'ARCTIC_CIRCLE', text: 'Arctic Circle 66°33′N', lat: 66.5633, lon: 0.0000, elevationMeters: 0, fontSize: 10.5, fontStyle: 1, priority: 2, category: 'celestial', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'ANTARCTIC_CIRCLE', text: 'Antarctic Circle 66°33′S', lat: -66.5633, lon: 0.0000, elevationMeters: 0, fontSize: 10.5, fontStyle: 1, priority: 2, category: 'celestial', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'PRIME_MERIDIAN', text: 'Prime Meridian 0°', lat: 51.4769, lon: 0.0000, elevationMeters: 0, fontSize: 10.5, fontStyle: 1, priority: 2, category: 'celestial', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
];

// ----------------------------------------------------------------------------
// 9. Historical 19th-Century Geodetic Survey Benchmarks
// ----------------------------------------------------------------------------
export const GEODETIC_SURVEY_LABELS: ToponymLabel[] = GEODETIC_BENCHMARKS.map((bm) => ({
  id: `BM_${bm.id}`,
  text: `[${bm.id}] ${bm.name}`,
  lat: bm.lat,
  lon: bm.lon,
  elevationMeters: 0,
  fontSize: 9.5,
  fontStyle: 1, // Technical font
  priority: 3,
  category: 'geodetic' as ToponymCategory,
  tier: 'local' as ToponymTier,
  minCamDist: TOPONYM_CAM_DIST_LOCAL,
}));

// ----------------------------------------------------------------------------
// 10. Archival Hydrographic Depth Soundings
// ----------------------------------------------------------------------------
export const ARCHIVAL_SOUNDING_LABELS: ToponymLabel[] = [
  ...ARCHIVAL_SOUNDINGS.map((s, idx) => ({
    id: `SND_${idx}`,
    text: `${s.depthFm} fm (${s.name})`,
    lat: s.lat,
    lon: s.lon,
    elevationMeters: -s.depthM,
    fontSize: 9.0,
    priority: 3,
    category: 'sounding' as ToponymCategory,
    tier: 'local' as ToponymTier,
    minCamDist: TOPONYM_CAM_DIST_LOCAL,
  })),
  {
    id: 'SND_KONA_ABYSS',
    text: '2140 fm (Kona Trench)',
    lat: 19.5100,
    lon: -155.9400,
    elevationMeters: -3914,
    fontSize: 9.5,
    priority: 2,
    category: 'sounding' as ToponymCategory,
    tier: 'local' as ToponymTier,
    minCamDist: TOPONYM_CAM_DIST_LOCAL,
  },
];

// ----------------------------------------------------------------------------
// 11. Continental Landmasses (ZOOM_DETAIL_SPEC_LEDGER §5.2)
// ----------------------------------------------------------------------------
/**
 * Prominent continental landmass inscriptions for orbital view (z < 4).
 */
export const CONTINENTS: ToponymLabel[] = [
  { id: 'CONTINENT_AFRICA', text: 'AFRICA', lat: 7.1881, lon: 21.0938, elevationMeters: 500, fontSize: 15.0, priority: 1, category: 'continent', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'CONTINENT_ANTARCTICA', text: 'ANTARCTICA', lat: -75.2509, lon: 0.0000, elevationMeters: 2500, fontSize: 15.0, priority: 1, category: 'continent', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'CONTINENT_ASIA', text: 'ASIA', lat: 34.0479, lon: 100.6197, elevationMeters: 1000, fontSize: 15.0, priority: 1, category: 'continent', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'CONTINENT_AUSTRALIA', text: 'AUSTRALIA', lat: -25.2744, lon: 133.7751, elevationMeters: 300, fontSize: 14.5, priority: 1, category: 'continent', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'CONTINENT_EUROPE', text: 'EUROPE', lat: 54.5260, lon: 15.2551, elevationMeters: 200, fontSize: 14.5, priority: 1, category: 'continent', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'CONTINENT_NORTH_AMERICA', text: 'NORTH AMERICA', lat: 48.5000, lon: -101.5000, elevationMeters: 700, fontSize: 15.0, priority: 1, category: 'continent', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
  { id: 'CONTINENT_SOUTH_AMERICA', text: 'SOUTH AMERICA', lat: -14.6048, lon: -57.6562, elevationMeters: 500, fontSize: 15.0, priority: 1, category: 'continent', tier: 'orbital', minCamDist: TOPONYM_CAM_DIST_ORBITAL },
];

// ----------------------------------------------------------------------------
// 12. Major Sovereign States & Historical Territories (ZOOM_DETAIL_SPEC_LEDGER §5.2)
// ----------------------------------------------------------------------------
/**
 * Prominent sovereign states and historical cartographic realms for regional view (4 <= z < 8).
 */
export const SOVEREIGN_STATES: ToponymLabel[] = [
  { id: 'STATE_FRANCE', text: 'France', lat: 46.6034, lon: 1.8883, elevationMeters: 300, fontSize: 12.0, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_GERMANY', text: 'Germany', lat: 51.1657, lon: 10.4515, elevationMeters: 300, fontSize: 12.0, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_UNITED_KINGDOM', text: 'United Kingdom', lat: 54.0000, lon: -2.5000, elevationMeters: 200, fontSize: 12.0, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_ITALY', text: 'Italy', lat: 41.8719, lon: 12.5674, elevationMeters: 400, fontSize: 12.0, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_SPAIN', text: 'Spain', lat: 40.4637, lon: -3.7492, elevationMeters: 600, fontSize: 12.0, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_EGYPT', text: 'Egypt', lat: 26.8206, lon: 30.8025, elevationMeters: 200, fontSize: 12.0, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_SOUTH_AFRICA', text: 'South Africa', lat: -30.5595, lon: 22.9375, elevationMeters: 1000, fontSize: 12.0, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_INDIA', text: 'India', lat: 23.5000, lon: 78.5000, elevationMeters: 500, fontSize: 12.5, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_CHINA', text: 'China', lat: 35.8617, lon: 104.1954, elevationMeters: 1200, fontSize: 13.0, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_JAPAN', text: 'Japan', lat: 36.2048, lon: 138.2529, elevationMeters: 400, fontSize: 12.0, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_RUSSIA', text: 'Russia', lat: 61.5240, lon: 105.3188, elevationMeters: 400, fontSize: 13.0, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_BRAZIL', text: 'Brazil', lat: -14.2350, lon: -51.9253, elevationMeters: 500, fontSize: 12.5, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_ARGENTINA', text: 'Argentina', lat: -38.4161, lon: -63.6167, elevationMeters: 500, fontSize: 12.0, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_UNITED_STATES', text: 'United States', lat: 37.0902, lon: -95.7129, elevationMeters: 600, fontSize: 13.0, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_CANADA', text: 'Canada', lat: 56.1304, lon: -106.3468, elevationMeters: 400, fontSize: 13.0, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_MEXICO', text: 'Mexico', lat: 23.6345, lon: -102.5528, elevationMeters: 1100, fontSize: 12.0, priority: 1, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_INDONESIA', text: 'Indonesia', lat: -0.7893, lon: 113.9213, elevationMeters: 200, fontSize: 12.0, priority: 2, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_SAUDI_ARABIA', text: 'Saudi Arabia', lat: 23.8859, lon: 45.0792, elevationMeters: 600, fontSize: 12.0, priority: 2, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_TURKEY', text: 'Turkey', lat: 38.9637, lon: 35.2433, elevationMeters: 1000, fontSize: 12.0, priority: 2, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_PERU', text: 'Peru', lat: -9.1900, lon: -75.0152, elevationMeters: 1500, fontSize: 12.0, priority: 2, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_NORWAY', text: 'Norway', lat: 60.4720, lon: 8.4689, elevationMeters: 500, fontSize: 11.5, priority: 2, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
  { id: 'STATE_GREECE', text: 'Greece', lat: 39.0742, lon: 21.8243, elevationMeters: 400, fontSize: 11.5, priority: 2, category: 'state', tier: 'regional', minCamDist: TOPONYM_CAM_DIST_REGIONAL },
];

// ----------------------------------------------------------------------------
// Master Aggregated Curated Archival Toponymic Dataset
// ----------------------------------------------------------------------------
/**
 * Master collection of all curated archival toponyms.
 */
export const CURATED_ARCHIVAL_TOPONYMS: ToponymLabel[] = [
  ...CONTINENTS,
  ...GLOBAL_SUMMITS,
  ...GLOBAL_TRENCHES,
  ...GEOGRAPHIC_STRAITS,
  ...GEOGRAPHIC_CAPES,
  ...CONTINENTAL_SHIELDS,
  ...MOUNTAIN_RANGES,
  ...SOVEREIGN_STATES,
  ...OCEANIC_FEATURES,
  ...GREAT_CIRCLES,
  ...GEODETIC_SURVEY_LABELS,
  ...ARCHIVAL_SOUNDING_LABELS,
];

// ----------------------------------------------------------------------------
// Hierarchical Query & Filtering Utilities
// ----------------------------------------------------------------------------
/**
 * Resolves camera distance threshold for zoom gating, inferring from tier if unspecified.
 */
export function resolveMinCamDist(label: ToponymLabel): number {
  if (label.minCamDist !== undefined && Number.isFinite(label.minCamDist)) {
    return label.minCamDist;
  }
  const tier = label.tier;
  if (tier === 'regional' || (tier as any) === 2) {
    return TOPONYM_CAM_DIST_REGIONAL;
  }
  if (tier === 'local' || (tier as any) === 3) {
    return TOPONYM_CAM_DIST_LOCAL;
  }
  return TOPONYM_CAM_DIST_ORBITAL;
}

/**
 * Normalizes label tier classification to canonical string tier ('orbital' | 'regional' | 'local').
 */
export function resolveTier(label: ToponymLabel): 'orbital' | 'regional' | 'local' {
  if (label.tier !== undefined) {
    if (label.tier === 1 || label.tier === 'orbital') return 'orbital';
    if (label.tier === 2 || label.tier === 'regional') return 'regional';
    if (label.tier === 3 || label.tier === 'local') return 'local';
  }
  if (label.minCamDist !== undefined) {
    if (label.minCamDist <= 0.0) return 'orbital';
    if (label.minCamDist <= TOPONYM_CAM_DIST_LOCAL) return 'local';
    return 'regional';
  }
  return 'orbital';
}

/**
 * Filters toponyms by hierarchical zoom tier ('orbital', 'regional', 'local', or 1, 2, 3).
 */
export function getToponymsByTier(
  tier: ToponymTier,
  labels: ToponymLabel[] = CURATED_ARCHIVAL_TOPONYMS
): ToponymLabel[] {
  const targetTier =
    tier === 1 || tier === 'orbital'
      ? 'orbital'
      : tier === 2 || tier === 'regional'
      ? 'regional'
      : 'local';
  return labels.filter((label) => resolveTier(label) === targetTier);
}

/**
 * Filters toponyms by cartographic feature category.
 */
export function getToponymsByCategory(
  category: ToponymCategory,
  labels: ToponymLabel[] = CURATED_ARCHIVAL_TOPONYMS
): ToponymLabel[] {
  return labels.filter((label) => label.category === category);
}

/**
 * Evaluates visibility for all labels at a given camera distance.
 * Returns only those labels whose minCamDist allows visibility.
 */
export function filterToponymsByCamDist(
  camDist: number,
  labels: ToponymLabel[] = CURATED_ARCHIVAL_TOPONYMS
): ToponymLabel[] {
  if (!Number.isFinite(camDist)) return [];
  return labels.filter((label) => {
    const minCam = resolveMinCamDist(label);
    if (minCam <= 0.0) return true; // Orbital / always visible
    return camDist <= minCam;
  });
}

/**
 * Validates an individual toponym label against the cartographic specification schema.
 */
export function validateToponymLabel(label: ToponymLabel): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!label.id || typeof label.id !== 'string' || label.id.trim() === '') {
    errors.push('Label id must be a non-empty string');
  }

  if (!label.text || typeof label.text !== 'string' || label.text.trim() === '') {
    errors.push('Label text must be a non-empty string');
  }

  if (typeof label.lat !== 'number' || !Number.isFinite(label.lat) || label.lat < -90.0 || label.lat > 90.0) {
    errors.push(`Label latitude must be between -90 and 90 degrees (got ${label.lat})`);
  }

  if (typeof label.lon !== 'number' || !Number.isFinite(label.lon) || label.lon < -180.0 || label.lon > 180.0) {
    errors.push(`Label longitude must be between -180 and 180 degrees (got ${label.lon})`);
  }

  if (label.elevationMeters !== undefined && (typeof label.elevationMeters !== 'number' || !Number.isFinite(label.elevationMeters))) {
    errors.push('Label elevationMeters must be a valid number if specified');
  }

  if (label.fontSize !== undefined && (typeof label.fontSize !== 'number' || !Number.isFinite(label.fontSize) || label.fontSize <= 0.0)) {
    errors.push('Label fontSize must be a positive number if specified');
  }

  if (label.alpha !== undefined && (typeof label.alpha !== 'number' || !Number.isFinite(label.alpha) || label.alpha < 0.0 || label.alpha > 1.0)) {
    errors.push('Label alpha must be a number between 0.0 and 1.0 if specified');
  }

  if (label.priority !== undefined && (typeof label.priority !== 'number' || !Number.isFinite(label.priority) || label.priority <= 0)) {
    errors.push('Label priority must be a positive integer if specified');
  }

  if (label.category !== undefined) {
    const validCategories = new Set([
      'summit', 'trench', 'strait', 'cape', 'shield',
      'range', 'water', 'geodetic', 'sounding', 'celestial',
      'continent', 'state'
    ]);
    if (!validCategories.has(label.category)) {
      errors.push(`Invalid category: "${label.category}"`);
    }
  }

  if (label.tier !== undefined) {
    const validTiers = new Set(['orbital', 'regional', 'local', 1, 2, 3]);
    if (!validTiers.has(label.tier)) {
      errors.push(`Invalid tier: "${label.tier}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates the entire dataset for schema correctness, coordinate bounds, and ID uniqueness.
 */
export function validateToponymDataset(
  labels: ToponymLabel[] = CURATED_ARCHIVAL_TOPONYMS
): { valid: boolean; errors: string[]; count: number } {
  const allErrors: string[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const { valid, errors } = validateToponymLabel(label);
    if (!valid) {
      allErrors.push(`[Index ${i}] ${label.id || 'unnamed'}: ${errors.join(', ')}`);
    }

    if (label.id) {
      if (seenIds.has(label.id)) {
        allErrors.push(`Duplicate ID detected: "${label.id}" at index ${i}`);
      }
      seenIds.add(label.id);
    }
  }

  return { valid: allErrors.length === 0, errors: allErrors, count: labels.length };
}
