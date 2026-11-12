// ============================================================================
// Indicatrix Engine — GPU-Driven CDLOD Quadtree Culling & Indirect Draw WGSL
// Frustum Culling, Distance-Based LOD Range Selection, Fluid Dynamic Bounding
// 2:1 Parametric Cylindrical CDLOD Quadtree in UV Space [0, 1] x [0, 1]
// ============================================================================

struct DrawIndexedIndirect {
    indexCount: u32,
    instanceCount: atomic<u32>,
    firstIndex: u32,
    baseVertex: i32,
    firstInstance: u32,
    crustIndexCount: u32,
    crustInstanceCount: atomic<u32>,
    crustFirstIndex: u32,
    crustBaseVertex: i32,
    crustFirstInstance: u32,
    hydroIndexCount: u32,
    hydroInstanceCount: atomic<u32>,
    hydroFirstIndex: u32,
    hydroBaseVertex: i32,
    hydroFirstInstance: u32,
};

struct QuadtreeNode {
    center: vec3<f32>,     // offset 0..12
    radius: f32,           // offset 12..16
    minUV: vec2<f32>,      // offset 16..24
    sizeUV: vec2<f32>,     // offset 24..32
    lod: u32,              // offset 32..36
    morphStart: f32,       // offset 36..40
    invMorphRange: f32,    // offset 40..44
    _pad: f32,             // offset 44..48
};

struct CDLODInstance {
    minUV: vec2<f32>,      // offset 0..8
    sizeUV: vec2<f32>,     // offset 8..16
    lod: u32,              // offset 16..20
    morphStart: f32,       // offset 20..24
    invMorphRange: f32,    // offset 24..28
    lodFraction: f32,      // offset 28..32
};

struct CullingUniforms {
    cameraPos: vec4<f32>,               // offset 0..16
    frustumPlanes: array<vec4<f32>, 6>, // offset 16..112 (6 planes: ax + by + cz + d >= 0 is inside)
    fluidMaxDisplacement: f32,          // offset 112..116
    mode: u32,                          // offset 116..120
    nodeCount: u32,                     // offset 120..124
    maxInstances: u32,                  // offset 124..128
    R_squared_minus_disp: f32,          // offset 128..132
    _pad0: f32,                         // offset 132..136
    _pad1: f32,                         // offset 136..140
    _pad2: f32,                         // offset 140..144
};

@group(0) @binding(0) var<uniform> uniforms: CullingUniforms;
@group(0) @binding(1) var<storage, read> nodes: array<QuadtreeNode>;
@group(0) @binding(2) var<storage, read_write> indirectCmd: DrawIndexedIndirect;
@group(0) @binding(3) var<storage, read_write> instances: array<CDLODInstance>;

@compute @workgroup_size(1)
fn cs_reset() {
    atomicStore(&indirectCmd.instanceCount, 0u);
    // Dual surface (crust + hydrosphere) 64x64 patch index count with perimeter skirts:
    // (4096 grid quads + 256 skirt quads) * 6 indices * 2 surfaces = 52224 indices
    indirectCmd.indexCount = 52224u;
    indirectCmd.firstIndex = 0u;
    indirectCmd.baseVertex = 0;
    indirectCmd.firstInstance = 0u;

    // Strata Pass 1A (byte offset 20): Lithosphere Crust + Skirts (Surface 0, indices 0..26111)
    atomicStore(&indirectCmd.crustInstanceCount, 0u);
    indirectCmd.crustIndexCount = 26112u;
    indirectCmd.crustFirstIndex = 0u;
    indirectCmd.crustBaseVertex = 0;
    indirectCmd.crustFirstInstance = 0u;

    // Strata Pass 1B (byte offset 40): Liquid Hydrosphere Grid (Surface 1, indices 26112..50687)
    atomicStore(&indirectCmd.hydroInstanceCount, 0u);
    indirectCmd.hydroIndexCount = 24576u;
    indirectCmd.hydroFirstIndex = 26112u;
    indirectCmd.hydroBaseVertex = 0;
    indirectCmd.hydroFirstInstance = 0u;
}

const USE_SUBGROUP_COMPACTION: bool = false;

fn allocateInstanceSlotAtomic(passesCull: bool) -> u32 {
    if (!passesCull) {
        return uniforms.maxInstances;
    }
    let idx = atomicAdd(&indirectCmd.instanceCount, 1u);
    if (idx < uniforms.maxInstances) {
        atomicAdd(&indirectCmd.crustInstanceCount, 1u);
        atomicAdd(&indirectCmd.hydroInstanceCount, 1u);
    }
    return idx;
}

// __SUBGROUP_COMPACTION_START__
fn allocateInstanceSlotSubgroup(passesCull: bool) -> u32 {
    let vote = select(0u, 1u, passesCull);
    let localOffset = subgroupExclusiveAdd(vote);
    let subgroupTotal = subgroupAdd(vote);
    var subgroupBase = 0u;
    if (subgroupElect() && subgroupTotal > 0u) {
        subgroupBase = atomicAdd(&indirectCmd.instanceCount, subgroupTotal);
        if (subgroupBase < uniforms.maxInstances) {
            let clampedAdd = min(subgroupTotal, uniforms.maxInstances - subgroupBase);
            atomicAdd(&indirectCmd.crustInstanceCount, clampedAdd);
            atomicAdd(&indirectCmd.hydroInstanceCount, clampedAdd);
        }
    }
    subgroupBase = subgroupBroadcastFirst(subgroupBase);
    return subgroupBase + localOffset;
}
// __SUBGROUP_COMPACTION_END__

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let nodeIdx = global_id.x;
    let inBounds = nodeIdx < uniforms.nodeCount;
    let safeIdx = min(nodeIdx, max(1u, uniforms.nodeCount) - 1u);

    let node = nodes[safeIdx];

    // Fluid Advection (Mode 3) bounding sphere expansion:
    // Dynamically expand node bounding spheres by the maximum fluid displacement velocity
    // to prevent premature frustum clipping during severe vortex/wave displacement.
    var effectiveRadius = node.radius;
    if (uniforms.mode == 3u) {
        effectiveRadius += uniforms.fluidMaxDisplacement;
    }

    // View Frustum Culling against all 6 frustum planes
    var visible = inBounds;
    for (var i = 0u; i < 6u; i++) {
        let plane = uniforms.frustumPlanes[i];
        let dist = dot(plane.xyz, node.center) + plane.w;
        if (dist < -effectiveRadius) {
            visible = false;
            break;
        }
    }

    let camDistToOrigin = length(uniforms.cameraPos.xyz);

    // Planetary Horizon Occlusion Culling (smoothly decoupled as unfurl progresses)
    let unfurl = uniforms.cameraPos.w;
    let globeWeight = 1.0 - smoothstep(0.0, 0.05, unfurl);
    if (globeWeight > 0.0) {
        let cDotCam = dot(node.center, uniforms.cameraPos.xyz);
        let effectiveMargin = (1.0 - globeWeight) * camDistToOrigin * 10.0;
        if (cDotCam + (effectiveRadius + effectiveMargin) * camDistToOrigin < uniforms.R_squared_minus_disp) {
            visible = false;
        }
    }

    var instanceIdx = 0u;
    if (USE_SUBGROUP_COMPACTION) {
        instanceIdx = allocateInstanceSlotSubgroup(visible);
    } else {
        instanceIdx = allocateInstanceSlotAtomic(visible);
    }

    if (!visible) {
        return;
    }

    if (instanceIdx >= uniforms.maxInstances) {
        atomicStore(&indirectCmd.instanceCount, uniforms.maxInstances);
        return;
    }

    instances[instanceIdx].minUV = node.minUV;
    instances[instanceIdx].sizeUV = node.sizeUV;
    instances[instanceIdx].lod = node.lod;
    instances[instanceIdx].morphStart = node.morphStart;
    instances[instanceIdx].invMorphRange = node.invMorphRange;
    instances[instanceIdx].lodFraction = f32(node.lod);
}

