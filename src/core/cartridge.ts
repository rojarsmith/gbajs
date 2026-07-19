/**
 * Cartridge: ROM + header parsing + memory bank controllers.
 *
 * Implemented MBCs (covers nearly the whole GB library):
 * - MBC1: 5-bit ROM bank + 2-bit bank2 (upper ROM bits or RAM bank), mode 0/1
 * - MBC3: 7-bit ROM bank, 4 RAM banks, RTC registers (minimal: wall-clock
 *   values computed at latch time; writes stored but not ticked)
 * - MBC5: 9-bit ROM bank (bank 0 selectable), 16 RAM banks
 * MBC2's built-in nibble RAM is not implemented yet (no test cart on hand).
 *
 * Battery-backed carts set `hasBattery`; RAM writes mark `ramDirty` so the
 * frontend can persist to IndexedDB.
 */

const CART_TYPES: Record<number, string> = {
  0x00: "ROM ONLY",
  0x01: "MBC1",
  0x02: "MBC1+RAM",
  0x03: "MBC1+RAM+BATTERY",
  0x05: "MBC2",
  0x06: "MBC2+BATTERY",
  0x08: "ROM+RAM",
  0x09: "ROM+RAM+BATTERY",
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

const BATTERY_TYPES = new Set([0x03, 0x06, 0x09, 0x0f, 0x10, 0x13, 0x1b, 0x1e]);

type MbcKind = "none" | "mbc1" | "mbc3" | "mbc5";

function mbcKind(typeCode: number): MbcKind {
  if (typeCode === 0x00 || typeCode === 0x08 || typeCode === 0x09) return "none";
  if (typeCode <= 0x03) return "mbc1";
  if (typeCode >= 0x0f && typeCode <= 0x13) return "mbc3";
  if (typeCode >= 0x19 && typeCode <= 0x1e) return "mbc5";
  console.warn(`Unsupported cartridge type 0x${typeCode.toString(16)}; using MBC1 behavior`);
  return "mbc1";
}

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
  readonly hasBattery: boolean;
  /** Set on external-RAM writes; the frontend clears it after persisting. */
  ramDirty = false;

  private readonly kind: MbcKind;
  private readonly romBankMask: number;
  private ramEnabled = false;
  private romBank = 1;
  private bank2 = 0;   // MBC1 upper bits; MBC3/MBC5 RAM bank / RTC select
  private mode = 0;    // MBC1 banking mode
  private rtc = new Uint8Array(5); // MBC3 latched S, M, H, DL, DH
  private rtcLatch = 0xff;

  constructor(rom: Uint8Array) {
    if (rom.length < 0x150) {
      throw new Error(`ROM too small to contain a header (${rom.length} bytes)`);
    }
    this.rom = rom;
    this.header = Cartridge.parseHeader(rom);
    this.ram = new Uint8Array(this.header.ramSize);
    this.kind = mbcKind(this.header.cartTypeCode);
    this.hasBattery = BATTERY_TYPES.has(this.header.cartTypeCode);
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

  // ---- ROM (0x0000-0x7FFF) ----------------------------------------------

  readRom(addr: number): number {
    if (this.kind === "none") return addr < this.rom.length ? this.rom[addr] : 0xff;
    let bank: number;
    if (addr < 0x4000) {
      bank = this.kind === "mbc1" && this.mode ? (this.bank2 << 5) & this.romBankMask : 0;
    } else if (this.kind === "mbc1") {
      bank = ((this.bank2 << 5) | this.romBank) & this.romBankMask;
    } else {
      bank = this.romBank & this.romBankMask;
    }
    return this.rom[(bank << 14) | (addr & 0x3fff)];
  }

  /** Writes into ROM space program the MBC registers. */
  writeRom(addr: number, value: number): void {
    switch (this.kind) {
      case "none": return;
      case "mbc1":
        if (addr < 0x2000) this.ramEnabled = (value & 0xf) === 0xa;
        else if (addr < 0x4000) this.romBank = (value & 0x1f) || 1; // bank 0 selects 1
        else if (addr < 0x6000) this.bank2 = value & 0x03;
        else this.mode = value & 1;
        return;
      case "mbc3":
        if (addr < 0x2000) this.ramEnabled = (value & 0xf) === 0xa;
        else if (addr < 0x4000) this.romBank = (value & 0x7f) || 1;
        else if (addr < 0x6000) this.bank2 = value; // 0-3 RAM bank, 0x8-0xC RTC reg
        else {
          if (this.rtcLatch === 0 && value === 1) this.latchRtc();
          this.rtcLatch = value;
        }
        return;
      case "mbc5":
        if (addr < 0x2000) this.ramEnabled = (value & 0xf) === 0xa;
        else if (addr < 0x3000) this.romBank = (this.romBank & 0x100) | value; // bank 0 allowed
        else if (addr < 0x4000) this.romBank = (this.romBank & 0xff) | ((value & 1) << 8);
        else if (addr < 0x6000) this.bank2 = value & 0x0f;
        return;
    }
  }

  // ---- external RAM (0xA000-0xBFFF, offset 0-0x1FFF) ---------------------

  readRam(offset: number): number {
    if (this.kind !== "none" && !this.ramEnabled) return 0xff;
    if (this.kind === "mbc3" && this.bank2 >= 0x08 && this.bank2 <= 0x0c) {
      return this.rtc[this.bank2 - 0x08];
    }
    if (this.ram.length === 0) return 0xff;
    return this.ram[this.ramIndex(offset)];
  }

  writeRam(offset: number, value: number): void {
    if (this.kind !== "none" && !this.ramEnabled) return;
    if (this.kind === "mbc3" && this.bank2 >= 0x08 && this.bank2 <= 0x0c) {
      this.rtc[this.bank2 - 0x08] = value;
      return;
    }
    if (this.ram.length === 0) return;
    this.ram[this.ramIndex(offset)] = value;
    this.ramDirty = true;
  }

  /** RAM address after banking; mirrors when RAM is smaller than addressed. */
  private ramIndex(offset: number): number {
    let bank = 0;
    if (this.kind === "mbc1") bank = this.mode ? this.bank2 : 0;
    else if (this.kind === "mbc3") bank = this.bank2 & 0x03;
    else if (this.kind === "mbc5") bank = this.bank2;
    return ((bank << 13) + offset) % this.ram.length;
  }

  private latchRtc(): void {
    // Minimal RTC: latch current wall-clock time. Not persisted, not
    // adjustable via writes — enough for games to boot and tick.
    const t = Math.floor(Date.now() / 1000);
    const days = Math.floor(t / 86400) & 0x1ff;
    this.rtc[0] = t % 60;
    this.rtc[1] = Math.floor(t / 60) % 60;
    this.rtc[2] = Math.floor(t / 3600) % 24;
    this.rtc[3] = days & 0xff;
    this.rtc[4] = (days >> 8) & 1;
  }

  // ---- battery save interface -------------------------------------------

  exportRam(): Uint8Array {
    return this.ram.slice();
  }

  importRam(data: Uint8Array): void {
    this.ram.set(data.subarray(0, this.ram.length));
  }

  /** Stable identity for keying saves in IndexedDB. */
  get saveKey(): string {
    const h = this.header;
    return `${h.title}-${h.globalChecksum.toString(16)}-${this.rom.length}`;
  }
}
