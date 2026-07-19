/**
 * Cartridge: ROM + header parsing. MBC bank switching arrives in a later step;
 * for now reads are flat (enough for 32 KiB "ROM only" carts and header dumps).
 */

const CART_TYPES: Record<number, string> = {
  0x00: "ROM ONLY",
  0x01: "MBC1",
  0x02: "MBC1+RAM",
  0x03: "MBC1+RAM+BATTERY",
  0x05: "MBC2",
  0x06: "MBC2+BATTERY",
  0x0f: "MBC3+TIMER+BATTERY",
  0x10: "MBC3+TIMER+RAM+BATTERY",
  0x11: "MBC3",
  0x12: "MBC3+RAM",
  0x13: "MBC3+RAM+BATTERY",
  0x19: "MBC5",
  0x1a: "MBC5+RAM",
  0x1b: "MBC5+RAM+BATTERY",
  0x1c: "MBC5+RUMBLE",
  0x1d: "MBC5+RUMBLE+RAM",
  0x1e: "MBC5+RUMBLE+RAM+BATTERY",
};

const RAM_SIZES: Record<number, number> = {
  0x00: 0,
  0x02: 8 * 1024,
  0x03: 32 * 1024,
  0x04: 128 * 1024,
  0x05: 64 * 1024,
};

export interface CartHeader {
  title: string;
  cgbFlag: number; // 0x80 = CGB enhanced, 0xC0 = CGB only
  cartTypeCode: number;
  cartTypeName: string;
  romSize: number; // bytes, from header
  ramSize: number; // bytes, from header
  headerChecksum: number;
  headerChecksumOk: boolean;
  globalChecksum: number;
}

export class Cartridge {
  readonly rom: Uint8Array;
  readonly ram: Uint8Array;
  readonly header: CartHeader;

  constructor(rom: Uint8Array) {
    if (rom.length < 0x150) {
      throw new Error(`ROM too small to contain a header (${rom.length} bytes)`);
    }
    this.rom = rom;
    this.header = Cartridge.parseHeader(rom);
    this.ram = new Uint8Array(this.header.ramSize);
  }

  static parseHeader(rom: Uint8Array): CartHeader {
    let title = "";
    for (let i = 0x134; i <= 0x143; i++) {
      const b = rom[i];
      if (b === 0 || b >= 0x80) break; // stop at NUL or CGB flag byte
      title += String.fromCharCode(b);
    }

    // Header checksum: x = 0; for 0x134..0x14C: x = x - byte - 1 (8-bit)
    let sum = 0;
    for (let i = 0x134; i <= 0x14c; i++) {
      sum = (sum - rom[i] - 1) & 0xff;
    }

    const cartTypeCode = rom[0x147];
    return {
      title,
      cgbFlag: rom[0x143] >= 0x80 ? rom[0x143] : 0,
      cartTypeCode,
      cartTypeName: CART_TYPES[cartTypeCode] ?? `unknown (0x${cartTypeCode.toString(16)})`,
      romSize: 32 * 1024 * (1 << rom[0x148]),
      ramSize: RAM_SIZES[rom[0x149]] ?? 0,
      headerChecksum: rom[0x14d],
      headerChecksumOk: sum === rom[0x14d],
      globalChecksum: (rom[0x14e] << 8) | rom[0x14f],
    };
  }

  /** 0x0000-0x7FFF. Flat for now; MBC banking replaces this later. */
  readRom(addr: number): number {
    return addr < this.rom.length ? this.rom[addr] : 0xff;
  }

  writeRom(_addr: number, _value: number): void {
    // MBC register writes land here later. Ignored for ROM-only carts.
  }

  /** 0xA000-0xBFFF external RAM (offset 0-0x1FFF). */
  readRam(offset: number): number {
    return offset < this.ram.length ? this.ram[offset] : 0xff;
  }

  writeRam(offset: number, value: number): void {
    if (offset < this.ram.length) this.ram[offset] = value;
  }
}
