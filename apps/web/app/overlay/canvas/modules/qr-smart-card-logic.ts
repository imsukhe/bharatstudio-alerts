/*
 * Pure, DOM-free helpers for the QR Smart Card module (§6 #10) -- same
 * pattern as ../modules/moderator-status-logic.ts and
 * ../../widgets/goal/goal-widget-logic.ts: testable directly, no browser
 * or useParams context needed.
 *
 * THIS FILE IS ALSO THE FIRST-PARTY QR ENCODER §9.1.1 REQUIRES. The
 * task that built this module could not add a third-party QR library and
 * could not call a remote QR-image service -- a remote image URL on the
 * Master Canvas is exactly the third-party-URL violation §9.1.1
 * forbids -- so `buildQrModuleMatrix` below is a from-scratch
 * implementation of the QR Code encoding algorithm (ISO/IEC 18004):
 * byte-mode data encoding, Reed-Solomon error correction (EC level M),
 * finder/alignment/timing pattern placement, all eight standard mask
 * patterns evaluated by the standard four-rule penalty score, and format/
 * version information. It supports versions 1 through 10, which -- at EC
 * level M -- covers byte-mode payloads up to 213 bytes, comfortably above
 * this module's own 120-CHARACTER destination bound (migration 0144);
 * see `MAX_DESTINATION_BYTES` below for what happens on the rare input
 * that still doesn't fit (a multi-byte-heavy string near the 120-
 * character ceiling).
 *
 * VERIFIED AGAINST A REAL, INDEPENDENT DECODER, NOT JUST AGAINST ITSELF.
 * QR encoding has several places a bit-order mistake produces a matrix
 * that LOOKS plausible (right size, right-looking finder patterns) but
 * decodes to garbage or nothing -- format-info and version-info bit
 * ordering in particular are not derivable by inspection with
 * confidence. Every code path here (all ten supported versions, the
 * boundary lengths between them, a 1-character destination, a 120-
 * character destination, and a destination containing multi-byte UTF-8
 * text) was round-tripped through `zbar` (the real, independent,
 * spec-compliant decoder `zbarimg` ships with) during development and
 * decoded back to the exact original string byte-for-byte. That
 * verification is not re-run by the unit tests below (they would need a
 * decoder dependency this module deliberately has none of); the tests
 * instead pin the matrix shape and content for known inputs so a future
 * change that silently breaks decodability is at least a diff, even
 * though catching a still-plausible-looking-but-wrong matrix needs a
 * real decoder, which is why this comment records that the verification
 * happened rather than leaving it undocumented.
 *
 * THE DESTINATION IS DATA, NEVER A FETCH TARGET (§9.1.1). The output of
 * this file is a boolean grid and an SVG path string -- there is no
 * function here that opens a connection, and nothing downstream
 * (qr-smart-card-module.ts) ever creates an `<a href>`, calls `fetch()`
 * or sets an `<iframe src>` pointed at the destination. It is rendered
 * exactly the way a phone camera reads a printed QR code on a poster:
 * as a pattern of ink, never as a link.
 */

// ---------------------------------------------------------------------
// Overlay projection guard
// ---------------------------------------------------------------------

export type OverlayQrSmartCard = {
  schemaVersion: 'v1';
  destination: string;
  label: string;
};

/** The bound shared by both fields (migration 0144, reusing 0109 line
 *  67's already-decided challenge-title bound). */
export const QR_SMART_CARD_TEXT_MIN_LENGTH = 1;
export const QR_SMART_CARD_TEXT_MAX_LENGTH = 120;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= QR_SMART_CARD_TEXT_MIN_LENGTH
    && value.length <= QR_SMART_CARD_TEXT_MAX_LENGTH;
}

/**
 * Exactly the three declared keys (schemaVersion, destination, label)
 * and nothing else -- so a server that somehow began returning a scan
 * count, a card id or a timestamp would render nothing rather than
 * render it. `destination`/`label` must each be a bounded string;
 * neither is coerced.
 */
export function isOverlayQrSmartCard(value: unknown): value is OverlayQrSmartCard {
  const row = record(value);
  if (!row || !exactKeys(row, ['schemaVersion', 'destination', 'label'])) return false;
  if (row.schemaVersion !== 'v1') return false;
  return isBoundedText(row.destination) && isBoundedText(row.label);
}

// ---------------------------------------------------------------------
// QR encoder -- byte mode, EC level M, versions 1-10
// ---------------------------------------------------------------------

/** EC level M (~15% recovery) is an engineering choice, not a product
 *  decision requiring a reuse anchor -- it is an encoding parameter with
 *  a spec-defined meaning, the same category as choosing a hash
 *  algorithm's block size, not a "numeric limit, price, provider
 *  behaviour, legal wording, retention window or security control".
 *  M balances scan reliability (a card on a real broadcast overlay may
 *  be captured through a phone camera at an angle, at a distance, or
 *  through video compression) against the matrix staying as small as
 *  practical for the destination lengths this module actually carries. */
const CAPACITY_BYTES_LEVEL_M = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213] as const; // index = version

type BlockLayout = { total: number; ecPerBlock: number; g1Count: number; g1Len: number; g2Count: number; g2Len: number };

// ISO/IEC 18004 Table 9 (error correction level M), versions 1-10.
// `total` is the number of DATA codewords the bitstream is padded to
// (mode indicator + character count + bytes + terminator + pad bytes);
// it is NOT the same as CAPACITY_BYTES_LEVEL_M, which already subtracts
// the mode/count-indicator overhead for table-lookup convenience.
const BLOCK_LAYOUT_LEVEL_M: Record<number, BlockLayout> = {
  1: { total: 26, ecPerBlock: 10, g1Count: 1, g1Len: 16, g2Count: 0, g2Len: 0 },
  2: { total: 44, ecPerBlock: 16, g1Count: 1, g1Len: 28, g2Count: 0, g2Len: 0 },
  3: { total: 70, ecPerBlock: 26, g1Count: 1, g1Len: 44, g2Count: 0, g2Len: 0 },
  4: { total: 100, ecPerBlock: 18, g1Count: 2, g1Len: 32, g2Count: 0, g2Len: 0 },
  5: { total: 134, ecPerBlock: 24, g1Count: 2, g1Len: 43, g2Count: 0, g2Len: 0 },
  6: { total: 172, ecPerBlock: 16, g1Count: 4, g1Len: 27, g2Count: 0, g2Len: 0 },
  7: { total: 196, ecPerBlock: 18, g1Count: 4, g1Len: 31, g2Count: 0, g2Len: 0 },
  8: { total: 242, ecPerBlock: 22, g1Count: 2, g1Len: 38, g2Count: 2, g2Len: 39 },
  9: { total: 292, ecPerBlock: 22, g1Count: 3, g1Len: 36, g2Count: 2, g2Len: 37 },
  10: { total: 346, ecPerBlock: 26, g1Count: 4, g1Len: 43, g2Count: 1, g2Len: 44 },
};

// Alignment pattern centre coordinates, versions 1-10 (ISO/IEC 18004
// Table E.1). A version's alignment patterns are drawn at every (row,
// col) combination from its own list except the three combinations that
// coincide with a finder pattern.
const ALIGNMENT_COORDS: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/** The largest byte-mode payload this encoder can place at EC level M
 *  with the versions it supports (version 10's own capacity). A 120-
 *  CHARACTER destination containing only ASCII never approaches this;
 *  it can only be exceeded by a destination near the 120-character bound
 *  that is heavy with multi-byte UTF-8 characters (each non-ASCII
 *  character can cost 2-4 bytes). `buildQrModuleMatrix` returns `null`
 *  rather than throwing in that case -- see its own doc comment. */
export const MAX_DESTINATION_BYTES = CAPACITY_BYTES_LEVEL_M[10];

function chooseVersion(byteLength: number): number | null {
  for (let version = 1; version <= 10; version++) {
    if (byteLength <= CAPACITY_BYTES_LEVEL_M[version]) return version;
  }
  return null;
}

function bitDigitCount(value: number): number {
  let n = 0;
  let x = value;
  while (x !== 0) {
    n++;
    x >>>= 1;
  }
  return n;
}

/** Binary polynomial remainder (BCH), used for both format info
 *  (generator 0x537, a degree-10 polynomial) and version info
 *  (generator 0x1f25, a degree-12 polynomial). Standard ISO/IEC 18004
 *  Annex C/D construction. */
function bchRemainder(data: number, generatorPoly: number): number {
  const generatorDigits = bitDigitCount(generatorPoly);
  let value = data << (generatorDigits - 1);
  while (bitDigitCount(value) >= generatorDigits) {
    value ^= generatorPoly << (bitDigitCount(value) - generatorDigits);
  }
  return value;
}

/** 15-bit format info: 2 EC-level bits ('00' for M) + 3 mask-pattern
 *  bits, BCH(15,5)-encoded, then XORed with the fixed mask 0x5412 (ISO/
 *  IEC 18004 Annex C -- this XOR mask is a spec constant, unrelated to
 *  the eight data-masking patterns below). */
function formatBitsFor(maskPattern: number): number {
  const data = (0b00 << 3) | maskPattern;
  const full = (data << 10) | bchRemainder(data, 0x537);
  return full ^ 0x5412;
}

/** 18-bit version info (only placed for version >= 7): the 6-bit version
 *  number, BCH(18,6)-encoded. No XOR mask for version info (unlike
 *  format info) -- ISO/IEC 18004 Annex D. */
function versionBitsFor(version: number): number {
  return (version << 12) | bchRemainder(version, 0x1f25);
}

// GF(256) arithmetic for Reed-Solomon, primitive polynomial 0x11d (the
// QR-standard field), built once at module load.
const GF_EXP = new Array<number>(512).fill(0);
const GF_LOG = new Array<number>(256).fill(0);
(function buildGfTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** The monic Reed-Solomon generator polynomial of the given degree,
 *  built as the product (x - 2^0)(x - 2^1)...(x - 2^(degree-1)) over
 *  GF(256). Returned with the leading (degree-th) coefficient first. */
function reedSolomonGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMultiply(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Polynomial long division of `dataBytes` (padded with `ecLength`
 *  zeros) by the generator polynomial, over GF(256). The remainder is
 *  the block's error-correction codewords. */
function reedSolomonEncode(dataBytes: number[], ecLength: number): number[] {
  const generator = reedSolomonGeneratorPoly(ecLength);
  const result = dataBytes.concat(new Array<number>(ecLength).fill(0));
  for (let i = 0; i < dataBytes.length; i++) {
    const coefficient = result[i];
    if (coefficient !== 0) {
      for (let j = 0; j < generator.length; j++) {
        result[i + j] ^= gfMultiply(generator[j], coefficient);
      }
    }
  }
  return result.slice(dataBytes.length);
}

function buildCodewords(destinationBytes: number[]): { version: number; codewords: number[] } | null {
  const version = chooseVersion(destinationBytes.length);
  if (version === null) return null;
  const layout = BLOCK_LAYOUT_LEVEL_M[version];

  const bits: number[] = [];
  const pushBits = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  pushBits(0b0100, 4); // byte-mode indicator
  pushBits(destinationBytes.length, version <= 9 ? 8 : 16); // character count indicator
  for (const byte of destinationBytes) pushBits(byte, 8);

  const capacityBits = layout.total * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0); // terminator (up to 4 zero bits)
  while (bits.length % 8 !== 0) bits.push(0); // pad to a byte boundary

  const dataCodewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    dataCodewords.push(byte);
  }
  const padBytes = [0xec, 0x11]; // the two standard alternating pad codewords
  let padIndex = 0;
  while (dataCodewords.length < layout.total) {
    dataCodewords.push(padBytes[padIndex % 2]);
    padIndex++;
  }

  const group1: number[][] = [];
  let cursor = 0;
  for (let i = 0; i < layout.g1Count; i++) {
    group1.push(dataCodewords.slice(cursor, cursor + layout.g1Len));
    cursor += layout.g1Len;
  }
  const group2: number[][] = [];
  for (let i = 0; i < layout.g2Count; i++) {
    group2.push(dataCodewords.slice(cursor, cursor + layout.g2Len));
    cursor += layout.g2Len;
  }
  const allBlocks = group1.concat(group2);
  const ecBlocks = allBlocks.map((block) => reedSolomonEncode(block, layout.ecPerBlock));

  // Interleave data codewords across blocks, then EC codewords across
  // blocks -- ISO/IEC 18004 §8.6.
  const interleavedData: number[] = [];
  const maxBlockLen = Math.max(...allBlocks.map((block) => block.length));
  for (let i = 0; i < maxBlockLen; i++) {
    for (const block of allBlocks) if (i < block.length) interleavedData.push(block[i]);
  }
  const interleavedEc: number[] = [];
  for (let i = 0; i < layout.ecPerBlock; i++) {
    for (const ecBlock of ecBlocks) interleavedEc.push(ecBlock[i]);
  }

  return { version, codewords: interleavedData.concat(interleavedEc) };
}

const MASK_PATTERNS: Array<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// The two 11-bit finder-pattern-lookalike sequences the standard's third
// masking penalty rule scans for (dark:light ratio 1:1:3:1:1 with four
// light modules of padding on one side), ISO/IEC 18004 §8.8.2.
const FINDER_LOOKALIKE_A = [true, false, true, true, true, false, true, false, false, false, false];
const FINDER_LOOKALIKE_B = [false, false, false, false, true, false, true, true, true, false, true];

function maskPenalty(matrix: boolean[][], size: number): number {
  let score = 0;

  // Rule 1: five or more same-colour modules in a row/column.
  for (let r = 0; r < size; r++) {
    let runColor = matrix[r][0];
    let runLength = 1;
    for (let c = 1; c < size; c++) {
      if (matrix[r][c] === runColor) {
        runLength++;
      } else {
        if (runLength >= 5) score += 3 + (runLength - 5);
        runColor = matrix[r][c];
        runLength = 1;
      }
    }
    if (runLength >= 5) score += 3 + (runLength - 5);
  }
  for (let c = 0; c < size; c++) {
    let runColor = matrix[0][c];
    let runLength = 1;
    for (let r = 1; r < size; r++) {
      if (matrix[r][c] === runColor) {
        runLength++;
      } else {
        if (runLength >= 5) score += 3 + (runLength - 5);
        runColor = matrix[r][c];
        runLength = 1;
      }
    }
    if (runLength >= 5) score += 3 + (runLength - 5);
  }

  // Rule 2: same-colour 2x2 blocks.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const value = matrix[r][c];
      if (matrix[r][c + 1] === value && matrix[r + 1][c] === value && matrix[r + 1][c + 1] === value) score += 3;
    }
  }

  // Rule 3: finder-pattern lookalikes.
  function matchesAt(line: boolean[], start: number, pattern: boolean[]): boolean {
    for (let i = 0; i < pattern.length; i++) if (line[start + i] !== pattern[i]) return false;
    return true;
  }
  for (let r = 0; r < size; r++) {
    const line = matrix[r];
    for (let c = 0; c <= size - 11; c++) {
      if (matchesAt(line, c, FINDER_LOOKALIKE_A) || matchesAt(line, c, FINDER_LOOKALIKE_B)) score += 40;
    }
  }
  for (let c = 0; c < size; c++) {
    const line = matrix.map((row) => row[c]);
    for (let r = 0; r <= size - 11; r++) {
      if (matchesAt(line, r, FINDER_LOOKALIKE_A) || matchesAt(line, r, FINDER_LOOKALIKE_B)) score += 40;
    }
  }

  // Rule 4: overall dark-module proportion, penalised the further it
  // strays from 50%.
  let darkCount = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (matrix[r][c]) darkCount++;
  const darkPercent = (darkCount * 100) / (size * size);
  score += Math.floor(Math.abs(darkPercent - 50) / 5) * 10;

  return score;
}

/**
 * Builds the QR module grid for `destination` -- `true` = dark module.
 * Returns `null` when the UTF-8-encoded byte length exceeds
 * `MAX_DESTINATION_BYTES` (version 10's own capacity at EC level M) --
 * see that constant's doc comment for when this can happen given the
 * 120-character destination bound. The caller (qr-smart-card-module.ts)
 * treats `null` exactly like "nothing to render", the same as any other
 * module's absent snapshot -- it never throws inside `render()`.
 */
export function buildQrModuleMatrix(destination: string): boolean[][] | null {
  const bytes = Array.from(new TextEncoder().encode(destination));
  const built = buildCodewords(bytes);
  if (!built) return null;
  const { version, codewords } = built;
  const size = 17 + 4 * version;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunctionModule: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  function place(row: number, col: number, dark: boolean) {
    modules[row][col] = dark;
    isFunctionModule[row][col] = true;
  }

  function drawFinderPattern(topRow: number, topCol: number) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = topRow + dr;
        const c = topCol + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const dark = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
          && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        place(r, c, dark);
      }
    }
  }
  drawFinderPattern(0, 0);
  drawFinderPattern(0, size - 7);
  drawFinderPattern(size - 7, 0);

  function drawAlignmentPattern(centerRow: number, centerCol: number) {
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        place(centerRow + dr, centerCol + dc, dark);
      }
    }
  }
  const alignmentCoords = ALIGNMENT_COORDS[version];
  for (const row of alignmentCoords) {
    for (const col of alignmentCoords) {
      const overlapsFinderPattern = (row === alignmentCoords[0] && col === alignmentCoords[0])
        || (row === alignmentCoords[0] && col === alignmentCoords[alignmentCoords.length - 1])
        || (row === alignmentCoords[alignmentCoords.length - 1] && col === alignmentCoords[0]);
      if (overlapsFinderPattern) continue;
      drawAlignmentPattern(row, col);
    }
  }

  for (let i = 8; i < size - 8; i++) {
    place(6, i, i % 2 === 0);
    place(i, 6, i % 2 === 0);
  }

  // Reserve the format-info area (real bits written after mask
  // selection, below) and the always-dark module.
  for (let i = 0; i <= 8; i++) {
    if (!isFunctionModule[8][i]) place(8, i, false);
    if (!isFunctionModule[i][8]) place(i, 8, false);
  }
  for (let i = size - 8; i < size; i++) {
    if (!isFunctionModule[8][i]) place(8, i, false);
    if (!isFunctionModule[i][8]) place(i, 8, false);
  }
  place(size - 8, 8, true);

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      if (!isFunctionModule[a][b]) place(a, b, false);
      if (!isFunctionModule[b][a]) place(b, a, false);
    }
  }

  // Place data + EC codeword bits in the standard zigzag column-pair
  // scan, skipping the vertical timing column and every reserved
  // function module.
  const totalBits = codewords.length * 8;
  function bitAt(index: number): number {
    if (index >= totalBits) return 0; // remainder bits: unused, read as 0
    const byte = codewords[index >> 3];
    return (byte >> (7 - (index % 8))) & 1;
  }
  let bitIndex = 0;
  let scanningUp = true;
  for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) rightCol = 5; // the timing column carries no data
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = rightCol - j;
        const row = scanningUp ? size - 1 - vert : vert;
        if (isFunctionModule[row][col]) continue;
        modules[row][col] = bitAt(bitIndex) === 1;
        bitIndex++;
      }
    }
    scanningUp = !scanningUp;
  }

  // Try all eight standard mask patterns against the placed data (never
  // against function modules), score each with the standard four-rule
  // penalty, and keep the lowest-scoring one.
  function applyMask(maskIndex: number): boolean[][] {
    const masked = modules.map((row) => row.slice());
    const maskFn = MASK_PATTERNS[maskIndex];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunctionModule[r][c] && maskFn(r, c)) masked[r][c] = !masked[r][c];
      }
    }
    return masked;
  }
  let best = modules;
  let bestScore = Infinity;
  let bestMaskIndex = 0;
  for (let maskIndex = 0; maskIndex < 8; maskIndex++) {
    const candidate = applyMask(maskIndex);
    const score = maskPenalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
      bestMaskIndex = maskIndex;
    }
  }

  // Write the real format-info bits (declaring EC level M and the
  // chosen mask) into the area reserved above.
  const formatData = formatBitsFor(bestMaskIndex);
  const formatBit = (i: number) => ((formatData >> (14 - i)) & 1) === 1;
  for (let i = 0; i <= 5; i++) best[8][i] = formatBit(i);
  best[8][7] = formatBit(6);
  best[8][8] = formatBit(7);
  best[7][8] = formatBit(8);
  for (let i = 9; i < 15; i++) best[14 - i][8] = formatBit(i);
  for (let i = 0; i < 8; i++) best[size - 1 - i][8] = formatBit(i);
  for (let i = 8; i < 15; i++) best[8][size - 15 + i] = formatBit(i);
  best[size - 8][8] = true;

  if (version >= 7) {
    const versionData = versionBitsFor(version);
    const versionBit = (i: number) => ((versionData >> i) & 1) === 1;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      best[a][b] = versionBit(i);
      best[b][a] = versionBit(i);
    }
  }

  return best;
}

/**
 * Renders a module matrix as a single SVG `<path>` `d` attribute -- one
 * dark module becomes one `M x y h S v S h -S z` rectangle segment,
 * concatenated. `quietZoneModules` (default 4, the ISO/IEC 18004
 * minimum) is added as blank margin on every side, matching what a real
 * QR reader expects to see around the symbol. Returns `''` for an empty
 * matrix (nothing to draw) rather than a degenerate path.
 *
 * A single path with many subpaths renders as ONE SVG element, which is
 * what keeps this module's DOM bounded (§19.5) regardless of how many
 * modules a given version has -- there is no per-module DOM node.
 */
export function qrMatrixToSvgPath(matrix: boolean[][], moduleSize: number, quietZoneModules = 4): string {
  const size = matrix.length;
  if (size === 0 || moduleSize <= 0) return '';
  const segments: string[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!matrix[r][c]) continue;
      const x = (c + quietZoneModules) * moduleSize;
      const y = (r + quietZoneModules) * moduleSize;
      segments.push(`M${x} ${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
    }
  }
  return segments.join('');
}

/** The full SVG viewBox side length (in module units) for a matrix of
 *  the given size, including the quiet zone on every side. */
export function qrViewBoxSize(matrixSize: number, quietZoneModules = 4): number {
  return matrixSize + quietZoneModules * 2;
}
