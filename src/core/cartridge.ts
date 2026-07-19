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

  // MBC1 state (also the safe fallback for not-yet-implemented MBCs)
  private readonly hasMbc: boolean;
  private readonly romBankMask: number;
  private ramEnabled = false;
  private romBank = 1;
  private bank2 = 0; // upper ROM bank bits / RAM bank, depending on mode
  private mode = 0;

  constructor(rom: Uint8Array) {
    if (rom.length < 0x150) {
      throw new Error(`ROM too small to contain a header (${rom.length} bytes)`);
    }
    this.rom = rom;
    this.header = Cartridge.parseHeader(rom);
    this.ram = new Uint8Array(this.header.ramSize);
    // 0x00 = ROM only. Everything else gets MBC1 semantics for now; MBC3
    // (0x0F-0x13) and MBC5 (0x19-0x1E) differ and arrive in roadmap step 6.
    this.hasMbc = this.header.cartTypeCode !== 0x00;
    this.romBankMask = Math.max(1, rom.length >> 14) - 1; // banks are 16 KiB
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

  /** 0x0000-0x7FFF. */
  readRom(addr: number): number {
    if (!this.hasMbc) return addr < this.rom.length ? this.rom[addr] : 0xff;
    const bank = addr < 0x4000
      ? (this.mode ? (this.bank2 << 5) & this.romBankMask : 0)
      : ((this.bank2 << 5) | this.romBank) & this.romBankMask;
    return this.rom[(bank << 14) | (addr & 0x3fff)];
  }

  /** Writes into ROM space program the MBC registers. */
  writeRom(addr: number, value: number): void {
    if (!this.hasMbc) return;
    if (addr < 0x2000) this.ramEnabled = (value & 0xf) === 0xa;
    else if (addr < 0x4000) this.romBank = (value & 0x1f) || 1; // bank 0 selects 1
    else if (addr < 0x6000) this.bank2 = value & 0x03;
    else this.mode = value & 1;
  }

  private ramOffset(offset: number): number {
    return (this.hasMbc && this.mode ? this.bank2 << 13 : 0) + offset;
  }

  /** 0xA000-0xBFFF external RAM (offset 0-0x1FFF). */
  readRam(offset: number): number {
    if (this.hasMbc && !this.ramEnabled) return 0xff;
    const i = this.ramOffset(offset);
    return i < this.ram.length ? this.ram[i] : 0xff;
  }

  writeRam(offset: number, value: number): void {
    if (this.hasMbc && !this.ramEnabled) return;
    const i = this.ramOffset(offset);
    if (i < this.ram.length) this.ram[i] = value;
  }
}
