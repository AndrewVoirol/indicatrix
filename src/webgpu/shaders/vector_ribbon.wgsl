// ============================================================================
// File: src/webgpu/shaders/vector_ribbon.wgsl
// Target: WebGPU Screen-Space Anti-Aliased Vector Line Ribbon Pipeline
// Pipeline Architecture: Instanced Quad Extrusion with Homogeneous Near-Plane Guard
// Mathematical Specification: Indicatrix Engine Frontier 1 Research Specification
// ============================================================================

struct SimUniforms {
    u_unfurl: f32,
    u_mode: u32,
    u_theme: u32,             // 0 = Obsidian Dark Cyber, 1 = Light Monochrome
    u_time: f32,
    u_viewport: vec4<f32>,     // x: width_px, y: height_px, z: 1/width, w: 1/height
    u_cameraPos: vec4<f32>,
    u_cursorHitPos: vec4<f32>,
    u_cursorVel: vec4<f32>,    // xyz: vel, w: speed
    u_cursorActive: f32,
    u_displacementScale: f32,
    u_halfWidthPx: f32,        // Nominal half-width in CSS pixels
    u_dpr: f32,                // Device Pixel Ratio (e.g. 2.0 for Retina)
    u_nearPlane: f32,          // Near clipping distance (e.g. 0.1)
    u_peakExponent: f32,       // Peak exponent matching crust_hydrosphere.wgsl
    u_seaLevel: f32,           // Dynamic sea level in meters
    u_pad2: f32,
    u_viewMatrix: mat4x4<f32>,
    u_projectionMatrix: mat4x4<f32>,
    u_vectorTierOverride: f32, // 0.0 = auto, 1.0 = orbit, 2.0 = regional, 3.0 = local
    _padRte0_1: f32,
    _padRte0_2: f32,
    _padRte0_3: f32,
    _padRte1: vec4<f32>,
    _padRte2: vec4<f32>,
    _padRte3: vec4<f32>,
    _padRte4: vec4<f32>,
    u_cameraPosHigh: vec4<f32>,
    u_cameraPosLow: vec4<f32>,
    u_viewProjectionMatrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> sim: SimUniforms;
@group(0) @binding(1) var u_demTexture: texture_2d<f32>;
@group(0) @binding(2) var u_demSampler: sampler;
@group(0) @binding(3) var u_regionalDEMTexture: texture_2d<f32>;

struct RegionalOverlayUniforms {
    u_regionalBounds: vec4<f32>,
    u_pad0: vec4<f32>,
    u_pad1: vec4<f32>,
    u_regionalActive: u32,
    u_pad2: u32,
    u_pad3: u32,
    u_pad4: u32,
};

@group(0) @binding(4) var<uniform> u_regionalOverlay: RegionalOverlayUniforms;

struct TileSlotDescriptor {
    bounds: vec4<f32>, // x: minLon, y: minLat, z: maxLon, w: maxLat
    tileMeta: vec4<f32>,   // x: lod + edgeMask * 64.0, y: slotIndex, z: uvScaleX, w: uvScaleY
};

@group(0) @binding(5) var u_tileCacheArray: texture_2d_array<f32>;
@group(0) @binding(6) var<storage, read> u_tileSlots: array<TileSlotDescriptor>;

// ----------------------------------------------------------------------------
// Vertex Input Structs
// Quad Base Geometry: 4 vertices per quad (Instanced Drawing)
// ----------------------------------------------------------------------------
struct VertexInput {
    // Instanced Quad Corner (Location 0)
    // x: u in [0, 1] (longitudinal), y: v in [-1, +1] (lateral)
    @location(0) corner: vec2<f32>,

    // Per-Segment Instance Attributes
    @location(1) posA_3d: vec4<f32>,         // xyz: sphere pos, w: pointType (0=river, 1=coast)
    @location(2) posA_target2d: vec4<f32>,   // xy: Mercator 2D, z: tierTag (1=orbit, 2=regional, 3=local), w: streamOrderA (1..8)
    @location(3) posB_3d: vec4<f32>,         // xyz: sphere pos, w: pointType
    @location(4) posB_target2d: vec4<f32>,   // xy: Mercator 2D, z: tierTag, w: streamOrderB (1..8)
};

struct VertexOutput {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) uv: vec2<f32>,              // x: normalized longitudinal, y: normalized lateral
    @location(1) uCapExcess: f32,            // longitudinal cap extension ratio
    @location(2) pointType: f32,
    @location(3) facing: f32,
    @location(4) alphaPeak: f32,             // Subpixel radiometric energy attenuation
};

// ----------------------------------------------------------------------------
// Analytical 3D Solenoidal Curl Noise (div u = 0 guaranteed)
// ----------------------------------------------------------------------------
fn getRegionalBlendWeight(uv: vec2<f32>) -> f32 {
    let lon = uv.x * 360.0 - 180.0;
    let lat = 90.0 - uv.y * 180.0;

    var bestTileWeight: f32 = 0.0;
    let cBounds = u_regionalOverlay.u_pad1;
    let hasClusterBounds = cBounds.z > cBounds.x && cBounds.w > cBounds.y;
    let inTileCluster = !hasClusterBounds || (lon >= cBounds.x && lon <= cBounds.z && lat >= cBounds.y && lat <= cBounds.w);
    let slotCount = select(0u, min(u_regionalOverlay.u_pad3, 64u), inTileCluster);
    let gridF = max(1.0, round(sqrt(f32(slotCount))));
    let gridN = u32(gridF);
    let relX = clamp((lon - cBounds.x) / max(1e-5, cBounds.z - cBounds.x), 0.0, 0.99999);
    let relY = clamp((cBounds.w - lat) / max(1e-5, cBounds.w - cBounds.y), 0.0, 0.99999);
    let guessIdx = select(0u, min(slotCount - 1u, u32(floor(relY * gridF)) * gridN + u32(floor(relX * gridF))), slotCount > 0u);
    for (var step: u32 = 0u; step < slotCount; step = step + 1u) {
        let i = select(select(step, step - 1u, step <= guessIdx), guessIdx, step == 0u);
        let slot = u_tileSlots[i];
        let b = slot.bounds;
        if (lon >= b.x && lon <= b.z && lat >= b.y && lat <= b.w && b.z > b.x && b.w > b.y) {
            let tileU = (lon - b.x) / (b.z - b.x);
            let tileV = (b.w - lat) / (b.w - b.y);
            let edgeMask = u32(floor(slot.tileMeta.x / 64.0));
            let blendDeg = 0.05;
            let marginU = clamp(blendDeg / (b.z - b.x), 0.001, 0.49);
            let marginV = clamp(blendDeg / (b.w - b.y), 0.001, 0.49);

            let wWest  = select(smoothstep(0.0, marginU, tileU), 1.0, (edgeMask & 1u) != 0u);
            let wEast  = select(smoothstep(0.0, marginU, 1.0 - tileU), 1.0, (edgeMask & 4u) != 0u);
            let wNorth = select(smoothstep(0.0, marginV, tileV), 1.0, (edgeMask & 8u) != 0u);
            let wSouth = select(smoothstep(0.0, marginV, 1.0 - tileV), 1.0, (edgeMask & 2u) != 0u);

            let slotWeight = min(wWest, wEast) * min(wNorth, wSouth);
            bestTileWeight = max(bestTileWeight, slotWeight);
            break;
        }
    }

    if (u_regionalOverlay.u_regionalActive != 1u) {
        return bestTileWeight;
    }

    let bounds = u_regionalOverlay.u_regionalBounds;
    let minLon = bounds.x;
    let minLat = bounds.y;
    let maxLon = bounds.z;
    let maxLat = bounds.w;

    // Strict bounds validation: require non-inverted valid geographic coordinates
    if (minLon >= maxLon || minLat >= maxLat ||
        minLat < -90.0 || maxLat > 90.0 ||
        minLon < -180.0 || maxLon > 180.0) {
        return bestTileWeight;
    }

    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) {
        return bestTileWeight;
    }

    let regU = (lon - minLon) / (maxLon - minLon);
    let regV = (maxLat - lat) / (maxLat - minLat);

    let blendDeg = 0.05;
    let lonSpan = maxLon - minLon;
    let latSpan = maxLat - minLat;
    let marginU = clamp(blendDeg / lonSpan, 0.001, 0.49);
    let marginV = clamp(blendDeg / latSpan, 0.001, 0.49);

    let distU = min(regU, 1.0 - regU);
    let distV = min(regV, 1.0 - regV);

    let weightU = smoothstep(0.0, marginU, distU);
    let weightV = smoothstep(0.0, marginV, distV);
    return max(bestTileWeight, weightU * weightV);
}

fn sampleRegionalComposite(uv: vec2<f32>, globalSample: vec4<f32>, lod: f32) -> vec4<f32> {
    let lon = uv.x * 360.0 - 180.0;
    let lat = 90.0 - uv.y * 180.0;
    var compositeSample = globalSample;

    if (u_regionalOverlay.u_regionalActive == 1u) {
        let bounds = u_regionalOverlay.u_regionalBounds;
        let minLon = bounds.x;
        let minLat = bounds.y;
        let maxLon = bounds.z;
        let maxLat = bounds.w;
        if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat && maxLon > minLon && maxLat > minLat) {
            let regU = clamp((lon - minLon) / (maxLon - minLon), 0.0, 1.0);
            let regV = clamp((maxLat - lat) / (maxLat - minLat), 0.0, 1.0);
            let blendDeg = 0.05;
            let marginU = clamp(blendDeg / (maxLon - minLon), 0.001, 0.49);
            let marginV = clamp(blendDeg / (maxLat - minLat), 0.001, 0.49);
            let regW = smoothstep(0.0, marginU, min(regU, 1.0 - regU)) * smoothstep(0.0, marginV, min(regV, 1.0 - regV));
            let regSample = textureSampleLevel(u_regionalDEMTexture, u_demSampler, vec2<f32>(regU, regV), lod);
            compositeSample = mix(compositeSample, regSample, regW);
            return compositeSample;
        }
    }

    let cBounds = u_regionalOverlay.u_pad1;
    let hasClusterBounds = cBounds.z > cBounds.x && cBounds.w > cBounds.y;
    let inTileCluster = !hasClusterBounds || (lon >= cBounds.x && lon <= cBounds.z && lat >= cBounds.y && lat <= cBounds.w);
    let slotCount = select(0u, min(u_regionalOverlay.u_pad3, 64u), inTileCluster);
    let gridF = max(1.0, round(sqrt(f32(slotCount))));
    let gridN = u32(gridF);
    let relX = clamp((lon - cBounds.x) / max(1e-5, cBounds.z - cBounds.x), 0.0, 0.99999);
    let relY = clamp((cBounds.w - lat) / max(1e-5, cBounds.w - cBounds.y), 0.0, 0.99999);
    let guessIdx = select(0u, min(slotCount - 1u, u32(floor(relY * gridF)) * gridN + u32(floor(relX * gridF))), slotCount > 0u);
    for (var step: u32 = 0u; step < slotCount; step = step + 1u) {
        let i = select(select(step, step - 1u, step <= guessIdx), guessIdx, step == 0u);
        let slot = u_tileSlots[i];
        let b = slot.bounds;
        if (lon >= b.x && lon <= b.z && lat >= b.y && lat <= b.w && b.z > b.x && b.w > b.y) {
            let tileU = clamp((lon - b.x) / (b.z - b.x), 0.0, 1.0);
            let tileV = clamp((b.w - lat) / (b.w - b.y), 0.0, 1.0);
            let edgeMask = u32(floor(slot.tileMeta.x / 64.0));
            let blendDeg = 0.05;
            let marginU = clamp(blendDeg / (b.z - b.x), 0.001, 0.49);
            let marginV = clamp(blendDeg / (b.w - b.y), 0.001, 0.49);

            let wWest  = select(smoothstep(0.0, marginU, tileU), 1.0, (edgeMask & 1u) != 0u);
            let wEast  = select(smoothstep(0.0, marginU, 1.0 - tileU), 1.0, (edgeMask & 4u) != 0u);
            let wNorth = select(smoothstep(0.0, marginV, tileV), 1.0, (edgeMask & 8u) != 0u);
            let wSouth = select(smoothstep(0.0, marginV, 1.0 - tileV), 1.0, (edgeMask & 2u) != 0u);
            let slotWeight = min(wWest, wEast) * min(wNorth, wSouth);

            let effCols = max(1.0, slot.tileMeta.z * 256.0);
            let effRows = max(1.0, slot.tileMeta.w * 256.0);
            let sampU = (0.5 + tileU * (effCols - 1.0)) / 256.0;
            let sampV = (0.5 + tileV * (effRows - 1.0)) / 256.0;
            let tileSample = textureSampleLevel(u_tileCacheArray, u_demSampler, vec2<f32>(sampU, sampV), i32(slot.tileMeta.y), 0.0);
            let tileLandGate = smoothstep(0.35, 0.65, globalSample.b);
            compositeSample = mix(compositeSample, tileSample, slotWeight * tileLandGate);
            break;
        }
    }

    return compositeSample;
}

fn applyVectorDisplacement(basePos: vec3<f32>, baseNormal: vec3<f32>, pointType: f32, restPos3D: vec3<f32>) -> vec3<f32> {
    let curR = RADIUS;
    let lambda = atan2(restPos3D.x, restPos3D.z);
    let phi = asin(clamp(restPos3D.y / curR, -0.9998, 0.9998));
    let demUv = vec2<f32>((lambda + PI) / (2.0 * PI), 0.5 - phi / PI);
    let patchDist = length(sim.u_cameraPos.xyz - basePos);
    let patchLOD = clamp(log2(max(1.0, patchDist * 0.2)), 0.0, 4.0);
    let demSampleGlobal = textureSampleLevel(u_demTexture, u_demSampler, demUv, patchLOD);
    let demSample = sampleRegionalComposite(demUv, demSampleGlobal, patchLOD);

    let poleDist = abs(demUv.y - 0.5) * 2.0;
    let poleAtten = 1.0 - smoothstep(0.85, 0.98, poleDist);
    let elevMeters = demSample.a * 19772.0 - 10924.0;
    var normalDisplacement: f32 = 0.0;
    let dispScale = sim.u_displacementScale * 2.8;

    let exponent = select(1.0, clamp(sim.u_peakExponent, 0.2, 4.0), sim.u_peakExponent > 0.01);
    if (sim.u_pad2 > 0.5) {
        if (elevMeters >= 0.0) {
            let logNormH = log(1.0 + elevMeters / 1200.0) / log(1.0 + 8848.0 / 1200.0);
            let expLogNormH = pow(clamp(logNormH, 0.0, 1.0), exponent);
            normalDisplacement = expLogNormH * dispScale * poleAtten;
        } else {
            let logNormD = log(1.0 + (-elevMeters) / 1500.0) / log(1.0 + 10924.0 / 1500.0);
            normalDisplacement = -logNormD * dispScale * poleAtten;
        }
    } else {
        if (elevMeters >= 0.0) {
            let normH = elevMeters / 8848.0;
            let expNormH = pow(clamp(normH, 0.0, 1.0), exponent);
            normalDisplacement = expNormH * dispScale * poleAtten;
        } else {
            let normD = clamp(-elevMeters / 10924.0, 0.0, 1.0);
            let shelfD = normD / (1.0 + 1.5 * (1.0 - normD));
            normalDisplacement = -shelfD * dispScale * poleAtten;
        }
    }

    let viewDir = normalize(sim.u_cameraPos.xyz - basePos);
    let facing = dot(baseNormal, viewDir);
    let globeWeight = 1.0 - smoothstep(0.0, 0.05, sim.u_unfurl);
    let limbAtten = mix(1.0, smoothstep(0.000, 0.005, facing), globeWeight);
    if (normalDisplacement < 0.0) {
        normalDisplacement = normalDisplacement * limbAtten;
    }

    // Eliminated 0.025 normal standoff: set standoff = 0.0 to conform directly to terrain surface without floating spikes
    let standoff = 0.0;
    return basePos + baseNormal * (normalDisplacement + standoff);
}

// ----------------------------------------------------------------------------
// Vertex Shader: Screen-Space Quad Extrusion with Analytical Near-Plane Guard
// ----------------------------------------------------------------------------
@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;

    // Antimeridian line severance: cull cross-seam wrapping segments
    if (abs(in.posA_target2d.x - in.posB_target2d.x) > PI * RADIUS) {
        out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 0.0);
        return out;
    }

    // 1. Manifold Deformations
    let normPosA = normalize(in.posA_3d.xyz) * RADIUS;
    let defA = evaluateManifoldCore(
        normPosA, in.posA_target2d.xy,
        sim.u_unfurl, sim.u_mode, sim.u_time,
        sim.u_cursorHitPos, sim.u_cursorActive, sim.u_cursorVel
    );
    let dispPosA = applyVectorDisplacement(defA.pos, defA.normal, in.posA_3d.w, normPosA);

    let normPosB = normalize(in.posB_3d.xyz) * RADIUS;
    let defB = evaluateManifoldCore(
        normPosB, in.posB_target2d.xy,
        sim.u_unfurl, sim.u_mode, sim.u_time,
        sim.u_cursorHitPos, sim.u_cursorActive, sim.u_cursorVel
    );
    let dispPosB = applyVectorDisplacement(defB.pos, defB.normal, in.posB_3d.w, normPosB);

    // Compute view-space positions, normals, and horizon facing for both endpoints
    let viewPosA = sim.u_viewMatrix * vec4<f32>(dispPosA, 1.0);
    let viewNormalA = normalize((sim.u_viewMatrix * vec4<f32>(defA.normal, 0.0)).xyz);
    let facingA = dot(viewNormalA, -normalize(viewPosA.xyz));

    let viewPosB = sim.u_viewMatrix * vec4<f32>(dispPosB, 1.0);
    let viewNormalB = normalize((sim.u_viewMatrix * vec4<f32>(defB.normal, 0.0)).xyz);
    let facingB = dot(viewNormalB, -normalize(viewPosB.xyz));

    let sphereFactor = 1.0 - smoothstep(0.0, 0.35, sim.u_unfurl);

    // Early-out backface culling on spherical globe: if both endpoints are behind the horizon limb, cull segment completely
    if (sphereFactor > 0.5 && facingA < 0.0 && facingB < 0.0) {
        out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 0.0); // Degenerate cull
        return out;
    }

    // 2. Homogeneous Clip-Space Coordinates
    var clipA = sim.u_projectionMatrix * viewPosA;
    var clipB = sim.u_projectionMatrix * viewPosB;

    let nearGuard = max(sim.u_nearPlane, 0.00002);

    // 3. Analytical Near-Plane Guard (w_c >= nearGuard)
    let wA_ok = clipA.w >= nearGuard;
    let wB_ok = clipB.w >= nearGuard;

    // Early-out if segment lies completely behind the camera near plane
    if (!wA_ok && !wB_ok) {
        out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 0.0); // Degenerate cull
        return out;
    }

    // Analytical line clipping against homogeneous plane w = nearGuard
    var uA_param: f32 = 0.0;
    var uB_param: f32 = 1.0;

    if (!wA_ok && wB_ok) {
        let tClip = (nearGuard - clipA.w) / (clipB.w - clipA.w);
        clipA = mix(clipA, clipB, tClip);
        clipA.w = nearGuard;
        uA_param = tClip;
    } else if (wA_ok && !wB_ok) {
        let tClip = (nearGuard - clipA.w) / (clipB.w - clipA.w);
        clipB = mix(clipA, clipB, tClip);
        clipB.w = nearGuard;
        uB_param = tClip;
    }

    // 4. Perspective Division to NDC Space
    let ndcA = clipA.xy / clipA.w;
    let ndcB = clipB.xy / clipB.w;

    // 5. Transformation to Physical Screen Pixels
    let halfVp = sim.u_viewport.xy * 0.5;
    let pxA = vec2<f32>((ndcA.x + 1.0) * halfVp.x, (1.0 - ndcA.y) * halfVp.y);
    let pxB = vec2<f32>((ndcB.x + 1.0) * halfVp.x, (1.0 - ndcB.y) * halfVp.y);

    let deltaPx = pxB - pxA;
    let lenPx = length(deltaPx);

    let camDist = mix(length(sim.u_cameraPos.xyz), 5.0 + abs(sim.u_cameraPos.z), clamp(sim.u_unfurl, 0.0, 1.0));

    // ------------------------------------------------------------------------
    // Multi-Scale Natural Earth Vector Tiers & LOD Switching (M13-P2-T1)
    // Tier 1.0 (Orbit): 1:110M generalized boundaries (camDist >= 11.5)
    // Tier 2.0 (Regional): 1:10M standard vectors (5.8 <= camDist < 14.0)
    // Tier 3.0 (Local): High-detail densified geometry (camDist <= 6.8)
    // Tier 0.0: Legacy / unpartitioned dataset (always visible)
    // ------------------------------------------------------------------------
    let tierTag = in.posA_target2d.z;
    var tierVisibility: f32 = 1.0;
    if (tierTag > 0.5) {
        if (sim.u_vectorTierOverride > 0.5) {
            // Manual tier override forced by UI / engine parameter
            if (sim.u_vectorTierOverride < 1.5) {
                // Forced Orbit
                tierVisibility = select(0.0, 1.0, tierTag < 1.5);
            } else if (sim.u_vectorTierOverride < 2.5) {
                // Forced Regional
                tierVisibility = select(0.0, 1.0, tierTag >= 1.5 && tierTag < 2.5);
            } else {
                // Forced Local
                tierVisibility = select(0.0, 1.0, tierTag >= 2.5);
            }
        } else {
            // Auto LOD switching with smooth cross-fading
            if (tierTag < 1.5) {
                // Orbit Tier (1:110M generalized boundaries)
                tierVisibility = smoothstep(10.5, 13.5, camDist);
            } else if (tierTag < 2.5) {
                // Regional Tier (1:10M standard vectors)
                let fadeIn = 1.0 - smoothstep(12.0, 14.0, camDist);
                let fadeOut = smoothstep(5.6, 6.8, camDist);
                tierVisibility = fadeIn * fadeOut;
            } else {
                // Local / High-detail Tier (dense coastline and hydrographic segments)
                tierVisibility = 1.0 - smoothstep(5.6, 6.8, camDist);
            }
        }

        if (tierVisibility <= 0.005) {
            out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 0.0);
            return out;
        }
    }

    // 5.5 Hydrological River Hierarchy Zoom Gating
    // Orbit (camDist > 16.0): Render only Orders 6-8 (continental arteries)
    // Regional (8.0 < camDist <= 16.0): Render Orders 4-8 (regional rivers & trunks)
    // Local (camDist <= 8.0): Render Orders 1-8 (all rivers down to headwater rills)
    let isRiver = in.posA_3d.w < 0.75;
    var riverLODVisibility = 1.0;

    let rawOrderA = in.posA_target2d.w;
    let rawOrderB = in.posB_target2d.w;
    let maxOrder = max(rawOrderA, rawOrderB);
    let segOrder = clamp(select(maxOrder, 5.0, maxOrder <= 0.01), 1.0, 8.0);

    if (isRiver) {
        if (segOrder < 3.5) {
            // Orders 1-3 (Headwaters and rills): Local zoom only (camDist <= 8.0)
            riverLODVisibility = 1.0 - smoothstep(7.0, 8.5, camDist);
        } else if (segOrder < 5.5) {
            // Orders 4-5 (Regional rivers & tributaries): Regional and Local (camDist <= 16.0)
            riverLODVisibility = 1.0 - smoothstep(14.5, 16.5, camDist);
        } else {
            // Orders 6-8 (Major continental trunks): All zoom levels
            riverLODVisibility = 1.0;
        }

        if (riverLODVisibility <= 0.005) {
            out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 0.0);
            return out;
        }
    } else {
        // Close-Zoom Vector-to-DEM Shoreline Handoff (M13-P2-T1):
        // At close zoom (camDist < 5.55), coarse 1:50m Natural Earth coastline chords
        // form visible straight polygon segments over high-resolution slippy DEM shorelines.
        // Smoothly hand off coarse coastline ink inside active regional/slippy DEM coverage
        // so the crisp DEM shoreline contour and hypsometric shelf transition take over.
        let midRest3D = normalize(0.5 * (in.posA_3d.xyz + in.posB_3d.xyz)) * RADIUS;
        let midLambda = atan2(midRest3D.x, midRest3D.z);
        let midPhi = asin(clamp(midRest3D.y / RADIUS, -0.9998, 0.9998));
        let midDemUv = vec2<f32>((midLambda + PI) / (2.0 * PI), 0.5 - midPhi / PI);
        let regWeight = getRegionalBlendWeight(midDemUv);
        let closeCoastFade = select(
            mix(1.0, smoothstep(5.08, 5.55, camDist), smoothstep(0.25, 0.75, regWeight)),
            1.0,
            sim._padRte0_1 > 0.5
        );
        tierVisibility = tierVisibility * closeCoastFade;
        if (tierVisibility <= 0.005) {
            out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 0.0);
            return out;
        }
    }

    // Cull segments whose projected screen-space length is under 0.25 pixels at orbital altitudes
    let projectedLenPx = lenPx;
    let isOrbit = camDist > 16.0;
    if (isOrbit && projectedLenPx < 0.35 && in.posA_3d.w < 0.75) {
        out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 0.0); // Cull subpixel river rills from orbit
        return out;
    }

    let tangent = select(vec2<f32>(1.0, 0.0), deltaPx / lenPx, lenPx > 1e-4);
    let normal = vec2<f32>(-tangent.y, tangent.x);

    // Quad corner selection: in.corner.x in [0, 1], in.corner.y in [-1, +1]
    let isEndB = in.corner.x > 0.5;
    let baseClip = select(clipA, clipB, isEndB);
    let facingEnd = select(facingA, facingB, isEndB);

    // 6. Camera-Distance-Adaptive Stroke Scaling & Subpixel Radiometric Clamping
    // Leopold-Maddock Fluvial Power-Law Scaling w(Q) = a * Q^b (b = 0.50):
    // Order 1 rill: 0.40px hairline (0.40 / 3.40 = 11.76% of coastline)
    // Order 8 continental trunk: 1.98px estuary
    let vertexOrder = clamp(select(select(rawOrderA, 5.0, rawOrderA <= 0.01), select(rawOrderB, 5.0, rawOrderB <= 0.01), isEndB), 1.0, 8.0);
    let streamOrderNorm = clamp((vertexOrder - 1.0) / 7.0, 0.0, 1.0);
    let riverWidthPx = mix(0.40, 1.98, pow(streamOrderNorm, 0.50));
    let riverWidthScale = riverWidthPx / 3.40;
    let widthScale = select(1.0, riverWidthScale, isRiver);

    // Camera-distance adaptive stroke scaling:
    // 0.45px physical/CSS stroke scaling at planetary orbit (camDist >= 25.0)
    // 1.30px regional drafting stroke at intermediate zoom (camDist ~ 8.0)
    // 0.75px fine technical drafting pen at close zoom (camDist <= 5.2)
    // Seamlessly transitions across zoom levels, preventing clunky thick strokes at close zoom
    // while preserving delicate hairline visibility and radiometric energy at orbital scale.
    let orbitT = clamp((camDist - 8.0) / (25.0 - 8.0), 0.0, 1.0);
    let targetHalfWidthCss = mix(0.65, 0.225, orbitT); // 1.30px -> 0.45px full stroke width
    let effectiveHalfWidthCss = select(targetHalfWidthCss, sim.u_halfWidthPx, sim.u_halfWidthPx > 0.001);

    // Close-zoom adaptive stroke scaling:
    // Scale down from regional drafting width (1.30px CSS / 0.65px half-width)
    // to technical drafting weight (0.75px CSS / 0.375px half-width) as camera descends to local terrain.
    let closeZoomT = clamp((camDist - 5.2) / (8.0 - 5.2), 0.0, 1.0);
    let adaptiveHalfWidthCss = mix(0.375, effectiveHalfWidthCss, closeZoomT);

    // Smooth limb horizon width taper: prevent ribbons from extruding past the planetary silhouette
    let limbTaper = mix(1.0, horizonFalloff(max(0.0, facingEnd), 0.15, 0.0, 0.08), sphereFactor);

    let nominalHalfWidthPhys = adaptiveHalfWidthCss * sim.u_dpr * widthScale;
    let geomHalfWidthPhys = max(nominalHalfWidthPhys, 0.25) * limbTaper;
    let featherPhys = 0.65 * limbTaper;
    let totalRadiusPhys = geomHalfWidthPhys + featherPhys;

    // Cap extension ratio for round caps
    let capExcess = totalRadiusPhys / max(lenPx, 1.0);

    // Longitudinal parameterization: extend unclipped ends by capExcess so round cap SDF can evaluate
    let baseU_A = select(uA_param - capExcess, uA_param, !wA_ok);
    let baseU_B = select(uB_param + capExcess, uB_param, !wB_ok);
    let baseU = select(baseU_A, baseU_B, isEndB);

    // Longitudinal and lateral screen-space displacements
    let lateralOffset = in.corner.y * totalRadiusPhys * normal;

    // Flush termination for near-plane clipped endpoints (zero longitudinal cap offset)
    let longScale = smoothstep(0.1, 1.0, lenPx);
    let longOffsetA = select(-totalRadiusPhys * tangent, vec2<f32>(0.0), !wA_ok);
    let longOffsetB = select( totalRadiusPhys * tangent, vec2<f32>(0.0), !wB_ok);
    let longitudinalOffset = select(longOffsetA, longOffsetB, isEndB) * longScale;
    let totalOffsetPx = lateralOffset + longitudinalOffset;

    // 7. Depth-Invariant Clip Offset Reconstruction (Offset * w_c)
    let offsetNdc = vec2<f32>(
        (totalOffsetPx.x / halfVp.x),
        -(totalOffsetPx.y / halfVp.y)
    );

    out.clipPos = vec4<f32>(
        baseClip.xy + offsetNdc * baseClip.w,
        baseClip.z,
        baseClip.w
    );

    // Interpolated Shading Coordinates
    out.uv = vec2<f32>(baseU, in.corner.y);
    out.uCapExcess = capExcess;
    out.pointType = select(in.posA_3d.w, in.posB_3d.w, isEndB);

    // Subpixel peak alpha attenuation to preserve radiometric flux
    // Smoothly fade vector ribbon stroke alpha as camera distance increases beyond orbit (camDist > 25.0)
    let orbitAlphaFade = 1.0 - smoothstep(25.0, 45.0, camDist);
    out.alphaPeak = min(1.0, 2.0 * nominalHalfWidthPhys) * orbitAlphaFade * tierVisibility;
    out.alphaPeak = out.alphaPeak * riverLODVisibility;

    // 8. Surface Facing & Horizon Culling
    out.facing = facingEnd;

    return out;
}

// ----------------------------------------------------------------------------
// Fragment Shader: Screen-Pixel Analytical Distance & Anti-Aliased Feathering
// ----------------------------------------------------------------------------
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // ------------------------------------------------------------------------
    // 1. UNIFORM CONTROL FLOW EVALUATION
    // All finite difference derivatives (fwidth) MUST be evaluated unconditionally
    // at the very top of fs_main before ANY branching, conditional blocks, or discard.
    // ------------------------------------------------------------------------
    let u = in.uv.x;
    let v = in.uv.y;

    // Longitudinal excess beyond segment endpoints (SIMD32 branchless)
    let uExcess = max(0.0, max(-u, u - 1.0)) / max(in.uCapExcess, 1e-5);

    // Normalized Euclidean distance metric from the ribbon spine
    let dNorm = sqrt(uExcess * uExcess + v * v);

    // Screen-Pixel Derivative Feathering (Exact Physical Pixel Ramp)
    // Evaluated in unconditional uniform control flow
    let delta = max(0.5 * fwidth(dNorm), 1e-4);

    // Linear coverage ramp over a 1.0 physical pixel boundary transition
    let coverage = clamp(1.0 - (dNorm - (1.0 - delta)) / (2.0 * delta), 0.0, 1.0);

    // ------------------------------------------------------------------------
    // 2. Horizon Facing Falloff & Backface Attenuation
    // ------------------------------------------------------------------------
    let sphereFactor = 1.0 - smoothstep(0.0, 0.35, sim.u_unfurl);

    // Smooth limb horizon falloff: cleanly attenuates to 0.0 at the silhouette
    // Vector fragments attenuate to zero before crossing the planetary horizon limb (smoothstep(0.02, 0.20, in.facing))
    let limbFalloff = smoothstep(0.02, 0.20, in.facing);
    let horizonAtten = horizonFalloff(in.facing, 0.15, 0.0, 0.08) * limbFalloff;
    let facingFade = mix(1.0, horizonAtten, sphereFactor);

    // Discard non-covered pixels or geometry behind the planetary horizon
    if (coverage <= 0.0 || (sphereFactor > 0.0 && in.facing <= 0.02)) {
        discard;
    }

    // 4. Cartographic Color Theme Evaluation
    var strokeColor: vec3<f32>;
    var nominalAlpha: f32;

    if (sim.u_theme == 0u) {
        // Theme 0: Dark Palette Cartographic Hairlines (Marie Tharp)
        if (in.pointType < 0.75) {
            // Major Hydrological Arteries: Mineral cyan/slate-blue
            strokeColor = vec3<f32>(0.38, 0.58, 0.78);
            nominalAlpha = 0.65;
        } else {
            // Continental Coastlines: High-contrast soft parchment ivory
            strokeColor = vec3<f32>(0.94, 0.92, 0.88);
            nominalAlpha = 0.80;
        }
    } else if (sim.u_theme == 2u) {
        // Theme 2: Prussian Cyanotype (Actinic unexposed resist / Photographic negative)
        // STRICTLY MONOCHROMATIC — only Prussian blue + white
        if (in.pointType < 0.75) {
            // Major Hydrological Arteries: Washed cerulean (#4F79A3)
            strokeColor = vec3<f32>(0.31, 0.475, 0.64);
            nominalAlpha = 0.60;
        } else {
            // Continental Coastlines: Chalk ruling pen white (#E8EDF2 / unexposed resist)
            strokeColor = vec3<f32>(0.91, 0.93, 0.95);
            nominalAlpha = 0.98;
        }
    } else {
        // Theme 1: Light Monochrome Architectural / Swiss Relief (Cream Rag)
        if (in.pointType < 0.75) {
            // Hydrology: Washed mineral lapis/celadon glaze
            strokeColor = vec3<f32>(0.24, 0.38, 0.50);
            nominalAlpha = 0.50;
        } else {
            // Coastlines: Archival bistre / sepia-charcoal technical drafting ink (#261E18)
            strokeColor = vec3<f32>(0.15, 0.12, 0.10);
            nominalAlpha = 0.88;
        }
    }

    let finalAlpha = nominalAlpha * coverage * in.alphaPeak * facingFade;

    return vec4<f32>(strokeColor, finalAlpha);
}
