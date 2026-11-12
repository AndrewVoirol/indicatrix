// ============================================================================
// File: src/webgpu/shaders/wind_ribbon_render.wgsl
// Target: WebGPU Instanced Vector Ribbon Render Pipeline
// Description: Zero-copy rendering of multi-stratum wind streamlines extruded as
//              screen-space anti-aliased 3D ribbon quads from particle history buffers.
// ============================================================================

struct SimUniforms {
    u_unfurl: f32,
    u_mode: u32,
    u_theme: u32,             // 0 = Obsidian Dark Cyber, 1 = Light Monochrome
    u_time: f32,
    u_viewport: vec4<f32>,     // x: width_px, y: height_px, z: 1/width, w: 1/height
    u_cameraPos: vec4<f32>,
    u_cursorHitPos: vec4<f32>,
    u_cursorVel: vec4<f32>,
    u_cursorActive: f32,
    u_displacementScale: f32,
    u_halfWidthPx: f32,
    u_dpr: f32,
    u_nearPlane: f32,
    u_pad0: f32,
    u_pad1: f32,
    u_pad2: f32,
    u_viewMatrix: mat4x4<f32>,
    u_projectionMatrix: mat4x4<f32>,
};

struct WindParticle {
    pos: vec4<f32>,      // x: lonRad, y: latRad, z: altitudeOffset, w: normalizedAge [0..1]
    vel: vec4<f32>,      // x: uMps, y: vMps, z: wMps, w: speedMagnitude
    history0: vec4<f32>, // xyz: worldPos 0, w: alpha
    history1: vec4<f32>, // xyz: worldPos 1, w: alpha
    history2: vec4<f32>, // xyz: worldPos 2, w: alpha
    history3: vec4<f32>, // xyz: worldPos 3, w: alpha
};

@group(0) @binding(0) var<uniform> sim: SimUniforms;
@group(0) @binding(1) var<storage, read> particles: array<WindParticle>;

struct VertexInput {
    // Quad corner: x in [0, 1] along segment, y in [-1, 1] across segment
    @location(0) corner: vec2<f32>,
    @builtin(instance_index) instanceIdx: u32,
};

struct VertexOutput {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) alpha: f32,
    @location(2) speed: f32,
    @location(3) isJetStream: f32,
    @location(4) facing: f32,
    @location(5) vertVel: f32,
};

const PI: f32 = 3.141592653589793;
const RADIUS: f32 = 5.0;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;

    let particleIdx = in.instanceIdx / 3u;
    let segIdx = in.instanceIdx % 3u;

    if (particleIdx >= arrayLength(&particles)) {
        out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 0.0);
        return out;
    }

    let p = particles[particleIdx];
    let isJet = select(0.0, 1.0, p.pos.z > 0.003);

    var ptA = p.history0;
    var ptB = p.history1;
    if (segIdx == 1u) {
        ptA = p.history1;
        ptB = p.history2;
    } else if (segIdx == 2u) {
        ptA = p.history2;
        ptB = p.history3;
    }

    // Degenerate checks: if segment alpha too low, endpoints identical, or crossing flat map seam
    let segLenSq = dot(ptA.xyz - ptB.xyz, ptA.xyz - ptB.xyz);
    let maxSegLenSq = select(0.64, 2.5, sim.u_unfurl > 0.05);
    let isCrossAntimeridian = select(false, abs(ptA.x - ptB.x) > PI * RADIUS * 0.75, sim.u_unfurl > 0.05);
    if (ptA.w <= 0.01 || ptB.w <= 0.01 || segLenSq < 0.000001 || segLenSq > maxSegLenSq || isCrossAntimeridian) {
        out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 0.0);
        return out;
    }

    // Clip-space projection
    var clipA = sim.u_projectionMatrix * sim.u_viewMatrix * vec4<f32>(ptA.xyz, 1.0);
    var clipB = sim.u_projectionMatrix * sim.u_viewMatrix * vec4<f32>(ptB.xyz, 1.0);

    let nearGuard = max(sim.u_nearPlane, 0.00002);
    let wA_ok = clipA.w >= nearGuard;
    let wB_ok = clipB.w >= nearGuard;

    if (!wA_ok && !wB_ok) {
        out.clipPos = vec4<f32>(0.0, 0.0, -1.0, 0.0);
        return out;
    }

    if (!wA_ok && wB_ok) {
        let t = (nearGuard - clipA.w) / (clipB.w - clipA.w);
        clipA = mix(clipA, clipB, t);
        clipA.w = nearGuard;
    } else if (wA_ok && !wB_ok) {
        let t = (nearGuard - clipA.w) / (clipB.w - clipA.w);
        clipB = mix(clipA, clipB, t);
        clipB.w = nearGuard;
    }

    // Screen-space NDC coordinates
    let ndcA = clipA.xy / clipA.w;
    let ndcB = clipB.xy / clipB.w;

    let vpSize = sim.u_viewport.xy;
    let screenA = (ndcA * 0.5 + 0.5) * vpSize;
    let screenB = (ndcB * 0.5 + 0.5) * vpSize;

    let dirPx = screenB - screenA;
    let lenPx = max(length(dirPx), 0.001);
    let unitDir = dirPx / lenPx;
    let unitNorm = vec2<f32>(-unitDir.y, unitDir.x);

    // Ribbon width in CSS pixels
    // Camera-distance adaptive stroke scaling
    // 0.42x scaling at planetary orbit (camDist >= 25.0) down to ultra-fine hairlines;
    // 1.00x scaling zoomed in (camDist <= 8.0) for tactile drafting weight.
    let camDist = length(sim.u_cameraPos.xyz);
    let orbitT = clamp((camDist - 8.0) / (25.0 - 8.0), 0.0, 1.0);
    let zoomScale = mix(1.0, 0.42, orbitT);

    // Longitudinal head-to-tail aerodynamic taper (segIdx 0..2, u 0..1)
    let ribbonT = (f32(segIdx) + in.corner.x) / 3.0;
    let headTip = smoothstep(0.0, 0.08, ribbonT);
    let tailTaper = pow(1.0 - ribbonT, 0.85);
    let taperWidth = mix(0.22, 1.08, tailTaper) * mix(0.58, 1.0, headTip);

    // Surface winds: refined ~1.35px half-width (total ~2.7px stroke) for crisp filament visibility
    // Jet stream: drafted ~1.85px half-width (total ~3.7px stroke) for upper-air circulation traces
    let baseHalfWidth = select(1.35, 1.85, isJet > 0.5) * sim.u_dpr;
    let widthAtten = select(
        clamp(p.vel.w / 14.0, 0.80, 1.35),
        clamp(p.vel.w / 40.0, 0.75, 1.60),
        isJet > 0.5
    );
    let halfW = baseHalfWidth * widthAtten * zoomScale * taperWidth;

    let u = in.corner.x; // [0..1] along segment
    let v = in.corner.y; // [-1..1] across segment

    let centerPx = mix(screenA, screenB, u);
    let offsetPx = unitNorm * (v * halfW);
    let finalPx = centerPx + offsetPx;

    // Convert back to NDC and clip coordinates
    let finalNdc = (finalPx / vpSize) * 2.0 - 1.0;
    let finalW = mix(clipA.w, clipB.w, u);

    out.clipPos = vec4<f32>(finalNdc * finalW, mix(clipA.z, clipB.z, u), finalW);
    out.uv = vec2<f32>(ribbonT, in.corner.y);
    // Longitudinal power-law alpha decay for clean directional quill tapering
    let trailDecay = pow(1.0 - ribbonT, 1.30);
    out.alpha = mix(ptA.w, ptB.w, u) * mix(0.15, 1.0, trailDecay);
    out.speed = p.vel.w;
    out.isJetStream = isJet;

    // Normal facing calculation across both spherical and flat manifold states
    let midWorld = mix(ptA.xyz, ptB.xyz, u);
    let sphereNorm = midWorld / max(length(midWorld), 1e-5);
    let flatNorm = vec3<f32>(0.0, 0.0, 1.0);
    let surfNorm = normalize(mix(sphereNorm, flatNorm, clamp(sim.u_unfurl * 2.0, 0.0, 1.0)));
    let viewVecMid = sim.u_cameraPos.xyz - midWorld;
    let viewDir = viewVecMid / max(length(viewVecMid), 1e-5);
    let facingMid = dot(surfNorm, viewDir);
    let normA = ptA.xyz / max(length(ptA.xyz), 1e-5);
    let normB = ptB.xyz / max(length(ptB.xyz), 1e-5);
    let viewVecA = sim.u_cameraPos.xyz - ptA.xyz;
    let viewVecB = sim.u_cameraPos.xyz - ptB.xyz;
    let facingA = dot(normA, viewVecA / max(length(viewVecA), 1e-5));
    let facingB = dot(normB, viewVecB / max(length(viewVecB), 1e-5));
    out.facing = select(facingMid, min(facingMid, min(facingA, facingB)), sim.u_unfurl < 0.20);
    out.vertVel = p.vel.z;

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // All finite difference derivatives must be evaluated at the top of fs_main
    // in unconditional uniform control flow, strictly before any dynamic branching or discard.
    let dUv = fwidth(in.uv);
    let dVertVel = fwidth(in.vertVel);

    // In spherical globe mode, discard backfacing streamlines cleanly at the horizon
    if (sim.u_unfurl < 0.20 && in.facing < 0.02) {
        discard;
    }

    // Orographic condensation wash on windward slopes (w > 0)
    let condensation = smoothstep(0.2, 3.5, in.vertVel);

    // Lateral anti-aliasing via parabolic box-filter softened by condensation vapor
    let lateralDist = abs(in.uv.y);
    let featherMin = mix(0.18, 0.06, condensation * 0.5);
    let edgeFeather = 1.0 - smoothstep(featherMin, 0.95 + dUv.y * 0.02, lateralDist);

    // Capillary absorption feathering into cellulose paper tooth (Theme 1 Cream Rag)
    let toothNoise = sin(in.uv.x * 180.0 + in.uv.y * 60.0) * cos(in.uv.x * 90.0 - in.uv.y * 120.0);
    let capillaryFeather = select(edgeFeather, edgeFeather * (1.0 - 0.15 * abs(toothNoise) * smoothstep(0.35, 0.95, lateralDist)), sim.u_theme == 1u);

    var color: vec3<f32>;
    var alphaBase: f32;

    if (in.isJetStream > 0.5) {
        // High-Altitude Jet Stream (250 hPa, real speeds up to 92 m/s / 180 kt):
        // Disciplined Thermal Metal Palette (Zero magenta / candy pink)
        let normSpeed = clamp(in.speed / 80.0, 0.0, 1.0);
        let jetSpeedAtten = smoothstep(0.12, 0.65, normSpeed);

        if (sim.u_theme == 0u) {
            // Theme 0: Dark Obsidian / Marie Tharp theme:
            // Subdued slate-blue (< 35 m/s) -> Luminescent platinum-cyan (~55 m/s) -> Solar amber core (> 70 m/s)
            let coolJet = vec3<f32>(0.22, 0.50, 0.70); // Deep aerospace slate-blue
            let midJet  = vec3<f32>(0.55, 0.82, 0.92); // Luminescent platinum
            let coreJet = vec3<f32>(1.00, 0.82, 0.38); // Warm solar gold
            let peakJet = vec3<f32>(1.00, 0.94, 0.82); // Core highlight

            if (normSpeed < 0.45) {
                color = mix(coolJet, midJet, normSpeed / 0.45);
            } else if (normSpeed < 0.82) {
                color = mix(midJet, coreJet, (normSpeed - 0.45) / 0.37);
            } else {
                color = mix(coreJet, peakJet, (normSpeed - 0.82) / 0.18);
            }
            // Physiographic ink glaze: amber-gold core along spine with platinum-cyan wash at ribbon margins
            let coreSpine = 1.0 - smoothstep(0.0, 0.42, lateralDist);
            color = mix(color, coreJet, coreSpine * smoothstep(0.40, 0.85, normSpeed) * 0.35);
            alphaBase = mix(0.20, 0.78, jetSpeedAtten);
        } else if (sim.u_theme == 1u) {
            // Theme 1: Cream Rag (Swiss Relief): Warm Pewter-Bistre to Archival Iron-Gall Sepia (#332E29)
            let calmJet = vec3<f32>(0.46, 0.42, 0.38);
            let fastJet = vec3<f32>(0.29, 0.25, 0.22);
            let coreJet = vec3<f32>(0.20, 0.18, 0.16);
            color = mix(calmJet, fastJet, smoothstep(0.2, 0.7, normSpeed));
            color = mix(color, coreJet, smoothstep(0.7, 1.0, normSpeed));
            alphaBase = mix(0.14, 0.54, jetSpeedAtten);
        } else if (sim.u_theme == 2u) {
            // Theme 2: Prussian Cyanotype (Blueprint architectural drafting traces)
            // Chalk cerulean (#7AA2C8) to crisp chalk ruling pen white (#E8EDF2)
            // Zero amber contamination - cold photochemical linework
            let ceruleanJet = vec3<f32>(0.478, 0.635, 0.784); // #7AA2C8
            let midChalk    = vec3<f32>(0.72, 0.84, 0.94);
            let coreChalk   = vec3<f32>(0.94, 0.97, 1.00);    // Crisp chalk white
            color = mix(ceruleanJet, midChalk, smoothstep(0.2, 0.65, normSpeed));
            color = mix(color, coreChalk, smoothstep(0.65, 0.98, normSpeed));
            alphaBase = mix(0.15, 0.55, jetSpeedAtten);
        } else {
            // Fallback: Theme 1
            let calmJet = vec3<f32>(0.46, 0.42, 0.38);
            let fastJet = vec3<f32>(0.29, 0.25, 0.22);
            let coreJet = vec3<f32>(0.20, 0.18, 0.16);
            color = mix(calmJet, fastJet, smoothstep(0.2, 0.7, normSpeed));
            color = mix(color, coreJet, smoothstep(0.7, 1.0, normSpeed));
            alphaBase = mix(0.14, 0.54, jetSpeedAtten);
        }
    } else {
        // Surface Boundary Layer (10m, speeds up to 32 m/s):
        // Fine, delicate filaments hugging terrain with low-velocity deadband suppression
        let normSpeed = clamp(in.speed / 18.0, 0.0, 1.0);

        if (sim.u_theme == 0u) {
            // Theme 0: Marie Tharp: Subtle misty slate-pearl to crisp lunar silver
            // Low saturation prevents clashing with terrain relief or ocean blues
            let calmSurf  = vec3<f32>(0.56, 0.66, 0.76); // Muted slate-pearl
            let briskSurf = vec3<f32>(0.88, 0.94, 1.00); // Luminous silver filament
            color = mix(calmSurf, briskSurf, normSpeed);
            alphaBase = max(0.38 * smoothstep(0.02, 0.18, normSpeed), mix(0.06, 0.72, smoothstep(0.06, 0.60, normSpeed)) * 1.25);
        } else if (sim.u_theme == 1u) {
            // Theme 1: Cream Rag: Deep sepia-verdigris intaglio core with warm vellum edge halo
            // Contrasts cleanly against both warm ochre landmass and dark marine bathymetry
            let calmSurf  = vec3<f32>(0.74, 0.38, 0.20); // Warm burnt sienna archival ink
            let briskSurf = vec3<f32>(0.94, 0.58, 0.26); // Luminous polished copper filament
            color = mix(calmSurf, briskSurf, normSpeed);
            // Capillary ink bleed into cellulose fibers at stroke margins
            let inkBleed = smoothstep(0.45, 0.95, lateralDist) * 0.18;
            color = mix(color, vec3<f32>(0.64, 0.44, 0.30), inkBleed);
            let intaglioCore = mix(vec3<f32>(0.21, 0.18, 0.16), vec3<f32>(0.11, 0.29, 0.36), normSpeed);
            let vellumHalo = vec3<f32>(0.98, 0.96, 0.91);
            let spineMask = 1.0 - smoothstep(0.24, 0.64, lateralDist);
            color = mix(vellumHalo, mix(intaglioCore, color, 0.22), spineMask);
            alphaBase = max(0.46 * smoothstep(0.02, 0.18, normSpeed), mix(0.08, 0.78, smoothstep(0.06, 0.60, normSpeed)) * mix(0.95, 1.38, spineMask));
        } else if (sim.u_theme == 2u) {
            // Theme 2: Prussian Cyanotype: Photochemical cerulean (calm) -> Actinic chalk white (brisk)
            // Contrasts sharply against ferroprussiate indigo oceans and cerulean terrain - zero amber contamination
            let calmSurf  = vec3<f32>(0.42, 0.82, 0.98); // Cold photochemical cerulean filament
            let briskSurf = vec3<f32>(0.92, 0.96, 1.00); // Pure actinic white ruling pen line
            color = mix(calmSurf, briskSurf, normSpeed);
            alphaBase = max(0.48 * smoothstep(0.02, 0.18, normSpeed), mix(0.10, 0.88, smoothstep(0.06, 0.60, normSpeed)) * 1.20);
        } else {
            // Fallback: Theme 1
            let calmSurf  = vec3<f32>(0.74, 0.38, 0.20);
            let briskSurf = vec3<f32>(0.94, 0.58, 0.26);
            color = mix(calmSurf, briskSurf, normSpeed);
            alphaBase = max(0.46 * smoothstep(0.02, 0.18, normSpeed), mix(0.08, 0.78, smoothstep(0.06, 0.60, normSpeed)));
        }
    }

    // Orographic condensation glaze (subtle archival moisture washes)
    if (condensation > 0.001) {
        if (sim.u_theme == 0u) {
            // Obsidian Dark Cyber / Marie Tharp: Crystalline silver mist vapor glaze
            let mistGlaze = vec3<f32>(0.92, 0.96, 1.00);
            color = mix(color, mistGlaze, condensation * 0.35);
        } else if (sim.u_theme == 1u) {
            // Cream Rag / Swiss Relief: Washed watercolor vapor glaze
            let vaporGlaze = vec3<f32>(0.68, 0.74, 0.80);
            color = mix(color, vaporGlaze, condensation * 0.30);
        } else if (sim.u_theme == 2u) {
            // Prussian Cyanotype: Actinic chalk mist glaze
            let actinicGlaze = vec3<f32>(0.88, 0.93, 0.98);
            color = mix(color, actinicGlaze, condensation * 0.35);
        } else {
            // Fallback: Theme 1
            let vaporGlaze = vec3<f32>(0.68, 0.74, 0.80);
            color = mix(color, vaporGlaze, condensation * 0.30);
        }
        alphaBase = alphaBase + condensation * 0.18;
    }

    // Tail-to-head traveling ink-density wave: in.uv.x runs 1.0 (tail) -> 0.0 (head)
    let waveRate = select(2.2, 3.4, in.isJetStream > 0.5);
    let flowWavePhase = in.uv.x * 2.0 + sim.u_time * waveRate;
    let flowPulse = 0.72 + 0.28 * (0.5 + 0.5 * cos(flowWavePhase * 6.2831853));
    let headCrest = 1.0 + 0.24 * (1.0 - smoothstep(0.0, 0.30, in.uv.x));

    let sphereFactor = 1.0 - smoothstep(0.0, 0.35, sim.u_unfurl);
    let limbFalloff = mix(1.0, smoothstep(0.08, 0.26, in.facing), sphereFactor);
    let finalAlpha = clamp(in.alpha * capillaryFeather * alphaBase * flowPulse * headCrest * limbFalloff, 0.0, 1.0) + dVertVel * 0.000001;
    return vec4<f32>(color, finalAlpha);
}
