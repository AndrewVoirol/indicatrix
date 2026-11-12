// ============================================================================
// File: src/webgpu/support.ts
// Utility: Lightweight WebGPU Hardware Feature Detection (Zero WGSL Dependency)
// ============================================================================

let lastNavigatorGPU: any = null;
let globalAdapterPromise: Promise<GPUAdapter | null> | null = null;
let globalDevicePromise: Promise<GPUDevice | null> | null = null;
let cachedShaderF16Supported = false;
let cachedSubgroupsSupported = false;
let overrideShaderF16: boolean | null = null;
let overrideSubgroups: boolean | null = null;

export function resetWebGPUCache(): void {
  globalAdapterPromise = null;
  globalDevicePromise = null;
  lastNavigatorGPU = null;
  cachedShaderF16Supported = false;
  cachedSubgroupsSupported = false;
  overrideShaderF16 = null;
  overrideSubgroups = null;
}

export function hasShaderF16(): boolean {
  return overrideShaderF16 !== null ? overrideShaderF16 : cachedShaderF16Supported;
}

export function hasSubgroups(): boolean {
  return overrideSubgroups !== null ? overrideSubgroups : cachedSubgroupsSupported;
}

export function setShaderF16OverrideForTest(enabled: boolean | null): void {
  overrideShaderF16 = enabled;
}

export function setSubgroupsOverrideForTest(enabled: boolean | null): void {
  overrideSubgroups = enabled;
}

export function buildShaderF16Preamble(f16Enabled = hasShaderF16()): string {
  if (f16Enabled) {
    return [
      'enable f16;',
      'alias half = f16;',
      'alias half2 = vec2<f16>;',
      'alias half3 = vec3<f16>;',
      'alias half4 = vec4<f16>;',
      '',
    ].join('\n');
  }
  return [
    'alias half = f32;',
    'alias half2 = vec2<f32>;',
    'alias half3 = vec3<f32>;',
    'alias half4 = vec4<f32>;',
    '',
  ].join('\n');
}

export function prepareVolumetricCloudShaderWGSL(
  rawSource: string,
  f16Enabled = hasShaderF16()
): string {
  const preamble = buildShaderF16Preamble(f16Enabled);
  const stripped = rawSource.replace(
    /\/\/ __HALF_PRECISION_ALIASES_START__[\s\S]*?\/\/ __HALF_PRECISION_ALIASES_END__\n?/,
    ''
  );
  return `${preamble}${stripped}`;
}

export function prepareCullingShaderWGSL(
  rawSource: string,
  subgroupsEnabled = hasSubgroups()
): string {
  if (subgroupsEnabled) {
    const withEnable = rawSource.startsWith('enable subgroups;')
      ? rawSource
      : `enable subgroups;\n${rawSource}`;
    return withEnable.replace(
      /const USE_SUBGROUP_COMPACTION:\s*bool\s*=\s*(true|false);/,
      'const USE_SUBGROUP_COMPACTION: bool = true;'
    );
  }
  return rawSource
    .replace(/^enable subgroups;\s*/m, '')
    .replace(
      /const USE_SUBGROUP_COMPACTION:\s*bool\s*=\s*(true|false);/,
      'const USE_SUBGROUP_COMPACTION: bool = false;'
    )
    .replace(
      /\/\/ __SUBGROUP_COMPACTION_START__[\s\S]*?\/\/ __SUBGROUP_COMPACTION_END__/,
      `fn allocateInstanceSlotSubgroup(passesCull: bool) -> u32 {\n  return allocateInstanceSlotAtomic(passesCull);\n}`
    );
}

export async function getWebGPUAdapter(): Promise<GPUAdapter | null> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
    return null;
  }
  if (navigator.gpu !== lastNavigatorGPU) {
    globalAdapterPromise = null;
    globalDevicePromise = null;
    lastNavigatorGPU = navigator.gpu;
  }
  if (!globalAdapterPromise) {
    globalAdapterPromise = navigator.gpu.requestAdapter().catch(() => null);
  }
  return globalAdapterPromise;
}

export async function getWebGPUDevice(): Promise<GPUDevice | null> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
    return null;
  }
  if (navigator.gpu !== lastNavigatorGPU) {
    globalAdapterPromise = null;
    globalDevicePromise = null;
    lastNavigatorGPU = navigator.gpu;
  }
  if (!globalDevicePromise) {
    globalDevicePromise = (async () => {
      const adapter = await getWebGPUAdapter();
      if (!adapter) return null;
      try {
        const requiredFeatures: GPUFeatureName[] = [];
        if (adapter.features && adapter.features.has('texture-compression-bc')) {
          requiredFeatures.push('texture-compression-bc');
        }
        if (adapter.features && adapter.features.has('texture-formats-tier1' as any)) {
          requiredFeatures.push('texture-formats-tier1' as any);
        }
        if (adapter.features && adapter.features.has('float32-filterable')) {
          requiredFeatures.push('float32-filterable');
        }
        if (adapter.features && adapter.features.has('timestamp-query')) {
          requiredFeatures.push('timestamp-query');
        }
        if (adapter.features && adapter.features.has('shader-f16' as GPUFeatureName)) {
          requiredFeatures.push('shader-f16' as GPUFeatureName);
          cachedShaderF16Supported = true;
        } else {
          cachedShaderF16Supported = false;
        }
        if (adapter.features && adapter.features.has('subgroups' as GPUFeatureName)) {
          requiredFeatures.push('subgroups' as GPUFeatureName);
          cachedSubgroupsSupported = true;
        } else {
          cachedSubgroupsSupported = false;
        }
        const requiredLimits: Record<string, number> = {};
        if (adapter.limits) {
          if (adapter.limits.maxBufferSize) {
            requiredLimits.maxBufferSize = adapter.limits.maxBufferSize;
          }
          if (adapter.limits.maxStorageBufferBindingSize) {
            requiredLimits.maxStorageBufferBindingSize = adapter.limits.maxStorageBufferBindingSize;
          }
          if (
            adapter.limits.maxSampledTexturesPerShaderStage &&
            adapter.limits.maxSampledTexturesPerShaderStage > 16
          ) {
            requiredLimits.maxSampledTexturesPerShaderStage = Math.min(
              adapter.limits.maxSampledTexturesPerShaderStage,
              32
            );
          }
        }

        const device = await adapter.requestDevice({
          ...(requiredFeatures.length > 0 ? { requiredFeatures } : {}),
          ...(Object.keys(requiredLimits).length > 0 ? { requiredLimits } : {}),
        });
        if (device && device.features) {
          cachedShaderF16Supported = device.features.has('shader-f16' as GPUFeatureName);
          cachedSubgroupsSupported = device.features.has('subgroups' as GPUFeatureName);
        }
        if (device && device.lost) {
          device.lost.then(() => {
            globalDevicePromise = null;
            globalAdapterPromise = null;
          }).catch(() => {});
        }
        return device;
      } catch (err) {
        console.warn('Failed to acquire WebGPU device:', err);
        return null;
      }
    })();
  }
  return globalDevicePromise;
}

export async function isWebGPUSupported(): Promise<boolean> {
  const device = await getWebGPUDevice();
  return device !== null;
}

