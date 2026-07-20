/**
 * PPU — scanline renderer. DMG (step 4) plus Game Boy Color (step 8).
 *
 * Timing: 456 dots per line, 154 lines (144 visible + 10 VBlank), giving the
 * 70224-cycle frame. Within a visible line: mode 2 (OAM scan, dots 0-79),
 * mode 3 (transfer, 80-251), mode 0 (HBlank). A whole scanline is rendered at
 * the 3->0 transition from that instant's register state — per-line raster
 * effects work; mid-line effects and the pixel FIFO are out of scope, as is
 * VRAM/OAM locking during modes 2/3.
 *
 * CGB additions: two VRAM banks (VBK), the BG attribute map in bank 1
 * (palette, tile bank, flips, priority), 8+8 palettes of 15-bit color
 * (BCPS/BCPD, OCPS/OCPD), OAM-index sprite priority, LCDC.0 as master
 * priority, and an HBlank callback for HDMA.
 */

// Classic DMG green shades as little-endian RGBA (ABGR words).
const PALETTE = new Uint32Array([0xffd0f8e0, 0xff70c088, 0xff566834, 0xff201808]);

const enum Irq { VBlank = 0, Stat = 1 }

export class PPU {
  /** Set by the GameBoy assembly before the machine runs. */
  cgb = false;
  readonly vram = new Uint8Array(0x4000); // 2 banks of 8 KiB; bank 1 unused on DMG
  readonly oam = new Uint8Array(0xa0);
  readonly framebuffer = new Uint32Array(160 * 144);
  /** Increments when a frame completes (VBlank starts). */
  frame = 0;
  /** Wired to Bus.requestInterrupt by the GameBoy assembly. */
  requestInterrupt: (bit: number) => void = () => {};
  /** Fires at each visible-line HBlank (CGB HDMA hook). */
  onHblank: () => void = () => {};

  // Registers (post-boot-ROM state)
  private lcdc = 0x91;
  private stat = 0;
  private scy = 0;
  private scx = 0;
  private ly = 0;
  private lyc = 0;
  private bgp = 0xfc;
  private obp0 = 0xff;
  private obp1 = 0xff;
  private wy = 0;
  private wx = 0;
  private vbk = 0;

  // CGB palette RAM + resolved-color caches (8 palettes x 4 colors each)
  private bgPalRam = new Uint8Array(64);
  private objPalRam = new Uint8Array(64);
  private bcps = 0;
  private ocps = 0;
  private bgColors = new Uint32Array(32).fill(0xffffffff);
  private objColors = new Uint32Array(32).fill(0xffffffff);

  private dot = 0;
  private mode = 0;
  private winLine = 0; // window's internal line counter
  private lineColor = new Uint8Array(160); // per-pixel BG color index, for OBJ priority
  private linePrio = new Uint8Array(160);  // CGB: BG attribute bit 7 per pixel
  private lineRgb = new Uint32Array(160);  // CGB: resolved BG pixel colors

  // ---- VRAM banking (bus delegates here) ---------------------------------

  readVram(off: number): number {
    return this.vram[(this.vbk << 13) | off];
  }

  writeVram(off: number, v: number): void {
    this.vram[(this.vbk << 13) | off] = v;
  }

  // ---- registers ---------------------------------------------------------

  readReg(addr: number): number {
    switch (addr) {
      case 0xff40: return this.lcdc;
      case 0xff41: return 0x80 | (this.stat & 0x78) | (this.ly === this.lyc ? 4 : 0) | this.mode;
      case 0xff42: return this.scy;
      case 0xff43: return this.scx;
      case 0xff44: return this.ly;
      case 0xff45: return this.lyc;
      case 0xff47: return this.bgp;
      case 0xff48: return this.obp0;
      case 0xff49: return this.obp1;
      case 0xff4a: return this.wy;
      case 0xff4b: return this.wx;
      case 0xff4f: return 0xfe | this.vbk;
      case 0xff68: return 0x40 | this.bcps;
      case 0xff69: return this.bgPalRam[this.bcps & 0x3f];
      case 0xff6a: return 0x40 | this.ocps;
      case 0xff6b: return this.objPalRam[this.ocps & 0x3f];
      default: return 0xff;
    }
  }

  writeReg(addr: number, v: number): void {
    switch (addr) {
      case 0xff40: {
        const wasOn = (this.lcdc & 0x80) !== 0;
        this.lcdc = v;
        if (wasOn && !(v & 0x80)) { // LCD off: counters reset, screen blank
          this.ly = 0;
          this.dot = 0;
          this.mode = 0;
          this.framebuffer.fill(this.cgb ? 0xffffffff : PALETTE[0]);
        }
        break;
      }
      case 0xff41: this.stat = (this.stat & 0x07) | (v & 0x78); break;
      case 0xff42: this.scy = v; break;
      case 0xff43: this.scx = v; break;
      case 0xff44: break; // LY is read-only
      case 0xff45: this.lyc = v; break;
      case 0xff47: this.bgp = v; break;
      case 0xff48: this.obp0 = v; break;
      case 0xff49: this.obp1 = v; break;
      case 0xff4a: this.wy = v; break;
      case 0xff4b: this.wx = v; break;
      case 0xff4f: this.vbk = v & 1; break;
      case 0xff68: this.bcps = v & 0xbf; break;
      case 0xff69: {
        const i = this.bcps & 0x3f;
        this.bgPalRam[i] = v;
        this.refreshColor(this.bgPalRam, this.bgColors, i);
        if (this.bcps & 0x80) this.bcps = 0x80 | ((i + 1) & 0x3f);
        break;
      }
      case 0xff6a: this.ocps = v & 0xbf; break;
      case 0xff6b: {
        const i = this.ocps & 0x3f;
        this.objPalRam[i] = v;
        this.refreshColor(this.objPalRam, this.objColors, i);
        if (this.ocps & 0x80) this.ocps = 0x80 | ((i + 1) & 0x3f);
        break;
      }
    }
  }

  /** 15-bit BGR555 -> 32-bit RGBA, expanding 5-bit channels as (v<<3)|(v>>2). */
  private refreshColor(ram: Uint8Array, cache: Uint32Array, byteIdx: number): void {
    const i = byteIdx & ~1;
    const word = ram[i] | (ram[i + 1] << 8);
    const r = word & 31;
    const g = (word >> 5) & 31;
    const b = (word >> 10) & 31;
    cache[i >> 1] = 0xff000000 |
      (((b << 3) | (b >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((r << 3) | (r >> 2));
  }

  // ---- clock -------------------------------------------------------------

  step(cycles: number): void {
    if (!(this.lcdc & 0x80)) return;

    this.dot += cycles;
    while (this.dot >= 456) {
      this.dot -= 456;
      this.ly++;
      if (this.ly === 154) {
        this.ly = 0;
        this.winLine = 0;
      }
      if (this.ly === this.lyc && this.stat & 0x40) this.requestInterrupt(Irq.Stat);
    }

    const mode = this.ly >= 144 ? 1 : this.dot < 80 ? 2 : this.dot < 252 ? 3 : 0;
    if (mode === this.mode) return;
    this.mode = mode;
    switch (mode) {
      case 0:
        this.renderLine();
        if (this.stat & 0x08) this.requestInterrupt(Irq.Stat);
        this.onHblank();
        break;
      case 1:
        this.frame++;
        this.requestInterrupt(Irq.VBlank);
        if (this.stat & 0x10) this.requestInterrupt(Irq.Stat);
        break;
      case 2:
        if (this.stat & 0x20) this.requestInterrupt(Irq.Stat);
        break;
    }
  }

  // ---- scanline rendering ------------------------------------------------

  private renderLine(): void {
    const y = this.ly;
    const row = y * 160;
    this.lineColor.fill(0);
    if (this.cgb) this.linePrio.fill(0);

    // DMG: LCDC.0 turns the BG off. CGB: the BG always renders and LCDC.0
    // becomes the master priority bit (handled in renderSprites).
    if (this.cgb || this.lcdc & 0x01) {
      this.renderBackground(y);
      if (this.lcdc & 0x20 && y >= this.wy && this.wx < 167) {
        this.renderWindow();
        this.winLine++;
      }
      if (this.cgb) {
        for (let x = 0; x < 160; x++) this.framebuffer[row + x] = this.lineRgb[x];
      } else {
        for (let x = 0; x < 160; x++) {
          this.framebuffer[row + x] = PALETTE[(this.bgp >> (this.lineColor[x] << 1)) & 3];
        }
      }
    } else {
      this.framebuffer.fill(PALETTE[0], row, row + 160);
    }

    if (this.lcdc & 0x02) this.renderSprites(y);
  }

  /** Fetch one tile row pixel's color index from the given VRAM bank offset. */
  private tileColor(tileIdx: number, px: number, py: number, bank: number): number {
    const base = bank + (this.lcdc & 0x10
      ? tileIdx << 4                                // 0x8000 unsigned
      : 0x1000 + (((tileIdx << 24) >> 24) << 4));   // 0x8800 signed
    const lo = this.vram[base + (py << 1)];
    const hi = this.vram[base + (py << 1) + 1];
    const bit = 7 - px;
    return (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
  }

  /** Resolve one BG/window pixel; mi is the VRAM index of the tile-map byte. */
  private bgPixel(mi: number, px: number, py: number, x: number): void {
    const tileIdx = this.vram[mi];
    if (this.cgb) {
      const attr = this.vram[0x2000 + mi]; // attribute map lives in bank 1
      if (attr & 0x20) px = 7 - px;
      if (attr & 0x40) py = 7 - py;
      const ci = this.tileColor(tileIdx, px, py, attr & 0x08 ? 0x2000 : 0);
      this.lineColor[x] = ci;
      this.linePrio[x] = attr & 0x80;
      this.lineRgb[x] = this.bgColors[((attr & 7) << 2) | ci];
    } else {
      this.lineColor[x] = this.tileColor(tileIdx, px, py, 0);
    }
  }

  private renderBackground(y: number): void {
    const map = this.lcdc & 0x08 ? 0x1c00 : 0x1800;
    const yy = (y + this.scy) & 0xff;
    const mapRow = map + (yy >> 3) * 32;
    for (let x = 0; x < 160; x++) {
      const xx = (x + this.scx) & 0xff;
      this.bgPixel(mapRow + (xx >> 3), xx & 7, yy & 7, x);
    }
  }

  private renderWindow(): void {
    const map = this.lcdc & 0x40 ? 0x1c00 : 0x1800;
    const wy = this.winLine;
    const mapRow = map + (wy >> 3) * 32;
    const startX = Math.max(0, this.wx - 7);
    for (let x = startX; x < 160; x++) {
      const wx = x - (this.wx - 7);
      this.bgPixel(mapRow + (wx >> 3), wx & 7, wy & 7, x);
    }
  }

  private renderSprites(y: number): void {
    const h = this.lcdc & 0x04 ? 16 : 8;
    const row = y * 160;

    // OAM scan: first 10 sprites covering this line, in OAM order
    const found: number[] = [];
    for (let i = 0; i < 40 && found.length < 10; i++) {
      const sy = this.oam[i * 4] - 16;
      if (y >= sy && y < sy + h) found.push(i);
    }
    // DMG priority: lower X wins, then lower OAM index. CGB: OAM index only.
    if (!this.cgb) {
      found.sort((a, b) => this.oam[a * 4 + 1] - this.oam[b * 4 + 1] || a - b);
    }
    // CGB master priority: LCDC.0 clear puts every sprite above the BG.
    const masterOff = this.cgb && !(this.lcdc & 0x01);

    for (let k = found.length - 1; k >= 0; k--) {
      const i = found[k] * 4;
      const sy = this.oam[i] - 16;
      const sx = this.oam[i + 1] - 8;
      const attr = this.oam[i + 3];
      let line = y - sy;
      if (attr & 0x40) line = h - 1 - line; // Y flip
      let tile = this.oam[i + 2];
      if (h === 16) tile = (tile & 0xfe) + (line >= 8 ? 1 : 0);
      const bank = this.cgb && attr & 0x08 ? 0x2000 : 0;
      const lo = this.vram[bank + (tile << 4) + ((line & 7) << 1)];
      const hi = this.vram[bank + (tile << 4) + ((line & 7) << 1) + 1];
      const pal = attr & 0x10 ? this.obp1 : this.obp0;

      for (let px = 0; px < 8; px++) {
        const x = sx + px;
        if (x < 0 || x >= 160) continue;
        const bit = attr & 0x20 ? px : 7 - px; // X flip
        const ci = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        if (ci === 0) continue; // color 0 is transparent
        if (!masterOff && this.lineColor[x] !== 0) {
          if (this.cgb && this.linePrio[x]) continue; // BG attribute priority
          if (attr & 0x80) continue;                  // OBJ behind BG 1-3
        }
        this.framebuffer[row + x] = this.cgb
          ? this.objColors[((attr & 7) << 2) | ci]
          : PALETTE[(pal >> (ci << 1)) & 3];
      }
    }
  }
}
