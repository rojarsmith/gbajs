import type { APU } from "./apu";
import type { Cartridge } from "./cartridge";
import type { Joypad } from "./joypad";
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
  private joypad: Joypad;
  private apu: APU;
  private readonly cgb: boolean;
  private wram = new Uint8Array(0x8000); // CGB: 8 banks; DMG uses the first 2
  private svbk = 1;                      // CGB WRAM bank (FF70)
  private io = new Uint8Array(0x80);
  private hram = new Uint8Array(0x7f);
  private ie = 0;

  // CGB double speed (KEY1) — read by the GameBoy assembly's clock scaling
  doubleSpeed = false;
  private speedPrep = false;

  // CGB HDMA/GDMA (FF51-FF55)
  private dmaSrc = 0;
  private dmaDst = 0;
  private hdmaBlocks = 0;
  private hdmaActive = false;

  /** Blargg's test ROMs print results via the serial port — capture them. */
  onSerial: ((byte: number) => void) | null = null;

  constructor(cart: Cartridge, timer: Timer, ppu: PPU, joypad: Joypad, apu: APU, cgb: boolean) {
    this.cart = cart;
    this.timer = timer;
    this.ppu = ppu;
    this.joypad = joypad;
    this.apu = apu;
    this.cgb = cgb;
  }

  /** C000-DFFF (and echo) with CGB WRAM banking; D000-DFFF is switchable. */
  private wramIndex(addr: number): number {
    return addr < 0xd000 ? addr - 0xc000 : (this.svbk << 12) + (addr - 0xd000);
  }

  /** STOP executes this: toggles CGB double speed if prepared (KEY1). */
  speedSwitch(): void {
    if (!this.cgb || !this.speedPrep) return;
    this.doubleSpeed = !this.doubleSpeed;
    this.speedPrep = false;
  }

  /** Set an IF bit (0=VBlank, 1=STAT, 2=Timer, 3=Serial, 4=Joypad). */
  requestInterrupt(bit: number): void {
    this.io[0x0f] |= 1 << bit;
  }

  read8(addr: number): number {
    addr &= 0xffff;
    if (addr < 0x8000) return this.cart.readRom(addr);
    if (addr < 0xa000) return this.ppu.readVram(addr - 0x8000);
    if (addr < 0xc000) return this.cart.readRam(addr - 0xa000);
    if (addr < 0xe000) return this.wram[this.wramIndex(addr)];
    if (addr < 0xfe00) return this.wram[this.wramIndex(addr - 0x2000)]; // echo RAM
    if (addr < 0xfea0) return this.ppu.oam[addr - 0xfe00];
    if (addr < 0xff00) return 0xff; // unusable region
    if (addr === 0xff00) return this.joypad.read();
    if (addr >= 0xff04 && addr <= 0xff07) return this.timer.readReg(addr);
    if (addr === 0xff0f) return this.io[0x0f] | 0xe0; // IF upper bits read as 1
    if (addr >= 0xff10 && addr <= 0xff3f) return this.apu.readReg(addr);
    if (addr >= 0xff40 && addr <= 0xff4b && addr !== 0xff46) return this.ppu.readReg(addr);
    if (this.cgb) {
      if (addr === 0xff4d) return (this.doubleSpeed ? 0x80 : 0) | 0x7e | (this.speedPrep ? 1 : 0);
      if (addr === 0xff4f || (addr >= 0xff68 && addr <= 0xff6b)) return this.ppu.readReg(addr);
      if (addr === 0xff55) return this.hdmaActive ? (this.hdmaBlocks - 1) & 0x7f : 0xff;
      if (addr === 0xff70) return 0xf8 | this.svbk;
    }
    if (addr < 0xff80) return this.io[addr - 0xff00];
    if (addr < 0xffff) return this.hram[addr - 0xff80];
    return this.ie;
  }

  write8(addr: number, value: number): void {
    addr &= 0xffff;
    value &= 0xff;
    if (addr < 0x8000) return this.cart.writeRom(addr, value);
    if (addr < 0xa000) return this.ppu.writeVram(addr - 0x8000, value);
    if (addr < 0xc000) return this.cart.writeRam(addr - 0xa000, value);
    if (addr < 0xe000) { this.wram[this.wramIndex(addr)] = value; return; }
    if (addr < 0xfe00) { this.wram[this.wramIndex(addr - 0x2000)] = value; return; }
    if (addr < 0xfea0) { this.ppu.oam[addr - 0xfe00] = value; return; }
    if (addr < 0xff00) return; // unusable
    if (addr < 0xff80) {
      if (addr === 0xff00) return this.joypad.write(value);
      if (addr >= 0xff04 && addr <= 0xff07) return this.timer.writeReg(addr, value);
      // Serial: SB = FF01, SC = FF02. Writing 0x81 to SC "sends" SB.
      if (addr === 0xff02 && value === 0x81 && this.onSerial) {
        this.onSerial(this.io[0x01]);
      }
      if (addr >= 0xff10 && addr <= 0xff3f) return this.apu.writeReg(addr, value);
      if (this.cgb) {
        if (addr === 0xff4d) { this.speedPrep = (value & 1) !== 0; return; }
        if (addr === 0xff4f || (addr >= 0xff68 && addr <= 0xff6b)) {
          return this.ppu.writeReg(addr, value);
        }
        if (addr === 0xff51) { this.dmaSrc = (this.dmaSrc & 0x00f0) | (value << 8); return; }
        if (addr === 0xff52) { this.dmaSrc = (this.dmaSrc & 0xff00) | (value & 0xf0); return; }
        if (addr === 0xff53) { this.dmaDst = (this.dmaDst & 0x00f0) | ((value & 0x1f) << 8); return; }
        if (addr === 0xff54) { this.dmaDst = (this.dmaDst & 0x1f00) | (value & 0xf0); return; }
        if (addr === 0xff55) return this.startHdma(value);
        if (addr === 0xff70) { this.svbk = value & 7 || 1; return; }
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

  // ---- CGB HDMA (VRAM DMA) ----------------------------------------------

  /** FF55 write: bit 7 set = HBlank DMA (16 bytes/HBlank), clear = instant GDMA. */
  private startHdma(v: number): void {
    if (this.hdmaActive && !(v & 0x80)) { // writing with bit 7 clear cancels
      this.hdmaActive = false;
      return;
    }
    const blocks = (v & 0x7f) + 1;
    if (v & 0x80) {
      this.hdmaActive = true;
      this.hdmaBlocks = blocks;
    } else {
      for (let b = 0; b < blocks; b++) this.hdmaCopyBlock();
    }
  }

  private hdmaCopyBlock(): void {
    for (let i = 0; i < 16; i++) {
      this.ppu.writeVram((this.dmaDst + i) & 0x1fff, this.read8(this.dmaSrc + i));
    }
    this.dmaSrc = (this.dmaSrc + 16) & 0xffff;
    this.dmaDst = (this.dmaDst + 16) & 0x1fff;
  }

  /** Wired to the PPU's HBlank callback by the GameBoy assembly. */
  hdmaHblank(): void {
    if (!this.hdmaActive) return;
    this.hdmaCopyBlock();
    if (--this.hdmaBlocks === 0) this.hdmaActive = false;
  }

  read16(addr: number): number {
    return this.read8(addr) | (this.read8(addr + 1) << 8);
  }

  write16(addr: number, value: number): void {
    this.write8(addr, value & 0xff);
    this.write8(addr + 1, value >>> 8);
  }
}
