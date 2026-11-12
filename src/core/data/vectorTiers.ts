/**
 * ============================================================================
 * Vector LOD Tiers & Multi-Scale Natural Earth Geometry (M13-P2-T1)
 * ============================================================================
 *
 * Implements multi-tier vector levels of detail:
 * 1. Orbit Tier (1:110M): Generalized Natural Earth boundaries eliminating
 *    subpixel chord clutter and scintillation at planetary distances.
 * 2. Regional Tier (1:10M): Standard global coastlines and major hydrological
 *    arteries from the primary vector dataset.
 * 3. Local / High-Detail Tier: Topographically densified coastline and
 *    hydrographic segments eliminating 10–30 km straight-line chord polygons
 *    at close zoom via geodesic slerp and curvature subdivision.
 */

import { NATURAL_EARTH_110M_RINGS } from './naturalEarth110mData';

export type VectorTier = 'auto' | 'orbit' | 'regional' | 'local';

export const TIER_TAG_DEFAULT = 0.0;
export const TIER_TAG_ORBIT = 1.0;
export const TIER_TAG_REGIONAL = 2.0;
export const TIER_TAG_LOCAL = 3.0;

const RADIUS = 5.005; // z_standoff = 0.001 * R0 <= 0.002
const EARTH_RADIUS_KM = 6371.0;
const DEG2RAD = Math.PI / 180.0;
const RAD2DEG = 180.0 / Math.PI;

/**
 * Projects (lon, lat) in degrees to 3D sphere coordinate at canonical radius.
 */
export function projectToSphere(lonDeg: number, latDeg: number, radius: number = RADIUS): [number, number, number] {
  const lambda = lonDeg * DEG2RAD;
  const phi = Math.max(-89.9, Math.min(89.9, latDeg)) * DEG2RAD;
  const cosPhi = Math.cos(phi);
  const x = radius * cosPhi * Math.sin(lambda);
  const y = radius * Math.sin(phi);
  const z = radius * cosPhi * Math.cos(lambda);
  return [x, y, z];
}

/**
 * Projects (lon, lat) in degrees to Mercator 2D coordinates matching WebGPU shaders.
 */
export function projectToMercator(lonDeg: number, latDeg: number, radius: number = RADIUS): [number, number] {
  const lambda = lonDeg * DEG2RAD;
  const phi = Math.max(-85.051129, Math.min(85.051129, latDeg)) * DEG2RAD;
  const u = radius * lambda;
  const v = radius * Math.log(Math.tan(Math.PI * 0.25 + phi * 0.5));
  return [u, v];
}

/**
 * Resolves active tier taking into account auto switching based on camera distance.
 */
export function resolveActiveVectorTier(
  requestedTier: VectorTier,
  cameraDistance: number
): 'orbit' | 'regional' | 'local' {
  if (requestedTier === 'orbit' || requestedTier === 'regional' || requestedTier === 'local') {
    return requestedTier;
  }
  if (cameraDistance >= 13.0) {
    return 'orbit';
  }
  if (cameraDistance < 6.2) {
    return 'local';
  }
  return 'regional';
}

/**
 * Generates 1:110M Orbit Tier segments with clean generalized boundaries.
 * Instances formatted in standard 16-float stride with TIER_TAG_ORBIT in posA_target2d.z.
 */
export function generateOrbitTierSegments(): Float32Array {
  const segmentPairs: Array<{
    lonA: number;
    latA: number;
    lonB: number;
    latB: number;
  }> = [];

  for (const ring of NATURAL_EARTH_110M_RINGS) {
    if (!ring || ring.length < 2) continue;
    for (let i = 0; i < ring.length - 1; i++) {
      const lonA = ring[i][0];
      const latA = ring[i][1];
      const lonB = ring[i + 1][0];
      const latB = ring[i + 1][1];

      // Antimeridian seam crossing detection
      const dLon = lonB - lonA;
      if (Math.abs(dLon) > 180.0) {
        // Crosses antimeridian: split into two continuous segments without polar wrapping
        let tSeam = 0.5;
        if (lonA > 0 && lonB < 0) {
          // Crosses eastward across antimeridian (+180 -> -180)
          const denom = (lonB + 360.0) - lonA;
          tSeam = Math.abs(denom) > 1e-6 ? (180.0 - lonA) / denom : 0.5;
          tSeam = Math.max(0.0, Math.min(1.0, tSeam));
          const latSeam = latA + tSeam * (latB - latA);
          segmentPairs.push({ lonA, latA, lonB: 180.0, latB: latSeam });
          segmentPairs.push({ lonA: -180.0, latA: latSeam, lonB, latB });
        } else if (lonA < 0 && lonB > 0) {
          // Crosses westward across antimeridian (-180 -> +180)
          const denom = (lonB - 360.0) - lonA;
          tSeam = Math.abs(denom) > 1e-6 ? (-180.0 - lonA) / denom : 0.5;
          tSeam = Math.max(0.0, Math.min(1.0, tSeam));
          const latSeam = latA + tSeam * (latB - latA);
          segmentPairs.push({ lonA, latA, lonB: -180.0, latB: latSeam });
          segmentPairs.push({ lonA: 180.0, latA: latSeam, lonB, latB });
        }
      } else {
        segmentPairs.push({ lonA, latA, lonB, latB });
      }
    }
  }

  const segCount = segmentPairs.length;
  const outFloats = new Float32Array(segCount * 16);

  for (let k = 0; k < segCount; k++) {
    const pair = segmentPairs[k];
    const [xA, yA, zA] = projectToSphere(pair.lonA, pair.latA);
    const [uA, vA] = projectToMercator(pair.lonA, pair.latA);
    const [xB, yB, zB] = projectToSphere(pair.lonB, pair.latB);
    const [uB, vB] = projectToMercator(pair.lonB, pair.latB);

    const base = k * 16;
    // posA_3d (xyz = pos, w = pointType 1.0 for coastline)
    outFloats[base + 0] = xA;
    outFloats[base + 1] = yA;
    outFloats[base + 2] = zA;
    outFloats[base + 3] = 1.0;

    // posA_target2d (xy = Mercator, z = tierTag, w = reserved)
    outFloats[base + 4] = uA;
    outFloats[base + 5] = vA;
    outFloats[base + 6] = TIER_TAG_ORBIT;
    outFloats[base + 7] = 0.0;

    // posB_3d
    outFloats[base + 8] = xB;
    outFloats[base + 9] = yB;
    outFloats[base + 10] = zB;
    outFloats[base + 11] = 1.0;

    // posB_target2d
    outFloats[base + 12] = uB;
    outFloats[base + 13] = vB;
    outFloats[base + 14] = TIER_TAG_ORBIT;
    outFloats[base + 15] = 0.0;
  }

  return outFloats;
}

/**
 * Calculates stroke width in pixels according to Leopold-Maddock (1953)
 * hydraulic geometry power law: w(Q) = a * Q^b with b ≈ 0.50.
 *
 * Order 1 (rill): 0.40px hairline
 * Order 8 (continental trunk): 1.98px estuary
 */
export function calcLeopoldMaddockWidth(streamOrder: number, b: number = 0.50): number {
  const clampedOrder = Math.max(1.0, Math.min(8.0, streamOrder));
  const t = (clampedOrder - 1.0) / 7.0;
  return 0.40 + (1.98 - 0.40) * Math.pow(t, b);
}

/**
 * Classifies river segments into Strahler stream orders (Order 1 rill -> Order 8 continental trunk)
 * based on topological drainage hierarchy, confluence merging, and Horton accumulation laws.
 *
 * Populates posA_target2d.w (streamOrderA) and posB_target2d.w (streamOrderB) at offsets +7 and +15.
 * Leaves coastline segments (pointType >= 0.75) with order 0.0.
 *
 * @param segFloats 16-float stride vector segment buffer
 * @returns The modified segment buffer
 */
export function classifyRiverStrahlerOrders(segFloats: Float32Array): Float32Array {
  const totalSegs = Math.floor(segFloats.length / 16);
  if (totalSegs === 0) return segFloats;

  // 1. Gather river segments and count coastline vertices (zero-GC typed array pass)
  let riverCount = 0;
  let coastCount = 0;
  for (let k = 0; k < totalSegs; k++) {
    if (segFloats[k * 16 + 3] < 0.75) {
      riverCount++;
    } else {
      coastCount++;
    }
  }

  if (riverCount === 0) return segFloats;

  const riverSegs = new Int32Array(riverCount);
  let rPtr = 0;
  for (let k = 0; k < totalSegs; k++) {
    if (segFloats[k * 16 + 3] < 0.75) {
      riverSegs[rPtr++] = k;
    }
  }

  // 2. Spatial hashing to assign compact integer node IDs (12.7m precision on R ~ 5.0)
  // Uses zero-string open-addressed Int32Array hash table for <30ms execution on 120k segments
  const maxPossibleNodes = riverCount * 2 + 1;
  let hashCap = 1024;
  while (hashCap < maxPossibleNodes * 2) {
    hashCap <<= 1;
  }
  const hashMask = hashCap - 1;
  const hashIds = new Int32Array(hashCap).fill(-1);
  const nodeIx = new Int32Array(maxPossibleNodes);
  const nodeIy = new Int32Array(maxPossibleNodes);
  const nodeIz = new Int32Array(maxPossibleNodes);
  const nodeX = new Float32Array(maxPossibleNodes);
  const nodeY = new Float32Array(maxPossibleNodes);
  const nodeZ = new Float32Array(maxPossibleNodes);
  let nextNodeId = 0;

  function getNodeId(x: number, y: number, z: number): number {
    const ix = Math.round(x * 100000) | 0;
    const iy = Math.round(y * 100000) | 0;
    const iz = Math.round(z * 100000) | 0;
    let slot = ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0) & hashMask;
    while (true) {
      const id = hashIds[slot];
      if (id === -1) {
        const newId = nextNodeId++;
        hashIds[slot] = newId;
        nodeIx[newId] = ix;
        nodeIy[newId] = iy;
        nodeIz[newId] = iz;
        nodeX[newId] = x;
        nodeY[newId] = y;
        nodeZ[newId] = z;
        return newId;
      }
      if (nodeIx[id] === ix && nodeIy[id] === iy && nodeIz[id] === iz) {
        return id;
      }
      slot = (slot + 1) & hashMask;
    }
  }

  const uNodes = new Int32Array(riverCount);
  const vNodes = new Int32Array(riverCount);

  for (let i = 0; i < riverCount; i++) {
    const k = riverSegs[i];
    const base = k * 16;
    uNodes[i] = getNodeId(segFloats[base + 0], segFloats[base + 1], segFloats[base + 2]);
    vNodes[i] = getNodeId(segFloats[base + 8], segFloats[base + 9], segFloats[base + 10]);
  }

  const numNodes = nextNodeId;

  // 3. Flat adjacency arrays and degree counting for zero-GC graph traversal
  const inDeg = new Int32Array(numNodes);
  const outDeg = new Int32Array(numNodes);
  const deg = new Int32Array(numNodes);
  for (let i = 0; i < riverCount; i++) {
    outDeg[uNodes[i]]++;
    inDeg[vNodes[i]]++;
    deg[uNodes[i]]++;
    deg[vNodes[i]]++;
  }

  const head = new Int32Array(numNodes + 1);
  for (let i = 0; i < riverCount; i++) {
    head[uNodes[i] + 1]++;
    head[vNodes[i] + 1]++;
  }
  for (let i = 0; i < numNodes; i++) {
    head[i + 1] += head[i];
  }

  const curHead = new Int32Array(head);
  const adjNbr = new Int32Array(riverCount * 2);

  for (let i = 0; i < riverCount; i++) {
    const u = uNodes[i];
    const v = vNodes[i];
    adjNbr[curHead[u]++] = v;
    adjNbr[curHead[v]++] = u;
  }

  // 4. Connected components (flat CSR array in q/compNodesFlat to avoid per-component JS Array allocations)
  const compOf = new Int32Array(numNodes).fill(-1);
  const compOffsets = new Int32Array(numNodes + 1);
  const q = new Int32Array(numNodes);
  let numComps = 0;
  let writePos = 0;

  for (let i = 0; i < numNodes; i++) {
    if (compOf[i] === -1) {
      const cId = numComps++;
      compOffsets[cId] = writePos;
      let qHead = writePos;
      q[writePos++] = i;
      compOf[i] = cId;

      while (qHead < writePos) {
        const curr = q[qHead++];
        const start = head[curr];
        const end = head[curr + 1];
        for (let e = start; e < end; e++) {
          const nbr = adjNbr[e];
          if (compOf[nbr] === -1) {
            compOf[nbr] = cId;
            q[writePos++] = nbr;
          }
        }
      }
    }
  }
  compOffsets[numComps] = writePos;
  const compNodesFlat = new Int32Array(q);

  // 5. Spatial indexing for robust ocean outlet and inland confluence detection
  // 5a. Coastline spatial CSR grid (open-addressed Int32Array cell table -> contiguous Float32Array)
  let coastHashKey: Int32Array | null = null;
  let coastHashCell: Int32Array | null = null;
  let coastCellOffsets: Int32Array | null = null;
  let coastXYZ: Float32Array | null = null;
  let coastHashMask = 0;

  if (coastCount > 0) {
    let coastHashCap = 16384;
    while (coastHashCap < Math.min(65536, coastCount * 2 + 1)) {
      coastHashCap <<= 1;
    }
    coastHashMask = coastHashCap - 1;
    coastHashKey = new Int32Array(coastHashCap).fill(-1);
    coastHashCell = new Int32Array(coastHashCap).fill(-1);
    const pointCell = new Int32Array(coastCount);
    const cellCounts = new Int32Array(coastHashCap);
    let numCells = 0;
    let cIdx = 0;
    for (let k = 0; k < totalSegs; k++) {
      const base = k * 16;
      if (segFloats[base + 3] >= 0.75) {
        const cx = segFloats[base + 0];
        const cy = segFloats[base + 1];
        const cz = segFloats[base + 2];
        const gk = ((Math.floor(cx * 20) + 512) & 1023) | (((Math.floor(cy * 20) + 512) & 1023) << 10) | (((Math.floor(cz * 20) + 512) & 1023) << 20);
        let slot = (Math.imul(gk, 0x9e3779b1) >>> 0) & coastHashMask;
        while (coastHashKey[slot] !== -1 && coastHashKey[slot] !== gk) {
          slot = (slot + 1) & coastHashMask;
        }
        let cellId = coastHashCell[slot];
        if (cellId === -1) {
          cellId = numCells++;
          coastHashKey[slot] = gk;
          coastHashCell[slot] = cellId;
        }
        pointCell[cIdx++] = cellId;
        cellCounts[cellId]++;
      }
    }
    coastCellOffsets = new Int32Array(numCells + 1);
    for (let c = 0; c < numCells; c++) {
      coastCellOffsets[c + 1] = coastCellOffsets[c] + cellCounts[c];
    }
    const writeHead = new Int32Array(coastCellOffsets);
    coastXYZ = new Float32Array(coastCount * 3);
    cIdx = 0;
    for (let k = 0; k < totalSegs; k++) {
      const base = k * 16;
      if (segFloats[base + 3] >= 0.75) {
        const cellId = pointCell[cIdx++];
        const dst = writeHead[cellId] * 3;
        writeHead[cellId]++;
        coastXYZ[dst] = segFloats[base + 0];
        coastXYZ[dst + 1] = segFloats[base + 1];
        coastXYZ[dst + 2] = segFloats[base + 2];
      }
    }
  }

  function distToCoast(x: number, y: number, z: number): number {
    if (!coastHashKey || !coastHashCell || !coastCellOffsets || !coastXYZ) return Infinity;
    const gx = Math.floor(x * 20);
    const gy = Math.floor(y * 20);
    const gz = Math.floor(z * 20);
    let minD2 = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const gk = ((gx + dx + 512) & 1023) | (((gy + dy + 512) & 1023) << 10) | (((gz + dz + 512) & 1023) << 20);
          let slot = (Math.imul(gk, 0x9e3779b1) >>> 0) & coastHashMask;
          while (coastHashKey[slot] !== -1) {
            if (coastHashKey[slot] === gk) {
              const cellId = coastHashCell[slot];
              const start = coastCellOffsets[cellId] * 3;
              const end = coastCellOffsets[cellId + 1] * 3;
              for (let p = start; p < end; p += 3) {
                const d2 = (coastXYZ[p] - x) ** 2 + (coastXYZ[p + 1] - y) ** 2 + (coastXYZ[p + 2] - z) ** 2;
                if (d2 < minD2) minD2 = d2;
              }
              break;
            }
            slot = (slot + 1) & coastHashMask;
          }
        }
      }
    }
    return Math.sqrt(minD2);
  }

  // 5b. River leaves spatial CSR grid to detect inland confluence endpoints
  let leafCount = 0;
  for (let i = 0; i < numNodes; i++) {
    if (deg[i] === 1) leafCount++;
  }
  let leafHashCap = 16384;
  while (leafHashCap < Math.min(65536, leafCount * 2 + 1)) {
    leafHashCap <<= 1;
  }
  const leafHashMask = leafHashCap - 1;
  const leafHashKey = new Int32Array(leafHashCap).fill(-1);
  const leafHashCell = new Int32Array(leafHashCap).fill(-1);
  const leafCellOf = new Int32Array(leafCount);
  const leafCellCounts = new Int32Array(leafHashCap);
  let numLeafCells = 0;
  let lIdx = 0;
  for (let i = 0; i < numNodes; i++) {
    if (deg[i] === 1) {
      const lx = nodeX[i];
      const ly = nodeY[i];
      const lz = nodeZ[i];
      const gk = ((Math.floor(lx * 10) + 512) & 1023) | (((Math.floor(ly * 10) + 512) & 1023) << 10) | (((Math.floor(lz * 10) + 512) & 1023) << 20);
      let slot = (Math.imul(gk, 0x9e3779b1) >>> 0) & leafHashMask;
      while (leafHashKey[slot] !== -1 && leafHashKey[slot] !== gk) {
        slot = (slot + 1) & leafHashMask;
      }
      let cellId = leafHashCell[slot];
      if (cellId === -1) {
        cellId = numLeafCells++;
        leafHashKey[slot] = gk;
        leafHashCell[slot] = cellId;
      }
      leafCellOf[lIdx++] = cellId;
      leafCellCounts[cellId]++;
    }
  }
  const leafCellOffsets = new Int32Array(numLeafCells + 1);
  for (let c = 0; c < numLeafCells; c++) {
    leafCellOffsets[c + 1] = leafCellOffsets[c] + leafCellCounts[c];
  }
  const leafWriteHead = new Int32Array(leafCellOffsets);
  const leafNodesCSR = new Int32Array(leafCount);
  lIdx = 0;
  for (let i = 0; i < numNodes; i++) {
    if (deg[i] === 1) {
      const cellId = leafCellOf[lIdx++];
      leafNodesCSR[leafWriteHead[cellId]++] = i;
    }
  }

  function distToOtherComp(u: number, cId: number): number {
    const x = nodeX[u];
    const y = nodeY[u];
    const z = nodeZ[u];
    const gx = Math.floor(x * 10);
    const gy = Math.floor(y * 10);
    const gz = Math.floor(z * 10);
    let minD2 = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const gk = ((gx + dx + 512) & 1023) | (((gy + dy + 512) & 1023) << 10) | (((gz + dz + 512) & 1023) << 20);
          let slot = (Math.imul(gk, 0x9e3779b1) >>> 0) & leafHashMask;
          while (leafHashKey[slot] !== -1) {
            if (leafHashKey[slot] === gk) {
              const cellId = leafHashCell[slot];
              const start = leafCellOffsets[cellId];
              const end = leafCellOffsets[cellId + 1];
              for (let p = start; p < end; p++) {
                const ln = leafNodesCSR[p];
                if (compOf[ln] !== cId) {
                  const d2 = (nodeX[ln] - x) ** 2 + (nodeY[ln] - y) ** 2 + (nodeZ[ln] - z) ** 2;
                  if (d2 < minD2) minD2 = d2;
                }
              }
              break;
            }
            slot = (slot + 1) & leafHashMask;
          }
        }
      }
    }
    return Math.sqrt(minD2);
  }

  // 6. Compute Strahler stream order per component
  const nodeOrder = new Float32Array(numNodes).fill(1.0);
  const dist = new Int32Array(numNodes);
  const parentNode = new Int32Array(numNodes);
  const bfsOrder = new Int32Array(numNodes);
  const subSize = new Int32Array(numNodes);
  const strahler = new Int32Array(numNodes);
  const maxChildOrder = new Uint8Array(numNodes);
  const maxChildCount = new Uint8Array(numNodes);

  for (let c = 0; c < numComps; c++) {
    const cStart = compOffsets[c];
    const cEnd = compOffsets[c + 1];
    if (cEnd - cStart === 1) continue;

    // Pick root (river mouth / outlet / confluence)
    let bestRoot = -1;

    // 1. Check proximity to coastline (ocean estuary), preferring downstream sink leaves (inDeg > outDeg)
    let minCoast = Infinity;
    for (let j = cStart; j < cEnd; j++) {
      const u = compNodesFlat[j];
      if (deg[u] === 1) {
        const dC = distToCoast(nodeX[u], nodeY[u], nodeZ[u]);
        const effDC = inDeg[u] > outDeg[u] ? dC : dC + 0.08;
        if (effDC < minCoast) {
          minCoast = effDC;
          bestRoot = u;
        }
      }
    }

    // 2. If river does not reach ocean directly (inland tributary), find leaf closest to another river component
    if (minCoast > 0.05) {
      let minOther = Infinity;
      let bestOther = -1;
      for (let j = cStart; j < cEnd; j++) {
        const u = compNodesFlat[j];
        if (deg[u] === 1) {
          const dO = distToOtherComp(u, c);
          if (dO < minOther) {
            minOther = dO;
            bestOther = u;
          }
        }
      }
      if (bestOther !== -1 && minOther < 0.05) {
        bestRoot = bestOther;
      }
    }

    // 3. Fallback for synthetic trees or isolated inland basins:
    // Look for a sink node where inDeg > outDeg (terminal downstream point)
    if (bestRoot === -1 || (minCoast > 0.05 && coastCount === 0)) {
      for (let j = cStart; j < cEnd; j++) {
        const u = compNodesFlat[j];
        if (deg[u] === 1 && inDeg[u] > outDeg[u]) {
          bestRoot = u;
          break;
        }
      }
    }

    // 4. Ultimate fallback: pick any leaf or first node
    if (bestRoot === -1) {
      bestRoot = compNodesFlat[cStart];
      for (let j = cStart; j < cEnd; j++) {
        if (deg[compNodesFlat[j]] === 1) {
          bestRoot = compNodesFlat[j];
          break;
        }
      }
    }

    // BFS tree rooted at bestRoot (so root has distance 0, headwaters are at the leaves)
    for (let j = cStart; j < cEnd; j++) {
      const n = compNodesFlat[j];
      dist[n] = -1;
      parentNode[n] = -1;
      subSize[n] = 1;
      strahler[n] = 1;
      maxChildOrder[n] = 0;
      maxChildCount[n] = 0;
    }

    let qH = 0;
    let qT = 0;
    q[qT++] = bestRoot;
    dist[bestRoot] = 0;
    let bfsCount = 0;

    while (qH < qT) {
      const u = q[qH++];
      bfsOrder[bfsCount++] = u;
      const s = head[u];
      const e = head[u + 1];
      for (let k = s; k < e; k++) {
        const nbr = adjNbr[k];
        if (dist[nbr] === -1) {
          dist[nbr] = dist[u] + 1;
          parentNode[nbr] = u;
          q[qT++] = nbr;
        }
      }
    }

    // Process nodes in reverse BFS order (leaves up towards root)
    for (let idx = bfsCount - 1; idx >= 0; idx--) {
      const u = bfsOrder[idx];
      let sOrd = 1;
      const m1 = maxChildOrder[u];
      const countM1 = maxChildCount[u];
      if (m1 > 0) {
        sOrd = countM1 >= 2 ? Math.min(8, m1 + 1) : m1;
      }
      strahler[u] = sOrd;

      const p = parentNode[u];
      if (p !== -1) {
        subSize[p] += subSize[u];
        if (sOrd > maxChildOrder[p]) {
          maxChildOrder[p] = sOrd;
          maxChildCount[p] = 1;
        } else if (sOrd === maxChildOrder[p]) {
          maxChildCount[p]++;
        }
      }
    }

    // Assign final stream order combining Strahler order and Horton accumulated reach law
    for (let j = cStart; j < cEnd; j++) {
      const u = compNodesFlat[j];
      const hortonOrder = Math.min(8, 1 + Math.floor(Math.log2(Math.max(1, subSize[u])) * 0.75));
      nodeOrder[u] = Math.max(strahler[u], hortonOrder);
    }
  }

  // 7. Write stream orders back to segFloats buffer
  // Positional offset +7: streamOrderA (at posA)
  // Positional offset +15: streamOrderB (at posB)
  for (let i = 0; i < riverCount; i++) {
    const k = riverSegs[i];
    const base = k * 16;
    const u = uNodes[i];
    const v = vNodes[i];
    segFloats[base + 7] = nodeOrder[u];
    segFloats[base + 15] = nodeOrder[v];
  }

  return segFloats;
}

/**
 * Eliminates 10-30 km straight-line chord polygons at close zoom by subdividing
 * long segments along spherical geodesics (great circles) into curvature-conforming
 * local subsegments.
 *
 * @param sourceFloats 16-float stride vector segment buffer
 * @param maxChordKm Maximum allowed straight-line chord length before subdivision (default 15 km)
 * @param maxSubdivisions Maximum subdivision depth per chord (default 6)
 */
export function densifySegmentsToLocalTier(
  sourceFloats: Float32Array,
  maxChordKm: number = 15.0,
  maxSubdivisions: number = 8
): Float32Array {
  const inSegCount = Math.floor(sourceFloats.length / 16);
  if (inSegCount === 0) return new Float32Array(0);

  // Pass 1: Compute subdivision counts per segment without allocating JS heap objects
  const subCounts = new Uint8Array(inSegCount);
  let totalOutSegs = 0;
  const seamThreshold = Math.PI * RADIUS * 0.95;

  for (let k = 0; k < inSegCount; k++) {
    const base = k * 16;
    const xA = sourceFloats[base + 0];
    const yA = sourceFloats[base + 1];
    const zA = sourceFloats[base + 2];
    const uA = sourceFloats[base + 4];

    const xB = sourceFloats[base + 8];
    const yB = sourceFloats[base + 9];
    const zB = sourceFloats[base + 10];
    const uB = sourceFloats[base + 12];

    const lenA = Math.hypot(xA, yA, zA);
    const lenB = Math.hypot(xB, yB, zB);
    if (lenA < 0.001 || lenB < 0.001) continue;

    const isCrossSeam = Math.abs(uA - uB) > seamThreshold;
    const dot = (xA * xB + yA * yB + zA * zB) / (lenA * lenB);
    const clampedDot = Math.max(-1.0, Math.min(1.0, dot));
    const theta = Math.acos(clampedDot);
    const chordKm = theta * EARTH_RADIUS_KM;

    if (chordKm <= maxChordKm || theta < 0.0001 || isCrossSeam) {
      subCounts[k] = 1;
      totalOutSegs += 1;
    } else {
      const N = Math.min(maxSubdivisions, Math.max(2, Math.ceil(chordKm / maxChordKm)));
      subCounts[k] = N;
      totalOutSegs += N;
    }
  }

  // Pass 2: Write subsegments directly into preallocated Float32Array
  const outFloats = new Float32Array(totalOutSegs * 16);
  let outBase = 0;

  for (let k = 0; k < inSegCount; k++) {
    const N = subCounts[k];
    if (N === 0) continue;

    const base = k * 16;
    const xA = sourceFloats[base + 0];
    const yA = sourceFloats[base + 1];
    const zA = sourceFloats[base + 2];
    const wA = sourceFloats[base + 3];
    const uA = sourceFloats[base + 4];
    const vA = sourceFloats[base + 5];
    const orderA = sourceFloats[base + 7];

    const xB = sourceFloats[base + 8];
    const yB = sourceFloats[base + 9];
    const zB = sourceFloats[base + 10];
    const wB = sourceFloats[base + 11];
    const uB = sourceFloats[base + 12];
    const vB = sourceFloats[base + 13];
    const orderB = sourceFloats[base + 15];

    if (N === 1) {
      outFloats[outBase + 0] = xA;
      outFloats[outBase + 1] = yA;
      outFloats[outBase + 2] = zA;
      outFloats[outBase + 3] = wA;
      outFloats[outBase + 4] = uA;
      outFloats[outBase + 5] = vA;
      outFloats[outBase + 6] = TIER_TAG_LOCAL;
      outFloats[outBase + 7] = orderA;

      outFloats[outBase + 8] = xB;
      outFloats[outBase + 9] = yB;
      outFloats[outBase + 10] = zB;
      outFloats[outBase + 11] = wB;
      outFloats[outBase + 12] = uB;
      outFloats[outBase + 13] = vB;
      outFloats[outBase + 14] = TIER_TAG_LOCAL;
      outFloats[outBase + 15] = orderB;
      outBase += 16;
    } else {
      const lenA = Math.hypot(xA, yA, zA);
      const lenB = Math.hypot(xB, yB, zB);
      const dot = (xA * xB + yA * yB + zA * zB) / (lenA * lenB);
      const clampedDot = Math.max(-1.0, Math.min(1.0, dot));
      const theta = Math.acos(clampedDot);
      const sinTheta = Math.sqrt(Math.max(1e-12, 1.0 - clampedDot * clampedDot));

      const invLenA = RADIUS / lenA;
      const lonARad = Math.atan2(xA, zA);
      const mercRadius =
        Math.abs(uA) > 0.05 && Math.abs(lonARad) > 0.01
          ? Math.abs(uA / lonARad)
          : RADIUS;
      let prevX = xA * invLenA;
      let prevY = yA * invLenA;
      let prevZ = zA * invLenA;
      let prevW = wA;
      let prevU = uA;
      let prevV = vA;
      let prevOrder = orderA;

      for (let s = 1; s <= N; s++) {
        const t = s / N;
        let currX: number;
        let currY: number;
        let currZ: number;

        if (sinTheta > 1e-6) {
          const s0 = Math.sin((1.0 - t) * theta) / sinTheta;
          const s1 = Math.sin(t * theta) / sinTheta;
          currX = s0 * xA + s1 * xB;
          currY = s0 * yA + s1 * yB;
          currZ = s0 * zA + s1 * zB;
          const currLen = Math.hypot(currX, currY, currZ);
          if (currLen > 0.0001) {
            const invLen = RADIUS / currLen;
            currX *= invLen;
            currY *= invLen;
            currZ *= invLen;
          }
        } else {
          currX = (1.0 - t) * xA + t * xB;
          currY = (1.0 - t) * yA + t * yB;
          currZ = (1.0 - t) * zA + t * zB;
        }

        const currW = (1.0 - t) * wA + t * wB;
        const currOrder = (1.0 - t) * orderA + t * orderB;
        let currU: number;
        let currV: number;

        if (s === N) {
          const invLenB = RADIUS / lenB;
          currX = xB * invLenB;
          currY = yB * invLenB;
          currZ = zB * invLenB;
          currU = uB;
          currV = vB;
        } else {
          // Project slerped spherical point to 2D Mercator to prevent Greenwich distortion
          const currLon = Math.atan2(currX, currZ);
          const currLat = Math.asin(Math.max(-0.9998, Math.min(0.9998, currY / RADIUS)));
          const [projU, projV] = projectToMercator(currLon * RAD2DEG, currLat * RAD2DEG, mercRadius);
          currU = projU;
          currV = projV;
        }

        outFloats[outBase + 0] = prevX;
        outFloats[outBase + 1] = prevY;
        outFloats[outBase + 2] = prevZ;
        outFloats[outBase + 3] = prevW;
        outFloats[outBase + 4] = prevU;
        outFloats[outBase + 5] = prevV;
        outFloats[outBase + 6] = TIER_TAG_LOCAL;
        outFloats[outBase + 7] = prevOrder;

        outFloats[outBase + 8] = currX;
        outFloats[outBase + 9] = currY;
        outFloats[outBase + 10] = currZ;
        outFloats[outBase + 11] = currW;
        outFloats[outBase + 12] = currU;
        outFloats[outBase + 13] = currV;
        outFloats[outBase + 14] = TIER_TAG_LOCAL;
        outFloats[outBase + 15] = currOrder;
        outBase += 16;

        prevX = currX;
        prevY = currY;
        prevZ = currZ;
        prevW = currW;
        prevU = currU;
        prevV = currV;
        prevOrder = currOrder;
      }
    }
  }

  return outFloats;
}

/**
 * Marks source segments with Regional tier tag (TIER_TAG_REGIONAL = 2.0).
 */
export function tagRegionalSegments(sourceFloats: Float32Array): Float32Array {
  const out = new Float32Array(sourceFloats);
  const count = Math.floor(out.length / 16);
  for (let k = 0; k < count; k++) {
    const base = k * 16;
    out[base + 6] = TIER_TAG_REGIONAL;
    out[base + 14] = TIER_TAG_REGIONAL;
  }
  return out;
}

/**
 * Builds a unified multi-tier vector buffer containing Orbit, Regional, and Local
 * segments with embedded tier tags for automatic shader-driven LOD switching.
 */
export function buildUnifiedTieredVectorBuffer(
  orbitSegments: Float32Array,
  regionalSegments: Float32Array,
  localSegments: Float32Array
): Float32Array {
  const totalLength = orbitSegments.length + regionalSegments.length + localSegments.length;
  const unified = new Float32Array(totalLength);
  let offset = 0;
  unified.set(orbitSegments, offset);
  offset += orbitSegments.length;
  unified.set(regionalSegments, offset);
  offset += regionalSegments.length;
  unified.set(localSegments, offset);
  return unified;
}

// ============================================================================
// Dynamic Slippy-Tile Vector Chunk Loader (Option 2B)
// ============================================================================

export interface SlippyVectorChunk {
  key: string;
  zoom: number;
  tileX: number;
  tileY: number;
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  segments: Float32Array;
  segmentCount: number;
  lastUsedTime: number;
}

function packSlippyVectorSegment(
  out: number[],
  lonA: number,
  latA: number,
  lonB: number,
  latB: number,
  vType: number,
  order: number
): void {
  const phiA = latA * DEG2RAD;
  const lamA = lonA * DEG2RAD;
  const cosPhiA = Math.cos(phiA);
  const xA = RADIUS * cosPhiA * Math.sin(lamA);
  const yA = RADIUS * Math.sin(phiA);
  const zA = RADIUS * cosPhiA * Math.cos(lamA);
  const [uA, vA] = projectToMercator(lonA, latA, 5.0);

  const phiB = latB * DEG2RAD;
  const lamB = lonB * DEG2RAD;
  const cosPhiB = Math.cos(phiB);
  const xB = RADIUS * cosPhiB * Math.sin(lamB);
  const yB = RADIUS * Math.sin(phiB);
  const zB = RADIUS * cosPhiB * Math.cos(lamB);
  const [uB, vB] = projectToMercator(lonB, latB, 5.0);

  out.push(
    xA, yA, zA, vType,
    uA, vA, TIER_TAG_LOCAL, order,
    xB, yB, zB, vType,
    uB, vB, TIER_TAG_LOCAL, order
  );
}

/**
 * Extracts high-resolution sub-pixel shoreline (Marching Squares contour aligned
 * with GPUTileCache / crust_hydrosphere.wgsl isLand = 0.50 datum)
 * directly from a 256x256 equirectangular-reprojected
 * slippy DEM tile grid, producing zero-chord-artifact TIER_TAG_LOCAL vector segments.
 */
export function extractSlippyTileVectorChunk(
  zoom: number,
  tileX: number,
  tileY: number,
  bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number },
  demGrid: Float32Array,
  gridSize: number = 256
): SlippyVectorChunk {
  const key = `${zoom}/${tileX}/${tileY}`;
  const { minLon, maxLon, minLat, maxLat } = bounds;
  const lonSpan = maxLon - minLon;
  const latSpan = maxLat - minLat;
  const outFloats: number[] = [];

  if (demGrid && demGrid.length >= gridSize * gridSize && lonSpan > 0 && latSpan > 0) {
    const invMax = 1.0 / (gridSize - 1);
    const iso = 0.85;

    // 1. Sub-pixel Marching Squares shoreline contour extraction across full welded tile grid
    for (let r = 0; r < gridSize - 1; r++) {
      const lat0 = maxLat - r * invMax * latSpan;
      const lat1 = maxLat - (r + 1) * invMax * latSpan;
      const row0 = r * gridSize;
      const row1 = (r + 1) * gridSize;

      for (let c = 0; c < gridSize - 1; c++) {
        const v00 = demGrid[row0 + c];
        const v10 = demGrid[row0 + c + 1];
        const v11 = demGrid[row1 + c + 1];
        const v01 = demGrid[row1 + c];

        let mask = 0;
        if (v00 >= iso) mask |= 1;
        if (v10 >= iso) mask |= 2;
        if (v11 >= iso) mask |= 4;
        if (v01 >= iso) mask |= 8;
        if (mask === 0 || mask === 15) continue;

        // Guard against artificial open-water 0.0m tile cutouts and submerged intertidal flats
        const maxCorner = Math.max(v00, v10, v11, v01);
        const minCorner = Math.min(v00, v10, v11, v01);
        if (maxCorner < 1.50 || minCorner > 0.15) continue;

        const lon0 = minLon + c * invMax * lonSpan;
        const lon1 = minLon + (c + 1) * invMax * lonSpan;

        const interp = (a: number, b: number) => {
          const denom = a - b;
          return Math.abs(denom) > 1e-5 ? Math.max(0.0, Math.min(1.0, (a - iso) / denom)) : 0.5;
        };

        // Edges: 0 = top (v00..v10), 1 = right (v10..v11), 2 = bottom (v01..v11), 3 = left (v00..v01)
        const edgeLon = [
          lon0 + interp(v00, v10) * (lon1 - lon0),
          lon1,
          lon0 + interp(v01, v11) * (lon1 - lon0),
          lon0,
        ];
        const edgeLat = [
          lat0,
          lat0 + interp(v10, v11) * (lat1 - lat0),
          lat1,
          lat0 + interp(v00, v01) * (lat1 - lat0),
        ];

        const emitEdgePair = (eA: number, eB: number) => {
          packSlippyVectorSegment(
            outFloats,
            edgeLon[eA],
            edgeLat[eA],
            edgeLon[eB],
            edgeLat[eB],
            1.0,
            1.0
          );
        };

        switch (mask) {
          case 1:
          case 14:
            emitEdgePair(3, 0);
            break;
          case 2:
          case 13:
            emitEdgePair(0, 1);
            break;
          case 3:
          case 12:
            emitEdgePair(3, 1);
            break;
          case 4:
          case 11:
            emitEdgePair(1, 2);
            break;
          case 6:
          case 9:
            emitEdgePair(0, 2);
            break;
          case 7:
          case 8:
            emitEdgePair(3, 2);
            break;
          case 5:
            emitEdgePair(3, 2);
            emitEdgePair(0, 1);
            break;
          case 10:
            emitEdgePair(3, 0);
            emitEdgePair(2, 1);
            break;
        }
      }
    }
  }

  const segments = new Float32Array(outFloats);
  return {
    key,
    zoom,
    tileX,
    tileY,
    minLon,
    maxLon,
    minLat,
    maxLat,
    segments,
    segmentCount: Math.floor(segments.length / 16),
    lastUsedTime: Date.now(),
  };
}

export class SlippyVectorChunkLoader {
  private cache: Map<string, SlippyVectorChunk> = new Map();
  private inFlight: Map<string, Promise<SlippyVectorChunk | null>> = new Map();
  private maxChunks: number;

  constructor(maxChunks: number = 64) {
    this.maxChunks = Math.max(4, maxChunks);
  }

  public getCachedChunk(key: string): SlippyVectorChunk | undefined {
    const chunk = this.cache.get(key);
    if (chunk) {
      chunk.lastUsedTime = Date.now();
    }
    return chunk;
  }

  public getCachedChunkCount(): number {
    return this.cache.size;
  }

  public getInFlightCount(): number {
    return this.inFlight.size;
  }

  public clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  private evictIfNeeded(): void {
    while (this.cache.size > this.maxChunks) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache.entries()) {
        if (v.lastUsedTime < oldestTime) {
          oldestTime = v.lastUsedTime;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) {
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  /**
   * Loads a slippy-tile vector chunk from cache, remote vector-tile endpoint (if enabled),
   * or extracts sub-pixel shoreline & hydrographic vectors directly from the tile's DEM grid.
   */
  public async loadOrExtractTileChunk(
    zoom: number,
    tileX: number,
    tileY: number,
    bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number },
    demGrid?: Float32Array,
    remoteUrlTemplate?: string
  ): Promise<SlippyVectorChunk | null> {
    const key = `${zoom}/${tileX}/${tileY}`;
    const existing = this.cache.get(key);
    if (existing) {
      existing.lastUsedTime = Date.now();
      return existing;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const task = (async (): Promise<SlippyVectorChunk | null> => {
      try {
        if (remoteUrlTemplate && typeof fetch === 'function') {
          const url = remoteUrlTemplate
            .replace('{z}', String(zoom))
            .replace('{x}', String(tileX))
            .replace('{y}', String(tileY));
          try {
            const resp = await fetch(url);
            if (resp.ok) {
              const buf = await resp.arrayBuffer();
              if (buf.byteLength >= 64 && buf.byteLength % 64 === 0) {
                const segs = new Float32Array(buf);
                const chunk: SlippyVectorChunk = {
                  key,
                  zoom,
                  tileX,
                  tileY,
                  minLon: bounds.minLon,
                  maxLon: bounds.maxLon,
                  minLat: bounds.minLat,
                  maxLat: bounds.maxLat,
                  segments: segs,
                  segmentCount: Math.floor(segs.length / 16),
                  lastUsedTime: Date.now(),
                };
                this.cache.set(key, chunk);
                this.evictIfNeeded();
                return chunk;
              }
            }
          } catch {
            // Fall through to DEM contour extraction
          }
        }

        if (demGrid && demGrid.length > 0) {
          const chunk = extractSlippyTileVectorChunk(zoom, tileX, tileY, bounds, demGrid);
          this.cache.set(key, chunk);
          this.evictIfNeeded();
          return chunk;
        }
        return null;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, task);
    return task;
  }

  /**
   * Synchronously ingests a slippy DEM tile grid and updates the LRU vector chunk cache.
   */
  public ingestDemTileSync(
    zoom: number,
    tileX: number,
    tileY: number,
    bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number },
    demGrid: Float32Array,
    gridSize: number = 256
  ): SlippyVectorChunk {
    const key = `${zoom}/${tileX}/${tileY}`;
    const existing = this.cache.get(key);
    if (existing) {
      existing.lastUsedTime = Date.now();
      return existing;
    }
    const chunk = extractSlippyTileVectorChunk(zoom, tileX, tileY, bounds, demGrid, gridSize);
    this.cache.set(key, chunk);
    this.evictIfNeeded();
    return chunk;
  }

  /**
   * Packs active cached slippy-tile vector chunks into a single contiguous Float32Array
   * ready for zero-GC GPU vertex buffer upload.
   */
  public assembleActiveChunkBuffer(activeKeys?: Iterable<string>): Float32Array {
    const chunks: SlippyVectorChunk[] = [];
    let totalFloats = 0;

    if (activeKeys) {
      for (const k of activeKeys) {
        const c = this.cache.get(k);
        if (c && c.segments.length > 0) {
          chunks.push(c);
          totalFloats += c.segments.length;
        }
      }
    } else {
      for (const c of this.cache.values()) {
        if (c.segments.length > 0) {
          chunks.push(c);
          totalFloats += c.segments.length;
        }
      }
    }

    const out = new Float32Array(totalFloats);
    let offset = 0;
    for (const c of chunks) {
      out.set(c.segments, offset);
      offset += c.segments.length;
    }
    return out;
  }
}

