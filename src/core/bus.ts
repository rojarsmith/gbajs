import type { Cartridge } from "./cartridge";
import type { PPU } from "./ppu";
import type { Timer } from "./timer";

/**
 * The 16-bit memory bus. Every CPU memory access dispatches through here.
 * PPU/APU/timer registers are a flat I/O byte array for now; they gain real
 * behavior as each component is implemented.
 */
export class Bus {
  private cart: Cartridge;
  private timer: Timer;
  private ppu: PPU;
  private wram = new Uint8Array(0x2000);
  private io = new Uint8Array(0x80);
  private hram = new Uint8Array(0x7f);
  private ie = 0;

  /** Blargg's test ROMs print results via the serial port — capture them. */
  onSerial: ((byte: number) => void) | null = null;

  constructor(cart: Cartridge, timer: Timer, ppu: PPU) {
    this.cart = cart;
    this.timer = timer;
    this.ppu = ppu;
  }

  /** Set an IF bit (0=VBlank, 1=STAT, 2=Timer, 3=Serial, 4=Joypad). */
  requestInterrupt(bit: number): void {
    this.io[0x0f] |= 1 << bit;
  }

  read8(addr: number): number {
    addr &= 0xffff;
    if (addr < 0x8000) return this.cart.readRom(addr);
    if (addr < 0xa000) return this.ppu.vram[addr - 0x8000];
    if (addr < 0xc000) return this.cart.readRam(addr - 0xa000);
    if (addr < 0xe000) return this.wram[addr - 0xc000];
    if (addr < 0xfe00) return this.wram[addr - 0xe000]; // echo RAM
    if (addr < 0xfea0) return this.ppu.oam[addr - 0xfe00];
    if (addr < 0xff00) return 0xff; // unusable region
    if (addr === 0xff00) return 0xc0 | (this.io[0] & 0x30) | 0x0f; // joypad: none pressed (step 5)
    if (addr >= 0xff04 && addr <= 0xff07) return this.timer.readReg(addr);
    if (addr === 0xff0f) return this.io[0x0f] | 0xe0; // IF upper bits read as 1
    if (addr >= 0xff40 && addr <= 0xff4b && addr !== 0xff46) return this.ppu.readReg(addr);
    if (addr < 0xff80) return this.io[addr - 0xff00];
    if (addr < 0xffff) return this.hram[addr - 0xff80];
    return this.ie;
  }

  write8(addr: number, value: number): void {
    addr &= 0xffff;
    value &= 0xff;
    if (addr < 0x8000) return this.cart.writeRom(addr, value);
    if (addr < 0xa000) { this.ppu.vram[addr - 0x8000] = value; return; }
    if (addr < 0xc000) return this.cart.writeRam(addr - 0xa000, value);
    if (addr < 0xe000) { this.wram[addr - 0xc000] = value; return; }
    if (addr < 0xfe00) { this.wram[addr - 0xe000] = value; return; }
    if (addr < 0xfea0) { this.ppu.oam[addr - 0xfe00] = value; return; }
    if (addr < 0xff00) return; // unusable
    if (addr < 0xff80) {
      if (addr >= 0xff04 && addr <= 0xff07) return this.timer.writeReg(addr, value);
      // Serial: SB = FF01, SC = FF02. Writing 0x81 to SC "sends" SB.
      if (addr === 0xff02 && value === 0x81 && this.onSerial) {
        this.onSerial(this.io[0x01]);
      }
      if (addr === 0xff46) { // OAM DMA: copy 160 bytes from value<<8 (instant)
        const src = value << 8;
        for (let i = 0; i < 0xa0; i++) this.ppu.oam[i] = this.read8(src + i);
      } else if (addr >= 0xff40 && addr <= 0xff4b) {
        return this.ppu.writeReg(addr, value);
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
