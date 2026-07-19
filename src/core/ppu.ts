/**
 * DMG PPU — scanline renderer (roadmap step 4).
 *
 * Timing: 456 dots per line, 154 lines (144 visible + 10 VBlank), giving the
 * 70224-cycle frame. Within a visible line: mode 2 (OAM scan, dots 0-79),
 * mode 3 (transfer, 80-251), mode 0 (HBlank). A whole scanline is rendered at
 * the 3->0 transition from that instant's register state — per-line raster
 * effects work; mid-line effects and the pixel FIFO are out of scope, as is
 * VRAM/OAM locking during modes 2/3.
 */

// Classic DMG green shades as little-endian RGBA (ABGR words).
const PALETTE = new Uint32Array([0xffd0f8e0, 0xff70c088, 0xff566834, 0xff201808]);

const enum Irq { VBlank = 0, Stat = 1 }

export class PPU {
  readonly vram = new Uint8Array(0x2000);
  readonly oam = new Uint8Array(0xa0);
  readonly framebuffer = new Uint32Array(160 * 144);
  /** Increments when a frame completes (VBlank starts). */
  frame = 0;
  /** Wired to Bus.requestInterrupt by the GameBoy assembly. */
  requestInterrupt: (bit: number) => void = () => {};

  // Registers (post-boot-ROM DMG state)
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

  private dot = 0;
  private mode = 0;
  private winLine = 0; // window's internal line counter
  private lineColor = new Uint8Array(160); // per-pixel BG color index, for OBJ priority

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
          this.framebuffer.fill(PALETTE[0]);
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
    }
  }

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

    if (this.lcdc & 0x01) {
      this.renderBackground(y);
      if (this.lcdc & 0x20 && y >= this.wy && this.wx < 167) {
        this.renderWindow();
        this.winLine++;
      }
      for (let x = 0; x < 160; x++) {
        this.framebuffer[row + x] = PALETTE[(this.bgp >> (this.lineColor[x] << 1)) & 3];
      }
    } else {
      this.framebuffer.fill(PALETTE[0], row, row + 160);
    }

    if (this.lcdc & 0x02) this.renderSprites(y);
  }

  /** Fetch one BG/window tile row's color index. */
  private tilePixel(tileIdx: number, px: number, py: number): number {
    const base = this.lcdc & 0x10
      ? tileIdx << 4                                // 0x8000 unsigned
      : 0x1000 + (((tileIdx << 24) >> 24) << 4);    // 0x8800 signed
    const lo = this.vram[base + (py << 1)];
    const hi = this.vram[base + (py << 1) + 1];
    const bit = 7 - px;
    return (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
  }

  private renderBackground(y: number): void {
    const map = this.lcdc & 0x08 ? 0x1c00 : 0x1800;
    const yy = (y + this.scy) & 0xff;
    const mapRow = map + (yy >> 3) * 32;
    for (let x = 0; x < 160; x++) {
      const xx = (x + this.scx) & 0xff;
      this.lineColor[x] = this.tilePixel(this.vram[mapRow + (xx >> 3)], xx & 7, yy & 7);
    }
  }

  private renderWindow(): void {
    const map = this.lcdc & 0x40 ? 0x1c00 : 0x1800;
    const wy = this.winLine;
    const mapRow = map + (wy >> 3) * 32;
    const startX = Math.max(0, this.wx - 7);
    for (let x = startX; x < 160; x++) {
      const wx = x - (this.wx - 7);
      this.lineColor[x] = this.tilePixel(this.vram[mapRow + (wx >> 3)], wx & 7, wy & 7);
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
    // DMG priority: lower X wins, then lower OAM index. Draw back-to-front.
    found.sort((a, b) => this.oam[a * 4 + 1] - this.oam[b * 4 + 1] || a - b);

    for (let k = found.length - 1; k >= 0; k--) {
      const i = found[k] * 4;
      const sy = this.oam[i] - 16;
      const sx = this.oam[i + 1] - 8;
      const attr = this.oam[i + 3];
      let line = y - sy;
      if (attr & 0x40) line = h - 1 - line; // Y flip
      let tile = this.oam[i + 2];
      if (h === 16) tile = (tile & 0xfe) + (line >= 8 ? 1 : 0);
      const lo = this.vram[(tile << 4) + ((line & 7) << 1)];
      const hi = this.vram[(tile << 4) + ((line & 7) << 1) + 1];
      const pal = attr & 0x10 ? this.obp1 : this.obp0;

      for (let px = 0; px < 8; px++) {
        const x = sx + px;
        if (x < 0 || x >= 160) continue;
        const bit = attr & 0x20 ? px : 7 - px; // X flip
        const ci = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        if (ci === 0) continue; // color 0 is transparent
        if (attr & 0x80 && this.lineColor[x] !== 0) continue; // behind BG 1-3
        this.framebuffer[row + x] = PALETTE[(pal >> (ci << 1)) & 3];
      }
    }
  }
}
