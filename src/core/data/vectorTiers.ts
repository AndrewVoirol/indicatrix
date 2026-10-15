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

  // 1. Gather river segments and count coastline vertices
  const riverSegs: number[] = [];
  let coastCount = 0;
  for (let k = 0; k < totalSegs; k++) {
    const base = k * 16;
    if (segFloats[base + 3] < 0.75) {
      riverSegs.push(k);
    } else {
      coastCount++;
    }
  }

  const riverCount = riverSegs.length;
  if (riverCount === 0) return segFloats;

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

  // 4. Connected components
  const compOf = new Int32Array(numNodes).fill(-1);
  const compNodes: number[][] = [];
  const q = new Int32Array(numNodes);

  for (let i = 0; i < numNodes; i++) {
    if (compOf[i] === -1) {
      const cId = compNodes.length;
      let qHead = 0;
      let qTail = 0;
      q[qTail++] = i;
      compOf[i] = cId;
      const nodes: number[] = [];

      while (qHead < qTail) {
        const curr = q[qHead++];
        nodes.push(curr);
        const start = head[curr];
        const end = head[curr + 1];
        for (let e = start; e < end; e++) {
          const nbr = adjNbr[e];
          if (compOf[nbr] === -1) {
            compOf[nbr] = cId;
            q[qTail++] = nbr;
          }
        }
      }
      compNodes.push(nodes);
    }
  }

  // 5. Spatial indexing for robust ocean outlet and inland confluence detection
  // 5a. Coastline spatial grid (if coastlines are available)
  let coastGrid: Map<number, number[]> | null = null;
  if (coastCount > 0) {
    coastGrid = new Map<number, number[]>();
    for (let k = 0; k < totalSegs; k++) {
      const base = k * 16;
      if (segFloats[base + 3] >= 0.75) {
        const cx = segFloats[base + 0];
        const cy = segFloats[base + 1];
        const cz = segFloats[base + 2];
        const gk = ((Math.floor(cx * 5) + 512) & 1023) | (((Math.floor(cy * 5) + 512) & 1023) << 10) | (((Math.floor(cz * 5) + 512) & 1023) << 20);
        let list = coastGrid.get(gk);
        if (!list) {
          list = [];
          coastGrid.set(gk, list);
        }
        list.push(cx, cy, cz);
      }
    }
  }

  function distToCoast(x: number, y: number, z: number): number {
    if (!coastGrid) return Infinity;
    const gx = Math.floor(x * 5);
    const gy = Math.floor(y * 5);
    const gz = Math.floor(z * 5);
    let minD2 = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const gk = ((gx + dx + 512) & 1023) | (((gy + dy + 512) & 1023) << 10) | (((gz + dz + 512) & 1023) << 20);
          const list = coastGrid.get(gk);
          if (list) {
            for (let p = 0; p < list.length; p += 3) {
              const d2 = (list[p] - x) ** 2 + (list[p + 1] - y) ** 2 + (list[p + 2] - z) ** 2;
              if (d2 < minD2) minD2 = d2;
            }
          }
        }
      }
    }
    return Math.sqrt(minD2);
  }

  // 5b. River leaves spatial grid to detect inland confluence endpoints
  const leafGrid = new Map<number, number[]>();
  for (let i = 0; i < numNodes; i++) {
    if (deg[i] === 1) {
      const lx = nodeX[i];
      const ly = nodeY[i];
      const lz = nodeZ[i];
      const gk = ((Math.floor(lx * 10) + 512) & 1023) | (((Math.floor(ly * 10) + 512) & 1023) << 10) | (((Math.floor(lz * 10) + 512) & 1023) << 20);
      let list = leafGrid.get(gk);
      if (!list) {
        list = [];
        leafGrid.set(gk, list);
      }
      list.push(i, compOf[i], lx, ly, lz);
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
          const list = leafGrid.get(gk);
          if (list) {
            for (let p = 0; p < list.length; p += 5) {
              if (list[p + 1] !== cId) {
                const d2 = (list[p + 2] - x) ** 2 + (list[p + 3] - y) ** 2 + (list[p + 4] - z) ** 2;
                if (d2 < minD2) minD2 = d2;
              }
            }
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

  for (let c = 0; c < compNodes.length; c++) {
    const cNodes = compNodes[c];
    if (cNodes.length === 1) continue;

    // Pick root (river mouth / outlet / confluence)
    let bestRoot = -1;

    // 1. Check proximity to coastline (ocean estuary)
    let minCoast = Infinity;
    for (let j = 0; j < cNodes.length; j++) {
      const u = cNodes[j];
      if (deg[u] === 1) {
        const dC = distToCoast(nodeX[u], nodeY[u], nodeZ[u]);
        if (dC < minCoast) {
          minCoast = dC;
          bestRoot = u;
        }
      }
    }

    // 2. If river does not reach ocean directly (inland tributary), find leaf closest to another river component
    if (minCoast > 0.05) {
      let minOther = Infinity;
      let bestOther = -1;
      for (let j = 0; j < cNodes.length; j++) {
        const u = cNodes[j];
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
      for (let j = 0; j < cNodes.length; j++) {
        const u = cNodes[j];
        if (deg[u] === 1 && inDeg[u] > outDeg[u]) {
          bestRoot = u;
          break;
        }
      }
    }

    // 4. Ultimate fallback: pick any leaf or first node
    if (bestRoot === -1) {
      bestRoot = cNodes[0];
      for (let j = 0; j < cNodes.length; j++) {
        if (deg[cNodes[j]] === 1) {
          bestRoot = cNodes[j];
          break;
        }
      }
    }

    // BFS tree rooted at bestRoot (so root has distance 0, headwaters are at the leaves)
    for (let j = 0; j < cNodes.length; j++) {
      const n = cNodes[j];
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
    for (let j = 0; j < cNodes.length; j++) {
      const u = cNodes[j];
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

  const subsegments: Array<{
    xA: number; yA: number; zA: number; wA: number;
    uA: number; vA: number; orderA: number;
    xB: number; yB: number; zB: number; wB: number;
    uB: number; vB: number; orderB: number;
  }> = [];

  for (let k = 0; k < inSegCount; k++) {
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

    // Compute angular span theta between endpoints
    const lenA = Math.hypot(xA, yA, zA);
    const lenB = Math.hypot(xB, yB, zB);
    if (lenA < 0.001 || lenB < 0.001) continue;

    // Detect antimeridian cross-seam chord in 2D Mercator space (|du| > pi * RADIUS * 0.95)
    const isCrossSeam = Math.abs(uA - uB) > Math.PI * RADIUS * 0.95;

    const dot = (xA * xB + yA * yB + zA * zB) / (lenA * lenB);
    const clampedDot = Math.max(-1.0, Math.min(1.0, dot));
    const theta = Math.acos(clampedDot);
    const chordKm = theta * EARTH_RADIUS_KM;

    if (chordKm <= maxChordKm || theta < 0.0001 || isCrossSeam) {
      // Retain segment as-is (cross-seam preserved intact so WGSL antimeridian severance culls it)
      subsegments.push({ xA, yA, zA, wA, uA, vA, orderA, xB, yB, zB, wB, uB, vB, orderB });
    } else {
      // Subdivide into N geodesic segments
      const N = Math.min(maxSubdivisions, Math.max(2, Math.ceil(chordKm / maxChordKm)));
      const sinTheta = Math.sqrt(Math.max(1e-12, 1.0 - clampedDot * clampedDot));

      const invLenA = RADIUS / lenA;
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
          const [projU, projV] = projectToMercator(currLon * RAD2DEG, currLat * RAD2DEG, RADIUS);
          currU = projU;
          currV = projV;
        }

        subsegments.push({
          xA: prevX, yA: prevY, zA: prevZ, wA: prevW,
          uA: prevU, vA: prevV, orderA: prevOrder,
          xB: currX, yB: currY, zB: currZ, wB: currW,
          uB: currU, vB: currV, orderB: currOrder,
        });

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

  const outCount = subsegments.length;
  const outFloats = new Float32Array(outCount * 16);

  for (let k = 0; k < outCount; k++) {
    const s = subsegments[k];
    const base = k * 16;
    outFloats[base + 0] = s.xA;
    outFloats[base + 1] = s.yA;
    outFloats[base + 2] = s.zA;
    outFloats[base + 3] = s.wA;
    outFloats[base + 4] = s.uA;
    outFloats[base + 5] = s.vA;
    outFloats[base + 6] = TIER_TAG_LOCAL;
    outFloats[base + 7] = s.orderA;

    outFloats[base + 8] = s.xB;
    outFloats[base + 9] = s.yB;
    outFloats[base + 10] = s.zB;
    outFloats[base + 11] = s.wB;
    outFloats[base + 12] = s.uB;
    outFloats[base + 13] = s.vB;
    outFloats[base + 14] = TIER_TAG_LOCAL;
    outFloats[base + 15] = s.orderB;
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
