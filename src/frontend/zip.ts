/**
 * Minimal ZIP reader — just enough to pull a ROM out of a .zip in the browser
 * with zero dependencies. Parses the central directory and inflates entries
 * via the native DecompressionStream("deflate-raw").
 *
 * Not supported (not needed for ROM zips): zip64, encryption, multi-disk.
 */

export interface ZipEntry {
  name: string;
  method: number; // 0 = stored, 8 = deflate
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export function isZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b;
}

export function listZip(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Find End Of Central Directory: scan backwards (a trailing comment of up
  // to 65535 bytes may follow it).
  let eocd = -1;
  const scanEnd = Math.max(0, data.length - 22 - 65535);
  for (let i = data.length - 22; i >= scanEnd; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid ZIP file (no end-of-central-directory)");

  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true); // central directory offset

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== CENTRAL_SIG) {
      throw new Error("Corrupt ZIP central directory");
    }
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    entries.push({
      name: new TextDecoder().decode(data.subarray(pos + 46, pos + 46 + nameLen)),
      method: view.getUint16(pos + 10, true),
      compressedSize: view.getUint32(pos + 20, true),
      size: view.getUint32(pos + 24, true),
      localHeaderOffset: view.getUint32(pos + 42, true),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function extractZipEntry(data: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const p = entry.localHeaderOffset;
  if (view.getUint32(p, true) !== LOCAL_SIG) {
    throw new Error(`Corrupt ZIP local header for ${entry.name}`);
  }
  // Local header's name/extra lengths can differ from the central directory's.
  const nameLen = view.getUint16(p + 26, true);
  const extraLen = view.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  const compressed = data.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return compressed.slice();
  if (entry.method !== 8) {
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  }
  const stream = new Blob([compressed.slice()])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
