import type { Cartridge } from "./cartridge";

/**
 * The 16-bit memory bus. Every CPU memory access dispatches through here.
 * PPU/APU/timer registers are a flat I/O byte array for now; they gain real
 * behavior as each component is implemented.
 */
export class Bus {
  private cart: Cartridge;
  private vram = new Uint8Array(0x2000);
  private wram = new Uint8Array(0x2000);
  private oam = new Uint8Array(0xa0);
  private io = new Uint8Array(0x80);
  private hram = new Uint8Array(0x7f);
  private ie = 0;

  /** Blargg's test ROMs print results via the serial port — capture them. */
  onSerial: ((byte: number) => void) | null = null;

  constructor(cart: Cartridge) {
    this.cart = cart;
  }

  read8(addr: number): number {
    addr &= 0xffff;
    if (addr < 0x8000) return this.cart.readRom(addr);
    if (addr < 0xa000) return this.vram[addr - 0x8000];
    if (addr < 0xc000) return this.cart.readRam(addr - 0xa000);
    if (addr < 0xe000) return this.wram[addr - 0xc000];
    if (addr < 0xfe00) return this.wram[addr - 0xe000]; // echo RAM
    if (addr < 0xfea0) return this.oam[addr - 0xfe00];
    if (addr < 0xff00) return 0xff; // unusable region
    if (addr < 0xff80) return this.io[addr - 0xff00];
    if (addr < 0xffff) return this.hram[addr - 0xff80];
    return this.ie;
  }

  write8(addr: number, value: number): void {
    addr &= 0xffff;
    value &= 0xff;
    if (addr < 0x8000) return this.cart.writeRom(addr, value);
    if (addr < 0xa000) { this.vram[addr - 0x8000] = value; return; }
    if (addr < 0xc000) return this.cart.writeRam(addr - 0xa000, value);
    if (addr < 0xe000) { this.wram[addr - 0xc000] = value; return; }
    if (addr < 0xfe00) { this.wram[addr - 0xe000] = value; return; }
    if (addr < 0xfea0) { this.oam[addr - 0xfe00] = value; return; }
    if (addr < 0xff00) return; // unusable
    if (addr < 0xff80) {
      // Serial: SB = FF01, SC = FF02. Writing 0x81 to SC "sends" SB.
      if (addr === 0xff02 && value === 0x81 && this.onSerial) {
        this.onSerial(this.io[0x01]);
      }
      this.io[addr - 0xff00] = value;
      return;
    }
    if (addr < 0xffff) { this.hram[addr - 0xff80] = value; return; }
    this.ie = value;
  }

  read16(addr: number): number {
    return this.read8(addr) | (this.read8(addr + 1) << 8);
  }

  write16(addr: number, value: number): void {
    this.write8(addr, value & 0xff);
    this.write8(addr + 1, value >>> 8);
  }
}
