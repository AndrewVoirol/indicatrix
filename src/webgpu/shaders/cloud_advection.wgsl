// ============================================================================
// File: src/webgpu/shaders/cloud_advection.wgsl
// Target: WebGPU 3D Compute Pipeline (@compute @workgroup_size(8, 8, 4))
// Architecture: Milestone Section 1: Temporal Cloud Morphing & Semi-Lagrangian Vector Advection
//
// Mathematical Foundations:
//   - Section 1.2: 3D Continuous Advection-Diffusion Equation
//     d(rho)/dt + (u . grad) rho = D * grad^2(rho) + S_cond - S_evap
//   - Section 1.2: Second-Order Runge-Kutta (RK2) Semi-Lagrangian Back-Trajectory
//     x* = x - (dt / 2) * u(x, t)
//     x_dep = x - dt * u(x*, t + dt/2)
//   - Section 1.2: Catmull-Rom Tricubic Spline Interpolation
//     rho*(x) = I_cubic(rho^t, x_dep)
//   - Section 1.2: Orographic Condensation & Subsidence Evaporation Coupling
//     S_cond = gamma_pluvial * max(0.0, u . grad(h) - w_crit)
//     S_evap = kappa_evap * (1.0 - RH) * rho*(x)
//     rho^{t+dt}(x) = clamp(rho* + dt * (S_cond - S_evap), min_density, max_density)
//   - Section 1.4: 64-Byte AdvectionUniforms (16-Byte WGSL Alignment)
// ============================================================================

struct AdvectionUniforms {
    u_deltaTime: f32,               // offset 0  (seconds, e.g. 0.0166)
    u_advectionSpeed: f32,          // offset 4  (temporal velocity multiplier)
    u_condensationRate: f32,        // offset 8  (orographic condensation coefficient)
    u_evaporationRate: f32,         // offset 12 (dry air subsidence dissipation rate)
    u_gridDimensions: vec4<u32>,    // offset 16 (width, height, depth, mipLevels)
    u_windAltitudeShear: vec4<f32>, // offset 32 (u_shear, v_shear, coriolis_tau, pad)
    u_thresholdParams: vec4<f32>,   // offset 48 (w_crit, min_density, max_density, pad)
};

@group(0) @binding(0) var<uniform> uniforms: AdvectionUniforms;
@group(0) @binding(1) var u_prevDensityTexture: texture_3d<f32>;
@group(0) @binding(2) var u_densitySampler: sampler;
@group(0) @binding(3) var u_nextDensityTexture: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(4) var u_windTexture: texture_2d<f32>;
@group(0) @binding(5) var u_windSampler: sampler;
@group(0) @binding(6) var u_demTexture: texture_2d<f32>;
@group(0) @binding(7) var u_demSampler: sampler;
@group(0) @binding(8) var u_cloudLowTexture: texture_2d<f32>;
@group(0) @binding(9) var u_cloudMidTexture: texture_2d<f32>;
@group(0) @binding(10) var u_cloudHighTexture: texture_2d<f32>;
@group(0) @binding(11) var u_tempTexture: texture_2d<f32>;
@group(0) @binding(12) var u_dewpointTexture: texture_2d<f32>;

const PI: f32 = 3.14159265358979323846;
const TWO_PI: f32 = 6.28318530717958647692;
const EARTH_RADIUS_M: f32 = 6371000.0;
const TROPO_TOP_METERS: f32 = 12000.0;
const SIM_TIME_SCALE: f32 = 6000.0;

fn unpackDemRG(s: vec4<f32>) -> vec4<f32> {
    let bNorm = s.r;
    let aNorm = s.g;
    let elevM = aNorm * 19772.0 - 10924.0;
    return vec4<f32>(clamp(elevM / 8848.0, 0.0, 1.0), clamp(-elevM / 10924.0, 0.0, 1.0), bNorm, aNorm);
}

// Cross-Pipeline Geoid Elevation Decoding Parity
fn decodeElevation(demSample: vec4<f32>) -> f32 {
    return demSample.a * 19772.0 - 10924.0;
}

// Smooth Vertical Trapezoid Envelope for Cloud Layer Strata
fn layerHeightEnvelope(h: f32, hMin: f32, hMax: f32, feather: f32) -> f32 {
    let bottom = smoothstep(hMin, hMin + feather, h);
    let top = 1.0 - smoothstep(hMax - feather, hMax, h);
    return bottom * top;
}

var<workgroup> wg_windGrad: array<vec4<f32>, 64>;
var<workgroup> wg_macroClouds: array<vec4<f32>, 64>;
var<workgroup> wg_thermo: array<vec2<f32>, 64>;
var<private> p_cellUV: vec2<f32> = vec2<f32>(-10.0, -10.0);
var<private> p_cellWindGrad: vec4<f32> = vec4<f32>(0.0);

// Computes 3D Atmospheric Velocity Vector in normalized UVW space [1/s]
fn getAtmosphericVelocity(uvw: vec3<f32>, dims: vec3<f32>) -> vec3<f32> {
    let useCellCache = all(abs(uvw.xy - p_cellUV) <= vec2<f32>(1e-6));
    var rawWind = p_cellWindGrad.xy;
    if (!useCellCache) {
        rawWind = textureSampleLevel(u_windTexture, u_windSampler, uvw.xy, 0.0).xy;
    }

    // Altitude wind shear: wind speed increases with altitude towards jet stream levels
    let altitudeShear = vec2<f32>(
        1.0 + uniforms.u_windAltitudeShear.x * uvw.z,
        1.0 + uniforms.u_windAltitudeShear.y * uvw.z
    );
    let windMps = rawWind * altitudeShear * (uniforms.u_advectionSpeed * SIM_TIME_SCALE);

    // Spherical metric tensor arc-lengths with latitude cosLat scaling
    let latRad = (0.5 - uvw.y) * PI;
    let cosLat = max(0.02, cos(latRad));
    let circumLonMeters = TWO_PI * EARTH_RADIUS_M * cosLat;
    let meridianMeters = PI * EARTH_RADIUS_M;

    let deltaU = windMps.x / circumLonMeters;
    let deltaV = -windMps.y / meridianMeters;

    // Coriolis cyclonic turning: f = 2 * omega * sin(lat)
    let coriolisTau = uniforms.u_windAltitudeShear.z;
    let fCoriolis = 2.0 * 7.292115e-5 * sin(latRad);
    let vCoriolis = vec2<f32>(-deltaV, deltaU) * (fCoriolis * coriolisTau * 3600.0);

    // Terrain-induced orographic vertical velocity
    var gradEast = p_cellWindGrad.z;
    var gradNorth = p_cellWindGrad.w;
    if (!useCellCache) {
        let epsU = 1.0 / 360.0;
        let epsV = 1.0 / 181.0;
        let epsMetersX = circumLonMeters * epsU;
        let epsMetersY = meridianMeters * epsV;

        let hEast  = decodeElevation(unpackDemRG(textureSampleLevel(u_demTexture, u_demSampler, uvw.xy + vec2<f32>(epsU, 0.0), 0.0)));
        let hWest  = decodeElevation(unpackDemRG(textureSampleLevel(u_demTexture, u_demSampler, uvw.xy - vec2<f32>(epsU, 0.0), 0.0)));
        let hNorth = decodeElevation(unpackDemRG(textureSampleLevel(u_demTexture, u_demSampler, uvw.xy - vec2<f32>(0.0, epsV), 0.0)));
        let hSouth = decodeElevation(unpackDemRG(textureSampleLevel(u_demTexture, u_demSampler, uvw.xy + vec2<f32>(0.0, epsV), 0.0)));

        gradEast = (max(0.0, hEast) - max(0.0, hWest)) / (2.0 * max(100.0, epsMetersX));
        gradNorth = (max(0.0, hNorth) - max(0.0, hSouth)) / (2.0 * max(100.0, epsMetersY));
    }

    let uDotGradH = windMps.x * gradEast + windMps.y * gradNorth;
    // Normalized vertical speed per second (scaled across troposphere thickness)
    let deltaW = (uDotGradH / TROPO_TOP_METERS) * 0.25;

    return vec3<f32>(deltaU + vCoriolis.x, deltaV + vCoriolis.y, deltaW);
}

// Coordinate backstep with spherical longitude wrapping and edge clamping
fn backstepCoord(pos: vec3<f32>, deltaPos: vec3<f32>) -> vec3<f32> {
    var p = pos - deltaPos;
    // Longitude wraps 360 degrees
    p.x = fract(fract(p.x) + 1.0);
    // Latitude clamps away from singular poles
    p.y = clamp(p.y, 0.001, 0.999);
    // Altitude clamped to tropospheric strata [0, 1]
    p.z = clamp(p.z, 0.0, 1.0);
    return p;
}

// 8-Tap Fast GPU Catmull-Rom Tricubic Spline Interpolation (Sigg & Hadwiger 2005)
// Evaluates exact C¹-continuous cubic reconstruction with minimal numerical dissipation
fn sampleCatmullRom3D(
    tex: texture_3d<f32>,
    samp: sampler,
    uvw: vec3<f32>,
    dims: vec3<f32>
) -> f32 {
    let p = uvw * dims - vec3<f32>(0.5);
    let i = floor(p);
    let f = p - i;

    // Catmull-Rom 1D cubic spline polynomial weights
    let f2 = f * f;
    let f3 = f2 * f;

    let w0 = 0.5 * (-f3 + 2.0 * f2 - f);
    let w1 = 0.5 * (3.0 * f3 - 5.0 * f2 + vec3<f32>(2.0));
    let w2 = 0.5 * (-3.0 * f3 + 4.0 * f2 + f);
    let w3 = 0.5 * (f3 - f2);

    let g0 = w0 + w1;
    let g1 = w2 + w3;

    let safeG0 = max(vec3<f32>(1e-5), abs(g0));
    let safeG1 = max(vec3<f32>(1e-5), abs(g1));

    let h0 = w1 / safeG0;
    let h1 = w3 / safeG1;

    let tc0 = (i - vec3<f32>(0.5) + h0) / dims;
    let tc1 = (i + vec3<f32>(1.5) + h1) / dims;

    // Periodic horizontal wrapping for longitude
    let x0 = fract(tc0.x);
    let x1 = fract(tc1.x);

    let y0 = clamp(tc0.y, 0.001, 0.999);
    let y1 = clamp(tc1.y, 0.001, 0.999);

    let z0 = clamp(tc0.z, 0.0, 1.0);
    let z1 = clamp(tc1.z, 0.0, 1.0);

    var sum: f32 = 0.0;

    for (var cz = 0; cz < 2; cz++) {
        let wz = select(g0.z, g1.z, cz == 1);
        let coordZ = select(z0, z1, cz == 1);

        for (var cy = 0; cy < 2; cy++) {
            let wy = select(g0.y, g1.y, cy == 1);
            let coordY = select(y0, y1, cy == 1);

            for (var cx = 0; cx < 2; cx++) {
                let wx = select(g0.x, g1.x, cx == 1);
                let coordX = select(x0, x1, cx == 1);

                let tap = textureSampleLevel(tex, samp, vec3<f32>(coordX, coordY, coordZ), 0.0).r;
                sum += wx * wy * wz * tap;
            }
        }
    }

    return sum;
}

@compute @workgroup_size(8, 8, 4)
fn cs_main(
    @builtin(global_invocation_id) globalId: vec3<u32>,
    @builtin(local_invocation_id) localId: vec3<u32>
) {
    let gridDims = uniforms.u_gridDimensions.xyz;
    let safeDims = max(vec3<u32>(1u), gridDims);
    let fDims = vec3<f32>(safeDims);
    let clampedXY = min(globalId.xy, safeDims.xy - vec2<u32>(1u));
    let cellUV = (vec2<f32>(clampedXY) + vec2<f32>(0.5)) / fDims.xy;
    let xyIdx = localId.y * 8u + localId.x;

    // Share z-D wind, DEM gradient, macro cloud, and thermo taps across z = 0..3
    if (localId.z == 0u) {
        let colRawWind = textureSampleLevel(u_windTexture, u_windSampler, cellUV, 0.0).xy;
        let colLatRad = (0.5 - cellUV.y) * PI;
        let colCosLat = max(0.02, cos(colLatRad));
        let colCircumLonMeters = TWO_PI * EARTH_RADIUS_M * colCosLat;
        let colMeridianMeters = PI * EARTH_RADIUS_M;
        let epsU = 1.0 / 360.0;
        let epsV = 1.0 / 181.0;
        let epsMetersX = colCircumLonMeters * epsU;
        let epsMetersY = colMeridianMeters * epsV;

        let hEast  = decodeElevation(unpackDemRG(textureSampleLevel(u_demTexture, u_demSampler, cellUV + vec2<f32>(epsU, 0.0), 0.0)));
        let hWest  = decodeElevation(unpackDemRG(textureSampleLevel(u_demTexture, u_demSampler, cellUV - vec2<f32>(epsU, 0.0), 0.0)));
        let hNorth = decodeElevation(unpackDemRG(textureSampleLevel(u_demTexture, u_demSampler, cellUV - vec2<f32>(0.0, epsV), 0.0)));
        let hSouth = decodeElevation(unpackDemRG(textureSampleLevel(u_demTexture, u_demSampler, cellUV + vec2<f32>(0.0, epsV), 0.0)));

        let colGradEast = (max(0.0, hEast) - max(0.0, hWest)) / (2.0 * max(100.0, epsMetersX));
        let colGradNorth = (max(0.0, hNorth) - max(0.0, hSouth)) / (2.0 * max(100.0, epsMetersY));
        wg_windGrad[xyIdx] = vec4<f32>(colRawWind, colGradEast, colGradNorth);

        let colMacroLow  = textureSampleLevel(u_cloudLowTexture,  u_windSampler, cellUV, 0.0).r;
        let colMacroMid  = textureSampleLevel(u_cloudMidTexture,  u_windSampler, cellUV, 0.0).r;
        let colMacroHigh = textureSampleLevel(u_cloudHighTexture, u_windSampler, cellUV, 0.0).r;
        wg_macroClouds[xyIdx] = vec4<f32>(colMacroLow, colMacroMid, colMacroHigh, 0.0);

        let colT2m  = textureSampleLevel(u_tempTexture, u_windSampler, cellUV, 0.0).r;
        let colTd2m = textureSampleLevel(u_dewpointTexture, u_windSampler, cellUV, 0.0).r;
        wg_thermo[xyIdx] = vec2<f32>(colT2m, colTd2m);
    }
    workgroupBarrier();

    if (globalId.x >= gridDims.x || globalId.y >= gridDims.y || globalId.z >= gridDims.z) {
        return;
    }

    let uvw = (vec3<f32>(globalId) + vec3<f32>(0.5)) / fDims;
    let dt = max(1e-4, uniforms.u_deltaTime);
    let cachedWindGrad = wg_windGrad[xyIdx];
    let cachedClouds = wg_macroClouds[xyIdx];
    let cachedThermo = wg_thermo[xyIdx];
    p_cellUV = uvw.xy;
    p_cellWindGrad = cachedWindGrad;

    // ========================================================================
    // 1. Second-Order Runge-Kutta (RK2) Semi-Lagrangian Back-Trajectory Tracing
    // ========================================================================
    // Step 1: Midpoint departure position
    let u0 = getAtmosphericVelocity(uvw, fDims);
    let xStar = backstepCoord(uvw, 0.5 * dt * u0);

    // Step 2: Velocity evaluation at midpoint
    let uHalf = getAtmosphericVelocity(xStar, fDims);

    // Step 3: Full departure position x_dep
    let xDep = backstepCoord(uvw, dt * uHalf);

    // ========================================================================
    // 2. Catmull-Rom Tricubic Spline Interpolation: rho* = I_cubic(rho^t, x_dep)
    // ========================================================================
    let rhoStarRaw = sampleCatmullRom3D(u_prevDensityTexture, u_densitySampler, xDep, fDims);
    let minDensity = uniforms.u_thresholdParams.y;
    let maxDensity = uniforms.u_thresholdParams.z;
    let rhoStar = clamp(rhoStarRaw, minDensity, maxDensity);

    // ========================================================================
    // 3. Thermodynamic Source / Sink Coupling (Orographic Lift & Dissipation)
    // ========================================================================
    let rawWind = cachedWindGrad.xy * uniforms.u_advectionSpeed;
    let gradEast = cachedWindGrad.z;
    let gradNorth = cachedWindGrad.w;

    // Orographic updraft velocity w = u . grad(h)
    let uDotGradH = rawWind.x * gradEast + rawWind.y * gradNorth;
    let wCrit = uniforms.u_thresholdParams.x;

    // Pluvial Condensation Source: S_cond = gamma * max(0, u . grad(h) - w_crit)
    let sCond = uniforms.u_condensationRate * max(0.0, uDotGradH - wCrit);

    // Subsidence Evaporation Sink: S_evap = kappa * (1 - RH) * rho*
    let rh = clamp(1.0 - uvw.z * 0.45 - max(0.0, -uDotGradH * 2.40), 0.05, 1.0);
    let sEvap = uniforms.u_evaporationRate * (1.0 - rh) * rhoStar;

    // Integrated Density Update: rho^{t+dt} = rho* + dt * (S_cond - S_evap)
    let rhoNew = clamp(rhoStar + dt * (sCond - sEvap), minDensity, maxDensity);

    // ========================================================================
    // 4. Prognostic Macro Seeding & Boot Initialization
    // ========================================================================
    let macroLow  = cachedClouds.x;
    let macroMid  = cachedClouds.y;
    let macroHigh = cachedClouds.z;

    let baseStratified = layerHeightEnvelope(uvw.z, 0.05, 0.25, 0.04) * macroLow
                       + layerHeightEnvelope(uvw.z, 0.20, 0.55, 0.05) * macroMid
                       + layerHeightEnvelope(uvw.z, 0.55, 0.95, 0.06) * macroHigh;

    // Seed on boot or dt-normalized macro replenishment to sustain atmospheric circulation across 15Hz..120Hz cadences
    let isBootStep = (uniforms.u_thresholdParams.w > 0.5);
    let replenishAlpha = clamp(1.0 - pow(0.985, clamp(dt * 60.0, 0.25, 15.0)), 0.0, 1.0);
    let seededRho = select(mix(rhoNew, baseStratified, replenishAlpha), baseStratified, isBootStep);
    let finalRho = clamp(seededRho, minDensity, maxDensity);

    // ========================================================================
    // 5. Spatially Varying 2D Lifting Condensation Level z_LCL(lambda, phi)
    // ========================================================================
    let t2mCelsius = cachedThermo.x;
    let td2mCelsius = cachedThermo.y;
    let dewpointDepressionC = max(t2mCelsius - td2mCelsius, 0.0);
    let zLclMeters = 125.0 * max(t2mCelsius - td2mCelsius, 0.0);
    let lclAlpha = 0.52 + 0.48 * clamp(zLclMeters / 4000.0, 0.0, 1.0);

    // Write to pong storage texture:
    // Red:   Advected cloud water density rho
    // Green: Orographic condensation S_cond (scaled to utilize 8-bit unorm dynamic range)
    // Blue:  Relative humidity RH
    // Alpha: Active fluid flag (> 0.5) + affine-packed local z_LCL in [0.52, 1.0]
    textureStore(u_nextDensityTexture, vec3<i32>(globalId), vec4<f32>(finalRho, clamp(sCond * 3.5, 0.0, 1.0), rh, lclAlpha));
}
