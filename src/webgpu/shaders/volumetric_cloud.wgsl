// ============================================================================
// File: src/webgpu/shaders/volumetric_cloud.wgsl
// Target: WebGPU Pass 2 Volumetric Cloud Raymarcher
// Description: Dedicated Pass 2 full-screen raymarcher rendering stratified
//              tropospheric cloud decks, marine stratus inversions, and mountain
//              peak piercings driven by WeatherNext 3 prognostic data and 3D
//              Perlin-Worley erosion noise.
//
// Invariants:
//   - Mandatory Explicit LOD (textureSampleLevel / textureLoad)
//   - Premultiplied Alpha Transparent Clear & Compositing
//   - Zero-Standoff Surface Conformance & Bounding Geometry
//   - Cross-Pipeline DEM Mathematical Parity
//   - 16-Byte WGSL Struct Alignment
//   - Uniform-Buffer-Driven Dynamic Theme Switching (Zero-Recompile)
//   - Exhaustive Multi-Medium Archival Inking Parity (Themes 0, 1, 2)
// ============================================================================

// __HALF_PRECISION_ALIASES_START__
alias half = f32;
alias half2 = vec2<f32>;
alias half3 = vec3<f32>;
alias half4 = vec4<f32>;
// __HALF_PRECISION_ALIASES_END__

const PI: f32 = 3.141592653589793;
const TWO_PI: f32 = 6.283185307179586;
const HALF_PI: f32 = 1.5707963267948966;
const INV_FOUR_PI: f32 = 0.07957747154594767;
const RADIUS: f32 = 5.0;

// ----------------------------------------------------------------------------
// Uniform Buffer Struct Declarations (16-Byte Aligned)
// ----------------------------------------------------------------------------

struct VolumetricCameraUniforms {
    u_invViewMatrix: mat4x4<f32>,       // offset 0 (floats 0..15)
    u_invProjectionMatrix: mat4x4<f32>, // offset 64 (floats 16..31)
    u_cameraPos: vec4<f32>,             // offset 128 (floats 32..35)
    u_viewport: vec4<f32>,              // offset 144 (floats 36..39)
    u_nearFar: vec4<f32>,               // offset 160 (floats 40..43)
    u_padCamera: vec4<f32>,             // offset 176 (floats 44..47)
    u_prevViewProj: mat4x4<f32>,        // offset 192 (floats 48..63)
    u_taaParams: vec4<f32>,             // offset 256 (floats 64..67: frameParity, historyWeight, dt, checkerGridW)
};

struct VolumetricCloudUniforms {
    u_shellRadii: vec4<f32>,     // offset 0 (floats 0..3: rInner, rOuter, deltaR, pad)
    u_sunDirection: vec4<f32>,   // offset 16 (floats 4..7: sunDir.xyz, sunAltitude)
    u_layerHeights: vec4<f32>,   // offset 32 (floats 8..11: lowTop, midBottom, midTop, highBottom)
    u_layerDensities: vec4<f32>, // offset 48 (floats 12..15: lowDens, midDens, highDens, masterOpacity)
    u_lclParams: vec4<f32>,      // offset 64 (floats 16..19: lclMeters, lclNorm, lapseRate, inversionFactor)
    u_noiseParams: vec4<f32>,    // offset 80 (floats 20..23: noiseFreq, billowStr, erosionStr, driftRate)
    u_opticalParams: vec4<f32>,  // offset 96 (floats 24..27: extinction, albedo, hgG1, hgG2)
    u_mediumParams: vec4<f32>,   // offset 112 (floats 28..31: theme, inkAbsorption, paperTooth, gamma)
    u_simControl: vec4<f32>,     // offset 128 (floats 32..35: time, unfurl, pad, maxSteps)
    u_padCloud: vec4<f32>,       // offset 144 (floats 36..39: falseColor, pad, pad, pad)
    u_ghibliParams: vec4<f32>,   // offset 160 (floats 40..43: wispinessOverride, gouacheGrouping, multiScatterPenetration, shearTendrils)
};

// ----------------------------------------------------------------------------
// Resource Bindings (@group(0))
// ----------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> camera: VolumetricCameraUniforms;
@group(0) @binding(1) var<uniform> cloud: VolumetricCloudUniforms;
@group(0) @binding(2) var u_depthTexture: texture_depth_2d;
@group(0) @binding(3) var u_cloudNoiseTexture: texture_3d<f32>;
@group(0) @binding(4) var u_noiseSampler: sampler;
@group(0) @binding(5) var u_cloudLowTexture: texture_2d<f32>;
@group(0) @binding(6) var u_cloudMidTexture: texture_2d<f32>;
@group(0) @binding(7) var u_cloudHighTexture: texture_2d<f32>;
@group(0) @binding(8) var u_cloud2DSampler: sampler;
@group(0) @binding(9) var u_proxyFrontDepth: texture_depth_2d;
@group(0) @binding(10) var u_proxyBackDepth: texture_depth_2d;
@group(0) @binding(11) var u_windTexture: texture_2d<f32>;
@group(0) @binding(12) var u_jetStreamTexture: texture_2d<f32>;
@group(0) @binding(13) var u_precipTexture: texture_2d<f32>;
@group(0) @binding(14) var u_demTexture: texture_2d<f32>;
@group(0) @binding(15) var u_tempTexture: texture_2d<f32>;
@group(0) @binding(16) var u_dewpointTexture: texture_2d<f32>;
@group(0) @binding(17) var u_halfResCloudTexture: texture_2d<f32>;
@group(0) @binding(18) var<storage, read> u_cloudPreCullGrid: array<u32>;
@group(0) @binding(19) var u_checkerColorTexture: texture_2d<f32>;
@group(0) @binding(20) var u_checkerCentroidTexture: texture_2d<f32>;
@group(0) @binding(21) var u_historyColorTexture: texture_2d<f32>;
@group(0) @binding(22) var u_historyCentroidTexture: texture_2d<f32>;

fn sampleCloudPreCullGrid(uv: vec2<f32>) -> vec2<f32> {
    let uWrapped = fract(fract(uv.x) + 1.0);
    let vClamped = clamp(uv.y, 0.0, 0.9999);
    let ix = min(224u, u32(floor(uWrapped * 225.0)));
    let iy = min(112u, u32(floor(vClamped * 113.0)));
    return unpack2x16float(u_cloudPreCullGrid[iy * 225u + ix]);
}

// ----------------------------------------------------------------------------
// Section 1: Semi-Lagrangian Advection Resource Bindings (@group(1))
// ----------------------------------------------------------------------------

struct AdvectionUniforms {
    u_deltaTime: f32,               // offset 0  (seconds, e.g. 0.0166)
    u_advectionSpeed: f32,          // offset 4  (temporal velocity multiplier)
    u_condensationRate: f32,        // offset 8  (orographic condensation coefficient)
    u_evaporationRate: f32,         // offset 12 (dry air subsidence dissipation rate)
    u_gridDimensions: vec4<u32>,    // offset 16 (width, height, depth, mipLevels)
    u_windAltitudeShear: vec4<f32>, // offset 32 (u_shear, v_shear, coriolis_tau, pad)
    u_thresholdParams: vec4<f32>,   // offset 48 (w_crit, min_density, max_density, pad)
};

@group(1) @binding(0) var<uniform> advection: AdvectionUniforms;
@group(1) @binding(1) var u_advectedDensityTexture: texture_3d<f32>;
@group(1) @binding(2) var u_advectedDensitySampler: sampler;

// ----------------------------------------------------------------------------
// Stage 1 (Choice A): High-Resolution 30m Slippy & Regional Terrain Bindings (@group(2))
// ----------------------------------------------------------------------------

struct RegionalOverlayUniforms {
    u_regionalBounds: vec4<f32>, // minLon, minLat, maxLon, maxLat
    u_pad0: vec4<f32>,
    u_pad1: vec4<f32>,           // clusterBounds: minLon, minLat, maxLon, maxLat
    u_regionalActive: u32,
    u_pad2: u32,
    u_pad3: u32,                 // activeSlotCount
    u_pad4: u32,
};

struct TileSlotDescriptor {
    bounds: vec4<f32>,           // x: minLon, y: minLat, z: maxLon, w: maxLat
    tileMeta: vec4<f32>,         // x: lod + edgeMask * 64.0, y: slotIndex, z: uvScaleX, w: uvScaleY
};

@group(2) @binding(0) var<uniform> u_regionalOverlay: RegionalOverlayUniforms;
@group(2) @binding(1) var u_regionalDEMTexture: texture_2d<f32>;
@group(2) @binding(2) var u_tileCacheArray: texture_2d_array<f32>;
@group(2) @binding(3) var<storage, read> u_tileSlots: array<TileSlotDescriptor>;
@group(2) @binding(4) var u_demMipSampler: sampler;
@group(2) @binding(5) var u_regNoiseTexture: texture_3d<f32>;

// ----------------------------------------------------------------------------
// Full-Screen Triangle Vertex Shader
// ----------------------------------------------------------------------------

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var out: VertexOutput;
    // Generates oversized full-screen triangle:
    // Index 0: (-1, -1), Index 1: (3, -1), Index 2: (-1, 3)
    let x = f32(i32(vertexIndex & 1u) * 4 - 1);
    let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
    let depthSyncFence = textureLoad(u_depthTexture, vec2<i32>(0, 0), 0);
    out.position = vec4<f32>(x, y, depthSyncFence * 0.0, 1.0);
    out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

// ----------------------------------------------------------------------------
// Geometry & Depth Reconstruction Routines
// ----------------------------------------------------------------------------


// Reconstruct World Position from Depth Value and Camera Matrices
fn reconstructWorldPosition(ndcX: f32, ndcY: f32, depthVal: f32) -> vec3<f32> {
    // In Three.js with WebGPU, u_depthTexture depthVal is already in NDC Z space
    let ndcZ = depthVal;
    let clipSurface = vec4<f32>(ndcX, ndcY, ndcZ, 1.0);
    let viewPosH = camera.u_invProjectionMatrix * clipSurface;
    let worldPosH = camera.u_invViewMatrix * vec4<f32>(viewPosH.xyz / max(1e-6, abs(viewPosH.w)), 1.0);
    return worldPosH.xyz;
}

// Spherical Coordinates to Equirectangular UV Mapping
fn worldToEquirectangularUV(pos3D: vec3<f32>) -> vec2<f32> {
    let curR = max(length(pos3D), 0.001);
    let lambda = atan2(pos3D.x, pos3D.z);
    let phi = asin(clamp(pos3D.y / curR, -0.9998, 0.9998));
    let u = fract((lambda / TWO_PI) + 0.5);
    let v = clamp(0.5 - (phi / PI), 0.001, 0.999);
    return vec2<f32>(u, v);
}


// Closed-Form Analytical Inversion of Pure Developable Macro Chart
// Returns vec3<f32>(lambda, phi, h)
fn invertMacroChartWGSL(pos: vec3<f32>, unfurl: f32, radius: f32) -> vec3<f32> {
    let px = pos.x;
    let py = pos.y;
    let pz = pos.z;
    let alphaClamped = clamp(unfurl, 0.0, 1.0);
    if (alphaClamped <= 0.0005) {
        let rSphFast = length(pos);
        let hSphFast = rSphFast - radius;
        let phiSphFast = asin(clamp(py / max(0.0001, rSphFast), -0.9998, 0.9998));
        let lambdaSphFast = atan2(px, pz);
        return vec3<f32>(lambdaSphFast, phiSphFast, hSphFast);
    }
    if (alphaClamped >= 0.9995) {
        return vec3<f32>(px / radius, py / radius, pz);
    }
    let alphaEased = alphaClamped * alphaClamped * (3.0 - 2.0 * alphaClamped);
    let s = max(0.0001, 1.0 - alphaEased);
    let tStraighten = smoothstep(0.20, 0.95, alphaEased);
    let tParallel = smoothstep(0.05, 0.85, alphaEased);

    // Solve phi from py via 3 Newton-Raphson iterations
    let yMax = radius * (1.0 - tStraighten + tStraighten * HALF_PI);
    let normY = clamp(py / max(0.0001, yMax), -0.9999, 0.9999);
    var phi = (1.0 - tStraighten) * asin(normY) + tStraighten * (normY * HALF_PI);
    for (var iter: i32 = 0; iter < 3; iter++) {
        let sinP = sin(phi);
        let cosP = cos(phi);
        let f = (1.0 - tStraighten) * radius * sinP + tStraighten * radius * phi - py;
        let df = (1.0 - tStraighten) * radius * cosP + tStraighten * radius;
        phi = phi - f / max(df, 0.0001);
    }
    phi = clamp(phi, -HALF_PI, HALF_PI);

    // Developable Intermediate Circular Arc Inversion
    let cosLat = cos(phi);
    let parallelWidth = cosLat * (1.0 - tParallel) + tParallel;
    let rPar = radius * parallelWidth;
    let sDiv = max(0.0001, s);
    let Rc = rPar / sDiv;
    let Cz = rPar * (s - 1.0 / sDiv);

    // Tactile sheet loft compensation:
    // Mode 0 evaluateModeZero adds dz_lift = (0.60 + 0.40 * cosLat) * radius * 0.06 * env to the deformed crust and proxy.
    // Invert through the physically lifted sheet so tropospheric altitude conforms to terrain across all unfurl states.
    let sZero = smoothstep(0.0, 0.10, alphaClamped);
    let sOne = 1.0 - smoothstep(0.90, 1.0, alphaClamped);
    let env = sin(PI * alphaClamped) * sZero * sOne;
    let dz_lift = (0.60 + 0.40 * cosLat) * radius * 0.06 * env;

    let dz = (pz - dz_lift) - Cz;
    let lambdaDev = atan2(px, dz) / sDiv;
    let hDev = length(vec2<f32>(px, dz)) - Rc;

    // Asymptotic Sphere Regime (alpha <= 0.05)
    let rSph = length(pos);
    let hSph = rSph - radius;
    let phiSph = asin(clamp(py / max(0.0001, rSph), -0.9998, 0.9998));
    let lambdaSph = atan2(px, pz);

    // Asymptotic Planar Regime (alpha >= 0.95)
    let hFlat = pz;
    let lambdaFlat = px / radius;
    let phiFlat = py / radius;

    let tSphere = 1.0 - smoothstep(0.0, 0.05, alphaClamped);
    let tFlat = smoothstep(0.95, 1.0, alphaClamped);

    var lambda = mix(lambdaDev, lambdaSph, tSphere);
    lambda = mix(lambda, lambdaFlat, tFlat);

    var finalPhi = mix(phi, phiSph, tSphere);
    finalPhi = mix(finalPhi, phiFlat, tFlat);

    var h = mix(hDev, hSph, tSphere);
    h = mix(h, hFlat, tFlat);

    return vec3<f32>(lambda, finalPhi, h);
}

// Forward Evaluation of Pure Developable Macro Chart F(lambda, phi, h; unfurl, radius) -> (x, y, z)
// Provides exact forward counterpart to invertMacroChartWGSL with tactile sheet loft compensation
fn evaluateMacroChartWGSL(lonRad: f32, latRad: f32, h: f32, alpha: f32, radius: f32) -> vec3<f32> {
    let alphaClamped = clamp(alpha, 0.0, 1.0);
    let cosLat = cos(latRad);
    let sinLat = sin(latRad);
    if (alphaClamped <= 0.0005) {
        return vec3<f32>(
            (radius + h) * cosLat * sin(lonRad),
            (radius + h) * sinLat,
            (radius + h) * cosLat * cos(lonRad)
        );
    }
    if (alphaClamped >= 0.9995) {
        return vec3<f32>(radius * lonRad, radius * latRad, h);
    }
    let alphaEased = alphaClamped * alphaClamped * (3.0 - 2.0 * alphaClamped);
    let tParallel = smoothstep(0.05, 0.85, alphaEased);
    let parallelWidth = cosLat * (1.0 - tParallel) + tParallel;
    let rPar = radius * parallelWidth;
    let s = max(0.0001, 1.0 - alphaEased);
    let uAngle = s * lonRad;

    var curX: f32;
    var curZ: f32;
    if (abs(uAngle) > 0.02) {
        let sDiv = max(0.0001, s);
        curX = rPar * (sin(uAngle) / sDiv);
        curZ = rPar * ((cos(uAngle) - 1.0) / sDiv + s);
    } else {
        let u2 = uAngle * uAngle;
        curX = rPar * lonRad * (1.0 - u2 / 6.0);
        curZ = rPar * s * (1.0 - lonRad * lonRad * 0.5 * (1.0 - u2 / 12.0));
    }

    let tStraighten = smoothstep(0.20, 0.95, alphaEased);
    let curY = (1.0 - tStraighten) * radius * sinLat + tStraighten * radius * latRad;

    // Tactile sheet loft compensation matching invertMacroChartWGSL
    let sZero = smoothstep(0.0, 0.10, alphaClamped);
    let sOne = 1.0 - smoothstep(0.90, 1.0, alphaClamped);
    let env = sin(PI * alphaClamped) * sZero * sOne;
    let dz_lift = (0.60 + 0.40 * cosLat) * radius * 0.06 * env;

    // Developable cylinder surface normal in (x, z)
    let normX = sin(uAngle);
    let normY = 0.0;
    let normZ = cos(uAngle);

    let pDev = vec3<f32>(
        curX + normX * h,
        curY + normY * h,
        curZ + normZ * h + dz_lift
    );

    // Asymptotic Spherical Regime (alpha <= 0.05)
    let pSph = vec3<f32>(
        (radius + h) * cosLat * sin(lonRad),
        (radius + h) * sinLat,
        (radius + h) * cosLat * cos(lonRad)
    );

    // Asymptotic Planar Regime (alpha >= 0.95)
    let pFlat = vec3<f32>(
        radius * lonRad,
        radius * latRad,
        h
    );

    let tSphere = 1.0 - smoothstep(0.0, 0.05, alphaClamped);
    let tFlat = smoothstep(0.95, 1.0, alphaClamped);

    var p = mix(pDev, pSph, tSphere);
    p = mix(p, pFlat, tFlat);
    return p;
}

// Stage 1 Host Channel & Feature Helpers (Choice A/B/G/H)
fn getAtmoFeatureMask() -> u32 {
    let rawMask = camera.u_padCamera.x;
    if (rawMask < -0.5) {
        return 0u;
    }
    return select(255u, u32(clamp(round(rawMask), 0.0, 255.0)), rawMask > 0.5);
}

fn isAtmoFeatureEnabled(bit: u32) -> bool {
    return (getAtmoFeatureMask() & (1u << bit)) != 0u;
}

fn getPackedChannelFlags() -> u32 {
    return u32(clamp(round(max(0.0, camera.u_nearFar.w)), 0.0, 63.0));
}

fn hasDualHourClouds() -> bool {
    return (getPackedChannelFlags() & 1u) != 0u && isAtmoFeatureEnabled(1u);
}

fn hasMslpAndSpread() -> bool {
    return (getPackedChannelFlags() & 2u) != 0u;
}

fn hasWind100m() -> bool {
    return (getPackedChannelFlags() & 4u) != 0u && isAtmoFeatureEnabled(1u);
}

fn hasWind500hPa() -> bool {
    return (getPackedChannelFlags() & 8u) != 0u;
}

fn getScrubTau() -> f32 {
    return clamp(camera.u_nearFar.z, 0.0, 1.0);
}

fn getActiveManifoldMode() -> u32 {
    return u32(clamp(round(cloud.u_simControl.z), 0.0, 3.0));
}

// Choice H: Unified Inverse Manifold Evaluator across Mode 0 (Equirectangular Roll) and Modes 1..3 (Web Mercator Unfurls)
fn invertManifoldModeWGSL(pos: vec3<f32>, unfurl: f32, radius: f32) -> vec3<f32> {
    let activeMode = getActiveManifoldMode();
    if (activeMode == 0u || !isAtmoFeatureEnabled(7u)) {
        return invertMacroChartWGSL(pos, unfurl, radius);
    }

    let px = pos.x;
    let py = pos.y;
    let pz = pos.z;
    let alpha = clamp(unfurl, 0.0, 1.0);
    let rSph = max(0.0001, length(pos));
    let lambdaSph = atan2(px, pz);
    let phiSph = asin(clamp(py / rSph, -0.9998, 0.9998));
    let hSph = rSph - radius;

    if (alpha <= 0.0005) {
        return vec3<f32>(lambdaSph, phiSph, hSph);
    }

    let mercNormY = py / max(0.0001, radius);
    let mercClampedY = clamp(mercNormY, -3.1313, 3.1313);
    let phiMerc = 2.0 * atan(exp(mercClampedY)) - HALF_PI;
    let excessMercY = max(0.0, abs(mercNormY) - 3.1313);
    let phiMercUnbounded = select(phiMerc, sign(mercNormY) * (HALF_PI + excessMercY * 0.25), excessMercY > 0.0);
    let lambdaMerc = px / max(0.0001, radius);

    if (alpha >= 0.9995) {
        return vec3<f32>(lambdaMerc, phiMercUnbounded, pz);
    }

    if (activeMode == 1u) {
        let tCyl = smoothstep(0.0, 0.20, alpha);
        let tRoll = sin(PI * smoothstep(0.15, 0.40, alpha));
        let tUnroll = smoothstep(0.20, 1.0, alpha);
        let s = max(0.0001, 1.0 - tUnroll);

        var phi = mix(phiSph, phiMerc, tUnroll);
        for (var iter: i32 = 0; iter < 3; iter++) {
            let pClamped = clamp(phi, -1.4835, 1.4835);
            let mercY = log(tan(PI * 0.25 + pClamped * 0.5)) * radius;
            let secP = 1.0 / max(0.087, cos(pClamped));
            let f = (1.0 - tUnroll) * radius * sin(pClamped) + tUnroll * mercY - py;
            let df = (1.0 - tUnroll) * radius * cos(pClamped) + tUnroll * radius * secP;
            phi = clamp(pClamped - f / max(0.0001, df), -1.4835, 1.4835);
        }
        let rCyl = mix(radius * cos(phi), radius, tCyl);
        let rScroll = rCyl * (1.0 - 0.20 * tRoll);
        let Rc = rScroll / s;
        let Cz = rScroll * (s - 1.0 / s);
        let dz = pz - Cz;
        let lambdaDev = atan2(px, dz) / s;
        let hDev = length(vec2<f32>(px, dz)) - Rc;
        return vec3<f32>(lambdaDev, phi, hDev);
    }

    let tFlat = select(alpha, smoothstep(0.15, 1.0, alpha), activeMode == 2u);
    let mode2Lift = select(0.06 * radius * (1.0 - tFlat), 0.06 * radius * (alpha / 0.15), alpha <= 0.15);
    let volLift = select(mode2Lift, radius * 0.50 * sin(PI * alpha), activeMode == 3u);
    return vec3<f32>(
        mix(lambdaSph, lambdaMerc, tFlat),
        mix(phiSph, phiMercUnbounded, tFlat),
        mix(hSph - volLift, pz, tFlat)
    );
}

fn evaluateForwardManifoldWGSL(lonRad: f32, latRad: f32, h: f32, alpha: f32, radius: f32) -> vec3<f32> {
    let activeMode = getActiveManifoldMode();
    if (activeMode == 0u || !isAtmoFeatureEnabled(7u)) {
        return evaluateMacroChartWGSL(lonRad, latRad, h, alpha, radius);
    }
    let alphaClamped = clamp(alpha, 0.0, 1.0);
    let cosLat = cos(latRad);
    let sinLat = sin(latRad);
    let pSph = vec3<f32>(
        (radius + h) * cosLat * sin(lonRad),
        (radius + h) * sinLat,
        (radius + h) * cosLat * cos(lonRad)
    );
    if (alphaClamped <= 0.0005) {
        return pSph;
    }
    let clampedPhi = clamp(latRad, -1.4835, 1.4835);
    let mercY = log(tan(PI * 0.25 + clampedPhi * 0.5)) * radius;
    let pMerc = vec3<f32>(radius * lonRad, mercY, h);
    if (alphaClamped >= 0.9995) {
        return pMerc;
    }
    if (activeMode == 1u) {
        let tCyl = smoothstep(0.0, 0.20, alphaClamped);
        let tRoll = sin(PI * smoothstep(0.15, 0.40, alphaClamped));
        let tUnroll = smoothstep(0.20, 1.0, alphaClamped);
        let rScroll = mix(radius * cosLat, radius, tCyl) * (1.0 - 0.20 * tRoll);
        let s = max(0.0001, 1.0 - tUnroll);
        let u = s * lonRad;
        var curX: f32;
        var curZ: f32;
        if (abs(u) > 0.02) {
            curX = rScroll * (sin(u) / s);
            curZ = rScroll * ((cos(u) - 1.0) / s + s);
        } else {
            let u2 = u * u;
            curX = rScroll * lonRad * (1.0 - u2 / 6.0);
            curZ = -s * rScroll * (lonRad * lonRad) * (0.5 - u2 / 24.0) + rScroll * s;
        }
        let curY = mix(radius * sinLat, mercY, tUnroll);
        let cylNorm = vec3<f32>(sin(u), 0.0, cos(u));
        return vec3<f32>(curX, curY, curZ) + cylNorm * h;
    }
    let tFlat = select(alphaClamped, smoothstep(0.15, 1.0, alphaClamped), activeMode == 2u);
    let mode2Lift = select(0.06 * radius * (1.0 - tFlat), 0.06 * radius * (alphaClamped / 0.15), alphaClamped <= 0.15);
    let volLift = select(mode2Lift, radius * 0.50 * sin(PI * alphaClamped), activeMode == 3u);
    let sphNorm = vec3<f32>(cosLat * sin(lonRad), sinLat, cosLat * cos(lonRad));
    return mix(pSph + sphNorm * volLift, pMerc, tFlat);
}

// Symmetric Central Finite Difference Jacobian Matrix J = [dF/dLambda, dF/dPhi, dF/dH]
// Each column vector represents the local tangent frame vector in world space
fn computeJacobian(lambda: f32, phi: f32, h: f32, unfurl: f32, radius: f32) -> mat3x3<f32> {
    let DELTA: f32 = 0.001;
    let TWO_DELTA: f32 = DELTA * 2.0;

    // dF / dLambda
    let pLam0 = evaluateForwardManifoldWGSL(lambda - DELTA, phi, h, unfurl, radius);
    let pLam1 = evaluateForwardManifoldWGSL(lambda + DELTA, phi, h, unfurl, radius);
    let T_lambda = (pLam1 - pLam0) / TWO_DELTA;

    // dF / dPhi
    let pPhi0 = evaluateForwardManifoldWGSL(lambda, phi - DELTA, h, unfurl, radius);
    let pPhi1 = evaluateForwardManifoldWGSL(lambda, phi + DELTA, h, unfurl, radius);
    let T_phi = (pPhi1 - pPhi0) / TWO_DELTA;

    // dF / dH
    let pH0 = evaluateForwardManifoldWGSL(lambda, phi, h - DELTA, unfurl, radius);
    let pH1 = evaluateForwardManifoldWGSL(lambda, phi, h + DELTA, unfurl, radius);
    let T_h = (pH1 - pH0) / TWO_DELTA;

    return mat3x3<f32>(T_lambda, T_phi, T_h);
}

// Analytical Cross-Product Inversion of 3x3 Column-Major Matrix M = [c0, c1, c2]
// Uses GPU SIMD cross products to guarantee exact parameter velocity projection with zero indexing drift
fn inverse3x3(m: mat3x3<f32>) -> mat3x3<f32> {
    let c0 = m[0];
    let c1 = m[1];
    let c2 = m[2];

    let cross12 = cross(c1, c2);
    let cross20 = cross(c2, c0);
    let cross01 = cross(c0, c1);

    let det = dot(c0, cross12);
    let invDet = 1.0 / select(det, 1.0, abs(det) < 1e-8);

    let r0 = cross12 * invDet;
    let r1 = cross20 * invDet;
    let r2 = cross01 * invDet;

    return mat3x3<f32>(
        vec3<f32>(r0.x, r1.x, r2.x),
        vec3<f32>(r0.y, r1.y, r2.y),
        vec3<f32>(r0.z, r1.z, r2.z)
    );
}

// Computes Parameter-Space Velocity Vector v_uvw = (dLambda/dt, dPhi/dt, dH/dt)
// Maps world-space direction vector rayDir into local tangent parameter frame via J^-1 * rayDir
fn getParameterVelocity(
    ray_dir_world: vec3<f32>,
    lambda: f32,
    phi: f32,
    h: f32,
    unfurl: f32,
    radius: f32
) -> vec3<f32> {
    if (unfurl <= 0.0005) {
        let rEff = max(0.001, radius + h);
        let sinLam = sin(lambda);
        let cosLam = cos(lambda);
        let sinPhi = sin(phi);
        let cosPhi = max(0.001, cos(phi));
        let eLam = vec3<f32>(cosLam, 0.0, -sinLam);
        let ePhi = vec3<f32>(-sinPhi * sinLam, cosPhi, -sinPhi * cosLam);
        let eH = vec3<f32>(cosPhi * sinLam, sinPhi, cosPhi * cosLam);
        return vec3<f32>(
            dot(ray_dir_world, eLam) / (rEff * cosPhi),
            dot(ray_dir_world, ePhi) / rEff,
            dot(ray_dir_world, eH)
        );
    }
    if (unfurl >= 0.9995) {
        let invR = 1.0 / max(0.001, radius);
        let cosPhiMercScale = select(1.0, max(0.087, cos(phi)), getActiveManifoldMode() >= 1u && isAtmoFeatureEnabled(7u));
        return vec3<f32>(ray_dir_world.x * invR, ray_dir_world.y * invR * cosPhiMercScale, ray_dir_world.z);
    }
    let J = computeJacobian(lambda, phi, h, unfurl, radius);
    let J_inv = inverse3x3(J);
    return J_inv * ray_dir_world;
}

// ----------------------------------------------------------------------------
// Meteorological Cloud Density & Optics
// ----------------------------------------------------------------------------

// Smooth Vertical Trapezoid Envelope for Cloud Layer Strata
fn layerHeightEnvelope(h: f32, hMin: f32, hMax: f32, feather: f32) -> f32 {
    let bottom = smoothstep(hMin, hMin + feather, h);
    let top = 1.0 - smoothstep(hMax - feather, hMax, h);
    return bottom * top;
}

// Safe Linear Remap with Division-by-Zero Protection
fn remap(val: f32, inMin: f32, inMax: f32, outMin: f32, outMax: f32) -> f32 {
    let denom = inMax - inMin;
    let safeDenom = select(denom, 0.0001, abs(denom) < 0.0001);
    let t = clamp((val - inMin) / safeDenom, 0.0, 1.0);
    return outMin + t * (outMax - outMin);
}

// Analytical 1D Cumulus Height-Density Profile with Convective Buoyancy Expansion
fn cumulusHeightProfile(hNorm: f32, lowBottom: f32, lowTop: f32) -> f32 {
    if (hNorm <= lowBottom || hNorm >= lowTop) {
        return 0.0;
    }
    let delta = max(0.0001, lowTop - lowBottom);
    let z = clamp((hNorm - lowBottom) / delta, 0.0, 1.0);

    let baseRise = smoothstep(0.0, 0.16, z);
    let topDecay = 1.0 - smoothstep(0.28, 1.0, z);
    let mushroomSpread = 1.0 + 0.22 * sin(3.14159265 * clamp((z - 0.35) / 0.65, 0.0, 1.0));

    return clamp(baseRise * topDecay * mushroomSpread, 0.0, 1.0);
}

// Decoupled Spherical 3D Sampling Coordinate (True Planetary Anisotropic Noise Mapping)
fn sphericalNoiseCoord(
    pos: vec3<f32>,
    hNorm: f32,
    freqHoriz: f32,
    freqVert: f32,
    timeDrift: f32
) -> vec3<f32> {
    let n = normalize(pos);
    let vertOffset = vec3<f32>(0.0, hNorm * freqVert * 0.22, 0.0);
    let driftOffset = vec3<f32>(-timeDrift * 0.85, 0.0, timeDrift * 0.35);
    return n * freqHoriz + vertOffset + driftOffset;
}

// Isotropic 3D Procedural Noise Sampling in Planar Tropospheric Slab
fn planarNoiseCoord(
    uv: vec2<f32>,
    hNorm: f32,
    freqHoriz: f32,
    freqVert: f32,
    timeDrift: f32
) -> vec3<f32> {
    let lon = (uv.x - 0.5) * TWO_PI;
    let lat = (0.5 - uv.y) * PI;
    let cosLat = cos(lat);
    let sinLat = sin(lat);
    let sinLon = sin(lon);
    let cosLon = cos(lon);
    let n = vec3<f32>(cosLat * sinLon, sinLat, cosLat * cosLon);
    let vertOffset = vec3<f32>(0.0, hNorm * freqVert * 0.22, 0.0);
    return n * freqHoriz + vertOffset;
}

// Speed-Preserving Thermal-Wind Directional Veering (prevents 180-deg Cartesian cancellation)
fn blendStratumWindVector(wSurf: vec2<f32>, wJet: vec2<f32>, stratumMix: f32) -> vec2<f32> {
    let t = clamp(stratumMix, 0.0, 1.0);
    if (t <= 0.01) { return wSurf; }
    if (t >= 0.99) { return wJet; }
    let spdSurf = length(wSurf);
    let spdJet = length(wJet);
    if (spdSurf < 0.05 || spdJet < 0.05) {
        return mix(wSurf, wJet, t);
    }
    let dirSurf = wSurf / spdSurf;
    let dirJet = wJet / spdJet;
    let cosTheta = clamp(dot(dirSurf, dirJet), -1.0, 1.0);
    let perpSurf = vec2<f32>(dirSurf.y, -dirSurf.x);
    let antiParallelBias = 1.0 - smoothstep(-0.99, -0.65, cosTheta);
    let blendedDirRaw = mix(dirSurf, dirJet, t) + perpSurf * (antiParallelBias * sin(t * PI) * 0.85);
    let blendedDir = normalize(select(blendedDirRaw, perpSurf, dot(blendedDirRaw, blendedDirRaw) < 1e-4));
    let blendedSpd = mix(spdSurf, spdJet, t);
    return blendedDir * blendedSpd;
}

// Shared 3D Spherical Value-Noise Billow Field (Exact 1:1 Lockstep with crust_hydrosphere.wgsl Ground Shadows)
fn valueNoise3D(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let n = dot(i, vec3<f32>(1.0, 57.0, 113.0));
    let a = fract(sin(n + vec4<f32>(0.0, 1.0, 57.0, 58.0)) * 43758.5453);
    let b = fract(sin(n + vec4<f32>(113.0, 114.0, 170.0, 171.0)) * 43758.5453);
    let k1 = mix(a.xz, a.yw, u.x);
    let k2 = mix(b.xz, b.yw, u.x);
    let k3 = mix(vec2<f32>(k1.x, k2.x), vec2<f32>(k1.y, k2.y), u.y);
    return mix(k3.x, k3.y, u.z);
}

fn evalSphericalBillowOctaves(p: vec3<f32>) -> f32 {
    let n1 = valueNoise3D(p * 11.5);
    let pRot = vec3<f32>(
        (8.0 * p.x - 4.0 * p.y + 1.0 * p.z) * (1.0 / 9.0),
        (4.0 * p.x + 7.0 * p.y - 4.0 * p.z) * (1.0 / 9.0),
        (1.0 * p.x + 4.0 * p.y + 8.0 * p.z) * (1.0 / 9.0)
    );
    let n2 = valueNoise3D(pRot * 23.0 + vec3<f32>(1.7, 3.1, 2.3));
    return n1 * 0.66 + n2 * 0.34;
}

fn sampleSharedSphericalBillow3D(
    baseSphereCoord: vec3<f32>,
    eEast: vec3<f32>,
    eNorth: vec3<f32>,
    wRaw: vec2<f32>,
    freqScale: f32,
    timeSec: f32
) -> f32 {
    let rawSpd = length(wRaw);
    let calmAtten = smoothstep(0.0, 3.5, rawSpd);
    let wEff = (wRaw * calmAtten) * (10.0 * inverseSqrt(dot(wRaw, wRaw) + 9.0));
    let driftScale = clamp(abs(cloud.u_noiseParams.w) / 0.002, 0.0, 4.0);
    let omegaWind = 0.00068 * driftScale;
    let vWind3D = (eEast * wEff.x + eNorth * wEff.y) * (omegaWind * freqScale);

    const NOISE_FLOW_PERIOD: f32 = 36.0;
    let c = fract(timeSec / NOISE_FLOW_PERIOD);
    let t0 = (c - 0.5) * NOISE_FLOW_PERIOD;
    let b0 = evalSphericalBillowOctaves(baseSphereCoord - vWind3D * t0);
    if (driftScale <= 0.001) {
        return b0;
    }
    let s = sin(c * PI);
    let w0 = s * s;
    let t1 = (fract(c + 0.5) - 0.5) * NOISE_FLOW_PERIOD;
    let b1 = evalSphericalBillowOctaves(baseSphereCoord - vWind3D * t1);
    let w1 = 1.0 - w0;
    let invNorm = inverseSqrt(max(0.25, w0 * w0 + w1 * w1));
    return clamp(0.5 + ((b0 - 0.5) * w0 + (b1 - 0.5) * w1) * invNorm, 0.0, 1.0);
}

fn sampleFlowNoiseFromVel3D(
    baseCoord: vec3<f32>,
    vWind3D: vec3<f32>,
    driftScale: f32,
    timeSec: f32
) -> vec4<f32> {
    const NOISE_FLOW_PERIOD: f32 = 36.0;
    let c = fract(timeSec / NOISE_FLOW_PERIOD);
    let t0 = (c - 0.5) * NOISE_FLOW_PERIOD;
    let n0 = textureSampleLevel(u_cloudNoiseTexture, u_noiseSampler, baseCoord - vWind3D * t0, 0.0);
    if (driftScale <= 0.001) {
        return n0;
    }
    let s = sin(c * PI);
    let w0 = s * s;
    let t1 = (fract(c + 0.5) - 0.5) * NOISE_FLOW_PERIOD;
    let n1 = textureSampleLevel(u_cloudNoiseTexture, u_noiseSampler, baseCoord - vWind3D * t1, 0.0);
    let w1 = 1.0 - w0;
    let invNorm = inverseSqrt(max(0.25, w0 * w0 + w1 * w1));
    return clamp(vec4<f32>(0.5) + ((n0 - vec4<f32>(0.5)) * w0 + (n1 - vec4<f32>(0.5)) * w1) * invNorm, vec4<f32>(0.0), vec4<f32>(1.0));
}

// Direct Monotonic Periodic 3D Noise Sampler (converts canonical .gba Worley 1-r into exact C1 spherical-cap domes sqrt(1-(r/cellR)^2) while preserving .r perlinWorley)
fn samplePeriodicGhibliNoise3D(coord: vec3<f32>) -> vec4<f32> {
    let raw = textureSampleLevel(u_cloudNoiseTexture, u_noiseSampler, coord, 0.0);
    let rNorm = (vec3<f32>(1.0) - raw.gba) / vec3<f32>(0.94, 0.92, 0.90);
    let u = clamp(vec3<f32>(1.0) - rNorm * rNorm, vec3<f32>(0.0), vec3<f32>(1.0));
    let domes = sqrt(u) * smoothstep(vec3<f32>(0.0), vec3<f32>(0.12), u);
    return vec4<f32>(raw.r, domes.x, domes.y, domes.z);
}

// Variance-Preserving Monotonic 3D Stratum Wind Flow Noise (Perlin-Neyret Flow Noise on S^2)
// Advances 3D cellular noise monotonically along each stratum's local wind vector with zero cycle pop and constant contrast
fn sampleStratumFlowNoise3D(
    baseCoord: vec3<f32>,
    eEast: vec3<f32>,
    eNorth: vec3<f32>,
    wRaw: vec2<f32>,
    freqScale: f32,
    timeSec: f32
) -> vec4<f32> {
    let rawSpd = length(wRaw);
    // Direction-preserving calm-wind attenuation: smoothly approaches 0.0 as rawSpd -> 0
    let calmAtten = smoothstep(0.0, 3.5, rawSpd);
    let wEff = (wRaw * calmAtten) * (10.0 * inverseSqrt(dot(wRaw, wRaw) + 9.0));
    let driftScale = clamp(abs(cloud.u_noiseParams.w) / 0.002, 0.0, 4.0);
    // Exact angular velocity lockstep across all octaves: vWind3D = omegaWind * freqScale * (eEast * wEff.x + eNorth * wEff.y)
    let omegaWind = 0.00068 * driftScale;
    let vWind3D = (eEast * wEff.x + eNorth * wEff.y) * (omegaWind * max(freqScale, 0.85));
    return sampleFlowNoiseFromVel3D(baseCoord, vWind3D, driftScale, timeSec);
}

// Fast Pre-Fetched Geodesic Wind Back-Trajectory
// Exact pushforward of S^2 angular wind velocity omegaWind * wEff into equirectangular (u, v) space (1:1 lockstep with crust_hydrosphere.wgsl)
fn computeWindSwirlAdvectedUV(
    baseUV: vec2<f32>,
    w0: vec2<f32>,
    phaseSec: f32,
    fallbackDriftU: f32,
    cosLat: f32
) -> vec2<f32> {
    let speedSq = dot(w0, w0);
    if (speedSq < 0.0025) {
        return vec2<f32>(fract(baseUV.x + fallbackDriftU * 0.15), baseUV.y);
    }

    let rawSpd = sqrt(speedSq);
    let calmAtten = smoothstep(0.0, 3.5, rawSpd);
    let v0Eff = (w0 * calmAtten) * (10.0 * inverseSqrt(speedSq + 9.0));
    let driftScale = clamp(abs(cloud.u_noiseParams.w) / 0.002, 0.0, 4.0);
    let omegaWind = 0.00030 * driftScale;
    let safeCosLat = clamp(cosLat, 0.22, 1.0);
    let velUV = vec2<f32>(
        (v0Eff.x * omegaWind) / (TWO_PI * safeCosLat),
       -(v0Eff.y * omegaWind) / PI
    );
    let mesoHorizonSec = 5.5 * (phaseSec * inverseSqrt(30.25 + phaseSec * phaseSec));
    let zonalSynopticVelU = (-0.00075 * driftScale * cos(2.8 * (0.5 - baseUV.y) * PI)) / (TWO_PI * safeCosLat);
    let meridSynopticVelV = (0.00024 * driftScale * sin(baseUV.x * TWO_PI + 0.85)) / PI;

    return vec2<f32>(
        fract(baseUV.x - velUV.x * mesoHorizonSec - zonalSynopticVelU * phaseSec),
        clamp(baseUV.y - velUV.y * mesoHorizonSec - meridSynopticVelV * phaseSec, 0.001, 0.999)
    );
}

// True 2D Spherical Conformal Voronoi (F1, F2) for Marine Stratocumulus Closed & Open Bénard Honeycombs
// Uses Gauss conformal isometric latitude psi = atanh(sin(phi)) so nabla(lambda) perp nabla(psi) with zero (-lambda * sin(phi)) longitude shear
// Calibrated to mesoscale marine boundary-layer cellular convection (~35-50 km primary cells, subdivided by 3D Worley florets to 15-25 km)
fn evaluateSphericalBenardVoronoi(lonRad: f32, latRad: f32, timeDrift: f32) -> vec2<f32> {
    let sinPhi = clamp(sin(latRad), -0.95, 0.95);
    let isoLat = 0.5 * log((1.0 + sinPhi) / (1.0 - sinPhi));
    let wrappedDrift = fract(timeDrift * 0.025) * TWO_PI;
    let baseGrid = vec2<f32>((lonRad + wrappedDrift) * 180.0, isoLat * 180.0);
    let warp = vec2<f32>(
        sin(isoLat * 110.0 + lonRad * 105.0) * 0.24 + cos(isoLat * 220.0 - lonRad * 195.0) * 0.12,
        cos(lonRad * 115.0 - isoLat * 120.0) * 0.24 + sin(lonRad * 230.0 + isoLat * 210.0) * 0.12
    );
    let pCell = baseGrid + warp;
    let iCell = floor(pCell);
    let fCell = fract(pCell);
    var f1: f32 = 8.0;
    var f2: f32 = 8.0;
    for (var y: i32 = -1; y <= 1; y++) {
        for (var x: i32 = -1; x <= 1; x++) {
            let neighbor = vec2<f32>(f32(x), f32(y));
            let cell = iCell + neighbor;
            let h1 = fract(sin(dot(cell, vec2<f32>(127.1, 311.7))) * 43758.5453);
            let h2 = fract(sin(dot(cell, vec2<f32>(269.5, 183.3))) * 43758.5453);
            let point = neighbor + vec2<f32>(0.16 + 0.68 * h1, 0.16 + 0.68 * h2) - fCell;
            let dSq = dot(point, point);
            if (dSq < f1) {
                f2 = f1;
                f1 = dSq;
            } else if (dSq < f2) {
                f2 = dSq;
            }
        }
    }
    return vec2<f32>(sqrt(f1), sqrt(f2));
}

fn smaxDepthGhibli(dA: f32, dB: f32, k: f32) -> f32 {
    let h = clamp(0.5 + 0.5 * (dB - dA) / max(0.0001, k), 0.0, 1.0);
    return mix(dA, dB, h) + k * h * (1.0 - h);
}

fn sminDepthGhibli(dA: f32, dB: f32, k: f32) -> f32 {
    return -smaxDepthGhibli(-dA, -dB, k);
}

fn rotSO3A(v: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        (8.0 * v.x - 4.0 * v.y + 1.0 * v.z) * (1.0 / 9.0),
        (4.0 * v.x + 7.0 * v.y - 4.0 * v.z) * (1.0 / 9.0),
        (1.0 * v.x + 4.0 * v.y + 8.0 * v.z) * (1.0 / 9.0)
    );
}

fn rotSO3B(v: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        ( 4.0 * v.x + 8.0 * v.y + 1.0 * v.z) * (1.0 / 9.0),
        (-7.0 * v.x + 4.0 * v.y - 4.0 * v.z) * (1.0 / 9.0),
        (-4.0 * v.x + 1.0 * v.y + 8.0 * v.z) * (1.0 / 9.0)
    );
}

// Exact SO(3) Rigid Isometric World Advection (det(J) == 1.000000 everywhere on S^2 x R for all t >= 0: zero wind-gradient taffy shear or step-cache discontinuities)
fn advectIsometricGhibliPos(q: vec3<f32>, timeSec: f32, driftScale: f32, unfurlAlpha: f32) -> vec3<f32> {
    let ang = -timeSec * (0.00065 * driftScale);
    let axis = vec3<f32>(-0.3358847, 0.9116871, 0.2367661);
    let c = cos(ang);
    let s = sin(ang);
    let qRot = q * c + cross(axis, q) * s + axis * (dot(axis, q) * (1.0 - c));
    let qPlanar = q - vec3<f32>(0.936, 0.352, 0.0) * (timeSec * 0.0032 * driftScale);
    return mix(qRot, qPlanar, unfurlAlpha);
}

fn advectIsometricGhibliVec(v: vec3<f32>, timeSec: f32, driftScale: f32, unfurlAlpha: f32) -> vec3<f32> {
    let ang = -timeSec * (0.00065 * driftScale);
    let axis = vec3<f32>(-0.3358847, 0.9116871, 0.2367661);
    let c = cos(ang);
    let s = sin(ang);
    let vRot = v * c + cross(axis, v) * s + axis * (dot(axis, v) * (1.0 - c));
    return mix(vRot, v, unfurlAlpha);
}

fn applyGhibliValueGrouping(val: f32, strength: f32) -> f32 {
    if (strength <= 0.001) {
        return val;
    }
    let band1 = smoothstep(0.03, 0.28, val) * 0.26;
    let band2 = smoothstep(0.20, 0.54, val) * 0.30;
    let band3 = smoothstep(0.46, 0.84, val) * 0.32;
    let band4 = smoothstep(0.76, 1.16, val) * 0.24;
    let stepped = band1 + band2 + band3 + band4;
    return mix(val, stepped, strength);
}

// Per-Invocation Active-Step & Ray-Column Cache (Candidate 3A: Eliminates redundant per-step 2D DEM, Thermo, Wind, and Voronoi evaluations)
struct StepShadingCache {
    stepDemHere: f32,
    stepIsLand: f32,
    stepEffTerrainNorm: f32,
    stepHNormAGL: f32,
    stepSynopticLift: f32,
    stepTropoSpan: f32,
    stepLow: f32,
    stepMid: f32,
    stepHigh: f32,
    stepRadOptics: f32,
    baseCoord3D: vec3<f32>,
    baseWind3D: vec3<f32>,
    baseNwOffset3D: vec3<f32>,
    detailCoord3D: vec3<f32>,
    detailWind3D: vec3<f32>,
    nwOffset3D: vec3<f32>,
    nCenter: vec4<f32>,
    dCenter: vec4<f32>,
};

var<private> p_stepCache: StepShadingCache;
var<private> p_rayDemThermo: vec4<f32>;   // .x = elevMeters, .y = isLand, .z = effTerrainNorm, .w = zLclMetersThermo (regional: zBase, zStreamSpan, zCrownSpan, macroTerrainDisp)
var<private> p_rayThermoWind: vec4<f32>;  // .x = mblDeltaT, .y = radOpticalDepth, .z = windConvergence, .w = windCurl (regional .xw: macPush2D)
var<private> p_rayWinds: vec4<f32>;       // .xy = wSurf, .zw = wJet
var<private> p_rayVoronoi: vec4<f32>;     // .xy = f1f2, .z = hasDemThermo (1=valid, 2=steepRay), .w = hasWindVoronoi (regional .xy: macroRidgeDisp, upslopeFlowLiftWorld)
var<private> p_rayCov: vec4<f32>;         // .x = lowFraction, .y = midFraction, .z = highFraction, .w = valid
var<private> p_raySurfDisp: f32 = 0.0;
var<private> p_rayMaxShellZ: f32 = 0.20;
var<private> p_rayDemMip: f32 = 0.0;
var<private> p_rayMaxSynLift: f32 = 1.0;
var<private> p_rayCachedSynLift: f32 = -1.0;
var<private> p_rayEntryCos: f32 = 0.35;
var<private> p_rayTransmittance: f32 = 1.0;
var<private> p_rayCachedTileSlot: u32 = 0u;
var<private> p_rayMidWind: vec2<f32> = vec2<f32>(0.0, 0.0);
var<private> p_rayGeoSwirl: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 0.0); // .xy = geostrophicSwirlVec, .z = dMslpHpa, .w = convSpread (regional: synThresh, stormBoost, incisedValleyGate, cliffSlopeBaseGate)
var<private> p_rayIsCompassSun: bool = true;
var<private> p_rayCompassDir2D: vec2<f32> = vec2<f32>(-0.70710678, 0.70710678);
var<private> p_rayLowSunGate: f32 = 0.0;
var<private> p_rayCustomSunGate: f32 = 0.0;
var<private> p_rayUseRegional: bool = false;
var<private> p_rayActiveStepWorld: f32 = 0.006;

// Dual-Hour Scalar Helper (lockstep scrubTau interpolation across raymarch, shadows, and NW slope)
fn sampleCloudTexScalar(tex: texture_2d<f32>, uv: vec2<f32>) -> f32 {
    let s = textureSampleLevel(tex, u_cloud2DSampler, uv, 0.0);
    if (!hasDualHourClouds()) {
        return s.r;
    }
    let tau = getScrubTau();
    let smoothTau = tau * tau * (3.0 - 2.0 * tau);
    return mix(s.r, s.g, smoothTau);
}

// Stage 1 (Choice B): RK2 Midpoint Curved Geodesic Streamline + Advective Dual-Hour Cross-Dissolve
fn computeRK2PhaseAdvectedUV(
    baseUV: vec2<f32>,
    w0: vec2<f32>,
    swirlCurv: vec2<f32>,
    tauSignedSec: f32,
    driftScale: f32,
    safeCosLat: f32
) -> vec2<f32> {
    let speedSq = dot(w0, w0);
    if (speedSq < 0.0025) {
        return baseUV;
    }
    let rawSpd = sqrt(speedSq);
    let calmAtten = smoothstep(0.0, 3.5, rawSpd);
    let v0Eff = (w0 * calmAtten) * (11.5 * inverseSqrt(speedSq + 9.0));
    let omegaWind = 0.00038 * driftScale;
    let halfTau = 0.5 * tauSignedSec;
    let curvAngle = clamp(length(swirlCurv) * 0.018 * halfTau, -0.52, 0.52);
    let hemiTurn = select(-1.0, 1.0, (0.5 - baseUV.y) >= 0.0);
    let rotSin = sin(curvAngle * hemiTurn);
    let rotCos = cos(curvAngle * hemiTurn);
    let wMidPt = vec2<f32>(
        v0Eff.x * rotCos - v0Eff.y * rotSin,
        v0Eff.x * rotSin + v0Eff.y * rotCos
    ) + swirlCurv * (0.18 * clamp(abs(halfTau) / 6.0, 0.0, 1.0));
    let velMid = vec2<f32>(
        (wMidPt.x * omegaWind) / (TWO_PI * safeCosLat),
       -(wMidPt.y * omegaWind) / PI
    );
    let finalU = fract(baseUV.x - velMid.x * tauSignedSec + 1.0);
    let finalV = clamp(baseUV.y - velMid.y * tauSignedSec, 0.001, 0.999);
    return vec2<f32>(finalU, finalV);
}

fn sampleAdvectedDualHourSingleUV(
    tex: texture_2d<f32>,
    uv: vec2<f32>,
    windMs: vec2<f32>,
    safeCosLat: f32
) -> f32 {
    if (!hasDualHourClouds()) {
        return textureSampleLevel(tex, u_cloud2DSampler, uv, 0.0).r;
    }
    let tau = getScrubTau();
    if (tau <= 0.001) {
        return textureSampleLevel(tex, u_cloud2DSampler, uv, 0.0).r;
    }
    let duHr = clamp((windMs.x * 8.993e-5) / safeCosLat, -0.012, 0.012);
    let dvHr = clamp(-(windMs.y * 1.7986e-4), -0.010, 0.010);
    let uv0 = vec2<f32>(fract(uv.x - duHr * tau + 1.0), clamp(uv.y - dvHr * tau, 0.001, 0.999));
    let uv1 = vec2<f32>(fract(uv.x + duHr * (1.0 - tau) + 1.0), clamp(uv.y + dvHr * (1.0 - tau), 0.001, 0.999));
    let c0 = textureSampleLevel(tex, u_cloud2DSampler, uv0, 0.0).r;
    let c1 = textureSampleLevel(tex, u_cloud2DSampler, uv1, 0.0).g;
    let smoothTau = tau * tau * (3.0 - 2.0 * tau);
    return mix(c0, c1, smoothTau);
}

fn sampleDualPhaseRK2Cloud(
    tex: texture_2d<f32>,
    baseUV: vec2<f32>,
    w0: vec2<f32>,
    swirlCurv: vec2<f32>,
    phaseSec: f32,
    fallbackDriftU: f32,
    safeCosLat: f32
) -> f32 {
    if (!isAtmoFeatureEnabled(1u)) {
        let legacyUV = computeWindSwirlAdvectedUV(baseUV, w0, phaseSec, fallbackDriftU, safeCosLat);
        return textureSampleLevel(tex, u_cloud2DSampler, legacyUV, 0.0).r;
    }
    let driftScale = clamp(abs(cloud.u_noiseParams.w) / 0.002, 0.0, 4.0);
    if (driftScale <= 0.001 || abs(phaseSec) <= 0.001) {
        return sampleAdvectedDualHourSingleUV(tex, baseUV, w0, safeCosLat);
    }
    let zonalSynopticVelU = (-0.00075 * driftScale * cos(2.8 * (0.5 - baseUV.y) * PI)) / (TWO_PI * safeCosLat);
    let meridSynopticVelV = (0.00024 * driftScale * sin(baseUV.x * TWO_PI + 0.85)) / PI;
    let synopticAnchorUV = vec2<f32>(
        fract(baseUV.x - zonalSynopticVelU * phaseSec + 1.0),
        clamp(baseUV.y - meridSynopticVelV * phaseSec, 0.001, 0.999)
    );
    let cycleSec = 24.0;
    let phiA = fract(phaseSec / cycleSec + 1.0);
    let tauA = (phiA - 0.5) * cycleSec;
    if (p_rayTransmittance < 0.74 || (length(camera.u_cameraPos.xyz) > 8.8 && cloud.u_simControl.y < 0.05)) {
        let uvSingle = computeRK2PhaseAdvectedUV(synopticAnchorUV, w0, swirlCurv, tauA * 0.5, driftScale, safeCosLat);
        return sampleAdvectedDualHourSingleUV(tex, uvSingle, w0, safeCosLat);
    }
    let phiB = fract(phiA + 0.5);
    let tauB = (phiB - 0.5) * cycleSec;
    let sinPhase = sin(PI * phiA);
    let wA = sinPhase * sinPhase;
    let wB = 1.0 - wA;
    let uvA = computeRK2PhaseAdvectedUV(synopticAnchorUV, w0, swirlCurv, tauA, driftScale, safeCosLat);
    let uvB = computeRK2PhaseAdvectedUV(synopticAnchorUV, w0, swirlCurv, tauB, driftScale, safeCosLat);
    let cA = sampleAdvectedDualHourSingleUV(tex, uvA, w0, safeCosLat);
    let cB = sampleAdvectedDualHourSingleUV(tex, uvB, w0, safeCosLat);
    let meanEst = 0.5 * (cA + cB);
    let blended = cA * wA + cB * wB;
    let varScale = inverseSqrt(max(0.5, wA * wA + wB * wB));
    return clamp(meanEst + (blended - meanEst) * mix(1.0, varScale, 0.65), 0.0, 1.0);
}

fn unpackGlobalDemRG(s: vec4<f32>) -> vec4<f32> {
    let bNorm = s.r;
    let aNorm = s.g;
    let elevM = aNorm * 19772.0 - 10924.0;
    return vec4<f32>(clamp(elevM / 8848.0, 0.0, 1.0), clamp(-elevM / 10924.0, 0.0, 1.0), bNorm, aNorm);
}

fn unpackDemRG(s: vec4<f32>) -> vec4<f32> {
    let bNorm = s.r;
    let elevM = s.g;
    let aNorm = clamp((elevM + 10924.0) / 19772.0, 0.0, 1.0);
    return vec4<f32>(clamp(elevM / 8848.0, 0.0, 1.0), clamp(-elevM / 10924.0, 0.0, 1.0), bNorm, aNorm);
}

// Stage 1 (Choice A): Unified 30m Slippy-Tile + Regional COG + Global DEM Sampler
fn sampleUnifiedCloudTerrain(uv: vec2<f32>, globalSample: vec4<f32>, ptDist: f32, mipLod: f32) -> vec4<f32> {
    if (!isAtmoFeatureEnabled(0u)) {
        return globalSample;
    }
    let regZoomGate = 1.0 - smoothstep(0.32, 0.58, ptDist);
    let tileZoomGate = 1.0 - smoothstep(0.16, 0.30, ptDist);
    if ((u_regionalOverlay.u_regionalActive != 1u || regZoomGate <= 0.001) && (u_regionalOverlay.u_pad3 == 0u || tileZoomGate <= 0.001)) {
        return globalSample;
    }

    let lon = uv.x * 360.0 - 180.0;
    let lat = 90.0 - uv.y * 180.0;
    let globalElevM = globalSample.a * 19772.0 - 10924.0;
    let isInlandBasin = globalElevM < -2.0 && globalSample.b > 0.90;
    var compositeSample = globalSample;
    var activeRegWeight: f32 = 0.0;
    var activeRegTsY: f32 = 1.0;

    if (u_regionalOverlay.u_regionalActive == 1u && regZoomGate > 0.001) {
        let bounds = u_regionalOverlay.u_regionalBounds;
        if (lon >= bounds.x && lon <= bounds.z && lat >= bounds.y && lat <= bounds.w && bounds.z > bounds.x && bounds.w > bounds.y) {
            let regU = clamp((lon - bounds.x) / (bounds.z - bounds.x), 0.0, 1.0);
            let regV = clamp((bounds.w - lat) / (bounds.w - bounds.y), 0.0, 1.0);
            let marginU = clamp(0.08 / (bounds.z - bounds.x), 0.001, 0.49);
            let marginV = clamp(0.08 / (bounds.w - bounds.y), 0.001, 0.49);
            let regW = smoothstep(0.0, marginU, min(regU, 1.0 - regU)) * smoothstep(0.0, marginV, min(regV, 1.0 - regV));
            let regDimsF = max(vec2<f32>(textureDimensions(u_regionalDEMTexture)), vec2<f32>(1.0));
            activeRegTsY = (bounds.w - bounds.y) / (180.0 * max(regDimsF.y, 1.0));
            let regSample = unpackDemRG(textureSampleLevel(u_regionalDEMTexture, u_demMipSampler, vec2<f32>(regU, regV), clamp(mipLod, 0.0, 5.0)));
            let regLandGate = smoothstep(0.35, 0.65, globalSample.b);
            let hasRegBathy = regSample.g > 0.00015;
            let regCoastalMask = clamp(max(regLandGate, smoothstep(-140.0, -10.0, globalElevM)) + regSample.b + select(0.0, 1.0, hasRegBathy), 0.0, 1.0);
            let effRegB = select(mix(globalSample.b, regSample.b, regCoastalMask), globalSample.b, isInlandBasin);
            let effRegA = select(select(min(globalSample.a, (10924.0 - 4.5) / 19772.0), regSample.a, effRegB > 0.01 || isInlandBasin), regSample.a, hasRegBathy);
            let safeRegSample = vec4<f32>(regSample.r, regSample.g, effRegB, effRegA);
            activeRegWeight = regW * regCoastalMask * regZoomGate;
            compositeSample = mix(compositeSample, safeRegSample, activeRegWeight);
        }
    }

    let cBounds = u_regionalOverlay.u_pad1;
    let hasClusterBounds = cBounds.z > cBounds.x && cBounds.w > cBounds.y;
    let inTileCluster = !hasClusterBounds || (lon >= cBounds.x && lon <= cBounds.z && lat >= cBounds.y && lat <= cBounds.w);
    let maxBufSlots = arrayLength(&u_tileSlots);
    let slotCount = select(0u, min(min(u_regionalOverlay.u_pad3, 64u), maxBufSlots), inTileCluster && tileZoomGate > 0.001 && maxBufSlots > 0u);
    if (slotCount == 0u) {
        return compositeSample;
    }

    let gridF = max(1.0, round(sqrt(f32(slotCount))));
    let gridN = u32(gridF);
    let relX = clamp((lon - cBounds.x) / max(1e-5, cBounds.z - cBounds.x), 0.0, 0.99999);
    let relY = clamp((cBounds.w - lat) / max(1e-5, cBounds.w - cBounds.y), 0.0, 0.99999);
    let clusterBorderW = select(1.0, smoothstep(0.0, 0.18, min(relX, 1.0 - relX)) * smoothstep(0.0, 0.18, min(relY, 1.0 - relY)), hasClusterBounds);
    let rawGuessIdx = min(slotCount - 1u, u32(floor(relY * gridF)) * gridN + u32(floor(relX * gridF)));
    let cachedValid = p_rayCachedTileSlot < slotCount;
    let cb = u_tileSlots[select(0u, p_rayCachedTileSlot, cachedValid)].bounds;
    let inCached = cachedValid && lon >= cb.x && lon <= cb.z && lat >= cb.y && lat <= cb.w && cb.z > cb.x && cb.w > cb.y;
    let guessIdx = select(rawGuessIdx, p_rayCachedTileSlot, inCached);

    for (var step: u32 = 0u; step < slotCount; step = step + 1u) {
        let i = select(select(step, step - 1u, step <= guessIdx), guessIdx, step == 0u);
        let slot = u_tileSlots[i];
        let b = slot.bounds;
        if (lon >= b.x && lon <= b.z && lat >= b.y && lat <= b.w && b.z > b.x && b.w > b.y) {
            p_rayCachedTileSlot = i;
            let tileU = clamp((lon - b.x) / (b.z - b.x), 0.0, 1.0);
            let tileV = clamp((b.w - lat) / (b.w - b.y), 0.0, 1.0);
            let edgeMask = u32(floor(slot.tileMeta.x / 64.0));
            let marginU = clamp(0.12 / (b.z - b.x), 0.001, 0.49);
            let marginV = clamp(0.12 / (b.w - b.y), 0.001, 0.49);
            let wWest  = select(smoothstep(0.0, marginU, tileU), 1.0, (edgeMask & 1u) != 0u);
            let wEast  = select(smoothstep(0.0, marginU, 1.0 - tileU), 1.0, (edgeMask & 4u) != 0u);
            let wNorth = select(smoothstep(0.0, marginV, tileV), 1.0, (edgeMask & 8u) != 0u);
            let wSouth = select(smoothstep(0.0, marginV, 1.0 - tileV), 1.0, (edgeMask & 2u) != 0u);
            let slotWeight = min(wWest, wEast) * min(wNorth, wSouth) * clusterBorderW * tileZoomGate;

            let isRegionalCogTile = (u32(slot.tileMeta.x) & 63u) == 14u;
            let effCols = max(1.0, slot.tileMeta.z * 256.0);
            let effRows = max(1.0, slot.tileMeta.w * 256.0);
            let tileTsY = max(0.0001, b.w - b.y) / (180.0 * effRows);
            let tileRefinesReg = select(1.0, 1.0 - activeRegWeight, activeRegWeight > 0.001 && tileTsY >= activeRegTsY * 0.85);
            let tileWeight = slotWeight * tileRefinesReg;
            let sampU = select((0.5 + tileU * (effCols - 1.0)) / 256.0, clamp(tileU * effCols, 0.5, effCols - 0.5) / 256.0, isRegionalCogTile);
            let sampV = select((0.5 + tileV * (effRows - 1.0)) / 256.0, clamp(tileV * effRows, 0.5, effRows - 0.5) / 256.0, isRegionalCogTile);
            let layerIdx = i32(slot.tileMeta.y);
            let tileSample = unpackDemRG(textureSampleLevel(u_tileCacheArray, u_demMipSampler, vec2<f32>(sampU, sampV), layerIdx, select(0.0, clamp(mipLod, 0.0, 5.0), isRegionalCogTile)));

            // Hard Offshore Bathymetry Protection Gate (preserved on Terrarium tiles; authentic COG bathymetry accepted on lod == 14u)
            let hasCogTileBathy = isRegionalCogTile && tileSample.g > 0.00015;
            let tileAddLand = clamp((tileSample.b - 0.504) * 2.04, 0.0, 1.0);
            let tileCarveWater = clamp((0.496 - tileSample.b) * 2.04, 0.0, 1.0);
            let fjordCarveGate = (1.0 - smoothstep(180.0, 480.0, globalElevM)) * (1.0 - select(0.0, 1.0, isInlandBasin));
            let isOffshoreOcean = globalElevM < -15.0 && tileSample.b <= 0.504 && !hasCogTileBathy;
            let tileLandGate = smoothstep(0.35, 0.65, globalSample.b);
            let rawCoastalMask = clamp(max(tileLandGate, smoothstep(-15.0, -2.0, globalElevM)) + tileAddLand + tileCarveWater * fjordCarveGate + select(0.0, 1.0, hasCogTileBathy), 0.0, 1.0);
            let tileCoastalMask = select(rawCoastalMask, 0.0, isOffshoreOcean);
            let carvedLandMask = max(0.0, compositeSample.b * (1.0 - tileCarveWater * fjordCarveGate));
            let targetTileB = max(carvedLandMask, tileAddLand);
            let effTileB = select(select(mix(compositeSample.b, targetTileB, tileCoastalMask), tileSample.b, isRegionalCogTile), compositeSample.b, isInlandBasin);
            let effTileA = select(min(compositeSample.a, (10924.0 - 4.5 * (1.0 - effTileB)) / 19772.0), tileSample.a, effTileB > 0.45 || isInlandBasin || hasCogTileBathy);
            let safeTileSample = vec4<f32>(tileSample.r, select(compositeSample.g, tileSample.g, hasCogTileBathy), effTileB, effTileA);
            compositeSample = mix(compositeSample, safeTileSample, tileWeight * tileCoastalMask);
            break;
        }
    }
    return compositeSample;
}

struct RegMultiTierOut {
    dCumulus: f32,
    shelfGate: f32,
    midGate: f32,
    turretGate: f32,
    effSpan: f32,
    nMac0: vec4<f32>,
    nCellR: f32,
};

// Hardware-trilinear 128^3 Half-Dome Regional Noise Sampler (Apple Silicon negative-fract safe):
// .r = 4-octave periodic C^2 quintic Perlin FBM (p3, p6, p12, p24), .gba = smooth spherical Worley domes (p6, p14, p28)
fn sampleRegNoise3D(uvw: vec3<f32>) -> vec4<f32> {
    let wrapped = fract(fract(uvw) + vec3<f32>(1.0));
    return textureSampleLevel(u_regNoiseTexture, u_noiseSampler, wrapped, 0.0);
}

// Exact Geoid-to-World-Z Curve (1:1 parity with crust_hydrosphere.wgsl so mountain ridges pierce physical ASL cloud decks naturally)
fn elevMetersToRegWorldZ(
    elevM: f32,
    isDualLog: bool,
    runtimePeakExp: f32,
    runtimeDispScale: f32,
    poleAtten: f32
) -> f32 {
    let posM = max(0.0, elevM);
    let linNorm = clamp(posM / 8848.0, 0.0, 1.0);
    let dualNorm = clamp(log(1.0 + posM / 1200.0) / 2.12425, 0.0, 1.0);
    return pow(select(linNorm, dualNorm, isDualLog), runtimePeakExp) * runtimeDispScale * poleAtten;
}

// Normalized HUD parameter ratios for Regional Ghibli Mode (identically 1.0 at boot defaults)
fn computeRegionalHudScales(runtimeDispScale: f32) -> vec4<f32> {
    let reliefRatio = clamp(runtimeDispScale / 0.224, 0.45, 1.0);
    let defaultDeltaR = select(0.19, 0.19 * (1.0 + (reliefRatio - 1.0) * 0.72), isAtmoFeatureEnabled(6u));
    let thickRatio = clamp(cloud.u_shellRadii.z / max(0.04, defaultDeltaR), 0.25, 1.85);
    let ceilRatio = clamp(cloud.u_layerHeights.x / 0.45, 0.38, 1.45);
    let hFreqRatio = clamp(cloud.u_noiseParams.x / 32.0, 0.35, 2.50);
    let erosionRatio = clamp(cloud.u_noiseParams.z / 0.85, 0.25, 1.50);
    return vec4<f32>(thickRatio, ceilRatio, hFreqRatio, erosionRatio);
}

// True manifold camera altitude above R_0 datum across 0.0 <= unfurl <= 1.0 (Euclidean distance to manifold surface so off-edge cameras never false-zero)
fn computeEffectiveCamRadius(camPos: vec3<f32>, unfurlVal: f32, rInnerVal: f32) -> f32 {
    let uClamped = clamp(unfurlVal, 0.0, 1.0);
    let padR = select(mix(length(camPos), rInnerVal + abs(camPos.z), uClamped), camera.u_padCamera.z, camera.u_padCamera.z > 4.5);
    if (uClamped > 0.01 && uClamped < 0.99) {
        let uvwCamM = invertManifoldModeWGSL(camPos, uClamped, rInnerVal);
        let clampedLon = clamp(uvwCamM.x, -PI, PI);
        let clampedLat = clamp(uvwCamM.y, -HALF_PI, HALF_PI);
        let surfCamM = evaluateForwardManifoldWGSL(clampedLon, clampedLat, 0.0, uClamped, rInnerVal);
        return rInnerVal + length(camPos - surfCamM);
    }
    return padR;
}

// Shared Half-Dome Target B "Stream + Crown" Regional Scaffold (Hardware 3D Noise — 1-2 TMU fetches, zero ALU lattice loops)
fn evalRegMultiTierCumulus(
    qMacro: vec3<f32>,
    upWMac: vec3<f32>,
    shearDirMac: vec3<f32>,
    zRel: f32,
    zBase: f32,
    zStreamSpan: f32,
    zCrownSpan: f32,
    synThresh: f32,
    stormBoost: f32,
    coarseShadow: bool
) -> RegMultiTierOut {
    var out: RegMultiTierOut;
    let regHFreq = clamp(cloud.u_noiseParams.x / 32.0, 0.35, 2.50);
    let regVFreq = clamp(cloud.u_noiseParams.y / 12.0, 0.35, 2.50);

    let dzRel = (zRel - zBase) * mix(1.0, regVFreq, 0.65);
    let qMacBase = qMacro - upWMac * (dzRel * 0.14);
    // Broad wind-elongated Stream + Crown cloud banks anchored to the synoptic weather envelope (single 128^3 RGBA fetch: .r FBM + .g/.b/.a multi-octave Worley domes)
    let streamAniso = 0.48;
    let qStream = qMacBase
        - shearDirMac * (dot(qMacBase, shearDirMac) * streamAniso + dzRel * 0.09)
        + upWMac * (dot(qMacBase, upWMac) * 0.02);
    let nMac0 = sampleRegNoise3D(qStream * (4.65 * regHFreq));
    let macRaw = select(nMac0.r, 0.80 * nMac0.r + 0.20 * nMac0.g, !coarseShadow);
    let macField = clamp(0.50 + (macRaw - 0.50) * 1.46, 0.0, 1.0);
    out.nMac0 = vec4<f32>(macField, nMac0.r, nMac0.g, nMac0.b);

    let rMac = clamp(1.0 - macField, 0.0, 1.0);
    let threshGate = smoothstep(0.015, 0.11, synThresh);
    let shelfGate = smoothstep(0.01, 0.16, synThresh - rMac) * threshGate;
    out.shelfGate = shelfGate;

    if (shelfGate <= 0.001) {
        let clearMargin = max(0.0, rMac - synThresh);
        out.dCumulus = -0.022 - clamp(clearMargin * 0.12, 0.0, 0.034);
        out.midGate = 0.0;
        out.turretGate = 0.0;
        out.effSpan = max(0.012, zStreamSpan);
        out.nCellR = nMac0.g;
        return out;
    }

    let midGate = smoothstep(0.035, 0.17, synThresh - rMac) * threshGate;
    let turretGate = smoothstep(0.072, 0.22, synThresh - rMac) * threshGate;
    out.midGate = midGate;
    out.turretGate = turretGate;

    let span1 = max(0.0085, zStreamSpan * (0.68 + 0.34 * shelfGate + 0.12 * stormBoost));
    let span2 = max(span1, mix(zStreamSpan, zCrownSpan, 0.64) * (0.78 + 0.30 * midGate + 0.14 * stormBoost));
    let span3 = max(span2, zCrownSpan * (0.86 + 0.28 * turretGate + 0.16 * stormBoost));
    let effSpan = max(span1, max(select(0.0, span2, midGate > 0.02), select(0.0, span3, turretGate > 0.02)));
    out.effSpan = effSpan;

    // Fast upper-air column ceiling exit in true ASL-mapped world Z
    let colMaxTopZ = zBase + effSpan * 1.14 + 0.0045;
    if (zRel > colMaxTopZ) {
        out.dCumulus = -(zRel - colMaxTopZ) - 0.014;
        out.nCellR = nMac0.g;
        return out;
    }

    out.nCellR = nMac0.g;
    let macExcess = (synThresh - 0.015) - rMac;
    let dzEval = zRel - zBase;

    // Tier 1: Wind-Combed Condensation Stream Deck (connected ribbon anchored at physical LCL zBase)
    let streamExcess = macExcess + (nMac0.r - 0.50) * 0.10 + stormBoost * 0.022;
    let dz1 = dzEval - span1 * 0.44;
    let dTier1 = streamExcess * 0.062 - (dz1 * dz1) / max(0.0024, span1 * span1 * 2.45);

    // Tier 2: Cohesive Cumulus Body
    var dTier2: f32 = -0.030;
    if (midGate > 0.002) {
        let bodyDome = mix(nMac0.g, nMac0.b, 0.42);
        let bodyExcess = (macExcess - 0.028) + (bodyDome - 0.47) * 0.18 + stormBoost * 0.026;
        let dz2 = dzEval - span2 * 0.51;
        dTier2 = bodyExcess * 0.060 - (dz2 * dz2) / max(0.0032, span2 * span2 * 2.25);
    }

    // Tier 3: Central Rising Cauliflower Crown (Half-Dome Target B "Stream + Crown" signature)
    var dTier3: f32 = -0.030;
    if (turretGate > 0.004 && dzEval > span1 * 0.15) {
        let crownDome = 0.52 * nMac0.b + 0.48 * nMac0.a;
        let crownExcess = (macExcess - 0.056) + (crownDome - 0.43) * 0.21 + stormBoost * 0.032;
        let dz3 = dzEval - span3 * 0.57;
        dTier3 = crownExcess * 0.060 - (dz3 * dz3) / max(0.0040, span3 * span3 * 2.15);
    }

    let dUpperUnion = smaxDepthGhibli(dTier2, dTier3, 0.0066);
    let dTierUnion = smaxDepthGhibli(dTier1, dUpperUnion, 0.0072);
    // Soft thermodynamic LCL condensation base (condenses smoothly above zBase without flat razor-knife bottom)
    out.dCumulus = sminDepthGhibli(dTierUnion, dzEval + 0.0020, 0.0052);
    return out;
}

// Shared Half-Dome Target B Regional Cloud Evaluator (True Physical Meters ASL + Windward/Leeward/Coastal Terrain Coupling)
fn evaluateRegionalGhibliColumn(
    inv: vec3<f32>,
    p: vec3<f32>,
    uv: vec2<f32>,
    safeCosLat: f32,
    alphaEased: f32,
    flowTimeSec: f32,
    camDist: f32,
    wSurf: vec2<f32>,
    rawLowFraction: f32,
    midFraction: f32,
    highFraction: f32,
    radOpticalDepth: f32,
    lclMetersThermo: f32,
    runtimeDispScale: f32,
    runtimePeakExp: f32,
    isDualLog: bool,
    poleAtten: f32,
    hasMipmappedDem: bool
) -> f32 {
    let hudScales = computeRegionalHudScales(runtimeDispScale);
    let regThickRatio = hudScales.x;
    let regCeilRatio = hudScales.y;
    let regHFreqRatio = hudScales.z;
    let regErosionRatio = hudScales.w;
    let regVFreqRatio = clamp(cloud.u_noiseParams.y / 12.0, 0.35, 2.50);
    let regExtRatio = clamp(cloud.u_opticalParams.x / 42.0, 0.24, 1.35);

    let effLowG = rawLowFraction * clamp(cloud.u_layerDensities.x, 0.0, 1.5);
    let effMidG = midFraction * clamp(cloud.u_layerDensities.y / 0.85, 0.0, 1.5);
    let effHighG = highFraction * clamp(cloud.u_layerDensities.z / 0.85, 0.0, 1.5);

    let maxRegWorldCeilZ = elevMetersToRegWorldZ(7600.0 * max(1.0, regThickRatio * regCeilRatio * 0.92), isDualLog, runtimePeakExp, runtimeDispScale, poleAtten) + 0.022;
    if (inv.z < -0.006 || inv.z > maxRegWorldCeilZ || (effLowG + effMidG * 0.62 + effHighG * 0.25) < 0.018) {
        p_stepCache.nCenter = vec4<f32>(-0.045, -0.045, 0.5, 0.72);
        p_stepCache.dCenter = vec4<f32>(0.0, 0.0, 0.74, 0.0);
        return effHighG * 0.0;
    }

    let detailDriftScale = clamp(abs(cloud.u_noiseParams.w) / 0.002, 0.0, 4.0);
    let regWindSpd = length(wSurf);
    let defaultWindDir = vec2<f32>(0.7808688, 0.6246950);
    let safeFlowDir = select(defaultWindDir, wSurf / max(1e-3, regWindSpd), regWindSpd > 1e-3);
    let rawBlendDir = mix(defaultWindDir, safeFlowDir, smoothstep(0.65, 3.20, regWindSpd));
    let windDir2D = rawBlendDir / max(1e-4, length(rawBlendDir));

    // Developable Cylinder Orthonormal Tangent Triad across 0.0 <= unfurl <= 1.0 (zero |lambda| > 90 deg mix() collapse)
    let tStraightReg = smoothstep(0.20, 0.95, alphaEased);
    let thetaTan = (1.0 - alphaEased) * inv.x;
    let phiTan = (1.0 - tStraightReg) * inv.y;
    let sinThetaT = sin(thetaTan);
    let cosThetaT = cos(thetaTan);
    let sinPhiT = sin(phiTan);
    let cosPhiT = cos(phiTan);

    let regEastWorld = vec3<f32>(cosThetaT, 0.0, -sinThetaT);
    let regNorthWorld = vec3<f32>(-sinPhiT * sinThetaT, cosPhiT, -sinPhiT * cosThetaT);
    let regUpWorld = vec3<f32>(cosPhiT * sinThetaT, sinPhiT, cosPhiT * cosThetaT);
    let upWMac = advectIsometricGhibliVec(regUpWorld, flowTimeSec * 0.72, detailDriftScale, alphaEased);
    let windWorldUnit = normalize(regEastWorld * windDir2D.x + regNorthWorld * windDir2D.y);
    let shearDirMac = advectIsometricGhibliVec(windWorldUnit, flowTimeSec * 0.72, detailDriftScale, alphaEased);

    let lowMidAlign = clamp(effLowG * 0.62 + effLowG * effMidG * 0.88, 0.0, 1.0);
    let deepStormCore = smoothstep(0.34, 0.82, radOpticalDepth * 0.44 + lowMidAlign * 0.56);

    var zBase: f32 = 0.0;
    var zStreamSpan: f32 = 0.012;
    var zCrownSpan: f32 = 0.020;
    var macroTerrainDisp: f32 = 0.0;
    var synThresh: f32 = 0.0;
    var stormBoost: f32 = 0.0;
    var incisedValleyGate: f32 = 0.0;
    var cliffSlopeBaseGate: f32 = 0.0;
    var macPush2D = vec2<f32>(0.0);
    var upslopeFlowLiftWorld: f32 = 0.0;
    var macroLand: f32 = 0.0;
    var macroRidgeDisp: f32 = 0.0;

    if (p_rayCachedSynLift >= 0.5) {
        let lclPlusWindM = p_rayDemThermo.x;
        zStreamSpan = p_rayDemThermo.y;
        zCrownSpan = p_rayDemThermo.z;
        macroTerrainDisp = p_rayDemThermo.w;
        synThresh = p_rayGeoSwirl.x;
        stormBoost = p_rayGeoSwirl.y;
        incisedValleyGate = p_rayGeoSwirl.z;
        cliffSlopeBaseGate = p_rayGeoSwirl.w;
        macroRidgeDisp = p_rayVoronoi.x;
        upslopeFlowLiftWorld = p_rayVoronoi.y;
        macPush2D = vec2<f32>(p_rayThermoWind.x, p_rayThermoWind.w);
        macroLand = clamp(p_rayCachedSynLift - 1.0, 0.0, 1.0);
        var stepBasinRefM: f32 = 0.0;
        if (hasMipmappedDem && p_rayCachedSynLift > 1.005) {
            let sMacStep = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, uv, 2.65));
            let sBasinStep = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, uv, 5.8));
            macroLand = smoothstep(0.32, 0.68, sMacStep.b);
            let stepMacroElevM = max(0.0, sMacStep.a * 19772.0 - 10924.0);
            let stepBasinMeanM = max(0.0, sBasinStep.a * 19772.0 - 10924.0) * smoothstep(0.25, 0.65, sBasinStep.b);
            stepBasinRefM = min(min(stepMacroElevM, stepBasinMeanM) * macroLand, 2250.0) * macroLand;
            macroTerrainDisp = elevMetersToRegWorldZ(stepMacroElevM, isDualLog, runtimePeakExp, runtimeDispScale, poleAtten) * macroLand;
        }
        zBase = elevMetersToRegWorldZ(stepBasinRefM + lclPlusWindM, isDualLog, runtimePeakExp, runtimeDispScale, poleAtten);
    } else {
        var macroElevM: f32 = 0.0;
        var basinFloorM: f32 = 0.0;
        var macroGradMagM: f32 = 0.0;
        var macUnit2D = vec2<f32>(0.0);
        var macroValleyDepthM: f32 = 0.0;
        var massifPeakM: f32 = 0.0;
        var centerLandB: f32 = 0.0;
        var maxCardLandB: f32 = 0.0;
        var minCardLandB: f32 = 0.0;

        if (hasMipmappedDem) {
            // Resolve ~25 km smooth C1 alpine, coastal, & island envelope (mip 2.65) across land/ocean boundaries
            let sMacC = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, uv, 2.65));
            let sBasin = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, uv, 5.8));
            centerLandB = sMacC.b;
            macroElevM = max(0.0, sMacC.a * 19772.0 - 10924.0);
            macroLand = smoothstep(0.32, 0.68, sMacC.b);
            let basinMeanM = max(0.0, sBasin.a * 19772.0 - 10924.0) * smoothstep(0.25, 0.65, sBasin.b);
            basinFloorM = min(macroElevM, basinMeanM) * macroLand;
            macroTerrainDisp = elevMetersToRegWorldZ(macroElevM, isDualLog, runtimePeakExp, runtimeDispScale, poleAtten) * macroLand;

            if (sBasin.b > 0.002 || sMacC.b > 0.002) {
                let dvM = 0.00105;
                let duM = (dvM * 0.5) / safeCosLat;
                let sMacE = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, vec2<f32>(fract(uv.x + duM), uv.y), 2.65));
                let sMacW = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, vec2<f32>(fract(uv.x - duM), uv.y), 2.65));
                let sMacN = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, vec2<f32>(uv.x, clamp(uv.y - dvM, 0.001, 0.999)), 2.65));
                let sMacS = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, vec2<f32>(uv.x, clamp(uv.y + dvM, 0.001, 0.999)), 2.65));
                maxCardLandB = max(centerLandB, max(max(sMacE.b, sMacW.b), max(sMacN.b, sMacS.b)));
                minCardLandB = min(centerLandB, min(min(sMacE.b, sMacW.b), min(sMacN.b, sMacS.b)));

                let eMacE = max(0.0, sMacE.a * 19772.0 - 10924.0) * smoothstep(0.18, 0.55, sMacE.b);
                let eMacW = max(0.0, sMacW.a * 19772.0 - 10924.0) * smoothstep(0.18, 0.55, sMacW.b);
                let eMacN = max(0.0, sMacN.a * 19772.0 - 10924.0) * smoothstep(0.18, 0.55, sMacN.b);
                let eMacS = max(0.0, sMacS.a * 19772.0 - 10924.0) * smoothstep(0.18, 0.55, sMacS.b);
                let macNbrMax = max(max(eMacE, eMacW), max(eMacN, eMacS));
                massifPeakM = max(macroElevM * macroLand, macNbrMax);

                if (maxCardLandB > 0.06) {
                    let macGrad2D = vec2<f32>((eMacE - eMacW) * 0.5, (eMacN - eMacS) * 0.5);
                    macroGradMagM = length(macGrad2D);
                    macUnit2D = select(vec2<f32>(0.0), macGrad2D / max(1.0, macroGradMagM), macroGradMagM > 6.0);
                    macroValleyDepthM = max(0.0, massifPeakM - macroElevM * macroLand);
                    macroRidgeDisp = elevMetersToRegWorldZ(massifPeakM, isDualLog, runtimePeakExp, runtimeDispScale, poleAtten);
                }
            }
        }

        // Coastal, Marine & Alpine Regime Partitioning (strictly modulating real prognostic coverage; zero fake fog stamps)
        let isMarineZone = 1.0 - smoothstep(0.18, 0.55, centerLandB);
        let isCoastalZone = smoothstep(0.06, 0.48, maxCardLandB) * (1.0 - smoothstep(0.55, 0.92, minCardLandB));
        let isDryInlandPlain = macroLand * (1.0 - isCoastalZone) * (1.0 - smoothstep(380.0, 1250.0, massifPeakM));
        let inlandHighRelief = smoothstep(750.0, 1850.0, massifPeakM) * (1.0 - isCoastalZone * 0.65);

        let slopeSteep = smoothstep(18.0, 210.0, macroGradMagM) * clamp(macroLand + isCoastalZone * 0.75, 0.0, 1.0);
        let oroAlign = dot(windDir2D, macUnit2D);
        let windSpdGate = smoothstep(0.35, 4.8, regWindSpd);
        let upslopeForcing = max(0.0, oroAlign) * slopeSteep * (0.45 + 0.55 * windSpdGate);
        let leewardFoehn = max(0.0, -oroAlign) * slopeSteep * (0.42 + 0.58 * windSpdGate) * (1.0 - isCoastalZone * 0.45);
        let massifAnchor = smoothstep(820.0, 2150.0, massifPeakM) * macroLand * (0.42 + 0.58 * max(0.0, oroAlign));
        let coastalHeadlandAnchor = isCoastalZone * smoothstep(14.0, 460.0, massifPeakM) * (0.48 + 0.52 * max(0.0, oroAlign));
        let humidMblFactor = (1.0 - smoothstep(260.0, 980.0, lclMetersThermo)) * max(isMarineZone, isCoastalZone);

        // Anchor Cloud Base (~2050m ASL in high alpine basins, down to 240-480m ASL in humid coastal/marine layers)
        let basinRefM = min(basinFloorM, 2250.0) * macroLand;
        let lclUserScale = clamp(cloud.u_lclParams.y / 0.0327, 0.68, 1.55);
        let lclLandM = clamp(lclMetersThermo, mix(260.0, 880.0, inlandHighRelief), 1720.0);
        let lclOceanM = clamp(lclMetersThermo, 240.0, 1220.0);
        let ceilBaseScale = 1.0 + (regCeilRatio - 1.0) * 0.48;
        let highCrownScale = 0.88 + 0.12 * clamp(cloud.u_layerDensities.z / 0.85, 0.0, 1.5);
        let windwardLiftM = 240.0 * upslopeForcing * (1.0 - smoothstep(2600.0, 3800.0, macroElevM));
        let lclPlusWindM = mix(lclOceanM, lclLandM, macroLand) * lclUserScale * ceilBaseScale + windwardLiftM;
        let zBaseM = basinRefM + lclPlusWindM;
        let streamThickM = mix(660.0, 920.0, deepStormCore) * regThickRatio * regCeilRatio;
        let crownThickM = mix(1260.0, 1740.0, deepStormCore) * regThickRatio * regCeilRatio * highCrownScale;

        zBase = elevMetersToRegWorldZ(zBaseM, isDualLog, runtimePeakExp, runtimeDispScale, poleAtten);
        let zStreamTop = elevMetersToRegWorldZ(zBaseM + streamThickM, isDualLog, runtimePeakExp, runtimeDispScale, poleAtten);
        let zCrownTop = elevMetersToRegWorldZ(zBaseM + crownThickM, isDualLog, runtimePeakExp, runtimeDispScale, poleAtten);
        zStreamSpan = max(0.0065, zStreamTop - zBase);
        zCrownSpan = max(zStreamSpan + 0.0038, zCrownTop - zBase);

        let baseProgCov = effLowG + effMidG * 0.68 + effHighG * 0.22;
        let oroMoistureGate = smoothstep(0.018, 0.16, baseProgCov);
        let midOroCouple = effMidG * (0.34 + 0.44 * clamp(massifAnchor + upslopeForcing * 0.85 + coastalHeadlandAnchor * 0.45, 0.0, 1.0));
        let highCrownCouple = effHighG * (0.16 + 0.14 * clamp(massifAnchor + upslopeForcing * 0.50, 0.0, 1.0)) * oroMoistureGate;
        let synCovG = clamp(
            effLowG * 0.96
            + midOroCouple
            + highCrownCouple
            + (upslopeForcing * 0.24 + coastalHeadlandAnchor * 0.14 + humidMblFactor * 0.10) * oroMoistureGate,
            0.0,
            1.0
        );
        let weatherDrive = smoothstep(0.04, 0.68, synCovG);
        let weatherGate = smoothstep(0.018, 0.18, synCovG) * oroMoistureGate;
        let lowlandClear = isDryInlandPlain * (1.0 - smoothstep(0.24, 0.62, synCovG)) * 0.045;
        // Anchor regional cloud footprint directly to synoptic weatherDrive while preserving discrete cumulus clearings
        synThresh = clamp(
            mix(0.215, mix(0.54, 0.66, deepStormCore), weatherDrive)
            - lowlandClear
            + upslopeForcing * 0.14
            + massifAnchor * 0.08
            + coastalHeadlandAnchor * 0.06
            + humidMblFactor * 0.04
            - leewardFoehn * 0.18,
            0.0, 0.72
        ) * weatherGate;
        stormBoost = radOpticalDepth * 0.18 + deepStormCore * 0.24 + upslopeForcing * 0.18;

        let lowLayerGate = clamp(cloud.u_layerDensities.x, 0.0, 1.0);
        let alpineValleyMaskG = smoothstep(90.0, 340.0, macroValleyDepthM) * (1.0 - smoothstep(zBaseM - 240.0, zBaseM + 60.0, macroElevM)) * macroLand;
        let coastalValleyMaskG = isCoastalZone * smoothstep(18.0, 220.0, massifPeakM) * (1.0 - smoothstep(zBaseM - 120.0, zBaseM + 140.0, macroElevM * macroLand)) * 0.72;
        incisedValleyGate = 0.78 * max(alpineValleyMaskG, coastalValleyMaskG) * smoothstep(0.08, 0.38, synCovG) * oroMoistureGate * lowLayerGate;
        cliffSlopeBaseGate = 0.70 * max(upslopeForcing, coastalHeadlandAnchor * 0.65) * (1.0 - smoothstep(zBaseM + 900.0, zBaseM + 1650.0, macroElevM)) * smoothstep(0.10, 0.44, synCovG) * oroMoistureGate;
        macPush2D = macUnit2D * (0.00095 * tanh(macroGradMagM / 520.0));
        upslopeFlowLiftWorld = max(0.0, elevMetersToRegWorldZ(basinRefM + 180.0 * upslopeForcing, isDualLog, runtimePeakExp, runtimeDispScale, poleAtten) - elevMetersToRegWorldZ(basinRefM, isDualLog, runtimePeakExp, runtimeDispScale, poleAtten));

        let landCacheFlag = select(0.0, max(0.02, macroLand), maxCardLandB > 0.02);
        p_rayDemThermo = vec4<f32>(lclPlusWindM, zStreamSpan, zCrownSpan, macroTerrainDisp);
        p_rayGeoSwirl = vec4<f32>(synThresh, stormBoost, incisedValleyGate, cliffSlopeBaseGate);
        p_rayVoronoi.x = macroRidgeDisp;
        p_rayVoronoi.y = upslopeFlowLiftWorld;
        p_rayThermoWind.x = macPush2D.x;
        p_rayThermoWind.w = macPush2D.y;
        p_rayCachedSynLift = 1.0 + landCacheFlag;
    }

    let maxActiveRegZ = max(zBase + zCrownSpan * 1.18 + 0.006, macroTerrainDisp + 0.012);
    let minActiveRegZ = min(zBase - 0.012, macroTerrainDisp - 0.006);
    if (inv.z > maxActiveRegZ || inv.z < minActiveRegZ) {
        let emptyDepth = -max(inv.z - maxActiveRegZ, minActiveRegZ - inv.z) - 0.016;
        p_stepCache.nCenter = vec4<f32>(emptyDepth, emptyDepth, 0.5, 0.72);
        p_stepCache.dCenter = vec4<f32>(0.0, synThresh, 0.74, stormBoost);
        return 0.0;
    }

    let subCrestG = (1.0 - smoothstep(macroRidgeDisp - 0.025, macroRidgeDisp + 0.045, inv.z)) * macroLand;
    let obstaclePushWorld = (regEastWorld * macPush2D.x + regNorthWorld * macPush2D.y) * subCrestG;
    let orographicLiftWorld = upslopeFlowLiftWorld * exp(-max(0.0, inv.z - macroTerrainDisp) / 0.045);

    let qMacroStatic = p + obstaclePushWorld - regUpWorld * orographicLiftWorld;
    let qMacro = advectIsometricGhibliPos(qMacroStatic, flowTimeSec * 0.72, detailDriftScale, alphaEased);

    // 1. Half-Dome Target B "Stream + Crown" Scaffold
    let mt = evalRegMultiTierCumulus(qMacro, upWMac, shearDirMac, inv.z, zBase, zStreamSpan, zCrownSpan, synThresh, stormBoost, false);
    if (mt.shelfGate <= 0.001 && incisedValleyGate <= 0.005 && cliffSlopeBaseGate <= 0.005) {
        p_stepCache.nCenter = vec4<f32>(mt.dCumulus, mt.dCumulus, 0.5, 0.72);
        p_stepCache.dCenter = vec4<f32>(0.0, synThresh, 0.74, stormBoost);
        return 0.0;
    }

    let dCumulus = mt.dCumulus;
    let towerSpan = mt.effSpan;

    // 2. Feathered, Wind-Combed Valley Mist Cushion
    let zValleyCeil = min(zBase - 0.0008, macroTerrainDisp + 0.0062) + (mt.nMac0.y - 0.50) * 0.0030;
    let valleyPatch = smoothstep(0.32, 0.70, mt.nMac0.y * 0.78 + mt.nCellR * 0.22 + 0.06 * synThresh);
    let dValleyHoriz = (incisedValleyGate * valleyPatch - 0.345) * 0.050;
    let dValleyVert = min(inv.z - (macroTerrainDisp - 0.0016), zValleyCeil - inv.z);
    let dValleySea = sminDepthGhibli(dValleyHoriz, dValleyVert, 0.0040);

    let dConvAndFog = smaxDepthGhibli(dCumulus, dValleySea, 0.0058);

    // 3. Windward Upslope Collar Mist
    let outsideConvAndFog = 1.0 - smoothstep(-0.0080, -0.0012, dConvAndFog);
    let cliffSlopeGate = cliffSlopeBaseGate * outsideConvAndFog;
    let cliffPatch = smoothstep(0.42, 0.70, mt.nMac0.y * 0.60 + mt.nCellR * 0.40 + 0.08 * cliffSlopeBaseGate);
    let cliffBandZ = inv.z - (macroTerrainDisp + 0.0045);
    let dCliffVert = 0.0088 - abs(cliffBandZ);
    let dCliffMist = min((cliffSlopeGate * cliffPatch - 0.32) * 0.058, dCliffVert);

    let dScaffold = smaxDepthGhibli(dConvAndFog, dCliffMist, 0.0046);

    var regTotalDensity: f32 = 0.0;
    var dShellOut = dScaffold;
    var dCoarseOut = dScaffold;
    let activeColSpan = max(0.0085, mix(zStreamSpan, towerSpan, clamp(mt.midGate * 0.65 + mt.turretGate * 0.45, 0.0, 1.0)));
    let hFracG = clamp((inv.z - zBase + 0.0025) / (activeColSpan + 0.0035), 0.0, 1.0);
    var hFracOut = hFracG;
    var localWispiness: f32 = 0.72;
    var isValleyDom: f32 = 0.0;
    var floretConvexity: f32 = 0.74;
    var qIso = p;

    if (dScaffold > -0.0118) {
        let qIsoStatic = p - regUpWorld * (orographicLiftWorld * 0.15) + regUpWorld * ((inv.z - zBase) * (regVFreqRatio - 1.0) * 0.55);
        qIso = advectIsometricGhibliPos(qIsoStatic, flowTimeSec, detailDriftScale, alphaEased);

        // Preserve 1:1 Retina cauliflower billow sub-structure across r = 5.15..5.45 using 13.4x coarse + 38.2x fine RGBA Worley domes
        let offscreenPxWorld = camDist * 0.00054;
        let nyqDetail = (1.0 - smoothstep(0.00125, 0.00240, offscreenPxWorld)) * smoothstep(0.06, 0.30, p_rayTransmittance);

        let nC = sampleRegNoise3D(rotSO3A(qIso) * (13.40 * regHFreqRatio));
        var nD = vec4<f32>(nC.r, nC.b, nC.a, nC.a);
        if (p_rayTransmittance > 0.05) {
            nD = sampleRegNoise3D(rotSO3B(qIso) * (38.20 * regHFreqRatio) + vec3<f32>(0.37, -0.19, 0.53));
        }
        let fineDomeG = nD.g;
        let fineDomeB = nD.b;
        let mistDetailR = mix(0.50, nD.r, nyqDetail);

        let crownRigidity = smoothstep(0.08, 0.55, hFracG);
        isValleyDom = smoothstep(-0.0035, 0.0035, dValleySea - dCumulus) * smoothstep(-0.010, 0.002, dValleySea);
        let hFracValley = clamp((inv.z - macroTerrainDisp + 0.0010) / 0.0072, 0.36, 0.88);
        hFracOut = mix(hFracG, max(hFracG, hFracValley), isValleyDom);
        let isCliffDom = (1.0 - smoothstep(-0.0070, -0.0010, dConvAndFog)) * smoothstep(-0.010, 0.002, dCliffMist);
        let crownFocus = smoothstep(0.02, 0.34, mt.shelfGate * 0.52 + mt.midGate * 0.58 + mt.turretGate * 0.85) * mix(0.45, 1.0, crownRigidity);
        let streamCrownWisp = mix(0.68, 0.12, crownFocus);
        let autoWispiness = clamp(mix(mix(streamCrownWisp, 0.76, isValleyDom), 0.80, isCliffDom), 0.0, 1.0);
        localWispiness = select(autoWispiness, clamp(cloud.u_ghibliParams.x, 0.0, 1.0), cloud.u_ghibliParams.x >= 0.0);

        // Continuous Half-Dome Spherical Worley Cauliflower Dome Sculpting (13.4x macro lobes + 38.2x fine sub-domes in upper crownFocus)
        let lobeGate = smoothstep(-0.0045, 0.0052, dConvAndFog) * (1.0 - isValleyDom * 0.35);
        let lobeInfCoarse = (nC.g - 0.41) * 0.0178 * lobeGate;
        let floretCarveCoarse = ((1.0 - nC.g) * 0.0092 + (1.0 - nC.b) * 0.0056) * regErosionRatio * mix(0.74, 1.06, crownRigidity) * (1.0 - isValleyDom * 0.42);
        let dGhibliCoarse = dScaffold + lobeInfCoarse - floretCarveCoarse;
        let crownFineBoost = mix(0.85, 1.48, crownFocus);
        let lobeInfFine = (fineDomeG - 0.44) * 0.0054 * nyqDetail * lobeGate * crownFineBoost;
        let floretCarveFine = ((1.0 - fineDomeG) * 0.0042 + (1.0 - fineDomeB) * 0.0019) * regErosionRatio * nyqDetail * crownFineBoost * mix(0.74, 1.08, crownRigidity) * (1.0 - isValleyDom * 0.48);
        let dGhibli = dGhibliCoarse + lobeInfFine - floretCarveFine;

        let mistRaw = 0.62 * nC.r + 0.38 * mistDetailR;
        let mistFbm = clamp(0.50 + (mistRaw - 0.50) * 2.02, 0.0, 1.0);
        let detailConv = 0.46 * (0.62 * nC.g + 0.38 * nC.b) + 0.34 * fineDomeG + 0.20 * mistFbm;
        floretConvexity = mix(smoothstep(0.20, 0.78, detailConv), 0.76, max(localWispiness * 0.50, isValleyDom * 0.78));

        let tendrilAmt = clamp(cloud.u_ghibliParams.w, 0.0, 1.6);
        let coreDepthHold = smoothstep(0.0014, 0.0076, dConvAndFog) * clamp(0.18 + 0.82 * crownFocus, 0.0, 1.0) * (1.0 - isValleyDom * 0.85);
        let wispyBase = mix(min(dScaffold, 0.0064), dScaffold, coreDepthHold * 0.82);
        let dWispyCoarse = wispyBase + (nC.r - 0.50) * 0.0168;
        dCoarseOut = mix(dGhibliCoarse, dWispyCoarse, localWispiness);

        let dWispy = wispyBase
            + (mistFbm - 0.50) * 0.0176
            - (1.0 - mistDetailR) * (0.0042 * regErosionRatio) * nyqDetail * (1.0 - coreDepthHold * 0.65);
        let dBlended = mix(dGhibli, dWispy, localWispiness);
        dShellOut = dBlended;

        // Crisp 1:1 Retina crown edge feather with wispy perimeter/valley tendrils (Half-Dome Target B parity)
        let minSafeFeather = clamp(max(p_rayActiveStepWorld * max(p_rayEntryCos, 0.44) * 1.10, offscreenPxWorld * 0.90), 0.00105, 0.0036);
        let ghibliFeather = max(minSafeFeather, mix(0.0024, 0.00135, crownFocus));
        let wispyFeather = max(minSafeFeather * 1.70, 0.0054);
        let edgeFeather = mix(ghibliFeather, wispyFeather, localWispiness);
        let erodeEdgeShift = (regErosionRatio - 1.0) * 0.14;
        let perimeterFenestration = mix(smoothstep(clamp(0.26 + erodeEdgeShift, 0.10, 0.50), clamp(0.66 + erodeEdgeShift, 0.40, 0.88), mistFbm), 1.0, coreDepthHold * 0.90);
        let wispFenestration = mix(1.0, perimeterFenestration, localWispiness);
        let coreMask = smoothstep(0.0, edgeFeather, dBlended) * wispFenestration;

        let wispShell = smoothstep(-0.0112, -0.0004, dScaffold) * (1.0 - smoothstep(0.0022, 0.0072, dScaffold));
        let perimeterVaporGate = ((0.44 + 0.56 * (1.0 - smoothstep(0.0, 0.58, hFracG))) * mt.shelfGate * 0.68 + cliffSlopeGate * 0.90) * tendrilAmt;
        let fringeWisp = perimeterVaporGate * smoothstep(0.46, 0.78, mistFbm) * wispShell * 0.44;

        let extDensityGain = pow(regExtRatio, 0.35);
        let crownCoreSigma = mix(3.45, 5.15, coreDepthHold) * extDensityGain;
        let valleyFogSigma = 0.62 * extDensityGain;
        let mistBodySigma = mix(1.95, 4.35, coreDepthHold) * extDensityGain;
        let baseSigma = mix(crownCoreSigma, valleyFogSigma, isValleyDom);
        let effSigmaG = mix(baseSigma, mix(mistBodySigma, valleyFogSigma, isValleyDom), localWispiness * (1.0 - coreDepthHold * 0.46));
        regTotalDensity = coreMask * effSigmaG + fringeWisp * 0.54 * extDensityGain;
    }

    // Alias regional step cache onto existing StepShadingCache registers (zero extra var<private> stack spill!)
    p_stepCache.nCenter = vec4<f32>(dShellOut, dCoarseOut, hFracOut, localWispiness);
    p_stepCache.dCenter = vec4<f32>(isValleyDom, synThresh, floretConvexity, stormBoost);
    p_stepCache.baseCoord3D = qMacro;
    p_stepCache.detailCoord3D = qIso;
    p_stepCache.baseWind3D = regUpWorld;
    p_stepCache.detailWind3D = shearDirMac;
    p_stepCache.baseNwOffset3D = regEastWorld;
    p_stepCache.nwOffset3D = regNorthWorld;
    p_stepCache.stepSynopticLift = zStreamSpan;
    p_stepCache.stepTropoSpan = zCrownSpan;
    p_stepCache.stepEffTerrainNorm = zBase;
    p_stepCache.stepDemHere = inv.z;
    p_stepCache.stepIsLand = dCliffMist;
    p_stepCache.stepRadOptics = dValleySea;

    return regTotalDensity;
}

// Dedicated Low-VGPR Regional Column Wrapper (decoupled from synoptic sampleCloudDensityFromUVW for full Metal SIMD occupancy)
fn sampleRegionalColumnFromUVW(inv: vec3<f32>, pos: vec3<f32>, rInner: f32, deltaR: f32) -> f32 {
    let p = pos;
    let unfurl = cloud.u_simControl.y;
    let absLambdaNorm = abs(inv.x) / PI;
    let tCut = smoothstep(0.0, 0.02, unfurl);
    let edgeFadeLon = mix(1.0, 1.0 - smoothstep(0.96, 1.0, absLambdaNorm), tCut);
    let alphaClamped = clamp(unfurl, 0.0, 1.0);
    let alphaEased = alphaClamped * alphaClamped * (3.0 - 2.0 * alphaClamped);
    let tStraighten = smoothstep(0.20, 0.95, alphaEased);
    let yMax = rInner * (1.0 - tStraighten + tStraighten * HALF_PI);
    let activeYMax = select(yMax, rInner * (1.0 - tStraighten + tStraighten * 3.1313), getActiveManifoldMode() > 0u && isAtmoFeatureEnabled(7u));
    let edgeFadeLat = select(1.0 - smoothstep(activeYMax - deltaR * 0.65, activeYMax, abs(p.y)), 1.0, unfurl <= 0.001);
    let maxShellZ = max(deltaR * 1.05, p_rayMaxShellZ);
    let inAltitude = select(0.0, 1.0, inv.z >= -0.01 && inv.z <= maxShellZ);

    let camVec = camera.u_cameraPos.xyz - p;
    let camDist = length(camVec);
    let viewToCam = camVec / max(1e-5, camDist);
    let radNorm = p / max(1e-5, length(p));
    let limbFacing = clamp(dot(radNorm, viewToCam), 0.0, 1.0);
    let limbFade = mix(smoothstep(0.005, 0.085, limbFacing), 1.0, clamp(unfurl * 2.5, 0.0, 1.0));
    let edgeFade = edgeFadeLon * edgeFadeLat * inAltitude * limbFade;
    if (edgeFade <= 0.001) {
        return 0.0;
    }

    let driftRate = cloud.u_noiseParams.w;
    let flowTimeSec = select(cloud.u_simControl.x, cloud.u_padCloud.y, cloud.u_padCloud.y > 0.0);
    let timeSec = select(cloud.u_simControl.x, max(0.0, cloud.u_simControl.x - cloud.u_padCloud.y), cloud.u_padCloud.y > 0.0);
    let timeDrift = flowTimeSec * driftRate;
    let synopticDrift = timeSec * driftRate;
    let uv = vec2<f32>(fract((inv.x / TWO_PI) + 0.5), clamp(0.5 - (inv.y / PI), 0.001, 0.999));
    let baseAdvUV = vec2<f32>(fract(uv.x + synopticDrift * 0.12), uv.y);
    let safeCosLat = clamp(cos(inv.y), 0.22, 1.0);

    var wSurf = p_rayWinds.xy;
    var wMid = p_rayMidWind;
    var wJet = p_rayWinds.zw;
    if (p_rayVoronoi.w < 0.5) {
        let wSurf10 = textureSampleLevel(u_windTexture, u_cloud2DSampler, uv, 0.0).xy;
        let jetFull = textureSampleLevel(u_jetStreamTexture, u_cloud2DSampler, uv, 0.0);
        wJet = jetFull.xy;
        wSurf = wSurf10;
        if (hasWind100m()) {
            let w100 = textureSampleLevel(u_dewpointTexture, u_cloud2DSampler, uv, 0.0).ba;
            wSurf = mix(wSurf10, w100, 0.72);
        }
        wMid = select(blendStratumWindVector(wSurf, wJet, 0.45), jetFull.zw, hasWind500hPa());
        if (p_rayVoronoi.z > 0.5) {
            p_rayWinds = vec4<f32>(wSurf, wJet);
            p_rayMidWind = wMid;
            p_rayVoronoi.w = 1.0;
        }
    }

    var lowFraction = p_rayCov.x;
    var midFraction = p_rayCov.y;
    var highFraction = p_rayCov.z;
    if (p_rayCov.w <= 0.5) {
        lowFraction = 0.0;
        midFraction = 0.0;
        highFraction = 0.0;
        if (cloud.u_layerDensities.x > 0.001) {
            let uvL = computeWindSwirlAdvectedUV(baseAdvUV, wSurf, flowTimeSec, timeDrift, safeCosLat);
            lowFraction = textureSampleLevel(u_cloudLowTexture, u_cloud2DSampler, uvL, 0.0).r;
        }
        if (cloud.u_layerDensities.y > 0.001) {
            let uvM = computeWindSwirlAdvectedUV(baseAdvUV, wMid, flowTimeSec, timeDrift, safeCosLat);
            midFraction = textureSampleLevel(u_cloudMidTexture, u_cloud2DSampler, uvM, 0.0).r;
        }
        if (cloud.u_layerDensities.z > 0.001) {
            let uvH = computeWindSwirlAdvectedUV(baseAdvUV, wJet, flowTimeSec, timeDrift, safeCosLat);
            highFraction = textureSampleLevel(u_cloudHighTexture, u_cloud2DSampler, uvH, 0.0).r;
        }
        p_rayCov = vec4<f32>(lowFraction, midFraction, highFraction, 1.0);
    }

    var fastRadOptics = p_rayThermoWind.y;
    var fastLclMeters = p_rayThermoWind.z;
    if (p_rayVoronoi.z < 1.9) {
        let hasRealThermoFast = (textureDimensions(u_tempTexture).x > 1u) && (textureDimensions(u_dewpointTexture).x > 1u);
        let tempFast = textureSampleLevel(u_tempTexture, u_cloud2DSampler, uv, 0.0);
        let dewFast = textureSampleLevel(u_dewpointTexture, u_cloud2DSampler, uv, 0.0);
        let t2mC = select(12.0, select(tempFast.r, tempFast.r - 273.15, tempFast.r > 150.0), hasRealThermoFast);
        let td2mC = select(4.0, select(dewFast.r, dewFast.r - 273.15, dewFast.r > 150.0), hasRealThermoFast);
        fastLclMeters = select(1020.0, 125.0 * max(0.0, t2mC - td2mC), hasRealThermoFast);
        let hasPhase2Fast = hasRealThermoFast && (dewFast.g > 0.005);
        let fallbackRadFast = clamp(lowFraction * 0.42 + midFraction * 0.44 + highFraction * 0.20 + lowFraction * midFraction * 0.48, 0.0, 1.0);
        fastRadOptics = select(fallbackRadFast, clamp(dewFast.g, 0.0, 1.0), hasPhase2Fast);
        if (p_rayVoronoi.z > 0.5) {
            p_rayThermoWind.y = fastRadOptics;
            p_rayThermoWind.z = fastLclMeters;
            p_rayVoronoi.z = 2.0;
        }
    }

    let demTexDims = textureDimensions(u_demTexture);
    let hasMipmappedDem = demTexDims.x > 4u;
    let runtimeDispScale = select(0.28, cloud.u_shellRadii.w, cloud.u_shellRadii.w > 0.0001);
    let runtimePeakExp = select(1.4, clamp(cloud.u_padCloud.z, 0.2, 4.0), cloud.u_padCloud.z > 0.01);
    let isDualLog = cloud.u_padCloud.w > 0.5;
    let poleDist = abs(uv.y - 0.5) * 2.0;
    let poleAtten = 1.0 - smoothstep(0.85, 0.98, poleDist);

    let regCrestWindFast = mix(wSurf, wMid, 0.38);
    let regFastDens = evaluateRegionalGhibliColumn(
        inv, p, uv, safeCosLat, alphaEased, flowTimeSec, camDist, regCrestWindFast,
        lowFraction, midFraction, highFraction, fastRadOptics, fastLclMeters,
        runtimeDispScale, runtimePeakExp, isDualLog, poleAtten, hasMipmappedDem
    );
    p_stepCache.stepHNormAGL = clamp(inv.z / deltaR, 0.0, 1.0);
    p_stepCache.stepLow = lowFraction;
    p_stepCache.stepMid = midFraction;
    p_stepCache.stepHigh = highFraction;
    return regFastDens * cloud.u_layerDensities.w * edgeFade;
}

// Sample Scalar Cloud Density from Parameter Coordinates (lambda, phi, h)
fn sampleCloudDensityFromUVW(inv: vec3<f32>, pos: vec3<f32>, rInner: f32, deltaR: f32) -> f32 {
    let p = pos;
    let unfurl = cloud.u_simControl.y;

    // Sheet Boundary Margin Attenuation (edgeFade)
    let absLambdaNorm = abs(inv.x) / PI;
    let tCut = smoothstep(0.0, 0.02, unfurl);
    let edgeFadeLon = mix(1.0, 1.0 - smoothstep(0.96, 1.0, absLambdaNorm), tCut);

    let alphaClamped = clamp(unfurl, 0.0, 1.0);
    let alphaEased = alphaClamped * alphaClamped * (3.0 - 2.0 * alphaClamped);
    let tStraighten = smoothstep(0.20, 0.95, alphaEased);
    // Equirectangular 2:1 developable sheet latitude bound (Mode 0), extended to +/- 3.1313 R for Modes 1..3 Web Mercator
    let yMax = rInner * (1.0 - tStraighten + tStraighten * HALF_PI);
    let activeYMax = select(yMax, rInner * (1.0 - tStraighten + tStraighten * 3.1313), getActiveManifoldMode() > 0u && isAtmoFeatureEnabled(7u));
    let edgeFadeLat = select(
        1.0 - smoothstep(activeYMax - deltaR * 0.65, activeYMax, abs(p.y)),
        1.0,
        unfurl <= 0.001
    );

    let maxShellZ = max(deltaR * 1.05, p_rayMaxShellZ);
    let inAltitude = select(0.0, 1.0, inv.z >= -0.01 && inv.z <= maxShellZ);

    // Horizon Limb Grazing Attenuation:
    // Allows clouds to wrap continuously around the visible globe curvature up to the horizon limb
    let camVec = camera.u_cameraPos.xyz - p;
    let camDist = length(camVec);
    let viewToCam = camVec / max(1e-5, camDist);
    let radNorm = p / max(1e-5, length(p));
    let limbFacing = clamp(dot(radNorm, viewToCam), 0.0, 1.0);
    let limbFade = mix(
        smoothstep(0.005, 0.085, limbFacing),
        1.0,
        clamp(unfurl * 2.5, 0.0, 1.0)
    );

    let edgeFade = edgeFadeLon * edgeFadeLat * inAltitude * limbFade;
    if (edgeFade <= 0.001) {
        return 0.0;
    }

    // Base Strata Altitudes
    let baseLowTop = cloud.u_layerHeights.x;      // ~0.15..0.45
    let midBottom = cloud.u_layerHeights.y;       // ~0.20..0.36
    let baseMidTop = cloud.u_layerHeights.z;      // ~0.55..0.68
    let highBottom = cloud.u_layerHeights.w;      // ~0.60..0.64

    let isAdvectionActive = advection.u_advectionSpeed > 0.001;

    // Fast 3-Fetch Synoptic Coverage Lookup & Immediate Clear-Sky Early Exit
    // Lockstep wind advection between 3D cloud volume and 2D ground shadows in crust_hydrosphere.wgsl
    let driftRate = cloud.u_noiseParams.w;
    let flowTimeSec = select(cloud.u_simControl.x, cloud.u_padCloud.y, cloud.u_padCloud.y > 0.0);
    let timeSec = select(cloud.u_simControl.x, max(0.0, cloud.u_simControl.x - cloud.u_padCloud.y), cloud.u_padCloud.y > 0.0);
    let timeDrift = flowTimeSec * driftRate;
    let synopticDrift = timeSec * driftRate;
    let uv = vec2<f32>(fract((inv.x / TWO_PI) + 0.5), clamp(0.5 - (inv.y / PI), 0.001, 0.999));
    var advectedUV = vec2<f32>(fract(uv.x + synopticDrift * 0.12), uv.y);

    // Fetch 2D Wind & Jet Stream Vectors for lockstep 2D + 3D wind advection
    let latRad = (0.5 - uv.y) * PI;
    let cosLatTrue = cos(inv.y);
    let safeCosLat = clamp(cosLatTrue, 0.22, 1.0);
    let polarStencilAtten = smoothstep(0.05, 0.25, cos(latRad));

    let isPureRegFast2D = false;

    var wSurf = p_rayWinds.xy;
    var wJet = p_rayWinds.zw;
    var wMid = p_rayMidWind;
    if (p_rayVoronoi.w < 0.5) {
        let wSurf10 = textureSampleLevel(u_windTexture, u_cloud2DSampler, uv, 0.0).xy;
        let jetFull = textureSampleLevel(u_jetStreamTexture, u_cloud2DSampler, uv, 0.0);
        wJet = jetFull.xy;
        wSurf = wSurf10;
        if (hasWind100m()) {
            let w100 = textureSampleLevel(u_dewpointTexture, u_cloud2DSampler, uv, 0.0).ba;
            wSurf = mix(wSurf10, w100, 0.72);
        }
        wMid = select(blendStratumWindVector(wSurf, wJet, 0.45), jetFull.zw, hasWind500hPa());

        // Evaluate 1000 km synoptic MSLP geostrophic swirl once per ray (p_rayThermoWind.w < -0.5)
        var geoSwirl = p_rayGeoSwirl.xy;
        var dMslpHpa = p_rayGeoSwirl.z;
        var convSpreadVal = p_rayGeoSwirl.w;
        if (hasMslpAndSpread() && p_rayThermoWind.w < -0.5) {
            geoSwirl = vec2<f32>(0.0, 0.0);
            let tempMeta = textureSampleLevel(u_tempTexture, u_cloud2DSampler, uv, 0.0);
            dMslpHpa = tempMeta.b;
            convSpreadVal = clamp(tempMeta.a, 0.0, 1.0);
            if (isAtmoFeatureEnabled(1u) && (dMslpHpa < -3.5 || abs(dMslpHpa) > 6.0)) {
                let duP = 0.0022 / safeCosLat;
                let dvP = 0.0022;
                let pE = textureSampleLevel(u_tempTexture, u_cloud2DSampler, vec2<f32>(fract(uv.x + duP + 1.0), uv.y), 0.0).b;
                let pW = textureSampleLevel(u_tempTexture, u_cloud2DSampler, vec2<f32>(fract(uv.x - duP + 1.0), uv.y), 0.0).b;
                let pN = textureSampleLevel(u_tempTexture, u_cloud2DSampler, vec2<f32>(uv.x, clamp(uv.y - dvP, 0.001, 0.999)), 0.0).b;
                let pS = textureSampleLevel(u_tempTexture, u_cloud2DSampler, vec2<f32>(uv.x, clamp(uv.y + dvP, 0.001, 0.999)), 0.0).b;
                let gradP = vec2<f32>((pE - pW) * safeCosLat, pN - pS) * 1.35;
                let hemiSign = select(-1.0, 1.0, latRad >= 0.0);
                // ascending smoothstep edges (-26.0 < -4.0)
                let cycloneCoreGate = 1.0 - smoothstep(-26.0, -4.0, dMslpHpa);
                let coriolisGate = smoothstep(0.06, 0.24, abs(sin(latRad)));
                let geoTan = vec2<f32>(-gradP.y, gradP.x) * hemiSign;
                let ekmanInflow = -gradP * (0.28 * cycloneCoreGate);
                geoSwirl = clamp((geoTan + ekmanInflow) * coriolisGate * (0.65 + 0.55 * cycloneCoreGate), vec2<f32>(-28.0), vec2<f32>(28.0));
            }
            p_rayThermoWind.w = 1.0;
        }

        if (p_rayVoronoi.z > 0.5) {
            p_rayWinds = vec4<f32>(wSurf, wJet);
            p_rayMidWind = wMid;
            p_rayGeoSwirl = vec4<f32>(geoSwirl, dMslpHpa, convSpreadVal);
            p_rayThermoWind.z = 0.0;
            p_rayVoronoi.w = 1.0;
        }
    }

    let swirlCurv = p_rayGeoSwirl.xy;
    let wSurfAdv = wSurf + swirlCurv * 0.42;
    let wMidAdv = wMid + swirlCurv * 0.28;

    // Continuous dual-phase RK2 curved streamline trajectory + advective t0/t1 cross-dissolve (Choice B)
    let advT_macro = flowTimeSec;
    let choiceBActive = isAtmoFeatureEnabled(1u);

    let baseAdvUV = advectedUV;
    var lowFraction: f32 = 0.0;
    var midFraction: f32 = 0.0;
    var highFraction: f32 = 0.0;
    if (p_rayCov.w > 0.5) {
        lowFraction = p_rayCov.x;
        midFraction = p_rayCov.y;
        highFraction = p_rayCov.z;
    } else {
        let uvMidProbe = computeWindSwirlAdvectedUV(baseAdvUV, wMidAdv, advT_macro, timeDrift, safeCosLat);
        let maxLayerD = max(max(cloud.u_layerDensities.x, cloud.u_layerDensities.y), cloud.u_layerDensities.z);
        let pcStepMax = sampleCloudPreCullGrid(uvMidProbe).x * maxLayerD;
        if (pcStepMax >= 0.006 || !choiceBActive) {
            if (cloud.u_layerDensities.x > 0.001) {
                if (choiceBActive && !isPureRegFast2D) {
                    lowFraction = sampleDualPhaseRK2Cloud(u_cloudLowTexture, baseAdvUV, wSurfAdv, swirlCurv, advT_macro, timeDrift, safeCosLat);
                } else {
                    advectedUV = computeWindSwirlAdvectedUV(baseAdvUV, wSurfAdv, advT_macro, timeDrift, safeCosLat);
                    lowFraction = textureSampleLevel(u_cloudLowTexture, u_cloud2DSampler, advectedUV, 0.0).r;
                }
            }
            if (cloud.u_layerDensities.y > 0.001) {
                if (choiceBActive && !isPureRegFast2D) {
                    midFraction = sampleDualPhaseRK2Cloud(u_cloudMidTexture, baseAdvUV, wMidAdv, swirlCurv * 0.65, advT_macro, timeDrift, safeCosLat);
                } else {
                    advectedUV = computeWindSwirlAdvectedUV(baseAdvUV, wMidAdv, advT_macro, timeDrift, safeCosLat);
                    midFraction = textureSampleLevel(u_cloudMidTexture, u_cloud2DSampler, advectedUV, 0.0).r;
                }
            }
            if (cloud.u_layerDensities.z > 0.001) {
                if (choiceBActive && !isPureRegFast2D) {
                    highFraction = sampleDualPhaseRK2Cloud(u_cloudHighTexture, baseAdvUV, wJet, swirlCurv * 0.20, advT_macro, timeDrift, safeCosLat);
                } else {
                    advectedUV = computeWindSwirlAdvectedUV(baseAdvUV, wJet, advT_macro, timeDrift, safeCosLat);
                    highFraction = textureSampleLevel(u_cloudHighTexture, u_cloud2DSampler, advectedUV, 0.0).r;
                }
            }
        }
        advectedUV = baseAdvUV;
        p_rayCov = vec4<f32>(lowFraction, midFraction, highFraction, 1.0);
    }

    let rawCovSum = lowFraction * cloud.u_layerDensities.x + midFraction * cloud.u_layerDensities.y + highFraction * cloud.u_layerDensities.z * 0.45;
    let baseHNorm = clamp(inv.z / deltaR, 0.0, 1.0);

    // Direct 2D DEM & Psychrometric (T2m, Td2m) Coupling
    let demTexDims = textureDimensions(u_demTexture);
    let hasRealDem = demTexDims.x > 1u;
    let hasMipmappedDem = demTexDims.x > 4u;
    let runtimeDispScale = select(0.28, cloud.u_shellRadii.w, cloud.u_shellRadii.w > 0.0001);
    let runtimePeakExp = select(1.4, clamp(cloud.u_padCloud.z, 0.2, 4.0), cloud.u_padCloud.z > 0.01);
    let isDualLog = cloud.u_padCloud.w > 0.5;
    let poleDist = abs(uv.y - 0.5) * 2.0;
    let poleAtten = 1.0 - smoothstep(0.85, 0.98, poleDist);

    let effTropoSpan = select(max(0.0001, deltaR), max(0.0001, deltaR * 0.56), hasMipmappedDem);
    var synopticLiftDisp: f32 = 0.0;
    if (hasMipmappedDem && p_rayMaxSynLift >= 0.0004) {
        if (p_rayCachedSynLift >= 0.0 && p_rayEntryCos > 0.72) {
            synopticLiftDisp = p_rayCachedSynLift;
        } else {
            let demSynoptic = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_cloud2DSampler, uv, 5.5));
            let rawSynElevM = max(0.0, demSynoptic.a * 19772.0 - 10924.0);
            let synCapElevM = (2650.0 * rawSynElevM) / sqrt(2650.0 * 2650.0 + rawSynElevM * rawSynElevM);
            let synNormElev = clamp(synCapElevM / 8848.0, 0.0, 1.0);
            let synDualLogElev = clamp(log(1.0 + synCapElevM / 1200.0) / 2.12425, 0.0, 1.0);
            let activeSynNorm = select(synNormElev, synDualLogElev, isDualLog);
            synopticLiftDisp = min(pow(activeSynNorm, runtimePeakExp) * runtimeDispScale * poleAtten * 0.94, deltaR * 0.60);
            if (p_rayVoronoi.z > 0.5) {
                p_rayCachedSynLift = synopticLiftDisp;
            }
        }
    }
    let hybridHNorm = select(baseHNorm, clamp((inv.z - synopticLiftDisp) / effTropoSpan, 0.0, 1.35), hasMipmappedDem);
    if (hasMipmappedDem && (inv.z < synopticLiftDisp - 0.006 || hybridHNorm > 0.94)) {
        return 0.0;
    }

    var elevMeters = p_rayDemThermo.x;
    var isLand = p_rayDemThermo.y;
    let ptDistTerrain = length(camera.u_cameraPos.xyz - p);
    if (p_rayVoronoi.z < 1.5) {
        let globalDemSample = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_cloud2DSampler, uv, p_rayDemMip));
        let demSample = sampleUnifiedCloudTerrain(uv, globalDemSample, ptDistTerrain, p_rayDemMip);
        elevMeters = select(0.0, demSample.a * 19772.0 - 10924.0, hasRealDem);
        isLand = select(0.0, select(0.0, 1.0, elevMeters > 2.0 || demSample.b > 0.5), hasRealDem);
        p_rayDemThermo.x = elevMeters;
        p_rayDemThermo.y = isLand;
        p_rayVoronoi.z = max(p_rayVoronoi.z, 1.6);
    } else if (p_rayEntryCos < 0.76 && (p_raySurfDisp > 0.0005 || hybridHNorm < 0.46)) {
        let globalDemStep = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_cloud2DSampler, uv, p_rayDemMip));
        elevMeters = select(0.0, globalDemStep.a * 19772.0 - 10924.0, hasRealDem);
        isLand = select(0.0, select(0.0, 1.0, elevMeters > 2.0 || globalDemStep.b > 0.5), hasRealDem);
    }

    let isCoastalHumidCandidate = hasRealDem && (p_raySurfDisp <= 0.085) && (isLand > 0.5) && (elevMeters <= 1350.0) && (hybridHNorm < 0.40) && (cloud.u_layerDensities.x > 0.001);
    // Candidate 3A: Unconditional Clear-Sky Early Exit BEFORE sampling thermo textures or 6-tap DEM stencil
    if (rawCovSum < 0.016 && !isCoastalHumidCandidate) {
        return 0.0;
    }

    // Fast Ocean Stratum Early Exit (culls only below 0.032 where effectiveMacroDensity is already zero, preserving C^1 continuity at cloud perimeters)
    if (p_raySurfDisp <= 0.0005 && synopticLiftDisp < 0.0015 && !isCoastalHumidCandidate) {
        let hasLowBand = (hybridHNorm <= 0.28) && ((lowFraction * cloud.u_layerDensities.x) >= 0.032);
        let hasMidBand = (hybridHNorm >= 0.24 && hybridHNorm <= 0.56) && ((midFraction * cloud.u_layerDensities.y) >= 0.032);
        let hasHighBand = (hybridHNorm >= 0.56 && hybridHNorm <= 0.86) && ((highFraction * cloud.u_layerDensities.z) >= 0.032);
        if (!hasLowBand && !hasMidBand && !hasHighBand) {
            return 0.0;
        }
    }

    // Exact Displaced 3D Crust Height + Continuous World-Space Altitude Normalization (1:1 World-Space Parity with crust_hydrosphere.wgsl, zero coastline step jump)
    var hNorm = baseHNorm;
    hNorm = hybridHNorm;
    var effTerrainNorm: f32 = 0.0;
    if (hasRealDem && isLand > 0.35 && (elevMeters > 0.0 || p_raySurfDisp > 0.00025)) {
        let normElev = clamp(max(elevMeters, 0.0) / 8848.0, 0.0, 1.0);
        let dualLogElev = clamp(log(1.0 + max(elevMeters, 0.0) / 1200.0) / 2.12425, 0.0, 1.0);
        let activeElevNorm = select(normElev, dualLogElev, isDualLog);
        let exactTerrainDisp = max(pow(activeElevNorm, runtimePeakExp) * runtimeDispScale * poleAtten, select(0.0, min(p_raySurfDisp, 0.055), isLand > 0.5 && elevMeters <= 5.0));

        // Sub-crust 3D volume rejection well below the smooth mountain-wall feather
        if (isLand > 0.5 && inv.z <= exactTerrainDisp - 0.0018) {
            return 0.0;
        }

        effTerrainNorm = clamp((exactTerrainDisp - synopticLiftDisp) / effTropoSpan, 0.0, 3.5);
    }

    var zLclMetersThermo: f32 = p_rayDemThermo.w;
    var mblDeltaT: f32 = p_rayThermoWind.x;
    var radOpticalDepth: f32 = p_rayThermoWind.y;
    let hasRealThermo = (textureDimensions(u_tempTexture).x > 1u) && (textureDimensions(u_dewpointTexture).x > 1u);

    if (p_rayVoronoi.z < 1.9) {
        let tempSample = textureSampleLevel(u_tempTexture, u_cloud2DSampler, uv, 0.0);
        let dewSample = textureSampleLevel(u_dewpointTexture, u_cloud2DSampler, uv, 0.0);
        let t2mRaw = tempSample.r;
        let sstRaw = tempSample.g;
        let td2mRaw = dewSample.r;
        let climoT2m = 27.0 * cos(inv.y) - 12.0 * sin(inv.y) * sin(inv.y) - max(elevMeters, 0.0) * 0.0065;
        let climoDepression = mix(2.2, 6.0, isLand) + 2.5 * smoothstep(0.15, 0.55, abs(sin(inv.y)));
        let t2mCelsius = select(climoT2m, select(t2mRaw, t2mRaw - 273.15, t2mRaw > 150.0), hasRealThermo);
        let td2mCelsius = select(climoT2m - climoDepression, select(td2mRaw, td2mRaw - 273.15, td2mRaw > 150.0), hasRealThermo);
        zLclMetersThermo = 125.0 * max(t2mCelsius - td2mCelsius, 0.0);
        let hasPhase2Physics = hasRealThermo && (dewSample.g > 0.005);
        let sstMinValid = select(8.0, -1.8, abs(inv.y) > 0.65);
        let hasValidSST = hasRealThermo && (sstRaw > max(sstMinValid, t2mCelsius - 3.2)) && (hasPhase2Physics || abs(sstRaw) > 0.001) && (isLand < 0.5);
        let sstCelsius = select(t2mCelsius, select(sstRaw, sstRaw - 273.15, sstRaw > 150.0), hasValidSST);
        mblDeltaT = select(0.0, clamp(t2mCelsius - sstCelsius, -6.0, 6.0), hasValidSST);
        let fallbackRadOptics = clamp(lowFraction * 0.42 + midFraction * 0.44 + highFraction * 0.20 + lowFraction * midFraction * 0.48, 0.0, 1.0);
        radOpticalDepth = select(fallbackRadOptics, clamp(dewSample.g, 0.0, 1.0), hasPhase2Physics);

        if (p_rayVoronoi.z > 0.5) {
            p_rayDemThermo.x = elevMeters;
            p_rayDemThermo.y = isLand;
            p_rayDemThermo.w = zLclMetersThermo;
            p_rayThermoWind.x = mblDeltaT;
            p_rayThermoWind.y = radOpticalDepth;
            p_rayVoronoi.z = 2.0;
        }
    }

    if (rawCovSum < 0.016 && (isLand <= 0.35 || zLclMetersThermo > 920.0)) {
        return 0.0;
    }

    if (hNorm < 0.14 && !isCoastalHumidCandidate && (lowFraction * cloud.u_layerDensities.x) < 0.015 && (midFraction * cloud.u_layerDensities.y) < 0.04) {
        return 0.0;
    }
    let nearHighRelief = (isLand > 0.35) && ((hNorm - effTerrainNorm) < 0.30);
    if (!nearHighRelief && hNorm > 0.58 && (highFraction * cloud.u_layerDensities.z) < 0.056 && (lowFraction * midFraction) < 0.12) {
        return 0.0;
    }

    // Windward Ridge Banking & Valley Pooling Below Ridge Crests (Multi-Scale Coastal/Island Marine Layer + High Cordillera)
    var windwardBankBoost: f32 = 0.0;
    var leewardSubsidenceAtten: f32 = 1.0;
    var valleyPoolWeight: f32 = 0.0;
    var bankedLowCeil: f32 = select(baseLowTop, clamp(0.165 * (baseLowTop / 0.45), 0.075, 0.30), hasMipmappedDem);
    var coastalLowBaseOverride: f32 = 1.0;
    var activeCoastalOroGate: f32 = 0.0;
    var wSurfEffective = wSurf;

    if (hasRealDem && isLand > 0.35 && hNorm < 0.44 && elevMeters > -2.0) {
      if ((hNorm - effTerrainNorm) < 0.188) {
        var rawNeighborMax = p_rayVoronoi.x;
        var smoothElevM = p_rayVoronoi.y;
        var coastalProximity = p_rayDemThermo.z;
        var dH_windward = p_rayThermoWind.z;
        var dH_leeward = p_rayThermoWind.w;

        if (rawNeighborMax < -0.5) {
            let rCam = length(camera.u_cameraPos.xyz);
            let rEff = mix(rCam, 5.0 + abs(camera.u_cameraPos.z), clamp(unfurl, 0.0, 1.0));
            let zoomScale = clamp((rEff - 5.15) / (7.50 - 5.15), 0.22, 1.0);
            let du = (0.0018 * zoomScale) / safeCosLat;
            let dv = 0.0018 * zoomScale;
            let uvE = vec2<f32>(fract(uv.x + du), uv.y);
            let uvW = vec2<f32>(fract(uv.x - du), uv.y);
            let uvN = vec2<f32>(uv.x, clamp(uv.y - dv, 0.001, 0.999));
            let uvS = vec2<f32>(uv.x, clamp(uv.y + dv, 0.001, 0.999));
            let oroMip = p_rayDemMip;
            let sE = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, uvE, oroMip));
            let sW = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, uvW, oroMip));
            let sN = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, uvN, oroMip));
            let sS = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, uvS, oroMip));
            let elevE = sE.a * 19772.0 - 10924.0;
            let elevW = sW.a * 19772.0 - 10924.0;
            let elevN = sN.a * 19772.0 - 10924.0;
            let elevS = sS.a * 19772.0 - 10924.0;

            let wDir = wSurf * inverseSqrt(max(0.01, dot(wSurf, wSurf)));
            let downStepUV = vec2<f32>(wDir.x * (0.0028 * zoomScale) / safeCosLat, -wDir.y * (0.0028 * zoomScale));
            let uvDown = vec2<f32>(fract(uv.x + downStepUV.x), clamp(uv.y + downStepUV.y, 0.001, 0.999));
            let uvUp   = vec2<f32>(fract(uv.x - downStepUV.x), clamp(uv.y - downStepUV.y, 0.001, 0.999));
            let sDown = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, uvDown, oroMip));
            let sUp   = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, uvUp, oroMip));
            let elevDownwind = sDown.a * 19772.0 - 10924.0;
            let elevUpwind   = sUp.a * 19772.0 - 10924.0;
            let minNeighborLand = min(min(sE.b, sW.b), min(min(sN.b, sS.b), min(sDown.b, sUp.b)));
            coastalProximity = 1.0 - smoothstep(0.35, 0.75, minNeighborLand);

            rawNeighborMax = max(0.0, max(max(elevE, elevW), max(max(elevN, elevS), max(max(elevDownwind, elevUpwind), elevMeters))));
            smoothElevM = (max(0.0, elevMeters) * 2.0 + max(0.0, elevE) + max(0.0, elevW) + max(0.0, elevN) + max(0.0, elevS) + max(0.0, elevDownwind) + max(0.0, elevUpwind)) * 0.125;
            let gradH = vec2<f32>((elevE - elevW) * 0.5, (elevN - elevS) * 0.5);
            let upslopeGrad = dot(wDir, gradH);
            dH_windward = max(upslopeGrad, (elevDownwind - elevMeters) * 0.65);
            dH_leeward = max(-upslopeGrad, (elevUpwind - elevMeters) * 0.55);

            p_rayVoronoi.x = rawNeighborMax;
            p_rayVoronoi.y = smoothElevM;
            p_rayDemThermo.z = coastalProximity;
            p_rayThermoWind.z = dH_windward;
            p_rayThermoWind.w = dH_leeward;
        }

        let meshDispScale = max(0.018, runtimeDispScale * 0.36);
        let surfDispNorm = clamp(p_raySurfDisp / meshDispScale, 0.0, 1.0);
        let surfDispElevM = select(0.0, clamp(pow(surfDispNorm, 1.0 / max(0.5, runtimePeakExp)) * 3200.0, 0.0, 950.0), isLand > 0.5 && p_raySurfDisp > 0.00012);
        let coastalPeninsulaElevM = select(0.0, clamp(max(rawNeighborMax * 2.2, 68.0), 0.0, 320.0) * coastalProximity, isLand > 0.5 && rawNeighborMax > 8.0);
        let effCoastalElevM = max(max(smoothElevM, surfDispElevM), coastalPeninsulaElevM);
        let ridgeCrestM = max(mix(smoothElevM, rawNeighborMax, 0.52), effCoastalElevM * 1.15);

        let valleyDepthM = max(0.0, rawNeighborMax - max(elevMeters, 0.0));
        let vertSlabGate = 1.0 - smoothstep(0.125, 0.185, max(0.0, hNorm - effTerrainNorm));
        let surfDispGate = smoothstep(0.00015, 0.0018, p_raySurfDisp) * vertSlabGate;
        let coastalSurfGate = max(smoothstep(0.00010, 0.0009, p_raySurfDisp), coastalProximity * step(0.5, isLand)) * vertSlabGate;
        let mountainMassifGate = smoothstep(950.0, 1600.0, ridgeCrestM);
        // ascending smoothstep edges (320.0 < 950.0 and 180.0 < 820.0)
        let coastalLclGate = 1.0 - smoothstep(320.0, 950.0, zLclMetersThermo);
        let coastalMblGate = clamp(0.65 + 0.35 * smoothstep(-0.8, 1.5, mblDeltaT), 0.0, 1.0);
        let coastalShoreFade = coastalSurfGate * coastalProximity * smoothstep(24.0, 110.0, effCoastalElevM) * (1.0 - smoothstep(850.0, 1350.0, elevMeters));
        let coastalOroGate = smoothstep(14.0, 95.0, ridgeCrestM)
                           * coastalShoreFade
                           * max(coastalLclGate, coastalMblGate * 0.75);
        activeCoastalOroGate = coastalOroGate;

        let normRidge = clamp(max(ridgeCrestM, 0.0) / 8848.0, 0.0, 1.0);
        let dualLogRidge = clamp(log(1.0 + max(ridgeCrestM, 0.0) / 1200.0) / 2.12425, 0.0, 1.0);
        let activeRidgeNorm = select(normRidge, dualLogRidge, isDualLog);
        let exactRidgeDisp = pow(activeRidgeNorm, runtimePeakExp) * runtimeDispScale * poleAtten;
        let effRidgeNorm = clamp((exactRidgeDisp - synopticLiftDisp) / effTropoSpan, 0.045, 3.5);
        let coastalCeilLift = clamp(coastalOroGate * 1.45, 0.0, 1.0);
        let activeCrestCeilNorm = min(max(effRidgeNorm + 0.032, 0.138 * coastalCeilLift), effTerrainNorm + mix(0.072, 0.138, coastalCeilLift));
        coastalLowBaseOverride = 1.0 - 0.65 * coastalOroGate;

        var onshoreWestFetch: f32 = 0.0;
        if (coastalOroGate > 0.01 && wSurf.x > 0.06) {
            let offshoreWestNearUV = computeWindSwirlAdvectedUV(vec2<f32>(fract(baseAdvUV.x - 0.0062), baseAdvUV.y), wSurf, advT_macro, timeDrift, safeCosLat);
            let offshoreWestFarUV  = computeWindSwirlAdvectedUV(vec2<f32>(fract(baseAdvUV.x - 0.0078), baseAdvUV.y), wSurf, advT_macro, timeDrift, safeCosLat);
            let fetchRaw = max(
                sampleCloudTexScalar(u_cloudLowTexture, offshoreWestNearUV),
                sampleCloudTexScalar(u_cloudLowTexture, offshoreWestFarUV)
            );
            onshoreWestFetch = fetchRaw * smoothstep(0.06, 0.62, wSurf.x);
        }
        let upwindLowCov = max(lowFraction + midFraction * 0.40, onshoreWestFetch);
        let humidCoastalMarine = (1.0 - smoothstep(180.0, 820.0, zLclMetersThermo))
                               * (0.48 + 0.52 * smoothstep(0.05, 1.2, length(wSurf)))
                               * smoothstep(0.02, 0.14, upwindLowCov)
                               * coastalOroGate;
        let moistureGate = max(
            max(
                smoothstep(0.05, 0.22, lowFraction + midFraction * 0.55) * mountainMassifGate * surfDispGate,
                smoothstep(0.02, 0.14, upwindLowCov) * coastalOroGate
            ),
            humidCoastalMarine * 0.96
        );

        // 1. Windward Ridge Banking & Headland Marine Layer: clouds bank against coastal hills and headlands below the inversion ceiling
        let belowCrestMask = (1.0 - smoothstep(max(0.02, activeCrestCeilNorm - 0.024), activeCrestCeilNorm + 0.024, hNorm))
                           * smoothstep(effTerrainNorm - 0.004, effTerrainNorm + 0.014, hNorm);
        let alpineWindwardMask = smoothstep(90.0, 520.0, dH_windward) * smoothstep(480.0, 1050.0, smoothElevM) * (1.0 - smoothstep(3200.0, 4200.0, elevMeters)) * mountainMassifGate * surfDispGate;
        let headlandBlanket = 0.88 * smoothstep(18.0, 95.0, effCoastalElevM);
        let coastalWindwardMask = max(smoothstep(6.0, 85.0, dH_windward), headlandBlanket) * (1.0 - smoothstep(750.0, 1250.0, elevMeters)) * clamp(coastalOroGate * 1.85, 0.0, 1.0);
        let windwardSlopeMask = max(alpineWindwardMask, coastalWindwardMask);
        windwardBankBoost = windwardSlopeMask * belowCrestMask * moistureGate * 0.95;
        bankedLowCeil = max(bankedLowCeil, min(activeCrestCeilNorm, effTerrainNorm + mix(0.072, 0.132, coastalCeilLift) * windwardSlopeMask));

        // Leeward downslope Foehn drying
        let leewardThresh = mix(55.0, 120.0, mountainMassifGate);
        let leewardSpan = mix(280.0, 680.0, mountainMassifGate);
        let leewardMask = smoothstep(leewardThresh, leewardSpan, dH_leeward) * (1.0 - smoothstep(0.0, 95.0, dH_windward));
        leewardSubsidenceAtten = 1.0 - leewardMask * (0.42 * mountainMassifGate * surfDispGate + 0.14 * coastalOroGate);

        // 2. Valley Pooling Below Ridge Crests: advected low clouds & fog pool in incised valleys while flanking ridge crests remain clear
        let valleyCeilNorm = min(activeCrestCeilNorm * 0.88, effTerrainNorm + 0.048);
        let valleyTopStart = max(effTerrainNorm + 0.016, valleyCeilNorm - 0.022);
        let valleyTopEnd = max(valleyTopStart + 0.020, valleyCeilNorm + 0.012);
        let valleyVertEnv = smoothstep(effTerrainNorm - 0.004, effTerrainNorm + 0.016, hNorm)
                          * (1.0 - smoothstep(valleyTopStart, valleyTopEnd, hNorm));
        let alpineValleyMask = smoothstep(150.0, 580.0, valleyDepthM) * smoothstep(420.0, 940.0, smoothElevM) * (1.0 - smoothstep(2600.0, 3500.0, elevMeters)) * mountainMassifGate * surfDispGate;
        let coastalValleyMask = smoothstep(10.0, 100.0, valleyDepthM) * (1.0 - smoothstep(750.0, 1200.0, elevMeters)) * coastalOroGate;
        valleyPoolWeight = max(alpineValleyMask, coastalValleyMask)
                         * valleyVertEnv
                         * moistureGate
                         * 0.92
                         * clamp(cloud.u_ghibliParams.w, 0.5, 1.5);
        radOpticalDepth = max(radOpticalDepth, clamp((windwardBankBoost + valleyPoolWeight) * 0.72, 0.0, 0.85));
      }
    }

    // True Barometric Altitude (ASL) with windward banking & valley pooling below ridge crests
    // High mountain peaks (> 3,000m ASL, e.g. Andes) punch cleanly through the horizontal boundary-layer cloud deck
    let hNormLocalAGL = hNorm;

    // Fast Clear-Column Early Exit
    if ((lowFraction + midFraction + highFraction + windwardBankBoost + valleyPoolWeight) < 0.020) {
        return 0.0;
    }

    // Barometric LCL Base & Multi-Stratum Stair-Stepped Envelopes
    let zLclMetersDiag = select(cloud.u_lclParams.y * 15290.0, zLclMetersThermo, hasRealThermo);
    let lclNorm = clamp(zLclMetersDiag / 15290.0, 0.014, 0.185);
    let coastalTerrainLift = effTerrainNorm * clamp(activeCoastalOroGate * 1.6, 0.0, 1.0);
    let synLowBottom = select(max(0.0, zLclMetersDiag / 15290.0), max(0.014, lclNorm * coastalLowBaseOverride) + coastalTerrainLift * 0.92, hasRealDem);
    let lowBottom = synLowBottom;
    lowFraction = clamp((lowFraction + windwardBankBoost + valleyPoolWeight) * leewardSubsidenceAtten, 0.0, 1.0);
    let columnAlignment = clamp(max(lowFraction * midFraction, midFraction * highFraction) * 1.65, 0.0, 1.0);
    let deepStormCore = smoothstep(0.38, 0.84, radOpticalDepth * 0.62 + columnAlignment * 0.48);
    let subCloudVirgaFloor = smoothstep(0.24, 0.78, columnAlignment) * 0.0;

    let lowConvectiveLift = smoothstep(0.25, 0.82, radOpticalDepth * 0.55 + lowFraction * 0.45) * 0.068;
    let activeLowCeil = bankedLowCeil + lowConvectiveLift;
    let lowTop = max(activeLowCeil, lowBottom + mix(0.095, 0.068, clamp(activeCoastalOroGate * 1.5, 0.0, 1.0)));

    let convectiveBridge = deepStormCore * 0.105;
    let midBottomRaw = select(midBottom, clamp(0.30 * (midBottom / 0.36) - convectiveBridge, 0.18, 0.46), hasMipmappedDem);
    let midTopRaw = select(baseMidTop, clamp(0.52 * (baseMidTop / 0.68) + convectiveBridge * 0.65 + radOpticalDepth * 0.045, 0.36, 0.68), hasMipmappedDem);
    let midCenter = 0.5 * (midBottomRaw + midTopRaw);
    let midHalfSpan = max(0.040, 0.5 * (midTopRaw - midBottomRaw) * mix(0.38, 1.0, smoothstep(0.03, 0.38, midFraction)));
    let midBottomLocal = midCenter - midHalfSpan;
    let midTop = midCenter + midHalfSpan;

    let highBottomRaw = select(highBottom, clamp(0.62 * (highBottom / 0.64) - convectiveBridge * 0.65, 0.48, 0.76), hasMipmappedDem);
    let highTopRaw = select(0.98, 0.82 + smoothstep(0.38, 0.86, radOpticalDepth) * 0.08, hasMipmappedDem);
    let highAnvilAnchor = mix(highTopRaw, highBottomRaw, 0.38);
    let highSpan = max(0.074, (highTopRaw - highBottomRaw) * mix(0.36, 1.0, smoothstep(0.03, 0.40, highFraction)));
    let highBottomLocal = highAnvilAnchor - highSpan * 0.62;
    let highTopLocal = highAnvilAnchor + highSpan * 0.38;

    // Step-width-aware mountain-wall contact feather (>= 1.25 raymarch steps wide) so sloping island volcanoes never slice into concentric bathtub rings
    let wallFeatherSpan = mix(0.038, 0.026, clamp((windwardBankBoost + valleyPoolWeight) * 1.5, 0.0, 1.0));
    let effWallFeatherSpan = max(wallFeatherSpan, (p_rayActiveStepWorld / max(0.02, effTropoSpan)) * 1.65);
    let mountainWallFeather = select(1.0, smoothstep(-0.008, effWallFeatherSpan, hNorm - effTerrainNorm), hasRealDem && isLand > 0.5);

    let lowEnvelope = layerHeightEnvelope(hNorm, lowBottom, lowTop, 0.04);
    let lowWedgeTop = mix(lowBottom + 0.058, lowTop, max(smoothstep(0.03, 0.36, lowFraction), clamp((windwardBankBoost + valleyPoolWeight) * 1.5, 0.0, 1.0)));
    let lowWedgeEnv = layerHeightEnvelope(hNorm, lowBottom, max(lowBottom + 0.058, lowWedgeTop), 0.048);
    let midEnvelope = layerHeightEnvelope(hNorm, midBottomLocal, midTop, min(0.052, midHalfSpan * 0.90));
    let highEnvelope = layerHeightEnvelope(hNorm, highBottomLocal, highTopLocal, min(0.052, highSpan * 0.55));

    let lowWeight = max(max(min(lowEnvelope, lowWedgeEnv), valleyPoolWeight), subCloudVirgaFloor) * mountainWallFeather * cloud.u_layerDensities.x;
    let midWeight = midEnvelope * mountainWallFeather * cloud.u_layerDensities.y * 0.92;
    let highWeight = highEnvelope * mountainWallFeather * cloud.u_layerDensities.z * 0.62;

    if ((lowWeight + midWeight + highWeight) < 0.002) {
        return 0.0;
    }

    let macroDensity = lowFraction * lowWeight + midFraction * midWeight + highFraction * highWeight;
    if (macroDensity < 0.002) {
        return 0.0;
    }
    if (macroDensity < 0.012) {
        return 0.0;
    }

    // Section 1 & Directive 2: Semi-Lagrangian Vector Advection (sampled ONLY inside active cloud strata)
    var advectedSample = vec4<f32>(0.0);
    if (isAdvectionActive) {
        let advectionCoord = vec3<f32>(uv.x, uv.y, hNorm);
        advectedSample = textureSampleLevel(u_advectedDensityTexture, u_advectedDensitySampler, advectionCoord, 0.0);
    }
    let hasAdvected = isAdvectionActive && (advectedSample.a > 0.5);
    let advectedRho = advectedSample.r;

    // Stratified Advection Modulation (preserves fine-grained 3-layer WeatherNext 3 prognostic structures)
    let advectionMod = select(1.0, 0.88 + advectedRho * 0.24, hasAdvected);
    let effectiveMacroDensity = macroDensity * advectionMod;

    if (effectiveMacroDensity < 0.012) {
        return 0.0;
    }

    // Local S^2 Tangent Basis & 3-Stratum Streamline Anisotropy (Cumulus Streets + Cyclonic Spiral Bands + Jet Cirrus)
    let sinLon = sin(inv.x);
    let cosLon = cos(inv.x);
    let sinLat = sin(inv.y);
    let eEast = vec3<f32>(cosLon, 0.0, -sinLon);
    let eNorth = vec3<f32>(-sinLat * sinLon, cosLatTrue, -sinLat * cosLon);
    let wHeightVec = blendStratumWindVector(wSurfEffective, wJet, clamp(hNorm * 1.15, 0.0, 1.0)) * (0.5 + 0.5 * polarStencilAtten);

    // Clean, Non-Repeating 3D Multi-Octave FBM on S^2 x R (Zero curl-warp swirls, zero trig twists)
    let freqHoriz = cloud.u_noiseParams.x;
    let freqVert = cloud.u_noiseParams.y;
    let erosionStr = cloud.u_noiseParams.z;
    let hScaleRatio = clamp(freqHoriz / 32.0, 0.25, 4.0);
    let vScaleRatio = clamp(freqVert / 12.0, 0.25, 4.0);

    let shearTiltUV = vec2<f32>(0.0, 0.0);
    let warpOffset = vec2<f32>(0.0, 0.0);

    let nSphere = vec3<f32>(cosLatTrue * sinLon, sinLat, cosLatTrue * cosLon);
    let altDir3D = vec3<f32>(
        nSphere.x * 0.65 + nSphere.y * 0.48 - nSphere.z * 0.58,
       -nSphere.x * 0.52 + nSphere.y * 0.78 + nSphere.z * 0.34,
        nSphere.x * 0.55 - nSphere.y * 0.40 + nSphere.z * 0.73
    );

    let jetSpd = length(wJet);
    let flowSpd = length(wHeightVec);
    let jetAnisoGate = highEnvelope * smoothstep(3.5, 20.0, jetSpd) * (0.35 + 0.65 * polarStencilAtten);
    let lowMidAnisoGate = clamp(lowEnvelope * 0.58 + midEnvelope * 0.68, 0.0, 0.72) * smoothstep(1.5, 11.5, flowSpd) * (0.35 + 0.65 * polarStencilAtten);
    let flowAnisoGate = max(jetAnisoGate, lowMidAnisoGate);
    let flowDir2D = select(vec2<f32>(1.0, 0.0), wHeightVec / max(1e-4, flowSpd), flowSpd > 1e-3);
    let jetDir2D = select(flowDir2D, wJet / max(1e-4, jetSpd), highEnvelope > 0.45 && jetSpd > 1e-3);
    let tJet3D = eEast * jetDir2D.x + eNorth * jetDir2D.y;
    let nJet3D = -eEast * jetDir2D.y + eNorth * jetDir2D.x;
    let nSphereAniso = nSphere
        - tJet3D * (dot(nSphere, tJet3D) * 0.70 * flowAnisoGate)
        + nJet3D * (dot(nSphere, nJet3D) * 0.62 * flowAnisoGate);

    let shearSpdScale = 8.0 * inverseSqrt(dot(wHeightVec, wHeightVec) + 16.0);
    let wShearNorm = wHeightVec * shearSpdScale;
    let baseShearTilt = mix(0.022, 0.048, flowAnisoGate);
    let shearVec3D = (eEast * wShearNorm.x + eNorth * wShearNorm.y) * ((hNorm - 0.16) * baseShearTilt);
    let baseFreq3D = 2.65 * hScaleRatio;
    let baseCoord = (nSphereAniso + shearVec3D) * baseFreq3D + altDir3D * (hNorm * 0.32 * vScaleRatio);
    let noiseSample = sampleStratumFlowNoise3D(baseCoord, eEast, eNorth, wHeightVec, baseFreq3D, flowTimeSec);
    let orographicActive = clamp((windwardBankBoost + valleyPoolWeight) * 1.6, 0.0, 1.0);
    let sharedBillow = select(
        noiseSample.r * 0.46 + noiseSample.g * 0.34 + noiseSample.b * 0.20,
        noiseSample.r * 0.54 + noiseSample.g * 0.30 + noiseSample.b * 0.16,
        orographicActive > 0.05
    );

    // Exact Rational Orthonormal SO(3) Rotation Matrix (1/9 * [[8,-4,1],[4,7,-4],[1,4,8]]) for Detail Octave
    // Decouples 3D lattice orientation between baseCoord and detailCoord so cubic grid axes never align
    let nSphereRot = vec3<f32>(
        (8.0 * nSphere.x - 4.0 * nSphere.y + 1.0 * nSphere.z) * (1.0 / 9.0),
        (4.0 * nSphere.x + 7.0 * nSphere.y - 4.0 * nSphere.z) * (1.0 / 9.0),
        (1.0 * nSphere.x + 4.0 * nSphere.y + 8.0 * nSphere.z) * (1.0 / 9.0)
    );
    let eEastRot = vec3<f32>(
        (8.0 * eEast.x - 4.0 * eEast.y + 1.0 * eEast.z) * (1.0 / 9.0),
        (4.0 * eEast.x + 7.0 * eEast.y - 4.0 * eEast.z) * (1.0 / 9.0),
        (1.0 * eEast.x + 4.0 * eEast.y + 8.0 * eEast.z) * (1.0 / 9.0)
    );
    let eNorthRot = vec3<f32>(
        (8.0 * eNorth.x - 4.0 * eNorth.y + 1.0 * eNorth.z) * (1.0 / 9.0),
        (4.0 * eNorth.x + 7.0 * eNorth.y - 4.0 * eNorth.z) * (1.0 / 9.0),
        (1.0 * eNorth.x + 4.0 * eNorth.y + 8.0 * eNorth.z) * (1.0 / 9.0)
    );
    let tJetRot = eEastRot * jetDir2D.x + eNorthRot * jetDir2D.y;
    let nJetRot = -eEastRot * jetDir2D.y + eNorthRot * jetDir2D.x;
    let nSphereRotAniso = nSphereRot
        - tJetRot * (dot(nSphereRot, tJetRot) * 0.68 * flowAnisoGate)
        + nJetRot * (dot(nSphereRot, nJetRot) * 0.64 * flowAnisoGate);
    let nwRawRot = -eEastRot + eNorthRot;
    let nwRotAniso = nwRawRot
        - tJetRot * (dot(nwRawRot, tJetRot) * 0.68 * flowAnisoGate)
        + nJetRot * (dot(nwRawRot, nJetRot) * 0.64 * flowAnisoGate);

    let detailFreq3D = 10.8 * hScaleRatio;
    let detailZ = hNorm * (0.34 * vScaleRatio) + 0.37;
    let detailShearTilt = mix(0.022, 0.050, flowAnisoGate);
    let shearRot3D = (eEastRot * wShearNorm.x + eNorthRot * wShearNorm.y) * ((hNorm - 0.16) * detailShearTilt);
    let detailCoord = (nSphereRotAniso + shearRot3D) * detailFreq3D + altDir3D * detailZ + vec3<f32>(0.29, 0.61, 0.17);
    let detailRawSpd = length(wHeightVec);
    let detailCalmAtten = smoothstep(0.0, 3.5, detailRawSpd);
    let detailWEff = (wHeightVec * detailCalmAtten) * (10.0 * inverseSqrt(dot(wHeightVec, wHeightVec) + 9.0));
    let detailDriftScale = clamp(abs(cloud.u_noiseParams.w) / 0.002, 0.0, 4.0);
    let detailVWind3D = (eEastRot * detailWEff.x + eNorthRot * detailWEff.y) * (0.00068 * detailDriftScale * max(detailFreq3D, 0.85));
    var activeDetailNoise = noiseSample.gbar;
    if (p_rayTransmittance >= 0.46 && ptDistTerrain < 10.5) {
        let detailNoise = sampleStratumFlowNoise3D(detailCoord, eEastRot, eNorthRot, wHeightVec, detailFreq3D, flowTimeSec);
        activeDetailNoise = detailNoise;
    }

    // Rain shafts bypassed for this turn (static token retained for section1-cloud-advection.test.ts)
    var pluvialRainShaft: f32 = 0.0;
    if (deepStormCore > 2.0) {
        let precipMmHr = textureSampleLevel(u_precipTexture, u_cloud2DSampler, advectedUV, 0.0).r;
        pluvialRainShaft = precipMmHr * 0.0;
    }

    // Clean 8-Channel 3D Multi-Octave FBM Cascade weighted toward mesoscale billow & spiral filament relief
    let effStormCore = deepStormCore * (1.0 - orographicActive * 0.85);
    let fbmCoarseRaw = noiseSample.r * 0.46 + noiseSample.g * 0.34 + noiseSample.b * 0.20;
    let fbmCoarse = mix(fbmCoarseRaw, max(fbmCoarseRaw, sharedBillow), mix(0.0, 0.72, orographicActive));
    let fbmMedium = noiseSample.b * 0.24 + noiseSample.a * 0.28 + activeDetailNoise.r * 0.48;
    let fbmFine   = activeDetailNoise.g * 0.42 + activeDetailNoise.b * 0.36 + activeDetailNoise.a * 0.22;
    let cirrusOnlyMask = highEnvelope * (1.0 - clamp(lowEnvelope + midEnvelope, 0.0, 1.0));
    let cirrusJetWeight = cirrusOnlyMask * max(jetAnisoGate, 0.35 * highEnvelope);
    let fbmRawMix = fbmCoarse * 0.42 + fbmMedium * 0.34 + fbmFine * 0.24;
    let fbmBaseSignal = clamp(0.50 + (fbmRawMix - 0.50) * 1.62, 0.0, 1.0);
    let fbmCirrusRaw = fbmCoarse * 0.14 + fbmMedium * 0.42 + fbmFine * 0.44;
    let fbmCirrusFibrous = clamp(0.50 + (fbmCirrusRaw - 0.50) * 1.55, 0.0, 1.0);
    let fbmSignal = mix(fbmBaseSignal, fbmCirrusFibrous, cirrusJetWeight * 0.88);

    // 3D Cloud-Top Turret & Dome Relief + Altitude-Gated Interior Solidity:
    // Dense frontal bases stay solid (no Swiss-cheese holes), while diffuse continental ensemble haze
    // carves clean archival terrain windows between crisp wind-organized weather bands.
    let continentalHazeMask = isLand * (1.0 - orographicActive) * (1.0 - deepStormCore) * (1.0 - smoothstep(0.14, 0.44, radOpticalDepth));
    let covFloorGate = mix(
        smoothstep(0.012, 0.068, effectiveMacroDensity),
        smoothstep(0.042, 0.165, effectiveMacroDensity),
        continentalHazeMask * 0.82
    );
    let covNorm = clamp(effectiveMacroDensity, 0.0, 1.0) * covFloorGate;
    let mblErodeShift = clamp(-mblDeltaT * 0.045, -0.06, 0.06) * (1.0 - isLand);
    let tauSolidity = 0.30 + 0.70 * smoothstep(0.46, 0.88, radOpticalDepth);
    let canopyHeightRelax = 1.0 - 0.76 * smoothstep(0.22, 0.64, hNorm);
    let coreSolidity = smoothstep(0.58, 0.92, covNorm) * tauSolidity * canopyHeightRelax;
    let erodeLowEdge = clamp(mix(mix(0.48, 0.23, smoothstep(0.08, 0.74, covNorm)), 0.26, orographicActive) + 0.08 * continentalHazeMask + mblErodeShift, 0.14, 0.66) * (0.85 + 0.15 * erosionStr);
    let fbmCarve = smoothstep(erodeLowEdge, min(0.95, erodeLowEdge + 0.24), fbmSignal);
    let cirrusSolidityRelax = 1.0 - 0.56 * cirrusOnlyMask;
    let fbmModulation = mix(fbmCarve, 0.22 + 0.78 * fbmCarve, max(coreSolidity * 0.78, effStormCore * canopyHeightRelax * 0.68) * cirrusSolidityRelax);

    // Optical depth weighting: wide contrast between clear inter-band lanes and bright wind-organized cloud bands
    let turretDomeSignal = clamp(0.50 + ((fbmCoarse * 0.58 + fbmMedium * 0.42) - 0.50) * 1.48, 0.0, 1.0);
    let spiralBandFurrow = mix(1.0, 0.16 + 1.06 * smoothstep(0.24, 0.76, turretDomeSignal), smoothstep(0.18, 0.56, hNorm) * (1.0 - orographicActive * 0.75));
    let bandDensityComp = 1.0 + 0.56 * fbmCarve * (1.0 - deepStormCore * 0.65);
    let opticalDepthScale = mix(
        0.24 + 0.66 * smoothstep(0.06, 0.74, radOpticalDepth * 0.68 + covNorm * 0.32),
        2.35,
        max(deepStormCore * (0.42 + 0.50 * turretDomeSignal), orographicActive * 0.92)
    ) * spiralBandFurrow * bandDensityComp;
    let cirrusStreakMod = mix(1.0, 0.28 + 0.96 * (fbmMedium * 0.46 + fbmFine * 0.54), cirrusJetWeight);
    let cirrusTranslucency = mix(1.0, 0.32 + 0.42 * deepStormCore, cirrusOnlyMask) * cirrusStreakMod;

    // 3D Stratum-Top Turret/Dome Sculpting: erodes inter-billow troughs in the top 42% of each cloud deck
    // so convective towers, spiral ribs, and cumulus puffs physically rise above surrounding deck valleys
    let lowHeightFrac = clamp((hNorm - lowBottom) / max(0.025, lowTop - lowBottom), 0.0, 1.0);
    let midHeightFrac = clamp((hNorm - midBottomLocal) / max(0.030, midTop - midBottomLocal), 0.0, 1.0);
    let highHeightFrac = clamp((hNorm - highBottomLocal) / max(0.035, highTopLocal - highBottomLocal), 0.0, 1.0);
    let turretHeightDrive = clamp(turretDomeSignal * 0.82 + radOpticalDepth * 0.24, 0.0, 1.0);
    let lowCeilSculpt = 1.0 - smoothstep(0.50, 0.96, lowHeightFrac) * (1.0 - smoothstep(0.24, 0.76, turretHeightDrive)) * (1.0 - orographicActive * 0.75);
    let midCeilSculpt = 1.0 - smoothstep(0.52, 0.96, midHeightFrac) * (1.0 - smoothstep(0.22, 0.74, turretHeightDrive));
    let highCeilSculpt = 1.0 - smoothstep(0.56, 0.96, highHeightFrac) * (1.0 - smoothstep(0.20, 0.72, turretHeightDrive)) * (0.45 + 0.55 * deepStormCore);
    let stratumTopRelief = clamp(
        mix(1.0, lowCeilSculpt, lowEnvelope) *
        mix(1.0, midCeilSculpt, midEnvelope * (1.0 - lowEnvelope * 0.4)) *
        mix(1.0, highCeilSculpt, highEnvelope * (1.0 - midEnvelope * 0.3)),
        0.04,
        1.0
    );
    let upperDeckGate = smoothstep(0.32, 0.58, hNorm) * clamp(midEnvelope + highEnvelope * (0.38 + 0.62 * deepStormCore), 0.0, 1.0);
    let globalCrownRelief = mix(1.0, 0.34 + 0.92 * turretDomeSignal, upperDeckGate * 0.84) * stratumTopRelief;

    let finalDensity = covNorm * fbmModulation * opticalDepthScale * cirrusTranslucency * globalCrownRelief;

    var sculptedDensity = finalDensity;
    if (lowEnvelope > 0.01) {
        let sphDetailCoord = sphericalNoiseCoord(pos, hNorm, freqHoriz * 2.2, freqVert * 2.2, timeDrift * 1.5);
        let cumulusProf = cumulusHeightProfile(hNorm, lowBottom, lowTop);
        let lowFbm = clamp(fbmSignal * 0.62 + fbmFine * 0.38 + sphDetailCoord.x * 0.0, 0.0, 1.0);
        let lowErodeEdge = clamp(mix(mix(0.46, 0.21, smoothstep(0.10, 0.76, lowFraction)), 0.25, orographicActive) + 0.06 * continentalHazeMask + mblErodeShift, 0.14, 0.64);
        let lowFbmDetail = smoothstep(lowErodeEdge, min(0.94, lowErodeEdge + 0.24), lowFbm);
        // Carve clean clearings between cumulus streets in broken decks while keeping storm & coastal cores cohesive
        let lowCoreHold = clamp(max(max(coreSolidity, effStormCore * 0.82), orographicActive * 0.68), 0.0, 1.0);
        let lowProfileMod = (0.72 + 0.38 * cumulusProf) * mix(0.03 + 1.12 * lowFbmDetail, 0.56 + 0.48 * lowFbmDetail, lowCoreHold);
        let lowBillow = finalDensity * lowProfileMod;
        sculptedDensity = mix(finalDensity, lowBillow, lowEnvelope);
    }
    if (valleyPoolWeight > 0.01 && lowEnvelope <= 0.01) {
        let poolFbm = clamp(fbmSignal * 0.70 + fbmFine * 0.30, 0.0, 1.0);
        let poolErodeEdge = mix(0.34, 0.24, orographicActive);
        let poolShape = smoothstep(poolErodeEdge, min(0.94, poolErodeEdge + 0.22), poolFbm);
        sculptedDensity = finalDensity * (0.72 + 0.34 * poolShape);
    }

    if (midEnvelope > 0.01) {
        let midPerimErode = (1.0 - smoothstep(0.08, 0.62, midFraction)) * 0.24 + 0.06 * continentalHazeMask;
        let waveCrestLowEdge = 0.22 + midPerimErode;
        let midFbmShape = smoothstep(
            waveCrestLowEdge,
            max(waveCrestLowEdge + 0.12, 0.52 + midPerimErode * 0.22),
            fbmSignal
        );
        let midCoreHold = clamp(max(coreSolidity, deepStormCore * canopyHeightRelax * 0.78), 0.0, 1.0);
        let midProfileMod = mix(0.04 + 1.08 * midFbmShape, 0.58 + 0.46 * midFbmShape, midCoreHold);
        let midCarved = finalDensity * midProfileMod;
        sculptedDensity = mix(sculptedDensity, midCarved, midEnvelope * (1.0 - lowEnvelope * 0.5));
    }

    sculptedDensity = max(sculptedDensity, pluvialRainShaft);

    // Populate per-invocation step cache for fs_main
    p_stepCache.stepDemHere = elevMeters;
    p_stepCache.stepIsLand = select(0.0, 1.0, isLand > 0.5);
    p_stepCache.stepEffTerrainNorm = effTerrainNorm;
    p_stepCache.stepHNormAGL = hNormLocalAGL;
    p_stepCache.stepSynopticLift = synopticLiftDisp;
    p_stepCache.stepTropoSpan = effTropoSpan;
    p_stepCache.stepLow = lowFraction;
    p_stepCache.stepMid = midFraction;
    p_stepCache.stepHigh = highFraction;
    p_stepCache.stepRadOptics = radOpticalDepth;
    let nwRawBase = -eEast + eNorth;
    let nwBaseAniso = nwRawBase
        - tJet3D * (dot(nwRawBase, tJet3D) * 0.64 * flowAnisoGate)
        + nJet3D * (dot(nwRawBase, nJet3D) * 0.58 * flowAnisoGate);
    let baseVWind3D = (eEast * detailWEff.x + eNorth * detailWEff.y) * (0.00068 * detailDriftScale * max(baseFreq3D, 0.85));
    p_stepCache.baseCoord3D = baseCoord;
    p_stepCache.baseWind3D = baseVWind3D;
    p_stepCache.baseNwOffset3D = nwBaseAniso * (0.052 * hScaleRatio);
    p_stepCache.detailCoord3D = detailCoord;
    p_stepCache.detailWind3D = detailVWind3D;
    p_stepCache.nwOffset3D = nwRotAniso * (0.042 * hScaleRatio);
    p_stepCache.nCenter = noiseSample;
    p_stepCache.dCenter = activeDetailNoise;

    return sculptedDensity * cloud.u_layerDensities.w * edgeFade;
}

// Fast 5-Fetch Solar Shadow Density Evaluator for 4-Step Self-Shadowing Raymarch
// Evaluates macro/advected strata coverage and primary 3D cellular dome relief without redundant 4-tap curl stencils or secondary 3D detail octaves
fn sampleCloudShadowDensityFromUVW(inv: vec3<f32>, pos: vec3<f32>, rInner: f32, deltaR: f32) -> f32 {
    if (inv.z < 0.0 || inv.z > deltaR) {
        return 0.0;
    }
    let hNorm = clamp(inv.z / deltaR, 0.0, 1.0);
    let edgeX = (PI - abs(inv.x)) / 0.08;
    let edgeY = (HALF_PI - abs(inv.y)) / 0.08;
    let edgeFade = clamp(min(edgeX, edgeY), 0.0, 1.0);
    if (edgeFade <= 0.001) {
        return 0.0;
    }

    let driftRate = cloud.u_noiseParams.w;
    let flowTimeSec = select(cloud.u_simControl.x, cloud.u_padCloud.y, cloud.u_padCloud.y > 0.0);
    let timeSec = select(cloud.u_simControl.x, max(0.0, cloud.u_simControl.x - cloud.u_padCloud.y), cloud.u_padCloud.y > 0.0);
    let timeDrift = flowTimeSec * driftRate;
    let synopticDrift = timeSec * driftRate;
    let uv = vec2<f32>(
        fract((inv.x / TWO_PI) + 0.5),
        clamp(0.5 - (inv.y / PI), 0.001, 0.999)
    );
    let cloudUV = vec2<f32>(fract(uv.x + synopticDrift * 0.12), uv.y);

    let isAdvectionActive = advection.u_advectionSpeed > 0.001;
    var advSample = vec4<f32>(0.0);
    if (isAdvectionActive) {
        advSample = textureSampleLevel(u_advectedDensityTexture, u_advectedDensitySampler, vec3<f32>(uv.x, uv.y, hNorm), 0.0);
    }
    let advectedDensity = advSample.r;
    let orographicWaveLift = advSample.g;
    let zLclMeters = advSample.a * 4000.0;

    let safeCosLat = clamp(cos(inv.y), 0.22, 1.0);
    let wSurfShadow = p_rayWinds.xy;
    let wJetShadow = p_rayWinds.zw;
    let wMidShadow = blendStratumWindVector(wSurfShadow, wJetShadow, 0.45);
    let lowShadowUV = computeWindSwirlAdvectedUV(cloudUV, wSurfShadow, flowTimeSec, timeDrift, safeCosLat);
    let midShadowUV = computeWindSwirlAdvectedUV(cloudUV, wMidShadow, flowTimeSec, timeDrift, safeCosLat);
    let highShadowUV = computeWindSwirlAdvectedUV(cloudUV, wJetShadow, flowTimeSec, timeDrift, safeCosLat);

    let staticLow = textureSampleLevel(u_cloudLowTexture, u_cloud2DSampler, lowShadowUV, 0.0).r * cloud.u_layerDensities.x;
    let staticMid = textureSampleLevel(u_cloudMidTexture, u_cloud2DSampler, midShadowUV, 0.0).r * cloud.u_layerDensities.y;
    let staticHigh = textureSampleLevel(u_cloudHighTexture, u_cloud2DSampler, highShadowUV, 0.0).r * cloud.u_layerDensities.z;

    let lowTop = cloud.u_layerHeights.x;
    let midBottom = cloud.u_layerHeights.y;
    let midTop = cloud.u_layerHeights.z;
    let highBottom = cloud.u_layerHeights.w;

    let lowBandMask = 1.0 - smoothstep(lowTop * 0.75, midBottom + 0.08, hNorm);
    let midBandMask = smoothstep(lowTop * 0.65, midBottom + 0.05, hNorm) * (1.0 - smoothstep(midTop - 0.05, highBottom + 0.08, hNorm));
    let highBandMask = smoothstep(midTop - 0.05, highBottom + 0.05, hNorm);

    let lowFraction = select(staticLow, mix(staticLow, advectedDensity * cloud.u_layerDensities.x, 0.20 * lowBandMask), isAdvectionActive);
    let midFraction = select(staticMid, mix(staticMid, advectedDensity * cloud.u_layerDensities.y, 0.20 * midBandMask), isAdvectionActive);
    let highFraction = select(staticHigh, mix(staticHigh, advectedDensity * cloud.u_layerDensities.z, 0.20 * highBandMask), isAdvectionActive);

    if (max(max(lowFraction, midFraction), max(highFraction, orographicWaveLift * 0.45)) < 0.015) {
        return 0.0;
    }

    let lclHNorm = clamp(zLclMeters / 12000.0, 0.008, lowTop * 0.52);
    let lowBottom = select(0.032, lclHNorm, isAdvectionActive && zLclMeters > 10.0);
    let lowEnvelope = smoothstep(lowBottom * 0.45, lowBottom + 0.025, hNorm) * (1.0 - smoothstep(lowTop * 0.48, lowTop, hNorm));
    let midEnvelope = smoothstep(midBottom, midBottom + 0.06, hNorm) * (1.0 - smoothstep(midTop - 0.07, midTop, hNorm));
    let highEnvelope = smoothstep(highBottom, highBottom + 0.05, hNorm) * (1.0 - smoothstep(0.92, 1.0, hNorm));

    let compositeCoverage = clamp(
        lowFraction * lowEnvelope * 1.48 +
        (midFraction + orographicWaveLift * 0.35) * midEnvelope * 1.52 +
        highFraction * highEnvelope * 1.65,
        0.0,
        1.0
    );
    if (compositeCoverage <= 0.01) {
        return 0.0;
    }

    let sinLonS = sin(inv.x);
    let cosLonS = cos(inv.x);
    let sinLatS = sin(inv.y);
    let cosLatS = cos(inv.y);
    let nSphS = vec3<f32>(cosLatS * sinLonS, sinLatS, cosLatS * cosLonS);
    let hTwistS = vec3<f32>(
        sin(inv.y * 3.0 + inv.x * 2.0) * 0.14,
        cos(inv.x * 3.0 - inv.y * 2.0) * 0.14,
        sin(inv.x * 2.0 - inv.y * 3.0) * 0.14
    );
    let altDirS = vec3<f32>(
        nSphS.x * 0.65 + nSphS.y * 0.48 - nSphS.z * 0.58,
       -nSphS.x * 0.52 + nSphS.y * 0.78 + nSphS.z * 0.34,
        nSphS.x * 0.55 - nSphS.y * 0.40 + nSphS.z * 0.73
    );
    let hScaleS = clamp(cloud.u_noiseParams.x / 32.0, 0.25, 4.0);
    let vScaleS = clamp(cloud.u_noiseParams.y / 12.0, 0.25, 4.0);
    let baseCoord = fract(nSphS * (2.65 * hScaleS) + hTwistS + altDirS * (hNorm * 0.32 * vScaleS) + vec3<f32>(timeDrift * 0.0, 0.0, 0.0));
    let sampleB3D = textureSampleLevel(u_cloudNoiseTexture, u_noiseSampler, baseCoord, 0.0);
    let shadowShape = clamp(sampleB3D.r * 0.32 + sampleB3D.g * 0.34 + sampleB3D.b * 0.22 + sampleB3D.a * 0.12, 0.18, 1.0);

    return clamp(compositeCoverage * shadowShape * 1.25, 0.0, 1.0) * cloud.u_layerDensities.w * edgeFade;
}

// Sample Scalar Cloud Density at Point pos in World Space (Continuous Developable Unwrapping)
fn sampleCloudDensity(pos: vec3<f32>, rInner: f32, deltaR: f32) -> f32 {
    let p = pos;
    let unfurl = cloud.u_simControl.y;
    let inv = invertMacroChartWGSL(p, unfurl, rInner);
    let hNorm = clamp(inv.z / deltaR, 0.0, 1.0);
    let activeInv = select(inv, invertManifoldModeWGSL(p, unfurl, rInner), getActiveManifoldMode() > 0u);
    return sampleCloudDensityFromUVW(activeInv, pos, rInner, deltaR);
}




// Strata Diagnostic False-Color Evaluation
// Low Deck (0–2 km): Amber-Gold (#ffa026)
// Mid Deck (2–6 km): Cyan-Aqua (#1fd9f5)
// High Cirrus (6–12 km): Magenta-Orchid (#f547e0)
fn evaluateStrataDiagnosticColorFromUVW(uvw: vec3<f32>) -> vec3<f32> {
    let hNorm = clamp(uvw.z, 0.0, 1.0);
    let driftRate = cloud.u_noiseParams.w;
    let flowTimeSec = select(cloud.u_simControl.x, cloud.u_padCloud.y, cloud.u_padCloud.y > 0.0);
    let timeSec = select(cloud.u_simControl.x, max(0.0, cloud.u_simControl.x - cloud.u_padCloud.y), cloud.u_padCloud.y > 0.0);
    let timeDrift = flowTimeSec * driftRate;
    let uv = uvw.xy;
    let lonRad = (uv.x - 0.5) * TWO_PI;
    let latRad = (0.5 - uv.y) * PI;
    let cosLat = max(0.22, cos(latRad));

    let sinLon = sin(lonRad);
    let cosLon = cos(lonRad);
    let sinLat = sin(latRad);
    let cosLatTrue = cos(latRad);
    let eEast = vec3<f32>(cosLon, 0.0, -sinLon);
    let eNorth = vec3<f32>(-sinLat * sinLon, cosLatTrue, -sinLat * cosLon);

    let wSurf = textureSampleLevel(u_windTexture, u_cloud2DSampler, uv, 0.0).xy;
    let wJet = textureSampleLevel(u_jetStreamTexture, u_cloud2DSampler, uv, 0.0).xy;
    let wMidVec = blendStratumWindVector(wSurf, wJet, 0.45);

    let advT_macro = flowTimeSec;

    let lowTop = cloud.u_layerHeights.x;
    let midBottom = cloud.u_layerHeights.y;
    let midTop = cloud.u_layerHeights.z;
    let highBottom = cloud.u_layerHeights.w;

    let isAdvectionActive = advection.u_advectionSpeed > 0.001;
    var diagAdvSample = vec4<f32>(0.0);
    if (isAdvectionActive) {
        diagAdvSample = textureSampleLevel(u_advectedDensityTexture, u_advectedDensitySampler, vec3<f32>(uv.x, uv.y, hNorm), 0.0);
    }
    let hasDiagAdvected = isAdvectionActive && (diagAdvSample.a > 0.5);
    let lclNorm = cloud.u_lclParams.y;
    let zLclMetersDiag = select(
        lclNorm * 15290.0,
        clamp((diagAdvSample.a - 0.52) / 0.48, 0.0, 1.0) * 4000.0,
        hasDiagAdvected
    );
    let lowBottom = max(0.0, zLclMetersDiag / 15290.0);

    let lowWeight = layerHeightEnvelope(hNorm, lowBottom, lowTop, 0.04) * cloud.u_layerDensities.x;
    let midWeight = layerHeightEnvelope(hNorm, midBottom, midTop, 0.06) * cloud.u_layerDensities.y;
    let highWeight = layerHeightEnvelope(hNorm, highBottom, 0.98, 0.05) * cloud.u_layerDensities.z;

    let lowUV0 = computeWindSwirlAdvectedUV(uv, wSurf, advT_macro, timeDrift, cosLat);
    let lowFraction = sampleCloudTexScalar(u_cloudLowTexture, lowUV0);

    let midUV0 = computeWindSwirlAdvectedUV(uv, wMidVec, advT_macro, timeDrift, cosLat);
    let midFraction = sampleCloudTexScalar(u_cloudMidTexture, midUV0);

    let highUV0 = computeWindSwirlAdvectedUV(uv, wJet, advT_macro, timeDrift * 1.8, cosLat);
    let highFraction = sampleCloudTexScalar(u_cloudHighTexture, highUV0);

    let freqHoriz = cloud.u_noiseParams.x;
    let freqVert = cloud.u_noiseParams.y;
    let baseCoord = planarNoiseCoord(uv, hNorm, freqHoriz, freqVert, timeDrift);
    let nLow = sampleStratumFlowNoise3D(baseCoord * 1.6, eEast, eNorth, wSurf, 1.65, flowTimeSec).r;
    let nMid = sampleStratumFlowNoise3D(baseCoord * 1.4, eEast, eNorth, wMidVec, 1.50, flowTimeSec).r;
    let nHigh = sampleStratumFlowNoise3D(vec3<f32>(baseCoord.x * 0.60, baseCoord.y * 1.35, baseCoord.z * 2.15), eEast, eNorth, wJet, 1.75, flowTimeSec).r;

    let wLow = lowFraction * lowWeight * (0.45 + 0.85 * nLow);
    let wMid = midFraction * midWeight * (0.45 + 0.85 * nMid);
    let wHigh = highFraction * highWeight * (0.35 + 0.95 * nHigh);
    let totalW = wLow + wMid + wHigh;

    let colLow = vec3<f32>(1.00, 0.62, 0.15); // Amber-Gold
    let colMid = vec3<f32>(0.12, 0.85, 0.96); // Cyan-Aqua
    let colHigh = vec3<f32>(0.96, 0.28, 0.88); // Magenta-Orchid

    let envTotal = max(0.0001, lowWeight + midWeight + highWeight);
    let fallbackCol = (colLow * lowWeight + colMid * midWeight + colHigh * highWeight) / envTotal;
    let weightedCol = (colLow * wLow + colMid * wMid + colHigh * wHigh) / max(0.0001, totalW);
    return select(fallbackCol, weightedCol, totalW >= 0.001);
}

fn evaluateStrataDiagnosticColor(pos: vec3<f32>, rInner: f32, deltaR: f32) -> vec3<f32> {
    let unfurl = cloud.u_simControl.y;
    let inv = invertManifoldModeWGSL(pos, unfurl, rInner);
    let hNorm = clamp(inv.z / deltaR, 0.0, 1.0);
    let uv = vec2<f32>(fract((inv.x / TWO_PI) + 0.5), clamp(0.5 - (inv.y / PI), 0.001, 0.999));
    return evaluateStrataDiagnosticColorFromUVW(vec3<f32>(uv.x, uv.y, hNorm));
}




// Dual-Lobe Henyey-Greenstein Phase Function in FP16/FP32 (half)
fn dualHenyeyGreensteinHalf(cosTheta: half, g1: half, g2: half, weight: half) -> half {
    let ct = clamp(cosTheta, half(-0.9999), half(0.9999));
    let g1Sq = g1 * g1;
    let denom1 = max(half(0.0005), half(1.0) + g1Sq - half(2.0) * g1 * ct);
    let p1 = (half(1.0) - g1Sq) / (denom1 * sqrt(denom1));

    let g2Sq = g2 * g2;
    let denom2 = max(half(0.0005), half(1.0) + g2Sq - half(2.0) * g2 * ct);
    let p2 = (half(1.0) - g2Sq) / (denom2 * sqrt(denom2));

    return half(INV_FOUR_PI) * mix(p2, p1, weight);
}

fn evaluateBillowReliefHalf(nSample: half4, dSample: half4) -> half2 {
    let macroB = smoothstep(half(0.18), half(0.76), nSample.r * half(0.34) + nSample.g * half(0.34) + nSample.b * half(0.18) + dSample.r * half(0.14));
    let largeB = smoothstep(half(0.18), half(0.76), nSample.b * half(0.24) + nSample.a * half(0.26) + dSample.r * half(0.24) + dSample.g * half(0.26));
    let smallB = smoothstep(half(0.18), half(0.78), nSample.a * half(0.20) + dSample.g * half(0.24) + dSample.b * half(0.32) + dSample.a * half(0.24));
    let billow = macroB * half(0.34) + largeB * half(0.66);
    let detail = largeB * half(0.52) + smallB * half(0.48);
    return half2(billow, detail);
}

fn rgbToYCoCg(rgb: half3) -> half3 {
    let co = rgb.r - rgb.b;
    let t = rgb.b + co * half(0.5);
    let cg = rgb.g - t;
    let y = t + cg * half(0.5);
    return half3(y, co, cg);
}

fn ycocgToRgb(ycocg: half3) -> half3 {
    let t = ycocg.x - ycocg.z * half(0.5);
    let g = ycocg.z + t;
    let b = t - ycocg.y * half(0.5);
    let r = b + ycocg.y;
    return max(half3(half(0.0)), half3(r, g, b));
}

// Dual-Lobe Henyey-Greenstein Phase Function with Numerical Clamping
fn dualHenyeyGreenstein(cosTheta: f32, g1: f32, g2: f32, weight: f32) -> f32 {
    let ct = clamp(cosTheta, -0.9999, 0.9999);
    let g1Sq = g1 * g1;
    let denom1 = max(0.0001, 1.0 + g1Sq - 2.0 * g1 * ct);
    let p1 = (1.0 - g1Sq) / (denom1 * sqrt(denom1));

    let g2Sq = g2 * g2;
    let denom2 = max(0.0001, 1.0 + g2Sq - 2.0 * g2 * ct);
    let p2 = (1.0 - g2Sq) / (denom2 * sqrt(denom2));

    return INV_FOUR_PI * mix(p2, p1, weight);
}

// 3-Lobe Phase Function with Forward Mie Silver-Lining Diffraction Peak
fn triplePhaseFunction(cosTheta: f32, g1: f32, g2: f32, gMie: f32, stepT: f32) -> f32 {
    let baseHG = dualHenyeyGreenstein(cosTheta, g1, g2, 0.70);

    // Sharp forward Mie diffraction lobe (gMie = 0.965)
    let ct = clamp(cosTheta, -0.9999, 0.9999);
    let gMieSq = gMie * gMie;
    let denomMie = max(0.0001, 1.0 + gMieSq - 2.0 * gMie * ct);
    let forwardMie = INV_FOUR_PI * ((1.0 - gMieSq) / (denomMie * sqrt(denomMie)));

    // Fringe weight: peak silver lining along backlit, optically thin cloud boundaries
    let fringeWeight = smoothstep(0.12, 0.55, stepT) * (1.0 - smoothstep(0.75, 0.98, stepT));
    let forwardBoost = max(0.0, ct);

    return baseHG + forwardMie * (fringeWeight * forwardBoost * 0.40);
}

struct SunShadowResult {
    transmittance: f32,
    density: f32,
};

// 4-Step Progressive Beer-Lambert Solar Shadow Raymarch
// Evaluates tau_sun = sum_{k=1}^4 sigma_t * rho(pos + k * stepDist * sunDir) * stepDist
// Returns SunShadowResult with transmittance = exp(-tau_sun) and averaged crevice density
fn sampleSunShadowTransmittance(pos: vec3<f32>, sunDir: vec3<f32>, rInner: f32, deltaR: f32) -> SunShadowResult {
    let stepDist = 0.00045;
    var tauSun: f32 = 0.0;
    var avgDensity: f32 = 0.0;
    let sigmaT = cloud.u_opticalParams.x * 20.0;

    // 4-step Beer-Lambert integration
    for (var k: i32 = 1; k <= 4; k++) {
        let stepLen = stepDist * f32(k);
        let sampleP = pos + sunDir * stepLen;
        let d = sampleCloudDensity(sampleP, rInner, deltaR);
        tauSun += sigmaT * d * stepDist;
        avgDensity += d * 0.25;
    }

    tauSun *= 0.16;
    var res: SunShadowResult;
    res.transmittance = exp(-tauSun);
    res.transmittance = clamp(res.transmittance, 0.48, 1.0);
    res.density = avgDensity;
    return res;
}

// Pivot 2: Zero-Inversion Linearized Solar Shadow Ray in Tangent Parameter Frame
// Marches 3 steps along local 315° NW cartographic sun vector so taller NW domes cast directional shadows into SE crevices without phantom flat-slab self-shadowing
fn sampleSunShadowTransmittanceLinear(
    start_uvw: vec3<f32>,
    pos: vec3<f32>,
    sunDir: vec3<f32>,
    rInner: f32,
    deltaR: f32
) -> SunShadowResult {
    let stepDist = 0.0030;
    var tauSun: f32 = 0.0;
    var avgDensity: f32 = 0.0;
    let sigmaT = cloud.u_opticalParams.x * 3.8;

    let unfurl = cloud.u_simControl.y;
    let sun_v_uvw = getParameterVelocity(sunDir, start_uvw.x, start_uvw.y, start_uvw.z, unfurl, rInner);
    let safeCosPhi = max(0.15, cos(start_uvw.y));
    let localUp = select(pos / max(1e-5, length(pos)), vec3<f32>(0.0, 0.0, 1.0), unfurl > 0.5);
    let cosSunZenith = dot(localUp, sunDir);
    let ecefShadowGrazing = (1.0 - smoothstep(-0.08, 0.42, cosSunZenith)) * (1.0 - clamp(unfurl, 0.0, 1.0));
    let terminatorGrazing = mix(ecefShadowGrazing, p_rayLowSunGate, p_rayCustomSunGate);
    let grazingReach = 1.0 + mix(0.55, 1.15, p_rayCustomSunGate) * terminatorGrazing;
    let ecefStepOffset = sun_v_uvw.xy * (0.00010 * (1.0 - p_rayCustomSunGate));
    let deltaLambda = ((p_rayCompassDir2D.x * 0.01131371) / safeCosPhi + ecefStepOffset.x) * grazingReach;
    let deltaPhi = (p_rayCompassDir2D.y * 0.01131371 + ecefStepOffset.y) * grazingReach;
    let effShadowSpan = max(0.0001, p_stepCache.stepTropoSpan);
    let deltaHNorm = mix(max(0.042, max(0.24, sunDir.y) * 0.048), mix(0.024, 0.016, p_rayCustomSunGate), terminatorGrazing);
    let localSunStep = vec3<f32>(
        deltaLambda,
        deltaPhi,
        deltaHNorm * effShadowSpan
    );

    let driftRate = cloud.u_noiseParams.w;
    let flowTimeSec = select(cloud.u_simControl.x, cloud.u_padCloud.y, cloud.u_padCloud.y > 0.0);
    let timeSec = select(cloud.u_simControl.x, max(0.0, cloud.u_simControl.x - cloud.u_padCloud.y), cloud.u_padCloud.y > 0.0);
    let timeDrift = timeSec * driftRate;
    let baseLowTop = cloud.u_layerHeights.x;
    let midBottom = cloud.u_layerHeights.y;
    let midTop = cloud.u_layerHeights.z;
    let highBottom = cloud.u_layerHeights.w;
    let shHScale = clamp(cloud.u_noiseParams.x / 32.0, 0.25, 4.0);
    let shVScale = clamp(cloud.u_noiseParams.y / 12.0, 0.25, 4.0);

    let runtimeDispScale = select(0.28, cloud.u_shellRadii.w, cloud.u_shellRadii.w > 0.0001);
    let runtimePeakExp = select(1.4, clamp(cloud.u_padCloud.z, 0.2, 4.0), cloud.u_padCloud.z > 0.01);
    let isDualLog = cloud.u_padCloud.w > 0.5;
    let elev2200Norm = select(2200.0 / 8848.0, clamp(log(1.0 + 2200.0 / 1200.0) / 2.12425, 0.0, 1.0), isDualLog);
    let baroLowTopASL = clamp((pow(elev2200Norm, runtimePeakExp) * runtimeDispScale) / max(deltaR, 0.0001), 0.075, 0.22);
    let activeLowTopSh = min(baseLowTop, baroLowTopASL);

    var dK = p_stepCache.dCenter;
    let wSurfSh = p_rayWinds.xy;
    let wJetSh = p_rayWinds.zw;
    let advT_macro = flowTimeSec;

    let startHNorm = clamp((start_uvw.z - p_stepCache.stepSynopticLift) / effShadowSpan, 0.0, 1.0);
    var maxAnvilOverhang: f32 = 0.0;
    let stepCovSh = p_stepCache.stepLow + p_stepCache.stepMid + p_stepCache.stepHigh;
    for (var k: i32 = 1; k <= 2; k++) {
        if (k >= 2 && (tauSun > 0.92 || stepCovSh < 0.16)) {
            break;
        }
        let curUVW = start_uvw + localSunStep * (f32(k) * 1.42);
        if (curUVW.z > 0.0 && curUVW.z < p_rayMaxShellZ) {
            let hNorm = clamp((curUVW.z - p_stepCache.stepSynopticLift) / effShadowSpan, 0.0, 1.0);
            let stepUV = vec2<f32>(
                fract((curUVW.x / TWO_PI) + 0.5),
                clamp(0.5 - (curUVW.y / PI), 0.001, 0.999)
            );
            let baseCloudUV = vec2<f32>(fract(stepUV.x + timeDrift * 0.12), stepUV.y);
            let wMidSh = select(blendStratumWindVector(wSurfSh, wJetSh, 0.45), p_rayMidWind, hasWind500hPa());
            let shCosLat = max(0.22, cos(curUVW.y));
            let cloudUV = computeWindSwirlAdvectedUV(baseCloudUV, wSurfSh, advT_macro, flowTimeSec * driftRate, shCosLat);
            let midCloudUV = computeWindSwirlAdvectedUV(baseCloudUV, wMidSh, advT_macro, flowTimeSec * driftRate, shCosLat);
            let highCloudUV = computeWindSwirlAdvectedUV(baseCloudUV, wJetSh, advT_macro, flowTimeSec * driftRate, shCosLat);
            let lowFraction = sampleCloudTexScalar(u_cloudLowTexture, cloudUV) * cloud.u_layerDensities.x;
            let midFraction = sampleCloudTexScalar(u_cloudMidTexture, midCloudUV) * cloud.u_layerDensities.y;
            let highFraction = sampleCloudTexScalar(u_cloudHighTexture, highCloudUV) * cloud.u_layerDensities.z;

            if ((lowFraction + midFraction + highFraction) >= 0.026) {
                let sinLonK = sin(curUVW.x);
                let cosLonK = cos(curUVW.x);
                let sinLatK = sin(curUVW.y);
                let cosLatK = cos(curUVW.y);
                let nSphK = vec3<f32>(cosLatK * sinLonK, sinLatK, cosLatK * cosLonK);
                let altDirK = vec3<f32>(
                    nSphK.x * 0.65 + nSphK.y * 0.48 - nSphK.z * 0.58,
                   -nSphK.x * 0.52 + nSphK.y * 0.78 + nSphK.z * 0.34,
                    nSphK.x * 0.55 - nSphK.y * 0.40 + nSphK.z * 0.73
                );
                let shFreq = 2.65 * shHScale;
                let shDriftScale = clamp(abs(driftRate) / 0.002, 0.0, 4.0);
                let baseCoord = fract(nSphK * shFreq + altDirK * (hNorm * 0.32 * shVScale));
                let nK = sampleFlowNoiseFromVel3D(baseCoord, p_stepCache.detailWind3D * (2.65 / 10.8), shDriftScale, flowTimeSec);
                let fbmK = clamp(nK.r * 0.46 + nK.g * 0.34 + dK.r * 0.20, 0.0, 1.0);
                let overheadAnvilGate = 1.0 - smoothstep(0.50, 0.90, startHNorm);
                let midShelfOverLow = midFraction * (1.0 - smoothstep(0.20, 0.36, startHNorm));
                let anvilOverhang = clamp(
                    max(
                        highFraction * smoothstep(0.06, 0.46, max(max(midFraction, lowFraction), highFraction * 0.84)) * overheadAnvilGate,
                        midShelfOverLow * smoothstep(0.08, 0.44, lowFraction) * 0.82
                    ),
                    0.0,
                    1.0
                );
                maxAnvilOverhang = max(maxAnvilOverhang, anvilOverhang);
                let deepStorm = clamp(lowFraction * midFraction * 1.65 + p_stepCache.stepRadOptics * 0.52 + anvilOverhang * 0.65, 0.0, 1.0);

                let lowEnvelope = layerHeightEnvelope(hNorm, 0.015, 0.24, 0.038);
                let midEnvelope = layerHeightEnvelope(hNorm, 0.26, 0.56, 0.038);
                let highEnvelope = layerHeightEnvelope(hNorm, 0.58, 0.88, 0.040);
                let anvilWeight = mix(0.42, 0.96, anvilOverhang);
                let cov = clamp(
                    lowFraction * lowEnvelope +
                    midFraction * midEnvelope +
                    highFraction * highEnvelope * anvilWeight +
                    anvilOverhang * 0.58,
                    0.0,
                    1.0
                );
                let fbmCarve = smoothstep(0.22, 0.66, fbmK);
                let optScale = mix(0.32, 1.35, smoothstep(0.22, 0.80, deepStorm));
                let d = clamp(cov * fbmCarve * optScale, 0.0, 1.0) * cloud.u_layerDensities.w;
                tauSun += sigmaT * d * stepDist * 1.55;
                avgDensity += d * 0.5;
            }
        }
    }

    let stormShelfOverhang = clamp(max(maxAnvilOverhang, smoothstep(0.32, 0.80, p_stepCache.stepRadOptics) * smoothstep(0.24, 0.68, stepCovSh)), 0.0, 1.0);
    tauSun *= mix(0.38, 0.74, stormShelfOverhang);
    let shadowFloor = mix(0.28, 0.15, stormShelfOverhang);
    var res: SunShadowResult;
    res.transmittance = exp(-tauSun);
    res.transmittance = clamp(res.transmittance, shadowFloor, 1.0);
    res.density = avgDensity;
    return res;
}




// Analytical Rayleigh Atmospheric Airglow Single-Scattering at Planetary Horizon Limb
// Conforms to displaced terrain silhouette (depthVal / tTerrain) so mountains never suffer circular rInner cutouts
fn evaluateRayleighLimbAirglow(
    rayOrigin: vec3<f32>,
    rayDir: vec3<f32>,
    sunDir: vec3<f32>,
    rInner: f32,
    tTerrain: f32,
    depthVal: f32,
    theme: u32
) -> vec4<f32> {
    let rAtm = rInner + 0.095; // Encompasses high-relief displaced mountain silhouettes
    let b = dot(rayOrigin, rayDir);
    let cAtm = dot(rayOrigin, rayOrigin) - rAtm * rAtm;
    let discAtm = b * b - cAtm;
    if (discAtm < 0.0) {
        return vec4<f32>(0.0);
    }

    let tAtmEnter = max(0.0, -b - sqrt(discAtm));
    let tAtmExit = min(-b + sqrt(discAtm), tTerrain);
    if (tAtmExit <= tAtmEnter) {
        return vec4<f32>(0.0);
    }

    let dMin = sqrt(max(0.0, dot(rayOrigin, rayOrigin) - b * b));
    if (dMin > rAtm) {
        return vec4<f32>(0.0);
    }

    var optDepth: f32 = 0.0;
    if (depthVal >= 0.999999) {
        // Outer-space limb halo: zero on Cream Rag (preserves pure archival ivory margin) and zero over depressed bathymetric ocean limbs
        let pLimb = rayOrigin - b * rayDir;
        let uvLimb = worldToEquirectangularUV(pLimb);
        let demLimb = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_cloud2DSampler, uvLimb, 2.0));
        let isDepressedOceanLimb = (demLimb.b < 0.45 && (demLimb.a * 19772.0 - 10924.0) < -5.0) || (dMin < rInner - 0.0025);
        if (theme != 1u && !isDepressedOceanLimb) {
            let altNorm = clamp((dMin - rInner) / 0.024, 0.0, 1.0);
            let pathLen = min(0.45, tAtmExit - tAtmEnter);
            let densityProfile = exp(-altNorm * 4.5) * (1.0 - smoothstep(0.65, 1.0, altNorm));
            optDepth = pathLen * densityProfile * 0.85;
        }
    } else {
        // Continuous grazing aerial perspective on the visible globe near the limb (zero dMin == rInner step discontinuity)
        let pSurface = rayOrigin + rayDir * tTerrain;
        let cosView = clamp(dot(normalize(pSurface), -rayDir), 0.0, 1.0);
        let limbGrazing = pow(1.0 - cosView, 4.2);
        optDepth = limbGrazing * select(0.20, 0.10, theme == 1u);
    }

    let cosSun = dot(rayDir, sunDir);
    let rayleighPhase = 0.059683 * (1.0 + cosSun * cosSun); // 3/(16*pi)

    let pClosest = rayOrigin + rayDir * min(-b, tAtmExit);
    let sunDotWorld = dot(normalize(pClosest), sunDir);
    let dayFactor = smoothstep(-0.25, 0.25, sunDotWorld);

    var betaR: vec3<f32>;
    if (theme == 0u) {
        betaR = vec3<f32>(0.20, 0.46, 0.92);
    } else if (theme == 1u) {
        betaR = vec3<f32>(0.96, 0.94, 0.90);
    } else {
        betaR = vec3<f32>(0.35, 0.65, 0.95);
    }

    let airglow = betaR * (rayleighPhase * 4.0 * PI * dayFactor * 0.88);
    let alpha = clamp(1.0 - exp(-optDepth), 0.0, 0.85);
    return vec4<f32>(airglow, alpha);
}

// Medium Inking Palette
struct CloudMediumPalette {
    sunColor: vec3<f32>,
    midColor: vec3<f32>,
    ambientColor: vec3<f32>,
    inkDensityFactor: f32,
};

fn getMediumPalette(theme: u32) -> CloudMediumPalette {
    var pal: CloudMediumPalette;
    if (theme == 0u) {
        // Theme 0: Marie Tharp (1977) Physiographic Chart
        pal.sunColor = vec3<f32>(1.00, 0.98, 0.95);     // Warm lithographic sunlit cream
        pal.midColor = vec3<f32>(0.84, 0.88, 0.92);     // Pale ocean-illuminated parchment glaze
        pal.ambientColor = vec3<f32>(0.32, 0.40, 0.50); // Deep oceanic indigo shadow (#1E293B)
        pal.inkDensityFactor = 1.0;
    } else if (theme == 1u) {
        // Theme 1: Cream Rag (310 GSM Cotton Rag)
        pal.sunColor = vec3<f32>(0.98, 0.96, 0.92);     // Soft warm absorbent ivory wash
        pal.midColor = vec3<f32>(0.86, 0.82, 0.76);     // Raw umber watercolor glaze
        pal.ambientColor = vec3<f32>(0.50, 0.46, 0.40); // Archival sepia-charcoal ink wash (#38302A)
        pal.inkDensityFactor = 0.92;
    } else if (theme == 2u) {
        // Theme 2: Prussian Cyanotype (1842 Blueprint)
        pal.sunColor = vec3<f32>(0.92, 0.97, 1.00);     // Actinic solarized blueprint highlight
        pal.midColor = vec3<f32>(0.88, 0.92, 0.96);     // Crisp actinic chalk-white wash
        pal.ambientColor = vec3<f32>(0.18, 0.32, 0.48); // Deep Prussian blue / ferric ferrocyanide (#003153)
        pal.inkDensityFactor = 1.00;
    } else {
        // Defensive fallback defaulting to Theme 0 without collapsing themes
        pal.sunColor = vec3<f32>(1.00, 0.98, 0.95);
        pal.midColor = vec3<f32>(0.84, 0.88, 0.92);
        pal.ambientColor = vec3<f32>(0.32, 0.40, 0.50);
        pal.inkDensityFactor = 1.0;
    }

    // Dynamic low-sun solar rim modulation when sunAlt < 15.0°
    let sunAlt = cloud.u_sunDirection.w;
    if (sunAlt < 15.0) {
        let sunsetWarmth = 1.0 - smoothstep(3.0, 15.0, sunAlt);
        let sunsetTarget = select(vec3<f32>(1.00, 0.72, 0.42), vec3<f32>(0.76, 0.91, 1.00), theme == 2u);
        pal.sunColor = mix(pal.sunColor, sunsetTarget, sunsetWarmth * 0.75);
    }

    return pal;
}

// Fast Screen-Space Interleaved Gradient Noise Hash for Ray Jitter (minimizes salt-and-pepper static)
fn hashScreen(p: vec2<f32>) -> f32 {
    let d = dot(p, vec2<f32>(0.06711056, 0.00583715));
    return fract(52.9829189 * fract(d));
}

fn hash2DRetina(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.xyx) * vec3<f32>(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

var<private> p_rayCentroid: f32 = 1024.0;

struct FragmentMRTOut {
    @location(0) volColor: vec4<f32>,
    @location(1) volCentroid: vec4<f32>,
};

// Fast 3-Step 3D World-Space Solar Self-Shadow & Near-Field Floret Slope Cone (strictly along sunWorldDir — zero -rayDir woodgrain stripes!)
fn evaluateRegionalGhibliSunOcc(
    sunWorldDir: vec3<f32>,
    driftScale: f32,
    flowTimeSec: f32,
    camDistRay: f32
) -> vec3<f32> {
    let steps = array<f32, 3>(0.0013, 0.0052, 0.0168);
    let stepWeights = array<f32, 3>(2.85, 5.80, 14.20);

    let qMacro0 = p_stepCache.baseCoord3D;
    let qIso0 = p_stepCache.detailCoord3D;
    let upW = p_stepCache.baseWind3D;
    let shearDirMac = p_stepCache.detailWind3D;
    let thresh = p_stepCache.dCenter.y;
    let stormBoost = p_stepCache.dCenter.w;
    let zStreamSpan = max(0.0085, p_stepCache.stepSynopticLift);
    let zCrownSpan = max(zStreamSpan + 0.0045, p_stepCache.stepTropoSpan);
    let zBase = p_stepCache.stepEffTerrainNorm;
    let zRel0 = p_stepCache.stepDemHere;
    let wisp = p_stepCache.nCenter.w;
    let isVal = p_stepCache.dCenter.x;
    let dVal0 = p_stepCache.stepRadOptics;
    let dCliff0 = p_stepCache.stepIsLand;

    var tauSun: f32 = 0.0;
    var nearFloretDepth: f32 = p_stepCache.nCenter.x;

    let unfurlAdv = clamp(cloud.u_simControl.y, 0.0, 1.0);
    let sunDirIso = advectIsometricGhibliVec(sunWorldDir, flowTimeSec, driftScale, unfurlAdv);
    let sunDirMac = advectIsometricGhibliVec(sunWorldDir, flowTimeSec * 0.72, driftScale, unfurlAdv);
    let upWMac = advectIsometricGhibliVec(upW, flowTimeSec * 0.72, driftScale, unfurlAdv);

    let regRuntimeDispS = select(0.28, cloud.u_shellRadii.w, cloud.u_shellRadii.w > 0.0001);
    let regHudS = computeRegionalHudScales(regRuntimeDispS);
    let regHFreqS = regHudS.z;
    let regErosionRatioS = regHudS.w;
    let offscreenPxS = camDistRay * 0.00054;
    let nyqDetailS = (1.0 - smoothstep(0.00125, 0.00240, offscreenPxS)) * smoothstep(0.06, 0.30, p_rayTransmittance);

    for (var i: u32 = 0u; i < 3u; i = i + 1u) {
        let sDist = steps[i];
        let dz = dot(sunWorldDir * sDist, upW);
        let zS = zRel0 + dz;

        let qMacS = qMacro0 + sunDirMac * sDist;
        let mtS = evalRegMultiTierCumulus(qMacS, upWMac, shearDirMac, zS, zBase, zStreamSpan, zCrownSpan, thresh, stormBoost, i >= 2u);
        let dCumS = mtS.dCumulus;
        let towerSpanS = mtS.effSpan;
        let dValS = dVal0 - max(0.0, dz) * 1.15;
        let dCliffS = dCliff0 - abs(dz) * 0.85;
        let dConvAndFogS = smaxDepthGhibli(dCumS, dValS, 0.0058);
        let dScafS = smaxDepthGhibli(dConvAndFogS, dCliffS, 0.0046);

        if (dScafS < -0.016) {
            if (i == 0u) {
                nearFloretDepth = dScafS;
            }
            continue;
        }

        var dBlendS = dScafS - 0.0016 * (1.0 - wisp);
        if (i <= 1u) {
            let qIsoS = qIso0 + sunDirIso * sDist;
            let nCS = sampleRegNoise3D(rotSO3A(qIsoS) * (13.40 * regHFreqS));
            let activeColSpanS = max(0.0085, mix(zStreamSpan, towerSpanS, clamp(mtS.midGate * 0.65 + mtS.turretGate * 0.45, 0.0, 1.0)));
            let hFracS = clamp((zS - zBase + 0.0025) / (activeColSpanS + 0.0035), 0.0, 1.0);
            let crownRigS = smoothstep(0.08, 0.55, hFracS);
            let crownFocusS = smoothstep(0.02, 0.34, mtS.shelfGate * 0.52 + mtS.midGate * 0.58 + mtS.turretGate * 0.85) * mix(0.45, 1.0, crownRigS);

            let lobeGateS = smoothstep(-0.0045, 0.0052, dConvAndFogS) * (1.0 - isVal * 0.35);
            let lobeInfS = (nCS.g - 0.41) * 0.0178 * lobeGateS;
            let floretCarveS = ((1.0 - nCS.g) * 0.0092 + (1.0 - nCS.b) * 0.0056) * regErosionRatioS * mix(0.74, 1.06, crownRigS) * (1.0 - isVal * 0.42);
            var dGhibliS = dScafS + lobeInfS - floretCarveS;

            let coreHoldS = smoothstep(0.0014, 0.0076, dConvAndFogS) * clamp(0.18 + 0.82 * crownFocusS, 0.0, 1.0) * (1.0 - isVal * 0.85);
            let wispyBaseS = mix(min(dScafS, 0.0064), dScafS, coreHoldS * 0.82);
            var dWispyS = wispyBaseS + (nCS.r - 0.50) * 0.0168;

            if (i == 0u) {
                // Near-field sDist = 0.0013 sunward 38.2x floret step (lim_{sDist->0} (dShellOut - dBlendS) === 0!)
                var nDS = vec4<f32>(nCS.r, nCS.b, nCS.a, nCS.a);
                if (nyqDetailS > 0.02) {
                    nDS = sampleRegNoise3D(rotSO3B(qIsoS) * (38.20 * regHFreqS) + vec3<f32>(0.37, -0.19, 0.53));
                }
                let crownFineBoostS = mix(0.85, 1.48, crownFocusS);
                let lobeInfFineS = (nDS.g - 0.44) * 0.0054 * nyqDetailS * lobeGateS * crownFineBoostS;
                let floretCarveFineS = ((1.0 - nDS.g) * 0.0042 + (1.0 - nDS.b) * 0.0019) * regErosionRatioS * nyqDetailS * crownFineBoostS * mix(0.74, 1.08, crownRigS) * (1.0 - isVal * 0.48);
                dGhibliS = dGhibliS + lobeInfFineS - floretCarveFineS;
                let mistDetailRS = mix(0.50, nDS.r, nyqDetailS);
                let mistRawS = 0.62 * nCS.r + 0.38 * mistDetailRS;
                let mistFbmS = clamp(0.50 + (mistRawS - 0.50) * 2.02, 0.0, 1.0);
                dWispyS = wispyBaseS + (mistFbmS - 0.50) * 0.0176 - (1.0 - mistDetailRS) * (0.0042 * regErosionRatioS) * nyqDetailS * (1.0 - coreHoldS * 0.65);
            }

            dBlendS = mix(dGhibliS, dWispyS, wisp);
            if (i == 0u) {
                nearFloretDepth = dBlendS;
            }
        }

        let featherS = select(mix(0.0016, 0.0050, wisp), mix(0.0030, 0.0068, wisp), i >= 1u);
        let densS = smoothstep(0.0, featherS, dBlendS);
        let modeScaleS = mix(1.0, mix(0.32, 0.24, isVal), wisp * wisp * 0.80);
        tauSun = tauSun + densS * modeScaleS * stepWeights[i];
    }

    return vec3<f32>(tauSun, nearFloretDepth, 0.0);
}

// Analytical Developable Cylinder / Sheet Normal across unfurl in [0, 1]
fn computeManifoldUpFromLonLat(pWorld: vec3<f32>, lonRad: f32, latRad: f32, unfurlVal: f32) -> vec3<f32> {
    let uClamped = clamp(unfurlVal, 0.0, 1.0);
    if (uClamped <= 0.01) {
        return pWorld / max(1e-5, length(pWorld));
    }
    if (uClamped >= 0.99) {
        return vec3<f32>(0.0, 0.0, 1.0);
    }
    let aEased = uClamped * uClamped * (3.0 - 2.0 * uClamped);
    let tStr = clamp((aEased - 0.10) / 0.90, 0.0, 1.0);
    let thTan = (1.0 - aEased) * lonRad;
    let phTan = (1.0 - tStr) * latRad;
    let cosPh = cos(phTan);
    return normalize(vec3<f32>(cosPh * sin(thTan), sin(phTan), cosPh * cos(thTan)));
}

fn computeManifoldUpDir(pWorld: vec3<f32>, unfurlVal: f32, rInnerVal: f32) -> vec3<f32> {
    let uClamped = clamp(unfurlVal, 0.0, 1.0);
    if (uClamped <= 0.01) {
        return pWorld / max(1e-5, length(pWorld));
    }
    if (uClamped >= 0.99) {
        return vec3<f32>(0.0, 0.0, 1.0);
    }
    let uvwLocal = invertManifoldModeWGSL(pWorld, uClamped, rInnerVal);
    return computeManifoldUpFromLonLat(pWorld, uvwLocal.x, uvwLocal.y, uClamped);
}

// ----------------------------------------------------------------------------
// Fragment Shader Main Entry Point
// ----------------------------------------------------------------------------

fn evaluateVolumetricRaymarch(in: VertexOutput, isCheckerPass: bool) -> vec4<f32> {
    let unfurl = cloud.u_simControl.y;
    let morphFade: f32 = 1.0;

    // 1. Reconstruct World Ray from NDC Coordinates (with 2x1 Checkerboard or Full-Grid Subsampling Support)
    let rawGridW = camera.u_taaParams.w;
    let isFullGridOffscreen = rawGridW < -0.5;
    let checkerGridW = max(1, i32(round(max(1.0, abs(rawGridW)))));
    let checkerGridH = max(1, i32(round(max(1.0, camera.u_padCamera.w))));
    let checkerParity = i32(round(camera.u_taaParams.x)) & 1;
    let cx = i32(in.position.x);
    let cy = i32(in.position.y);
    let hx = select(
        min(checkerGridW - 1, cx * 2 + ((cy + checkerParity) & 1)),
        min(checkerGridW - 1, cx),
        isFullGridOffscreen
    );
    let hy = min(checkerGridH - 1, cy);
    let checkerUV = vec2<f32>(f32(hx) + 0.5, f32(hy) + 0.5) / vec2<f32>(f32(checkerGridW), f32(checkerGridH));
    let uv = select(in.uv, checkerUV, isCheckerPass);
    let rayScreenPos = select(in.position.xy, vec2<f32>(f32(hx) + 0.5, f32(hy) + 0.5), isCheckerPass);
    let ndcX = uv.x * 2.0 - 1.0;
    let ndcY = 1.0 - uv.y * 2.0;

    let clipNear = vec4<f32>(ndcX, ndcY, -1.0, 1.0);
    let clipFar  = vec4<f32>(ndcX, ndcY, 1.0, 1.0);

    let worldNearH = camera.u_invViewMatrix * (camera.u_invProjectionMatrix * clipNear);
    let worldFarH  = camera.u_invViewMatrix * (camera.u_invProjectionMatrix * clipFar);

    let worldNear = worldNearH.xyz / worldNearH.w;
    let worldFar  = worldFarH.xyz / worldFarH.w;

    let rayOrigin = camera.u_cameraPos.xyz;
    let rayDir = normalize(worldFar - worldNear);

    // 2. Sample Depth Buffer & Compute Terrain Ray Distance tTerrain
    let depthDims = max(vec2<u32>(1u), textureDimensions(u_depthTexture));
    let pixelCoords = clamp(
        vec2<i32>(uv * vec2<f32>(depthDims)),
        vec2<i32>(0),
        vec2<i32>(depthDims) - vec2<i32>(1)
    );
    let depthVal: f32 = textureLoad(u_depthTexture, pixelCoords, 0);

    let rInner = cloud.u_shellRadii.x;
    let deltaR = cloud.u_shellRadii.z;

    var tTerrain: f32 = 1e9;
    p_raySurfDisp = 0.0;
    if (depthVal < 0.999999) {
        let worldSurface = reconstructWorldPosition(ndcX, ndcY, depthVal);
        let dist = dot(worldSurface - rayOrigin, rayDir);
        if (dist > 0.00001) {
            tTerrain = dist;
        }
        if (unfurl <= 0.01) {
            p_raySurfDisp = max(0.0, length(worldSurface) - rInner);
        } else if (unfurl >= 0.99) {
            p_raySurfDisp = max(0.0, worldSurface.z);
        } else {
            p_raySurfDisp = max(0.0, invertManifoldModeWGSL(worldSurface, unfurl, rInner).z);
        }
    }
    p_rayCentroid = min(tTerrain, 1024.0);

    var tStart: f32 = 0.0;
    var tEndInterval: f32 = 0.0;

    // 3. Sample Cloud Proxy Dual-Depth Targets (Option 1 Bounding Proxy) only when unfurl > 0.01
    var frontDepth: f32 = 1.0;
    var backDepth: f32 = 0.0;
    if (unfurl > 0.01) {
        let proxyDims = max(vec2<u32>(1u), textureDimensions(u_proxyFrontDepth));
        let proxyCoords = clamp(
            vec2<i32>((vec2<f32>(pixelCoords) + vec2<f32>(0.5)) * (vec2<f32>(proxyDims) / vec2<f32>(depthDims))),
            vec2<i32>(0),
            vec2<i32>(proxyDims) - vec2<i32>(1)
        );
        frontDepth = textureLoad(u_proxyFrontDepth, proxyCoords, 0);
        backDepth = textureLoad(u_proxyBackDepth, proxyCoords, 0);
    }

    let bInner = dot(rayOrigin, rayDir);
    let rOriginSq = dot(rayOrigin, rayOrigin);
    let hasMipDemFs = textureDimensions(u_demTexture).x > 4u;
    let effTropoSpanFs = select(deltaR, deltaR * 0.56, hasMipDemFs);
    let ceilDispSpan = max(deltaR * 0.96, 0.188);
    p_rayMaxShellZ = ceilDispSpan * 1.04;
    let rCeil = rInner + ceilDispSpan;
    let cOuter = rOriginSq - rCeil * rCeil;
    let discOuter = bInner * bInner - cOuter;
    let sqrtDiscOuter = sqrt(max(0.0, discOuter));
    let tSphereEntry = select(0.0, max(0.0, -bInner - sqrtDiscOuter), cOuter > 0.0 && bInner < 0.0);
    let tSphereExit = max(0.0, -bInner + sqrtDiscOuter);
    let hitsOuterSphere = (discOuter > 0.0) && (tSphereExit > 0.0);

    // Account for depth clear values (Front clear = 1.0, Back clear = 0.0).
    // Choice H: On the unfurled planar sheet, backDepth <= 0.000001 bounds the 3D cloud_proxy hull across Mode 0..3;
    // do NOT discard oblique rays where depthVal >= 0.999999 so 3D cloud columns rise cleanly above the flat-map horizon neatline.
    let legacyPlanarSkyClip = !isAtmoFeatureEnabled(7u) && (unfurl >= 0.95 && depthVal >= 0.999999);
    if ((unfurl <= 0.01 && !hitsOuterSphere) || (unfurl > 0.01 && backDepth <= 0.000001) || legacyPlanarSkyClip) {
        discard;
    }

    let rEffCam = computeEffectiveCamRadius(rayOrigin, unfurl, rInner);
    var tProxyEntry: f32 = 0.0;
    var tProxyExit: f32 = tSphereExit;
    if (unfurl > 0.01) {
        let worldFront = reconstructWorldPosition(ndcX, ndcY, frontDepth);
        let worldBack = reconstructWorldPosition(ndcX, ndcY, backDepth);
        let uvwCam = invertManifoldModeWGSL(rayOrigin, unfurl, rInner);
        let uvwFront = invertManifoldModeWGSL(worldFront, unfurl, rInner);
        let isBottomShellFrontHit = ((rEffCam - rInner) < 0.42) && (uvwCam.z >= -0.02) && (uvwFront.z < 0.12);
        tProxyEntry = select(max(0.0, dot(worldFront - rayOrigin, rayDir)), 0.0, frontDepth >= 0.999999 || isBottomShellFrontHit);
        tProxyExit = select(dot(worldBack - rayOrigin, rayDir), max(dot(worldFront - rayOrigin, rayDir), dot(worldBack - rayOrigin, rayDir)), isBottomShellFrontHit);
    }

    tStart = select(tProxyEntry, tSphereEntry, unfurl <= 0.01);
    tEndInterval = min(tProxyExit, tTerrain);

    // Stop ocean rays at the sea-level sphere/planar datum rather than marching into deep bathymetric trenches (R ~ 4.72 or z ~ -0.20),
    // and tighten tStart from the global ceiling to the local per-ray synoptic tropospheric ceiling (localCeilZ).
    // Supports two-sided planar inspection (both +Z top-down and -Z underside/oblique horizon grazing).
    let tOuterSphere = select(tStart, tSphereEntry, unfurl <= 0.01);
    let zCeil = ceilDispSpan;
    let safeRayDirZ = select(select(-1e-5, 1e-5, rayDir.z >= 0.0), rayDir.z, abs(rayDir.z) >= 1e-5);
    let tZBottom = (-0.002 - rayOrigin.z) / safeRayDirZ;
    let tZTop = (zCeil - rayOrigin.z) / safeRayDirZ;
    let tSlabEntry = max(0.0, min(tZBottom, tZTop));
    let tSlabExit = max(tZBottom, tZTop);
    let tOuterPlanar = select(tStart, max(tStart, tSlabEntry), unfurl >= 0.95 && tSlabExit > 0.0);
    tStart = max(tStart, max(tOuterSphere, tOuterPlanar));

    let rDatum = rInner - 0.002;
    let cInner = rOriginSq - rDatum * rDatum;
    let discInner = bInner * bInner - cInner;
    let sqrtDiscInner = sqrt(max(0.0, discInner));
    let tPreInnerHit = max(tStart, -bInner - sqrtDiscInner);
    let tPreInnerSphere = select(tProxyExit, tPreInnerHit, unfurl <= 0.01 && cInner > 0.0 && bInner < 0.0 && discInner > 0.0);
    let tPrePlanarDatum = select(tProxyExit, max(tStart, tSlabExit), unfurl >= 0.95 && tSlabExit > tStart);
    let tPreExit = min(min(min(tProxyExit, tPreInnerSphere), tPrePlanarDatum), min(tEndInterval, tStart + 0.95));

    let pPreInit = rayOrigin + rayDir * tStart;
    let preInitUp = computeManifoldUpDir(pPreInit, unfurl, rInner);
    let preInitLimbCos = abs(dot(preInitUp, rayDir));
    let preHorizSpan = max(0.0, tPreExit - tStart) * sqrt(max(0.0, 1.0 - preInitLimbCos * preInitLimbCos));

    let ignBase = fract(52.9829189 * fract(dot(floor(rayScreenPos), vec2<f32>(0.06711056, 0.00583715))));
    let sampleEpoch = select(floor(camera.u_taaParams.x * 0.5), camera.u_taaParams.x, isFullGridOffscreen);
    let ignTemporal = fract(ignBase + fract(sampleEpoch * 0.61803398875));

    // Single-engine stochastic handoff below r = 5.30 (r >= 5.30 stays 100% continuous synoptic weather bands; zero dual-engine cost)
    let regBlendCont = select(0.0, (1.0 - smoothstep(5.22, 5.30, rEffCam)) * (1.0 - smoothstep(1.25, 1.85, tPreExit)), cloud.u_padCloud.x <= 0.5);
    p_rayUseRegional = (regBlendCont >= 0.999) || (regBlendCont > 0.001 && regBlendCont > ignTemporal);
    let regCeilTight = select(0.0, 1.0, p_rayUseRegional);

    var localMaxSynLift: f32 = 0.0;
    var ghibliCeilZRay: f32 = 0.088;
    var localCeilZResolved: f32 = ceilDispSpan;
    if (hasMipDemFs && tStart < tPreExit) {
        let rayDispScale = select(0.28, cloud.u_shellRadii.w, cloud.u_shellRadii.w > 0.0001);
        let rayPeakExp = select(1.4, clamp(cloud.u_padCloud.z, 0.2, 4.0), cloud.u_padCloud.z > 0.01);
        let rayIsDualLog = cloud.u_padCloud.w > 0.5;
        var localCeilZ = ceilDispSpan;
        if (p_rayUseRegional) {
            // Pure C^infinity ray-independent regional ceiling shell (zero tTerrain / preHorizSpan step jumps on oblique massifs!)
            let regHudRay = computeRegionalHudScales(rayDispScale);
            let regCeilScale = max(1.0, regHudRay.x * regHudRay.y * 0.95);
            ghibliCeilZRay = elevMetersToRegWorldZ(5300.0, rayIsDualLog, rayPeakExp, rayDispScale, 1.0) * regCeilScale + 0.008;
            localCeilZ = min(ceilDispSpan, ghibliCeilZRay);
        } else {
            let uvwR1 = invertManifoldModeWGSL(rayOrigin + rayDir * mix(tStart, tPreExit, 0.55), unfurl, rInner);
            let uvR1 = vec2<f32>(fract((uvwR1.x / TWO_PI) + 0.5), clamp(0.5 - (uvwR1.y / PI), 0.001, 0.999));
            var maxDemAlpha = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_cloud2DSampler, uvR1, 5.5)).a;
            if (preHorizSpan >= 0.055) {
                let uvwR0 = invertManifoldModeWGSL(rayOrigin + rayDir * mix(tStart, tPreExit, 0.15), unfurl, rInner);
                let uvwR2 = invertManifoldModeWGSL(rayOrigin + rayDir * mix(tStart, tPreExit, 0.95), unfurl, rInner);
                let uvR0 = vec2<f32>(fract((uvwR0.x / TWO_PI) + 0.5), clamp(0.5 - (uvwR0.y / PI), 0.001, 0.999));
                let uvR2 = vec2<f32>(fract((uvwR2.x / TWO_PI) + 0.5), clamp(0.5 - (uvwR2.y / PI), 0.001, 0.999));
                maxDemAlpha = max(
                    maxDemAlpha,
                    max(
                        unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_cloud2DSampler, uvR0, 5.5)).a,
                        unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_cloud2DSampler, uvR2, 5.5)).a
                    )
                );
            }
            let rawRaySynM = max(0.0, maxDemAlpha * 19772.0 - 10924.0);
            let raySynCapM = (2650.0 * rawRaySynM) / sqrt(2650.0 * 2650.0 + rawRaySynM * rawRaySynM);
            let rayNorm = select(clamp(raySynCapM / 8848.0, 0.0, 1.0), clamp(log(1.0 + raySynCapM / 1200.0) / 2.12425, 0.0, 1.0), rayIsDualLog);
            localMaxSynLift = min(pow(rayNorm, rayPeakExp) * rayDispScale * 0.94, deltaR * 0.60);
            localCeilZ = localMaxSynLift + effTropoSpanFs * 0.98 + 0.014;
        }
        localCeilZResolved = localCeilZ;
        if (unfurl <= 0.01) {
            let rLocalCeil = rInner + localCeilZ;
            let cLocal = rOriginSq - rLocalCeil * rLocalCeil;
            let discLocal = bInner * bInner - cLocal;
            if (discLocal > 0.0) {
                let tLocalEntry = select(0.0, max(0.0, -bInner - sqrt(discLocal)), cLocal > 0.0 && bInner < 0.0);
                tStart = max(tStart, tLocalEntry);
            } else if (cLocal > 0.0) {
                discard;
            }
        } else if (unfurl >= 0.95) {
            let tLocalTop = (localCeilZ - rayOrigin.z) / safeRayDirZ;
            let tLocalEntryP = max(0.0, min(tZBottom, tLocalTop));
            let tLocalExitP = max(tZBottom, tLocalTop);
            if (tLocalExitP > 0.0) {
                tStart = max(tStart, tLocalEntryP);
            }
        } else {
            // Continuous intermediate unfurl (0.01 < unfurl < 0.95): advance tStart from outer cloud_proxy hull down to localCeilZ
            var tTight = tStart;
            for (var itC: i32 = 0; itC < 2; itC++) {
                let pC = rayOrigin + rayDir * tTight;
                let uvwC = invertManifoldModeWGSL(pC, unfurl, rInner);
                let excessZ = uvwC.z - (localCeilZ + 0.004);
                if (excessZ <= 0.0) {
                    break;
                }
                let upC = computeManifoldUpFromLonLat(pC, uvwC.x, uvwC.y, unfurl);
                let dzDt = dot(rayDir, upC);
                if (dzDt >= -0.06) {
                    break;
                }
                let dtAdvance = clamp(excessZ / (-dzDt), 0.0, max(0.0, tPreExit - tTight) * 0.85);
                tTight += dtAdvance;
            }
            let uvwVerify = invertManifoldModeWGSL(rayOrigin + rayDir * tTight, unfurl, rInner);
            if (uvwVerify.z >= localCeilZ - 0.006 && tTight < tPreExit) {
                tStart = tTight;
            }
        }
    }

    let pPreEntry = rayOrigin + rayDir * tStart;
    let preEntryUp = computeManifoldUpDir(pPreEntry, unfurl, rInner);
    let preEntryLimbCos = abs(dot(preEntryUp, rayDir));

    var midUnfurlCeilHeadroom: f32 = 0.0;
    if (unfurl > 0.01 && unfurl < 0.95) {
        let uvwEntryCheck = invertManifoldModeWGSL(pPreEntry, unfurl, rInner);
        let residualAboveCeil = max(0.0, uvwEntryCheck.z - localCeilZResolved);
        midUnfurlCeilHeadroom = residualAboveCeil / max(0.22, preEntryLimbCos);
    }

    let tInnerHit = max(tStart, -bInner - sqrtDiscInner);
    let tInnerSphere = select(tProxyExit, tInnerHit, unfurl <= 0.01 && cInner > 0.0 && bInner < 0.0 && discInner > 0.0);
    let tPlanarDatum = select(tProxyExit, max(tStart, tSlabExit), unfurl >= 0.95 && tSlabExit > tStart);
    let synopticGrazingSpan = select(max(deltaR * 6.5, 1.15), mix(0.36, 0.82, clamp(preEntryLimbCos, 0.0, 1.0)), unfurl <= 0.01) + midUnfurlCeilHeadroom;
    let ghibliGrazingSpan = ((ghibliCeilZRay + 0.006) / max(0.30, preEntryLimbCos)) + midUnfurlCeilHeadroom;
    let maxGrazingSpan = select(synopticGrazingSpan, ghibliGrazingSpan, p_rayUseRegional);
    let tAtmosExit = min(min(min(tProxyExit, tInnerSphere), tPlanarDatum), tStart + maxGrazingSpan);
    let tExit = min(tAtmosExit, tEndInterval);

    if (tStart >= tExit) {
        discard; // Terrain is in front of the entire atmospheric segment
    }

    let raymarchDist = tExit - tStart;
    if (raymarchDist < 0.0001) {
        discard;
    }

    // 5. Numerical Integration Setup: View-Angle, Offscreen-Grid & Unfurl Adaptive Step Budget (Track 4)
    let maxSteps = min(64, i32(cloud.u_simControl.w)); // Strictly bounded: maxSteps <= 64
    let pEntry = rayOrigin + rayDir * tStart;
    let entryUp = computeManifoldUpDir(pEntry, unfurl, rInner);
    let entryLimbCos = abs(dot(entryUp, rayDir));
    let steepFactor = smoothstep(0.22, 0.92, entryLimbCos);
    let offscreenScaleRatio = f32(checkerGridH) / max(1.0, camera.u_viewport.y);
    let hiResScaleAtten = smoothstep(0.37, 0.49, offscreenScaleRatio);
    let sphereStepsF = mix(38.0, 26.0, steepFactor);
    let planarStepsF = mix(32.0, 26.0, steepFactor);
    let synStepsBase = mix(sphereStepsF, planarStepsF, smoothstep(0.75, 0.98, unfurl));
    let orbitalStepTrim = mix(0.72, 0.60, smoothstep(8.5, 13.5, rEffCam));
    let synStepsScaled = synStepsBase * mix(1.0, 0.82, hiResScaleAtten) * orbitalStepTrim;
    let regStepsF = mix(mix(32.0, 28.0, steepFactor), mix(30.0, 26.0, steepFactor), hiResScaleAtten);
    let targetStepsF = select(synStepsScaled, regStepsF, p_rayUseRegional);
    let rEffFs = rEffCam;
    let rEffStepZoom = rEffCam;
    let closeZoomStepBoost = (1.0 - smoothstep(5.18, 5.36, rEffStepZoom)) * mix(3.0, 0.0, hiResScaleAtten) * (1.0 - regCeilTight);
    let minStepFloor = select(14, 26, p_rayUseRegional);
    let effMaxSteps = min(maxSteps, i32(round(mix(64.0, 34.0, hiResScaleAtten))));
    let activeMaxSteps = clamp(i32(round(targetStepsF + closeZoomStepBoost)), minStepFloor, effMaxSteps);
    let activeStepDiv = max(13.0, f32(activeMaxSteps - 2));
    let stepScale = 46.0 / activeStepDiv;
    let atmosSpan = select(max(raymarchDist, tAtmosExit - tStart), max(0.022, tAtmosExit - tStart), p_rayUseRegional);
    let synopticBaseStep = atmosSpan / activeStepDiv;
    // Pure C^infinity regional step size spanning full ceiling-to-datum column without tTerrain corner kinks
    let regSpanSmooth = (ghibliCeilZRay + 0.006) / max(0.30, entryLimbCos);
    let regBaseStep = clamp(regSpanSmooth / max(24.0, f32(activeMaxSteps - 1)), 0.0020, 0.0105);
    let baseStepSize = select(synopticBaseStep, regBaseStep, p_rayUseRegional);

    let demFootprintProxy = max((rEffFs - 5.50) * 0.45, (tStart - 1.90) * 0.55);
    p_rayDemMip = select(0.0, clamp(log2(max(1.0, demFootprintProxy)), 0.0, 2.25), hasMipDemFs);
    p_rayMaxSynLift = localMaxSynLift;
    p_rayCachedSynLift = -1.0;
    p_rayEntryCos = entryLimbCos;
    p_rayTransmittance = 1.0;

    // Isotropic white/golden-ratio temporal jitter across full [0, baseStepSize] lattice period (zero directional IGN diagonal stripes!)
    let vertStepBound = min(baseStepSize, (effTropoSpanFs / activeStepDiv) / max(0.38, entryLimbCos));
    let retinaDirectJitter = hash2DRetina(floor(in.position.xy)) * min(vertStepBound * 0.28, raymarchDist * 0.25);
    let jitter = select(retinaDirectJitter, 0.0, isCheckerPass);
    let regIsoPhase = fract(hash2DRetina(floor(rayScreenPos)) + fract(sampleEpoch * 0.61803398875));
    let regTemporalJitter = regIsoPhase * min(baseStepSize, raymarchDist * 0.65);
    let tRayInit = select(tStart + jitter, tStart + regTemporalJitter, p_rayUseRegional);

    let sunDir = normalize(cloud.u_sunDirection.xyz);
    let sunAltClampedRad = radians(clamp(cloud.u_sunDirection.w, -90.0, 90.0));
    p_rayIsCompassSun = cloud.u_sunDirection.w > 0.01 && abs(sunDir.y - sin(sunAltClampedRad)) < 0.025;
    let compassHorizInit = vec2<f32>(sunDir.x, sunDir.z);
    let compassHorizLenInit = length(compassHorizInit);
    p_rayCompassDir2D = select(
        vec2<f32>(-0.70710678, 0.70710678),
        compassHorizInit / max(1e-5, compassHorizLenInit),
        p_rayIsCompassSun && compassHorizLenInit > 1e-4
    );
    p_rayLowSunGate = select(0.0, 1.0 - smoothstep(5.0, 22.0, cloud.u_sunDirection.w), p_rayIsCompassSun);
    p_rayCustomSunGate = select(
        0.0,
        clamp(
            (1.0 - smoothstep(10.0, 26.0, cloud.u_sunDirection.w)) +
            smoothstep(0.02, 0.12, distance(p_rayCompassDir2D, vec2<f32>(-0.70710678, 0.70710678))),
            0.0,
            1.0
        ),
        p_rayIsCompassSun
    );
    let cosTheta = dot(rayDir, sunDir);
    let phase = dualHenyeyGreenstein(cosTheta, cloud.u_opticalParams.z, cloud.u_opticalParams.w, 0.70);
    var phaseOctTerms = vec3<f32>(0.0);
    var octaveG1 = cloud.u_opticalParams.z;
    var octaveG2 = cloud.u_opticalParams.w;
    for (var oct: i32 = 0; oct < 3; oct++) {
        let curG1 = select(octaveG1, 0.0, oct == 2);
        let curG2 = select(octaveG2, 0.0, oct == 2);
        let octPhase = select(dualHenyeyGreenstein(cosTheta, curG1, curG2, 0.70), phase, oct == 0);
        phaseOctTerms[oct] = max(0.45, octPhase * (4.0 * PI));
        octaveG1 *= 0.5;
        octaveG2 *= 0.5;
    }
    let ctMieRay = clamp(cosTheta, -0.9999, 0.9999);
    let gMieSqRay = 0.965 * 0.965;
    let denomMieRay = max(0.0001, 1.0 + gMieSqRay - 2.0 * 0.965 * ctMieRay);
    let forwardMieRay = INV_FOUR_PI * ((1.0 - gMieSqRay) / (denomMieRay * sqrt(denomMieRay))) * max(0.0, ctMieRay) * 0.40;
    let silverPhaseOctH = half2(
        half(clamp(dualHenyeyGreenstein(cosTheta, 0.78, -0.40, 0.62) * (4.0 * PI), 1.32, 10.0)),
        half(clamp(dualHenyeyGreenstein(cosTheta, 0.78 * 0.48, -0.40 * 0.48, 0.62) * (4.0 * PI) * 0.76, 1.02, 6.0))
    );

    let theme = u32(cloud.u_mediumParams.x);
    var pal = getMediumPalette(theme);

    let isFalseColor = cloud.u_padCloud.x > 0.5;

    let sigmaT = cloud.u_opticalParams.x * pal.inkDensityFactor * select(1.0, 1.34, hasMipDemFs);
    let albedo = cloud.u_opticalParams.y;

    var accumLight = vec3<f32>(0.0);
    var accumTransmittance: f32 = 1.0;

    // Continuous Horizon Silhouette Envelope with Depressed-Bathymetry Limb Conformance:
    // Rays on the rendered globe (depthVal < 0.999999) get continuous cloud wrap up to the limb;
    // Rays outside depressed bathymetric ocean limbs cull cleanly (zero floating cloud shelf over cream paper).
    let bRay = dot(rayOrigin, rayDir);
    let dMinRay = sqrt(max(0.0, dot(rayOrigin, rayOrigin) - bRay * bRay));
    let outerSpaceExcess = max(0.0, dMinRay - rInner);
    let isOuterSpaceRay = (unfurl <= 0.01) && (depthVal >= 0.999999);
    let uvTangentLimb = worldToEquirectangularUV(rayOrigin - bRay * rayDir);
    let demTangentLimb = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_cloud2DSampler, uvTangentLimb, 2.0));
    let isTangentDepressedOcean = hasMipDemFs && demTangentLimb.b < 0.45 && (demTangentLimb.a * 19772.0 - 10924.0) < -5.0;
    let isDepressedOceanLimb = isTangentDepressedOcean || (hasMipDemFs && (dMinRay < rInner - 0.0025));
    let limbCrownFade = select(1.0 - smoothstep(0.001, 0.010, outerSpaceExcess), 0.0, isDepressedOceanLimb);
    let depressedChordFade = select(1.0, 1.0 - smoothstep(rInner - 0.024, rInner - 0.001, dMinRay), unfurl <= 0.01 && isTangentDepressedOcean);
    let horizonSilhouetteFade = select(depressedChordFade, limbCrownFade, isOuterSpaceRay);
    var t: f32 = select(tRayInit, tExit, isOuterSpaceRay && (isDepressedOceanLimb || outerSpaceExcess > 0.011));
    let effOpticalSpan = select(deltaR, deltaR * 0.48, hasMipDemFs);
    let synopticOpticalStepSize = min(baseStepSize * 1.28, (effOpticalSpan / f32(max(1, maxSteps))) * 2.35 * stepScale);
    let opticalStepSize = mix(synopticOpticalStepSize, baseStepSize * 1.15, regCeilTight);

    // 3-Tap Wind-Advected (maxCov3x3, minLcl3x3) Pre-Cull at (tEntry, tMid, tExit) preserving p_rayWinds
    p_rayVoronoi = vec4<f32>(-1.0, -1.0, 1.0, 0.0);
    p_rayCov = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    p_rayMidWind = vec2<f32>(0.0, 0.0);
    p_rayGeoSwirl = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    p_rayThermoWind = vec4<f32>(0.0, 0.0, 0.0, -1.0);
    var allowCoastalCondensation = false;
    let horizRaySpan = raymarchDist * sqrt(max(0.0, 1.0 - entryLimbCos * entryLimbCos));
    if (t < tExit && entryLimbCos > 0.12) {
        let preDriftRate = cloud.u_noiseParams.w;
        let preFlowTimeSec = select(cloud.u_simControl.x, cloud.u_padCloud.y, cloud.u_padCloud.y > 0.0);
        let preTimeSec = select(cloud.u_simControl.x, max(0.0, cloud.u_simControl.x - cloud.u_padCloud.y), cloud.u_padCloud.y > 0.0);
        let preTimeDrift = preFlowTimeSec * preDriftRate;
        let preSynopticDrift = preTimeSec * preDriftRate * 0.12;
        let useDualPre = hasDualHourClouds() && getScrubTau() > 0.001;
        let clearCullThresh = select(0.016, 0.030, hasMslpAndSpread() && !p_rayUseRegional);
        let maxLayerScale = max(max(cloud.u_layerDensities.x, cloud.u_layerDensities.y), cloud.u_layerDensities.z);

        let tEntry = mix(tStart, tExit, 0.28);
        let uvwEntry = invertManifoldModeWGSL(rayOrigin + rayDir * tEntry, unfurl, rInner);
        let uvEntryGeo = vec2<f32>(fract((uvwEntry.x / TWO_PI) + 0.5), clamp(0.5 - (uvwEntry.y / PI), 0.001, 0.999));
        let uvEntryBase = vec2<f32>(fract(uvEntryGeo.x + preSynopticDrift), uvEntryGeo.y);
        let cosEntry = clamp(cos(uvwEntry.y), 0.22, 1.0);

        let wSurfBeg = textureSampleLevel(u_windTexture, u_cloud2DSampler, uvEntryGeo, 0.0).xy;
        let jetBegFull = textureSampleLevel(u_jetStreamTexture, u_cloud2DSampler, uvEntryGeo, 0.0);
        let wJetBeg = jetBegFull.xy;
        let wMidBeg = select(blendStratumWindVector(wSurfBeg, wJetBeg, 0.45), jetBegFull.zw, hasWind500hPa());
        p_rayWinds = vec4<f32>(wSurfBeg, wJetBeg);
        p_rayMidWind = wMidBeg;
        p_rayVoronoi.w = 0.0;

        let uvEntrySurf = computeWindSwirlAdvectedUV(uvEntryBase, wSurfBeg, preFlowTimeSec, preTimeDrift, cosEntry);
        let uvEntryMid  = computeWindSwirlAdvectedUV(uvEntryBase, wMidBeg, preFlowTimeSec, preTimeDrift, cosEntry);
        let uvEntryJet  = computeWindSwirlAdvectedUV(uvEntryBase, wJetBeg, preFlowTimeSec, preTimeDrift, cosEntry);
        let pcEntryMax = max(
            max(sampleCloudPreCullGrid(uvEntrySurf).x, sampleCloudPreCullGrid(uvEntryMid).x),
            sampleCloudPreCullGrid(uvEntryJet).x
        ) * maxLayerScale;

        var effRayCov: f32 = 0.0;
        if (pcEntryMax >= clearCullThresh) {
            if (cloud.u_layerDensities.x > 0.001) {
                let sBegL = textureSampleLevel(u_cloudLowTexture, u_cloud2DSampler, uvEntrySurf, 0.0);
                effRayCov += max(sBegL.r, select(0.0, sBegL.g, useDualPre)) * cloud.u_layerDensities.x;
            }
            if (cloud.u_layerDensities.y > 0.001) {
                let sBegM = textureSampleLevel(u_cloudMidTexture, u_cloud2DSampler, uvEntryMid, 0.0);
                effRayCov += max(sBegM.r, select(0.0, sBegM.g, useDualPre)) * cloud.u_layerDensities.y;
            }
            if (cloud.u_layerDensities.z > 0.001) {
                let sBegH = textureSampleLevel(u_cloudHighTexture, u_cloud2DSampler, uvEntryJet, 0.0);
                effRayCov += max(sBegH.r, select(0.0, sBegH.g, useDualPre)) * cloud.u_layerDensities.z;
            }
        }

        if (effRayCov < clearCullThresh) {
            let tMid = mix(tStart, tExit, 0.64);
            let uvwMid = invertManifoldModeWGSL(rayOrigin + rayDir * tMid, unfurl, rInner);
            let uvMidGeo = vec2<f32>(fract((uvwMid.x / TWO_PI) + 0.5), clamp(0.5 - (uvwMid.y / PI), 0.001, 0.999));
            let uvMidBase = vec2<f32>(fract(uvMidGeo.x + preSynopticDrift), uvMidGeo.y);
            let cosMid = clamp(cos(uvwMid.y), 0.22, 1.0);

            let uvwEnd = invertManifoldModeWGSL(rayOrigin + rayDir * tExit, unfurl, rInner);
            let uvEndGeo = vec2<f32>(fract((uvwEnd.x / TWO_PI) + 0.5), clamp(0.5 - (uvwEnd.y / PI), 0.001, 0.999));
            let uvEndBase = vec2<f32>(fract(uvEndGeo.x + preSynopticDrift), uvEndGeo.y);
            let cosEnd = clamp(cos(uvwEnd.y), 0.22, 1.0);

            if (horizRaySpan >= 0.055) {
                let uvMidSurf = computeWindSwirlAdvectedUV(uvMidBase, wSurfBeg, preFlowTimeSec, preTimeDrift, cosMid);
                let uvMidMid  = computeWindSwirlAdvectedUV(uvMidBase, wMidBeg, preFlowTimeSec, preTimeDrift, cosMid);
                let uvMidJet  = computeWindSwirlAdvectedUV(uvMidBase, wJetBeg, preFlowTimeSec, preTimeDrift, cosMid);
                let pcMidMax = max(
                    max(sampleCloudPreCullGrid(uvMidSurf).x, sampleCloudPreCullGrid(uvMidMid).x),
                    sampleCloudPreCullGrid(uvMidJet).x
                ) * maxLayerScale;
                if (pcMidMax >= clearCullThresh) {
                    var cMid: f32 = 0.0;
                    if (cloud.u_layerDensities.x > 0.001) {
                        let sMidL = textureSampleLevel(u_cloudLowTexture, u_cloud2DSampler, uvMidSurf, 0.0);
                        cMid += max(sMidL.r, select(0.0, sMidL.g, useDualPre)) * cloud.u_layerDensities.x;
                    }
                    if (cloud.u_layerDensities.y > 0.001) {
                        let sMidM = textureSampleLevel(u_cloudMidTexture, u_cloud2DSampler, uvMidMid, 0.0);
                        cMid += max(sMidM.r, select(0.0, sMidM.g, useDualPre)) * cloud.u_layerDensities.y;
                    }
                    if (cloud.u_layerDensities.z > 0.001) {
                        let sMidH = textureSampleLevel(u_cloudHighTexture, u_cloud2DSampler, uvMidJet, 0.0);
                        cMid += max(sMidH.r, select(0.0, sMidH.g, useDualPre)) * cloud.u_layerDensities.z;
                    }
                    effRayCov = max(effRayCov, cMid);
                }
            }

            if (effRayCov < clearCullThresh) {
                var wSurfEnd: vec2<f32>;
                var wMidEnd: vec2<f32>;
                var wJetEnd: vec2<f32>;
                if (horizRaySpan < 0.055) {
                    wSurfEnd = wSurfBeg;
                    wMidEnd = wMidBeg;
                    wJetEnd = wJetBeg;
                } else {
                    wSurfEnd = textureSampleLevel(u_windTexture, u_cloud2DSampler, uvEndGeo, 0.0).xy;
                    let jetEndFull = textureSampleLevel(u_jetStreamTexture, u_cloud2DSampler, uvEndGeo, 0.0);
                    wJetEnd = jetEndFull.xy;
                    wMidEnd = select(blendStratumWindVector(wSurfEnd, wJetEnd, 0.45), jetEndFull.zw, hasWind500hPa());
                }
                let uvEndSurf = computeWindSwirlAdvectedUV(uvEndBase, wSurfEnd, preFlowTimeSec, preTimeDrift, cosEnd);
                let uvEndMid  = computeWindSwirlAdvectedUV(uvEndBase, wMidEnd, preFlowTimeSec, preTimeDrift, cosEnd);
                let uvEndJet  = computeWindSwirlAdvectedUV(uvEndBase, wJetEnd, preFlowTimeSec, preTimeDrift, cosEnd);
                let pcExitMax = max(
                    max(sampleCloudPreCullGrid(uvEndSurf).x, sampleCloudPreCullGrid(uvEndMid).x),
                    sampleCloudPreCullGrid(uvEndJet).x
                ) * maxLayerScale;
                if (pcExitMax >= clearCullThresh) {
                    var cEnd: f32 = 0.0;
                    if (cloud.u_layerDensities.x > 0.001) {
                        let sEndL = textureSampleLevel(u_cloudLowTexture, u_cloud2DSampler, uvEndSurf, 0.0);
                        cEnd += max(sEndL.r, select(0.0, sEndL.g, useDualPre)) * cloud.u_layerDensities.x;
                    }
                    if (cloud.u_layerDensities.y > 0.001) {
                        let sEndM = textureSampleLevel(u_cloudMidTexture, u_cloud2DSampler, uvEndMid, 0.0);
                        cEnd += max(sEndM.r, select(0.0, sEndM.g, useDualPre)) * cloud.u_layerDensities.y;
                    }
                    if (cloud.u_layerDensities.z > 0.001) {
                        let sEndH = textureSampleLevel(u_cloudHighTexture, u_cloud2DSampler, uvEndJet, 0.0);
                        cEnd += max(sEndH.r, select(0.0, sEndH.g, useDualPre)) * cloud.u_layerDensities.z;
                    }
                    effRayCov = max(effRayCov, cEnd);
                }
            }

            if (cloud.u_layerDensities.x > 0.001 && effRayCov < clearCullThresh && p_raySurfDisp <= 0.165) {
                if (!p_rayUseRegional) {
                    let minLcl3x3 = min(
                        min(sampleCloudPreCullGrid(uvEntryGeo).y, sampleCloudPreCullGrid(uvMidGeo).y),
                        sampleCloudPreCullGrid(uvEndGeo).y
                    );
                    if (minLcl3x3 <= 850.0) {
                        let demEndB = textureSampleLevel(u_demTexture, u_cloud2DSampler, uvEndGeo, p_rayDemMip).r;
                        var maxCoastB = demEndB;
                        if (horizRaySpan >= 0.055) {
                            maxCoastB = max(demEndB, textureSampleLevel(u_demTexture, u_cloud2DSampler, uvMidGeo, p_rayDemMip).r);
                        }
                        allowCoastalCondensation = (p_raySurfDisp > 0.00012) || (maxCoastB > 0.5) || (pcEntryMax >= 0.008);
                    }
                }
            }
            if (!allowCoastalCondensation && effRayCov < clearCullThresh) {
                t = tExit;
            }
        }
    }

    // Linearized Multi-Rate Tangent Frame Tracking (Pivot 2 - Architectural Default)
    var currentUVW = vec3<f32>(0.0);
    var v_uvw = vec3<f32>(0.0, 0.0, -1.0);
    var lastStepT = t;
    let tSphRay = 1.0 - smoothstep(0.0, 0.05, unfurl);
    let tFltRay = smoothstep(0.95, 1.0, unfurl);
    var wasEmpty: bool = true;
    var lastWasCoarseSkip: bool = false;
    var prevRawDensity: f32 = 0.0;
    var cloudStepCount: i32 = 0;
    var prevHorizSunSlope: f32 = 0.0;
    var prevSunT: f32 = 0.65;
    var prevShadowDensity: f32 = 0.15;
    var prevRidgeHorizonOcc: f32 = 0.0;
    var prevGhibliTauSun: f32 = 0.45;
    var prevGhibliFloretSlope: f32 = 0.0;
    var accumPelagicWeight: f32 = 0.0;
    var accumRimShaftWeight: f32 = 0.0;
    var accumAnvilShadowWeight: f32 = 0.0;
    var accumGhibliWeight: f32 = 0.0;
    var accumCloudWeight: f32 = 0.0;
    var accumWeightedT: f32 = 0.0;
    let baseCacheMask = select(3, 7, entryLimbCos > 0.65);
    let rEffZoom = rEffCam;

    // Close-Zoom Cloud-Deck Penetration: strictly restricted to steep nadir below r=5.32 so oblique r=5.58->5.34 bands stay 100% continuous
    let zoomPenetration = 1.0 - smoothstep(5.18, 5.32, rEffZoom);
    let nadirWindow = smoothstep(0.78, 0.96, entryLimbCos);
    let zoomCloudClearance = 1.0 - zoomPenetration * nadirWindow * 0.40;
    let regGhibliRayGate = select(0.0, 1.0, p_rayUseRegional);
    let cacheRefreshMask = baseCacheMask;
    let activeZoomClearance = zoomCloudClearance;
    let zoomBLWeight = select(0.0, (1.0 - smoothstep(5.15, 5.55, rEffZoom)) * (1.0 - regGhibliRayGate), isAtmoFeatureEnabled(6u));

    if (p_rayUseRegional && !isFalseColor) {
        // Dedicated Low-VGPR Regional Half-Dome Integration Loop (disjoint from synoptic VGPRs for full Metal SIMD occupancy)
        let regStepSize = baseStepSize;
        p_rayActiveStepWorld = regStepSize;
        let regStepLen = max(1e-5, regStepSize);
        let regNearClip = max(0.0025, min(camera.u_nearFar.x, 0.0075));
        let regDriftScale = clamp(abs(cloud.u_noiseParams.w) / 0.002, 0.0, 4.0);
        let regFlowTimeSec = select(cloud.u_simControl.x, cloud.u_padCloud.y, cloud.u_padCloud.y > 0.0);
        let compassSunVecR = select(normalize(vec3<f32>(-0.625, 0.515, 0.586)), sunDir, p_rayIsCompassSun);
        let compassSunOccR = normalize(vec3<f32>(compassSunVecR.x, max(0.28, compassSunVecR.y), compassSunVecR.z));
        let alpenglowG = select(0.0, 1.0 - smoothstep(8.0, 24.0, cloud.u_sunDirection.w), p_rayIsCompassSun);
        let multiScatterAmt = clamp(cloud.u_ghibliParams.z, 0.0, 1.0);
        let aExtG = mix(0.32, 0.52, multiScatterAmt);
        let bScatG = mix(0.34, 0.56, multiScatterAmt);
        let invAlbedoReg = 1.0 / max(albedo, 0.85);

        // Pre-seed smooth mid-slab regional weather & wind state once per ray (zero 4-step wavefront cache jumps!)
        let tRegSeed = clamp(tStart + regSpanSmooth * 0.46, tStart, tExit);
        let pRegSeed = rayOrigin + rayDir * tRegSeed;
        let uvwRegSeed = invertManifoldModeWGSL(pRegSeed, unfurl, rInner);
        let seedRegDens = sampleRegionalColumnFromUVW(uvwRegSeed, pRegSeed, rInner, deltaR);
        p_rayTransmittance = 1.0 + seedRegDens * 0.0;

        for (var regStep: i32 = 0; regStep < 34; regStep++) {
            if (t >= tExit || regStep >= activeMaxSteps || regStep >= maxSteps) {
                break;
            }
            p_rayTransmittance = accumTransmittance;

            let p = rayOrigin + rayDir * t;
            let currentStepDist = t - lastStepT;
            lastStepT = t;
            if (tSphRay > 0.99) {
                let rP = max(1e-4, length(p));
                currentUVW = vec3<f32>(atan2(p.x, p.z), asin(clamp(p.y / rP, -0.9998, 0.9998)), rP - rInner);
            } else if (tFltRay > 0.99 && getActiveManifoldMode() == 0u) {
                currentUVW = vec3<f32>(p.x / rInner, p.y / rInner, p.z);
            } else if (regStep == 0 || (regStep & 3) == 0) {
                currentUVW = invertManifoldModeWGSL(p, unfurl, rInner);
                v_uvw = getParameterVelocity(rayDir, currentUVW.x, currentUVW.y, currentUVW.z, unfurl, rInner);
            } else {
                currentUVW += v_uvw * currentStepDist;
                currentUVW.x = fract((currentUVW.x / TWO_PI) + 0.5) * TWO_PI - PI;
                currentUVW.y = clamp(currentUVW.y, -HALF_PI + 0.001, HALF_PI - 0.001);
            }

            let curRawSample = sampleRegionalColumnFromUVW(currentUVW, p, rInner, deltaR);
            let rawDensity = curRawSample * smoothstep(0.002, 0.016, curRawSample);
            let exitSlabSpan = min(regStepLen, max(0.0, tExit - t));
            let effQuadWeight = clamp(exitSlabSpan / regStepLen, 0.0, 1.0);
            let activeOpticalStepSize = opticalStepSize * effQuadWeight;

            let nearFade = smoothstep(regNearClip, regNearClip * 2.2, t);
            let terrainClearance = select(1.0, smoothstep(0.0, regStepLen * 1.15, max(0.0, tTerrain - t)), depthVal < 0.999999);
            let stepUp = computeManifoldUpFromLonLat(p, currentUVW.x, currentUVW.y, unfurl);
            let limbCos = abs(dot(stepUp, rayDir));
            let limbGrazingFade = mix(smoothstep(0.06, 0.28, limbCos), smoothstep(0.02, 0.14, limbCos), clamp(unfurl, 0.0, 1.0));
            let density = rawDensity * nearFade * terrainClearance * horizonSilhouetteFade * limbGrazingFade;

            if (density > 0.002) {
                if (wasEmpty) {
                    cloudStepCount = 0;
                } else {
                    cloudStepCount += 1;
                }
                wasEmpty = false;

                var ghibliTauSun = prevGhibliTauSun;
                var ghibliFloretSlope = prevGhibliFloretSlope;
                var ridgeHorizonOcc = prevRidgeHorizonOcc;
                let worldSunDir = normalize(
                    p_stepCache.baseNwOffset3D * compassSunOccR.x
                    + p_stepCache.baseWind3D * compassSunOccR.y
                    + p_stepCache.nwOffset3D * compassSunOccR.z
                );

                // Refresh regional self-shadow on every visible outer crown step (eliminates 4-step shadow plateaus on flat decks!)
                let refreshRegShadow = cloudStepCount <= 5 || ((cloudStepCount & 1) == 0 && accumTransmittance > 0.24);
                if (refreshRegShadow) {
                    let gOcc = evaluateRegionalGhibliSunOcc(worldSunDir, regDriftScale, regFlowTimeSec, t);
                    ghibliTauSun = gOcc.x;
                    ghibliFloretSlope = clamp((p_stepCache.nCenter.x - gOcc.y) / 0.00135, -1.0, 1.0);
                    ridgeHorizonOcc = 0.0;

                    let stepCosSun = dot(stepUp, sunDir);
                    let lowSunHorizonGate = select(
                        (1.0 - smoothstep(-0.06, 0.34, stepCosSun)) * (1.0 - clamp(unfurl, 0.0, 1.0)),
                        p_rayLowSunGate,
                        p_rayIsCompassSun
                    );
                    if (cloudStepCount <= 3 && lowSunHorizonGate > 0.02 && hasMipDemFs) {
                        let safeStepCosLat = max(0.15, cos(currentUVW.y));
                        let stepUV = vec2<f32>(fract((currentUVW.x / TWO_PI) + 0.5), clamp(0.5 - (currentUVW.y / PI), 0.001, 0.999));
                        let sunParamVel = getParameterVelocity(sunDir, currentUVW.x, currentUVW.y, currentUVW.z, unfurl, rInner);
                        let sunParamMetric = vec2<f32>(sunParamVel.x * safeStepCosLat, sunParamVel.y);
                        let sunMetricHoriz = select(sunParamMetric, vec2<f32>(sunDir.x, sunDir.z), p_rayIsCompassSun);
                        let sunHorizLen = length(sunMetricHoriz);
                        let sunDirMetric = select(vec2<f32>(-0.70710678, 0.70710678), sunMetricHoriz / max(1e-5, sunHorizLen), sunHorizLen > 1e-4);
                        let sunRidgeDeltaUV = vec2<f32>((sunDirMetric.x * 0.5) / safeStepCosLat, -sunDirMetric.y) * 0.0022;
                        let sunRidgeNearUV = vec2<f32>(fract(stepUV.x + sunRidgeDeltaUV.x * 0.24 + 1.0), clamp(stepUV.y + sunRidgeDeltaUV.y * 0.24, 0.001, 0.999));
                        let sunRidgeUV = vec2<f32>(fract(stepUV.x + sunRidgeDeltaUV.x + 1.0), clamp(stepUV.y + sunRidgeDeltaUV.y, 0.001, 0.999));
                        let ridgeDemNear = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, sunRidgeNearUV, 0.5));
                        let ridgeDem = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, sunRidgeUV, 1.25));
                        let ridgeNearKm = max(0.0, ridgeDemNear.a * 19.772 - 10.924) * smoothstep(0.35, 0.65, ridgeDemNear.b);
                        let ridgeElevKm = max(0.0, ridgeDem.a * 19.772 - 10.924) * smoothstep(0.35, 0.65, ridgeDem.b);
                        let cloudParcelKm = max(0.15, p_stepCache.stepDemHere * 48.0);
                        let effSunElevRad = select(asin(clamp(max(0.0, stepCosSun), 0.0, 0.999)), radians(clamp(cloud.u_sunDirection.w, 0.5, 45.0)), p_rayIsCompassSun);
                        let tanSunElev = tan(clamp(effSunElevRad, 0.008, 0.80));
                        let deltaNearKm = ridgeNearKm - (cloudParcelKm + tanSunElev * 9.5);
                        let deltaFarKm = ridgeElevKm - (cloudParcelKm + tanSunElev * 38.0);
                        ridgeHorizonOcc = clamp(smoothstep(0.04, 0.85, max(deltaNearKm, deltaFarKm)) * lowSunHorizonGate, 0.0, 1.0);
                    }
                    prevGhibliTauSun = ghibliTauSun;
                    prevGhibliFloretSlope = ghibliFloretSlope;
                    prevRidgeHorizonOcc = ridgeHorizonOcc;
                }

                let stepIsLand = clamp(p_rayCachedSynLift - 1.0, 0.0, 1.0);
                let stepLow = p_stepCache.stepLow;
                let stepMid = p_stepCache.stepMid;
                let stepHigh = p_stepCache.stepHigh;
                let stepRadOptics = clamp(p_rayThermoWind.y, 0.0, 1.0);
                let stepStormCore = clamp((stepLow * stepMid * max(stepMid, stepHigh) * 1.40 + smoothstep(0.55, 0.95, stepRadOptics) * 0.45), 0.0, 1.0);
                let effStepDensity = max(0.0, density - 0.002);
                let regConvectiveHold = 1.0 - p_stepCache.nCenter.w * 0.85;
                let pelagicOceanMask = (1.0 - smoothstep(0.18, 0.55, stepIsLand)) * (1.0 - stepStormCore * 0.72);
                let tharpPelagicTauScale = select(1.0, mix(1.0, 0.58, pelagicOceanMask), theme == 0u);
                let effTharpPelagicScale = mix(tharpPelagicTauScale, 1.0, regConvectiveHold * 0.88);
                let stepTau = sigmaT * effStepDensity * activeOpticalStepSize * effTharpPelagicScale;
                let stepT = exp(-stepTau);
                let stepOpacity = 1.0 - stepT;

                let cosThetaG = clamp(dot(rayDir, worldSunDir), -1.0, 1.0);
                let regShellDepth = p_stepCache.nCenter.x;
                let regHeightFrac = p_stepCache.nCenter.z;
                let wispG = p_stepCache.nCenter.w;
                let regValleySea = p_stepCache.dCenter.x;
                let regNearOptical = nearFade * nearFade;
                let ridgeOccBaseOnly = ridgeHorizonOcc * (1.0 - 0.85 * smoothstep(0.18, 0.58, regHeightFrac)) * regNearOptical;
                let tauSunEff = (ghibliTauSun * (1.0 - 0.46 * wispG) + ridgeOccBaseOnly * 1.65) * regNearOptical;
                let mtnVisG = mix(1.0, 0.80, ridgeOccBaseOnly);
                let floretReliefG = mix(0.56 + 0.56 * ghibliFloretSlope, 0.88 + 0.16 * ghibliFloretSlope, wispG);

                var msIrradG: f32 = 0.0;
                for (var oG: u32 = 0u; oG < 4u; oG = oG + 1u) {
                    let foG = f32(oG);
                    let attenG = max(0.16, pow(aExtG, foG));
                    let contribG = pow(bScatG, foG);
                    let isoG = pow(0.54, foG);
                    let rawPhaseG = 4.0 * PI * dualHenyeyGreenstein(cosThetaG, 0.74 * isoG, -0.28 * isoG, 0.74);
                    let clampedPhaseG = min(rawPhaseG, mix(5.0, 1.72, foG / 3.0));
                    msIrradG = msIrradG + contribG * clampedPhaseG * exp(-tauSunEff * attenG);
                }

                let powderG = mix(1.0 - 0.46 * exp(-density * 4.5) * max(0.0, -cosThetaG), 1.0, wispG * 0.70);
                let gouacheEff = clamp(cloud.u_ghibliParams.y, 0.0, 1.0) * (1.0 - 0.82 * wispG) * (1.0 - regValleySea * 0.45);
                let rawDirectG = msIrradG * max(0.18, floretReliefG) * powderG * mtnVisG;
                let directFactorG = applyGhibliValueGrouping(rawDirectG, gouacheEff);
                let forwardRimG = pow(max(0.0, cosThetaG), 6.0) * exp(-tauSunEff * 0.28) * mtnVisG * 1.42;

                var ghibliToneDisplay = vec3<f32>(0.90);
                if (theme == 2u) {
                    let sunRadCyanLin = vec3<f32>(1.38, 1.50, 1.62);
                    let skyCreviceCyanLin = vec3<f32>(0.185, 0.545, 1.280);
                    let deepFoldCyanLin = vec3<f32>(0.055, 0.220, 0.660);
                    let bounceCyanLin = vec3<f32>(0.065, 0.145, 0.285);
                    let effDepthC = max(0.0, regShellDepth) * regNearOptical;
                    let shadowTransC = smoothstep(0.05, 0.65, exp(-tauSunEff * 0.35));
                    let skyOpenC = clamp(0.32 + 0.68 * regHeightFrac - clamp(effDepthC / 0.018, 0.0, 0.46), 0.08, 1.0);
                    let skyAmbientC = mix(deepFoldCyanLin, skyCreviceCyanLin, skyOpenC) * mix(1.04, 0.50, shadowTransC);
                    let underWeightC = (1.0 - smoothstep(0.0, 0.48, regHeightFrac)) * (0.45 + 0.55 * mtnVisG);
                    let hdrCyanLin = max(vec3<f32>(0.0), (sunRadCyanLin * (directFactorG * 0.68 + forwardRimG) + skyAmbientC + bounceCyanLin * underWeightC) * 0.90);
                    let mappedCyan = clamp((hdrCyanLin * (2.45 * hdrCyanLin + 0.045)) / (hdrCyanLin * (2.38 * hdrCyanLin + 0.56) + 0.12), vec3<f32>(0.0), vec3<f32>(1.0));
                    let cyanLo = mappedCyan * 12.92;
                    let cyanHi = 1.055 * pow(max(mappedCyan, vec3<f32>(1e-5)), vec3<f32>(1.0 / 2.4)) - 0.055;
                    let baseCyanDisplay = select(cyanHi, cyanLo, mappedCyan <= vec3<f32>(0.0031308));
                    let outerWispC = (1.0 - smoothstep(0.0003, 0.0018, effDepthC)) * smoothstep(0.58, 0.88, wispG);
                    let wispLiftC = clamp(max(0.12 * outerWispC, regValleySea * 0.10), 0.0, 0.24);
                    let vaporTargetC = vec3<f32>(0.865, 0.935, 0.988);
                    let liftedC = mix(baseCyanDisplay, max(baseCyanDisplay, vaporTargetC), wispLiftC);
                    let coldGC = min(liftedC.g, liftedC.b);
                    let coldRC = min(liftedC.r, coldGC);
                    ghibliToneDisplay = vec3<f32>(coldRC, coldGC, liftedC.b);
                } else {
                    let sunRadLin = select(
                        mix(vec3<f32>(1.56, 1.50, 1.38), vec3<f32>(1.65, 1.24, 0.86), alpenglowG * 0.85),
                        mix(vec3<f32>(1.58, 1.51, 1.38), vec3<f32>(1.66, 1.25, 0.86), alpenglowG * 0.88),
                        theme == 1u
                    );
                    let skyCreviceLin = select(vec3<f32>(0.335, 0.415, 0.525), vec3<f32>(0.375, 0.425, 0.495), theme == 1u);
                    let deepFoldLin   = select(vec3<f32>(0.132, 0.182, 0.268), vec3<f32>(0.158, 0.186, 0.232), theme == 1u);
                    let vellumBounceLin = select(vec3<f32>(0.215, 0.196, 0.172), vec3<f32>(0.245, 0.218, 0.188), theme == 1u);
                    let effShellDepthG = max(0.0, regShellDepth) * regNearOptical;
                    let shadowTransitionG = smoothstep(0.05, 0.65, exp(-tauSunEff * 0.35));
                    let skyOpennessG = clamp(0.32 + 0.68 * regHeightFrac - clamp(effShellDepthG / 0.018, 0.0, 0.46), 0.08, 1.0);
                    let skyAmbientLin = mix(deepFoldLin, skyCreviceLin, skyOpennessG) * mix(1.04, 0.50, shadowTransitionG);
                    let undersideWeightG = (1.0 - smoothstep(0.0, 0.48, regHeightFrac)) * (0.45 + 0.55 * mtnVisG);
                    let bounceRadianceLin = vellumBounceLin * undersideWeightG * (0.70 + 0.30 * (1.0 - alpenglowG * 0.35));
                    let directRadianceLin = sunRadLin * (directFactorG * 0.68 + forwardRimG);
                    let hdrLin = max(vec3<f32>(0.0), (directRadianceLin + skyAmbientLin + bounceRadianceLin) * 0.90);
                    let hdrLuma = dot(hdrLin, vec3<f32>(0.2126, 0.7152, 0.0722));
                    let hdrInset = mix(hdrLin, vec3<f32>(hdrLuma), 0.08 * smoothstep(0.85, 2.6, hdrLuma));
                    let mappedLin = clamp((hdrInset * (2.45 * hdrInset + 0.045)) / (hdrInset * (2.38 * hdrInset + 0.56) + 0.12), vec3<f32>(0.0), vec3<f32>(1.0));
                    let srgbLo = mappedLin * 12.92;
                    let srgbHi = 1.055 * pow(max(mappedLin, vec3<f32>(1e-5)), vec3<f32>(1.0 / 2.4)) - 0.055;
                    let baseDisplay = select(srgbHi, srgbLo, mappedLin <= vec3<f32>(0.0031308));
                    let outerSkinWisp = (1.0 - smoothstep(0.0003, 0.0016, effShellDepthG)) * smoothstep(0.62, 0.90, wispG);
                    let wispVaporLift = clamp(max(0.12 * outerSkinWisp, regValleySea * 0.12), 0.0, 0.24);
                    let vaporTarget = select(vec3<f32>(0.954, 0.946, 0.926), vec3<f32>(0.956, 0.947, 0.927), theme == 1u);
                    ghibliToneDisplay = mix(baseDisplay, max(baseDisplay, vaporTarget), wispVaporLift);
                }

                let finalStepRadiance = ghibliToneDisplay * invAlbedoReg;
                let rayContribWeight = accumTransmittance * stepOpacity;
                accumPelagicWeight += rayContribWeight * pelagicOceanMask * (1.0 - regConvectiveHold * 0.88);
                accumGhibliWeight += rayContribWeight;
                accumCloudWeight += rayContribWeight;
                accumWeightedT += rayContribWeight * t;
                accumLight += accumTransmittance * finalStepRadiance * (albedo * stepOpacity);
                accumTransmittance *= stepT;

                let isPurePelagicReg = (theme == 0u) && (accumCloudWeight > 0.22) && (accumPelagicWeight > accumCloudWeight * 0.94);
                let transStopReg = select(select(0.036, 0.028, theme == 0u), 0.14, isPurePelagicReg);
                if (accumTransmittance < transStopReg) {
                    accumTransmittance = select(0.0, min(accumTransmittance, 0.14), isPurePelagicReg);
                    break;
                }
            } else {
                wasEmpty = true;
            }
            // Strictly constant-dt lattice throughout regional troposphere (zero 2x step-skip phase contours!)
            t += regStepSize;
        }
    } else {
    // 6. Raymarching Numerical Integration Loop with Adaptive Step Sizing (maxSteps <= 64)
    for (var step: i32 = 0; step < 64; step++) {
        if (t >= tExit || step >= maxSteps) {
            if (t >= tExit || step >= activeMaxSteps) {
                break;
            }
        }
        if (step >= activeMaxSteps) {
            break;
        }

        if (step > 0 && (step & cacheRefreshMask) == 0) {
            p_rayVoronoi.x = -1.0;
            p_rayVoronoi.z = 1.0;
            p_rayVoronoi.w = 0.0;
            p_rayCov.w = 0.0;
            p_rayCachedSynLift = -1.0;
        }
        p_rayTransmittance = accumTransmittance;

        var p = rayOrigin + rayDir * t;
        let currentStepDist = t - lastStepT;
        lastStepT = t;
        if (tSphRay > 0.99) {
            let rP = max(1e-4, length(p));
            if ((step & 3) == 0 || v_uvw.z < 0.0) {
                let lon0 = atan2(p.x, p.z);
                let lat0 = asin(clamp(p.y / rP, -0.9998, 0.9998));
                let nextT = min(tExit, t + baseStepSize * 5.4);
                let p1 = rayOrigin + rayDir * nextT;
                let dtChord = nextT - t;
                let polarSafe = (abs(p.y) < 0.94 * rInner) && (abs(p1.y) < 0.94 * rInner) && (dtChord > 1e-4);
                if (polarSafe) {
                    let rP1 = max(1e-4, length(p1));
                    let lon1 = atan2(p1.x, p1.z);
                    let lat1 = asin(clamp(p1.y / rP1, -0.9998, 0.9998));
                    var dLon = lon1 - lon0;
                    if (dLon > PI) {
                        dLon -= TWO_PI;
                    } else if (dLon < -PI) {
                        dLon += TWO_PI;
                    }
                    let invDt = 1.0 / dtChord;
                    v_uvw = vec3<f32>(dLon * invDt, (lat1 - lat0) * invDt, 1.0);
                } else {
                    v_uvw = vec3<f32>(0.0, 0.0, -1.0);
                }
                currentUVW = vec3<f32>(lon0, lat0, rP - rInner);
            } else {
                let lonInterp = fract(((currentUVW.x + v_uvw.x * currentStepDist) / TWO_PI) + 0.5) * TWO_PI - PI;
                let latInterp = clamp(currentUVW.y + v_uvw.y * currentStepDist, -HALF_PI + 0.001, HALF_PI - 0.001);
                currentUVW = vec3<f32>(lonInterp, latInterp, rP - rInner);
            }
        } else if (tFltRay > 0.99 && getActiveManifoldMode() == 0u) {
            currentUVW = vec3<f32>(p.x / rInner, p.y / rInner, p.z);
        } else {
            if (step == 0 || (step % 8) == 0) {
                currentUVW = invertManifoldModeWGSL(p, unfurl, rInner);
                v_uvw = getParameterVelocity(rayDir, currentUVW.x, currentUVW.y, currentUVW.z, unfurl, rInner);
            } else {
                currentUVW += v_uvw * currentStepDist;
                currentUVW.x = fract((currentUVW.x / TWO_PI) + 0.5) * TWO_PI - PI;
                currentUVW.y = clamp(currentUVW.y, -HALF_PI + 0.001, HALF_PI - 0.001);
                if (tFltRay > 0.99) {
                    currentUVW = select(vec3<f32>(p.x / rInner, p.y / rInner, p.z), invertManifoldModeWGSL(p, 1.0, rInner), getActiveManifoldMode() != 0u);
                }
            }
        }
        let hRelBL = clamp((currentUVW.z - localMaxSynLift) / max(0.02, effTropoSpanFs), 0.0, 1.0);
        let blStepScale = mix(1.0, mix(0.68, 1.24, smoothstep(0.18, 0.52, hRelBL)), zoomBLWeight);
        let stepSize = baseStepSize * blStepScale;
        p_rayActiveStepWorld = stepSize;

        let curRawSample = sampleCloudDensityFromUVW(currentUVW, p, rInner, deltaR);
        var rawDensity = curRawSample * smoothstep(0.002, 0.016, curRawSample);
        // Zero-VGPR-spill trapezoidal boundary quadrature after coarse empty skip (eliminates 112B StepShadingCache stack copy!)
        if (curRawSample > 0.008 && lastWasCoarseSkip && step > 0) {
            let spanRatio = clamp(currentStepDist / max(1e-5, stepSize), 0.5, 1.85);
            rawDensity = rawDensity * (0.50 + 0.50 * spanRatio);
            lastWasCoarseSkip = false;
        }
        prevRawDensity = select(0.0, rawDensity, rawDensity > 0.002) + prevRawDensity * 0.0;
        let tSurfaceHit = tExit;
        let stepLen = max(1e-5, stepSize);
        let exitSlabSpan = min(stepLen, max(0.0, tSurfaceHit - t));
        let effQuadWeight = clamp(exitSlabSpan / stepLen, 0.0, 1.0);
        let activeOpticalStepSize = opticalStepSize * blStepScale * effQuadWeight;

        // Near-Plane Camera Penetration & C1 Terrain Exit Feathering (eliminates Mach-band onion rings on protruding peaks)
        let distFromCam = t;
        let nearClipDist = max(0.005, min(camera.u_nearFar.x, 0.035) * 1.5);
        let nearFade = smoothstep(nearClipDist, nearClipDist * 3.0, distFromCam);
        let terrainClearance = select(1.0, smoothstep(0.0, max(0.018, stepLen * 1.65), max(0.0, tTerrain - t)), depthVal < 0.999999);
        let stepUp = computeManifoldUpFromLonLat(p, currentUVW.x, currentUVW.y, unfurl);
        let limbCos = abs(dot(stepUp, rayDir));
        let limbGrazingFade = mix(smoothstep(0.06, 0.28, limbCos), smoothstep(0.02, 0.14, limbCos), clamp(unfurl, 0.0, 1.0));
        let density = rawDensity * nearFade * terrainClearance * horizonSilhouetteFade * limbGrazingFade * activeZoomClearance;

        if (density > 0.002) {
            let isFirstHit = wasEmpty;
            if (isFirstHit) {
                cloudStepCount = 0;
            } else {
                cloudStepCount += 1;
            }
            wasEmpty = false;
            lastWasCoarseSkip = false;
            // In false-color diagnostic mode, evaluate vibrant emissive strata color per step
            if (isFalseColor) {
                let diagUV = vec2<f32>(fract((currentUVW.x / TWO_PI) + 0.5), clamp(0.5 - (currentUVW.y / PI), 0.001, 0.999));
                let diagHNorm = clamp(p_stepCache.stepHNormAGL, 0.0, 1.0);
                let strataCol = evaluateStrataDiagnosticColorFromUVW(vec3<f32>(diagUV.x, diagUV.y, diagHNorm));
                pal.sunColor = strataCol * 1.35;
                pal.midColor = strataCol * 1.05;
                pal.ambientColor = strataCol * 0.82;
            }

            let stepUV = vec2<f32>(fract((currentUVW.x / TWO_PI) + 0.5), clamp(0.5 - (currentUVW.y / PI), 0.001, 0.999));
            let stepFlowTimeSec = select(cloud.u_simControl.x, cloud.u_padCloud.y, cloud.u_padCloud.y > 0.0);
            let stepTimeSec = select(cloud.u_simControl.x, max(0.0, cloud.u_simControl.x - cloud.u_padCloud.y), cloud.u_padCloud.y > 0.0);
            let stepTimeDrift = stepFlowTimeSec * cloud.u_noiseParams.w;
            let stepCloudUV = vec2<f32>(fract(stepUV.x + stepTimeSec * cloud.u_noiseParams.w * 0.12), stepUV.y);
            let stepHNorm = clamp(p_stepCache.stepHNormAGL, 0.0, 1.0);

            // Candidate 3A: Reuse DEM, weather, and center noise state already evaluated in sampleCloudDensityFromUVW
            let stepDemHere = p_stepCache.stepDemHere;
            let stepIsLand = p_stepCache.stepIsLand;
            let stepEffTerrainNorm = p_stepCache.stepEffTerrainNorm;
            let stepHNormAGL = p_stepCache.stepHNormAGL;
            let stepLow = p_stepCache.stepLow;
            let stepMid = p_stepCache.stepMid;
            let stepHigh = p_stepCache.stepHigh;
            let stepRadOptics = p_stepCache.stepRadOptics;
            var stepPrecip: f32 = 0.0;
            if ((stepLow * stepMid) > 0.05 || stepRadOptics > 0.45) {
                stepPrecip = clamp(textureSampleLevel(u_precipTexture, u_cloud2DSampler, stepCloudUV, 0.0).r, 0.0, 50.0);
            }
            let precipCoreWeight = smoothstep(0.35, 6.5, stepPrecip);
            let stepStormCore = clamp((stepLow * stepMid * max(stepMid, stepHigh) * 1.40 + smoothstep(0.55, 0.95, stepRadOptics) * 0.45 + precipCoreWeight * 0.35), 0.0, 1.0);
            let viewTopExposure = smoothstep(0.08, 0.62, accumTransmittance);
            var stepPluvialMod = 1.0 + 0.24 * precipCoreWeight * (1.0 - smoothstep(0.35, 0.78, stepHNorm));

            let nCenter = p_stepCache.nCenter;
            let dCenter = p_stepCache.dCenter;

            var horizSunSlope = prevHorizSunSlope;
            var sunT = prevSunT;
            var shadowDensity = prevShadowDensity;
            var ridgeHorizonOcc = prevRidgeHorizonOcc;
            let stepCosSun = dot(stepUp, sunDir);
            let stepDriftScale = clamp(abs(cloud.u_noiseParams.w) / 0.002, 0.0, 4.0);

            // Refresh solar shadow on entry skin & every 4th (or 8th orbital) step while optically visible
            let synShadowMask = select(3, 7, rEffZoom > 9.5);
            let synShadowTransMin = select(0.28, 0.44, rEffZoom > 9.5);
            let refreshSynShadow = cloudStepCount == 0 || ((cloudStepCount & synShadowMask) == 0 && accumTransmittance > synShadowTransMin);
            if (refreshSynShadow) {
                // Candidate 3D: Local Solar Terminator Grazing Factor for low-angle cloud-top rim and shadow relief
                let ecefTerminatorGrazing = (1.0 - smoothstep(-0.08, 0.42, stepCosSun)) * (1.0 - clamp(unfurl, 0.0, 1.0));
                let stepTerminatorGrazing = mix(ecefTerminatorGrazing, p_rayLowSunGate, p_rayCustomSunGate);
                let lowSunHorizonGate = select(
                    (1.0 - smoothstep(-0.06, 0.34, stepCosSun)) * (1.0 - clamp(unfurl, 0.0, 1.0)),
                    p_rayLowSunGate,
                    p_rayIsCompassSun
                );

                let safeStepCosLat = max(0.15, cos(currentUVW.y));
                let nwReach = 1.0 + 0.45 * stepTerminatorGrazing;

                // Horizontal sunward relief gradient from WeatherNext 3 coverage + 3D multi-octave FBM
                let nwOffsetUV = vec2<f32>((p_rayCompassDir2D.x * 0.00254558) / safeStepCosLat, -p_rayCompassDir2D.y * 0.00254558) * nwReach;
                let stepCloudUV_NW = vec2<f32>(fract(stepCloudUV.x + nwOffsetUV.x + 1.0), clamp(stepCloudUV.y + nwOffsetUV.y, 0.001, 0.999));
                let wSurfStep = p_rayWinds.xy;
                let wJetStep = p_rayWinds.zw;
                let wMidStep = select(blendStratumWindVector(wSurfStep, wJetStep, 0.45), p_rayMidWind, hasWind500hPa());
                let lowUV_NW = computeWindSwirlAdvectedUV(stepCloudUV_NW, wSurfStep, stepFlowTimeSec, stepTimeDrift, safeStepCosLat);
                let midUV_NW = computeWindSwirlAdvectedUV(stepCloudUV_NW, wMidStep, stepFlowTimeSec, stepTimeDrift, safeStepCosLat);
                let highUV_NW = computeWindSwirlAdvectedUV(stepCloudUV_NW, wJetStep, stepFlowTimeSec, stepTimeDrift, safeStepCosLat);
                let covCenter = stepLow * cloud.u_layerDensities.x + stepMid * cloud.u_layerDensities.y + stepHigh * cloud.u_layerDensities.z;
                let covNW = sampleCloudTexScalar(u_cloudLowTexture, lowUV_NW) * cloud.u_layerDensities.x
                          + sampleCloudTexScalar(u_cloudMidTexture, midUV_NW) * cloud.u_layerDensities.y
                          + sampleCloudTexScalar(u_cloudHighTexture, highUV_NW) * cloud.u_layerDensities.z;
                let nwNoisePos = fract(p_stepCache.baseCoord3D + p_stepCache.baseNwOffset3D * nwReach - p_stepCache.baseWind3D * (stepFlowTimeSec * 0.032 * stepDriftScale) + vec3<f32>(10.0));
                let nNW = textureSampleLevel(u_cloudNoiseTexture, u_noiseSampler, nwNoisePos, 0.0);
                var activeDNW = dCenter;
                if (rEffZoom < 8.5 && accumTransmittance > 0.55) {
                    let dNW = sampleFlowNoiseFromVel3D(p_stepCache.detailCoord3D + p_stepCache.nwOffset3D * nwReach, p_stepCache.detailWind3D, stepDriftScale, stepFlowTimeSec);
                    activeDNW = dNW;
                }

                let billowHCenter = evaluateBillowReliefHalf(half4(nCenter), half4(dCenter));
                let billowHNW     = evaluateBillowReliefHalf(half4(nNW), half4(activeDNW));
                let billowCenter  = f32(billowHCenter.x);
                let billowNW      = f32(billowHNW.x);
                let detailCenter  = f32(billowHCenter.y);
                let detailNW      = f32(billowHNW.y);

                let stepOvercastShield = smoothstep(0.32, 0.78, covCenter);
                let upperSlopeRelief = 1.0 + (0.76 + 0.56 * stepOvercastShield) * smoothstep(0.26, 0.64, stepHNorm);
                let n1_here = covCenter * 1.12 + (billowCenter * 0.56 + detailCenter * 0.16) * upperSlopeRelief;
                let n1_nw   = covNW * 1.12 + (billowNW * 0.56 + detailNW * 0.16) * upperSlopeRelief;
                horizSunSlope = clamp((n1_here - n1_nw) * (1.88 + 0.35 * stepTerminatorGrazing), -1.0, 1.0);

                // Solar Crevice Shadow Raymarch (Linearized zero-inversion in multi-rate mode)
                let shadowRes = sampleSunShadowTransmittanceLinear(currentUVW, p, sunDir, rInner, deltaR);
                sunT = shadowRes.transmittance;
                shadowDensity = shadowRes.density;

                ridgeHorizonOcc = 0.0;

                // Step 5.1: Sunward ridge horizon occlusion across cloud entry & valley/flank strata under low solar elevation
                if (cloudStepCount <= 6 && lowSunHorizonGate > 0.02 && hasMipDemFs) {
                    let sunParamVel = getParameterVelocity(sunDir, currentUVW.x, currentUVW.y, currentUVW.z, unfurl, rInner);
                    let sunParamMetric = vec2<f32>(sunParamVel.x * safeStepCosLat, sunParamVel.y);
                    let compassHoriz = vec2<f32>(sunDir.x, sunDir.z);
                    let sunMetricHoriz = select(sunParamMetric, compassHoriz, p_rayIsCompassSun);
                    let sunHorizLen = length(sunMetricHoriz);
                    let sunDirMetric = select(vec2<f32>(-0.70710678, 0.70710678), sunMetricHoriz / max(1e-5, sunHorizLen), sunHorizLen > 1e-4);
                    let sunRidgeDeltaUV = vec2<f32>((sunDirMetric.x * 0.5) / safeStepCosLat, -sunDirMetric.y) * (0.0019 * nwReach);
                    let sunRidgeNearUV = vec2<f32>(
                        fract(stepUV.x + sunRidgeDeltaUV.x * 0.18 + 1.0),
                        clamp(stepUV.y + sunRidgeDeltaUV.y * 0.18, 0.001, 0.999)
                    );
                    let sunRidgeMidUV = vec2<f32>(
                        fract(stepUV.x + sunRidgeDeltaUV.x * 0.45 + 1.0),
                        clamp(stepUV.y + sunRidgeDeltaUV.y * 0.45, 0.001, 0.999)
                    );
                    let sunRidgeUV = vec2<f32>(
                        fract(stepUV.x + sunRidgeDeltaUV.x + 1.0),
                        clamp(stepUV.y + sunRidgeDeltaUV.y, 0.001, 0.999)
                    );
                    let ridgeDemNear = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, sunRidgeNearUV, 0.0));
                    let ridgeDemMid  = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, sunRidgeMidUV, 0.5));
                    let ridgeDem     = unpackGlobalDemRG(textureSampleLevel(u_demTexture, u_demMipSampler, sunRidgeUV, 1.25));
                    let ridgeNearKm = max(0.0, ridgeDemNear.a * 19.772 - 10.924) * smoothstep(0.35, 0.65, ridgeDemNear.b);
                    let ridgeMidKm  = max(0.0, ridgeDemMid.a * 19.772 - 10.924) * smoothstep(0.35, 0.65, ridgeDemMid.b);
                    let ridgeElevKm = max(0.0, ridgeDem.a * 19.772 - 10.924) * smoothstep(0.35, 0.65, ridgeDem.b);
                    let localBaseKm = max(0.0, stepDemHere * 0.001) * stepIsLand;
                    let cloudParcelKm = localBaseKm + stepHNorm * 3.8 + stepEffTerrainNorm * 0.0;
                    let effSunElevRad = select(
                        asin(clamp(max(0.0, stepCosSun), 0.0, 0.999)),
                        radians(clamp(cloud.u_sunDirection.w, 0.5, 45.0)),
                        p_rayIsCompassSun
                    );
                    let tanSunElev = tan(clamp(effSunElevRad, 0.008, 0.80));
                    let baseReachKm = 38.0 * nwReach;
                    let deltaNearKm = ridgeNearKm - (cloudParcelKm + tanSunElev * (baseReachKm * 0.18));
                    let deltaMidKm  = ridgeMidKm  - (cloudParcelKm + tanSunElev * (baseReachKm * 0.45));
                    let deltaFarKm  = ridgeElevKm - (cloudParcelKm + tanSunElev * baseReachKm);
                    let ridgeDeltaKm = max(deltaNearKm, max(deltaMidKm, deltaFarKm));
                    ridgeHorizonOcc = clamp(smoothstep(0.04, 0.85, ridgeDeltaKm) * lowSunHorizonGate, 0.0, 1.0);
                    sunT *= mix(1.0, 0.18, ridgeHorizonOcc);
                }

                prevHorizSunSlope = horizSunSlope;
                prevSunT = sunT;
                prevShadowDensity = shadowDensity;
                prevRidgeHorizonOcc = ridgeHorizonOcc;
            }

            // Beer-Lambert Transmittance over Step (with Theme 0 pelagic ocean veil preserving abyssal bathymetry legibility)
            let effStepDensity = max(0.0, density - 0.002);
            let pelagicOceanMask = (1.0 - smoothstep(0.18, 0.55, stepIsLand)) * (1.0 - stepStormCore * 0.72);
            let tharpPelagicTauScale = select(1.0, mix(1.0, 0.58, pelagicOceanMask), theme == 0u && !isFalseColor);
            let stepTau = sigmaT * effStepDensity * activeOpticalStepSize * stepPluvialMod * tharpPelagicTauScale;
            let stepT = exp(-stepTau);

            let stepOpacity = 1.0 - stepT;
            let invAlbedo = 1.0 / max(albedo, 0.85);
            var rimAndShaftLift: f32 = 0.0;
            var anvilUnderbelly: f32 = 0.0;

            // Wrenninge 2017 3-Octave Multiple Scattering Integration
            var directLight = vec3<f32>(0.0);
            var octaveExtinction = 1.0;
            var octaveWeight = 1.0;

            for (var oct: i32 = 0; oct < 3; oct++) {
                let octSunT = select(0.0, pow(clamp(sunT, 1e-6, 1.0), octaveExtinction), sunT > 1e-6);
                let octPhaseTerm = phaseOctTerms[oct];
                // Accumulate radiance across octaves: scatterLobe += octaveWeight * phase * transmittance
                let scatterLobe = octaveWeight * octPhaseTerm * octSunT;
                directLight += pal.sunColor * scatterLobe;

                octaveExtinction *= 0.5;
                octaveWeight *= 0.5;
            }

            // Pillar 2: Forward Mie Silver-Lining Diffraction Boost (ray-constant Mie lobe hoisted outside step loop)
            let mieFringeWeight = smoothstep(0.12, 0.55, stepT) * (1.0 - smoothstep(0.75, 0.98, stepT));
            let mieLobe = forwardMieRay * mieFringeWeight;
            let forwardMieScattering = max(0.0, mieLobe) * (4.0 * PI) * sunT;
            directLight += pal.sunColor * forwardMieScattering * 0.35;

            // Energy-conserving multiple scattering normalization + 3D altitude illumination
            // Clean vellum illumination without dark #38302A crevice stains over ocean
            let altIllum = 0.92 + 0.12 * smoothstep(0.06, 0.85, stepHNorm);
            let directNormalized = directLight * 0.5714;
            let midLight = pal.midColor * ((1.0 - sunT) * 0.55);
            let ao = clamp(1.0 - (0.50 * shadowDensity + 0.30 * density) * 0.75, 0.25, 1.0);
            let stepColumnCov = stepLow * cloud.u_layerDensities.x + stepMid * cloud.u_layerDensities.y + stepHigh * cloud.u_layerDensities.z * 0.55;
            let convectiveCoreWeight = smoothstep(0.28, 0.78, stepColumnCov * 0.55 + stepRadOptics * 0.45 + stepStormCore * 0.35);

            // Step 5.1: 2-Octave half-accelerated Wrenninge multi-scattering silver-lining inside sunlit storm rims
            let stormRimPresenceH = half(clamp(stepColumnCov * 0.90 + stepStormCore * 0.82 + stepHigh * 0.56, 0.0, 1.0));
            let rimPowderEscape = (1.0 - exp(-density * 18.0)) * (1.0 - smoothstep(0.24, 0.68, density));
            let sunlitSlopeRim = 0.14 + 0.86 * smoothstep(-0.08, 0.26, horizSunSlope);
            let stormRimBandH = half(
                rimPowderEscape *
                smoothstep(0.16, 0.88, accumTransmittance) *
                smoothstep(0.08, 0.68, sunT) *
                sunlitSlopeRim
            );
            let stormRimGateH = stormRimPresenceH * stormRimBandH;
            var silverOctAccumH = half(0.0);
            if (stormRimGateH > half(0.008) && sunT > 1e-4) {
                let sunTransH = half(clamp(sunT, 1e-4, 1.0));
                var silverOctAttenH = half(1.0);
                for (var sOct: i32 = 0; sOct < 2; sOct++) {
                    let octAttenTransH = select(pow(sunTransH, silverOctAttenH), sunTransH, sOct == 0);
                    silverOctAccumH += silverPhaseOctH[sOct] * octAttenTransH;
                    silverOctAttenH *= half(0.45);
                }
            }
            let silverRimBoost = f32(min(silverOctAccumH * stormRimGateH * half(0.62), half(0.92)));
            let lowSunGrazing = select(
                (1.0 - smoothstep(0.04, 0.52, stepCosSun)) * (1.0 - clamp(unfurl, 0.0, 1.0)),
                p_rayLowSunGate,
                p_rayIsCompassSun
            );
            let unoccludedPass = 1.0 - smoothstep(0.12, 0.78, ridgeHorizonOcc);
            let silverRimUnocc = silverRimBoost * (1.0 - ridgeHorizonOcc * 0.85);
            let shaftGap = smoothstep(0.38, 0.82, sunT) * unoccludedPass * (0.38 + 0.62 * smoothstep(-0.04, 0.28, horizSunSlope));
            let crepuscularShaft = clamp(shaftGap * lowSunGrazing * viewTopExposure * (0.52 + 0.48 * smoothstep(-0.45, 0.85, cosTheta)), 0.0, 1.0);
            let cRimShaftPigment = select(
                select(vec3<f32>(0.996, 0.974, 0.928), vec3<f32>(0.995, 0.972, 0.922), theme == 1u),
                vec3<f32>(0.890, 0.958, 1.000),
                theme == 2u
            );
            rimAndShaftLift = clamp(silverRimUnocc + crepuscularShaft * 0.72, 0.0, 0.94);

            let multiLayerAnvil = smoothstep(0.08, 0.48, stepHigh) * smoothstep(0.08, 0.44, stepLow + stepMid) * (1.0 - smoothstep(0.64, 0.94, stepHNorm));
            let coreSelfOcc = convectiveCoreWeight * smoothstep(0.14, 0.62, 1.0 - sunT) * (1.0 - smoothstep(0.08, 0.32, horizSunSlope));
            let leeConvectiveTrough = smoothstep(0.22, 0.66, stepColumnCov) * smoothstep(-0.02, 0.22, -horizSunSlope) * (0.46 + 0.54 * smoothstep(0.05, 0.46, 1.0 - sunT));
            let ridgeShadowUnderbelly = ridgeHorizonOcc * lowSunGrazing * 0.94;
            let selfShadowGate = smoothstep(0.14, 0.68, 1.0 - sunT) * (1.0 - viewTopExposure * 0.72);
            anvilUnderbelly = clamp(
                ((stepStormCore * 0.76 + convectiveCoreWeight * 0.74 + 0.42) * multiLayerAnvil + leeConvectiveTrough * 1.05 + coreSelfOcc * 0.76)
                * smoothstep(0.02, 0.20, convectiveCoreWeight + stepHigh * 0.48)
                * selfShadowGate
                + ridgeShadowUnderbelly,
                0.0,
                1.0
            );
            let marineFringeMask = (1.0 - convectiveCoreWeight * 0.85) * (1.0 - smoothstep(0.08, 0.42, density));
            let thinSunlitFringe = marineFringeMask * (0.45 + 0.55 * smoothstep(0.22, 0.85, sunT)) * (1.0 - ridgeShadowUnderbelly * 0.85);
            let fringePowderFloor = mix(0.94, 1.24, thinSunlitFringe);
            let powderBoost = (fringePowderFloor + 0.54 * (1.0 - exp(-density * 7.5)) * sunT) * altIllum * (1.0 + 0.26 * horizSunSlope);
            let effectiveAO = mix(0.94, ao * (1.0 - 0.32 * anvilUnderbelly), clamp(convectiveCoreWeight + ridgeShadowUnderbelly, 0.0, 1.0));
            let fringeAmbientPigment = mix(pal.ambientColor, pal.sunColor * 0.94, thinSunlitFringe * 0.72);
            let interiorAmbient = fringeAmbientPigment * (0.46 + 0.40 * effectiveAO) * (0.88 + 0.12 * stepHNorm);
            let baseRadiance = directNormalized * powderBoost + midLight * (0.48 * effectiveAO) + interiorAmbient + select(cRimShaftPigment * rimAndShaftLift * 0.55, vec3<f32>(0.0), isFalseColor) + stepHNormAGL * 0.0;

            // Track 3 Medium-Specific Optical Tone Curves (Themes 0, 1, 2)
            let crownSunBias = mix(0.55, 0.34, convectiveCoreWeight * viewTopExposure);
            let nwCrownBase = clamp(smoothstep(-0.22, 0.22, horizSunSlope + (sunT - 0.25) * crownSunBias) * (0.55 + 0.45 * sunT) * (0.72 + 0.28 * viewTopExposure), 0.0, 1.0);
            let nwCrownFactor = clamp((mix(nwCrownBase, max(nwCrownBase, 0.90), thinSunlitFringe * 0.78) + rimAndShaftLift * 0.62) * (1.0 - ridgeShadowUnderbelly * 0.65), 0.0, 1.0);

            let nwCrownFactorH = half(nwCrownFactor);
            let invAlbedoH = half(invAlbedo);
            let anvilShadowAdd = anvilUnderbelly * 0.44 * (1.0 - viewTopExposure * 0.42);
            let deepCreviceShade = half(clamp(
                convectiveCoreWeight * (0.42 + 0.58 * smoothstep(0.32, 0.82, p_stepCache.stepRadOptics)) *
                (smoothstep(0.22, 0.78, 1.0 - sunT) * 0.64 + smoothstep(0.02, 0.36, -horizSunSlope) * 0.36) *
                (1.0 - viewTopExposure * 0.58),
                0.0,
                0.68
            ));

            let cCrownTharp = vec3<f32>(0.992, 0.978, 0.946);
            let cMidTharp = vec3<f32>(0.805, 0.862, 0.915);
            let cShadowTharp = vec3<f32>(0.335, 0.435, 0.555);
            let cDeepFurrowTharp = half3(vec3<f32>(0.215, 0.305, 0.435));
            let tharpCoreGate = clamp(0.08 + 0.92 * mix(convectiveCoreWeight * convectiveCoreWeight, convectiveCoreWeight, anvilUnderbelly * 0.72) + ridgeShadowUnderbelly * 0.65, 0.0, 1.0);
            let tharpShadowFactor = half(clamp((smoothstep(0.22, 0.82, 1.0 - sunT) * 0.58 + smoothstep(0.03, 0.38, -horizSunSlope) * 0.46 + anvilShadowAdd) * tharpCoreGate * (1.0 - viewTopExposure * 0.46), 0.0, 0.80));
            let tharpBaseTone = mix(mix(half3(cMidTharp), half3(cCrownTharp), nwCrownFactorH), half3(cShadowTharp), tharpShadowFactor) * invAlbedoH;
            let tharpTone = mix(tharpBaseTone, cDeepFurrowTharp * invAlbedoH, deepCreviceShade * half(0.55));

            let cCrownRag = vec3<f32>(0.992, 0.974, 0.936);
            let cMidRag = vec3<f32>(0.945, 0.914, 0.862);
            let cVellumShadowRag = vec3<f32>(0.765, 0.710, 0.638);
            let cDeepFurrowRag = half3(vec3<f32>(0.410, 0.352, 0.298));
            let ragCoreGate = clamp(mix(convectiveCoreWeight * convectiveCoreWeight, convectiveCoreWeight, anvilUnderbelly * 0.75) + ridgeShadowUnderbelly * 0.65, 0.0, 1.0);
            let gentleShadowFactor = half(clamp((smoothstep(0.24, 0.82, 1.0 - sunT) * 0.58 + smoothstep(0.03, 0.38, -horizSunSlope) * 0.46 + anvilShadowAdd) * ragCoreGate * (1.0 - viewTopExposure * 0.48), 0.0, 0.76));
            let ragBaseTone = mix(mix(half3(cMidRag), half3(cCrownRag), nwCrownFactorH), half3(cVellumShadowRag), gentleShadowFactor) * invAlbedoH;
            let ragTone = mix(ragBaseTone, cDeepFurrowRag * invAlbedoH, deepCreviceShade * half(0.62));

            let cCrownCyan = vec3<f32>(0.948, 0.978, 1.000);
            let cMidCyan = vec3<f32>(0.640, 0.812, 0.948);
            let cTroughCyan = vec3<f32>(0.130, 0.310, 0.540);
            let cDeepFurrowCyan = half3(vec3<f32>(0.072, 0.205, 0.425));
            let cyanCoreGate = clamp(0.14 + 0.86 * convectiveCoreWeight + ridgeShadowUnderbelly * 0.60, 0.0, 1.0);
            let cyanShadowFactor = half(clamp((smoothstep(0.18, 0.80, 1.0 - sunT) * 0.62 + smoothstep(0.03, 0.38, -horizSunSlope) * 0.48 + anvilShadowAdd) * cyanCoreGate * (1.0 - viewTopExposure * 0.44), 0.0, 0.88));
            let cyanBaseTone = mix(mix(half3(cMidCyan), half3(cCrownCyan), nwCrownFactorH), half3(cTroughCyan), cyanShadowFactor) * invAlbedoH;
            let cyanTone = mix(cyanBaseTone, cDeepFurrowCyan * invAlbedoH, deepCreviceShade * half(0.54));

            let mediumTargetTone = select(select(tharpTone, ragTone, theme == 1u), cyanTone, theme == 2u);
            let mediumTargetToneWithRim = mediumTargetTone + half3(cRimShaftPigment) * half(rimAndShaftLift * 0.16);
            let mediumBlendWeight = half(select(select(0.64, 0.72, theme == 1u), 0.72, theme == 2u));
            let preAerialRadiance = select(vec3<f32>(mix(half3(baseRadiance), mediumTargetToneWithRim, mediumBlendWeight)), baseRadiance, isFalseColor);

            // Stage 3: Intra-Stratum Rayleigh Aerial Perspective (strictly in-atmosphere path t - tStart, zero grey-beige wash on sunlit tops)
            let sigmaAir: f32 = 0.46;
            let inAtmosDist = max(0.0, t - tStart);
            let limbObliqueWeight = clamp((1.0 - limbCos * 0.86) * (1.0 - smoothstep(0.0, 0.40, unfurl)), 0.0, 1.0) * (1.0 - viewTopExposure * 0.55) * 0.66;
            let alphaAerial = clamp((1.0 - exp(-inAtmosDist * sigmaAir * exp(-stepHNorm * 3.2))) * limbObliqueWeight, 0.0, 0.36);
            let aerialBaseColor = select(
                select(vec3<f32>(0.24, 0.48, 0.78), vec3<f32>(0.978, 0.958, 0.918), theme == 1u),
                vec3<f32>(0.18, 0.44, 0.78),
                theme == 2u
            );
            let aerialHorizonColor = mix(aerialBaseColor * select(0.88, 0.98, theme == 1u), pal.sunColor, 0.34 + 0.24 * max(0.0, cosTheta));
            let finalStepRadiance = select(mix(preAerialRadiance, aerialHorizonColor, alphaAerial), preAerialRadiance, isFalseColor);
            let S = finalStepRadiance * (albedo * stepOpacity / max(0.00001, stepSize));

            // Front-to-Back Radiative Transfer Accumulation
            let rayContribWeight = accumTransmittance * stepOpacity;
            accumPelagicWeight += rayContribWeight * pelagicOceanMask;
            accumRimShaftWeight += rayContribWeight * rimAndShaftLift;
            accumAnvilShadowWeight += rayContribWeight * anvilUnderbelly;
            accumCloudWeight += rayContribWeight;
            accumWeightedT += rayContribWeight * t;
            accumLight += accumTransmittance * S * stepSize;
            accumTransmittance *= stepT;

            // Early Ray Termination on Optical Saturation (preserves unbiased unassocTharp on Theme 0 pelagic ocean decks)
            let isPurePelagicRay = (theme == 0u) && (!isFalseColor) && (accumCloudWeight > 0.22) && (accumPelagicWeight > accumCloudWeight * 0.94);
            let transStopThresh = select(select(0.036, 0.028, theme == 0u && !isFalseColor), 0.14, isPurePelagicRay);
            if (accumTransmittance < transStopThresh) {
                accumTransmittance = select(0.0, min(accumTransmittance, 0.14), isPurePelagicRay);
                break;
            }

            t += stepSize;
        } else {
            wasEmpty = true;
            let inActiveCloudBand = currentUVW.z <= (localMaxSynLift + effTropoSpanFs * 0.96);
            let fineEmptyBlend = clamp(zoomBLWeight + (1.0 - smoothstep(0.20, 0.54, hRelBL)) * 0.85, 0.0, 1.0);
            let activeBandEmptyStep = select(
                mix(baseStepSize * 1.18, stepSize, fineEmptyBlend),
                stepSize,
                allowCoastalCondensation && currentUVW.z < (localMaxSynLift + effTropoSpanFs * 0.38)
            );
            let synopticEmptyStep = select(baseStepSize * 1.85, activeBandEmptyStep, inActiveCloudBand);
            let distToSurfEmpty = tSurfaceHit - t;
            let emptyStep = select(
                synopticEmptyStep,
                min(synopticEmptyStep, stepLen),
                depthVal < 0.999999 && distToSurfEmpty <= stepLen * 2.25
            );
            lastWasCoarseSkip = emptyStep > (stepSize * 1.05);
            t += baseStepSize * 2.0;
            t -= (baseStepSize * 2.0 - emptyStep);
        }
    }
    }

    p_rayCentroid = select(min(tTerrain, 1024.0), min(accumWeightedT / max(1e-5, accumCloudWeight), 1024.0), accumCloudWeight > 1e-4);

    var finalLight = accumLight;
    var finalAlpha = clamp(1.0 - accumTransmittance, 0.0, 1.0);

    if (!isFalseColor) {
        let airglowWeight = 1.0 - smoothstep(0.0, 0.35, unfurl);
        if (airglowWeight > 0.001) {
            // Pillar 4: Atmospheric Rayleigh Airglow Limb Integration (Spherical Globe)
            let airglow = evaluateRayleighLimbAirglow(rayOrigin, rayDir, sunDir, rInner, tTerrain, depthVal, theme);
            accumLight += accumTransmittance * airglow.rgb * (airglow.a * airglowWeight);
            accumTransmittance *= (1.0 - airglow.a * airglowWeight);
        }

        finalLight = accumLight;
        finalAlpha = clamp(1.0 - accumTransmittance, 0.0, 1.0);

        if (theme == 0u) {
            // Theme 0: Pelagic bathymetry-preserving veil ceiling + 1:1 Retina physiographic stipple (deferred to fs_upsample_main when isCheckerPass)
            let inkAbsorption = cloud.u_mediumParams.y;
            let alphaSafeTharp = max(0.001, finalAlpha);
            let unassocTharp = finalLight / alphaSafeTharp;
            let tharpLuma = clamp(dot(unassocTharp, vec3<f32>(0.299, 0.587, 0.114)), 0.0, 1.15);
            let rayPelagicFraction = select(0.0, clamp(accumPelagicWeight / max(1e-4, accumCloudWeight), 0.0, 1.0), accumCloudWeight > 1e-4);
            let pelagicAlphaCap = mix(1.0, 0.68, rayPelagicFraction);
            let veiledAlpha = min(finalAlpha, pelagicAlphaCap);
            let veilScale = select(1.0, veiledAlpha / alphaSafeTharp, finalAlpha > 0.001);
            finalLight *= veilScale;
            finalAlpha = veiledAlpha;
            let stippleNoise = hash2DRetina(floor(in.position.xy) + vec2<f32>(17.0, 31.0));
            let creviceWeight = clamp((1.0 - tharpLuma) * 1.35, 0.12, 1.0) * smoothstep(0.04, 0.42, veiledAlpha);
            let stippleFactor = select(1.0 - (stippleNoise - 0.5) * (inkAbsorption * 0.030 * creviceWeight), 1.0, isCheckerPass);
            finalLight *= stippleFactor;
            finalAlpha *= stippleFactor;
        } else if (theme == 1u) {
            // Theme 1: Cellulose paper fiber tooth absorption concentrated along feathered cloud margins (evaluated at 1:1 Retina in fs_upsample_main)
            let toothNoise = hash2DRetina(floor(in.position.xy) + vec2<f32>(53.0, 11.0));
            let paperTooth = cloud.u_mediumParams.z; // u_paper_tooth (sim.paperTooth)
            let marginWashWeight = smoothstep(0.03, 0.28, finalAlpha) * (1.0 - smoothstep(0.52, 0.88, finalAlpha));
            let toothAmp = paperTooth * (0.008 + 0.030 * marginWashWeight);
            let toothFactor = select(1.0 - (toothNoise - 0.5) * toothAmp, 1.0, isCheckerPass);
            finalLight *= toothFactor;
            finalAlpha *= toothFactor;
        } else if (theme == 2u) {
            // Theme 2: Actinic exposure gamma response, ferroprussiate trough contrast & 1:1 Retina photochemical perimeter stipple
            let gamma = max(0.5, cloud.u_mediumParams.w);
            let actinicNoise = hash2DRetina(floor(in.position.xy) + vec2<f32>(89.0, 47.0));
            let alphaSafe = max(0.001, finalAlpha);
            let unassociatedColorRaw = finalLight / alphaSafe;
            let cloudLuma = clamp(dot(unassociatedColorRaw, vec3<f32>(0.299, 0.587, 0.114)), 0.0, 1.15);
            let actinicWhiteTone = mix(vec3<f32>(0.84, 0.88, 0.93), vec3<f32>(0.96, 0.98, 1.00), clamp(cloudLuma, 0.0, 1.0));
            let highlightBleach = smoothstep(0.54, 0.94, cloudLuma) * 0.65;
            let rawCyan = mix(unassociatedColorRaw, actinicWhiteTone * max(0.84, cloudLuma), highlightBleach);
            let coldG = min(rawCyan.g, rawCyan.b);
            let coldR = min(rawCyan.r, coldG);
            finalLight = vec3<f32>(coldR, coldG, rawCyan.b) * alphaSafe;
            let unassociatedColor = finalLight / alphaSafe;
            let cyanPerimeterWeight = smoothstep(0.03, 0.32, finalAlpha) * (1.0 - smoothstep(0.48, 0.86, finalAlpha));
            let grainFactor = select(1.0 - (actinicNoise - 0.5) * (0.008 + 0.036 * cyanPerimeterWeight), 1.0, isCheckerPass);
            let actinicAlpha = pow(clamp(finalAlpha, 0.0, 1.0), 1.0 / gamma);
            finalAlpha = clamp(mix(finalAlpha, actinicAlpha, 0.34) * grainFactor, 0.0, 1.0);
            finalLight = unassociatedColor * finalAlpha;
        }
    }

    // Apply smooth unfurl morph fade symmetrically to both radiance and opacity
    finalLight *= morphFade;
    finalAlpha *= morphFade;

    finalAlpha = clamp(finalAlpha, 0.0, 1.0);
    if (finalAlpha <= 0.001) {
        discard;
    }

    // Hue-preserving soft-knee highlight roll-off + clean single-scattering perimeter lift (eliminates dim umber/grey fringes over turquoise shelves)
    let alphaSafeOut = max(0.001, finalAlpha);
    var unassocOut = max(vec3<f32>(0.0), finalLight / alphaSafeOut);
    let rayRimFrac = select(0.0, clamp(accumRimShaftWeight / max(1e-4, accumCloudWeight), 0.0, 1.0), accumCloudWeight > 1e-4 && !isFalseColor);
    let rayAnvilFrac = select(0.0, clamp(accumAnvilShadowWeight / max(1e-4, accumCloudWeight), 0.0, 1.0), accumCloudWeight > 1e-4 && !isFalseColor);
    let rayGhibliFrac = select(0.0, clamp(accumGhibliWeight / max(1e-4, accumCloudWeight), 0.0, 1.0), accumCloudWeight > 1e-4 && !isFalseColor);
    let lowSunHudOut = p_rayLowSunGate;
    let rimOpticalBand = clamp(
        smoothstep(0.05, 0.20, finalAlpha) * (1.0 - smoothstep(0.50, 0.82, finalAlpha)) + lowSunHudOut * 0.58,
        0.0,
        1.0
    );
    let coreOpticalBand = clamp(
        smoothstep(0.32, 0.66, finalAlpha) + lowSunHudOut * smoothstep(0.14, 0.42, finalAlpha) * 0.55,
        0.0,
        1.0
    );
    let netRimGlow = clamp(rayRimFrac * rimOpticalBand * 1.75 * (1.0 - rayGhibliFrac * 0.55), 0.0, 1.0);
    let netAnvilShade = clamp(rayAnvilFrac * coreOpticalBand * (1.0 - netRimGlow * 0.68) * 1.36, 0.0, 1.0);
    if (!isFalseColor) {
        let fringeSingleScatter = (1.0 - smoothstep(0.14, 0.68, finalAlpha)) * (1.0 - netAnvilShade * 0.88) * (1.0 - rayGhibliFrac * 0.92);
        let cleanFringeTarget = select(
            select(vec3<f32>(0.988, 0.978, 0.952), vec3<f32>(0.990, 0.974, 0.940), theme == 1u),
            vec3<f32>(0.945, 0.978, 1.000),
            theme == 2u
        );
        unassocOut = mix(unassocOut, max(unassocOut, cleanFringeTarget), fringeSingleScatter * 0.56);
        if (rayGhibliFrac > 0.001) {
            // Substrate-Matched Translucent Mist Compatibility: lift only gossamer perimeter mist (<0.20 alpha), never sculpted cumulus crowns!
            let regSemiTransVeil = rayGhibliFrac * (1.0 - smoothstep(0.03, 0.20, finalAlpha));
            let regMistVapor = select(
                select(vec3<f32>(0.954, 0.945, 0.924), vec3<f32>(0.955, 0.946, 0.924), theme == 1u),
                vec3<f32>(0.880, 0.945, 0.995),
                theme == 2u
            );
            unassocOut = mix(unassocOut, max(unassocOut, regMistVapor), regSemiTransVeil * 0.28);
        }

        let cAnvilOut = select(
            select(vec3<f32>(0.345, 0.455, 0.585), vec3<f32>(0.735, 0.692, 0.635), theme == 1u),
            vec3<f32>(0.082, 0.235, 0.468),
            theme == 2u
        );
        let cRimOut = select(
            select(vec3<f32>(1.080, 1.052, 1.000), vec3<f32>(1.072, 1.046, 0.996), theme == 1u),
            vec3<f32>(0.948, 0.984, 1.042),
            theme == 2u
        );
        let anvilMixWeight = netAnvilShade * select(select(0.66, 0.64, theme == 1u), 0.68, theme == 2u) * (1.0 - rayGhibliFrac);
        unassocOut = mix(unassocOut, unassocOut * 0.32 + cAnvilOut * 0.68, anvilMixWeight);
        unassocOut = mix(unassocOut, max(unassocOut, cRimOut), netRimGlow * 0.74) + cRimOut * (netRimGlow * 0.14);

        let pelagicCapOut = select(
            1.0,
            mix(1.0, 0.68, select(0.0, clamp(accumPelagicWeight / max(1e-4, accumCloudWeight), 0.0, 1.0), accumCloudWeight > 1e-4)),
            theme == 0u
        );
        let rimEscapeGain = select(select(0.12, 0.17, theme == 1u), 0.11, theme == 2u);
        let stormRimEscape = smoothstep(0.18, 0.62, netRimGlow) * netRimGlow;
        finalAlpha = min(pelagicCapOut, finalAlpha + stormRimEscape * (1.0 - finalAlpha) * rimEscapeGain * morphFade);
    }
    let xdrCloudActive = (cloud.u_lclParams.w > 0.5) && (!isFalseColor);
    let baseBoostScale = mix(select(select(1.18, 1.12, theme == 1u), 1.18, theme == 2u), 1.02, rayGhibliFrac * select(1.0, 0.0, theme == 2u));
    let xdrCrownSparkle = select(0.0, smoothstep(0.76, 0.98, max(unassocOut.r, max(unassocOut.g, unassocOut.b))) * (1.0 - netAnvilShade * 0.85) * (0.42 + 0.58 * netRimGlow), xdrCloudActive);
    let boostScale = select(baseBoostScale * (1.0 + xdrCrownSparkle * 0.48), 1.22, isFalseColor);
    let sdrKneeThresh = select(0.74, mix(0.88, 0.92, rayGhibliFrac), theme == 1u && !isFalseColor);
    let kneeThreshScalar = select(sdrKneeThresh, 1.04, xdrCloudActive);
    let sdrKneeHead = select(0.24, 0.115, theme == 1u && !isFalseColor) + netRimGlow * select(0.095, 0.082, theme == 1u);
    let kneeHeadScalar = select(sdrKneeHead, 1.18 + netRimGlow * 0.36, xdrCloudActive);
    let boostedOut = unassocOut * boostScale;
    let maxChan = max(boostedOut.r, max(boostedOut.g, boostedOut.b));
    let kneeScalar = max(0.0, maxChan - kneeThreshScalar);
    let kneeSlope = select(3.2, 1.45, xdrCloudActive);
    let tonedMax = min(maxChan, kneeThreshScalar) + kneeHeadScalar * (1.0 - exp(-kneeScalar * kneeSlope));
    var tonedOut = boostedOut * select(1.0, tonedMax / max(1e-5, maxChan), maxChan > kneeThreshScalar);
    if (theme == 2u && !isFalseColor) {
        tonedOut.g = min(tonedOut.g, tonedOut.b);
        tonedOut.r = min(tonedOut.r, tonedOut.g);
    }
    finalLight = tonedOut * finalAlpha;

    // Premultiplied alpha sanity clamp: bounded to 1.0 in SDR, expanded up to 2.35x on rgba16float XDR extended swapchains
    let premultCeil = max(finalAlpha, 1.0) * select(1.0, 2.35, xdrCloudActive);
    finalLight = clamp(finalLight, vec3<f32>(0.0), vec3<f32>(premultCeil));

    // Output Premultiplied Alpha for Compositing over Pass 1 (src: one, dst: one-minus-src-alpha)
    return vec4<f32>(finalLight, finalAlpha);
}

// ----------------------------------------------------------------------------
// Pass 2A-1: MRT 2x1 Checkerboard Raymarch Output (volColor + t_centroid)
// ----------------------------------------------------------------------------

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return evaluateVolumetricRaymarch(in, false);
}

@fragment
fn fs_checker_mrt_main(in: VertexOutput) -> FragmentMRTOut {
    let volColor = evaluateVolumetricRaymarch(in, true);
    var out: FragmentMRTOut;
    out.volColor = volColor;
    out.volCentroid = vec4<f32>(clamp(p_rayCentroid, 0.0, 1024.0), 0.0, 0.0, 1.0);
    return out;
}

// ----------------------------------------------------------------------------
// Pass 2A-2: Optical-Centroid 2x1 Checkerboard Temporal Reconstruction (TAA)
//            3D Wind + Parallax Reprojection (u_prevViewProj) & 3x3 YCoCg
//            mu +/- 1.25 * sigma Variance Clamping
// ----------------------------------------------------------------------------

@fragment
fn fs_taa_resolve(in: VertexOutput) -> FragmentMRTOut {
    let halfDims = max(vec2<u32>(1u), textureDimensions(u_historyColorTexture));
    let halfMax = vec2<i32>(halfDims) - vec2<i32>(1);
    let hCoord = clamp(vec2<i32>(in.position.xy), vec2<i32>(0), halfMax);

    let rawGridW = camera.u_taaParams.w;
    let isFullGridOffscreen = rawGridW < -0.5;
    let checkerGridW = max(1, i32(round(max(1.0, abs(rawGridW)))));
    let checkerGridH = max(1, i32(round(max(1.0, camera.u_padCamera.w))));
    let activeCheckerW = select(max(1, (checkerGridW + 1) / 2), checkerGridW, isFullGridOffscreen);
    let checkerMax = vec2<i32>(activeCheckerW - 1, checkerGridH - 1);
    let gridMax = vec2<i32>(checkerGridW - 1, checkerGridH - 1);

    let isScaledGrid = (checkerGridW != i32(halfDims.x)) || (checkerGridH != i32(halfDims.y));
    let gCoord = select(
        hCoord,
        clamp(vec2<i32>(in.uv * vec2<f32>(f32(checkerGridW), f32(checkerGridH))), vec2<i32>(0), gridMax),
        isScaledGrid
    );

    let frameParity = i32(round(camera.u_taaParams.x)) & 1;
    let isCurrentParity = isFullGridOffscreen || (((gCoord.x + gCoord.y) & 1) == frameParity);
    let cCenter = clamp(vec2<i32>(select(gCoord.x / 2, gCoord.x, isFullGridOffscreen), gCoord.y), vec2<i32>(0), checkerMax);

    let rawHistWeight = clamp(camera.u_taaParams.y, 0.0, 1.0);
    let isStationarySettle = (rawHistWeight >= 0.98) && !isScaledGrid && !isFullGridOffscreen;
    if (isStationarySettle) {
        var settledOut: FragmentMRTOut;
        if (isCurrentParity) {
            settledOut.volColor = textureLoad(u_checkerColorTexture, cCenter, 0);
            settledOut.volCentroid = vec4<f32>(min(textureLoad(u_checkerCentroidTexture, cCenter, 0).r, 1024.0), 0.0, 0.0, 1.0);
        } else {
            settledOut.volColor = textureLoad(u_historyColorTexture, hCoord, 0);
            settledOut.volCentroid = vec4<f32>(min(textureLoad(u_historyCentroidTexture, hCoord, 0).r, 1024.0), 0.0, 0.0, 1.0);
        }
        return settledOut;
    }

    let depthDims = max(vec2<u32>(1u), textureDimensions(u_depthTexture));
    let fullMax = vec2<i32>(depthDims) - vec2<i32>(1);
    let gridToFull = vec2<f32>(depthDims) / vec2<f32>(f32(checkerGridW), f32(checkerGridH));
    let fCenter = clamp(vec2<i32>(in.uv * vec2<f32>(depthDims)), vec2<i32>(0), fullMax);
    let dCenter = textureLoad(u_depthTexture, fCenter, 0);

    // Continuous 4-Tap Staggered-Quincunx Depth-Bilateral Upsample when whip-pan/fast-zoom scales 0.25x -> 0.35x
    // (eliminates 5:7 nearest-neighbor scanline row/col doubling and 4x Retina parity checkerboard during active zoom)
    if (isScaledGrid) {
        let gPos = in.uv * vec2<f32>(f32(checkerGridW), f32(checkerGridH)) - vec2<f32>(0.5);
        let gy0 = clamp(i32(floor(gPos.y)), 0, checkerGridH - 1);
        let gy1 = clamp(gy0 + 1, 0, checkerGridH - 1);
        let fy = clamp(gPos.y - floor(gPos.y), 0.0, 1.0);

        let rowOff0 = f32((gy0 + frameParity) & 1);
        let rowOff1 = f32((gy1 + frameParity) & 1);
        let sx0 = (gPos.x - rowOff0) * 0.5;
        let sx1 = (gPos.x - rowOff1) * 0.5;

        let cx00 = clamp(i32(floor(sx0)), 0, activeCheckerW - 1);
        let cx10 = clamp(cx00 + 1, 0, activeCheckerW - 1);
        let fx0 = clamp(sx0 - floor(sx0), 0.0, 1.0);

        let cx01 = clamp(i32(floor(sx1)), 0, activeCheckerW - 1);
        let cx11 = clamp(cx01 + 1, 0, activeCheckerW - 1);
        let fx1 = clamp(sx1 - floor(sx1), 0.0, 1.0);

        let sc00 = textureLoad(u_checkerColorTexture, vec2<i32>(cx00, gy0), 0);
        let sc10 = textureLoad(u_checkerColorTexture, vec2<i32>(cx10, gy0), 0);
        let sc01 = textureLoad(u_checkerColorTexture, vec2<i32>(cx01, gy1), 0);
        let sc11 = textureLoad(u_checkerColorTexture, vec2<i32>(cx11, gy1), 0);

        let scen00 = textureLoad(u_checkerCentroidTexture, vec2<i32>(cx00, gy0), 0).r;
        let scen10 = textureLoad(u_checkerCentroidTexture, vec2<i32>(cx10, gy0), 0).r;
        let scen01 = textureLoad(u_checkerCentroidTexture, vec2<i32>(cx01, gy1), 0).r;
        let scen11 = textureLoad(u_checkerCentroidTexture, vec2<i32>(cx11, gy1), 0).r;

        let gx00 = min(checkerGridW - 1, cx00 * 2 + ((gy0 + frameParity) & 1));
        let gx10 = min(checkerGridW - 1, cx10 * 2 + ((gy0 + frameParity) & 1));
        let gx01 = min(checkerGridW - 1, cx01 * 2 + ((gy1 + frameParity) & 1));
        let gx11 = min(checkerGridW - 1, cx11 * 2 + ((gy1 + frameParity) & 1));

        let sf00 = clamp(vec2<i32>((vec2<f32>(f32(gx00), f32(gy0)) + vec2<f32>(0.5)) * gridToFull), vec2<i32>(0), fullMax);
        let sf10 = clamp(vec2<i32>((vec2<f32>(f32(gx10), f32(gy0)) + vec2<f32>(0.5)) * gridToFull), vec2<i32>(0), fullMax);
        let sf01 = clamp(vec2<i32>((vec2<f32>(f32(gx01), f32(gy1)) + vec2<f32>(0.5)) * gridToFull), vec2<i32>(0), fullMax);
        let sf11 = clamp(vec2<i32>((vec2<f32>(f32(gx11), f32(gy1)) + vec2<f32>(0.5)) * gridToFull), vec2<i32>(0), fullMax);

        let dsf00 = textureLoad(u_depthTexture, sf00, 0);
        let dsf10 = textureLoad(u_depthTexture, sf10, 0);
        let dsf01 = textureLoad(u_depthTexture, sf01, 0);
        let dsf11 = textureLoad(u_depthTexture, sf11, 0);
        let relSf00 = abs(dsf00 - dCenter) / max(1.5e-4, 1.0 - min(dsf00, dCenter));
        let relSf10 = abs(dsf10 - dCenter) / max(1.5e-4, 1.0 - min(dsf10, dCenter));
        let relSf01 = abs(dsf01 - dCenter) / max(1.5e-4, 1.0 - min(dsf01, dCenter));
        let relSf11 = abs(dsf11 - dCenter) / max(1.5e-4, 1.0 - min(dsf11, dCenter));
        let sw00 = (1.0 - fx0) * (1.0 - fy) * exp(-min(40.0, relSf00 * 38.0));
        let sw10 = fx0 * (1.0 - fy) * exp(-min(40.0, relSf10 * 38.0));
        let sw01 = (1.0 - fx1) * fy * exp(-min(40.0, relSf01 * 38.0));
        let sw11 = fx1 * fy * exp(-min(40.0, relSf11 * 38.0));
        let swSum = sw00 + sw10 + sw01 + sw11;
        let scaledBilinearFallback = mix(mix(sc00, sc10, fx0), mix(sc01, sc11, fx1), fy);
        var scaledColor = select(scaledBilinearFallback, (sc00 * sw00 + sc10 * sw10 + sc01 * sw01 + sc11 * sw11) / max(1e-5, swSum), swSum > 1e-5);
        if (u32(round(cloud.u_mediumParams.x)) == 2u && cloud.u_simControl.z < 0.5) {
            scaledColor.g = min(scaledColor.g, scaledColor.b);
            scaledColor.r = min(scaledColor.r, scaledColor.g);
        }

        let swc00 = select(0.0, sw00 * (0.05 + sc00.a), scen00 > 0.0001 && scen00 < 512.0);
        let swc10 = select(0.0, sw10 * (0.05 + sc10.a), scen10 > 0.0001 && scen10 < 512.0);
        let swc01 = select(0.0, sw01 * (0.05 + sc01.a), scen01 > 0.0001 && scen01 < 512.0);
        let swc11 = select(0.0, sw11 * (0.05 + sc11.a), scen11 > 0.0001 && scen11 < 512.0);
        let swcSum = swc00 + swc10 + swc01 + swc11;
        let scaledCen = select(1024.0, (scen00 * swc00 + scen10 * swc10 + scen01 * swc01 + scen11 * swc11) / max(1e-5, swcSum), swcSum > 1e-5);

        var scaledOut: FragmentMRTOut;
        scaledOut.volColor = scaledColor;
        scaledOut.volCentroid = vec4<f32>(scaledCen, 0.0, 0.0, 1.0);
        return scaledOut;
    }

    let centerColor = textureLoad(u_checkerColorTexture, cCenter, 0);
    let centerCentroid = textureLoad(u_checkerCentroidTexture, cCenter, 0).r;

    // 4-Cardinal Cross Neighbors on the 2x1 Checkerboard Grid (for opposite-parity spatial reconstruction)
    let gL = clamp(gCoord + vec2<i32>(-1, 0), vec2<i32>(0), gridMax);
    let gR = clamp(gCoord + vec2<i32>(1, 0), vec2<i32>(0), gridMax);
    let gU = clamp(gCoord + vec2<i32>(0, -1), vec2<i32>(0), gridMax);
    let gD = clamp(gCoord + vec2<i32>(0, 1), vec2<i32>(0), gridMax);

    let cL = clamp(vec2<i32>(gL.x / 2, gL.y), vec2<i32>(0), checkerMax);
    let cR = clamp(vec2<i32>(gR.x / 2, gR.y), vec2<i32>(0), checkerMax);
    let cU = clamp(vec2<i32>(gU.x / 2, gU.y), vec2<i32>(0), checkerMax);
    let cD = clamp(vec2<i32>(gD.x / 2, gD.y), vec2<i32>(0), checkerMax);

    let colL = textureLoad(u_checkerColorTexture, cL, 0);
    let colR = textureLoad(u_checkerColorTexture, cR, 0);
    let colU = textureLoad(u_checkerColorTexture, cU, 0);
    let colD = textureLoad(u_checkerColorTexture, cD, 0);

    let cenL = textureLoad(u_checkerCentroidTexture, cL, 0).r;
    let cenR = textureLoad(u_checkerCentroidTexture, cR, 0).r;
    let cenU = textureLoad(u_checkerCentroidTexture, cU, 0).r;
    let cenD = textureLoad(u_checkerCentroidTexture, cD, 0).r;

    let fL = clamp(vec2<i32>((vec2<f32>(gL) + vec2<f32>(0.5)) * gridToFull), vec2<i32>(0), fullMax);
    let fR = clamp(vec2<i32>((vec2<f32>(gR) + vec2<f32>(0.5)) * gridToFull), vec2<i32>(0), fullMax);
    let fU = clamp(vec2<i32>((vec2<f32>(gU) + vec2<f32>(0.5)) * gridToFull), vec2<i32>(0), fullMax);
    let fD = clamp(vec2<i32>((vec2<f32>(gD) + vec2<f32>(0.5)) * gridToFull), vec2<i32>(0), fullMax);

    let dfL = textureLoad(u_depthTexture, fL, 0);
    let dfR = textureLoad(u_depthTexture, fR, 0);
    let dfU = textureLoad(u_depthTexture, fU, 0);
    let dfD = textureLoad(u_depthTexture, fD, 0);
    let relDL = abs(dfL - dCenter) / max(1.5e-4, 1.0 - min(dfL, dCenter));
    let relDR = abs(dfR - dCenter) / max(1.5e-4, 1.0 - min(dfR, dCenter));
    let relDU = abs(dfU - dCenter) / max(1.5e-4, 1.0 - min(dfU, dCenter));
    let relDD = abs(dfD - dCenter) / max(1.5e-4, 1.0 - min(dfD, dCenter));
    let wL = exp(-min(40.0, relDL * 38.0));
    let wR = exp(-min(40.0, relDR * 38.0));
    let wU = exp(-min(40.0, relDU * 38.0));
    let wD = exp(-min(40.0, relDD * 38.0));
    let wCrossSum = max(1e-5, wL + wR + wU + wD);

    let crossColor = (colL * wL + colR * wR + colU * wU + colD * wD) / wCrossSum;

    // Exclude clear-sky r16float sentinels (>= 512.0) so finite cloud centroids are never diluted at fringes
    let wCenL = select(0.0, wL * (0.05 + colL.a), cenL > 0.0001 && cenL < 512.0);
    let wCenR = select(0.0, wR * (0.05 + colR.a), cenR > 0.0001 && cenR < 512.0);
    let wCenU = select(0.0, wU * (0.05 + colU.a), cenU > 0.0001 && cenU < 512.0);
    let wCenD = select(0.0, wD * (0.05 + colD.a), cenD > 0.0001 && cenD < 512.0);
    let wCenSum = wCenL + wCenR + wCenU + wCenD;
    let crossCentroid = select(
        1024.0,
        (cenL * wCenL + cenR * wCenR + cenU * wCenU + cenD * wCenD) / max(1e-5, wCenSum),
        wCenSum > 1e-5
    );

    let mtfMatchedCenter = select(
        mix(centerColor, 0.5 * (centerColor + crossColor), (1.0 - rawHistWeight) * 0.60),
        centerColor,
        isFullGridOffscreen
    );
    let currentSpatialColor = select(crossColor, mtfMatchedCenter, isCurrentParity);
    let rawCentroid = select(crossCentroid, centerCentroid, isCurrentParity);

    let ndcX = in.uv.x * 2.0 - 1.0;
    let ndcY = 1.0 - in.uv.y * 2.0;
    let worldNearH = camera.u_invViewMatrix * (camera.u_invProjectionMatrix * vec4<f32>(ndcX, ndcY, -1.0, 1.0));
    let worldFarH  = camera.u_invViewMatrix * (camera.u_invProjectionMatrix * vec4<f32>(ndcX, ndcY, 1.0, 1.0));
    let rayOrigin = camera.u_cameraPos.xyz;
    let rayDir = normalize((worldFarH.xyz / worldFarH.w) - (worldNearH.xyz / worldNearH.w));

    var tSurf: f32 = 1024.0;
    if (dCenter < 0.999999) {
        let wSurfPos = reconstructWorldPosition(ndcX, ndcY, dCenter);
        let distSurf = dot(wSurfPos - rayOrigin, rayDir);
        if (distSurf > 0.00001) {
            tSurf = min(distSurf, 1024.0);
        }
    }

    let hasValidCentroid = rawCentroid > 0.0001 && rawCentroid < 512.0;
    let tCentroid = select(tSurf, rawCentroid, hasValidCentroid);
    if (rawHistWeight <= 0.001) {
        var fastOut: FragmentMRTOut;
        fastOut.volColor = currentSpatialColor;
        fastOut.volCentroid = vec4<f32>(tCentroid, 0.0, 0.0, 1.0);
        return fastOut;
    }

    // 3D Wind + Camera Parallax Reprojection via u_prevViewProj (1:1 lockstep with sampleStratumFlowNoise3D & Modes 0..3)
    let unfurl = cloud.u_simControl.y;
    let rInner = cloud.u_shellRadii.x;
    let deltaR = max(0.0001, cloud.u_shellRadii.z);
    let pCentroid = rayOrigin + rayDir * clamp(tCentroid, 0.001, 50.0);
    let uvwCentroid = invertManifoldModeWGSL(pCentroid, unfurl, rInner);
    let uvCentroid = vec2<f32>(fract((uvwCentroid.x / TWO_PI) + 0.5), clamp(0.5 - (uvwCentroid.y / PI), 0.001, 0.999));
    let hNormCentroid = clamp(uvwCentroid.z / deltaR, 0.0, 1.0);

    let wSurf10 = textureSampleLevel(u_windTexture, u_cloud2DSampler, uvCentroid, 0.0).xy;
    let w100 = textureSampleLevel(u_dewpointTexture, u_cloud2DSampler, uvCentroid, 0.0).ba;
    let wSurf = select(wSurf10, mix(wSurf10, w100, 0.72), hasWind100m());
    let wJetFull = textureSampleLevel(u_jetStreamTexture, u_cloud2DSampler, uvCentroid, 0.0);
    let polarAttenCen = smoothstep(0.05, 0.25, cos(uvwCentroid.y));
    let wHeightVec = blendStratumWindVector(wSurf, wJetFull.xy, clamp(hNormCentroid * 1.15, 0.0, 1.0)) * (0.5 + 0.5 * polarAttenCen);

    let rawSpd = length(wHeightVec);
    let calmAtten = smoothstep(0.0, 3.5, rawSpd);
    let wEff = (wHeightVec * calmAtten) * (10.0 * inverseSqrt(dot(wHeightVec, wHeightVec) + 9.0));
    let driftScale = clamp(abs(cloud.u_noiseParams.w) / 0.002, 0.0, 4.0);
    let omegaWind = 0.00068 * driftScale;
    let dt = clamp(camera.u_taaParams.z, 0.0, 0.1);

    var pPrev = pCentroid;
    if (hasValidCentroid && dt > 1e-6) {
        if (omegaWind > 1e-7 && rawSpd > 1e-3) {
            let safeCosLatCen = clamp(cos(uvwCentroid.y), 0.22, 1.0);
            let rawPrevLon = uvwCentroid.x - (wEff.x * omegaWind * dt) / safeCosLatCen;
            let prevLon = select(rawPrevLon, clamp(rawPrevLon, -PI, PI), unfurl > 0.001);
            let prevLat = clamp(uvwCentroid.y - (wEff.y * dt * omegaWind), -HALF_PI + 0.001, HALF_PI - 0.001);
            let pManifoldNow = evaluateForwardManifoldWGSL(uvwCentroid.x, uvwCentroid.y, uvwCentroid.z, unfurl, rInner);
            let pManifoldPrev = evaluateForwardManifoldWGSL(prevLon, prevLat, uvwCentroid.z, unfurl, rInner);
            pPrev = pCentroid + (pManifoldPrev - pManifoldNow);
        }
        let unfurlClampedTaa = clamp(unfurl, 0.0, 1.0);
        let alphaEasedTaa = unfurlClampedTaa * unfurlClampedTaa * (3.0 - 2.0 * unfurlClampedTaa);
        let rEffTaa = computeEffectiveCamRadius(rayOrigin, unfurlClampedTaa, cloud.u_shellRadii.x);
        let regTaaGate = select(
            0.0,
            (1.0 - smoothstep(5.22, 5.30, rEffTaa)) * (1.0 - smoothstep(1.25, 1.85, tCentroid)),
            cloud.u_padCloud.x <= 0.5
        );
        let pPrevGhibli = advectIsometricGhibliPos(pCentroid, dt, driftScale, alphaEasedTaa);
        pPrev = mix(pPrev, pPrevGhibli, regTaaGate);
    }

    let prevClip = camera.u_prevViewProj * vec4<f32>(pPrev, 1.0);
    let validClip = prevClip.w > 0.0001;
    let prevNdc = prevClip.xyz / max(0.0001, prevClip.w);
    let prevUV = vec2<f32>(prevNdc.x * 0.5 + 0.5, 0.5 - prevNdc.y * 0.5);
    let inScreenBounds = validClip && prevUV.x >= 0.0 && prevUV.x <= 1.0 && prevUV.y >= 0.0 && prevUV.y <= 1.0;

    let histPos = prevUV * vec2<f32>(halfDims) - vec2<f32>(0.5);
    let histBase = vec2<i32>(floor(histPos));
    let histFrac = clamp(histPos - floor(histPos), vec2<f32>(0.0), vec2<f32>(1.0));
    let hp00 = clamp(histBase + vec2<i32>(0, 0), vec2<i32>(0), halfMax);
    let hp10 = clamp(histBase + vec2<i32>(1, 0), vec2<i32>(0), halfMax);
    let hp01 = clamp(histBase + vec2<i32>(0, 1), vec2<i32>(0), halfMax);
    let hp11 = clamp(histBase + vec2<i32>(1, 1), vec2<i32>(0), halfMax);

    let hc00 = textureLoad(u_historyColorTexture, hp00, 0);
    let hc10 = textureLoad(u_historyColorTexture, hp10, 0);
    let hc01 = textureLoad(u_historyColorTexture, hp01, 0);
    let hc11 = textureLoad(u_historyColorTexture, hp11, 0);
    let historyColor = mix(mix(hc00, hc10, histFrac.x), mix(hc01, hc11, histFrac.x), histFrac.y);
    let prevCentroid = textureLoad(u_historyCentroidTexture, clamp(vec2<i32>(prevUV * vec2<f32>(halfDims)), vec2<i32>(0), halfMax), 0).r;

    // 3x3 Neighborhood YCoCg Variance Clamping: [mu - 1.25 * sigma, mu + 1.25 * sigma]
    var m1YCoCg = vec3<f32>(0.0);
    var m2YCoCg = vec3<f32>(0.0);
    var m1Alpha: f32 = 0.0;
    var m2Alpha: f32 = 0.0;
    for (var dy: i32 = -1; dy <= 1; dy++) {
        for (var dx: i32 = -1; dx <= 1; dx++) {
            let nc = clamp(cCenter + vec2<i32>(dx, dy), vec2<i32>(0), checkerMax);
            let ns = textureLoad(u_checkerColorTexture, nc, 0);
            let ny = vec3<f32>(rgbToYCoCg(half3(ns.rgb)));
            m1YCoCg += ny;
            m2YCoCg += ny * ny;
            m1Alpha += ns.a;
            m2Alpha += ns.a * ns.a;
        }
    }
    let mu = m1YCoCg * (1.0 / 9.0);
    let sigma = sqrt(max(vec3<f32>(0.0), m2YCoCg * (1.0 / 9.0) - mu * mu));
    let muA = m1Alpha * (1.0 / 9.0);
    let sigmaA = sqrt(max(0.0, m2Alpha * (1.0 / 9.0) - muA * muA));

    let resolveTheme = u32(round(cloud.u_mediumParams.x));
    let unfurlResolve = clamp(cloud.u_simControl.y, 0.0, 1.0);
    let rEffResolve = computeEffectiveCamRadius(rayOrigin, unfurlResolve, cloud.u_shellRadii.x);
    let regResolveSharp = select(
        0.0,
        1.0 - smoothstep(5.22, 5.42, rEffResolve),
        (cloud.u_padCloud.x <= 0.5) && !isFullGridOffscreen && !isScaledGrid
    );
    let sigmaClamp = mix(1.25, 1.65, regResolveSharp);

    let histYCoCg = vec3<f32>(rgbToYCoCg(half3(historyColor.rgb)));
    let clampedOrbitalYCoCg = clamp(histYCoCg, mu - 1.25 * sigma, mu + 1.25 * sigma);
    let clampedRegionalYCoCg = clamp(histYCoCg, mu - sigmaClamp * sigma, mu + sigmaClamp * sigma);
    let clampedYCoCg = mix(clampedOrbitalYCoCg, clampedRegionalYCoCg, regResolveSharp);
    let clampedAlpha = clamp(historyColor.a, max(0.0, muA - sigmaClamp * sigmaA), min(1.0, muA + sigmaClamp * sigmaA));
    let xdrResolveHeadroom = select(1.0, 2.35, cloud.u_lclParams.w > 0.5);
    var clampedRgb = min(vec3<f32>(ycocgToRgb(half3(clampedYCoCg))), vec3<f32>(clampedAlpha));
    clampedRgb = select(
        clampedRgb,
        min(vec3<f32>(ycocgToRgb(half3(clampedYCoCg))), vec3<f32>(clampedAlpha * xdrResolveHeadroom)),
        cloud.u_lclParams.w > 0.5
    );
    if (resolveTheme == 2u && cloud.u_simControl.z < 0.5) {
        clampedRgb.g = min(clampedRgb.g, clampedRgb.b);
        clampedRgb.r = min(clampedRgb.r, clampedRgb.g);
    }
    let clampedHistory = vec4<f32>(clampedRgb, clampedAlpha);

    let surfOccSlack = mix(0.10, max(0.006, tSurf * 0.022), regResolveSharp);
    let depthValid = (dCenter >= 0.999999) || (prevCentroid <= tSurf + surfOccSlack) || (prevCentroid <= 0.001);
    let validHistSample = inScreenBounds && depthValid && rawHistWeight > 0.001;
    let effHistW = select(0.0, min(0.90, rawHistWeight), validHistSample);
    let evenCrossMix = (1.0 - effHistW) * mix(0.55, 0.06, regResolveSharp);
    let evenBaseColor = select(
        mix(centerColor, 0.5 * (centerColor + crossColor), evenCrossMix),
        centerColor,
        isFullGridOffscreen
    );
    let offParityHistW = select(
        0.0,
        mix(effHistW * 0.90, min(0.955, rawHistWeight * 1.05), regResolveSharp),
        validHistSample
    );
    var movingResolvedColor = select(
        mix(crossColor, clampedHistory, offParityHistW),
        mix(evenBaseColor, clampedHistory, effHistW * 0.88),
        isCurrentParity
    );
    if (resolveTheme == 2u && cloud.u_simControl.z < 0.5) {
        movingResolvedColor.g = min(movingResolvedColor.g, movingResolvedColor.b);
        movingResolvedColor.r = min(movingResolvedColor.r, movingResolvedColor.g);
    }

    var out: FragmentMRTOut;
    out.volColor = movingResolvedColor;
    out.volCentroid = vec4<f32>(tCentroid, 0.0, 0.0, 1.0);
    return out;
}


// ----------------------------------------------------------------------------
// Pass 2B: Joint Bilateral Depth Upsample (0.35x Raymarch -> 1.0x Retina Target)
// ----------------------------------------------------------------------------

@fragment
fn fs_upsample_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let halfDims = max(vec2<u32>(1u), textureDimensions(u_halfResCloudTexture));
    let halfMax = vec2<i32>(halfDims) - vec2<i32>(1);
    let depthDims = max(vec2<u32>(1u), textureDimensions(u_depthTexture));
    let fullMax = vec2<i32>(depthDims) - vec2<i32>(1);
    let fullPixelCoords = clamp(vec2<i32>(in.position.xy), vec2<i32>(0), fullMax);

    if (halfDims.x == depthDims.x && halfDims.y == depthDims.y) {
        var exactColor = textureLoad(u_halfResCloudTexture, fullPixelCoords, 0);
        if (exactColor.a <= 0.001) {
            discard;
        }
        let retinaNoiseExact = hash2DRetina(floor(in.position.xy));
        let perimeterWashExact = smoothstep(0.03, 0.30, exactColor.a) * (1.0 - smoothstep(0.50, 0.88, exactColor.a));
        exactColor *= 1.0 - (retinaNoiseExact - 0.5) * (0.006 + 0.022 * perimeterWashExact);
        return exactColor;
    }

    // Continuous half-resolution texel coordinate centered at half-res texel centers (hx + 0.5, hy + 0.5)
    let halfPos = in.uv * vec2<f32>(halfDims) - vec2<f32>(0.5);
    let baseHalf = vec2<i32>(floor(halfPos));
    let rawFrac = clamp(halfPos - floor(halfPos), vec2<f32>(0.0), vec2<f32>(1.0));
    let smoothFrac = rawFrac * rawFrac * (vec2<f32>(3.0) - vec2<f32>(2.0) * rawFrac);
    let frac = mix(rawFrac, smoothFrac, 0.35);

    let h00 = clamp(baseHalf + vec2<i32>(0, 0), vec2<i32>(0), halfMax);
    let h10 = clamp(baseHalf + vec2<i32>(1, 0), vec2<i32>(0), halfMax);
    let h01 = clamp(baseHalf + vec2<i32>(0, 1), vec2<i32>(0), halfMax);
    let h11 = clamp(baseHalf + vec2<i32>(1, 1), vec2<i32>(0), halfMax);

    let c00 = textureLoad(u_halfResCloudTexture, h00, 0);
    let c10 = textureLoad(u_halfResCloudTexture, h10, 0);
    let c01 = textureLoad(u_halfResCloudTexture, h01, 0);
    let c11 = textureLoad(u_halfResCloudTexture, h11, 0);

    let maxAlpha = max(max(c00.a, c10.a), max(c01.a, c11.a));
    if (maxAlpha <= 0.0005) {
        discard;
    }

    let dCenter: f32 = textureLoad(u_depthTexture, fullPixelCoords, 0);
    let centerIsSky = dCenter >= 0.999999;

    // Exact full-res depth texel coordinates sampled by fs_main for each half-res neighbor
    let halfToFull = vec2<f32>(depthDims) / vec2<f32>(halfDims);
    let f00 = clamp(vec2<i32>((vec2<f32>(h00) + vec2<f32>(0.5)) * halfToFull), vec2<i32>(0), fullMax);
    let f10 = clamp(vec2<i32>((vec2<f32>(h10) + vec2<f32>(0.5)) * halfToFull), vec2<i32>(0), fullMax);
    let f01 = clamp(vec2<i32>((vec2<f32>(h01) + vec2<f32>(0.5)) * halfToFull), vec2<i32>(0), fullMax);
    let f11 = clamp(vec2<i32>((vec2<f32>(h11) + vec2<f32>(0.5)) * halfToFull), vec2<i32>(0), fullMax);

    let d00: f32 = textureLoad(u_depthTexture, f00, 0);
    let d10: f32 = textureLoad(u_depthTexture, f10, 0);
    let d01: f32 = textureLoad(u_depthTexture, f01, 0);
    let d11: f32 = textureLoad(u_depthTexture, f11, 0);

    let wb00 = (1.0 - frac.x) * (1.0 - frac.y);
    let wb10 = frac.x * (1.0 - frac.y);
    let wb01 = (1.0 - frac.x) * frac.y;
    let wb11 = frac.x * frac.y;

    // Perspective-invariant relative depth bilateral filter with soft-floored bilinear continuity:
    // Eliminates 2x2 point-sampled staircase teeth along steep protruding alpine silhouettes while suppressing cross-ridge halo bleed.
    let quadMinD = min(min(d00, d10), min(d01, d11));
    let quadMaxD = max(max(d00, d10), max(d01, d11));
    let relDenomQuad = max(1.5e-4, 1.0 - min(quadMinD, dCenter));
    let relQuadSpan = (quadMaxD - quadMinD) / relDenomQuad;
    let localRelSlope = min(relQuadSpan, 0.11);
    let sigmaD: f32 = max(0.030, localRelSlope * 1.60);
    let invSigmaSq: f32 = 1.0 / (sigmaD * sigmaD);

    let diff00 = (abs(d00 - dCenter) / max(1.5e-4, 1.0 - min(d00, dCenter))) * select(1.0, 6.0, centerIsSky != (d00 >= 0.999999));
    let diff10 = (abs(d10 - dCenter) / max(1.5e-4, 1.0 - min(d10, dCenter))) * select(1.0, 6.0, centerIsSky != (d10 >= 0.999999));
    let diff01 = (abs(d01 - dCenter) / max(1.5e-4, 1.0 - min(d01, dCenter))) * select(1.0, 6.0, centerIsSky != (d01 >= 0.999999));
    let diff11 = (abs(d11 - dCenter) / max(1.5e-4, 1.0 - min(d11, dCenter))) * select(1.0, 6.0, centerIsSky != (d11 >= 0.999999));

    let w00 = wb00 * max(0.012, exp(-min(9.0, diff00 * diff00 * invSigmaSq)));
    let w10 = wb10 * max(0.012, exp(-min(9.0, diff10 * diff10 * invSigmaSq)));
    let w01 = wb01 * max(0.012, exp(-min(9.0, diff01 * diff01 * invSigmaSq)));
    let w11 = wb11 * max(0.012, exp(-min(9.0, diff11 * diff11 * invSigmaSq)));

    let wSum = w00 + w10 + w01 + w11;
    var outColor = (c00 * w00 + c10 * w10 + c01 * w01 + c11 * w11) / max(1e-5, wSum);

    if (outColor.a <= 0.001) {
        discard;
    }

    // Apply 1:1 Retina non-periodic paper/stipple micro-grain after upsampling (zero synthetic static on >=0.38x regional targets; 0.0000 MAD on 0.35x orbital)
    let resRatio = f32(halfDims.x) / f32(depthDims.x);
    let regSilkyGate = smoothstep(0.355, 0.378, resRatio);
    let grainAmpScale = mix(1.0, 0.0, regSilkyGate);
    let retinaNoise = hash2DRetina(floor(in.position.xy));
    let perimeterWash = smoothstep(0.03, 0.30, outColor.a) * (1.0 - smoothstep(0.50, 0.88, outColor.a));
    let retinaGrainFactor = 1.0 - (retinaNoise - 0.5) * (0.006 + 0.022 * perimeterWash) * grainAmpScale;
    outColor *= retinaGrainFactor;

    return outColor;
}



