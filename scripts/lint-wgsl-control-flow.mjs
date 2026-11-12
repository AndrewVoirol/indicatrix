// ============================================================================
// File: scripts/lint-wgsl-control-flow.mjs
// Purpose: Static analysis of WGSL shaders to enforce:
//          1. Uniform Control Flow
//          2. WGSL Uniform/Storage Struct Alignment & vec3<f32> Traps
//          3. Hardcoded texture resolution constants.
// ============================================================================

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

function roundUp(align, value) {
  return Math.ceil(value / align) * align;
}

function evalIntExpr(rawExpr, consts) {
  if (!rawExpr) return null;
  const s = rawExpr.trim();
  if (!s) return null;
  // Reject floating-point literals (decimal points)
  if (/\d\.\d|\.\d|\d\./.test(s)) return null;

  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (s.startsWith('<<', i) || s.startsWith('>>', i)) {
      tokens.push(s.slice(i, i + 2));
      i += 2;
      continue;
    }
    if ('+-*/%()'.includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    const hexMatch = s.slice(i).match(/^0[xX][0-9a-fA-F]+[ui]?/);
    if (hexMatch) {
      tokens.push( parseInt(hexMatch[0].replace(/[ui]$/i, ''), 16) );
      i += hexMatch[0].length;
      continue;
    }
    const decMatch = s.slice(i).match(/^\d+[ui]?/);
    if (decMatch) {
      tokens.push( parseInt(decMatch[0].replace(/[ui]$/i, ''), 10) );
      i += decMatch[0].length;
      continue;
    }
    const idMatch = s.slice(i).match(/^[A-Za-z_]\w*/);
    if (idMatch) {
      const val = consts.get(idMatch[0]);
      if (typeof val !== 'number' || !Number.isFinite(val)) return null;
      tokens.push(val);
      i += idMatch[0].length;
      continue;
    }
    return null;
  }

  let pos = 0;
  function parseShift() {
    let left = parseAdd();
    if (left === null) return null;
    while (tokens[pos] === '<<' || tokens[pos] === '>>') {
      const op = tokens[pos++];
      const right = parseAdd();
      if (right === null) return null;
      left = op === '<<' ? (left << right) : (left >> right);
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    if (left === null) return null;
    while (tokens[pos] === '+' || tokens[pos] === '-') {
      const op = tokens[pos++];
      const right = parseMul();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    if (left === null) return null;
    while (tokens[pos] === '*' || tokens[pos] === '/' || tokens[pos] === '%') {
      const op = tokens[pos++];
      const right = parseUnary();
      if (right === null) return null;
      if ((op === '/' || op === '%') && right === 0) return null;
      left = op === '*' ? left * right : op === '/' ? Math.trunc(left / right) : left % right;
    }
    return left;
  }
  function parseUnary() {
    if (tokens[pos] === '+') {
      pos++;
      return parseUnary();
    }
    if (tokens[pos] === '-') {
      pos++;
      const v = parseUnary();
      return v === null ? null : -v;
    }
    if (tokens[pos] === '(') {
      pos++;
      const v = parseShift();
      if (tokens[pos] !== ')') return null;
      pos++;
      return v;
    }
    const tok = tokens[pos];
    if (typeof tok === 'number') {
      pos++;
      return tok;
    }
    return null;
  }

  const result = parseShift();
  if (result === null || pos !== tokens.length || !Number.isFinite(result)) return null;
  return Math.trunc(result);
}

function parseConstInts(cleanContent) {
  const consts = new Map();
  const re = /\bconst\s+([A-Za-z_]\w*)\s*(?::\s*[A-Za-z0-9_<>]+\s*)?=\s*([^;]+);/g;
  let m;
  while ((m = re.exec(cleanContent)) !== null) {
    const val = evalIntExpr(m[2], consts);
    if (val !== null) {
      consts.set(m[1], val);
    }
  }
  return consts;
}

function parseTypeAliases(cleanContent) {
  const aliases = new Map();
  const re = /\balias\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g;
  let m;
  while ((m = re.exec(cleanContent)) !== null) {
    aliases.set(m[1], m[2].trim());
  }
  return aliases;
}

function resolveTypeLayout(typeStr, structLayouts, consts, aliases = new Map(), depth = 0) {
  if (depth > 8) return null;
  const t = typeStr.replace(/\s+/g, '');

  if (aliases.has(t)) {
    return resolveTypeLayout(aliases.get(t), structLayouts, consts, aliases, depth + 1);
  }

  if (t === 'f32' || t === 'u32' || t === 'i32' || t === 'bool' || /^atomic<(u32|i32)>$/.test(t)) {
    return { align: 4, size: 4, isVec3: false, isMatCx3: false, elemIsVec3: false, isArray: false, arrayStride: 0 };
  }
  if (t === 'f16' || t === 'half') {
    return { align: 2, size: 2, isVec3: false, isMatCx3: false, elemIsVec3: false, isArray: false, arrayStride: 0 };
  }
  if (/^(vec2<(f16|half)>|vec2h|half2)$/.test(t)) {
    return { align: 4, size: 4, isVec3: false, isMatCx3: false, elemIsVec3: false, isArray: false, arrayStride: 0 };
  }
  if (/^(vec3<(f16|half)>|vec3h|half3)$/.test(t)) {
    return { align: 8, size: 6, isVec3: true, isMatCx3: false, elemIsVec3: false, isArray: false, arrayStride: 0 };
  }
  if (/^(vec4<(f16|half)>|vec4h|half4)$/.test(t)) {
    return { align: 8, size: 8, isVec3: false, isMatCx3: false, elemIsVec3: false, isArray: false, arrayStride: 0 };
  }
  if (/^(vec2<(f32|u32|i32)>|vec2[fui])$/.test(t)) {
    return { align: 8, size: 8, isVec3: false, isMatCx3: false, elemIsVec3: false, isArray: false, arrayStride: 0 };
  }
  if (/^(vec3<(f32|u32|i32)>|vec3[fui])$/.test(t)) {
    return { align: 16, size: 12, isVec3: true, isMatCx3: false, elemIsVec3: false, isArray: false, arrayStride: 0 };
  }
  if (/^(vec4<(f32|u32|i32)>|vec4[fui])$/.test(t)) {
    return { align: 16, size: 16, isVec3: false, isMatCx3: false, elemIsVec3: false, isArray: false, arrayStride: 0 };
  }

  const matMatch = t.match(/^mat([234])x([234])(?:<(f32|f16)>|([fh]))?$/);
  if (matMatch) {
    const cols = Number(matMatch[1]);
    const rows = Number(matMatch[2]);
    const isHalf = matMatch[3] === 'f16' || matMatch[4] === 'h';
    const colVecType = `vec${rows}<${isHalf ? 'f16' : 'f32'}>`;
    const colLayout = resolveTypeLayout(colVecType, structLayouts, consts, aliases, depth + 1);
    const colStride = roundUp(colLayout.align, colLayout.size);
    return {
      align: colLayout.align,
      size: cols * colStride,
      isVec3: false,
      isMatCx3: rows === 3,
      elemIsVec3: false,
      isArray: false,
      arrayStride: 0,
    };
  }

  if (t.startsWith('array<') && t.endsWith('>')) {
    const inner = t.slice(6, -1);
    let angleDepth = 0;
    let splitIdx = -1;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '<') angleDepth++;
      else if (inner[i] === '>') angleDepth--;
      else if (inner[i] === ',' && angleDepth === 0) {
        splitIdx = i;
        break;
      }
    }
    const elemType = splitIdx >= 0 ? inner.slice(0, splitIdx) : inner;
    const countRaw = splitIdx >= 0 ? inner.slice(splitIdx + 1) : null;
    const elemLayout = resolveTypeLayout(elemType, structLayouts, consts, aliases, depth + 1);
    if (!elemLayout) return null;
    const stride = roundUp(elemLayout.align, elemLayout.size);
    let count = 1;
    if (countRaw !== null) {
      const evaluated = evalIntExpr(countRaw, consts);
      count = evaluated !== null && evaluated > 0 ? evaluated : 1;
    }
    return {
      align: elemLayout.align,
      size: count * stride,
      isVec3: false,
      isMatCx3: elemLayout.isMatCx3,
      elemIsVec3: elemLayout.isVec3 || elemLayout.elemIsVec3,
      isArray: true,
      arrayStride: stride,
    };
  }

  if (structLayouts.has(t)) {
    const s = structLayouts.get(t);
    return {
      align: s.align,
      size: s.size,
      isVec3: false,
      isMatCx3: false,
      elemIsVec3: false,
      isArray: false,
      arrayStride: 0,
    };
  }

  return null;
}

function lintStructAlignments(cleanContent, file) {
  const structErrors = [];
  const consts = parseConstInts(cleanContent);
  const aliases = parseTypeAliases(cleanContent);

  // Parse struct declarations in source order so nested structs resolve cleanly
  const structLayouts = new Map();
  const structRe = /\bstruct\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)\}/g;
  let sm;
  while ((sm = structRe.exec(cleanContent)) !== null) {
    const structName = sm[1];
    const body = sm[2];
    const structStartLine = cleanContent.slice(0, sm.index).split('\n').length;

    // Skip vertex/fragment stage I/O structs (@location / @builtin / @interpolate / @invariant)
    const isStageIO = /@(?:location|builtin|interpolate|invariant)\b/.test(body);
    const bodyStartIdx = sm.index + sm[0].indexOf('{') + 1;

    // Split fields at ',' or ';' outside '<...>' or '(...)'
    const rawFields = [];
    let tokenStart = 0;
    let angleDepth = 0;
    let parenDepth = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '<') angleDepth++;
      else if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);
      else if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if ((ch === ',' || ch === ';') && angleDepth === 0 && parenDepth === 0) {
        rawFields.push({ text: body.slice(tokenStart, i), offsetInBody: tokenStart });
        tokenStart = i + 1;
      }
    }
    if (tokenStart < body.length) {
      rawFields.push({ text: body.slice(tokenStart), offsetInBody: tokenStart });
    }

    const fields = [];
    let offset = 0;
    let maxAlign = 1;

    for (const rf of rawFields) {
      const trimmedField = rf.text.trim();
      if (!trimmedField) continue;

      let explicitAlign = null;
      let explicitSize = null;
      const alignAttr = trimmedField.match(/@align\(\s*(\d+)\s*\)/);
      const sizeAttr = trimmedField.match(/@size\(\s*(\d+)\s*\)/);
      if (alignAttr) explicitAlign = Number(alignAttr[1]);
      if (sizeAttr) explicitSize = Number(sizeAttr[1]);

      const withoutAttrs = trimmedField.replace(/@[A-Za-z_]\w*(?:\([^)]*\))?\s*/g, '').trim();
      const colonIdx = withoutAttrs.indexOf(':');
      if (colonIdx < 0) continue;

      const fieldName = withoutAttrs.slice(0, colonIdx).trim();
      const fieldType = withoutAttrs.slice(colonIdx + 1).trim();
      const fieldLine = cleanContent.slice(0, bodyStartIdx + rf.offsetInBody).split('\n').length;

      const layout = resolveTypeLayout(fieldType, structLayouts, consts, aliases);
      if (!layout) continue;

      const memberAlign = explicitAlign ?? layout.align;
      const memberSize = explicitSize ?? layout.size;
      const prevEnd = offset;
      const memberOffset = roundUp(memberAlign, offset);

      fields.push({
        name: fieldName,
        type: fieldType,
        line: fieldLine,
        prevEnd,
        offset: memberOffset,
        align: memberAlign,
        size: memberSize,
        hasExplicitAlign: explicitAlign !== null,
        isVec3: layout.isVec3,
        isMatCx3: layout.isMatCx3,
        elemIsVec3: layout.elemIsVec3,
        isArray: layout.isArray,
        arrayStride: layout.arrayStride,
      });

      offset = memberOffset + memberSize;
      if (memberAlign > maxAlign) maxAlign = memberAlign;
    }

    const structSize = roundUp(maxAlign, offset);
    structLayouts.set(structName, {
      name: structName,
      line: structStartLine,
      isStageIO,
      align: maxAlign,
      rawEnd: offset,
      size: structSize,
      fields,
    });
  }

  // Discover var<uniform> and var<storage, ...> bound struct names & direct uniform layout violations
  const uniformStructs = new Set();
  const storageStructs = new Set();

  const varRe = /\bvar<\s*(uniform|storage)(?:\s*,\s*[^>]+)?\s*>\s+([A-Za-z_]\w*)\s*:\s*([^;]+);/g;
  let vm;
  while ((vm = varRe.exec(cleanContent)) !== null) {
    const space = vm[1];
    const varName = vm[2];
    const rawType = vm[3].trim();
    const varLine = cleanContent.slice(0, vm.index).split('\n').length;
    const arrayInner = rawType.match(/^array<\s*([A-Za-z_]\w*)/);
    const resolvedAlias = aliases.get(rawType.replace(/\s+/g, '')) || rawType;
    const typeName = arrayInner ? (aliases.get(arrayInner[1]) || arrayInner[1]) : resolvedAlias.replace(/\s+/g, '');

    if (space === 'uniform') {
      uniformStructs.add(typeName);
      const directLayout = resolveTypeLayout(rawType, structLayouts, consts, aliases);
      if (directLayout) {
        if (directLayout.isVec3 || directLayout.elemIsVec3 || directLayout.isMatCx3) {
          structErrors.push({
            file,
            line: varLine,
            message: `Rule 29 alignment trap on var<uniform> '${varName}: ${rawType}'; use 16-byte aligned vec4 or struct.`,
          });
        } else if (directLayout.isArray && directLayout.arrayStride % 16 !== 0) {
          structErrors.push({
            file,
            line: varLine,
            message: `Rule 29 uniform array stride trap on var<uniform> '${varName}: ${rawType}': element stride is ${directLayout.arrayStride} bytes (W3C WGSL §14.4.2 requires a multiple of 16 bytes; pack into array<vec4<...>>).`,
          });
        }
      }
    } else if (space === 'storage') {
      storageStructs.add(typeName);
    }
  }

  // Also include nested structs referenced inside uniform/storage structs
  const checkUniform = new Set(uniformStructs);
  const checkStorage = new Set(storageStructs);
  for (const [name, s] of structLayouts.entries()) {
    if (!s.isStageIO && /Uniform/i.test(name)) {
      checkUniform.add(name);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, s] of structLayouts.entries()) {
      const inU = checkUniform.has(name);
      const inS = checkStorage.has(name);
      if (!inU && !inS) continue;
      for (const f of s.fields) {
        const innerMatch = f.type.replace(/\s+/g, '').match(/^(?:array<)?([A-Za-z_]\w*)/);
        const rawRef = innerMatch ? innerMatch[1] : null;
        const refName = rawRef ? (aliases.get(rawRef) || rawRef) : null;
        if (refName && structLayouts.has(refName)) {
          if (inU && !checkUniform.has(refName)) {
            checkUniform.add(refName);
            changed = true;
          }
          if (inS && !checkStorage.has(refName)) {
            checkStorage.add(refName);
            changed = true;
          }
        }
      }
    }
  }

  for (const [structName, s] of structLayouts.entries()) {
    if (s.isStageIO) continue;
    const isUniform = checkUniform.has(structName);
    const isStorage = checkStorage.has(structName);
    if (!isUniform && !isStorage) continue;

    for (let idx = 0; idx < s.fields.length; idx++) {
      const f = s.fields[idx];
      const next = idx + 1 < s.fields.length ? s.fields[idx + 1] : null;

      if (f.elemIsVec3) {
        structErrors.push({
          file,
          line: f.line,
          message: `Rule 29 alignment trap in struct '${structName}.${f.name}': array of vec3 ('${f.type}') introduces per-element stride holes; use vec4 or scalar arrays.`,
        });
        continue;
      }

      if (isUniform && f.isArray && f.arrayStride % 16 !== 0) {
        structErrors.push({
          file,
          line: f.line,
          message: `Rule 29 uniform array stride trap in struct '${structName}.${f.name}': '${f.type}' has ${f.arrayStride}-byte element stride (W3C WGSL §14.4.2 requires uniform array stride to be a multiple of 16 bytes; pack into array<vec4<...>>).`,
        });
        continue;
      }

      if (f.isMatCx3) {
        structErrors.push({
          file,
          line: f.line,
          message: `Rule 29 alignment trap in struct '${structName}.${f.name}': '${f.type}' uses padded vec3 column stride; use mat4x4<f32> or vec4 columns.`,
        });
        continue;
      }

      if (f.isVec3) {
        const holeBytes = f.align - f.size;
        const hasPreGap = f.offset > f.prevEnd && !f.hasExplicitAlign;
        const isTailPackedWithScalar =
          next !== null && next.offset === f.offset + f.size && next.size === holeBytes;
        if (hasPreGap || !isTailPackedWithScalar) {
          const detail = hasPreGap
            ? `implicit ${f.offset - f.prevEnd}-byte alignment pad before '${f.name}' (offset ${f.prevEnd} -> ${f.offset})`
            : `unfilled ${holeBytes}-byte alignment hole after '${f.name}: ${f.type}' at offset ${f.offset + f.size}`;
          structErrors.push({
            file,
            line: f.line,
            message: `Rule 29 vec3 alignment trap in ${isUniform ? 'uniform' : 'storage'} struct '${structName}.${f.name}' (${detail}). Use 3 scalars or vec4<f32>.`,
          });
          continue;
        }
      }

      if (isUniform && (f.offset - f.prevEnd) >= 8 && !f.hasExplicitAlign) {
        structErrors.push({
          file,
          line: f.line,
          message: `Rule 29 implicit ${f.offset - f.prevEnd}-byte alignment padding in uniform struct '${structName}' before '${f.name}: ${f.type}' (offset ${f.prevEnd} -> ${f.offset}). Add explicit pad scalars so Float32Array offsets match WGSL.`,
        });
      }
    }

    if (isUniform && s.fields.length > 0 && s.rawEnd % 16 !== 0) {
      const lastField = s.fields[s.fields.length - 1];
      structErrors.push({
        file,
        line: lastField.line,
        message: `Rule 29 uniform struct '${structName}' ends at ${s.rawEnd} bytes (not 16-byte aligned; rounds to ${roundUp(16, s.rawEnd)} bytes). Add explicit trailing pad scalar(s).`,
      });
    }
  }

  return structErrors;
}

const BRANCH_KEYWORDS = new Set(['if', 'else', 'for', 'while', 'switch', 'loop', 'continuing']);
const NON_UNIFORM_DERIVATIVE_BUILTINS = new Set([
  'fwidth',
  'fwidthCoarse',
  'fwidthFine',
  'dpdx',
  'dpdxCoarse',
  'dpdxFine',
  'dpdy',
  'dpdyCoarse',
  'dpdyFine',
  'textureSample',
  'textureSampleBias',
  'textureSampleCompare',
]);

export function lintWgslSource(content, file = 'inline.wgsl') {
  const errorMessages = [];
  const warningMessages = [];

  // Strip block comments while preserving exact line numbers
  const cleanOverview = content.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat(m.split('\n').length - 1));
  const rawCleanLines = cleanOverview.split('\n');
  const cleanStrippedLines = rawCleanLines.map((l) => l.replace(/\/\/.*$/, ''));
  const lineCommentStripped = cleanStrippedLines.join('\n');

  const blockStack = [];
  let pendingBranch = false;
  let parenDepth = 0;

  for (let i = 0; i < cleanStrippedLines.length; i++) {
    const lineWithoutComment = cleanStrippedLines[i];
    const lineNum = i + 1;
    const trimmed = lineWithoutComment.trim();
    if (!trimmed) continue;

    // Scan character/token-by-token so single-line `if (c) { let g = fwidth(x); }`
    // and multi-call lines (`textureSampleLevel(...) + textureSample(...)`) are caught accurately.
    let c = 0;
    while (c < lineWithoutComment.length) {
      const ch = lineWithoutComment[c];
      if (/\s/.test(ch)) {
        c++;
        continue;
      }
      if (ch === '(') {
        parenDepth++;
        c++;
        continue;
      }
      if (ch === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
        c++;
        continue;
      }
      if (ch === '{') {
        if (pendingBranch) {
          blockStack.push({ type: 'branch', line: lineNum });
          pendingBranch = false;
        } else {
          blockStack.push({ type: 'other', line: lineNum });
        }
        c++;
        continue;
      }
      if (ch === '}') {
        if (blockStack.length > 0) {
          blockStack.pop();
        }
        pendingBranch = false;
        c++;
        continue;
      }
      if (ch === ';' && parenDepth === 0) {
        pendingBranch = false;
        c++;
        continue;
      }

      const identMatch = lineWithoutComment.slice(c).match(/^[A-Za-z_]\w*/);
      if (identMatch) {
        const word = identMatch[0];
        const nextIdx = c + word.length;
        // Skip member access `.foo`
        const prevChar = c > 0 ? lineWithoutComment[c - 1] : '';
        if (prevChar !== '.') {
          if (parenDepth === 0 && BRANCH_KEYWORDS.has(word)) {
            pendingBranch = true;
          } else if (
            NON_UNIFORM_DERIVATIVE_BUILTINS.has(word) &&
            blockStack.some((b) => b.type === 'branch')
          ) {
            const afterWord = lineWithoutComment.slice(nextIdx).trimStart();
            if (afterWord.startsWith('(')) {
              errorMessages.push({
                file,
                line: lineNum,
                message: `Non-uniform derivative evaluation: '${word}(' inside dynamic branch block.`,
                snippet: trimmed,
              });
            }
          }
        }
        c = nextIdx;
        continue;
      }

      c++;
    }

    if (/8192|4096/.test(trimmed) && !/byteLength|is8k|scale/i.test(trimmed)) {
      warningMessages.push({
        file,
        line: lineNum,
        message: 'Hardcoded texture dimension literal detected.',
        snippet: trimmed,
      });
    }
  }

  const structErrors = lintStructAlignments(lineCommentStripped, file);
  for (const se of structErrors) {
    errorMessages.push(se);
  }

  return {
    errors: errorMessages,
    warnings: warningMessages,
  };
}

function runCli() {
  const SHADERS_DIR = path.resolve('src/webgpu/shaders');

  if (!fs.existsSync(SHADERS_DIR)) {
    console.error(`Shaders directory not found: ${SHADERS_DIR}`);
    process.exit(1);
  }

  const shaderFiles = fs.readdirSync(SHADERS_DIR).filter((f) => f.endsWith('.wgsl'));
  let errors = 0;
  let warnings = 0;

  console.log(`\n============================================================`);
  console.log(`WGSL UNIFORM CONTROL FLOW & STRUCT ALIGNMENT LINTER`);
  console.log(`Auditing ${shaderFiles.length} WGSL shader modules in ${SHADERS_DIR}`);
  console.log(`============================================================\n`);

  for (const file of shaderFiles) {
    const filePath = path.join(SHADERS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const res = lintWgslSource(content, file);

    for (const err of res.errors) {
      console.error(`[ERROR] ${err.file}:${err.line} - ${err.message}`);
      if (err.snippet) {
        console.error(`        Line: ${err.snippet}`);
      }
      errors++;
    }
    for (const warn of res.warnings) {
      console.warn(`[WARN]  ${warn.file}:${warn.line} - ${warn.message}`);
      if (warn.snippet) {
        console.warn(`        Line: ${warn.snippet}`);
      }
      warnings++;
    }
  }

  console.log(`\n------------------------------------------------------------`);
  console.log(`Audit Results: ${errors} errors, ${warnings} warnings across ${shaderFiles.length} shaders.`);
  if (errors > 0) {
    console.error(`FAILED: WGSL uniform control flow or struct alignment violations detected.`);
    process.exit(1);
  } else {
    console.log(`PASSED: All shaders satisfy uniform control flow invariants.`);
    process.exit(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli();
}

