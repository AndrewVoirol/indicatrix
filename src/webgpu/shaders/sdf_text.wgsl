// ============================================================================
// File: src/webgpu/shaders/sdf_text.wgsl
// Architecture: GPU Signed Distance Field (SDF) Typography & Manifold Conformance
// Reference: visual_quality_phase_roadmap.md (M13-P3-T1), ZOOM_DETAIL_SPEC_LEDGER.md (§5)
// Design Ethos: Library/Museum Archival Inscriptions (Caslon/IM Fell, DIN Blueprint)
// ============================================================================

// ----------------------------------------------------------------------------
// Uniform Buffer Structs matching WebGPUEngine SimUniforms (Group 0, Binding 0)
// ----------------------------------------------------------------------------
struct SimUniforms {
    u_unfurl: f32,
    u_mode: u32,
    u_theme: u32,             // 0 = Marie Tharp, 1 = Cream Rag, 2 = Prussian Cyanotype
    u_time: f32,
    u_viewport: vec4<f32>,     // x: width_px, y: height_px, z: 1/width, w: 1/height
    u_cameraPos: vec4<f32>,
    u_cursorHitPos: vec4<f32>,
    u_cursorVel: vec4<f32>,    // xyz: vel, w: speed
    u_cursorActive: f32,
    u_displacementScale: f32,
    u_halfWidthPx: f32,
    u_dpr: f32,                // Device Pixel Ratio (e.g. 2.0 for Retina)
    u_nearPlane: f32,          // Near clipping distance
    u_peakExponent: f32,       // Peak exponent matching crust_hydrosphere.wgsl
    u_seaLevel: f32,           // Dynamic sea level in meters
    u_pad2: f32,
    u_viewMatrix: mat4x4<f32>,
    u_projectionMatrix: mat4x4<f32>,
    u_vectorTierOverride: f32,
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

struct RegionalOverlayUniforms {
    u_regionalBounds: vec4<f32>,
    u_pad0: vec4<f32>,
    u_pad1: vec4<f32>,
    u_regionalActive: u32,
    u_pad2: u32,
    u_pad3: u32,
    u_pad4: u32,
};

@group(0) @binding(0) var<uniform> sim: SimUniforms;
@group(0) @binding(1) var u_demTexture: texture_2d<f32>;
@group(0) @binding(2) var u_demSampler: sampler;
@group(0) @binding(3) var u_regionalDEMTexture: texture_2d<f32>;
@group(0) @binding(4) var<uniform> u_regionalOverlay: RegionalOverlayUniforms;
@group(0) @binding(5) var u_sdfAtlas: texture_2d<f32>;
@group(0) @binding(6) var u_sdfSampler: sampler;

struct TileSlotDescriptor {
    bounds: vec4<f32>, // x: minLon, y: minLat, z: maxLon, w: maxLat
    tileMeta: vec4<f32>,   // x: lod + edgeMask * 64.0, y: slotIndex, z: uvScaleX, w: uvScaleY
};

@group(0) @binding(7) var u_tileCacheArray: texture_2d_array<f32>;
@group(0) @binding(8) var<storage, read> u_tileSlots: array<TileSlotDescriptor>;

// ----------------------------------------------------------------------------
// Vertex Inputs and Outputs
// ----------------------------------------------------------------------------
struct VertexInput {
    // Quad corner geometry: [0.0, 0.0] to [1.0, 1.0] (stepMode: 'vertex')
    @location(0) corner: vec2<f32>,
    // Per-glyph instance attributes (stepMode: 'instance')
    // Stride: 80 bytes (5 x vec4<f32>)
    @location(1) anchor3d: vec4<f32>,   // xyz: sphere anchor pos (radius 5.0), w: fontSizePx
    @location(2) target2d: vec4<f32>,   // xy: Mercator anchor pos, z: orientationMode, w: elevStandoff
    @location(3) glyphRect: vec4<f32>,  // xy: offsetPx, zw: sizePx
    @location(4) glyphUv: vec4<f32>,    // xy: uvMin, zw: uvMax
    @location(5) glyphStyle: vec4<f32>, // x: fontStyle, y: colorPreset, z: minCamDist, w: alpha
};

struct VertexOutput {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) facing: f32,
    @location(3) fontStyle: f32,
};

// ----------------------------------------------------------------------------
// Regional DEM Compositing & Surface Conformance
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
    return max(bestTileWeight, smoothstep(0.0, marginU, distU) * smoothstep(0.0, marginV, distV));
}

fn sampleRegionalComposite(uv: vec2<f32>, globalSample: vec4<f32>, lod: f32) -> vec4<f32> {
    let lon = uv.x * 360.0 - 180.0;
    let lat = 90.0 - uv.y * 180.0;
    var compositeSample = globalSample;

    if (u_regionalOverlay.u_regionalActive == 1u) {
        let bounds = u_regionalOverlay.u_regionalBounds;
        if (lon >= bounds.x && lon <= bounds.z && lat >= bounds.y && lat <= bounds.w && bounds.z > bounds.x && bounds.w > bounds.y) {
            let regU = clamp((lon - bounds.x) / (bounds.z - bounds.x), 0.0, 1.0);
            let regV = clamp((bounds.w - lat) / (bounds.w - bounds.y), 0.0, 1.0);
            let blendDeg = 0.05;
            let marginU = clamp(blendDeg / (bounds.z - bounds.x), 0.001, 0.49);
            let marginV = clamp(blendDeg / (bounds.w - bounds.y), 0.001, 0.49);
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

fn applyTextDisplacement(
    basePos: vec3<f32>,
    baseNormal: vec3<f32>,
    normPos: vec3<f32>,
    elevStandoff: f32
) -> vec3<f32> {
    let PI_VAL = 3.141592653589793;
    let RADIUS_VAL = 5.0;

    // UV coordinates for global DEM lookup derived from rest geodetic position
    let lambda = atan2(normPos.x, normPos.z);
    let phi = asin(clamp(normPos.y / RADIUS_VAL, -0.9998, 0.9998));
    let demUv = vec2<f32>((lambda + PI_VAL) / (2.0 * PI_VAL), 0.5 - phi / PI_VAL);

    let patchDist = length(sim.u_cameraPos.xyz - basePos);
    let patchLOD = clamp(log2(max(1.0, patchDist * 0.2)), 0.0, 4.0);
    let demSampleGlobal = textureSampleLevel(u_demTexture, u_demSampler, demUv, patchLOD);
    let demSample = sampleRegionalComposite(demUv, demSampleGlobal, patchLOD);

    // 5-tap neighborhood envelope so canyon/valley anchors sit at local rim height
    let uvStep = vec2<f32>(0.0025, 0.0025);
    let sampE = sampleRegionalComposite(vec2<f32>(fract(demUv.x + uvStep.x), demUv.y), textureSampleLevel(u_demTexture, u_demSampler, vec2<f32>(fract(demUv.x + uvStep.x), demUv.y), patchLOD), patchLOD);
    let sampW = sampleRegionalComposite(vec2<f32>(fract(demUv.x - uvStep.x + 1.0), demUv.y), textureSampleLevel(u_demTexture, u_demSampler, vec2<f32>(fract(demUv.x - uvStep.x + 1.0), demUv.y), patchLOD), patchLOD);
    let sampN = sampleRegionalComposite(vec2<f32>(demUv.x, clamp(demUv.y - uvStep.y, 0.001, 0.999)), textureSampleLevel(u_demTexture, u_demSampler, vec2<f32>(demUv.x, clamp(demUv.y - uvStep.y, 0.001, 0.999)), patchLOD), patchLOD);
    let sampS = sampleRegionalComposite(vec2<f32>(demUv.x, clamp(demUv.y + uvStep.y, 0.001, 0.999)), textureSampleLevel(u_demTexture, u_demSampler, vec2<f32>(demUv.x, clamp(demUv.y + uvStep.y, 0.001, 0.999)), patchLOD), patchLOD);

    // Identical geoid decoding formula as crust_hydrosphere.wgsl
    let rawElevMeters = demSample.a * 19772.0 - 10924.0;
    let maxNeighborA = max(max(sampE.a, sampW.a), max(sampN.a, sampS.a));
    let neighborElevMeters = maxNeighborA * 19772.0 - 10924.0;
    let elevMeters = select(rawElevMeters, max(rawElevMeters, neighborElevMeters), rawElevMeters > -500.0);

    // Polar displacement attenuation near singularities matching crust_hydrosphere.wgsl
    let poleDist = abs(demUv.y - 0.5) * 2.0;
    let poleAtten = 1.0 - smoothstep(0.85, 0.98, poleDist);

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

    // Zero-standoff invariant
    let standoffClamped = clamp(elevStandoff, 0.0005, 0.0020);

    return basePos + baseNormal * (normalDisplacement + standoffClamped);
}

// ----------------------------------------------------------------------------
// Vertex Shader: Perspective-Correct Billboard Expansion & Manifold Morphing
// ----------------------------------------------------------------------------
@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;

    let RADIUS_VAL = 5.0;
    let normAnchor3d = normalize(in.anchor3d.xyz) * RADIUS_VAL;

    // Decode two-pass Halo-then-Ink quad corner encoding:
    // corner.x in [-2, -1] => passMode = 1.0 (Halo pass)
    // corner.x in [ 2,  3] => passMode = 2.0 (Ink pass)
    // corner.x in [ 0,  1] => passMode = 0.0 (Single-pass fallback)
    var passMode: f32 = 0.0;
    var cornerX: f32 = in.corner.x;
    if (in.corner.x < -0.5) {
        passMode = 1.0;
        cornerX = in.corner.x + 2.0;
    } else if (in.corner.x > 1.5) {
        passMode = 2.0;
        cornerX = in.corner.x - 2.0;
    }
    let corner = vec2<f32>(cornerX, in.corner.y);

    // 1. Manifold Deformations (Mode 0 Sphere-to-Plane Unfurl)
    // Mode 0 flat sheet in crust_hydrosphere.wgsl uses equirectangular Y = phi * RADIUS
    let phi = asin(clamp(normAnchor3d.y / RADIUS_VAL, -0.9998, 0.9998));
    let targetY = select(in.target2d.y, phi * RADIUS_VAL, sim.u_mode == 0u);
    let target2D = vec2<f32>(in.target2d.x, targetY);

    let def = evaluateManifoldCore(
        normAnchor3d,
        target2D,
        sim.u_unfurl,
        sim.u_mode,
        sim.u_time,
        sim.u_cursorHitPos,
        sim.u_cursorActive,
        sim.u_cursorVel
    );

    // 2. Crust Elevation Conformance
    let dispAnchor = applyTextDisplacement(
        def.pos,
        def.normal,
        normAnchor3d,
        in.target2d.w
    );

    // 3. View-Space Transformation and Horizon Facing
    let viewPos = sim.u_viewMatrix * vec4<f32>(dispAnchor, 1.0);
    let viewNormal = normalize((sim.u_viewMatrix * vec4<f32>(def.normal, 0.0)).xyz);
    let facing = dot(viewNormal, -normalize(viewPos.xyz));

    // 4. Backface Culling & Limb Attenuation on Spherical Manifold
    let sphereFactor = 1.0 - smoothstep(0.0, 0.35, sim.u_unfurl);
    if (sphereFactor > 0.5 && facing < 0.08) {
        out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 0.0); // Degenerate cull
        return out;
    }

    // 5. Zoom Gating & LOD Culling (Track D / M13-P3-T3)
    let camDist = mix(length(sim.u_cameraPos.xyz), 5.0 + abs(sim.u_cameraPos.z), clamp(sim.u_unfurl, 0.0, 1.0));
    let minCamDist = in.glyphStyle.z;
    if (minCamDist > 0.0 && camDist > minCamDist) {
        out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 0.0); // Culled by zoom gate
        return out;
    }

    // 6. Base Homogeneous Clip Coordinates
    let baseClip = sim.u_projectionMatrix * viewPos;
    let nearGuard = max(sim.u_nearPlane, 0.00002);

    if (baseClip.w < nearGuard) {
        out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 0.0); // Culled behind near plane
        return out;
    }

    // 7. Screen-Space Perspective-Correct Quad Expansion
    let dprScale = clamp(sim.u_dpr, 1.0, 3.0);
    let closeZoomFontBoost = mix(1.65, 1.08, smoothstep(5.10, 10.50, camDist));
    let quadOffsetPx = (in.glyphRect.xy + corner * in.glyphRect.zw) * dprScale * closeZoomFontBoost;

    // Map screen-pixel offset to NDC, scaled by baseClip.w
    let offsetNdc = vec2<f32>(
        quadOffsetPx.x * 2.0 * sim.u_viewport.z,
        -quadOffsetPx.y * 2.0 * sim.u_viewport.w
    );

    // Per-glyph spherical silhouette check: prevent right-extending labels from
    // overhanging into empty space beyond the globe's horizon limb.
    let projScaleX = max(0.25, abs(sim.u_projectionMatrix[0][0]));
    let projScaleY = max(0.25, abs(sim.u_projectionMatrix[1][1]));
    let viewOffsetXY = vec2<f32>(
        offsetNdc.x * baseClip.w / projScaleX,
        offsetNdc.y * baseClip.w / projScaleY
    );
    let glyphDiscXY = viewNormal.xy + viewOffsetXY / RADIUS_VAL;
    let glyphDiscR2 = dot(glyphDiscXY, glyphDiscXY);
    let glyphFacing = select(0.0, sqrt(max(0.0, 1.0 - glyphDiscR2)), glyphDiscR2 < 0.96);
    out.facing = mix(facing, min(facing, glyphFacing), sphereFactor);

    if (sphereFactor > 0.5 && out.facing <= 0.05) {
        out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 0.0); // Culled at planetary limb
        return out;
    }

    // Parallax-free view-ray depth clearance: keeps screen-space XY 100% locked to
    // the surface anchor while lifting hardware depth Z so adjacent ridges, canyon walls,
    // and planetary curvature across the label span never slice words in half.
    let viewDist = max(nearGuard, length(viewPos.xyz));
    let depthLift = min(viewDist * 0.38, 0.65 + sim.u_displacementScale * 3.5);
    let liftedViewPos = vec4<f32>(viewPos.xyz - normalize(viewPos.xyz) * depthLift, 1.0);
    let liftedClip = sim.u_projectionMatrix * liftedViewPos;
    let safeClipZ = clamp(liftedClip.z * (baseClip.w / max(liftedClip.w, nearGuard)), 0.0, baseClip.z);

    out.clipPos = vec4<f32>(
        baseClip.xy + offsetNdc * baseClip.w,
        safeClipZ,
        baseClip.w
    );

    // 8. Atlas Texture UV Coordinates
    out.uv = mix(in.glyphUv.xy, in.glyphUv.zw, corner);

    // 9. Style & Color Attributes Pass-Through
    out.fontStyle = passMode;
    out.color = vec4<f32>(1.0, 1.0, 1.0, in.glyphStyle.w);

    return out;
}

// ----------------------------------------------------------------------------
// Fragment Shader: Sub-Pixel Anti-Aliased SDF Evaluation & Theme Inks
// ----------------------------------------------------------------------------
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // ------------------------------------------------------------------------
    // 1. UNIFORM CONTROL FLOW EVALUATION
    // Derivatives (fwidth) and texture sampling MUST execute unconditionally
    // at the top of fs_main before any dynamic branching or discard statements.
    // ------------------------------------------------------------------------
    let sdfSample = textureSample(u_sdfAtlas, u_sdfSampler, in.uv).r;

    // Sub-pixel anti-aliasing delta: delta = 0.707 * fwidth(sdfSample)
    // Clamped to 0.09 so minification does not push upper smoothstep edge above stroke core
    let delta = clamp(0.707 * fwidth(sdfSample), 0.001, 0.09);
    let alphaGlyph = smoothstep(0.43 - delta, 0.46 + delta, sdfSample);
    let rawHalo = smoothstep(0.18 - delta, 0.43 + delta, sdfSample);
    let alphaHalo = smoothstep(0.0, 1.0, pow(rawHalo, 0.72));

    // Horizon limb falloff)
    let limbFalloff = smoothstep(0.02, 0.20, in.facing) * smoothstep(0.08, 0.28, in.facing);
    let sphereFactor = 1.0 - smoothstep(0.0, 0.35, sim.u_unfurl);
    let facingFade = mix(1.0, limbFalloff, sphereFactor);

    // ------------------------------------------------------------------------
    // 2. Early Fragment Discard (After unconditional uniform control flow)
    // ------------------------------------------------------------------------
    let isHaloPass = in.fontStyle > 0.5 && in.fontStyle < 1.5;
    let isInkPass = in.fontStyle >= 1.5;
    if (alphaHalo <= 0.001 || (isInkPass && alphaGlyph <= 0.001) || (sphereFactor > 0.0 && in.facing <= 0.05)) {
        discard;
    }

    // ------------------------------------------------------------------------
    // 3. Medium Archival Ink Palette Selection
    // ------------------------------------------------------------------------
    var inkColor: vec3<f32>;
    var haloColor: vec3<f32>;

    if (sim.u_theme == 2u) {
        // Theme 2: Prussian Cyanotype (1842 Blueprint)
        // Cold actinic white / cerulean ink (#E8EDF2), deep Prussian indigo knockout halo
        inkColor = vec3<f32>(0.910, 0.929, 0.949);
        haloColor = vec3<f32>(0.030, 0.082, 0.168);
    } else if (sim.u_theme == 1u) {
        // Theme 1: Cream Rag (310 GSM Archival Cotton Rag)
        // Luminous warm cotton-vellum inscription over archival sepia-charcoal (#38302A) intaglio casing
        let sepiaCharcoal = vec3<f32>(0.220, 0.188, 0.165);
        inkColor = vec3<f32>(0.976, 0.957, 0.918);
        haloColor = sepiaCharcoal * 0.52;
    } else {
        // Theme 0: Marie Tharp Physiographic Chart (1977 Ocean Floor Panorama)
        // Archival warm cream/ivory ink (#EAE6DE)
        inkColor = vec3<f32>(0.918, 0.902, 0.871);
        haloColor = vec3<f32>(0.095, 0.075, 0.060);
    }

    let haloStrength = select(0.92, 0.94, sim.u_theme == 1u);
    var combinedAlpha: f32;
    if (isHaloPass) {
        inkColor = haloColor;
        combinedAlpha = alphaHalo * haloStrength;
    } else if (isInkPass) {
        combinedAlpha = alphaGlyph;
    } else {
        inkColor = mix(haloColor, inkColor, alphaGlyph);
        combinedAlpha = max(alphaGlyph, alphaHalo * haloStrength);
    }

    // Compute composite opacity
    let finalAlpha = combinedAlpha * in.color.a * facingFade;

    // Return premultiplied color for canvas compositing
    return vec4<f32>(inkColor, finalAlpha);
}
