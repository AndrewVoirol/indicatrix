// ============================================================================
// File: src/webgpu/shaders/crust_hydrosphere.wgsl
// Target: Unified Native WebGPU Lithosphere Crust & Liquid Hydrosphere Pipeline
// Mathematical Foundations: Indicatrix Engine Frontiers 3 & 4
// Synchronous Dual-Surface Morphing Theorem: Theorem 3.3.2 (Zero Z-Fighting, Zero Cracks)
// ============================================================================

struct SimUniforms {
    u_unfurl: f32,
    u_mode: u32,
    u_theme: u32,             // 0 = Dark Obsidian, 1 = Light Monochrome (swisstopo)
    u_time: f32,
    u_viewport: vec4<f32>,     // x: width, y: height, z: 1/width, w: 1/height
    u_cameraPos: vec4<f32>,
    u_cursorHitPos: vec4<f32>,
    u_cursorVel: vec4<f32>,
    u_cursorActive: f32,
    u_displacementScale: f32,
    u_seaLevel: f32,          // Dynamic sea level in meters
    u_roughness: f32,
    u_viewMatrix: mat4x4<f32>,
    u_projectionMatrix: mat4x4<f32>,
    u_sunAzimuth: f32,
    u_sunAltitude: f32,
    u_ambientOcclusion: f32,
    u_waterClarity: f32,
    u_peakExponent: f32,
    u_layerOpacity: f32,
    u_renderStyle: u32,       // 0 = Architectural / Relief, 1 = Hybrid / Depth, 2 = Orbital
    u_isolatedStratum: f32,   // -1.0 = All active, 0.0..4.0 = Isolate specific stratum band
    u_mediumProperties: vec4<f32>, // x: inkAbsorption, y: fiberDensity, z: exposureGamma, w: stippleDensity
    u_shadowIntensity: f32, // Dynamic cloud ground shadow intensity (offset 272, float 68)
    u_cloudDriftRate: f32,  // Dynamic cloud drift rate for shadow sync (offset 276, float 69) _padShadow0: f32,
    u_cloudAltitudeKm: f32, // Dynamic cloud deck altitude in km (offset 280, float 70) _padShadow1: f32,
    u_verticalScaleMode: u32, // Vertical scale mode: 0 = Linear Legacy, 1 = Symmetrical Dual-Log (offset 284, float 71) _padShadow2: f32,
    u_pluvial_gamma: f32, // offset 288 (float 72)
    u_weatherOpticalMode: u32, // offset 292 (uint 73)
    u_lclBypass: f32, // offset 296 (float 74)
    u_purityMode: f32, // offset 300 (float 75)
    u_scrubTau: f32, // offset 304 (float 76)
    u_advectionActive: f32, // offset 308 (float 77)
    _padScrub1: f32, // offset 312 (float 78)
    u_cdlodDiagnosticMode: f32, // offset 316 (float 79)
    u_cameraPosHigh: vec4<f32>, // offset 320 (floats 80..83)
    u_cameraPosLow: vec4<f32>,  // offset 336 (floats 84..87)
    u_viewProjectionMatrix: mat4x4<f32>, // offset 352 (floats 88..103)
};

@group(0) @binding(0) var<uniform> sim: SimUniforms;
@group(0) @binding(1) var u_demTexture: texture_2d<f32>;
@group(0) @binding(2) var u_demSampler: sampler;
@group(0) @binding(3) var u_orbitalTextures: texture_2d_array<f32>; // Layer 0: Day Blue Marble, Layer 1: Night Lights
@group(0) @binding(4) var u_orbitalSampler: sampler;
@group(0) @binding(5) var u_regionalDEMTexture: texture_2d<f32>;

struct RegionalOverlayUniforms {
    u_regionalBounds: vec4<f32>, // minLon, minLat, maxLon, maxLat (bytes 0..15)
    u_pad0: vec4<f32>,           // (bytes 16..31)
    u_pad1: vec4<f32>,           // (bytes 32..47)
    u_regionalActive: u32,       // (bytes 48..51)
    u_pad2: u32,
    u_pad3: u32,
    u_pad4: u32,
};

@group(0) @binding(6) var<uniform> u_regionalOverlay: RegionalOverlayUniforms;
@group(0) @binding(7) var u_cloudTexture: texture_2d<f32>;
@group(0) @binding(8) var u_cloudSampler: sampler;
@group(0) @binding(9) var u_precipTexture: texture_2d<f32>;
@group(0) @binding(10) var u_precipSampler: sampler;
@group(0) @binding(11) var u_tempTexture: texture_2d<f32>;
@group(0) @binding(12) var u_dewpointTexture: texture_2d<f32>;
@group(0) @binding(13) var u_precipNextTexture: texture_2d<f32>;
@group(0) @binding(14) var u_windTexture: texture_2d<f32>;
@group(0) @binding(15) var u_highCloudTexture: texture_2d<f32>;

struct TerrainShadowUniforms {
    u_sunAzimuth: f32,             // offset 0  (radians, [0, 2*PI])
    u_sunAltitude: f32,            // offset 4  (radians, [0, PI/2])
    u_maxRayDistanceMeters: f32,   // offset 8  (e.g. 50,000.0 m max shadow reach)
    u_penumbraSoftness: f32,       // offset 12 (penumbra transition coefficient)
    u_shadowMapDimensions: vec2<u32>, // offset 16 (width, height, e.g. 4096, 2048)
    u_sampleStepCount: u32,        // offset 24 (steps per ray, e.g. 16 or 32)
    _pad: u32,                     // offset 28 (16-byte alignment)
};

struct DrainageBasinUniforms {
    u_widthExponentB: f32,          // offset 0  (default 0.50)
    _padding_4: f32,                // offset 4  (reserved)
    u_erodibilityConstantK: f32,    // offset 8  (default 1.00)
    u_flintExponentM: f32,          // offset 12 (default 0.45)
    u_flintExponentN: f32,          // offset 16 (default 1.00)
    u_minDischargeThreshold: f32,   // offset 20 (minimum Q to render a stream hairline)
    u_demGridDimensions: vec2<u32>, // offset 24 (e.g. 8192, 4096)
};

@group(1) @binding(0) var<uniform> u_terrainShadow: TerrainShadowUniforms;
@group(1) @binding(1) var u_terrainShadowTexture: texture_2d<f32>;
@group(1) @binding(2) var u_terrainShadowSampler: sampler;
@group(1) @binding(3) var u_hydroTexture: texture_2d<f32>;
@group(1) @binding(4) var u_normalTexture: texture_2d<f32>;
@group(1) @binding(5) var u_drainageTexture: texture_2d<f32>;
@group(1) @binding(6) var<uniform> u_drainageBasin: DrainageBasinUniforms;

struct GeomorphicMicroUniforms {
    u_microDetailStrength: f32, // offset 0 (0.0 to 1.5, default 0.65)
    u_rockSlopeThreshold: f32,  // offset 4 (radians, default 0.61 rad ~35 deg)
    u_contourBaseInterval: f32, // offset 8 (meters, default 50.0m)
    u_contourActive: f32,       // offset 12 (1.0 = on, 0.0 = off)
};

@group(1) @binding(7) var<uniform> u_geomorphicMicro: GeomorphicMicroUniforms;

struct TileSlotDescriptor {
    bounds: vec4<f32>, // x: minLon, y: minLat, z: maxLon, w: maxLat
    tileMeta: vec4<f32>,   // x: lod + edgeMask * 64.0, y: slotIndex, z: uvScaleX, w: uvScaleY
};

@group(1) @binding(8) var u_tileCacheArray: texture_2d_array<f32>;
@group(1) @binding(9) var<storage, read> u_tileSlots: array<TileSlotDescriptor>;

struct CDLODInstance {
    minUV: vec2<f32>,
    sizeUV: vec2<f32>,
    lod: u32,
    morphStart: f32,
    invMorphRange: f32,
    lodFraction: f32,
};

struct CDLODControlUniforms {
    u_cdlodActive: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(2) @binding(0) var<uniform> u_cdlodControl: CDLODControlUniforms;
@group(2) @binding(1) var<storage, read> cdlodInstances: array<CDLODInstance>;

struct VertexInput {
    @location(0) position: vec3<f32>, // Base manifold position
    @location(1) uv: vec2<f32>,       // Longitude/Latitude [0, 1]
    @location(2) surfaceType: f32,    // 0.0 = Crust, 1.0 = Liquid Hydrosphere
    @location(3) target2D: vec4<f32>, // xy: Mercator 2D, zw: Reserved/Unused
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) elevation: f32,
    @location(4) waterDepth: f32,
    @location(5) surfaceType: f32,
    @location(6) skirtFactor: f32,
    @location(7) lodInfo: vec2<f32>,
};

const PI_F32: f32 = 3.14159265358979323846;
const TWO_PI_F32: f32 = 6.28318530717958647692;
const INV_PI_F32: f32 = 0.31830988618379067154;
const INV_TWO_PI_F32: f32 = 0.15915494309189533577;
const EARTH_RADIUS_M: f32 = 6371000.0;
const INV_EARTH_RADIUS_M: f32 = 1.5696123e-7;

fn computeSunLightDir(azimuthDeg: f32, altitudeDeg: f32) -> vec3<f32> {
    let radAz = radians(azimuthDeg);
    let radAlt = radians(altitudeDeg);
    let cosAlt = cos(radAlt);
    return normalize(vec3<f32>(
        sin(radAz) * cosAlt,
        cos(radAz) * cosAlt,
        sin(radAlt)
    ));
}

// Procedural 2D corner hash (Hoskins hash12 — zero sin() stripe degeneracy at close zoom)
fn hashCell2D(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.xyx) * vec3<f32>(0.1031, 0.1030, 0.0973));
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Filtered 2D value noise for micro-fiber paper tooth across orbital and close-zoom scales
fn hashPaper2D(p: vec2<f32>) -> f32 {
    let camDist = mix(length(sim.u_cameraPos.xyz), 5.0 + abs(sim.u_cameraPos.z), clamp(sim.u_unfurl, 0.0, 1.0));
    let isCellCoord = all(fract(p) == vec2<f32>(0.0));
    let zoomFreq = select(mix(42.0, 2.0, smoothstep(5.12, 7.50, camDist)), 1.0, isCellCoord);
    let q = p * zoomFreq;
    let i = floor(q);
    let f = fract(q);
    let u = f * f * (3.0 - 2.0 * f);
    let a = hashCell2D(i);
    let b = hashCell2D(i + vec2<f32>(1.0, 0.0));
    let c = hashCell2D(i + vec2<f32>(0.0, 1.0));
    let d = hashCell2D(i + vec2<f32>(1.0, 1.0));
    let baseVal = mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    return select(clamp((baseVal - 0.5) * 1.15 + 0.5, 0.0, 1.0), a, isCellCoord);
}

// ----------------------------------------------------------------------------
// Analytical Multi-Octave Geomorphic Micro-Roughness Normal Perturbation (§2.1 A.3)
// ----------------------------------------------------------------------------
fn hashGeomorphicGrad3D(p: vec3<i32>) -> vec3<f32> {
    var v = bitcast<vec3<u32>>(p) * 1664525u + 1013904223u;
    v.x = v.x + v.y * v.z;
    v.y = v.y + v.z * v.x;
    v.z = v.z + v.x * v.y;
    v.x = v.x ^ (v.x >> 16u);
    v.y = v.y ^ (v.y >> 16u);
    v.z = v.z ^ (v.z >> 16u);
    let raw = vec3<f32>(v & vec3<u32>(0x3fffffffu)) * (2.0 / 1073741824.0) - 1.0;
    return raw * 0.70710678;
}

fn analyticalPerlin3DGrad(p: vec3<f32>) -> vec4<f32> {
    let i0 = vec3<i32>(floor(p));
    let f0 = fract(p);

    // C2 quintic polynomial: 6t^5 - 15t^4 + 10t^3
    let u = f0 * f0 * f0 * (f0 * (f0 * 6.0 - 15.0) + 10.0);
    let du = 30.0 * f0 * f0 * (f0 * (f0 - 2.0) + 1.0);

    let g000 = hashGeomorphicGrad3D(i0 + vec3<i32>(0, 0, 0));
    let g100 = hashGeomorphicGrad3D(i0 + vec3<i32>(1, 0, 0));
    let g010 = hashGeomorphicGrad3D(i0 + vec3<i32>(0, 1, 0));
    let g110 = hashGeomorphicGrad3D(i0 + vec3<i32>(1, 1, 0));
    let g001 = hashGeomorphicGrad3D(i0 + vec3<i32>(0, 0, 1));
    let g101 = hashGeomorphicGrad3D(i0 + vec3<i32>(1, 0, 1));
    let g011 = hashGeomorphicGrad3D(i0 + vec3<i32>(0, 1, 1));
    let g111 = hashGeomorphicGrad3D(i0 + vec3<i32>(1, 1, 1));

    let v000 = dot(g000, f0 - vec3<f32>(0.0, 0.0, 0.0));
    let v100 = dot(g100, f0 - vec3<f32>(1.0, 0.0, 0.0));
    let v010 = dot(g010, f0 - vec3<f32>(0.0, 1.0, 0.0));
    let v110 = dot(g110, f0 - vec3<f32>(1.0, 1.0, 0.0));
    let v001 = dot(g001, f0 - vec3<f32>(0.0, 0.0, 1.0));
    let v101 = dot(g101, f0 - vec3<f32>(1.0, 0.0, 1.0));
    let v011 = dot(g011, f0 - vec3<f32>(0.0, 1.0, 1.0));
    let v111 = dot(g111, f0 - vec3<f32>(1.0, 1.0, 1.0));

    let k0 = v000;
    let k1 = v100 - v000;
    let k2 = v010 - v000;
    let k3 = v001 - v000;
    let k4 = v110 - v100 - v010 + v000;
    let k5 = v101 - v100 - v001 + v000;
    let k6 = v011 - v010 - v001 + v000;
    let k7 = v111 - v011 - v101 + v001 - v110 + v010 + v100 - v000;

    let val = k0 + k1*u.x + k2*u.y + k3*u.z + k4*u.x*u.y + k5*u.x*u.z + k6*u.y*u.z + k7*u.x*u.y*u.z;

    let grad = du * vec3<f32>(
        k1 + k4*u.y + k5*u.z + k7*u.y*u.z,
        k2 + k4*u.x + k6*u.z + k7*u.x*u.z,
        k3 + k5*u.x + k6*u.y + k7*u.x*u.y
    ) + mix(
        mix(mix(g000, g100, u.x), mix(g010, g110, u.x), u.y),
        mix(mix(g001, g101, u.x), mix(g011, g111, u.x), u.y),
        u.z
    );

    return vec4<f32>(grad, val);
}

fn analyticalWorleyErosion2D(uv: vec2<f32>) -> vec3<f32> {
    let i = floor(uv);
    let f = fract(uv);
    var minDistSq: f32 = 10.0;
    var minDiff: vec2<f32> = vec2<f32>(0.0, 0.0);

    for (var dy = -1; dy <= 1; dy = dy + 1) {
        for (var dx = -1; dx <= 1; dx = dx + 1) {
            let neighbor = vec2<f32>(f32(dx), f32(dy));
            let cell = i + neighbor;
            let ucell = vec2<u32>(
                bitcast<u32>(i32(cell.x)),
                bitcast<u32>(i32(cell.y))
            );
            var h = ucell.x * 1664525u + ucell.y * 1013904223u + 374761393u;
            h = (h ^ (h >> 13u)) * 1274126177u;
            let fx = f32(h & 0xffffu) * (1.0 / 65535.0);
            let fy = f32((h >> 16u) & 0xffffu) * (1.0 / 65535.0);
            let pt = vec2<f32>(fx, fy);

            let diff = neighbor + pt - f;
            let dSq = dot(diff, diff);
            if (dSq < minDistSq) {
                minDistSq = dSq;
                minDiff = diff;
            }
        }
    }
    let d = sqrt(max(1e-5, minDistSq));
    let grad = minDiff / d;
    return vec3<f32>(grad.x, grad.y, 1.0 - d);
}

fn evaluateGeomorphicMicroErosion(
    worldPos: vec3<f32>,
    tangentX: vec3<f32>,
    tangentY: vec3<f32>
) -> vec2<f32> {
    var accumGrad = vec2<f32>(0.0, 0.0);
    var curFreq = 26000.0;
    var curAmp = 0.65;

    let r = length(worldPos);
    let sinPhi = clamp(worldPos.y / max(0.001, r), -1.0, 1.0);
    let cosPhi = sqrt(max(0.0, 1.0 - sinPhi * sinPhi));
    let lam = atan2(worldPos.x, worldPos.z);
    let uMetric = lam * (r * max(0.08, cosPhi));
    let vMetric = asin(sinPhi) * r;
    let uvSurface = select(vec2<f32>(uMetric, vMetric), worldPos.xy, sim.u_unfurl > 0.5);

    for (var oct = 0u; oct < 2u; oct = oct + 1u) {
        let pOct = worldPos * curFreq;
        let uvOct = uvSurface * curFreq;

        // 3D analytical Perlin gradient projected into surface tangent plane
        let pPerlin = analyticalPerlin3DGrad(pOct);
        let gradPerlinTan = vec2<f32>(dot(pPerlin.xyz, tangentX), dot(pPerlin.xyz, tangentY));

        // 2D analytical Worley erosion gradient in local metric tangent frame
        let wErosion = select(vec3<f32>(gradPerlinTan, 0.0), analyticalWorleyErosion2D(uvOct), oct == 0u);
        let gradWorleyTan = wErosion.xy;

        // Hybrid geomorphic erosion: continuous Perlin base carved by Worley V-groove talus channels
        let octaveGrad = mix(gradPerlinTan, gradWorleyTan, 0.38);
        accumGrad = accumGrad + octaveGrad * curAmp;

        curFreq = curFreq * 2.05;
        curAmp = curAmp * 0.50;
    }

    return accumGrad;
}


// ----------------------------------------------------------------------------
// Hydrosphere Optics & Jerlov Radiative Transfer (Frontier 3)
// ----------------------------------------------------------------------------
struct HydrosphereUniforms {
    u_waterType: u32,             // 0=Type I, 1=Type IA, 2=Type IB, 3=Type II, 4=Type III
    u_time: f32,                  // Continuous time in seconds
    u_seaLevelOffset: f32,        // Sea level adjustment datum (meters)
    u_causticIntensity: f32,      // Caustic focusing gain multiplier
    u_sunAzimuth: f32,            // Solar azimuth in degrees
    u_sunAltitude: f32,           // Solar altitude in degrees
    u_roughness: f32,             // Water surface micro-facet roughness
    u_fresnelPower: f32,          // Schlick Fresnel exponent
};

const JERLOV_KD: array<vec3<f32>, 5> = array<vec3<f32>, 5>(
    vec3<f32>(0.355, 0.055, 0.023), // Type I  (Ultra-oligotrophic, blue-penetrating)
    vec3<f32>(0.365, 0.063, 0.038), // Type IA
    vec3<f32>(0.380, 0.075, 0.052), // Type IB
    vec3<f32>(0.410, 0.105, 0.094), // Type II
    vec3<f32>(0.480, 0.145, 0.190)  // Type III (Coastal gelbstoff)
);

const JERLOV_A: array<vec3<f32>, 5> = array<vec3<f32>, 5>(
    vec3<f32>(0.350, 0.051, 0.018),
    vec3<f32>(0.355, 0.058, 0.032),
    vec3<f32>(0.362, 0.068, 0.046),
    vec3<f32>(0.385, 0.088, 0.085),
    vec3<f32>(0.440, 0.115, 0.165)
);

const JERLOV_BB: array<vec3<f32>, 5> = array<vec3<f32>, 5>(
    vec3<f32>(0.00045, 0.00054, 0.00063),
    vec3<f32>(0.00081, 0.00094, 0.00108),
    vec3<f32>(0.00117, 0.00135, 0.00153),
    vec3<f32>(0.00216, 0.00252, 0.00288),
    vec3<f32>(0.00480, 0.00560, 0.00640)
);

const JERLOV_R_INF: array<vec3<f32>, 5> = array<vec3<f32>, 5>(
    vec3<f32>(0.00064, 0.00527, 0.01720),
    vec3<f32>(0.00114, 0.00803, 0.01660),
    vec3<f32>(0.00161, 0.00983, 0.01635),
    vec3<f32>(0.00280, 0.01412, 0.01666),
    vec3<f32>(0.00542, 0.02377, 0.01903)
);

const ALBEDO_CARBONATE_REEF: vec3<f32> = vec3<f32>(0.48, 0.54, 0.44);
const ALBEDO_ABYSSAL_BASALT: vec3<f32> = vec3<f32>(0.06, 0.05, 0.04);
const ALBEDO_WHITE_OOID:     vec3<f32> = vec3<f32>(0.60, 0.64, 0.58); // Bahamian white shoal sand
const ALBEDO_COASTAL_SILT:   vec3<f32> = vec3<f32>(0.28, 0.22, 0.15); // Continental shelf terrigenous sediment

fn computeSlantPathCosines(N: vec3<f32>, L: vec3<f32>, V: vec3<f32>) -> vec2<f32> {
    const INV_NW_SQ: f32 = 0.561937; // 1.0 / (1.334 * 1.334)
    let NdotL = max(0.0, dot(N, L));
    let NdotV = max(0.0, dot(N, V));
    let sin2_theta_s = max(0.0, 1.0 - NdotL * NdotL);
    let sin2_theta_v = max(0.0, 1.0 - NdotV * NdotV);
    let mu_s = sqrt(max(0.01, 1.0 - sin2_theta_s * INV_NW_SQ));
    let mu_v = sqrt(max(0.01, 1.0 - sin2_theta_v * INV_NW_SQ));
    return vec2<f32>(mu_s, mu_v);
}

fn evaluateKubelkaMunkReflectance(
    depthMeters: f32,
    waterType: u32,
    bottomAlbedo: vec3<f32>,
    mu_s: f32,
    mu_v: f32
) -> vec3<f32> {
    let typeIdx = clamp(waterType, 0u, 4u);
    let a   = JERLOV_A[typeIdx];
    let bb  = JERLOV_BB[typeIdx];
    let Rinf = JERLOV_R_INF[typeIdx];
    let gamma = 2.0 * sqrt(a * (a + 2.0 * bb));
    let pathFactor = 0.5 * ((1.0 / mu_s) + (1.0 / mu_v));
    let expTerm = exp(-2.0 * gamma * (depthMeters * pathFactor));
    let crossTerm = Rinf * bottomAlbedo;
    let diffTerm  = bottomAlbedo - Rinf;
    let numerator   = Rinf * (vec3<f32>(1.0) - crossTerm) + diffTerm * expTerm;
    let denominator = (vec3<f32>(1.0) - crossTerm) + Rinf * (diffTerm * expTerm);
    return clamp(numerator / max(denominator, vec3<f32>(0.001)), vec3<f32>(0.0), vec3<f32>(1.0));
}

struct JerlovProperties {
    Kd: vec3<f32>,
    a: vec3<f32>,
    bb: vec3<f32>,
    Rinf: vec3<f32>,
};

fn getJerlovProperties(clarity: f32, depthMeters: f32) -> JerlovProperties {
    // Calibrated coastal gelbstoff / CDOM modulation:
    // Tropical lagoons and coral atolls under high clarity (clarity ~ 1.0) maintain pristine Type I/IA clarity.
    // Moderate or low clarity allows coastal organic absorption (Type II/III) to develop in shallow waters.
    let coastalFactor = (1.0 - smoothstep(12.0, 100.0, depthMeters)) * max(0.0, 0.75 - clarity * 0.50);
    let effectiveClarity = clamp(clarity - coastalFactor, 0.0, 1.0);

    // Continuous mapping to Jerlov index space [0.0 .. 4.0]:
    // 0.0 = Type I, 1.0 = Type IA, 2.0 = Type IB, 3.0 = Type II, 4.0 = Type III
    let typeParam = (1.0 - effectiveClarity) * 4.0;
    let idx0 = u32(clamp(floor(typeParam), 0.0, 4.0));
    let idx1 = min(idx0 + 1u, 4u);
    let frac = typeParam - floor(typeParam);

    var props: JerlovProperties;
    props.Kd = mix(JERLOV_KD[idx0], JERLOV_KD[idx1], frac);
    props.a = mix(JERLOV_A[idx0], JERLOV_A[idx1], frac);
    props.bb = mix(JERLOV_BB[idx0], JERLOV_BB[idx1], frac);
    props.Rinf = mix(JERLOV_R_INF[idx0], JERLOV_R_INF[idx1], frac);
    return props;
}

fn evaluateKubelkaMunkReflectanceProps(
    depthMeters: f32,
    props: JerlovProperties,
    bottomAlbedo: vec3<f32>,
    mu_s: f32,
    mu_v: f32
) -> vec3<f32> {
    let a   = props.a;
    let bb  = props.bb;
    let Rinf = props.Rinf;
    let gamma = 2.0 * sqrt(a * (a + 2.0 * bb));
    let pathFactor = 0.5 * ((1.0 / mu_s) + (1.0 / mu_v));
    let expTerm = exp(-2.0 * gamma * (depthMeters * pathFactor));
    let crossTerm = Rinf * bottomAlbedo;
    let diffTerm  = bottomAlbedo - Rinf;
    let numerator   = Rinf * (vec3<f32>(1.0) - crossTerm) + diffTerm * expTerm;
    let denominator = (vec3<f32>(1.0) - crossTerm) + Rinf * (diffTerm * expTerm);
    return clamp(numerator / max(denominator, vec3<f32>(0.001)), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn evaluateSpectralTransmission(depthMeters: f32, waterType: u32, mu_s: f32, mu_v: f32) -> vec3<f32> {
    let Kd = JERLOV_KD[clamp(waterType, 0u, 4u)];
    let pathFactor = (1.0 / mu_s) + (1.0 / mu_v);
    let opticalPath = Kd * (depthMeters * pathFactor);
    return exp(-opticalPath);
}

struct WaveHarmonic {
    amplitude: f32,
    kx: f32,
    ky: f32,
    omega: f32,
    phi: f32,
};

const WAVE_OCTAVES: array<WaveHarmonic, 4> = array<WaveHarmonic, 4>(
    WaveHarmonic(0.024,  2.40,  1.80, 2.20, 0.00),
    WaveHarmonic(0.014, -3.80,  3.20, 3.40, 1.14),
    WaveHarmonic(0.008,  6.50, -5.10, 5.10, 2.31),
    WaveHarmonic(0.004, -9.20, -8.60, 7.80, 4.05)
);

struct RippleResult {
    normalPerturbation: vec2<f32>,
    analyticalDivergence: f32,
};

fn evaluateMicroRipples(uv: vec2<f32>, time: f32) -> RippleResult {
    var dN = vec2<f32>(0.0, 0.0);
    var divN = 0.0;
    for (var i = 0u; i < 4u; i = i + 1u) {
        let phase = WAVE_OCTAVES[i].kx * uv.x + WAVE_OCTAVES[i].ky * uv.y - WAVE_OCTAVES[i].omega * time + WAVE_OCTAVES[i].phi;
        let cosP = cos(phase);
        let sinP = sin(phase);
        dN.x = dN.x + WAVE_OCTAVES[i].amplitude * WAVE_OCTAVES[i].kx * cosP;
        dN.y = dN.y + WAVE_OCTAVES[i].amplitude * WAVE_OCTAVES[i].ky * cosP;
        let kSq = WAVE_OCTAVES[i].kx * WAVE_OCTAVES[i].kx + WAVE_OCTAVES[i].ky * WAVE_OCTAVES[i].ky;
        divN = divN - WAVE_OCTAVES[i].amplitude * kSq * sinP;
    }
    var res: RippleResult;
    res.normalPerturbation = dN;
    res.analyticalDivergence = divN;
    return res;
}

fn evaluateCausticIntensity(
    depthMeters: f32,
    analyticalDivergence: f32,
    waterType: u32,
    intensityGain: f32
) -> f32 {
    let inRange = depthMeters > 0.01 && depthMeters <= 45.0;
    const MU_REFR: f32 = 0.2504;
    let safeDepth = clamp(depthMeters, 0.0, 50.0);
    let beta = select(0.0, MU_REFR * safeDepth * exp(-safeDepth * 0.18), inRange);
    let rawCaustic = 1.0 - (beta * analyticalDivergence) * intensityGain;
    let depthGate = 1.0 - smoothstep(12.0, 35.0, safeDepth);
    let caustic = max(0.0, mix(1.0, rawCaustic, depthGate));
    return select(1.0, caustic, inRange);
}

fn computeHydrosphereShading(
    worldPos: vec3<f32>,
    baseNormal: vec3<f32>,
    viewDir: vec3<f32>,
    sunDir: vec3<f32>,
    uvCoord: vec2<f32>,
    elevationMeters: f32,
    uniforms: HydrosphereUniforms,
    shadowFactor: f32
) -> vec4<f32> {
    let depthMeters = max(0.0, uniforms.u_seaLevelOffset - elevationMeters);
    let isWater = depthMeters > 0.001;
    let safeDepth = select(0.001, depthMeters, isWater);

    let rippleUv = uvCoord * 450.0;
    let ripples = evaluateMicroRipples(rippleUv, uniforms.u_time);

    let lambda = (uvCoord.x - 0.5) * (2.0 * PI);
    let sphereTangentX = vec3<f32>(cos(lambda), 0.0, -sin(lambda));
    let sphereTangentY = cross(baseNormal, sphereTangentX);
    let flatTangentX = vec3<f32>(1.0, 0.0, 0.0);
    let flatTangentY = vec3<f32>(0.0, 1.0, 0.0);
    let tangentX = normalize(mix(sphereTangentX, flatTangentX, sim.u_unfurl));
    let tangentY = normalize(mix(sphereTangentY, flatTangentY, sim.u_unfurl));

    let camDistToFrag = length(worldPos - sim.u_cameraPos.xyz);
    let rippleAtten = 1.0 - smoothstep(1.0, 7.0, max(0.0, camDistToFrag - RADIUS));
    let perturbedNormal = normalize(
        baseNormal + 
        (tangentX * ripples.normalPerturbation.x + tangentY * ripples.normalPerturbation.y) * (0.35 * rippleAtten)
    );

    let cosines = computeSlantPathCosines(baseNormal, sunDir, viewDir);
    let mu_s = cosines.x;
    let mu_v = cosines.y;

    // Jerlov radiative transfer optical properties:
    // Seamlessly transitions from coastal Type III emerald green to deep Type I crystal sapphire blue
    let props = getJerlovProperties(sim.u_waterClarity, safeDepth);

    // Benthic Substrate Albedo:
    // Shallow lagoons and coral atolls (0m - 50m) exhibit warm aragonite carbonate reef albedo
    // ALBEDO_CARBONATE_REEF = vec3(0.48, 0.54, 0.44), transitioning to abyssal basalt in deep basins
    let reefWeight = 1.0 - smoothstep(1.0, 50.0, safeDepth);
    let bedAlbedo = mix(ALBEDO_ABYSSAL_BASALT, ALBEDO_CARBONATE_REEF, reefWeight);

    // Multi-tier benthic sediment composition:
    // Ultra-shallow 0-16m: Bahamian white oolitic sand & coral reef flat crest
    // Shallow 16-50m: Aragonite coral reef sand
    // Continental shelf 50-200m: Terrigenous coastal silt
    // Deep ocean >200m: Abyssal basalt & pelagic clay
    let ooidGlow = 1.0 - smoothstep(0.5, 16.0, safeDepth);
    let shelfSilt = smoothstep(30.0, 120.0, safeDepth) * (1.0 - smoothstep(120.0, 350.0, safeDepth));
    let baseBedAlbedo = mix(mix(bedAlbedo, ALBEDO_WHITE_OOID, ooidGlow * 0.45), ALBEDO_COASTAL_SILT, shelfSilt * 0.40);
    // Enforce Prussian Cyanotype (Theme 2) cold photochemical blue-white shoal tones (zero warm olive/sepia)
    let cCyanotypeBed = mix(
        vec3<f32>(0.05, 0.10, 0.18),
        mix(vec3<f32>(0.32, 0.52, 0.70), vec3<f32>(0.62, 0.82, 0.96), ooidGlow * 0.60),
        reefWeight * 0.70 + ooidGlow * 0.30
    );
    let activeBedAlbedo = select(baseBedAlbedo, cCyanotypeBed, sim.u_theme == 2u);

    // Kubelka-Munk two-flux bottom reflectance evaluated with physical optical thickness
    let R_subsurface = evaluateKubelkaMunkReflectanceProps(safeDepth, props, activeBedAlbedo, mu_s, mu_v);

    // Austin-Petzold internal upwelling multiple reflection (air-water interface coupling)
    // Trapped light within the internal critical angle (rho_w = 0.485) amplifies shallow benthic radiance
    let internalReflect = 1.0 / max(vec3<f32>(0.2), vec3<f32>(1.0) - 0.485 * R_subsurface);
    let R_effective = R_subsurface * internalReflect;

    // Gerstner micro-ripple caustics focused onto shallow bathymetry
    let causticFactor = evaluateCausticIntensity(
        safeDepth,
        ripples.analyticalDivergence,
        uniforms.u_waterType,
        uniforms.u_causticIntensity
    );

    let NdotL = max(0.05, dot(baseNormal, sunDir));
    let cSunLight = select(vec3<f32>(1.08, 1.02, 0.94), vec3<f32>(0.95, 0.98, 1.02), sim.u_theme == 2u);

    // Pelagic Radiance & Bathymetric Gradient from Jerlov Radiative Transfer
    var cSkyAmbient: vec3<f32>;
    var cTrench: vec3<f32>;
    if (sim.u_theme == 2u) {
        cSkyAmbient = vec3<f32>(0.12, 0.22, 0.34);
        cTrench     = vec3<f32>(0.03, 0.05, 0.09); // Deep exposed prussiate #0E1824
    } else if (sim.u_theme == 1u) {
        cSkyAmbient = vec3<f32>(0.28, 0.34, 0.44);
        cTrench     = vec3<f32>(0.10, 0.16, 0.22); // Marine Indigo #263B52
    } else {
        cSkyAmbient = vec3<f32>(0.14, 0.18, 0.24);
        cTrench     = vec3<f32>(0.005, 0.015, 0.05); // Abyssal Trench #0F171F
    }

    // Coupled seabed direct radiance (strictly preserved for cloud shadow and solar illumination invariants)
    let seabedRadiance = R_subsurface * (NdotL * causticFactor * shadowFactor);

    // Downwelling direct sunlight with caustic modulation plus diffuse ambient skylight
    let downwellingSun = cSunLight * (NdotL * causticFactor * shadowFactor);
    let downwellingSky = cSkyAmbient * 0.45;
    let shelfSeabedRadiance = seabedRadiance * internalReflect * cSunLight + downwellingSky * R_effective;

    let sunIllum = cSunLight * (NdotL * 0.85 * shadowFactor + 0.15) + cSkyAmbient * 0.80;

    // Jerlov volume radiance: Type I crystal sapphire blue vs Type III emerald green
    let pelagicRadiance = clamp((props.Rinf * 36.0) * sunIllum, vec3<f32>(0.0), vec3<f32>(0.75));

    // Calibrated bathymetric depth regimes (shallows 0-200m, slope 200-2500m, abyss >2500m)
    let shelfBlend = smoothstep(1.5, 180.0, safeDepth);
    let shelfColor = mix(shelfSeabedRadiance, pelagicRadiance, shelfBlend);
    let slopeBlend = smoothstep(180.0, 2500.0, safeDepth);
    let slopeColor = mix(shelfColor, mix(pelagicRadiance, cTrench, 0.55), slopeBlend);
    let abyssBlend = smoothstep(2500.0, 10000.0, safeDepth);
    var waterColor = mix(slopeColor, cTrench, abyssBlend);

    let depthBlend = smoothstep(10.0, 2200.0, safeDepth);

    // Medium-specific water surface styling with depth-modulated archival wash glaze:
    // In shallow waters (0-50m), wash weight allows radiant carbonate reef glow to shine through.
    // In deep ocean basins (>200m), rich archival paper tooth & pigment washes fully take hold.
    let washAlpha = mix(0.28, 0.72, smoothstep(8.0, 160.0, safeDepth));

    if (sim.u_theme == 1u) {
        let cShoreWash = vec3<f32>(0.58, 0.70, 0.64);
        let cDeepWash  = vec3<f32>(0.24, 0.35, 0.46);
        let washTone = mix(cShoreWash, cDeepWash, depthBlend) * sunIllum;
        let fiberFreq = 1800.0 * max(0.1, sim.u_mediumProperties.y);
        var fiberTooth = 0.0;
        if (sim.u_roughness > 0.0) {
            fiberTooth = (hashPaper2D(uvCoord * fiberFreq) - 0.5) * (sim.u_roughness * 0.35);
        }
        waterColor = mix(waterColor, washTone * (1.0 + fiberTooth), washAlpha);
    } else if (sim.u_theme == 2u) {
        let cShallowCyan = vec3<f32>(0.20, 0.36, 0.54);
        let cDeepIndigo  = vec3<f32>(0.04, 0.09, 0.18);
        let cyanWash = mix(cShallowCyan, cDeepIndigo, depthBlend) * sunIllum;
        let linenFreq = 1400.0 * max(0.1, sim.u_mediumProperties.y);
        var linenTooth = 0.0;
        if (sim.u_roughness > 0.0) {
            linenTooth = (hashPaper2D(uvCoord * linenFreq) - 0.5) * (sim.u_roughness * 0.30);
        }
        waterColor = mix(waterColor, cyanWash * (1.0 + linenTooth), washAlpha * 0.92);
    } else if (sim.u_renderStyle < 2u) {
        // Theme 0 (Marie Tharp): Bruce Heezen & Marie Tharp / Heinrich Berann painted bathymetric wash
        let cTharpCoastal = vec3<f32>(0.08, 0.34, 0.42);
        let cTharpDeep    = vec3<f32>(0.02, 0.06, 0.14);
        let tharpWash = mix(cTharpCoastal, cTharpDeep, depthBlend) * sunIllum;
        let boardFreq = 750.0 * max(0.1, sim.u_mediumProperties.y);
        var boardTooth = 0.0;
        if (sim.u_roughness > 0.0) {
            boardTooth = (hashPaper2D(uvCoord * boardFreq) - 0.5) * (sim.u_roughness * 0.25);
        }
        waterColor = mix(waterColor, tharpWash * (1.0 + boardTooth), washAlpha * 0.95);
    }

    let NdotV = max(0.0, dot(perturbedNormal, viewDir));
    const F0_WATER: f32 = 0.0204;
    let fresnelWater = F0_WATER + (1.0 - F0_WATER) * pow(1.0 - max(0.0, dot(perturbedNormal, viewDir)), 5.0);
    let fresnel = fresnelWater;

    let H_spec = normalize(sunDir + viewDir);
    let NdotH = max(0.0, dot(perturbedNormal, H_spec));
    let sunSpecular = pow(NdotH, 64.0);

    // Dampen sky glare on the unfurled flat map so the ocean stays deep, clear, and visible
    let mapFresnelAtten = mix(1.0, 0.20, sim.u_unfurl);
    let isDark = sim.u_theme != 1u;
    let skyReflection = select(vec3<f32>(0.75, 0.85, 0.95), vec3<f32>(0.20, 0.38, 0.55), isDark) * (fresnel * mapFresnelAtten);
    let specAtten = mix(1.0, 0.35, sim.u_unfurl);

    // Physically-based Fresnel sun glint on water surfaces:
    // Couplings: direct solar radiance, cloud shadow attenuation, flat-sheet unfurl dampening, and paper substrate tooth
    let waterGlint = (sunSpecular * fresnel * specAtten * shadowFactor) * sunIllum * (1.0 - sim.u_roughness * 0.8);

    var mediumSpecular: vec3<f32>;
    if (sim.u_theme == 1u) {
        // Theme 1 (Cream Rag): Warm archival ivory/vellum ink luster
        mediumSpecular = waterGlint * vec3<f32>(0.96, 0.94, 0.88);
    } else if (sim.u_theme == 2u) {
        // Theme 2 (Prussian Cyanotype): Photochemical actinic blue-white exposure
        mediumSpecular = waterGlint * vec3<f32>(0.85, 0.92, 1.00);
    } else {
        // Theme 0 (Marie Tharp) / Base: Direct oceanic sun glint
        mediumSpecular = waterGlint * vec3<f32>(1.00, 0.98, 0.94);
    }

    let finalColor = waterColor * (1.0 - fresnel * 0.4) + skyReflection + mediumSpecular;

    // Dynamic optical transparency modulated by Beer-Lambert clarity (10% to 100%)
    let clarityNorm = clamp(sim.u_waterClarity, 0.08, 1.0);
    let kExtinction = 0.00035 / clarityNorm;
    let depthOpacity = 1.0 - exp(-safeDepth * kExtinction);
    let turbidityBase = mix(0.35, 0.08, clarityNorm);
    let maxOpacity = select(select(0.78, 0.65, sim.u_theme == 1u), 0.82, sim.u_theme == 2u);
    let waterOpacity = clamp(
        (turbidityBase + depthOpacity * 0.65 + fresnel * 0.15) * sim.u_layerOpacity,
        0.12,
        maxOpacity
    );

    let finalOutput = vec4<f32>(finalColor, waterOpacity);
    return select(vec4<f32>(0.0, 0.0, 0.0, 0.0), finalOutput, isWater);
}

// ----------------------------------------------------------------------------
// Manifold Kinematics Across All 5 Paradigms
// ----------------------------------------------------------------------------
fn evaluateGridManifold(uv: vec2<f32>, unfurl: f32, mode: u32) -> DeformedVertex {
    let lambda = (uv.x - 0.5) * TWO_PI_F32;
    let phi = (0.5 - uv.y) * PI_F32;
    let cosLat = cos(phi);
    let sinLat = sin(phi);
    let cosLon = cos(lambda);
    let sinLon = sin(lambda);
    let pos3D = vec3<f32>(RADIUS * cosLat * sinLon, RADIUS * sinLat, RADIUS * cosLat * cosLon);
    let clampedPhi = clamp(phi, -1.4835, 1.4835);
    let mercatorY = log(tan(PI_F32 * 0.25 + clampedPhi * 0.5)) * RADIUS;
    let mercatorX = lambda * RADIUS;
    let targetY = select(mercatorY, phi * RADIUS, mode == 0u);
    let target2D = vec2<f32>(mercatorX, targetY);
    return evaluateManifoldCore(
        pos3D, target2D, unfurl, mode,
        sim.u_time, sim.u_cursorHitPos, sim.u_cursorActive, sim.u_cursorVel
    );
}

fn decodeElevation(texColor: vec4<f32>) -> f32 {
    let normElev = texColor.a;
    return normElev * 19772.0 - 10924.0; // [-10,924m .. +8,848m]
}

fn evaluateSingleRegionalBoundsWeight(lon: f32, lat: f32) -> f32 {
    if (u_regionalOverlay.u_regionalActive != 1u) {
        return 0.0;
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
        return 0.0;
    }

    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) {
        return 0.0;
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
    return weightU * weightV;
}

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

    return max(bestTileWeight, evaluateSingleRegionalBoundsWeight(lon, lat));
}

fn getRegionalTexelSpacing(uv: vec2<f32>, fallbackTs: vec2<f32>) -> vec2<f32> {
    let lon = uv.x * 360.0 - 180.0;
    let lat = 90.0 - uv.y * 180.0;
    let cBounds = u_regionalOverlay.u_pad1;
    let hasClusterBounds = cBounds.z > cBounds.x && cBounds.w > cBounds.y;
    let inTileCluster = !hasClusterBounds || (lon >= cBounds.x && lon <= cBounds.z && lat >= cBounds.y && lat <= cBounds.w);
    let slotCount = select(0u, min(u_regionalOverlay.u_pad3, 64u), inTileCluster);
    if (slotCount == 0u) {
        return fallbackTs;
    }
    let gridF = max(1.0, round(sqrt(f32(slotCount))));
    let gridN = u32(gridF);
    let relX = clamp((lon - cBounds.x) / max(1e-5, cBounds.z - cBounds.x), 0.0, 0.99999);
    let relY = clamp((cBounds.w - lat) / max(1e-5, cBounds.w - cBounds.y), 0.0, 0.99999);
    let guessIdx = min(slotCount - 1u, u32(floor(relY * gridF)) * gridN + u32(floor(relX * gridF)));
    for (var step: u32 = 0u; step < slotCount; step = step + 1u) {
        let i = select(select(step, step - 1u, step <= guessIdx), guessIdx, step == 0u);
        let slot = u_tileSlots[i];
        let b = slot.bounds;
        if (lon >= b.x && lon <= b.z && lat >= b.y && lat <= b.w && b.z > b.x && b.w > b.y) {
            let slotSpanLon = max(0.0001, b.z - b.x);
            let slotSpanLat = max(0.0001, b.w - b.y);
            let effW = 256.0 * max(0.05, slot.tileMeta.z);
            let effH = 256.0 * max(0.05, slot.tileMeta.w);
            let slotTs = vec2<f32>((slotSpanLon / 360.0) / effW, (slotSpanLat / 180.0) / effH);
            return min(fallbackTs, slotTs);
        }
    }
    return fallbackTs;
}

var<private> p_cachedTileSlot: u32 = 0u;

fn sampleRegionalComposite(uv: vec2<f32>, globalSample: vec4<f32>, lod: f32) -> vec4<f32> {
    let lon = uv.x * 360.0 - 180.0;
    let lat = 90.0 - uv.y * 180.0;
    var compositeSample = globalSample;

    let cBounds = u_regionalOverlay.u_pad1;
    let hasClusterBounds = cBounds.z > cBounds.x && cBounds.w > cBounds.y;
    let inTileCluster = !hasClusterBounds || (lon >= cBounds.x && lon <= cBounds.z && lat >= cBounds.y && lat <= cBounds.w);
    let slotCount = select(0u, min(u_regionalOverlay.u_pad3, 64u), inTileCluster);
    let gridF = max(1.0, round(sqrt(f32(slotCount))));
    let gridN = u32(gridF);
    let relX = clamp((lon - cBounds.x) / max(1e-5, cBounds.z - cBounds.x), 0.0, 0.99999);
    let relY = clamp((cBounds.w - lat) / max(1e-5, cBounds.w - cBounds.y), 0.0, 0.99999);
    let rawGuessIdx = select(0u, min(slotCount - 1u, u32(floor(relY * gridF)) * gridN + u32(floor(relX * gridF))), slotCount > 0u);
    let cachedValid = p_cachedTileSlot < slotCount;
    let cb = u_tileSlots[select(0u, p_cachedTileSlot, cachedValid)].bounds;
    let inCached = cachedValid && lon >= cb.x && lon <= cb.z && lat >= cb.y && lat <= cb.w && cb.z > cb.x && cb.w > cb.y;
    let guessIdx = select(rawGuessIdx, p_cachedTileSlot, inCached);
    for (var step: u32 = 0u; step < slotCount; step = step + 1u) {
        let i = select(select(step, step - 1u, step <= guessIdx), guessIdx, step == 0u);
        let slot = u_tileSlots[i];
        let b = slot.bounds;
        if (lon >= b.x && lon <= b.z && lat >= b.y && lat <= b.w && b.z > b.x && b.w > b.y) {
            p_cachedTileSlot = i;
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
            let safeTileSample = vec4<f32>(tileSample.r, globalSample.g, globalSample.b, tileSample.a);
            compositeSample = mix(compositeSample, safeTileSample, slotWeight * tileLandGate);
            break;
        }
    }

    if (u_regionalOverlay.u_regionalActive == 1u) {
        let bounds = u_regionalOverlay.u_regionalBounds;
        let minLon = bounds.x;
        let minLat = bounds.y;
        let maxLon = bounds.z;
        let maxLat = bounds.w;
        if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat && maxLon > minLon && maxLat > minLat) {
            let regU = clamp((lon - minLon) / (maxLon - minLon), 0.0, 1.0);
            let regV = clamp((maxLat - lat) / (maxLat - minLat), 0.0, 1.0);
            let blendDeg = 0.08;
            let marginU = clamp(blendDeg / (maxLon - minLon), 0.001, 0.49);
            let marginV = clamp(blendDeg / (maxLat - minLat), 0.001, 0.49);
            let regW = smoothstep(0.0, marginU, min(regU, 1.0 - regU)) * smoothstep(0.0, marginV, min(regV, 1.0 - regV));
            let regSample = textureSampleLevel(u_regionalDEMTexture, u_demSampler, vec2<f32>(regU, regV), 0.0);
            let regLandGate = smoothstep(0.35, 0.65, globalSample.b);
            let safeRegSample = vec4<f32>(regSample.r, globalSample.g, globalSample.b, regSample.a);
            compositeSample = mix(compositeSample, safeRegSample, regW * regLandGate);
        }
    }

    return compositeSample;
}

@vertex
fn vs_main(input: VertexInput, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
    var output: VertexOutput;

    var inUv = input.uv;
    var inSurfaceType = input.surfaceType;
    let skirtFactor = input.target2D.z;

    var deformed: DeformedVertex;
    var inst: CDLODInstance;
    var instLod: f32 = 0.0;
    var morphAlpha: f32 = 0.0;

    if (u_cdlodControl.u_cdlodActive == 1u) {
        inst = cdlodInstances[instanceIdx];
        let p = input.position.xy;

        // Evaluate unmorphed coordinate & world position to compute camera distance r
        let uv_unmorphed = inst.minUV + p * inst.sizeUV;
        let unmorphed = evaluateGridManifold(uv_unmorphed, sim.u_unfurl, sim.u_mode);
        let r = length(unmorphed.pos - sim.u_cameraPos.xyz);

        // Morph factor alpha & continuous morph parameter k_morph in [0, 1] (Track D)
        let alpha = clamp((r - inst.morphStart) * inst.invMorphRange, 0.0, 1.0);
        let k_morph = alpha;
        morphAlpha = k_morph;

        // Snap odd grid coordinates in parameter space
        let p_morphed = p - alpha * (fract(p * 32.0) * (1.0 / 32.0));

        // Compute global parametric coordinate
        let uv = inst.minUV + p_morphed * inst.sizeUV;
        inUv = uv;

        // Continuous LOD fraction including morph progression
        inst.lodFraction = f32(inst.lod) + alpha;
        instLod = inst.lodFraction;

        // Pass canonical (u, v) directly into evaluateGridManifold
        deformed = evaluateGridManifold(uv, sim.u_unfurl, sim.u_mode);
    } else {
        deformed = evaluateGridManifold(inUv, sim.u_unfurl, sim.u_mode);
        let patchDistPre = length(sim.u_cameraPos.xyz - deformed.pos);
        inst.lodFraction = clamp(log2(max(1.0, patchDistPre * 0.2)), 0.0, 4.0);
        instLod = inst.lodFraction;
    }

    output.uv = inUv;
    output.surfaceType = inSurfaceType;

    let basePos = deformed.pos;
    let baseNormal = deformed.normal;

    // Continuous patch LOD based on camera distance to patch base position:
    // Prevents Nyquist sub-pixel sampling spikes while preserving bold 3D massif relief
    let patchDist = length(sim.u_cameraPos.xyz - basePos);
    let patchLOD = clamp(log2(max(1.0, patchDist * 0.2)), 0.0, 4.0);

    let uv = inUv;
    let demSample = textureSampleLevel(u_demTexture, u_demSampler, uv, min(patchLOD * 0.25, 1.0));
    let demSampleComp = sampleRegionalComposite(uv, demSample, 0.0);
    let elevMeters = decodeElevation(demSampleComp);
    output.elevation = elevMeters;

    // Liquid Hydrosphere shell: conforms to dynamic lake datum or global sea level
    let hydroSample = textureSampleLevel(u_hydroTexture, u_demSampler, inUv, 0.0);
    let z_lake = hydroSample.g * 9000.0;
    let isLake = demSampleComp.b > 0.45 && z_lake > 1.0;
    let localWaterDatum = select(sim.u_seaLevel, z_lake, isLake);

    // Calculate sea level displacement
    let depth = max(0.0, localWaterDatum - elevMeters);
    output.waterDepth = depth;

    // Polar displacement attenuation near singularities (prevent spiky mesh artifacts in Canada/Greenland/Siberia)
    let poleDist = abs(inUv.y - 0.5) * 2.0;
    let poleAtten = 1.0 - smoothstep(0.85, 0.98, poleDist);

    // Synchronous Dual-Surface Morphing Theorem (Theorem 3.3.2):
    // Zero gaps and zero z-fighting at shoreline (h = 0)
    var normalDisplacement = 0.0;
    let dispScale = sim.u_displacementScale * 2.8;
    // Lithosphere Crust: linear geometric elevation displacement & full bathymetry (0.65 dampening removed)
    let exponent = select(1.0, clamp(sim.u_peakExponent, 0.2, 4.0), sim.u_peakExponent > 0.01);
    if (sim.u_verticalScaleMode == 1u) {
        if (elevMeters >= 0.0) {
            // Symmetrical logarithmic elevation: expands lower/mid relief (hills/valleys) while smoothly bounding summits
            let logNormH = log(1.0 + elevMeters / 1200.0) / log(1.0 + 8848.0 / 1200.0);
            let expLogNormH = pow(clamp(logNormH, 0.0, 1.0), exponent);
            normalDisplacement = expLogNormH * dispScale * poleAtten;
        } else {
            // Symmetrical logarithmic bathymetry: reveals continental shelf and slope without core blowout
            let logNormD = log(1.0 + (-elevMeters) / 1500.0) / log(1.0 + 10924.0 / 1500.0);
            normalDisplacement = -logNormD * dispScale * poleAtten;
        }
    } else {
        if (elevMeters >= 0.0) {
            // True linear physical displacement: normalDisplacement = elevMeters * sim.u_elevationExaggeration
            let normH = elevMeters / 8848.0;
            let expNormH = pow(clamp(normH, 0.0, 1.0), exponent);
            normalDisplacement = expNormH * dispScale * poleAtten;
        } else {
            let normD = clamp(-elevMeters / 10924.0, 0.0, 1.0);
            // Continuous finite-slope continental shelf: eliminates vertical shear cliff at shoreline
            let shelfD = normD / (1.0 + 1.5 * (1.0 - normD));
            normalDisplacement = -shelfD * dispScale * poleAtten;
        }
    }

    // Grazing Horizon Parameterization for negative bathymetric displacement
    let viewDir = normalize(sim.u_cameraPos.xyz - basePos);
    let facing = dot(baseNormal, viewDir);
    let globeWeight = 1.0 - smoothstep(0.0, 0.05, sim.u_unfurl);
    let limbAtten = mix(1.0, smoothstep(0.000, 0.005, facing), globeWeight);
    if (normalDisplacement < 0.0) {
        normalDisplacement = normalDisplacement * limbAtten;
    }
    let isCrust = inSurfaceType < 0.5;
    let abyssalDrop = max(0.02, dispScale * 1.05 + 0.015);
    let skirtDepth = select(0.0, max(abyssalDrop, inst.sizeUV.y * 0.35 * dispScale), isCrust && skirtFactor > 0.0);
    if (inSurfaceType > 0.5) {
        let hideHydroShell = skirtFactor > 0.001 || (sim.u_renderStyle < 1u && abs(sim.u_seaLevel) <= 0.01 && !isLake) || depth <= 0.001;
        let hydroSkirtDrop = select(0.0, max(abyssalDrop, inst.sizeUV.y * 0.35 * dispScale), skirtFactor > 0.0);
        let waterDisp = (localWaterDatum / 8848.0) * dispScale * poleAtten;
        let waterDispAtten = select(waterDisp, waterDisp * limbAtten, waterDisp < 0.0);
        normalDisplacement = select(waterDispAtten, normalDisplacement - 0.025 - hydroSkirtDrop, hideHydroShell);
    }

    let worldP = basePos + baseNormal * (normalDisplacement - skirtDepth);
    output.worldPos = worldP;
    output.normal = baseNormal;
    output.skirtFactor = skirtFactor;
    let alpha = morphAlpha;
    output.lodInfo = vec2<f32>(f32(inst.lod), alpha);

    let posWorld = worldP;
    let posRelative = (posWorld - sim.u_cameraPosHigh.xyz) - sim.u_cameraPosLow.xyz;
    output.position = sim.u_viewProjectionMatrix * vec4<f32>(posRelative, 1.0);

    return output;
}

// ----------------------------------------------------------------------------
// Cloud Ground Shadow Projection & Soft Penumbra Filtering (Spec §2.1)
// ----------------------------------------------------------------------------
fn computeCloudShadowOffset(uv: vec2<f32>, sunAzimuthDeg: f32, sunAltitudeDeg: f32) -> vec2<f32> {
    const EARTH_RADIUS_KM: f32 = 6371.0;
    let cloudAltKm: f32 = select(2.5, sim.u_cloudAltitudeKm, sim.u_cloudAltitudeKm > 0.0);
    const TWO_PI_RE: f32 = 2.0 * 3.141592653589793 * EARTH_RADIUS_KM; // ~40030.17 km
    const PI_RE: f32 = 3.141592653589793 * EARTH_RADIUS_KM;           // ~20015.09 km

    // Key light sun azimuth (315.0 deg / NW) and altitude (45.0 deg) default
    let azDeg = select(315.0, sunAzimuthDeg, sunAzimuthDeg > 0.0);
    let altDeg = select(45.0, sunAltitudeDeg, sunAltitudeDeg > 0.0);

    let radAz = radians(azDeg);
    let radAlt = clamp(radians(altDeg), radians(5.0), radians(85.0)); // Prevent horizon division by zero
    let tanAlt = tan(radAlt);

    // Spherical metric tensor arc-length evaluation
    let cosLat = max(0.15, cos((uv.y - 0.5) * 3.141592653589793));

    // Spec §2.1 Equirectangular shadow displacement
    let deltaU = -(cloudAltKm / (tanAlt * TWO_PI_RE)) * cos(radAz) / cosLat;
    let deltaV =  (cloudAltKm / (tanAlt * PI_RE)) * sin(radAz);

    return vec2<f32>(deltaU, deltaV);
}

fn sampleCloudShadowFactor(uv: vec2<f32>, shadowOffset: vec2<f32>, intensity: f32) -> f32 {
    const EARTH_CIRCUMFERENCE_M: f32 = 40075000.0;
    let physicalRate = sim.u_cloudDriftRate / EARTH_CIRCUMFERENCE_M;
    let driftOffset = sim.u_time * physicalRate;
    let centerUV = vec2<f32>(fract(uv.x + driftOffset + shadowOffset.x), clamp(uv.y + shadowOffset.y, 0.001, 0.999));
    let cosLat = max(0.15, cos((uv.y - 0.5) * 3.141592653589793));

    // 20 km penumbra filter radius in UV space
    const PENUMBRA_KM: f32 = 20.0;
    const TWO_PI_RE: f32 = 40030.17;
    const PI_RE: f32 = 20015.09;
    let rU = (PENUMBRA_KM / TWO_PI_RE) / cosLat;
    let rV = PENUMBRA_KM / PI_RE;

    // 4 rotated jitter taps (Poisson disk distribution)
    let tap0 = vec2<f32>(fract(centerUV.x - 0.38 * rU), clamp(centerUV.y - 0.92 * rV, 0.0, 1.0));
    let tap1 = vec2<f32>(fract(centerUV.x + 0.92 * rU), clamp(centerUV.y - 0.38 * rV, 0.0, 1.0));
    let tap2 = vec2<f32>(fract(centerUV.x + 0.38 * rU), clamp(centerUV.y + 0.92 * rV, 0.0, 1.0));
    let tap3 = vec2<f32>(fract(centerUV.x - 0.92 * rU), clamp(centerUV.y + 0.38 * rV, 0.0, 1.0));

    // Explicit LOD 0.0
    let c0 = textureSampleLevel(u_cloudTexture, u_cloudSampler, tap0, 0.0).r;
    let c1 = textureSampleLevel(u_cloudTexture, u_cloudSampler, tap1, 0.0).r;
    let c2 = textureSampleLevel(u_cloudTexture, u_cloudSampler, tap2, 0.0).r;
    let c3 = textureSampleLevel(u_cloudTexture, u_cloudSampler, tap3, 0.0).r;

    let cloudDens = (c0 + c1 + c2 + c3) * 0.25;

    // Multi-stratum shadow ray projection & elevation decoupling (Milestone 4, Spec §8)
    let highShadowOffset = shadowOffset * 3.4;
    let highDriftOffset = driftOffset * 1.8;
    let highCenterUV = vec2<f32>(fract(uv.x + highDriftOffset + highShadowOffset.x), clamp(uv.y + highShadowOffset.y, 0.001, 0.999));
    const PENUMBRA_HIGH_KM: f32 = 35.0;
    let rU_high = (PENUMBRA_HIGH_KM / TWO_PI_RE) / cosLat;
    let rV_high = PENUMBRA_HIGH_KM / PI_RE;

    let tapHigh0 = vec2<f32>(fract(highCenterUV.x - 0.38 * rU_high), clamp(highCenterUV.y - 0.92 * rV_high, 0.0, 1.0));
    let tapHigh1 = vec2<f32>(fract(highCenterUV.x + 0.92 * rU_high), clamp(highCenterUV.y - 0.38 * rV_high, 0.0, 1.0));
    let tapHigh2 = vec2<f32>(fract(highCenterUV.x + 0.38 * rU_high), clamp(highCenterUV.y + 0.92 * rV_high, 0.0, 1.0));
    let tapHigh3 = vec2<f32>(fract(highCenterUV.x - 0.92 * rU_high), clamp(highCenterUV.y + 0.38 * rV_high, 0.0, 1.0));

    let h0 = textureSampleLevel(u_highCloudTexture, u_cloudSampler, tapHigh0, 0.0).r;
    let h1 = textureSampleLevel(u_highCloudTexture, u_cloudSampler, tapHigh1, 0.0).r;
    let h2 = textureSampleLevel(u_highCloudTexture, u_cloudSampler, tapHigh2, 0.0).r;
    let h3 = textureSampleLevel(u_highCloudTexture, u_cloudSampler, tapHigh3, 0.0).r;
    let highCloudDens = (h0 + h1 + h2 + h3) * 0.25;

    // Elevation decoupling: mountain peaks above cloudAltKm pierce low stratus
    let demSampleGlobal = textureSampleLevel(u_demTexture, u_demSampler, uv, 0.0);
    let demSample = demSampleGlobal;
    let terrainElevM = demSample.a * 19772.0 - 10924.0;
    let terrainH_km = max(0.0, terrainElevM) * 0.001;
    let cloudAltKm: f32 = select(2.5, sim.u_cloudAltitudeKm, sim.u_cloudAltitudeKm > 0.0);

    let deltaHLow = max(0.0, cloudAltKm - terrainH_km);
    let deltaHHigh = max(0.0, 8.5 - terrainH_km);
    let lowTerrainAtten = select(smoothstep(0.0, 0.5, deltaHLow), 0.0, deltaHLow <= 0.0);
    let highTerrainAtten = select(smoothstep(0.0, 1.0, deltaHHigh), 0.0, deltaHHigh <= 0.0);

    let lowTau = smoothstep(0.10, 0.35, cloudDens) * 0.70 * lowTerrainAtten;
    let highTau = smoothstep(0.12, 0.45, highCloudDens) * 0.30 * highTerrainAtten;
    let totalTau = lowTau + highTau;

    // Soft ground shadow attenuation per Spec §2.1 & Spec §8
    let shadowFactor = 1.0 - intensity * totalTau;
    return clamp(shadowFactor, 0.0, 1.0);
}

// ----------------------------------------------------------------------------
// apply_weather_pigmentation: Stage 3 Archival Ink Weather Overlays
//  (Explicit 3-Medium Branching)
// ----------------------------------------------------------------------------
fn apply_weather_pigmentation(
    precipRate: f32,
    theme: u32,
    mediumProps: vec4<f32>,
    baseColor: vec4<f32>
) -> vec4<f32> {
    let intensity = clamp(precipRate / 50.0, 0.0, 1.0);
    if (intensity <= 0.001) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    if (theme == 0u) {
        // Theme 0: Marie Tharp 1977 — Lithographic stipple density modulated by precipRate
        let stippleProb = clamp(intensity * 0.85 * max(0.1, mediumProps.w), 0.05, 0.95);
        let hashSeed = vec2<f32>(
            baseColor.r * 1337.1 + baseColor.b * 3141.5,
            baseColor.g * 2718.2 + precipRate * 42.0
        );
        let rng = hashPaper2D(hashSeed);
        let hasDot = select(0.0, 1.0, rng < stippleProb);
        let alpha = clamp(hasDot * intensity * 0.65 + intensity * 0.15, 0.0, 0.85);
        let cTharpIndigo = vec3<f32>(0.118, 0.161, 0.231); // #1E293B Marine Indigo
        return vec4<f32>(cTharpIndigo, alpha);
    } else if (theme == 1u) {
        // Theme 1: Cream Rag — Warm sepia-charcoal wash modulated by paper tooth (mediumProps.y)
        let paperTooth = mediumProps.y;
        let toothSeed = vec2<f32>(baseColor.g * 1920.0, baseColor.r * 1080.0) * max(0.1, paperTooth);
        let toothNoise = (hashPaper2D(toothSeed) - 0.5) * 0.35;
        let toothFactor = clamp(paperTooth * (1.0 + toothNoise), 0.5, 1.5);
        let alpha = clamp(intensity * 0.6 * toothFactor, 0.0, 0.90);
        return vec4<f32>(0.220, 0.188, 0.165, alpha);
    } else if (theme == 2u) {
        // Theme 2: Prussian Cyanotype 1842 — Actinic solarization to deep Prussian blue
        let gamma = max(0.1, mediumProps.z);
        let solarizedIntensity = pow(intensity, 1.0 / gamma);
        let alpha = clamp(solarizedIntensity * 0.8, 0.0, 0.95);
        return vec4<f32>(0.039, 0.098, 0.184, alpha);
    } else {
        // Defensive fallback for non-standard theme
        return vec4<f32>(0.220, 0.188, 0.165, intensity * 0.6);
    }
}

// ----------------------------------------------------------------------------
// sample_spectral_doppler: Standard Meteorological Radar Color Ramp
// ----------------------------------------------------------------------------
fn sample_spectral_doppler(precipRate: f32) -> vec4<f32> {
    if (precipRate < 0.1) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    let cLightBlue = vec3<f32>(0.25, 0.60, 1.00);
    let cGreen     = vec3<f32>(0.00, 0.78, 0.20);
    let cYellow    = vec3<f32>(1.00, 0.85, 0.00);
    let cOrange    = vec3<f32>(1.00, 0.47, 0.00);
    let cRed       = vec3<f32>(0.90, 0.00, 0.00);
    let cMagenta   = vec3<f32>(0.78, 0.00, 0.78);

    var color: vec3<f32>;
    var alpha: f32 = 0.75;

    if (precipRate < 1.0) {
        let t = (precipRate - 0.1) / 0.9;
        color = mix(cLightBlue * 0.8, cLightBlue, t);
        alpha = mix(0.40, 0.65, t);
    } else if (precipRate < 2.5) {
        let t = (precipRate - 1.0) / 1.5;
        color = mix(cLightBlue, cGreen, t);
        alpha = mix(0.65, 0.75, t);
    } else if (precipRate < 7.5) {
        let t = (precipRate - 2.5) / 5.0;
        color = mix(cGreen, cYellow, t);
        alpha = mix(0.75, 0.80, t);
    } else if (precipRate < 15.0) {
        let t = (precipRate - 7.5) / 7.5;
        color = mix(cYellow, cOrange, t);
        alpha = mix(0.80, 0.85, t);
    } else if (precipRate < 30.0) {
        let t = (precipRate - 15.0) / 15.0;
        color = mix(cOrange, cRed, t);
        alpha = mix(0.85, 0.90, t);
    } else {
        let t = clamp((precipRate - 30.0) / 20.0, 0.0, 1.0);
        color = mix(cRed, cMagenta, t);
        alpha = mix(0.90, 0.95, t);
    }

    return vec4<f32>(color, alpha);
}

// ----------------------------------------------------------------------------
// compute_valley_drainage: Modulates Leopold-Maddock river channel width by pluvial factor
// ----------------------------------------------------------------------------
fn compute_valley_drainage(baseWidth: f32, precipRate: f32, pluvialGamma: f32) -> f32 {
    let pluvialFactor = 1.0 + pluvialGamma * sqrt(clamp(precipRate, 0.0, 50.0));
    return baseWidth * pluvialFactor;
}

// ----------------------------------------------------------------------------
// sample_temperature_overlay: 2m Surface Temperature Thermal Wash & 10°C Isotherms
// ----------------------------------------------------------------------------
fn sample_temperature_overlay(tempC: f32, dTempPx: f32, theme: u32) -> vec4<f32> {
    let tNorm = clamp((tempC + 35.0) / 75.0, 0.0, 1.0);
    // 10°C isotherm interval + bold 0°C freezing line
    let isoFreq = tempC / 10.0;
    let distIso = min(fract(isoFreq), 1.0 - fract(isoFreq));
    let halfW = clamp(dTempPx / 10.0 * 1.15, 0.018, 0.14);
    let isIsotherm = 1.0 - smoothstep(0.0, halfW, distIso);
    let isFreezing = 1.0 - smoothstep(0.0, halfW * 1.6, abs(tempC) / 10.0);
    let moireGuard = 1.0 - smoothstep(0.35, 0.85, dTempPx / 10.0);
    let lineWeight = clamp((isIsotherm * 0.55 + isFreezing * 0.45) * moireGuard, 0.0, 1.0);

    if (theme == 0u) {
        let cCold = vec3<f32>(0.14, 0.42, 0.68);
        let cMild = vec3<f32>(0.76, 0.60, 0.28);
        let cWarm = vec3<f32>(0.82, 0.26, 0.16);
        let wash = select(mix(cCold, cMild, tNorm * 2.0), mix(cMild, cWarm, (tNorm - 0.5) * 2.0), tNorm > 0.5);
        let lineCol = select(vec3<f32>(0.92, 0.90, 0.86), vec3<f32>(0.35, 0.82, 0.96), isFreezing > 0.3);
        let rgb = mix(wash, lineCol, lineWeight * 0.85);
        return vec4<f32>(rgb, clamp(0.42 + lineWeight * 0.40, 0.0, 0.85));
    } else if (theme == 1u) {
        let cCold = vec3<f32>(0.22, 0.40, 0.58);
        let cMild = vec3<f32>(0.78, 0.64, 0.42);
        let cWarm = vec3<f32>(0.70, 0.25, 0.16);
        let wash = select(mix(cCold, cMild, tNorm * 2.0), mix(cMild, cWarm, (tNorm - 0.5) * 2.0), tNorm > 0.5);
        let lineCol = vec3<f32>(0.22, 0.19, 0.16);
        let rgb = mix(wash, lineCol, lineWeight * 0.85);
        return vec4<f32>(rgb, clamp(0.38 + lineWeight * 0.42, 0.0, 0.82));
    } else {
        // Theme 2: Strictly Monochromatic Prussian Cyanotype
        let cCold = vec3<f32>(0.04, 0.11, 0.22);
        let cMid  = vec3<f32>(0.28, 0.52, 0.76);
        let cWarm = vec3<f32>(0.82, 0.90, 0.97);
        let wash = select(mix(cCold, cMid, tNorm * 2.0), mix(cMid, cWarm, (tNorm - 0.5) * 2.0), tNorm > 0.5);
        let lineCol = vec3<f32>(0.91, 0.93, 0.96);
        let rgb = mix(wash, lineCol, lineWeight * 0.90);
        return vec4<f32>(rgb, clamp(0.44 + lineWeight * 0.42, 0.0, 0.88));
    }
}

// ----------------------------------------------------------------------------
// sample_z500_overlay: Synoptic 500 hPa Geopotential Isohypses (60m / 6 dam) & Baric Domes
// ----------------------------------------------------------------------------
fn sample_z500_overlay(
    tempC: f32,
    dewpointC: f32,
    dTempPx: f32,
    windVec: vec2<f32>,
    uv: vec2<f32>,
    dUV: vec2<f32>,
    theme: u32
) -> vec4<f32> {
    // Bolton (1980) vapor pressure e (hPa), specific humidity q, and virtual temperature Tv (K)
    let eVaporHpa = 6.112 * exp((17.67 * clamp(dewpointC, -60.0, 45.0)) / (clamp(dewpointC, -60.0, 45.0) + 243.5));
    let qSpec = 0.622 * eVaporHpa / max(500.0, 1013.25 - 0.378 * eVaporHpa);
    let TvSurface = (tempC + 273.15) * (1.0 + 0.608 * qSpec);
    // Mean 1000-500 hPa column virtual temperature (standard moist adiabatic lapse ~ 16.5 K to 700 hPa midpoint)
    let TvMean = TvSurface - 16.5;
    // Hypsometric equation: Delta Z_{1000-500} = (R_d / g_0) * ln(1000 / 500) * TvMean = 29.2712 * 0.693147 * TvMean = 20.289 * TvMean
    let hypsometricZ = 110.0 + 20.289 * (TvMean - 267.63) * 0.72 + 5540.0;
    let waveLon = uv.x * 6.0 * PI_F32;
    let waveLat = (0.5 - uv.y) * 2.0 * PI_F32;
    let coriolisSign = select(-1.0, 1.0, uv.y < 0.5);
    let geostrophicAnom = clamp((windVec.x * coriolisSign - windVec.y * 0.35) * 4.2, -95.0, 95.0);
    let rossbyWave = 65.0 * sin(waveLon) * sin(waveLat) + geostrophicAnom;
    let z500m = hypsometricZ + rossbyWave;

    let dWavePx = length(vec2<f32>(
        65.0 * 6.0 * PI_F32 * cos(waveLon) * sin(waveLat) * dUV.x,
        -65.0 * 2.0 * PI_F32 * sin(waveLon) * cos(waveLat) * dUV.y
    ));
    let dZ500Px = max(0.8, dTempPx * 14.6 + dWavePx);

    // 60m (6 dam) standard synoptic isohypse interval & 300m (30 dam) master index isohypse
    let zIndex = z500m / 60.0;
    let distMinor = min(fract(zIndex), 1.0 - fract(zIndex));
    let halfW = clamp((dZ500Px / 60.0) * 1.15, 0.020, 0.15);
    let isMinor = 1.0 - smoothstep(0.0, halfW, distMinor);

    let majorIdx = z500m / 300.0;
    let distMajor = min(fract(majorIdx), 1.0 - fract(majorIdx)) * 5.0;
    let isMajor = 1.0 - smoothstep(0.0, halfW * 1.75, distMajor);

    let moireGuard = 1.0 - smoothstep(0.40, 0.90, dZ500Px / 60.0);
    let contourAlpha = clamp((isMinor * 0.55 + isMajor * 0.45) * moireGuard, 0.0, 1.0);

    // High (H) ridge dome vs Low (L) cyclonic trough baric wash
    let ridgeWeight = smoothstep(5620.0, 5820.0, z500m);
    let troughWeight = 1.0 - smoothstep(5180.0, 5420.0, z500m);
    let domeWashAlpha = max(ridgeWeight, troughWeight) * 0.28;

    if (theme == 0u) {
        let cDome = select(vec3<f32>(0.22, 0.58, 0.78), vec3<f32>(0.85, 0.62, 0.24), ridgeWeight >= troughWeight);
        let cLine = select(vec3<f32>(0.78, 0.86, 0.92), vec3<f32>(0.96, 0.78, 0.38), isMajor > 0.3);
        let rgb = mix(cDome, cLine, smoothstep(0.05, 0.35, contourAlpha));
        return vec4<f32>(rgb, clamp(domeWashAlpha + contourAlpha * 0.78, 0.0, 0.88));
    } else if (theme == 1u) {
        let cDome = select(vec3<f32>(0.30, 0.46, 0.62), vec3<f32>(0.76, 0.52, 0.26), ridgeWeight >= troughWeight);
        let cLine = vec3<f32>(0.22, 0.19, 0.16);
        let rgb = mix(cDome, cLine, smoothstep(0.05, 0.35, contourAlpha));
        return vec4<f32>(rgb, clamp(domeWashAlpha + contourAlpha * 0.75, 0.0, 0.85));
    } else {
        // Theme 2: Strictly Monochromatic Prussian Cyanotype Isohypses
        let cDome = select(vec3<f32>(0.04, 0.10, 0.20), vec3<f32>(0.48, 0.68, 0.88), ridgeWeight >= troughWeight);
        let cLine = vec3<f32>(0.91, 0.93, 0.96);
        let rgb = mix(cDome, cLine, smoothstep(0.05, 0.35, contourAlpha));
        return vec4<f32>(rgb, clamp(domeWashAlpha + contourAlpha * 0.82, 0.0, 0.90));
    }
}

// ============================================================================
// Riemannian Exponential Map & Spherical Geodesic Advection on S^2
// ============================================================================
fn mapSphericalGeodesicUV(
    arrivalUV: vec2<f32>,
    windVelMps: vec2<f32>,
    deltaTSeconds: f32
) -> vec2<f32> {
    let lam_p = windVelMps.x * (INV_EARTH_RADIUS_M * deltaTSeconds);
    let phi_p = windVelMps.y * (INV_EARTH_RADIUS_M * deltaTSeconds);
    let sigma_sq = lam_p * lam_p + phi_p * phi_p;
    if (sigma_sq < 1e-12) {
        return arrivalUV;
    }
    let phi_a = (0.5 - arrivalUV.y) * PI_F32;
    let cos_phi_a = cos(phi_a);
    let sin_phi_a = sin(phi_a);
    let sigma = sqrt(sigma_sq);
    let sinc = select(1.0 - sigma_sq * 0.16666667, sin(sigma) / max(sigma, 1e-7), sigma > 1e-4);
    let cos_sigma = cos(sigma);
    let c_lam = sinc * lam_p;
    let c_phi = sinc * phi_p;
    let sin_phi_d = clamp(c_phi * cos_phi_a + cos_sigma * sin_phi_a, -1.0, 1.0);
    let phi_d = asin(sin_phi_d);
    let y = c_lam;
    let x = cos_sigma * cos_phi_a - c_phi * sin_phi_a;
    let delta_lambda = atan2(y, x);
    let uv_x = fract(arrivalUV.x + delta_lambda * INV_TWO_PI_F32 + 1.0);
    let uv_y = clamp(0.5 - phi_d * INV_PI_F32, 0.0001, 0.9999);
    return vec2<f32>(uv_x, uv_y);
}

// Bidirectional semi-Lagrangian great-circle advection helper
fn sampleAdvectedPrecipitationField(
    arrivalUV: vec2<f32>,
    windVelMps: vec2<f32>,
    tau: f32
) -> f32 {
    let advectionMultiplier = sim.u_advectionActive;
    let uv0 = mapSphericalGeodesicUV(arrivalUV, -windVelMps, tau * 3600.0 * advectionMultiplier);
    let uv1 = mapSphericalGeodesicUV(arrivalUV, windVelMps, (1.0 - tau) * 3600.0 * advectionMultiplier);
    let sample0 = textureSampleLevel(u_precipTexture, u_precipSampler, uv0, 0.0).r;
    let sample1 = textureSampleLevel(u_precipNextTexture, u_precipSampler, uv1, 0.0).r;
    return mix(sample0, sample1, tau);
}

// CDLOD Diagnostic Color Palette (Milestone 5 / R5)
fn getLODColor(lod: u32) -> vec3<f32> {
    switch (lod) {
        case 0u: { return vec3<f32>(0.10, 0.25, 0.65); } // LOD 0: Deep Cobalt
        case 1u: { return vec3<f32>(0.12, 0.58, 0.85); } // LOD 1: Cerulean
        case 2u: { return vec3<f32>(0.15, 0.72, 0.60); } // LOD 2: Turquoise/Teal
        case 3u: { return vec3<f32>(0.30, 0.78, 0.35); } // LOD 3: Meadow Green
        case 4u: { return vec3<f32>(0.85, 0.82, 0.20); } // LOD 4: Lemon Yellow
        case 5u: { return vec3<f32>(0.95, 0.58, 0.15); } // LOD 5: Amber Orange
        case 6u: { return vec3<f32>(0.92, 0.25, 0.20); } // LOD 6: Crimson
        case 7u: { return vec3<f32>(0.80, 0.20, 0.75); } // LOD 7: Magenta
        case 8u: { return vec3<f32>(0.55, 0.15, 0.85); } // LOD 8: Violet
        default: { return vec3<f32>(0.95, 0.95, 0.95); } // LOD 9+: Bright White
    }
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // 1. Unconditional derivative evaluation for WGSL uniform control flow conformance
    let du_dx = dpdx(input.uv.x);
    let du_dy = dpdy(input.uv.x);
    let dv_dx = dpdx(input.uv.y);
    let dv_dy = dpdy(input.uv.y);
    let dUV = fwidth(input.uv);

    // 2. Unconditional DEM 5-tap sampling with screen-space derivative LOD strictly before any branching/discard
    let duv_dx = vec2<f32>(du_dx, dv_dx);
    let duv_dy = vec2<f32>(du_dy, dv_dy);
    let demDims = textureDimensions(u_demTexture);
    let texSize = vec2<f32>(f32(demDims.x), f32(demDims.y));
    let deltaMax2 = max(dot(duv_dx * texSize, duv_dx * texSize), dot(duv_dy * texSize, duv_dy * texSize));
    let mipLOD = clamp(0.5 * log2(max(deltaMax2, 1e-4)) * 0.08, 0.0, 0.5);

    let pixelFootprintM = length(dUV) * (PI * EARTH_RADIUS_M);

    let mipStep = exp2(floor(mipLOD));
    let tsGlobal = (vec2<f32>(1.0, 1.0) / max(texSize, vec2<f32>(1.0, 1.0))) * max(1.0, mipStep);

    let demC = textureSampleLevel(u_demTexture, u_demSampler, input.uv, mipLOD);
    let regDims = textureDimensions(u_regionalDEMTexture);
    let rawRegWeightC = getRegionalBlendWeight(input.uv);
    let singleRegWeightC = evaluateSingleRegionalBoundsWeight(input.uv.x * 360.0 - 180.0, 90.0 - input.uv.y * 180.0);
    let regWeightC = rawRegWeightC * smoothstep(0.35, 0.65, demC.b);
    let regSpanLon = max(0.001, u_regionalOverlay.u_regionalBounds.z - u_regionalOverlay.u_regionalBounds.x);
    let regSpanLat = max(0.001, u_regionalOverlay.u_regionalBounds.w - u_regionalOverlay.u_regionalBounds.y);
    let tsRegionalBase = vec2<f32>(
        (regSpanLon / 360.0) / max(f32(regDims.x), 1.0),
        (regSpanLat / 180.0) / max(f32(regDims.y), 1.0)
    ) * max(1.0, mipStep);
    let tsRegionalValid = select(tsGlobal, tsRegionalBase, u_regionalOverlay.u_regionalActive == 1u && singleRegWeightC > 0.001);
    let tsRegional = getRegionalTexelSpacing(input.uv, tsRegionalValid);

    let ts = mix(tsGlobal, tsRegional * 1.15, regWeightC);
    let regStepRatio = clamp(tsGlobal.y / max(ts.y, 1e-6), 1.0, 12.0);
    let zoomNormBoost = clamp(0.08 / max(sim.u_displacementScale, 0.008), 1.0, 1.6);
    let slopeScale = clamp(mix(1.0, sqrt(regStepRatio) * 0.18, regWeightC) * zoomNormBoost, 1.0, 2.0);

    // Antimeridian seamless horizontal wrapping (fract on U) and polar clamp (clamp on V) to eliminate tile/seam artifacts
    let uvR = vec2<f32>(fract(input.uv.x + ts.x), clamp(input.uv.y, 0.0, 1.0));
    let uvL = vec2<f32>(fract(input.uv.x - ts.x + 1.0), clamp(input.uv.y, 0.0, 1.0));
    let uvU = vec2<f32>(input.uv.x, clamp(input.uv.y + ts.y, 0.0, 1.0));
    let uvD = vec2<f32>(input.uv.x, clamp(input.uv.y - ts.y, 0.0, 1.0));

    let demR = textureSampleLevel(u_demTexture, u_demSampler, uvR, mipLOD);
    let demL = textureSampleLevel(u_demTexture, u_demSampler, uvL, mipLOD);
    let demU = textureSampleLevel(u_demTexture, u_demSampler, uvU, mipLOD);
    let demD = textureSampleLevel(u_demTexture, u_demSampler, uvD, mipLOD);

    // Seamless Regional High-Resolution DEM Compositing (NOAA CUDEM ~10m)
    let finalDemC = sampleRegionalComposite(input.uv, demC, 0.0);
    let finalDemR = sampleRegionalComposite(uvR, demR, 0.0);
    let finalDemL = sampleRegionalComposite(uvL, demL, 0.0);
    let finalDemU = sampleRegionalComposite(uvU, demU, 0.0);
    let finalDemD = sampleRegionalComposite(uvD, demD, 0.0);

    // 3. Unconditional Cloud Ground Shadow 4-tap sampling strictly before dynamic branching/discard
    let shadowOffset = computeCloudShadowOffset(input.uv, sim.u_sunAzimuth, sim.u_sunAltitude);
    let camAltShadowKm = mix(max(0.05, (length(sim.u_cameraPos.xyz) - 5.0) * 1274.2), max(0.05, abs(sim.u_cameraPos.z) * 1274.2), clamp(sim.u_unfurl, 0.0, 1.0));
    let closeShadowFade = smoothstep(180.0, 520.0, camAltShadowKm);
    let shadowIntensity = sim.u_shadowIntensity * closeShadowFade;
    let shadowFactor = sampleCloudShadowFactor(input.uv, shadowOffset, shadowIntensity);

    // Unconditional Directional Terrain Horizon Self-Shadow sampling strictly before dynamic branching/discard (Section 2)
    let terrainShadowRaw = textureSampleLevel(u_terrainShadowTexture, u_terrainShadowSampler, input.uv, 0.0).r;
    let terrainShadowGlobal = select(1.0, terrainShadowRaw, u_terrainShadow.u_shadowMapDimensions.x > 0u && u_terrainShadow.u_sunAltitude > 0.0);

    // Unconditional 2-step high-resolution micro-horizon ray toward solar azimuth for 30m canyon walls & alpine ridges
    let sunAzRad = radians(sim.u_sunAzimuth);
    let sunAltRad = radians(max(1.0, sim.u_sunAltitude));
    let tanSunAlt = tan(sunAltRad);
    let rayLatRad = (0.5 - input.uv.y) * PI;
    let rayCosLat = max(0.15, cos(rayLatRad));
    let sunStepDir = vec2<f32>(sin(sunAzRad) / rayCosLat, -cos(sunAzRad));
    let h0Ray = decodeElevation(finalDemC);
    let uvRay1 = vec2<f32>(fract(input.uv.x + sunStepDir.x * ts.y * 3.0 + 1.0), clamp(input.uv.y + sunStepDir.y * ts.y * 3.0, 0.0, 1.0));
    let uvRay2 = vec2<f32>(fract(input.uv.x + sunStepDir.x * ts.y * 9.0 + 1.0), clamp(input.uv.y + sunStepDir.y * ts.y * 9.0, 0.0, 1.0));
    let hRay1 = decodeElevation(sampleRegionalComposite(uvRay1, demC, 0.0));
    let hRay2 = decodeElevation(sampleRegionalComposite(uvRay2, demC, 0.0));
    let baseStepM = max(12.0, ts.y * PI * EARTH_RADIUS_M);
    let slopeRay1 = (hRay1 - h0Ray) / (baseStepM * 3.0);
    let slopeRay2 = (hRay2 - h0Ray) / (baseStepM * 9.0);
    let maxSlopeRay = max(slopeRay1, slopeRay2);
    let microHorizonShadow = clamp((tanSunAlt - maxSlopeRay) / 0.14, 0.0, 1.0);
    let closeZoomShadowWeight = regWeightC * smoothstep(5.0, 50.0, 72.0 - sim.u_sunAltitude) * 0.22;
    let terrainShadow = terrainShadowGlobal * mix(1.0, microHorizonShadow, closeZoomShadowWeight);

    // Dynamic Geomorphic Drainage & Leopold-Maddock Hydrology sampling strictly before dynamic branching/discard
    let drainageSample = textureSampleLevel(u_drainageTexture, u_demSampler, input.uv, 0.0);

    // 4. Unconditional Precipitation, Next Precipitation, Wind, Temperature & Dewpoint Texture Sampling strictly before dynamic branching/discard
    let precipUV = input.uv;
    let precipRateRaw = textureSampleLevel(u_precipTexture, u_precipSampler, precipUV, 0.0).r;
    let windForAdvection = textureSampleLevel(u_windTexture, u_precipSampler, input.uv, 0.0);
    // The full bidirectional advection activates when two temporal frames are available
    // For now, store the scrub tau for downstream use
    let scrubTau = sim.u_scrubTau;
    let tempC = textureSampleLevel(u_tempTexture, u_precipSampler, precipUV, 0.0).r;
    let tempStepUV = vec2<f32>(1.0 / 3600.0, 1.0 / 1801.0);
    let tempR = textureSampleLevel(u_tempTexture, u_precipSampler, vec2<f32>(fract(precipUV.x + tempStepUV.x), precipUV.y), 0.0).r;
    let tempU = textureSampleLevel(u_tempTexture, u_precipSampler, vec2<f32>(precipUV.x, clamp(precipUV.y + tempStepUV.y, 0.0, 1.0)), 0.0).r;
    let dTempGrad = vec2<f32>((tempR - tempC) / tempStepUV.x, (tempU - tempC) / tempStepUV.y);
    let dTempPx = length(dTempGrad * dUV);
    let dewpointC = textureSampleLevel(u_dewpointTexture, u_precipSampler, precipUV, 0.0).r;
    let hydroSample = textureSampleLevel(u_hydroTexture, u_demSampler, input.uv, 0.0);
    let z_lake = hydroSample.g * 9000.0;
    let normSample0 = textureSampleLevel(u_normalTexture, u_demSampler, input.uv, 0.0);
    let lclMeters = 125.0 * max(tempC - dewpointC, 0.0);
    let demSample = finalDemC;
    let elevMeters = demSample.a * 19772.0 - 10924.0; // Standard DEM decode
    let lclGateRaw = smoothstep(lclMeters - 200.0, lclMeters, elevMeters);
    let lclGate = select(lclGateRaw, 1.0, sim.u_lclBypass > 0.5);
    // Unconditional semi-Lagrangian advection evaluation for WGSL uniform control flow conformance
    let precipAdvectedField = sampleAdvectedPrecipitationField(input.uv, windForAdvection.xy, scrubTau);
    let precipAdvected = select(precipRateRaw, precipAdvectedField, sim.u_advectionActive > 0.5);
    // Modulate precipitation by LCL gate while retaining synoptic marine/lowland precipitation floor
    let precipModulated = precipAdvected * max(lclGate, 0.72);
    let precipRate = precipModulated;

    let V = normalize(sim.u_cameraPos.xyz - input.worldPos);
    let N = normalize(input.normal);

    let isSkirt = input.skirtFactor > 0.5;
    if (input.surfaceType > 0.5 && isSkirt) {
        discard;
    }
    if (input.surfaceType > 0.5 && input.skirtFactor > 0.001) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    if (input.surfaceType > 0.5) {
        if (sim.u_purityMode > 0.5) {
            discard;
        }
        let isLake = finalDemC.b > 0.45 && z_lake > 1.0;
        if (sim.u_renderStyle == 0u && abs(sim.u_seaLevel) <= 0.01 && !isLake) {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
        // Dynamic lake datum evaluation: preserve water shell for inland lakes (e.g. Lake Titicaca at +3812m)
        let localWaterDatum = select(sim.u_seaLevel, z_lake, isLake);
        let depthMeters = max(0.0, localWaterDatum - elevMeters);
        if (depthMeters <= 0.001) {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }

        var hydroUniforms: HydrosphereUniforms;
        let clarityIdx = clamp(u32(floor((1.0 - clamp(sim.u_waterClarity, 0.0, 1.0)) * 4.0 + 0.5)), 0u, 4u);
        hydroUniforms.u_waterType = clarityIdx;
        hydroUniforms.u_time = sim.u_time;
        hydroUniforms.u_seaLevelOffset = localWaterDatum;
        hydroUniforms.u_causticIntensity = 1.0;
        hydroUniforms.u_sunAzimuth = sim.u_sunAzimuth;
        hydroUniforms.u_sunAltitude = sim.u_sunAltitude;
        hydroUniforms.u_roughness = sim.u_roughness;
        hydroUniforms.u_fresnelPower = 4.0;

        let sunPrimary = computeSunLightDir(sim.u_sunAzimuth, sim.u_sunAltitude);
        let safeElevation = elevMeters;
        let effectiveShadow = shadowFactor * terrainShadow;
        let hydroColor = computeHydrosphereShading(
            input.worldPos,
            N,
            V,
            sunPrimary,
            input.uv,
            safeElevation,
            hydroUniforms,
            effectiveShadow
        );

        if (hydroColor.a <= 0.001) {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }

        var hydroRgb = hydroColor.rgb;
        let hydroPrecipScaled = precipRate * select(4.5, 1.6, sim.u_weatherOpticalMode == 1u);
        var hydroOverlay: vec4<f32>;
        if (sim.u_weatherOpticalMode == 1u) {
            hydroOverlay = sample_spectral_doppler(hydroPrecipScaled);
        } else {
            hydroOverlay = apply_weather_pigmentation(
                hydroPrecipScaled,
                sim.u_theme,
                sim.u_mediumProperties,
                vec4<f32>(hydroRgb, 1.0)
            );
        }
        if (sim._padScrub1 > 3.5) {
            hydroOverlay = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        } else if (sim._padScrub1 > 2.5) {
            hydroOverlay = sample_z500_overlay(tempC, dewpointC, dTempPx, windForAdvection.xy, input.uv, dUV, sim.u_theme);
        } else if (sim._padScrub1 > 1.5) {
            hydroOverlay = sample_temperature_overlay(tempC, dTempPx, sim.u_theme);
        }
        hydroRgb = mix(hydroRgb, hydroOverlay.rgb, hydroOverlay.a);

        return vec4<f32>(hydroRgb, hydroColor.a);
    }

    let n0 = normalize(input.normal);

    // Continuous orthonormal tangent frame on sphere, unrolling cylinder & planar manifold
    // Follows the developable cylinder unroll angle uAngleTangent = (1 - alphaEased) * lambda so
    // tangentX remains unit-length and strictly orthogonal to n0 at all longitudes (preventing |lon|>90° cancellation during unfurl)
    let lambda = (input.uv.x - 0.5) * (2.0 * PI);
    let unfurlClamped = clamp(sim.u_unfurl, 0.0, 1.0);
    let unfurlEased = unfurlClamped * unfurlClamped * (3.0 - 2.0 * unfurlClamped);
    let uAngleTangent = (1.0 - unfurlEased) * lambda;
    let tangentX = vec3<f32>(cos(uAngleTangent), 0.0, -sin(uAngleTangent));
    let rawTangentY = cross(n0, tangentX);
    let tangentY = select(vec3<f32>(0.0, 1.0, 0.0), normalize(rawTangentY), length(rawTangentY) > 1e-5);

    let isLandBase = finalDemC.b;
    let landElevBase = finalDemC.r;
    let oceanDepthBase = finalDemC.g;

    // Dynamic coastal inundation & shelf exposure coupled to u_seaLevel
    let isLand = select(isLandBase, smoothstep(sim.u_seaLevel - 4.0, sim.u_seaLevel + 4.0, elevMeters), abs(sim.u_seaLevel) > 0.01);
    let landElev = select(landElevBase, max(0.0, (elevMeters - sim.u_seaLevel) / 8848.0), abs(sim.u_seaLevel) > 0.01);
    let oceanDepth = select(oceanDepthBase, max(0.0, (sim.u_seaLevel - elevMeters) / 10924.0), abs(sim.u_seaLevel) > 0.01);

    let onLand = isLand > 0.45;
    // True physical bathymetric elevation scale matching land elevation:
    // land: [0 .. +8848m] -> [0.0 .. 1.0]
    // ocean: [0 .. -10924m] -> [0.0 .. -1.2346]
    let bathyElev = -oceanDepth * (10924.0 / 8848.0);
    let hC = select(bathyElev, landElev, onLand);

    // Domain-aware one-sided finite differences: clamp cross-boundary taps to hC
    let hasR = select(finalDemR.b <= 0.45, finalDemR.b > 0.45, onLand);
    let hasL = select(finalDemL.b <= 0.45, finalDemL.b > 0.45, onLand);
    let hasU = select(finalDemU.b <= 0.45, finalDemU.b > 0.45, onLand);
    let hasD = select(finalDemD.b <= 0.45, finalDemD.b > 0.45, onLand);

    let rawHR = select(-finalDemR.g * (10924.0 / 8848.0), finalDemR.r, onLand);
    let rawHL = select(-finalDemL.g * (10924.0 / 8848.0), finalDemL.r, onLand);
    let rawHU = select(-finalDemU.g * (10924.0 / 8848.0), finalDemU.r, onLand);
    let rawHD = select(-finalDemD.g * (10924.0 / 8848.0), finalDemD.r, onLand);

    let effHR = select(hC, rawHR, hasR);
    let effHL = select(hC, rawHL, hasL);
    let effHU = select(hC, rawHU, hasU);
    let effHD = select(hC, rawHD, hasD);

    let hR = effHR;
    let hL = effHL;
    let hU = effHU;
    let hD = effHD;

    // Controlled displacement scale: calibrated for crisp Eduard Imhof Swiss relief hillshading
    // Gently boosted on unfurling/planar manifold while keeping rock cliff threshold invariant
    let planarReliefBoost = mix(1.0, 1.18, unfurlClamped);
    let dispScale = sim.u_displacementScale * 45.0 + 1.0;
    // Polar displacement and gradient attenuation near singularities (lat > 76.5°)
    // Smoothly attenuates finite difference spikes, Laplacian explosion, and tangential spinning near poles
    // Exact match with vertex shader poleAtten (0.85 to 0.98)
    let fragPoleDist = abs(input.uv.y - 0.5) * 2.0;
    let fragPoleAtten = 1.0 - smoothstep(0.85, 0.98, fragPoleDist);
    let cosLatPolar = max(0.0, cos((input.uv.y - 0.5) * PI));
    let polarLonAtten = smoothstep(0.01, 0.25, cosLatPolar);
    let cosLat = max(0.1, cos((input.uv.y - 0.5) * PI));
    let safeCosLat = max(0.08, cosLat);

    let scaleX = select(select(0.0, 1.0, hasR || hasL), 0.5, hasR && hasL);
    let scaleY = select(select(0.0, 1.0, hasU || hasD), 0.5, hasU && hasD);
    let dHx = (effHR - effHL) * scaleX * dispScale * slopeScale;
    let dHy = (effHD - effHU) * scaleY * dispScale * slopeScale;

    // Mountain massif normal damping: prevents gradient explosion into needle spikes at high summits
    let peakDamp = 1.0 / (1.0 + max(0.0, landElev - 0.20) * 1.6);
    let effDHx = dHx * planarReliefBoost * polarLonAtten * peakDamp;
    let effDHy = dHy * planarReliefBoost * polarLonAtten * peakDamp;

    // Discrete Laplacian Curvature evaluated strictly on domain-aware effective elevations
    let laplacian = ((effHR + effHL + effHU + effHD) - 4.0 * hC) * slopeScale;
    let effLaplacian = (laplacian / max(slopeScale, 1.0)) * fragPoleAtten * polarLonAtten;
    let kRidge  = clamp(-effLaplacian * 25.0, 0.0, 1.0);
    let kValley = clamp(effLaplacian * 45.0, 0.0, 1.0);

    // Perturbed surface normal in 3D world space with polar attenuation
    let perturbedN = normalize(n0 - (tangentX * effDHx + tangentY * effDHy) * fragPoleAtten);

    // Multi-Scale Normal Shading:
    // Blend between a 7.2 km macro-geomorphic baseline and a 450 m micro-structural baseline
    // using screen-space UV derivatives
    let multiScaleBlend = clamp((pixelFootprintM - 450.0) / (7200.0 - 450.0), 0.0, 1.0);

    // Micro-structural normal reconstructed from BC5 normal map: Z = sqrt(1.0 - X^2 - Y^2)
    let regNormalFade = 1.0 - regWeightC;
    let normX = (normSample0.r * 2.0 - 1.0) * regNormalFade;
    let normY = (normSample0.g * 2.0 - 1.0) * regNormalFade;
    let normZ = sqrt(max(0.0, 1.0 - normX * normX - normY * normY));
    let macroN = perturbedN; // 7.2 km macroscopic geomorphic baseline
    let microScale = (sim.u_displacementScale * 25.0 + 1.0) * mix(1.0, 1.15, unfurlClamped);
    let microN = normalize(macroN * normZ + (tangentX * normX + tangentY * normY) * (fragPoleAtten * microScale));

    // Multi-octave geomorphic micro-roughness normal perturbation (Track A.3)
    let rawCosSlope = clamp(dot(perturbedN, n0), 0.0, 1.0);
    let zoomMicroGate = (1.0 - smoothstep(250.0, 4500.0, pixelFootprintM)) * u_geomorphicMicro.u_microDetailStrength;
    let cosNormSlope = clamp(rawCosSlope - zoomMicroGate * 0.25 * (1.0 - rawCosSlope), 0.0, 1.0);
    let slopeNormWeight = (1.0 - smoothstep(0.55, 0.75, cosNormSlope));
    let microRoughWeight = (1.0 - smoothstep(250.0, 2500.0, pixelFootprintM)) * slopeNormWeight * u_geomorphicMicro.u_microDetailStrength;
    var accumGrad = vec2<f32>(0.0, 0.0);
    if (microRoughWeight > 0.0001 || zoomMicroGate > 0.0001) {
        accumGrad = evaluateGeomorphicMicroErosion(input.worldPos, tangentX, tangentY);
    }
    let sinNormSlope = sqrt(max(0.0, 1.0 - cosNormSlope * cosNormSlope));
    let screeAmp = 1.0 + smoothstep(0.55, 0.72, sinNormSlope) * 1.5 + kRidge * 1.25;
    let pGradX = accumGrad.x * (microRoughWeight * screeAmp * 0.35);
    let pGradY = accumGrad.y * (microRoughWeight * screeAmp * 0.35);
    let microN_enhanced = normalize(microN + (tangentX * pGradX + tangentY * pGradY));

    let blendedN = normalize(mix(microN_enhanced, macroN, multiScaleBlend));
    let effectiveNormal = select(blendedN, macroN, length(vec2<f32>(normX, normY)) < 0.01 && microRoughWeight < 0.001);

    // Multidirectional Oblique Solar Illumination controlled dynamically by u_sunAzimuth & u_sunAltitude
    let L1_view = computeSunLightDir(sim.u_sunAzimuth, sim.u_sunAltitude);
    let L2_view = computeSunLightDir(sim.u_sunAzimuth - 90.0, sim.u_sunAltitude * 0.65);

    let N_view_cam = normalize((sim.u_viewMatrix * vec4<f32>(effectiveNormal, 0.0)).xyz);
    let N_sheet = normalize(vec3<f32>(
        dot(effectiveNormal, tangentX),
        dot(effectiveNormal, tangentY),
        abs(dot(effectiveNormal, n0))
    ));
    let N_view = normalize(mix(N_view_cam, N_sheet, unfurlClamped));
    let NdotL1 = max(0.0, dot(N_view, L1_view)) * terrainShadow;
    let NdotL2 = max(0.0, dot(N_view, L2_view));

    var diffuseTotal = 0.08 + (0.72 * NdotL1) * shadowFactor + 0.20 * NdotL2;

    // Ridge Crest Contrast Enhancement & Valley Crevice AO (modulated by u_ambientOcclusion)
    let ridgeEnhance = (NdotL1 - 0.5) * kRidge * 0.22;
    diffuseTotal = clamp(diffuseTotal + ridgeEnhance * shadowFactor, 0.04, 1.40);
    let creviceAO = 1.0 - kValley * (0.85 * sim.u_ambientOcclusion);
    diffuseTotal = diffuseTotal * creviceAO;

    // Slope-Dependent Rock Cliff Exposure (theta > 35 degrees) (Track A.1)
    // Multi-scale slope evaluation: combines macro relief gradient with micro normal detail
    let landSlopeMag = length(vec2<f32>(effDHx, effDHy)) / planarReliefBoost;
    let macroSlopeGrad = landSlopeMag * 4.25;
    let microSlopeGrad = length(vec2<f32>(normX, normY)) / max(0.12, normZ);
    let totalSlopeGrad = max(macroSlopeGrad, microSlopeGrad);
    let cosSlope = clamp(1.0 / sqrt(1.0 + totalSlopeGrad * totalSlopeGrad), 0.0, 1.0);
    let slopeAngle = acos(cosSlope);
    let rockThreshold = select(0.610865, u_geomorphicMicro.u_rockSlopeThreshold, u_geomorphicMicro.u_rockSlopeThreshold > 0.01);
    let rockWeight = smoothstep(rockThreshold - 0.08, rockThreshold + 0.15, slopeAngle) * 0.95;

    // Eduard Imhof Directional Rock Strata & Couloir Fluting Hachures
    // Scaled with bounded C^inf local manifold coordinates + 3D erosion warp to prevent concentric elevation bullseye banding
    let effCamDistMetric = mix(length(sim.u_cameraPos.xyz), 5.0 + abs(sim.u_cameraPos.z), clamp(sim.u_unfurl, 0.0, 1.0));
    let closeMetricScale = mix(3.2, 1.0, smoothstep(5.12, 6.20, effCamDistMetric));
    let erosionWarp = vec2<f32>(accumGrad.x, accumGrad.y) * 0.35;
    let pMetric = vec3<f32>(
        sin(input.uv.x * 2400.0) * 16.0 + sin(input.uv.x * 18000.0) * (5.0 * closeMetricScale) + erosionWarp.x,
        sin(input.uv.y * 1200.0) * 16.0 + sin(input.uv.y * 9000.0) * (5.0 * closeMetricScale) + erosionWarp.y,
        landElev * 28.0 + (accumGrad.x - accumGrad.y) * 0.8
    );
    let gradDir = normalize(vec2<f32>(effDHx, effDHy) + vec2<f32>(1e-6, 1e-6));
    let strikeDir = vec2<f32>(-gradDir.y, gradDir.x);
    let uFall = dot(pMetric.xy, gradDir) + pMetric.z * 0.45;
    let uStrike = dot(pMetric.xy, strikeDir) + pMetric.z * 0.25;

    // Multi-octave geological bedding strata along strike direction
    let strata1 = sin(uStrike * 1.35);
    let strata2 = sin(uStrike * 3.40 + 0.9);
    let strata3 = sin(uStrike * 8.80 + 2.1) * 0.5;
    let strataTotal = strata1 * 0.50 + strata2 * 0.35 + strata3 * 0.15;

    // Couloir fluting gullies and joint fractures down the fall line
    let joint1 = sin(uFall * 1.90 + strataTotal * 1.8);
    let joint2 = sin(uFall * 4.80 + strataTotal * 2.4);
    let couloirTotal = joint1 * 0.65 + joint2 * 0.35;

    // Screen-space derivative dampening: preserves crisp intaglio fluting at regional survey altitude (3000-8000m footprint),
    // smoothly attenuating towards orbit (>24000m footprint) to prevent Moiré shimmering
    let detailFade = (1.0 - smoothstep(4500.0, 24000.0, pixelFootprintM)) * u_geomorphicMicro.u_microDetailStrength;
    let hachureModulation = clamp(0.55 + 0.45 * (couloirTotal * 0.60 + strataTotal * 0.40), 0.15, 1.35);
    let hachurePattern = mix(1.0, hachureModulation, detailFade * rockWeight);

    // High-frequency intaglio copperplate ruling-pen fluting & sharp V-notch couloir incisions
    let fluteFine = sin(uFall * 11.5 + strataTotal * 2.4);
    let fluteMicro = sin(uFall * 28.0 + strata2 * 3.0);
    let strataFine = sin(uStrike * 16.0 + 1.2);

    // V-notch profile for couloir crevices (deep incised troughs, razor-sharp arête crests)
    let couloirMacro = 0.5 + 0.5 * couloirTotal;
    let couloirFineNorm = 0.5 + 0.5 * fluteFine;
    let couloirMicroNorm = 0.5 + 0.5 * fluteMicro;
    let vNotchFluting = pow(clamp(couloirMacro * 0.45 + couloirFineNorm * 0.35 + couloirMicroNorm * 0.20, 0.0, 1.0), 2.2);

    // Stepped geological strata benches
    let strataLedge = clamp(0.5 + 0.5 * (strataTotal * 0.70 + strataFine * 0.30), 0.0, 1.0);
    let stepProfile = smoothstep(0.35, 0.65, strataLedge);

    var cRockDark: vec3<f32>;
    var cRockLit: vec3<f32>;
    var cSkyAmbient: vec3<f32>;
    var cLowland: vec3<f32>;
    var cPlateau: vec3<f32>;
    var cFlank: vec3<f32>;
    var cMontane: vec3<f32>;
    var cSummit: vec3<f32>;

    if (sim.u_theme == 2u) {
        // Prussian Cyanotype (Ferroprussiate Monochromatic Wash)
        cRockDark   = vec3<f32>(0.04, 0.08, 0.16); // Deep photochemical Prussian indigo #0A1428
        cRockLit    = vec3<f32>(0.88, 0.92, 0.96); // Sharp actinic chalk ruling-pen arêtes #E0EBF5
        cSkyAmbient = vec3<f32>(0.14, 0.22, 0.32);
        cLowland    = vec3<f32>(0.09, 0.16, 0.25); // Deep Prussian Ground #172940
        cPlateau    = vec3<f32>(0.18, 0.28, 0.42);
        cFlank      = vec3<f32>(0.34, 0.48, 0.64);
        cMontane    = vec3<f32>(0.52, 0.64, 0.76); // Washed Slate High Plateau
        cSummit     = vec3<f32>(0.92, 0.94, 0.96); // Chalk Ruling Pen #E8EDF2
    } else if (sim.u_theme == 1u) {
        // Cream Rag Paper (Eduard Imhof Swiss Alpine Relief)
        cRockDark   = vec3<f32>(0.22, 0.19, 0.16); // Archival sepia-charcoal ink #38302A
        cRockLit    = vec3<f32>(0.76, 0.71, 0.62); // Sunlit limestone crags #C2B59E
        cSkyAmbient = vec3<f32>(0.38, 0.40, 0.44);
        cLowland    = vec3<f32>(0.81, 0.71, 0.53); // Dune Ochre #CFB588
        cPlateau    = vec3<f32>(0.74, 0.63, 0.48); // Warm Steppe Ochre #BDA17A
        cFlank      = vec3<f32>(0.58, 0.44, 0.35); // Soft Umber Foothill #947059
        cMontane    = vec3<f32>(0.66, 0.56, 0.43); // Montane Steppe / Tibetan Plateau #A88E6E
        cSummit     = vec3<f32>(0.98, 0.97, 0.95); // Glacial White #FDFCFA
    } else {
        // Marie Tharp Physiographic (Dark Abyssal Trench to Parchment Land)
        cRockDark   = vec3<f32>(0.04, 0.06, 0.09); // Deep oceanic basalt crevice
        cRockLit    = vec3<f32>(0.56, 0.52, 0.44); // Illuminated mineral basalt
        cSkyAmbient = vec3<f32>(0.14, 0.18, 0.24);
        cLowland    = vec3<f32>(0.80, 0.71, 0.57); // Parchment Land #CBB692
        cPlateau    = vec3<f32>(0.72, 0.64, 0.52);
        cFlank      = vec3<f32>(0.60, 0.52, 0.42);
        cMontane    = vec3<f32>(0.68, 0.60, 0.48); // Archival Parchment Steppe
        cSummit     = vec3<f32>(0.96, 0.93, 0.88); // Alpine Ridge #F4EDE1
    }

    // Intaglio copperplate rock face shading:
    // 1. Directional micro-illumination: sunlit rock vs shadowed rock
    let rockSun = max(0.0, NdotL1) * shadowFactor;
    let rockDiffuse = mix(cRockDark, cRockLit, clamp(hachurePattern * diffuseTotal, 0.05, 1.0));

    // 2. Couloir incision: narrow V-notch troughs cut into the rock face with archival ink (preserving sunlit crags)
    let cCreviceInk = cRockDark;
    let incisionDepth = (1.0 - smoothstep(0.02, 0.18, vNotchFluting)) * detailFade;
    let rockIncised = mix(rockDiffuse, cCreviceInk, incisionDepth * 0.85);

    // 3. Geological bedding strata steps: horizontal ledges cross-cutting the couloirs
    let strataDisplacement = (stepProfile - 0.5) * 0.55 * detailFade;
    let rockWithStrata = clamp(rockIncised + strataDisplacement * (cRockLit - cRockDark), vec3<f32>(0.0), vec3<f32>(1.2));

    // 4. Knife-edge arêtes and rib highlights: sun-catching ridge crests
    let areteHighlight = smoothstep(0.32, 0.72, vNotchFluting) * (0.48 + 0.52 * rockSun) * detailFade;
    let cArete = select(cSummit, vec3<f32>(0.92, 0.95, 0.98), sim.u_theme == 2u);
    let cRockShaded = mix(rockWithStrata, cArete, areteHighlight * 0.80);

    // Natural Illumination Split: Warm Sun Direct + Cool Cerulean Sky Fill
    let cSunLight = select(vec3<f32>(1.08, 1.02, 0.94), vec3<f32>(0.96, 0.98, 1.02), sim.u_theme == 2u);
    let sunDirect = max(0.0, NdotL1) * shadowFactor;
    // Local sky dome exposure + view-space ambient fill (invariant to hemisphere / projection mode)
    let localSkyDome = clamp(dot(effectiveNormal, n0), 0.0, 1.0);
    let viewSkyFill = max(0.0, N_view.y * 0.35 + N_view.z * 0.65);
    let skyIndirect = 0.40 + 0.60 * (localSkyDome * 0.65 + viewSkyFill * 0.35);

    // Eduard Imhof Swiss Hypsometric Tinting with Physical Elevation Metre Ramps
    // Calibrated continuous transitions: lowlands (0..400m), piedmont/foothills (400..1400m),
    // mountain flanks (1400..3200m), montane steppe / high plateau (3200..5200m),
    // glacial summits & alpine ridges (>5200m).
    let hMeters = clamp(landElev * 8848.0, 0.0, 8848.0);
    let t0 = smoothstep(150.0, 650.0, hMeters);
    let t1 = smoothstep(650.0, 1600.0, hMeters);
    let t2 = smoothstep(1600.0, 3200.0, hMeters);
    let t3 = smoothstep(5200.0, 6800.0, hMeters);
    let cRamp = mix(mix(mix(mix(cLowland, cPlateau, t0), cFlank, t1), cMontane, t2), cSummit, t3);

    // Aerial Perspective & Illumination Combine
    var landIllum: vec3<f32>;
    let lowlandWeight = 1.0 - smoothstep(30.0, 600.0, hMeters);
    let lowlandMicroShade = (kRidge - kValley) * 0.40 * lowlandWeight;

    if (sim.u_theme == 1u) {
        // Eduard Imhof Dual-Temperature Vector Illumination:
        // Warm golden ochre on NW 315° direct illuminated slopes vs cool violet-umber on SE 135° shadowed slopes
        let cWarmDirect = vec3<f32>(1.14, 1.06, 0.94);
        let cSepiaCharcoal = vec3<f32>(0.22, 0.19, 0.16); // Archival sepia-charcoal ink #38302A
        let cCoolShadow = mix(vec3<f32>(0.35, 0.36, 0.45), cSepiaCharcoal, (1.0 - terrainShadow) * 0.65);
        let sunWeight = smoothstep(0.04, 0.68, NdotL1 * shadowFactor);
        let directComponent = cWarmDirect * (sunDirect * 0.90 + ridgeEnhance * 0.8 * shadowFactor);
        let shadowComponent = cCoolShadow * (skyIndirect * creviceAO);
        let lowlandLift = lowlandWeight * 0.12 * (1.0 + lowlandMicroShade) * terrainShadow;
        landIllum = mix(shadowComponent, directComponent, sunWeight) + cWarmDirect * lowlandLift;
    } else if (sim.u_theme == 2u) {
        // Prussian Cyanotype: Actinic Monochromatic Photochemical Illumination
        // STRICTLY MONOCHROMATIC — pure cool actinic blueprint lighting, zero warm/yellow sun component
        let cActinicDirect = vec3<f32>(0.96, 0.98, 1.02);
        let cPrussianNavyShadow = vec3<f32>(0.07, 0.14, 0.24); // Cold photochemical Prussian navy
        let cActinicShadow = mix(vec3<f32>(0.18, 0.32, 0.48), cPrussianNavyShadow, (1.0 - terrainShadow) * 0.70);
        let sunWeight = clamp(NdotL1 * 1.4 * shadowFactor, 0.0, 1.0);
        let directComponent = cActinicDirect * (sunDirect * 0.85 + ridgeEnhance * 0.8 * shadowFactor);
        let shadowComponent = cActinicShadow * (skyIndirect * creviceAO);
        landIllum = mix(shadowComponent, directComponent, sunWeight);
    } else {
        let cWarmSun = vec3<f32>(1.04, 0.98, 0.88);
        let cCoolHaze = vec3<f32>(0.84, 0.90, 1.06);
        let skyHaze = mix(cCoolHaze, cWarmSun, clamp(NdotL1 * 1.5 * shadowFactor, 0.0, 1.0));
        let cUmberCastShadow = vec3<f32>(0.22, 0.16, 0.12); // Berann hand-painted rich umber wash #2E241C
        let cSkyAmbientSave = cSkyAmbient;
        cSkyAmbient = mix(cSkyAmbient, cUmberCastShadow, (1.0 - terrainShadow) * 0.75);
        landIllum = (cSunLight * (sunDirect * 0.85 + ridgeEnhance * shadowFactor) + cSkyAmbient * (skyIndirect * creviceAO)) * skyHaze;
        cSkyAmbient = cSkyAmbientSave;
    }
    landIllum = landIllum * (1.0 + lowlandMicroShade * 0.30);
    let rawPlanZStage1 = abs(sim.u_cameraPos.z);
    let planAltStage1 = select(rawPlanZStage1, rawPlanZStage1 - 5.0, rawPlanZStage1 >= 5.0);
    let fragDistStage1 = length(sim.u_cameraPos.xyz - input.worldPos);
    let fragAltStage1 = select(fragDistStage1, fragDistStage1 - 5.0, fragDistStage1 >= 5.0);
    let camAltStage1Km = mix(max(0.05, (length(sim.u_cameraPos.xyz) - 5.0) * 1274.2), max(0.05, min(planAltStage1, fragAltStage1) * 1274.2), smoothstep(0.0, 0.25, unfurlClamped));
    let closeTopoPaperGate = (1.0 - smoothstep(320.0, 720.0, camAltStage1Km)) * clamp(u_geomorphicMicro.u_contourActive, 0.0, 1.0) * select(0.0, 1.0, sim.u_theme != 2u);
    let cCloseTopoSheet = select(vec3<f32>(0.82, 0.74, 0.60), vec3<f32>(0.86, 0.79, 0.66), sim.u_theme == 1u);
    let cEffectiveRamp = mix(cRamp, max(cRamp, cCloseTopoSheet), closeTopoPaperGate * 0.68);
    let closeIllumLift = mix(landIllum, max(landIllum, vec3<f32>(0.78, 0.74, 0.68)), closeTopoPaperGate * 0.45);
    let tintedLand = cEffectiveRamp * closeIllumLift;
    let steepWall = smoothstep(0.65, 0.85, slopeAngle);
    let alpineElevWeight = max(steepWall, smoothstep(300.0, 1500.0, hMeters));
    let effectiveRockWeight = rockWeight * select(1.0, alpineElevWeight, sim.u_theme == 1u) * (1.0 - closeTopoPaperGate * 0.55);
    var finalLand = mix(tintedLand, cRockShaded, effectiveRockWeight);

    // ========================================================================
    // STAGE 2 PHYSICAL MEDIUM AS INK: CONTINENTAL CRUST SHADING
    // ========================================================================
    if (sim.u_theme == 0u) {
        // --- THEME 0: MARIE THARP / HEINRICH BERANN (Physiographic Pen-and-Ink & Gouache on Illustration Board) ---
        let landSlope = length(vec2<f32>(effDHx, effDHy));
        let cGouacheParchment = vec3<f32>(0.96, 0.93, 0.88); // Alpine Ridge #F4EDE1
        let cInkTharp = vec3<f32>(0.18, 0.14, 0.11); // Archival bone-sepia drafting ink #2E241C
        let cParchmentInk = vec3<f32>(0.80, 0.71, 0.57); // Warm parchment ink tone #CBB692

        // 1. Berann-style gouache brushwork built up in layers following terrain contours & slope gradients
        // Directional stroke texture aligned to terrain slope gradient (broad, painterly character)
        let brushCoord = vec2<f32>(uStrike * 0.45, uFall * 0.25);
        let brush1 = sin(brushCoord.x * 2.0 + sin(brushCoord.y * 1.4) * 1.5);
        let brush2 = cos(brushCoord.x * 3.8 + brushCoord.y * 0.85);
        let painterlyBrush = (brush1 * 0.60 + brush2 * 0.40) * 0.5 + 0.5;

        let strokeFlank = smoothstep(0.04, 0.42, landSlope);
        let cGouacheBody = mix(cParchmentInk * 0.75, cGouacheParchment, painterlyBrush);
        let gouacheAlpha = painterlyBrush * strokeFlank * 0.28 * sim.u_mediumProperties.w * (1.0 - effectiveRockWeight * 0.60);
        finalLand = mix(finalLand, cGouacheBody, gouacheAlpha);

        // Gouache highlights on illuminated ridge crests and slope faces
        let gouacheLift = smoothstep(0.38, 0.88, diffuseTotal) * (kRidge * 0.45 + clamp(landSlope * 2.6, 0.0, 0.45));
        finalLand = mix(finalLand, cGouacheParchment, gouacheLift * 0.32 * (1.0 - effectiveRockWeight * 0.40));

        // Couloir crevices: etch deep fall-line incisions with archival bone-sepia drafting ink
        let couloirInkDepth = incisionDepth * effectiveRockWeight;
        finalLand = mix(finalLand, cInkTharp, couloirInkDepth * 0.95 * sim.u_mediumProperties.w);

        // Heinrich Berann Canyon & Escarpment Couloir Incision (active on canyon sidewalls & alpine flanks)
        let berannSlopeFlank = smoothstep(0.08, 0.36, landSlope);
        let canyonCouloirDepth = (1.0 - smoothstep(0.08, 0.44, vNotchFluting)) * berannSlopeFlank * detailFade;
        finalLand = mix(finalLand, cInkTharp, canyonCouloirDepth * 0.85 * sim.u_mediumProperties.w);

        // Heinrich Berann stepped geological strata terraces and benches on canyon walls and plateau scarps
        let strataBench = (stepProfile - 0.5) * 0.45 * smoothstep(0.05, 0.35, landSlope) * detailFade;
        finalLand = clamp(finalLand + strataBench * (cGouacheParchment - cInkTharp) * 0.75 * sim.u_mediumProperties.w, vec3<f32>(0.0), vec3<f32>(1.0));

        // Knife-edge arête gouache crests on sunlit ridges
        let berannRidgeArete = smoothstep(0.60, 0.92, vNotchFluting) * (kRidge * 0.55 + rockSun * 0.45) * detailFade;
        finalLand = mix(finalLand, cGouacheParchment, berannRidgeArete * 0.45 * sim.u_mediumProperties.w);

        // 2. Physiographic cross-hatching and slope-gradient pen-and-ink shading
        let inkTone = mix(cParchmentInk * 0.55, cInkTharp, smoothstep(0.08, 0.35, landSlope));

        let hatchSpacing1 = fract(uStrike * 1.85);
        let distHatch1 = min(hatchSpacing1, 1.0 - hatchSpacing1);
        let hatch1 = 1.0 - smoothstep(0.04, 0.12, distHatch1);

        let hatchSpacing2 = fract((uStrike * 0.707 + uFall * 0.707) * 1.85);
        let distHatch2 = min(hatchSpacing2, 1.0 - hatchSpacing2);
        let hatch2 = 1.0 - smoothstep(0.04, 0.12, distHatch2);

        let crossHatch = max(hatch1, hatch2 * smoothstep(0.25, 0.65, landSlope * 4.0));
        let shadowSlopeFactor = clamp((1.0 - NdotL1) * 0.75 + landSlope * 1.6, 0.0, 1.0);
        let riftChasm = smoothstep(0.06, 0.32, effLaplacian) * smoothstep(1200.0, 4500.0, hMeters);
        let physiographicHatch = crossHatch * shadowSlopeFactor * smoothstep(0.06, 0.40, landSlope) * (1.0 + riftChasm * 1.4) * detailFade;
        finalLand = mix(finalLand, inkTone, physiographicHatch * 0.35 * sim.u_mediumProperties.w);

        // Fine ruling-pen survey hachuring down the fall line on shadowed slopes and chasms
        let microHatchWave = sin(uFall * 9.2 + uStrike * 3.4);
        let fineHatch = smoothstep(0.32, 0.88, microHatchWave) * smoothstep(0.06, 0.36, landSlope) * shadowSlopeFactor;
        finalLand = mix(finalLand, inkTone, fineHatch * 0.50 * detailFade * sim.u_mediumProperties.w);

        // 3. Physiographic stippling on lowland transitions and plateaus modulated by stippleDensity (1.0)
        let stippleFreq = 1600.0 * max(0.1, sim.u_mediumProperties.w);
        let stippleCoord = vec2<f32>(input.uv.x * safeCosLat, input.uv.y) * stippleFreq;
        var dotMask = 0.0;
        if (sim.u_roughness > 0.0) {
            let cellId = floor(stippleCoord);
            let cellFract = fract(stippleCoord);
            let dotCenter = vec2<f32>(
                hashPaper2D(cellId + vec2<f32>(3.0, 11.0)),
                hashPaper2D(cellId + vec2<f32>(17.0, 31.0))
            ) * 0.6 + vec2<f32>(0.2);
            let distToDot = length(cellFract - dotCenter);

            let dotProb = clamp(0.10 + landSlope * 3.6 + (1.0 - diffuseTotal) * 0.20, 0.04, 0.82);
            let cellRng = hashPaper2D(cellId * 2.83 + vec2<f32>(11.7, 23.4));
            let hasDot = cellRng < dotProb;
            let dotRadius = mix(0.10, 0.22, clamp(landSlope * 3.2, 0.0, 1.0));
            dotMask = select(0.0, 1.0 - smoothstep(dotRadius - 0.04, dotRadius + 0.04, distToDot), hasDot) * fragPoleAtten;
        }
        let stippleTone = mix(cParchmentInk * 0.40, cInkTharp, smoothstep(0.05, 0.25, landSlope));
        finalLand = mix(finalLand, stippleTone, dotMask * 0.40 * sim.u_mediumProperties.w * sim.u_roughness);

        // Heinrich Berann high-density survey stippling on alpine scree, canyon benches & plateau scarps
        let microStippleFreq = 3200.0 * max(0.1, sim.u_mediumProperties.w);
        let microStippleCoord = vec2<f32>(input.uv.x * safeCosLat, input.uv.y) * microStippleFreq;
        var microDotMask = 0.0;
        if (sim.u_roughness > 0.0 && detailFade > 0.01) {
            let mCellId = floor(microStippleCoord);
            let mCellFract = fract(microStippleCoord);
            let mDotCenter = vec2<f32>(
                hashPaper2D(mCellId + vec2<f32>(7.0, 19.0)),
                hashPaper2D(mCellId + vec2<f32>(23.0, 41.0))
            ) * 0.6 + vec2<f32>(0.2);
            let mDist = length(mCellFract - mDotCenter);
            let mDotProb = clamp(landSlope * 4.2 + (1.0 - diffuseTotal) * 0.35 + riftChasm * 0.50, 0.02, 0.88);
            let mCellRng = hashPaper2D(mCellId * 3.41 + vec2<f32>(19.1, 47.7));
            let mHasDot = mCellRng < mDotProb;
            let mDotRadius = mix(0.08, 0.20, clamp(landSlope * 3.0, 0.0, 1.0));
            microDotMask = select(0.0, 1.0 - smoothstep(mDotRadius - 0.03, mDotRadius + 0.03, mDist), mHasDot) * fragPoleAtten;
        }
        let cBerannStipple = mix(cParchmentInk * 0.35, cInkTharp, smoothstep(0.04, 0.22, landSlope));
        finalLand = mix(finalLand, cBerannStipple, microDotMask * 0.55 * detailFade * sim.u_mediumProperties.w * sim.u_roughness);

        // 4. Illustration board substrate: smoother, less fibrous than cotton rag, with lower frequency broader grain
        let boardFreq = 750.0 * max(0.1, sim.u_mediumProperties.y);
        let boardCoord = vec2<f32>(input.uv.x * cosLat, input.uv.y) * boardFreq;
        var boardTooth = 0.0;
        if (sim.u_roughness > 0.0) {
            let boardFleck1 = hashPaper2D(boardCoord);
            let boardFleck2 = hashPaper2D(boardCoord * 0.45 + vec2<f32>(19.3, 57.1));
            boardTooth = (boardFleck1 * 0.65 + boardFleck2 * 0.35 - 0.50) * (sim.u_roughness * 0.40);

            // Directional raking light micro-shadows across cold-press illustration board
            let lenL_xy = length(L1_view.xy);
            let L_tangent = select(vec2<f32>(0.70710678, 0.70710678), L1_view.xy / max(lenL_xy, 1e-6), lenL_xy > 1e-4);
            let bCoordSun = boardCoord - L_tangent * 0.80;
            let bFleckSun1 = hashPaper2D(bCoordSun);
            let bFleckSun2 = hashPaper2D(bCoordSun * 0.45 + vec2<f32>(19.3, 57.1));
            let boardToothSun = (bFleckSun1 * 0.65 + bFleckSun2 * 0.35 - 0.50) * (sim.u_roughness * 0.40);
            let boardSlopeL = boardTooth - boardToothSun;
            let tharpRakingOblique = mix(0.70, 1.60, clamp((1.0 - NdotL1) * 1.4 + (1.0 - max(0.05, L1_view.z)) * 0.7, 0.0, 1.0));
            let boardMicroShadow = max(0.0, -boardSlopeL) * tharpRakingOblique;
            let cBoardUmberShadow = vec3<f32>(0.16, 0.12, 0.09);
            finalLand = mix(finalLand, cBoardUmberShadow, clamp(boardMicroShadow * 0.40, 0.0, 0.38));
        }
        finalLand = clamp(finalLand * (1.0 + boardTooth), vec3<f32>(0.0), vec3<f32>(1.0));

        // Subtractive ink absorption into warm parchment illustration board
        let kTharpInk = vec3<f32>(1.55, 1.70, 2.00); // Warm sepia-umber absorption
        let surfaceLumaTharp = dot(finalLand, vec3<f32>(0.299, 0.587, 0.114));
        let inkDensityTharp = clamp(1.0 - surfaceLumaTharp, 0.0, 1.0);
        let cBoardBase = vec3<f32>(0.80, 0.71, 0.57); // Warm parchment #CBB692
        let boardAbsorbed = cBoardBase * exp(-kTharpInk * (inkDensityTharp * 0.85));
        finalLand = mix(finalLand, boardAbsorbed, clamp(sim.u_mediumProperties.x * 0.35, 0.0, 0.50));
    } else if (sim.u_theme == 1u) {
        // --- THEME 1: CREAM RAG (Copperplate Intaglio on Cotton Rag) ---
        // 1. Dual-scale anisotropic cellulose fibers modulated by fiberDensity & u_roughness
        let fiberFreq = 1800.0 * max(0.1, sim.u_mediumProperties.y);
        let fiberCoord = input.uv * fiberFreq;
        var fiberTooth = 0.0;
        var fiberFleck = 0.5;
        var fiberStrand = 0.5;
        if (sim.u_roughness > 0.0) {
            fiberFleck = hashPaper2D(fiberCoord);
            fiberStrand = hashPaper2D(vec2<f32>(fiberCoord.x * 0.45 + 37.0, fiberCoord.y * 1.95 + 83.0));
            fiberTooth = (fiberFleck * 0.60 + fiberStrand * 0.40 - 0.50) * (sim.u_roughness * 0.85);
        }

        // Grazing raking light amplifies micro-shadows behind individual fibers under oblique sun angles
        // Directional fiber shadowing: gradient along 2D sun vector casts elongated shadows behind fiber crests
        let lenL1_xy = length(L1_view.xy);
        let L_tangent = select(vec2<f32>(0.70710678, 0.70710678), L1_view.xy / max(lenL1_xy, 1e-6), lenL1_xy > 1e-4);
        let sunGrazing = clamp(1.0 - max(0.05, L1_view.z), 0.0, 1.0);
        let rakingOblique = mix(0.70, 1.85, clamp((1.0 - NdotL1) * 1.5 + sunGrazing * 0.75, 0.0, 1.0));

        if (sim.u_roughness > 0.0) {
            let fiberStep = L_tangent * 0.85;
            let fiberCoordSun = fiberCoord - fiberStep;
            let fiberFleckSun = hashPaper2D(fiberCoordSun);
            let fiberStrandSun = hashPaper2D(vec2<f32>(fiberCoordSun.x * 0.45 + 37.0, fiberCoordSun.y * 1.95 + 83.0));
            let fiberToothSun = (fiberFleckSun * 0.60 + fiberStrandSun * 0.40 - 0.50) * (sim.u_roughness * 0.85);
            let fiberSlopeL = fiberTooth - fiberToothSun;

            let fiberHighlight = max(0.0, fiberSlopeL) * rakingOblique * 1.4;
            let fiberMicroShadow = max(0.0, -fiberSlopeL) * rakingOblique * 1.8;

            // In archival 310 GSM cotton rag, micro-shadows subtractively absorb light into sepia tone (#38302A)
            let cArchivalSepiaTone = vec3<f32>(0.22, 0.19, 0.16); // Archival sepia-charcoal ink #38302A
            finalLand = mix(finalLand, finalLand * cArchivalSepiaTone * 2.2, clamp(fiberMicroShadow * 0.14, 0.0, 0.22));
            finalLand = finalLand * (1.0 + fiberHighlight * 0.08);
        }

        let toothGlaze = 1.0 + fiberTooth * rakingOblique * 0.10;
        finalLand = clamp(finalLand * toothGlaze, vec3<f32>(0.0), vec3<f32>(1.0));

        // 2. Johann Georg Lehmann (1799) slope-angle hachuring (steep alpine faces theta > 20°)
        let slopeAngle = acos(cosSlope);
        let rad20 = 0.349066; // 20° in radians
        let rad45 = 0.785398; // 45° in radians
        if (slopeAngle > rad20) {
            let slopeIntensity = clamp((slopeAngle - rad20) / (rad45 - rad20), 0.0, 1.0);
            let hatchSpacing = fract(uStrike * 1.35);
            let distToHatch = min(hatchSpacing, 1.0 - hatchSpacing);

            // Capillary ink wicking along cellulose fiber strands
            let capillaryWick = (fiberFleck * 0.40 + fiberStrand * 0.60 - 0.50) * (sim.u_mediumProperties.x * 0.06);
            // Stroke width increases with slope angle (Lehmann's principle: steeper = denser/thicker)
            let strokeHalfW = mix(0.04, 0.32, slopeIntensity);
            let strokeBleedW = max(0.015, strokeHalfW + capillaryWick);
            let hatchCoverage = 1.0 - smoothstep(strokeBleedW - 0.035, strokeBleedW + 0.035, distToHatch);
            // Intermittent engraved cuts along the fall line with microscopic capillary wicking
            let strokeCut = smoothstep(0.18 + capillaryWick * 0.5, 0.22, fract(uFall * 0.42));
            let lehmannAlpine = smoothstep(400.0, 1400.0, hMeters) * detailFade * (0.30 + 0.70 * rockWeight);
            let lehmannStroke = hatchCoverage * strokeCut * slopeIntensity * lehmannAlpine;
            let cCopperplateSepia = vec3<f32>(0.22, 0.19, 0.16); // Archival sepia-charcoal ink #38302A
            let kSepiaHachure = vec3<f32>(1.45, 1.72, 2.15);
            let hachureAbsorbed = finalLand * exp(-kSepiaHachure * (lehmannStroke * 1.85));
            finalLand = mix(finalLand, cCopperplateSepia, lehmannStroke * 0.52);
            finalLand = mix(finalLand, hachureAbsorbed, lehmannStroke * 0.42 * sim.u_mediumProperties.x);
        }

        // 3. Subtractive Kubelka-Munk intaglio ink absorption with capillary micro-bleed into fibers
        let capillaryBleed = fiberTooth * (sim.u_mediumProperties.x * 0.35);
        let kSepia = vec3<f32>(1.45, 1.72, 2.15); // Sepia spectral absorption
        let shadowDepth = clamp(1.0 - diffuseTotal, 0.0, 1.0);
        let slopeGrip = smoothstep(0.04, 0.25, length(vec2<f32>(effDHx, effDHy)));
        let shadowCastGrip = max(slopeGrip, (1.0 - terrainShadow) * 0.60);
        let inkDensity = clamp(shadowDepth * shadowCastGrip * 0.45, 0.0, 0.60);
        let cPaperBase = vec3<f32>(0.953, 0.925, 0.878); // Arches 300gsm Cream Rag #F3ECE0
        let intaglioAbsorbed = mix(cPaperBase, finalLand, 0.65) * exp(-kSepia * (inkDensity * (1.0 + capillaryBleed)));
        let inkBlend = clamp(inkDensity * 1.5 * sim.u_mediumProperties.x, 0.0, 0.70);
        finalLand = mix(finalLand, intaglioAbsorbed, inkBlend);

        // Calibrated copperplate intaglio plate indentation:
        // Roller press compression embeds ink into damp 300 GSM cotton rag, embossing fine debossed bevels
        let plateIndentation = smoothstep(0.06, 0.35, length(vec2<f32>(effDHx, effDHy))) * (0.22 * sim.u_mediumProperties.x);
        finalLand = finalLand * (1.0 - plateIndentation * (1.0 - NdotL1 * 0.65));
    } else if (sim.u_theme == 2u) {
        // --- THEME 2: PRUSSIAN CYANOTYPE (1842 John Herschel Photochemical Model) ---
        // Actinic exposure model: elevation inversion with sensitometric curve E = (1.0 - elevNorm)^exposureGamma
        let normLandElev = clamp(landElev, 0.0, 1.0);
        let landExposure = pow(clamp(1.0 - normLandElev, 0.0, 1.0), max(0.1, sim.u_mediumProperties.z));
        let cChalkRulingPen = vec3<f32>(0.91, 0.93, 0.96); // Unexposed summit resist #E8EDF2
        let cWashedCerulean = vec3<f32>(0.09, 0.16, 0.25); // Lowland blueprint wash #172940
        let developedCyanotype = mix(cChalkRulingPen, cWashedCerulean, smoothstep(0.04, 0.80, landExposure));

        // Precision technical blueprint relief: modulate sensitized emulsion with actinic directional illumination
        let cyanShaded = developedCyanotype * landIllum;

        // Summits, sharp ridges, and crests wash out to crisp ruling-pen chalk linework (#E8EDF2)
        let unexposedResist = smoothstep(0.65, 0.98, normLandElev) + kRidge * 0.50;
        let cyanBase = mix(cyanShaded, cChalkRulingPen, clamp(unexposedResist, 0.0, 0.95));
        finalLand = mix(cyanBase, cRockShaded, effectiveRockWeight * detailFade * 1.15);

        // Blueprint ruling-pen cross-hatching along strike and fall lines (strictly monochromatic)
        let cyanoHatchSpacing1 = fract(uStrike * 1.85);
        let cyanoDistHatch1 = min(cyanoHatchSpacing1, 1.0 - cyanoHatchSpacing1);
        let cyanoHatch1 = 1.0 - smoothstep(0.04, 0.14, cyanoDistHatch1);
        let cyanoHatchSpacing2 = fract(uFall * 1.45);
        let cyanoDistHatch2 = min(cyanoHatchSpacing2, 1.0 - cyanoHatchSpacing2);
        let cyanoHatch2 = 1.0 - smoothstep(0.04, 0.14, cyanoDistHatch2);
        let cyanoSlopeGate = smoothstep(0.02, 0.24, length(vec2<f32>(effDHx, effDHy)));
        let cyanoCrossHatch = max(cyanoHatch1, cyanoHatch2 * 0.75) * cyanoSlopeGate * detailFade;
        let cBlueprintIndigo = vec3<f32>(0.04, 0.08, 0.16);
        finalLand = mix(finalLand, cBlueprintIndigo, cyanoCrossHatch * 0.50 * (1.0 - NdotL1 * 0.45));
        finalLand = mix(finalLand, cChalkRulingPen, cyanoHatch1 * cyanoSlopeGate * detailFade * NdotL1 * 0.42);

        // 1. Prussian Blue Crystal Precipitation Noise (colloidal ferroprussiate micro-crystals)
        // High-frequency crystalline granularity in deep exposure regions — NOT smooth gradients
        let crystalFreq = 2600.0 * max(0.1, sim.u_mediumProperties.y);
        let crystalCoord = vec2<f32>(input.uv.x * cosLat, input.uv.y) * crystalFreq;
        var crystalGranularity = 0.0;
        if (sim.u_roughness > 0.0) {
            let crystal1 = hashPaper2D(crystalCoord);
            let crystal2 = hashPaper2D(crystalCoord * 1.618 + vec2<f32>(13.7, 47.3));
            crystalGranularity = (crystal1 * crystal2 - 0.22) * 2.2 * sim.u_roughness;
        }
        let crystalStrength = smoothstep(0.25, 0.85, landExposure) * (0.32 * sim.u_roughness);
        let cPrussianCrystal = vec3<f32>(0.06, 0.11, 0.18); // Deep Prussian blue crystal precipitate #0F1C2E
        finalLand = mix(finalLand, cPrussianCrystal, clamp(crystalGranularity * crystalStrength, 0.0, 0.40));

        // 2. Subtle Wash Edge Effect (ferroprussiate developer solution pooling at rinse boundaries)
        // Mid-elevation transition boundary darkening along exposure gradient
        let washEdgeBand = 1.0 - abs(landExposure - 0.48) * 3.6;
        let washEdge = pow(clamp(washEdgeBand, 0.0, 1.0), 2.2);
        let slopeFactor = smoothstep(0.04, 0.28, length(vec2<f32>(effDHx, effDHy)));
        let cWashEdgeIndigo = vec3<f32>(0.08, 0.15, 0.25); // Rinse solution boundary concentration
        finalLand = mix(finalLand, cWashEdgeIndigo, washEdge * slopeFactor * 0.30);

        // 3. Structured Drafting Linen Tooth (interlocking orthogonal warp/weft weave grid)
        // Rough linen cloth weave texture with distinct regular structural grid (strictly monochromatic)
        let linenZoomScale = clamp(3600.0 / max(pixelFootprintM, 60.0), 1.0, 48.0);
        let linenFreq = 1400.0 * max(0.1, sim.u_mediumProperties.y) * linenZoomScale;
        let linenCoord = vec2<f32>(input.uv.x * cosLat, input.uv.y) * linenFreq;
        var linenTooth = 0.0;
        if (sim.u_roughness > 0.0) {
            let warp = sin(linenCoord.x * 3.14159265);
            let weft = sin(linenCoord.y * 3.14159265);
            let cellCoord = floor(linenCoord);
            let isWarpOver = select(-1.0, 1.0, fract((cellCoord.x + cellCoord.y) * 0.5) < 0.25 || fract((cellCoord.x + cellCoord.y) * 0.5) > 0.75);
            let weaveGrid = (warp - weft) * isWarpOver * 0.12 + (warp * weft) * 0.15;
            let linenSlub = (hashPaper2D(linenCoord * 0.5) - 0.5) * 0.18;
            linenTooth = (weaveGrid + linenSlub) * (sim.u_roughness * 0.65);

            // Directional raking light micro-shadows along orthogonal warp/weft drafting linen
            let lenL_xy = length(L1_view.xy);
            let L_tangent = select(vec2<f32>(0.70710678, 0.70710678), L1_view.xy / max(lenL_xy, 1e-6), lenL_xy > 1e-4);
            let dWarp = -sin(linenCoord.x * 3.14159265);
            let dWeft = -sin(linenCoord.y * 3.14159265);
            let weaveSlopeL = (L_tangent.x * dWarp + L_tangent.y * dWeft) * (sim.u_roughness * 0.40);
            let cyanoRakingOblique = mix(0.70, 1.60, clamp((1.0 - NdotL1) * 1.4 + (1.0 - max(0.05, L1_view.z)) * 0.7, 0.0, 1.0));
            let weaveShadow = max(0.0, -weaveSlopeL) * cyanoRakingOblique * 0.35;
            let weaveHighlight = max(0.0, weaveSlopeL) * cyanoRakingOblique * 0.35;

            // Cold Prussian indigo micro-shadows into linen weave crevices
            let cLinenShadowIndigo = vec3<f32>(0.04, 0.08, 0.14);
            finalLand = mix(finalLand, cLinenShadowIndigo, clamp(weaveShadow * 0.42, 0.0, 0.45));
            finalLand = finalLand * (1.0 + weaveHighlight * 0.22);
        }
        finalLand = clamp(finalLand * (1.0 + linenTooth * 0.35), vec3<f32>(0.0), vec3<f32>(1.0));

        // Calibrated ferric blueprint slope contrast:
        // Actinic photochemical exposure model with enhanced slope gradient dynamics
        let ferricSlope = length(vec2<f32>(effDHx, effDHy));
        let ferricContrast = pow(clamp(ferricSlope * 3.8, 0.0, 1.0), 1.25);
        let ferricModulation = mix(0.92, 1.18, ferricContrast * (NdotL1 - 0.45));
        finalLand = clamp(finalLand * ferricModulation, vec3<f32>(0.0), vec3<f32>(1.0));

        // Actinic solarization to eliminate warm tone bleed: ensure cold actinic hue and zero warm tint
        let warmBleed = max(0.0, finalLand.r - finalLand.b * 0.85);
        finalLand = clamp(finalLand - vec3<f32>(warmBleed, warmBleed * 0.5, 0.0), vec3<f32>(0.0), vec3<f32>(1.0));
    }

    // Multi-octave geomorphic micro-erosion relief pigmentation across volcanic shields, plateaus, and abyssal ridges
    let microErosionWave = clamp((accumGrad.x * L1_view.x + accumGrad.y * L1_view.y) * 1.40 + (couloirTotal * 0.35 + strataTotal * 0.25) * 0.28, -0.45, 0.45);
    let microPigmentShift = microErosionWave * zoomMicroGate * 0.56;
    let microTint = select(vec3<f32>(0.08, 0.07, 0.06), vec3<f32>(0.12, 0.18, 0.26), sim.u_theme == 2u);
    finalLand = clamp(finalLand * (1.0 + microPigmentShift) + microTint * (microPigmentShift * 0.32), vec3<f32>(0.0), vec3<f32>(1.0));

    // Continental crust uses archival matte paper ink absorption — zero computer-game specular glare

    // ------------------------------------------------------------------------
    // STAGE 1 In-Shader Geomorphic Hydrology Drainage (Frontiers 3 & 4)
    // Conforms self-tapering waterways directly into DEM valley troughs.
    // Line Ratio: Major river widths strictly proportioned below
    // coastline widths (55-60% ratio: 1.98px vs 3.40px maximum, tapering
    // down to 0.40px hairline headwaters in alpine terrain).
    // ------------------------------------------------------------------------
    let shoreWaterwayGate = smoothstep(0.40, 0.60, isLand);
    if (shoreWaterwayGate > 0.001) {
        // 1. Upstream Drainage Catchment Area A & Leopold-Maddock Downstream Hydraulic Geometry
        // Purging Laplacian heuristic (kValley) and elevation proxy (1 - normElev)^1.6
        // Ingest 15 arc-sec MERIT Hydro upstream drainage area (UPA in km²) packed into log-scaled 16-bit texture
        let normArea = textureSampleLevel(u_hydroTexture, u_demSampler, input.uv, 0.0).r;
        let A_max = 7000000.0;
        let A = exp(normArea * log(A_max + 1.0)) - 1.0; // km²
        let V_packed = normArea;
        let catchmentArea = A;
        let descentAccum = clamp(pow(A / A_max, 0.35), 0.0, 1.0);

        // Leopold-Maddock downstream hydraulic geometry scaling:
        let channelWidth = 2.1 * pow(max(0.0, A - 15.0), 0.45);
        let channelDepth = 0.28 * pow(max(0.0, A - 15.0), 0.32);
        let w_A = channelWidth;
        let d_A = channelDepth;

        // 2. Discrete Second-Derivative Valley Sub-Texel Centering
        let d2x = hR + hL - 2.0 * hC;
        let d2y = hD + hU - 2.0 * hC;
        let gx  = (hR - hL) * 0.5;
        let gy  = (hD - hU) * 0.5;

        let deltaX = select(0.0, -clamp(gx / max(d2x, 1e-4), -0.75, 0.75), d2x > 1e-4);
        let deltaY = select(0.0, -clamp(gy / max(d2y, 1e-4), -0.75, 0.75), d2y > 1e-4);

        // Sub-texel offset from cell center [-0.5, +0.5]
        let uvGrid = input.uv / ts;
        let fCell  = fract(uvGrid) - vec2<f32>(0.5);

        // Metric coordinate offset on globe manifold (accounting for spherical latitude convergence)
        var metricDistVec = (fCell - vec2<f32>(deltaX, deltaY)) * ts;
        metricDistVec.x = metricDistVec.x * cosLat;

        let distUv = length(metricDistVec);
        let pixelUv = length(dUV);
        let distPx = distUv / max(pixelUv, 1e-6);

        // Metric distance across planetary manifold (Earth equatorial circumference ~ 40,075,017m)
        let r_dist = distUv * 40075017.0;
        let distToAxis = r_dist;

        // Dynamic Geomorphic Drainage Coupling (Task M11-T2):
        // Integrate active discharge Q(x) and upstream area A(x) from dynamic drainage texture
        // and high-resolution DEM valley floor curvature (kValley) at close zoom
        let highResValleyArea = smoothstep(0.08, 0.35, kValley) * regWeightC * 65.0;
        let activeQ = select(A * (1.0 + sqrt(clamp(precipRate, 0.0, 50.0)) * 0.35), drainageSample.g, drainageSample.g > 0.0001) + highResValleyArea;
        let activeArea = max(select(A, drainageSample.r * A_max, drainageSample.r > 0.0001), highResValleyArea);
        let normActiveQ = clamp(activeQ / A_max, 0.0, 1.0);

        // Leopold-Maddock Downstream Hydraulic Geometry: W = a * Q^0.50, D = c * Q^0.40
        let dynamicDescentAccum = clamp(pow(normActiveQ, u_drainageBasin.u_widthExponentB), 0.0, 1.0);
        let leopoldWidthScale = pow(max(1e-4, normActiveQ), u_drainageBasin.u_widthExponentB - 0.50);

        // Flint's Law Bedrock Incision: delta_z = K * A^0.45 * ||grad(h)||^1.0
        let flintIncisionFactor = select(1.0, 1.0 + drainageSample.a * u_drainageBasin.u_erodibilityConstantK, drainageSample.a > 0.0001);
        let channelIncise = -channelDepth * exp(-pow(2.0 * distToAxis / max(channelWidth, 15.0), 2.0)) * flintIncisionFactor;
        let delta_z = channelIncise;

        // 3. Self-Tapering Waterway Line Width
        // High alpine headwaters: 0.40px ultra-fine hairline
        // Lowland valley confluences: 1.98px (58.2% of 3.40px)
        var riverWidthPx = mix(0.40, 1.98, descentAccum);
        let pluvialFactor = 1.0 + sim.u_pluvial_gamma * sqrt(clamp(precipRate, 0.0, 50.0));
        riverWidthPx = riverWidthPx * pluvialFactor;

        // Couple dynamic discharge into river width (scaled by Leopold-Maddock power law)
        let dynamicWidthPx = mix(0.40, 1.98, dynamicDescentAccum) * leopoldWidthScale;
        riverWidthPx = select(riverWidthPx, clamp(dynamicWidthPx, 0.40, 1.98), activeQ > u_drainageBasin.u_minDischargeThreshold && drainageSample.g > 0.0001);

        let riverHalfWidth = riverWidthPx * 0.5;
        let riverFeather = 0.45;

        // Sub-pixel screen-space box feathering for resolution-invariant linework
        let channelCoverage = 1.0 - smoothstep(riverHalfWidth - riverFeather, riverHalfWidth + riverFeather, distPx);

        // 4. Leopold-Maddock Fluvial Presence Gate & Strahler Stream Hierarchy (Track C)
        // Orbit (camDist > 16.0): Orders 6-8 (continental arteries A >= 10,000 km²)
        // Regional (8.0 < camDist <= 16.0): Orders 4-8 (rivers A >= 250 km²)
        // Local (camDist <= 8.0): Orders 1-8 (headwaters & rills A >= 15 km²)
        let camDistHydro = mix(length(sim.u_cameraPos.xyz), 5.0 + abs(sim.u_cameraPos.z), clamp(sim.u_unfurl, 0.0, 1.0));
        let minAreaThreshold = select(15.0, select(250.0, 10000.0, camDistHydro > 16.0), camDistHydro > 8.0);
        let riverPresence = select(0.0, smoothstep(minAreaThreshold, minAreaThreshold * 3.0, activeArea), activeArea > minAreaThreshold);
        let valleyGate = riverPresence;

        // Cliff attenuation: in sheer vertical rock cliffs (>35°), water forms narrow chutes
        let cliffDampen = 1.0 - rockWeight * 0.35;

        let waterwayGlaze = channelCoverage * valleyGate * cliffDampen * shoreWaterwayGate;

        // Physical Gaussian bed incision shading: darkens channel depression according to channelIncise
        let bedIncisionShade = clamp(1.0 + channelIncise * 0.0035 * valleyGate * shoreWaterwayGate, 0.72, 1.0);
        finalLand = finalLand * bedIncisionShade;

        // Archival Medium: High-contrast intaglio plate indentation along Leopold-Maddock river trunks (Cream Rag)
        if (sim.u_theme == 1u) {
            let riverIntaglioDeboss = channelCoverage * valleyGate * (0.35 * sim.u_mediumProperties.x);
            finalLand = finalLand * (1.0 - riverIntaglioDeboss * (1.0 - NdotL1 * 0.45));
        }

        if (waterwayGlaze > 0.001) {
            var cWaterway: vec3<f32>;
            var glazeAlpha: f32;

            if (sim.u_theme == 1u) {
                // Theme 1 (Cream Rag Paper): Archival Mineral Glazes / Washed Celadon-Lapis
                // Alpine headwaters: washed mineral celadon (#77998B / vec3(0.32, 0.48, 0.46))
                // Lowland confluences: deep archival lapis glaze (#263B52 / vec3(0.18, 0.32, 0.46))
                // Copperplate ruling-pen intaglio ink (#38302A / vec3(0.22, 0.19, 0.16))
                let cAlpineCeladon = vec3<f32>(0.32, 0.48, 0.46);
                let cLowlandLapis   = vec3<f32>(0.18, 0.32, 0.46);
                let cCopperplateInk = vec3<f32>(0.22, 0.19, 0.16);
                cWaterway = mix(cAlpineCeladon, cLowlandLapis, descentAccum);
                cWaterway = mix(cWaterway, cCopperplateInk, channelCoverage * 0.20 * sim.u_mediumProperties.x);
                glazeAlpha = waterwayGlaze * mix(0.38, 0.52, descentAccum);
            } else if (sim.u_theme == 2u) {
                // Theme 2 (Prussian Cyanotype): Washed Architectural Cerulean / Blueprint Drafting Ink
                // Pure photochemical actinic white to delicate blueprint chalk cerulean (#7AA2C8)
                // Confluences: rich ferroprussiate cerulean (#4F79A3 / vec3(0.32, 0.58, 0.80))
                let cActinicWhite  = vec3<f32>(0.92, 0.96, 1.00);
                let cChalkCerulean = vec3<f32>(0.52, 0.76, 0.92);
                let cDraftCerulean = vec3<f32>(0.32, 0.58, 0.80);
                let cHeadwater = mix(cActinicWhite, cChalkCerulean, clamp(descentAccum * 2.0, 0.0, 1.0));
                cWaterway = mix(cHeadwater, cDraftCerulean, descentAccum);
                glazeAlpha = waterwayGlaze * mix(0.48, 0.65, descentAccum);
            } else {
                // Theme 0 (Marie Tharp): Deep Marine Turquoise Drafting Glaze
                // Hand-painted Heinrich Berann turquoise extending bathymetrically across continental shelf breaks
                let cAlpineCyan = vec3<f32>(0.32, 0.64, 0.72);
                let cEstuaryCyan = vec3<f32>(0.18, 0.46, 0.56);
                let cSubmarineChasm = vec3<f32>(0.08, 0.28, 0.38);
                cWaterway = mix(cAlpineCyan, cEstuaryCyan, descentAccum);
                cWaterway = mix(cWaterway, cSubmarineChasm, clamp(descentAccum * 0.75, 0.0, 0.55));
                glazeAlpha = waterwayGlaze * mix(0.42, 0.58, descentAccum);
            }

            finalLand = mix(finalLand, cWaterway, clamp(glazeAlpha, 0.0, 0.85));
        }
    }

    var finalCrust: vec3<f32>;
    let isDark = sim.u_theme != 1u;

    if (sim.u_renderStyle == 0u) {
        // ====================================================================
        // OPTION A: ARCHITECTURAL TOPOGRAPHIC & BATHYMETRIC RELIEF
        // The entire planetary crust is an exposed solid physical relief sculpture.
        // No dark void! Ocean basins are rendered as architectural bathymetry
        // with mid-ocean ridges, seamounts, and trenches in sculpted mineral slate.
        // ====================================================================

            let normDepth = clamp(oceanDepth, 0.0, 1.0);
            let bathyDepthM = normDepth * 10924.0;
            var cBathyShelf: vec3<f32>;
            var cBathySlope: vec3<f32>;
            var cBathyAbyss: vec3<f32>;
            var cBathyTrench: vec3<f32>;
            var cBathyRidge: vec3<f32>;

            if (sim.u_theme == 2u) {
                // Prussian Cyanotype: Architectural drafting wash in cerulean & ferroprussiate indigo
                cBathyShelf  = vec3<f32>(0.20, 0.36, 0.52); // Drafting cobalt #294D75
                cBathySlope  = vec3<f32>(0.11, 0.22, 0.35); // Pelagic slope cerulean-indigo
                cBathyAbyss  = vec3<f32>(0.06, 0.13, 0.22); // Prussian indigo #162B42
                cBathyTrench = vec3<f32>(0.02, 0.05, 0.09); // Deep exposed prussiate #0E1824
                cBathyRidge  = vec3<f32>(0.91, 0.93, 0.96); // Chalk ruling pen crest #E8EDF2
            } else if (sim.u_theme == 1u) {
                // Cream Cotton Rag: Eduard Imhof tiered watercolor shelves (inner celadon, outer shelf break, pelagic slope, marine indigo, hadal trench)
                let cShorelineWash = vec3<f32>(0.68, 0.76, 0.72); // Delicate coastal estuarine wash
                let cInnerBase = vec3<f32>(0.56, 0.68, 0.62); // Luminous shelf celadon #77998B
                let cInnerShelf = mix(cShorelineWash, cInnerBase, smoothstep(0.0002, 0.004, normDepth));
                let cOuterShelf = vec3<f32>(0.42, 0.55, 0.56); // Mineral celadon-lapis wash
                let shelfTier = smoothstep(0.004, 0.018, normDepth);
                cBathyShelf  = mix(cInnerShelf, cOuterShelf, shelfTier);
                cBathySlope  = vec3<f32>(0.32, 0.44, 0.52); // Continental slope mineral lapis wash
                cBathyAbyss  = vec3<f32>(0.22, 0.32, 0.44); // Soft marine indigo #263B52
                cBathyTrench = vec3<f32>(0.12, 0.17, 0.24); // Trench umber-indigo
                cBathyRidge  = vec3<f32>(0.88, 0.84, 0.78); // Warm bleached parchment
            } else {
                // Marie Tharp: High-contrast turquoise continental shelf, pelagic slope & abyssal basalt
                cBathyShelf  = vec3<f32>(0.12, 0.48, 0.55); // Coastal turquoise #23778A
                cBathySlope  = vec3<f32>(0.08, 0.22, 0.28); // Oceanic teal-navy continental slope
                cBathyAbyss  = vec3<f32>(0.035, 0.065, 0.105); // Abyssal plain basalt #0F171F
                cBathyTrench = vec3<f32>(0.010, 0.018, 0.038); // Deep hadal trench abyss
                cBathyRidge  = vec3<f32>(0.54, 0.50, 0.42); // Mid-Atlantic rift ridge parchment
            }

            let b0 = smoothstep(0.004, 0.022, normDepth);  // Shelf (0-200m) to Slope (200-2500m)
            let b1 = smoothstep(0.022, 0.228, normDepth);  // Slope to Abyssal Plain (2500-5500m)
            let b2 = smoothstep(0.228, 0.503, normDepth);  // Abyss to Hadal Trench (>5500m)

            var cBathy = mix(
                mix(cBathyShelf, cBathySlope, b0),
                mix(cBathyAbyss, cBathyTrench, b2),
                b1
            );

            // Carbonate reef shelf glow (0 - 50m) in exposed bathymetric relief
            let reefShelfGlow = 1.0 - smoothstep(1.0, 50.0, bathyDepthM);
            var cReefTint: vec3<f32>;
            if (sim.u_theme == 2u) {
                cReefTint = vec3<f32>(0.32, 0.52, 0.70); // Photochemical shoal glow
            } else if (sim.u_theme == 1u) {
                cReefTint = vec3<f32>(0.72, 0.80, 0.74); // Aragonite shelf celadon
            } else {
                cReefTint = vec3<f32>(0.22, 0.62, 0.68); // Luminous atoll turquoise
            }
            cBathy = mix(cBathy, cReefTint, reefShelfGlow * 0.45);
            // Jerlov (1968) Optical Water Clarity (Type III turbid coastal <-> Type I oligotrophic pelagic):
            // Centered at nominal u_waterClarity = 0.75 so baseline calibration is invariant while scrubbing 0.10 -> 1.00
            // visibly modulates photic shelf-to-slope penetration even at nominal sea level (0m).
            let jerlovClarityDelta = clamp(sim.u_waterClarity, 0.1, 1.0) - 0.75;
            let jerlovShelfPenetration = (1.0 - smoothstep(0.0, 0.22, normDepth)) * jerlovClarityDelta;
            cBathy = mix(cBathy, select(cBathyAbyss, cReefTint, jerlovClarityDelta > 0.0), abs(jerlovShelfPenetration) * 0.55);

            if (sim.u_theme == 2u) {
                // Ferric blueprint tonal ramp: deep blue water absorption in restored ocean subduction trenches
                let deepExposure = pow(clamp(normDepth, 0.0, 1.0), max(0.1, sim.u_mediumProperties.z));
                let cSubductionTrench = vec3<f32>(0.015, 0.04, 0.08); // Deep photochemical Turnbull's indigo
                cBathy = mix(cBathy, cSubductionTrench, smoothstep(0.28, 0.92, deepExposure) * 0.75);

                // Ocean trench Prussian crystal precipitation noise (colloidal insoluble ferroprussiate micro-crystals)
                let bCrystalCoord = vec2<f32>(input.uv.x * cosLat, input.uv.y) * (2600.0 * max(0.1, sim.u_mediumProperties.y));
                var bCrystal = 0.0;
                if (sim.u_roughness > 0.0) {
                    bCrystal = (hashPaper2D(bCrystalCoord) * hashPaper2D(bCrystalCoord * 1.618 + vec2<f32>(7.1, 31.9)) - 0.22) * 2.0;
                }
                let bCrystalWeight = smoothstep(0.35, 0.95, deepExposure) * (0.28 * sim.u_roughness);
                cBathy = mix(cBathy, vec3<f32>(0.03, 0.06, 0.10), clamp(bCrystal * bCrystalWeight, 0.0, 0.35));
            }

            // Mid-ocean ridge depth gate: highlights mid-ocean rift systems (1,400m - 4,000m)
            // without speckling abyssal plains (>4,800m) or shallow coastal shelves (<1,200m)
            let ridgeDepthGate = smoothstep(1200.0, 2000.0, bathyDepthM) * (1.0 - smoothstep(3800.0, 4800.0, bathyDepthM));

            // Mid-ocean ridge crest highlight gated by authentic ridge depth
            cBathy = mix(cBathy, cBathyRidge, kRidge * 0.45 * ridgeDepthGate);

            // Trench crevice ink absorption: deep hadal chasms (>5,500m) absorb dark archival ink in concave troughs (kValley)
            let trenchChasmWeight = clamp(kValley * 1.5 * smoothstep(4500.0, 6500.0, bathyDepthM), 0.0, 1.0);
            let cTrenchInk = cBathyTrench * 0.65;
            cBathy = mix(cBathy, cTrenchInk, trenchChasmWeight * 0.85);

            // Marie Tharp (Theme 0): Bruce Heezen & Marie Tharp Physiographic Pen-and-Ink Stippling
            // Modulated by bathymetric slope gradient and u_mediumProperties.w (stippleDensity)
            if (sim.u_theme == 0u) {
                let bathySlope = length(vec2<f32>(effDHx, effDHy));
                let stippleFreq = 1400.0 * max(0.1, sim.u_mediumProperties.w);
                let stippleCoord = vec2<f32>(input.uv.x * safeCosLat, input.uv.y) * stippleFreq;
                var dotMask = 0.0;
                if (sim.u_roughness > 0.0) {
                    let cellId = floor(stippleCoord);
                    let cellFract = fract(stippleCoord);

                    // Authentic Tharp abyssal plain stippling: sediment dot pattern on abyssal plains and slopes
                    let abyssalPlainFactor = smoothstep(0.10, 0.35, normDepth);
                    let slopeFactor = smoothstep(0.02, 0.30, bathySlope);
                    let dotProb = (abyssalPlainFactor * 0.25 + slopeFactor * 0.55) * (sim.u_mediumProperties.w * 0.85);
                    let cellRng = hashPaper2D(cellId * 3.17 + vec2<f32>(43.1, 89.3));
                    let hasDot = cellRng < dotProb;

                    let jitter = (vec2<f32>(
                        hashPaper2D(cellId * 1.73 + vec2<f32>(13.3, 71.9)),
                        hashPaper2D(cellId * 2.41 + vec2<f32>(97.1, 31.7))
                    ) - 0.50) * 0.65;
                    let dotCenter = vec2<f32>(0.5, 0.5) + jitter;
                    let distToDot = length(cellFract - dotCenter);

                    // Dot radius slightly larger on steeper slopes
                    let dotRadius = mix(0.11, 0.24, clamp(bathySlope * 3.2, 0.0, 1.0));
                    dotMask = select(0.0, 1.0 - smoothstep(dotRadius - 0.04, dotRadius + 0.04, distToDot), hasDot) * fragPoleAtten;
                }

                let cStippleInk = vec3<f32>(0.03, 0.05, 0.07);
                cBathy = mix(cBathy, cStippleInk, dotMask * 0.70 * sim.u_roughness);

                // High-density Heinrich Berann bathymetric stippling on volcanic flanks & continental slopes
                let microBathyFreq = 2800.0 * max(0.1, sim.u_mediumProperties.w);
                let microBathyCoord = vec2<f32>(input.uv.x * safeCosLat, input.uv.y) * microBathyFreq;
                var microBathyDot = 0.0;
                if (sim.u_roughness > 0.0 && detailFade > 0.01) {
                    let mbCellId = floor(microBathyCoord);
                    let mbCellFract = fract(microBathyCoord);
                    let mbDotCenter = vec2<f32>(
                        hashPaper2D(mbCellId + vec2<f32>(5.0, 13.0)),
                        hashPaper2D(mbCellId + vec2<f32>(19.0, 37.0))
                    ) * 0.6 + vec2<f32>(0.2);
                    let mbDist = length(mbCellFract - mbDotCenter);
                    let mbSlopeFactor = smoothstep(0.02, 0.25, bathySlope);
                    let mbDepthFactor = smoothstep(0.01, 0.40, normDepth);
                    let mbDotProb = clamp(mbSlopeFactor * 0.60 + mbDepthFactor * 0.25, 0.02, 0.85);
                    let mbCellRng = hashPaper2D(mbCellId * 2.71 + vec2<f32>(31.7, 59.3));
                    let mbHasDot = mbCellRng < mbDotProb;
                    let mbRadius = mix(0.09, 0.22, clamp(bathySlope * 3.0, 0.0, 1.0));
                    microBathyDot = select(0.0, 1.0 - smoothstep(mbRadius - 0.03, mbRadius + 0.03, mbDist), mbHasDot) * fragPoleAtten;
                }
                let cOceanStippleInk = mix(cBathyAbyss * 0.45, cStippleInk, 0.70);
                cBathy = mix(cBathy, cOceanStippleInk, microBathyDot * 0.60 * detailFade * sim.u_mediumProperties.w * sim.u_roughness);

                // Mid-ocean ridge crests: concentrated transform fault hatching (decoupled from kValley)
                let uRidgeStrike = dot(vec2<f32>(input.uv.x * safeCosLat, input.uv.y) * 950.0, strikeDir);
                let ridgeHatchWave = smoothstep(0.38, 0.94, sin(uRidgeStrike * 1.65));
                let ridgeHatchStrength = ridgeHatchWave * (kRidge * 1.6);
                let ridgeHatch = clamp(ridgeHatchStrength * ridgeDepthGate, 0.0, 1.0);
                cBathy = mix(cBathy, cBathyRidge, ridgeHatch * 0.60);

                // Oceanic fracture zones & transform fault incisions across mid-ocean ridges
                let uTransformFault = dot(vec2<f32>(input.uv.x * safeCosLat, input.uv.y) * 1800.0, strikeDir);
                let transformWave = smoothstep(0.35, 0.90, sin(uTransformFault * 3.14159));
                let fractureZoneShading = transformWave * smoothstep(0.04, 0.30, bathySlope) * ridgeDepthGate;
                cBathy = mix(cBathy, cTrenchInk, fractureZoneShading * 0.75 * detailFade * sim.u_mediumProperties.w);

                // Submarine canyon incisions and fall-line fluting on continental slopes & island volcanic flanks
                let uBathyStrike = dot(vec2<f32>(input.uv.x * safeCosLat, input.uv.y) * 1400.0, strikeDir);
                let uBathyFall = dot(vec2<f32>(input.uv.x * safeCosLat, input.uv.y) * 1400.0, gradDir);
                let slopeFluting = smoothstep(0.38, 0.88, sin(uBathyStrike * 2.4 + sin(uBathyFall * 0.75) * 0.60));
                let slopeCanyonWeight = slopeFluting * smoothstep(0.03, 0.25, bathySlope) * smoothstep(150.0, 600.0, bathyDepthM) * (1.0 - smoothstep(3000.0, 4800.0, bathyDepthM));
                let cSubmarineCanyon = mix(cBathySlope * 0.35, cBathyAbyss, 0.65);
                cBathy = mix(cBathy, cSubmarineCanyon, slopeCanyonWeight * 0.65 * (0.60 + detailFade * 0.60) * sim.u_mediumProperties.w);

                // Deep-sea subduction trench hadal fracture zone shading
                let trenchDepthGate = smoothstep(4500.0, 7000.0, bathyDepthM);
                let trenchFault = smoothstep(0.32, 0.88, sin(uTransformFault * 1.85));
                let trenchFracture = trenchFault * smoothstep(0.04, 0.30, bathySlope) * trenchDepthGate;
                let cAbyssalTrenchInk = vec3<f32>(0.005, 0.010, 0.020);
                cBathy = mix(cBathy, cAbyssalTrenchInk, trenchFracture * 0.85 * (0.50 + detailFade * 0.70) * sim.u_mediumProperties.w);

                // Mid-Atlantic Ridge & oceanic axial rift valleys: prominent physiographic chasm incision scaled to real topographic gradient
                let oceanRiftChasm = smoothstep(0.04, 0.28, bathySlope) * ridgeDepthGate;
                cBathy = mix(cBathy, cTrenchInk, oceanRiftChasm * 0.70 * sim.u_mediumProperties.w);
            } else if (sim.u_theme == 1u) {
                // Cream Rag: Subtractive paper tooth and ink absorption into cotton rag ground
                let fiberFreq = 1800.0 * max(0.1, sim.u_mediumProperties.y);
                var bFiberTooth = 0.0;
                if (sim.u_roughness > 0.0) {
                    bFiberTooth = (hashPaper2D(input.uv * fiberFreq) - 0.5) * (sim.u_roughness * 0.40);

                    // Directional raking light micro-shadowing across bathymetric paper tooth
                    let lenL_xy = length(L1_view.xy);
                    let L_tangent = select(vec2<f32>(0.70710678, 0.70710678), L1_view.xy / max(lenL_xy, 1e-6), lenL_xy > 1e-4);
                    let bStep = L_tangent * 0.85;
                    let bCoordSun = input.uv * fiberFreq - bStep;
                    let bToothSun = (hashPaper2D(bCoordSun) - 0.5) * (sim.u_roughness * 0.40);
                    let bSlopeL = bFiberTooth - bToothSun;
                    let bRakingOblique = mix(0.70, 1.70, clamp((1.0 - max(0.05, L1_view.z)) * 1.4, 0.0, 1.0));
                    let bMicroShadow = max(0.0, -bSlopeL) * bRakingOblique * 1.5;
                    let bHighlight = max(0.0, bSlopeL) * bRakingOblique * 1.2;

                    // Archival sepia-charcoal ink wash absorption in abyssal depths (#38302A)
                    let cArchivalSepia = vec3<f32>(0.22, 0.19, 0.16);
                    let bShadowAbsorbed = mix(cBathy, cBathy * cArchivalSepia * 2.2, clamp(bMicroShadow, 0.0, 0.45));
                    cBathy = clamp(bShadowAbsorbed * (1.0 + bHighlight * 0.25), vec3<f32>(0.0), vec3<f32>(1.0));
                }
                cBathy = clamp(cBathy * (1.0 + bFiberTooth), vec3<f32>(0.0), vec3<f32>(1.0));
            } else if (sim.u_theme == 2u) {
                // Prussian Cyanotype: Structured blueprint linen weave tooth on bathymetric ground
                let bLinenZoomScale = clamp(3600.0 / max(pixelFootprintM, 60.0), 1.0, 48.0);
                let linenFreq = 1400.0 * max(0.1, sim.u_mediumProperties.y) * bLinenZoomScale;
                let linenCoord = vec2<f32>(input.uv.x * safeCosLat, input.uv.y) * linenFreq;
                var bLinenTooth = 0.0;
                if (sim.u_roughness > 0.0) {
                    let warp = sin(linenCoord.x * 3.14159265);
                    let weft = sin(linenCoord.y * 3.14159265);
                    let cellCoord = floor(linenCoord);
                    let isWarpOver = select(-1.0, 1.0, fract((cellCoord.x + cellCoord.y) * 0.5) < 0.25 || fract((cellCoord.x + cellCoord.y) * 0.5) > 0.75);
                    let weaveGrid = (warp - weft) * isWarpOver * 0.12 + (warp * weft) * 0.12;
                    bLinenTooth = (weaveGrid + (hashPaper2D(linenCoord * 0.5) - 0.5) * 0.15) * (sim.u_roughness * 0.50);
                }
                cBathy = clamp(cBathy * (1.0 + bLinenTooth * 0.35), vec3<f32>(0.0), vec3<f32>(1.0));

                // 1842 Technical Blueprint Bathymetric Stippling on continental slope and shelf break
                if (sim.u_mediumProperties.w > 0.1 && sim.u_roughness > 0.0) {
                    let bathySlope = length(vec2<f32>(effDHx, effDHy));
                    let stippleFreq = 1800.0 * sim.u_mediumProperties.w;
                    let stippleCoord = vec2<f32>(input.uv.x * safeCosLat, input.uv.y) * stippleFreq;
                    let cellId = floor(stippleCoord);
                    let cellFract = fract(stippleCoord);
                    let dotProb = smoothstep(0.015, 0.30, bathySlope) * (sim.u_mediumProperties.w * 0.70);
                    let cellRng = hashPaper2D(cellId * 2.71 + vec2<f32>(19.4, 53.2));
                    let hasDot = cellRng < dotProb;
                    let distToDot = length(cellFract - vec2<f32>(0.5));
                    let dotMask = select(0.0, 1.0 - smoothstep(0.10, 0.22, distToDot), hasDot) * fragPoleAtten;
                    let cChalkDot = vec3<f32>(0.91, 0.93, 0.96); // Chalk ruling pen sounding dot
                    cBathy = mix(cBathy, cChalkDot, dotMask * 0.65 * sim.u_roughness);
                }
            }

            var bathyIllum: vec3<f32>;
            if (sim.u_theme == 2u) {
                // Prussian Cyanotype: Actinic bathymetric illumination with zero warm sunlight
                let cActinicDirect = vec3<f32>(0.92, 0.96, 1.00);
                let cPrussianNavyBathy = vec3<f32>(0.07, 0.14, 0.24); // Cold photochemical Prussian navy
                let bathyActinicShadow = mix(vec3<f32>(0.18, 0.28, 0.42), cPrussianNavyBathy, (1.0 - terrainShadow) * 0.70);
                bathyIllum = cActinicDirect * max(0.0, sunDirect * 0.80 + ridgeEnhance * 0.8 * shadowFactor) + bathyActinicShadow * (skyIndirect * creviceAO);
            } else if (sim.u_theme == 1u) {
                // Cream Cotton Rag: Eduard Imhof warm sunlit relief with cool violet-umber shadow
                let cWarmDirect = vec3<f32>(1.10, 1.02, 0.90);
                let cSepiaCharcoalBathy = vec3<f32>(0.22, 0.19, 0.16); // Archival sepia-charcoal ink #38302A
                let bathyCoolShadow = mix(vec3<f32>(0.36, 0.32, 0.42), cSepiaCharcoalBathy, (1.0 - terrainShadow) * 0.65);
                let sunWeight = clamp(sunDirect * 1.4, 0.0, 1.0);
                let directComp = cWarmDirect * max(0.0, sunDirect * 0.85 + ridgeEnhance * 0.8 * shadowFactor);
                let shadowComp = bathyCoolShadow * (skyIndirect * creviceAO);
                bathyIllum = mix(shadowComp, directComp, sunWeight);
            } else {
                let cUmberBathy = vec3<f32>(0.22, 0.16, 0.12); // Berann hand-painted rich umber wash #2E241C
                let bathyEffectiveAmbient = mix(cSkyAmbient, cUmberBathy, (1.0 - terrainShadow) * 0.75);
                bathyIllum = cSunLight * max(0.0, sunDirect * 0.80 + ridgeEnhance * 0.8 * shadowFactor) + bathyEffectiveAmbient * (skyIndirect * creviceAO);
            }
        bathyIllum = bathyIllum * (1.0 + microPigmentShift * 1.15);
        let shelfDepthMeters = normDepth * 10924.0;
        let bathyRockGate = smoothstep(200.0, 1000.0, shelfDepthMeters);
        let cBathyComposite = mix(cBathy * bathyIllum, cRockShaded, rockWeight * 0.4 * bathyRockGate);

        let shoreCoverage = smoothstep(0.35, 0.65, isLand);
        finalCrust = mix(cBathyComposite, finalLand, shoreCoverage);
    } else if (sim.u_renderStyle == 2u) {
        // ====================================================================
        // OPTION C: NASA BLUE MARBLE ORBITAL PHOTOREALISM & CELESTIAL TERMINATOR
        // True-color orbital photography with dynamic celestial day/night blending,
        // nocturnal anthropogenic city lights, and golden Rayleigh twilight rim.
        // ====================================================================
        let dayColor = textureSampleLevel(u_orbitalTextures, u_orbitalSampler, input.uv, 0, 0.0).rgb;
        let nightColor = textureSampleLevel(u_orbitalTextures, u_orbitalSampler, input.uv, 1, 0.0).rgb;

        let sunDirWorld = computeSunLightDir(sim.u_sunAzimuth, sim.u_sunAltitude);
        let cosSun = dot(normalize(input.worldPos), sunDirWorld);

        let dayWeight = smoothstep(-0.08, 0.08, cosSun);
        let nightWeight = 1.0 - dayWeight;

        let directIllum = 0.10 + 0.90 * max(0.0, cosSun) * shadowFactor;
        let dayLit = dayColor * (directIllum * mix(0.20, 1.0, terrainShadow));
        let nightLit = nightColor * (nightWeight * 1.25);

        let twilightBand = pow(1.0 - abs(cosSun) / 0.08, 2.0) * select(0.0, 1.0, abs(cosSun) < 0.08);
        let twilightColor = vec3<f32>(1.0, 0.60, 0.28) * (twilightBand * 0.12);

        finalCrust = dayLit * dayWeight + nightLit + twilightColor;
    } else {
        // ====================================================================
        // OPTION B: HYDROSPHERE & BATHYMETRIC DEPTH
        // Ocean floor is submerged beneath translucent liquid water.
        // Deep seabed colors showing through the water column.
        // ====================================================================
        let normDepth = clamp(oceanDepth, 0.0, 1.0);
        var cOceanShelf: vec3<f32>;
        var cOceanSlope: vec3<f32>;
        var cOceanDeep: vec3<f32>;
        var cOceanTrench: vec3<f32>;

        if (sim.u_theme == 2u) {
            cOceanShelf  = vec3<f32>(0.20, 0.36, 0.54);
            cOceanSlope  = vec3<f32>(0.13, 0.24, 0.38);
            cOceanDeep   = vec3<f32>(0.07, 0.15, 0.25);
            cOceanTrench = vec3<f32>(0.03, 0.07, 0.12);
        } else if (sim.u_theme == 1u) {
            let cInnerShelf = vec3<f32>(0.58, 0.70, 0.64);
            let cOuterShelf = vec3<f32>(0.44, 0.56, 0.58);
            let shelfTier = smoothstep(0.004, 0.018, normDepth);
            cOceanShelf  = mix(cInnerShelf, cOuterShelf, shelfTier);
            cOceanSlope  = vec3<f32>(0.34, 0.46, 0.52);
            cOceanDeep   = vec3<f32>(0.24, 0.35, 0.46);
            cOceanTrench = vec3<f32>(0.13, 0.19, 0.26);
        } else {
            cOceanShelf  = vec3<f32>(0.04, 0.18, 0.28);
            cOceanSlope  = vec3<f32>(0.025, 0.10, 0.18);
            cOceanDeep   = vec3<f32>(0.012, 0.045, 0.09);
            cOceanTrench = vec3<f32>(0.005, 0.012, 0.03);
        }

        let reefInfluence = 1.0 - smoothstep(0.0001, 0.0046, normDepth); // 0 - 50m
        let lagoonGlow = 1.0 - smoothstep(0.00005, 0.0014, normDepth);    // 0 - 15m
        var cCarbonateBed: vec3<f32>;
        if (sim.u_theme == 2u) {
            cCarbonateBed = mix(vec3<f32>(0.32, 0.52, 0.70), vec3<f32>(0.62, 0.82, 0.96), lagoonGlow * 0.55);
        } else if (sim.u_theme == 1u) {
            cCarbonateBed = mix(vec3<f32>(0.74, 0.80, 0.75), ALBEDO_WHITE_OOID, lagoonGlow * 0.50);
        } else {
            cCarbonateBed = mix(ALBEDO_CARBONATE_REEF * 0.85, ALBEDO_WHITE_OOID * 0.90, lagoonGlow * 0.50);
        }
        let shelfReefBed = mix(cOceanShelf, cCarbonateBed, reefInfluence);

        let ob0 = smoothstep(0.004, 0.022, normDepth);
        let ob1 = smoothstep(0.022, 0.228, normDepth);
        let ob2 = smoothstep(0.228, 0.503, normDepth);
        var cBathy = mix(
            mix(shelfReefBed, cOceanSlope, ob0),
            mix(cOceanDeep, cOceanTrench, ob2),
            ob1
        );
        let jerlovClarityDeltaB = clamp(sim.u_waterClarity, 0.1, 1.0) - 0.75;
        let jerlovPenetrationB = (1.0 - smoothstep(0.0, 0.22, normDepth)) * jerlovClarityDeltaB;
        cBathy = mix(cBathy, select(cOceanDeep, cCarbonateBed, jerlovClarityDeltaB > 0.0), abs(jerlovPenetrationB) * 0.55);

        // Submerged bathymetric relief hillshading through water column
        let bathySunDirect = max(0.0, NdotL1) * shadowFactor;
        let bathyReliefWeight = 0.85 * (1.0 - smoothstep(0.02, 0.40, normDepth) * 0.40);
        let bathyDirectComp = max(0.0, bathySunDirect * 0.80 + ridgeEnhance * 0.75 * shadowFactor);
        var cBathyShadowAmbient: vec3<f32>;
        if (sim.u_theme == 2u) {
            cBathyShadowAmbient = mix(cSkyAmbient, vec3<f32>(0.07, 0.14, 0.24), (1.0 - terrainShadow) * 0.70);
        } else if (sim.u_theme == 1u) {
            cBathyShadowAmbient = mix(cSkyAmbient, vec3<f32>(0.22, 0.19, 0.16), (1.0 - terrainShadow) * 0.65);
        } else {
            cBathyShadowAmbient = mix(cSkyAmbient, vec3<f32>(0.22, 0.16, 0.12), (1.0 - terrainShadow) * 0.75);
        }
        let bathyIllum = (cSunLight * bathyDirectComp + cBathyShadowAmbient * (skyIndirect * creviceAO)) * bathyReliefWeight;
        finalCrust = mix(cBathy * bathyIllum, finalLand, smoothstep(0.32, 0.68, isLand));
    }

    // Hypsometric Stratum Isolation Glaze (Non-Destructive Elevation Band Highlight)
    if (sim.u_isolatedStratum >= -0.5) {
        let targetStratum = u32(round(sim.u_isolatedStratum));
        var currentStratum = 2u;
        if (elevMeters < -5500.0) {
            currentStratum = 0u; // Abyssal Trench
        } else if (elevMeters < -200.0) {
            currentStratum = 1u; // Continental Shelf Break / Mid-Ocean Ridge
        } else if (elevMeters < 500.0) {
            currentStratum = 2u; // Continental Shelf & Coastal Lowlands
        } else if (elevMeters < 5200.0) {
            currentStratum = 3u; // Steppe / Montane Plateaus
        } else {
            currentStratum = 4u; // Glacial Summits & Alpine Ridges
        }

        if (currentStratum == targetStratum) {
            // Selected stratum: subtle mineral brilliance & contrast boost
            finalCrust = finalCrust * 1.15;
        } else {
            // Non-selected stratum: soften contrast towards subdued tone to maintain geographic context
            let luma = dot(finalCrust, vec3<f32>(0.299, 0.587, 0.114));
            finalCrust = mix(finalCrust, vec3<f32>(luma), 0.50) * 0.70;
        }
    }


    // ========================================================================
    // MEDIUM-SPECIFIC ANALYTICAL CONTOURS & OCEANOGRAPHIC ISOBATHS
    // ========================================================================
    if (sim.u_renderStyle != 2u && u_geomorphicMicro.u_contourActive > 0.01) {
        let elevMeters = select(-oceanDepth * 10924.0, landElev * 8848.0, isLand > 0.45);
        let camAltSphKm = max(0.05, (length(sim.u_cameraPos.xyz) - 5.0) * 1274.2);
        let camAltPlanKm = max(0.05, abs(sim.u_cameraPos.z) * 1274.2);
        let camAltKm = mix(camAltSphKm, camAltPlanKm, clamp(sim.u_unfurl, 0.0, 1.0));
        let unfurlClamped = clamp(sim.u_unfurl, 0.0, 1.0);
        let rawPlanZ = abs(sim.u_cameraPos.z);
        let planAltOffsetKm = max(0.05, select(rawPlanZ, rawPlanZ - 5.0, rawPlanZ >= 5.0) * 1274.2);
        let rawFragDist = length(sim.u_cameraPos.xyz - input.worldPos.xyz);
        let fragAltKm = max(0.05, select(rawFragDist, rawFragDist - 5.0, rawFragDist >= 5.0) * 1274.2);
        let tiltSafePlanKm = select(fragAltKm, min(planAltOffsetKm, fragAltKm), rawPlanZ >= rawFragDist * 0.5);
        let effCamAltKm = mix(camAltKm, tiltSafePlanKm, unfurlClamped);

        // 1-2-5 Decimal Series: 500m -> 200m -> 100m -> 50m -> 20m
        let deltaH = select(500.0,
                     select(200.0,
                     select(100.0,
                     select(50.0, 20.0, effCamAltKm < 12.0),
                     effCamAltKm < 420.0),
                     effCamAltKm < 1400.0),
                     effCamAltKm < 3800.0) * select(1.0, u_geomorphicMicro.u_contourBaseInterval / 50.0, u_geomorphicMicro.u_contourBaseInterval > 0.1);

        // Orbital attenuation: smoothly extinguishes minor isolines at orbital distances to eliminate Moiré buzzing
        let orbitalContourFade = 1.0 - smoothstep(450.0, 1200.0, camAltKm);
        let regionalFadeSph = max(orbitalContourFade, (1.0 - smoothstep(1200.0, 4800.0, effCamAltKm)) * 0.88);
        let regionalFadeMap = (1.0 - smoothstep(3500.0, 16500.0, effCamAltKm)) * 0.90;
        let regionalContourFade = mix(regionalFadeSph, max(regionalFadeSph, regionalFadeMap), unfurlClamped);
        let macroFadeSph = max(regionalContourFade, (1.0 - smoothstep(4800.0, 14500.0, effCamAltKm)) * 0.80);
        let macroFadeMap = (1.0 - smoothstep(12000.0, 24000.0, effCamAltKm)) * 0.94;
        let macroContourFade = mix(macroFadeSph, max(macroFadeSph, macroFadeMap), unfurlClamped);

        // True screen-space DEM gradient derivatives via precomputed dUV
        // Eliminates the ~42x displacement normal blowout so anti-Moiré and hairlines render correctly
        let pxPerTexel = dUV / max(ts, vec2<f32>(1e-6));
        let dDemLandX = (finalDemR.r - finalDemL.r) * 0.5;
        let dDemLandY = (finalDemD.r - finalDemU.r) * 0.5;
        let dDemDepthX = (finalDemR.g - finalDemL.g) * 0.5;
        let dDemDepthY = (finalDemD.g - finalDemU.g) * 0.5;
        let dDemGlobalX = (finalDemR.a - finalDemL.a) * 0.5;
        let dDemGlobalY = (finalDemD.a - finalDemU.a) * 0.5;

        // One-sided step floor prevents central-difference cancellation on ridge crests and canyon rims
        let dLandStepX = max(abs(dDemLandX), max(abs(finalDemR.r - finalDemC.r), abs(finalDemC.r - finalDemL.r)));
        let dLandStepY = max(abs(dDemLandY), max(abs(finalDemD.r - finalDemC.r), abs(finalDemC.r - finalDemU.r)));
        let dDepthStepX = max(abs(dDemDepthX), max(abs(finalDemR.g - finalDemC.g), abs(finalDemC.g - finalDemL.g)));
        let dDepthStepY = max(abs(dDemDepthY), max(abs(finalDemD.g - finalDemC.g), abs(finalDemC.g - finalDemU.g)));
        let dGlobalStepX = max(abs(dDemGlobalX), max(abs(finalDemR.a - finalDemC.a), abs(finalDemC.a - finalDemL.a)));
        let dGlobalStepY = max(abs(dDemGlobalY), max(abs(finalDemD.a - finalDemC.a), abs(finalDemC.a - finalDemU.a)));

        // Suppress the 0m sea-level datum contour (which duplicates vector coastlines and traces 0m SRTM estuary pixels)
        // while keeping all >=20m topographic contours and <=-20m bathymetric isobaths at 100% strength.
        let zeroDatumFade = smoothstep(3.0, 14.0, abs(elevMeters));

        if (sim.u_theme == 1u) {
            // --- THEME 1 (Cream Rag): Eduard Imhof Swiss Topographic Analytical Contours ---
            // Generates copperplate sepia contours on land, coordinating with Imhof rock hachures on vertical cliffs
            let shoreContourFade = smoothstep(0.35, 0.65, isLand);
            if (shoreContourFade > 0.001 && landElev >= 0.0) {
                let elevIndex = elevMeters / deltaH;

                let dElevMetersPx = length(vec2<f32>(dDemLandX * pxPerTexel.x, dDemLandY * pxPerTexel.y)) * 8848.0;
                let dElevMetersSafe = max(dElevMetersPx, length(vec2<f32>(dLandStepX * pxPerTexel.x, dLandStepY * pxPerTexel.y)) * 8848.0);
                let dElevPx = dElevMetersSafe / deltaH;
                let halfW = clamp(dElevPx * 1.35, 0.0006, 0.25);
                let flatSlopeGate = smoothstep(0.00015, 0.00075, dElevPx);

                // Capillary ink wicking into paper tooth along contour stroke edges
                let fiberFreqContour = 1800.0 * max(0.1, sim.u_mediumProperties.y);
                let contourToothWick = (hashPaper2D(input.uv * fiberFreqContour) - 0.5) * (sim.u_mediumProperties.x * 0.25);
                let effectiveHalfW = clamp(halfW * (1.0 + contourToothWick), 0.0006, 0.27);

                // Minor contours (every interval)
                let minorVal = fract(elevIndex);
                let distMinor = min(minorVal, 1.0 - minorVal);
                let isMinor = (1.0 - smoothstep(0.0, effectiveHalfW, distMinor)) * flatSlopeGate;

                // Major index contours (every 5th interval)
                let majorIndex = elevIndex * 0.20;
                let majorVal = fract(majorIndex);
                let distMajor = min(majorVal, 1.0 - majorVal) * 5.0;
                let majorHalfW = clamp(max(effectiveHalfW * 1.8, dElevPx * 1.55), 0.001, 1.25);
                let isMajor = (1.0 - smoothstep(0.0, majorHalfW, distMajor)) * flatSlopeGate;

                // Slope coordination: contours remain crisp across hills, mountains, and canyon walls,
                // softening slightly as near-vertical cliffs (>55°) transition to Imhof rock hachures
                let hachureFade = 1.0 - smoothstep(0.70, 0.98, slopeAngle);
                let slopeContourWeight = mix(0.78, 1.0, hachureFade);

                // Anti-Moiré suppression at orbital distance when lines crowd into sub-pixel clusters
                let moireGuard = 1.0 - smoothstep(0.38, 0.88, dElevPx);
                let moireGuardMajor = 1.0 - smoothstep(0.38, 0.88, dElevPx * 0.20);

                let cCopperplateSepia = vec3<f32>(0.22, 0.19, 0.16); // Archival sepia-charcoal ink #38302A
                let contourAlpha = (isMinor * 0.55 * moireGuard + isMajor * 0.82 * moireGuardMajor) * slopeContourWeight * shoreContourFade * zeroDatumFade * orbitalContourFade;
                let macroAlpha = (isMinor * 0.48 * moireGuard * regionalContourFade + isMajor * 0.86 * moireGuardMajor * macroContourFade) * slopeContourWeight * shoreContourFade * zeroDatumFade;
                let activeContourAlpha = max(contourAlpha, macroAlpha);
                let kContourSepia = vec3<f32>(1.45, 1.72, 2.15);
                let contourAbsorbed = finalCrust * exp(-kContourSepia * (activeContourAlpha * (1.8 + contourToothWick * 0.5)));
                finalCrust = mix(finalCrust, contourAbsorbed, clamp(activeContourAlpha * 1.15, 0.0, 0.86));
                finalCrust = mix(finalCrust, min(finalCrust * 0.64, cCopperplateSepia), clamp(activeContourAlpha * 0.72, 0.0, 0.84));
            }
            if (isLand <= 0.45) {
                let shoreIsobathFade = 1.0 - smoothstep(0.35, 0.65, isLand);
                let normDepth = clamp(oceanDepth, 0.0, 1.0);
                let depthMeters = normDepth * 10924.0;
                let dDepthMetersPx = length(vec2<f32>(dDepthStepX * pxPerTexel.x, dDepthStepY * pxPerTexel.y)) * 10924.0;
                let dDynDepthPx = dDepthMetersPx / deltaH;
                let dynHalfW = clamp(dDynDepthPx * 1.35, 0.0006, 0.25);
                let flatDepthGate = smoothstep(0.00015, 0.00075, dDynDepthPx);
                let dynIsobathFreq = depthMeters / deltaH;
                let distDynIsobath = min(fract(dynIsobathFreq), 1.0 - fract(dynIsobathFreq));
                let isDynIsobath = (1.0 - smoothstep(0.0, dynHalfW, distDynIsobath)) * flatDepthGate;
                let majorIsobathIndex = dynIsobathFreq * 0.20;
                let distMajorIsobath = min(fract(majorIsobathIndex), 1.0 - fract(majorIsobathIndex)) * 5.0;
                let majorBathyHalfW = clamp(max(dynHalfW * 1.8, dDynDepthPx * 1.50), 0.001, 1.25);
                let isMajorIsobath = (1.0 - smoothstep(0.0, majorBathyHalfW, distMajorIsobath)) * flatDepthGate;
                let moireGuardOcean = 1.0 - smoothstep(0.38, 0.88, dDynDepthPx);
                let moireGuardOceanMajor = 1.0 - smoothstep(0.45, 1.15, dDynDepthPx * 0.20);
                let cCopperplateSepiaBathy = vec3<f32>(0.22, 0.19, 0.16);
                let bathyAlpha = (isDynIsobath * 0.44 * moireGuardOcean * regionalContourFade + isMajorIsobath * 0.74 * moireGuardOceanMajor * macroContourFade) * shoreIsobathFade * zeroDatumFade;
                finalCrust = mix(finalCrust, cCopperplateSepiaBathy, clamp(bathyAlpha, 0.0, 0.78));
            }
        } else if (sim.u_theme == 2u) {
            // --- THEME 2 (Prussian Cyanotype): Two-Tone Photochemical Blueprint Hierarchy ---
            let normElev = clamp((elevMeters + 10924.0) / 19772.0, 0.0, 1.0);
            let cyanoIndex = elevMeters / deltaH;
            let dCyanoMetersPx = select(
                length(vec2<f32>(dDepthStepX * pxPerTexel.x, dDepthStepY * pxPerTexel.y)) * 10924.0,
                length(vec2<f32>(dLandStepX * pxPerTexel.x, dLandStepY * pxPerTexel.y)) * 8848.0,
                isLand > 0.45
            );
            let dElevPx = dCyanoMetersPx / deltaH;
            let halfW = clamp(dElevPx * 1.05, 0.0005, 0.20);
            let flatSlopeGate = smoothstep(0.00015, 0.00075, dElevPx);

            let contourVal = fract(cyanoIndex);
            let distToLine = min(contourVal, 1.0 - contourVal);
            let isContour = (1.0 - smoothstep(0.0, halfW, distToLine)) * flatSlopeGate;

            let majorIndex = cyanoIndex * 0.20;
            let distMajor = min(fract(majorIndex), 1.0 - fract(majorIndex)) * 5.0;
            let majorHalfW = clamp(max(halfW * 1.75, dElevPx * 1.50), 0.001, 1.25);
            let isMajor = (1.0 - smoothstep(0.0, majorHalfW, distMajor)) * flatSlopeGate;

            let moireGuard = 1.0 - smoothstep(0.38, 0.88, dElevPx);
            let moireGuardMajor = 1.0 - smoothstep(0.45, 1.15, dElevPx * 0.20);
            let cyanoHachureFade = 1.0 - smoothstep(0.70, 0.98, slopeAngle);
            let cyanoShoreFade = smoothstep(0.04, 0.16, abs(isLand - 0.50)) * zeroDatumFade;
            let cyanoSlopeWeight = mix(0.78, 1.0, cyanoHachureFade) * cyanoShoreFade;

            // Two-tone ferroprussiate blueprint hierarchy:
            // Minor contours sit quietly as intermediate cerulean exposure lines (#5285B8);
            // Major 5th index contours use crisp chalk ruling-pen (#E8EDF2), inverting to Prussian indigo on bleached ridges
            let cyanoSubstrateLuma = dot(finalCrust, vec3<f32>(0.299, 0.587, 0.114));
            let ridgeBleachGate = smoothstep(0.52, 0.80, cyanoSubstrateLuma);
            let cCyanoMinor = mix(vec3<f32>(0.30, 0.50, 0.70), vec3<f32>(0.08, 0.16, 0.28), ridgeBleachGate);
            let cChalkContour = vec3<f32>(0.91, 0.93, 0.96); // Chalk Ruling Pen Linework #E8EDF2
            let cMajorAdaptive = mix(cChalkContour, vec3<f32>(0.06, 0.12, 0.22), ridgeBleachGate);
            let cActiveCyanoStroke = mix(cCyanoMinor, cMajorAdaptive, clamp(isMajor * 1.25, 0.0, 1.0));
            let cyanoAlpha = (isContour * 0.34 * moireGuard + isMajor * 0.68 * moireGuardMajor) * cyanoSlopeWeight * orbitalContourFade;
            let cyanoMacro = (isContour * 0.34 * moireGuard * regionalContourFade + isMajor * 0.72 * moireGuardMajor * macroContourFade) * cyanoSlopeWeight;
            finalCrust = mix(finalCrust, cActiveCyanoStroke, clamp(max(cyanoAlpha, cyanoMacro), 0.0, 0.82));
        } else if (sim.u_theme == 0u) {
            // --- THEME 0 (Marie Tharp): Physiographic Land Contours & Oceanographic Isobaths ---
            let shoreContourFade = smoothstep(0.35, 0.65, isLand);
            if (shoreContourFade > 0.001 && landElev >= 0.0) {
                let elevIndex = elevMeters / deltaH;
                let dElevMetersSafe = length(vec2<f32>(dLandStepX * pxPerTexel.x, dLandStepY * pxPerTexel.y)) * 8848.0;
                let dElevPx = dElevMetersSafe / deltaH;
                let halfW = clamp(dElevPx * 1.35, 0.0006, 0.25);
                let flatSlopeGate = smoothstep(0.00015, 0.00075, dElevPx);

                let minorVal = fract(elevIndex);
                let distMinor = min(minorVal, 1.0 - minorVal);
                let isMinor = (1.0 - smoothstep(0.0, halfW, distMinor)) * flatSlopeGate;

                let majorIndex = elevIndex * 0.20;
                let distMajor = min(fract(majorIndex), 1.0 - fract(majorIndex)) * 5.0;
                let majorHalfW = clamp(max(halfW * 1.8, dElevPx * 1.55), 0.001, 1.25);
                let isMajor = (1.0 - smoothstep(0.0, majorHalfW, distMajor)) * flatSlopeGate;

                let moireGuard = 1.0 - smoothstep(0.38, 0.88, dElevPx);
                let moireGuardMajor = 1.0 - smoothstep(0.45, 1.15, dElevPx * 0.20);
                let tharpHachureFade = 1.0 - smoothstep(0.70, 0.98, slopeAngle);
                let tharpSlopeWeight = mix(0.78, 1.0, tharpHachureFade);

                // Subtractive Kubelka-Munk bone-sepia ink absorbed into cold-press illustration board
                let cTharpLandContour = vec3<f32>(0.16, 0.11, 0.08);
                let tharpLandAlpha = (isMinor * 0.50 * moireGuard * regionalContourFade + isMajor * 0.82 * moireGuardMajor * macroContourFade) * tharpSlopeWeight * shoreContourFade * zeroDatumFade;
                let kTharpContour = vec3<f32>(1.55, 1.75, 2.10);
                let tharpContourAbsorbed = finalCrust * exp(-kTharpContour * (tharpLandAlpha * 1.70));
                finalCrust = mix(finalCrust, tharpContourAbsorbed, clamp(tharpLandAlpha * 1.15, 0.0, 0.86));
                finalCrust = mix(finalCrust, min(finalCrust * 0.64, cTharpLandContour), clamp(tharpLandAlpha * 0.72, 0.0, 0.84));
            }
            if (isLand <= 0.45) {
                let shoreIsobathFade = 1.0 - smoothstep(0.35, 0.65, isLand);
                let normDepth = clamp(oceanDepth, 0.0, 1.0);
                let depthMeters = normDepth * 10924.0;
                let dDepthMetersPx = length(vec2<f32>(dDepthStepX * pxPerTexel.x, dDepthStepY * pxPerTexel.y)) * 10924.0;

                // Dynamic intermediate bathymetric 1-2-5 series at survey zoom
                let isobathDeltaH = select(1000.0,
                                   select(500.0,
                                   select(200.0,
                                   select(100.0, 50.0, effCamAltKm < 12.0),
                                   effCamAltKm < 420.0),
                                   effCamAltKm < 1400.0),
                                   effCamAltKm < 3800.0);
                let dDynDepthPx = dDepthMetersPx / isobathDeltaH;
                let dynHalfW = clamp(dDynDepthPx * 0.95, 0.0004, 0.22);
                let flatDepthGate = smoothstep(0.00015, 0.00075, dDynDepthPx);
                let dynIsobathFreq = depthMeters / isobathDeltaH;
                let distDynIsobath = min(fract(dynIsobathFreq), 1.0 - fract(dynIsobathFreq));
                let isDynIsobath = (1.0 - smoothstep(0.0, dynHalfW, distDynIsobath)) * flatDepthGate;

                // Major 1000m oceanographic isobath (bolded 1.6x width, major index)
                let dMajorDepthPx = dDepthMetersPx / 1000.0;
                let majorHalfW = clamp(dMajorDepthPx * 0.95, 0.0004, 0.22) * 1.6;
                let effMajorHalfW = max(majorHalfW, clamp(dMajorDepthPx * 1.45, 0.001, 0.38));
                let flatMajorDepthGate = smoothstep(0.00010, 0.00050, dMajorDepthPx);
                let isobathFreq = depthMeters / 1000.0;
                let distToIsobath = min(fract(isobathFreq), 1.0 - fract(isobathFreq));
                let isIsobath = (1.0 - smoothstep(0.0, effMajorHalfW, distToIsobath)) * flatMajorDepthGate;

                // Continental shelf break isobath (200m depth contour) visible on continental shelf
                let dShelfDepthPx = dDepthMetersPx / 200.0;
                let shelfHalfW = clamp(dShelfDepthPx * 0.95, 0.0004, 0.22) * 1.4;
                let flatShelfGate = smoothstep(0.00015, 0.00075, dShelfDepthPx);
                let shelfIsobathVal = fract(depthMeters / 200.0);
                let distToShelfIsobath = min(shelfIsobathVal, 1.0 - shelfIsobathVal);
                let isShelfIsobath = (1.0 - smoothstep(0.0, shelfHalfW, distToShelfIsobath)) * smoothstep(600.0, 100.0, depthMeters) * flatShelfGate;

                let moireGuard = 1.0 - smoothstep(0.35, 0.85, dDynDepthPx);
                let moireGuardMajor = 1.0 - smoothstep(0.45, 1.15, dMajorDepthPx * 0.20);
                let bathyHachureFade = 1.0 - smoothstep(0.70, 0.98, slopeAngle);
                let bathySlopeWeight = mix(0.75, 1.0, bathyHachureFade);
                let cMarineTurquoise = vec3<f32>(0.22, 0.62, 0.70); // Marine turquoise drafting ink #389EB3
                let netIsobath = (max(isDynIsobath * 0.42 * moireGuard + isIsobath * 0.62 * moireGuardMajor, isShelfIsobath * 0.75)) * bathySlopeWeight;
                finalCrust = mix(finalCrust, cMarineTurquoise, netIsobath * 0.55 * shoreIsobathFade * zeroDatumFade * orbitalContourFade);
                let netMacroIsobath = max(isDynIsobath * 0.38 * moireGuard * regionalContourFade + isIsobath * 0.68 * moireGuardMajor * macroContourFade, isShelfIsobath * 0.78 * macroContourFade) * bathySlopeWeight;
                finalCrust = mix(finalCrust, cMarineTurquoise, netMacroIsobath * 0.58 * shoreIsobathFade * zeroDatumFade);
            }
        }
    }

    // Atmospheric limb darkening in light mode to define globe silhouette against white canvas
    if (sim.u_theme == 1u) {
        let NdotV = clamp(dot(n0, V), 0.0, 1.0);
        let limbFactor = pow(1.0 - NdotV, 3.0);
        let unfurlFade = 1.0 - smoothstep(0.3, 0.8, sim.u_unfurl);
        finalCrust = finalCrust * (1.0 - limbFactor * 0.35 * unfurlFade);
    }

    // ========================================================================
    // STAGE 3: Archival Ink Pigmentation & Weather Overlays
    // ========================================================================
    let windHorizLen = length(windForAdvection.xy);
    let windDir2D = select(vec2<f32>(0.0, 0.0), windForAdvection.xy / max(windHorizLen, 1e-4), windHorizLen > 0.5);
    let terrainUpSlope2D = vec2<f32>((hR - hL) * 0.5, (hU - hD) * 0.5) / max(ts.y, 1e-6);
    let upslopeDot = dot(windDir2D, terrainUpSlope2D);
    let orographicMod = clamp(1.0 + upslopeDot * 0.35 * regWeightC, 0.45, 2.20);
    let effectivePrecipRate = precipRate * orographicMod * select(4.5, 1.6, sim.u_weatherOpticalMode == 1u);

    var weatherOverlay = vec4<f32>(0.0);
    if (sim._padScrub1 > 3.5) {
        weatherOverlay = vec4<f32>(0.0);
    } else if (sim._padScrub1 > 2.5) {
        weatherOverlay = sample_z500_overlay(tempC, dewpointC, dTempPx, windForAdvection.xy, input.uv, dUV, sim.u_theme);
    } else if (sim._padScrub1 > 1.5) {
        weatherOverlay = sample_temperature_overlay(tempC, dTempPx, sim.u_theme);
    } else if (sim.u_weatherOpticalMode == 1u) {
        weatherOverlay = sample_spectral_doppler(effectivePrecipRate);
    } else {
        weatherOverlay = apply_weather_pigmentation(
            effectivePrecipRate,
            sim.u_theme,
            sim.u_mediumProperties,
            vec4<f32>(finalCrust, 1.0)
        );
    }

    finalCrust = mix(finalCrust, weatherOverlay.rgb, weatherOverlay.a);

    // ========================================================================
    // CDLOD Real-Time Diagnostic Plate (Milestone 5 / R5)
    // ========================================================================
    if (sim.u_cdlodDiagnosticMode > 0.5) {
        let lodInt = u32(round(input.lodInfo.x));
        let alpha = clamp(input.lodInfo.y, 0.0, 1.0);
        let lodColor = getLODColor(lodInt);

        var diagColor: vec3<f32>;
        if (sim.u_cdlodDiagnosticMode >= 2.5) {
            // Mode 3: Combined plate (LOD hue modulated by morph alpha + preserved hillshade relief)
            let alphaMod = mix(vec3<f32>(0.75), vec3<f32>(1.25, 1.05, 0.65), alpha);
            diagColor = lodColor * alphaMod;
        } else if (sim.u_cdlodDiagnosticMode >= 1.5) {
            // Mode 2: Pure Morph Factor Alpha Ramp
            diagColor = mix(vec3<f32>(0.05, 0.40, 0.85), vec3<f32>(0.95, 0.20, 0.10), alpha);
        } else {
            // Mode 1: Discrete Integer LOD Hue
            diagColor = lodColor;
        }

        let hillshade = clamp(NdotL1 * shadowFactor + 0.35, 0.25, 1.25);
        finalCrust = diagColor * hillshade;
    }

    return vec4<f32>(finalCrust, 1.0);
}
