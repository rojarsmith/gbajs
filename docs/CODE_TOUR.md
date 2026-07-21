# gbajs Code Tour — How This Emulator Works, File by File

**English** | [繁體中文](./CODE_TOUR.zh-TW.md)

This is a guided tour of the actual source code for software engineers who want to
understand — and ultimately reproduce by hand — a working Game Boy emulator. It pairs
with the [from-scratch guide](../README.md) (theory and roadmap); this document is the
practice: what the code does, *why* it is shaped this way, and which algorithms carry
the weight. Every excerpt below is real code from this repository.

**Recommended reading order** (same as the dependency order, and the order it was built):

```text
1. src/core/cartridge.ts   ROM parsing + bank switching   (~200 lines)
2. src/core/bus.ts         the memory map                 (~160 lines)
3. src/core/cpu.ts         the SM83 interpreter           (~450 lines)
4. src/core/timer.ts       the simplest clocked device    (~80 lines)
5. src/core/ppu.ts         scanline rendering + CGB       (~340 lines)
6. src/core/joypad.ts      the smallest component         (~50 lines)
7. src/core/apu.ts         sound synthesis                (~450 lines)
8. src/core/gb.ts          the 30-line machine assembly
9. src/frontend/*          browser integration
```

---

## 0. The one idea everything hangs on

A console is several chips sharing one clock. The whole architecture of this emulator
is that sentence made executable — [gb.ts](../src/core/gb.ts) *is* the design:

```ts
step(): number {
  const cycles = this.cpu.step();
  this.timer.step(cycles); // the timer follows the CPU clock
  const vc = this.bus.doubleSpeed ? cycles >> 1 : cycles;
  this.ppu.step(vc);
  this.apu.step(vc);
  return vc;
}
```

Cycles (T-cycles, 4,194,304 per second) are the *currency*. Every component's `step()`
takes elapsed cycles and updates internal state. No component ever looks at a wall
clock; determinism falls out for free, which is what makes the whole test strategy
(§9) possible.

The `vc` line is the Game Boy Color's **double-speed mode** expressed in one branch:
when the game flips KEY1 (via `STOP`), the CPU and timer run twice as fast, but video
and audio keep real-world timing — so the PPU/APU (and frame pacing, which uses the
returned value) simply receive *half the CPU's cycle count*. Two clock domains, one
divide.

Note the decoupling trick used throughout: components never hold references to each
other. When the timer needs to raise an interrupt, it calls a callback the assembly
wired up:

```ts
this.timer.requestInterrupt = () => this.bus.requestInterrupt(2);
this.ppu.requestInterrupt = bit => this.bus.requestInterrupt(bit);
```

If you write your own emulator: get this skeleton standing first, with stub
components. Everything else is filling in boxes.

---

## 1. Cartridge — [cartridge.ts](../src/core/cartridge.ts)

### Header parsing

Bytes `0x100-0x14F` of every ROM describe the cartridge. The interesting technique is
the header checksum — an exact reimplementation of what the boot ROM computes:

```ts
let sum = 0;
for (let i = 0x134; i <= 0x14c; i++) {
  sum = (sum - rom[i] - 1) & 0xff;
}
```

### Bank switching — the key algorithm

The GB's address space only exposes 32 KiB of ROM. Bigger carts put a *Memory Bank
Controller* between the bus and the ROM chip; **writing to ROM addresses** (which would
otherwise be meaningless) programs its registers. The whole trick is address
composition:

```ts
readRom(addr: number): number {
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
```

Three things to internalize:

- **The bank number is assembled from register pieces.** MBC1's 5-bit `romBank` plus a
  2-bit `bank2` gives 7 bits; MBC5 splits its 9-bit bank across two registers.
- **`& romBankMask` is the wrap rule.** ROM sizes are powers of two, so masking with
  `(size >> 14) - 1` reproduces the hardware behavior of unconnected address lines —
  writing bank 0x42 on a 4-bank cart selects bank 2. Mooneye's `rom_*` tests exist
  precisely to check this.
- **`(bank << 14) | (addr & 0x3fff)`** — banks are 16 KiB, so bank number and offset
  concatenate into a flat index. No lookup tables needed.

The same wrap idea handles RAM smaller than addressed (`% this.ram.length` mirrors it),
and MBC1's `mode` bit decides whether `bank2` remaps `0000-3FFF`/RAM or extends ROM
banking — the code reads directly as the Pan Docs description.

**Exercise:** add MBC2 (512×4-bit internal RAM, bank register overlapping the RAM
enable). The mooneye `emulator-only/mbc2` tests will grade you.

---

## 2. Bus — [bus.ts](../src/core/bus.ts)

Every memory access in the machine funnels through two functions. The design rule:
`read8`/`write8` are a **chain of range checks ordered by address**, with each region
backed by a `Uint8Array` or delegated to the owning component:

```ts
read8(addr: number): number {
  addr &= 0xffff;
  if (addr < 0x8000) return this.cart.readRom(addr);
  if (addr < 0xa000) return this.ppu.vram[addr - 0x8000];
  if (addr < 0xc000) return this.cart.readRam(addr - 0xa000);
  if (addr < 0xe000) return this.wram[addr - 0xc000];
  if (addr < 0xfe00) return this.wram[addr - 0xe000]; // echo RAM
  ...
}
```

Why one function instead of per-component memory maps? Because *hardware quirks live at
the boundaries*: echo RAM is a wiring artifact, reads of unmapped `FEA0-FEFF` return
`0xFF`, `IF`'s top three bits read as 1. One dispatch point means one place for all of
them.

I/O (`FF00-FF7F`) is where reads/writes stop being storage and become *behavior* —
`LY` returns the PPU's live scanline, and this single line is a complete DMA engine:

```ts
if (addr === 0xff46) { // OAM DMA: copy 160 bytes from value<<8
  const src = value << 8;
  for (let i = 0; i < 0xa0; i++) this.ppu.oam[i] = this.read8(src + i);
}
```

(Real DMA takes 160 M-cycles during which the CPU can only touch HRAM; the instant
version is accurate *enough* until you chase Mooneye's OAM DMA tests.)

### CGB additions

Color hardware widens the bus without changing its shape. Every CGB feature is gated
behind one flag so DMG cartridges see the old bus *exactly*:

- **WRAM banking** (`SVBK`): `C000-CFFF` is fixed, `D000-DFFF` switches among 7 banks —
  one index function serves reads, writes, and echo RAM:

  ```ts
  private wramIndex(addr: number): number {
    return addr < 0xd000 ? addr - 0xc000 : (this.svbk << 12) + (addr - 0xd000);
  }
  ```

- **VRAM banking** (`VBK`): the bus delegates to `ppu.readVram`/`writeVram`, which
  apply `(vbk << 13) | offset` — the PPU owns both banks because rendering needs them
  simultaneously (tiles in bank 0/1, attributes always in bank 1).
- **KEY1 + `speedSwitch()`**: a prepare bit and a toggle that `STOP` executes.
- **HDMA/GDMA** (`FF51-FF55`): general DMA copies all blocks instantly; HBlank DMA
  copies 16 bytes per scanline through a PPU callback — the same decoupling pattern as
  interrupts:

  ```ts
  hdmaHblank(): void {
    if (!this.hdmaActive) return;
    this.hdmaCopyBlock();
    if (--this.hdmaBlocks === 0) this.hdmaActive = false;
  }
  ```

---

## 3. CPU — [cpu.ts](../src/core/cpu.ts)

The largest file, but structurally simple: state + helpers + a 256-entry dispatch
table + a 256-entry CB table.

### The dispatch table, generated

The SM83 opcode map is famously regular, and the code exploits that: **most of the
table is filled by loops**, not written by hand. The whole 63-opcode `LD r, r'` block
is five lines:

```ts
for (let i = 0x40; i < 0x80; i++) {
  if (i === 0x76) continue; // that slot is HALT
  const dst = (i >> 3) & 7;
  const src = i & 7;
  OPS[i] = c => { R8_SET[dst](c, R8_GET[src](c)); return dst === 6 || src === 6 ? 8 : 4; };
}
```

The magic is the **register accessor tables** indexed 0-7 = `B C D E H L (HL) A`:

```ts
const R8_GET: ((c: CPU) => number)[] = [
  c => c.b, c => c.c, c => c.d, c => c.e, c => c.h, c => c.l,
  c => c.bus.read8(c.hl), c => c.a,   // index 6 is memory-at-HL!
];
```

Slot 6 being "memory at HL" instead of a register is exactly how the hardware encoding
works — by making it a first-class accessor, `INC (HL)` and `INC B` are the same
generated code. The ALU block (64 opcodes), all immediates (8), and the entire
CB-prefixed table (256) are generated the same way. Hand-written opcodes number only
a few dozen.

### Flag arithmetic — where all the bugs live

Cheat sheet from the code, worth memorizing:

```ts
// 8-bit add: half-carry = carry out of bit 3, computed on the NIBBLES
this.fl((r & 0xff) === 0, false, (this.a & 0xf) + (v & 0xf) + carry > 0xf, r > 0xff);
// 8-bit subtract: borrow versions of the same
this.fl((r & 0xff) === 0, true, (this.a & 0xf) - (v & 0xf) - borrow < 0, r < 0);
// ADD HL,rr: half-carry is out of bit 11, and Z is PRESERVED
this.f = (this.f & FZ) | ((hl & 0xfff) + (v & 0xfff) > 0xfff ? FH : 0) | (r > 0xffff ? FC : 0);
// ADD SP,e / LD HL,SP+e: signed operand, but flags from UNSIGNED low-byte math
this.fl(false, false, (this.sp & 0xf) + (raw & 0xf) > 0xf, (this.sp & 0xff) + (raw & 0xff) > 0xff);
```

And `DAA` — the single most-often-wrong instruction in GB emulators. Don't derive it;
transcribe it:

```ts
if (this.f & FN) {                       // after a subtraction
  if (this.f & FC) a = (a - 0x60) & 0xff;
  if (this.f & FH) a = (a - 0x06) & 0xff;
} else {                                 // after an addition
  if ((this.f & FC) || a > 0x99) { a = (a + 0x60) & 0xff; this.f |= FC; }
  if ((this.f & FH) || (a & 0xf) > 0x09) a = (a + 0x06) & 0xff;
}
```

### Interrupts, and the EI delay

Interrupt dispatch is bit arithmetic — lowest set bit = highest priority:

```ts
const bit = pending & -pending;          // isolate lowest set bit
const idx = 31 - Math.clz32(bit);        // bit index
this.pc = 0x40 + (idx << 3);             // vectors are 0x40,0x48,...
```

`EI` enables interrupts only *after the following instruction* — games rely on
`EI; RET` never being interrupted between the two. The implementation captures the
scheduled flag before executing, applies it after, and lets `DI` cancel it:

```ts
const willEnable = this.imeScheduled;
const cycles = handler(this);
if (willEnable && this.imeScheduled) { this.ime = true; this.imeScheduled = false; }
```

Two CGB touches live here too: the post-boot `A` register doubles as the hardware-type
signal games check (`0x01` DMG, `0x11` CGB), and `STOP` calls `bus.speedSwitch()` — the
KEY1 double-speed toggle.

**How you know the CPU is right:** Blargg's `cpu_instrs` checks every opcode's
semantics and `instr_timing` checks every cycle count. Until the PPU exists, results
arrive through the serial-port hook in the bus (§9). This emulator passed 11/11 and
`instr_timing` on first run after the timer landed — the payoff of transcribing flag
rules instead of improvising them.

---

## 4. Timer — [timer.ts](../src/core/timer.ts)

The timer teaches the pattern every clocked device uses: **convert "cycles elapsed"
into "events that happened" with integer math, not per-cycle loops.**

Hardware: one free-running 16-bit counter. `DIV` is its top byte; `TIMA` increments
whenever a TAC-selected bit of the counter goes 1→0, i.e. once per `2^(shift)` cycles.
So the number of increments in a step is a difference of quotients:

```ts
const old = this.counter;
const now = old + cycles;
this.counter = now & 0xffff;
const shift = SHIFTS[this.tac & 3];              // 10, 4, 6, 8
let tima = this.tima + ((now >> shift) - (old >> shift));
```

`(now >> shift) - (old >> shift)` counts exactly how many period boundaries the span
crossed — batchable to any step size, zero drift. The same quotient-difference idiom
reappears in the APU's frame sequencer and sampling.

---

## 5. PPU — [ppu.ts](../src/core/ppu.ts)

### The mode state machine

The PPU's timing skeleton is two lines of arithmetic on a dot counter:

```ts
this.dot += cycles;
while (this.dot >= 456) { this.dot -= 456; this.ly++; ... }     // next scanline
const mode = this.ly >= 144 ? 1 : this.dot < 80 ? 2 : this.dot < 252 ? 3 : 0;
```

Mode *transitions* (not states) trigger everything: entering mode 0 renders the
scanline, entering mode 1 fires VBlank and completes the frame, and each transition
raises its STAT interrupt if enabled. Rendering a **whole line at the 3→0 transition**
is the load-bearing decision: games change scroll/palette registers between lines
(raster effects), and per-line rendering honors that while staying ~100× cheaper than
per-pixel emulation. dmg-acid2 — which toggles LCDC bits per line via LYC interrupts —
passes pixel-perfect against this renderer.

### The tile fetch — bit-plane graphics in six lines

All GB graphics are 8×8 tiles, 2 bits per pixel, split across two *bit planes*:

```ts
private tilePixel(tileIdx: number, px: number, py: number): number {
  const base = this.lcdc & 0x10
    ? tileIdx << 4                                // 0x8000 region, unsigned index
    : 0x1000 + (((tileIdx << 24) >> 24) << 4);    // 0x8800 region, SIGNED index
  const lo = this.vram[base + (py << 1)];
  const hi = this.vram[base + (py << 1) + 1];
  const bit = 7 - px;
  return (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
}
```

Note `(tileIdx << 24) >> 24` — the standard JS idiom for sign-extending a byte, needed
because one of the two tile-addressing modes treats indices as signed. Background
scrolling is just `(x + scx) & 0xff` (the map wraps at 256 pixels), and the window is
the same fetch driven by its own **internal line counter** that only advances on lines
where the window was actually visible — the quirk dmg-acid2's "nose" checks.

### Sprite priority — sort, then paint backwards

```ts
// first 10 sprites covering this line, in OAM order
// DMG priority: lower X wins, then lower OAM index
found.sort((a, b) => this.oam[a*4+1] - this.oam[b*4+1] || a - b);
for (let k = found.length - 1; k >= 0; k--) { /* draw */ }
```

Drawing **back-to-front** makes the painter's algorithm resolve overlap: the
highest-priority sprite is drawn last, and transparent pixels (color 0) of a
high-priority sprite naturally let lower ones show through. Two more rules complete
it: the 10-per-line limit comes from the *scan*, not the draw; and the behind-BG flag
consults `lineColor[x]`, the BG color index the background pass recorded per pixel.

### CGB: attributes, palettes, and a new priority order

Color mode reuses the whole scanline machine and changes three things.

**Every BG tile gains an attribute byte** at the same map address in VRAM bank 1 —
palette, tile bank, flips, and a priority bit:

```ts
const attr = this.vram[0x2000 + mi]; // attribute map lives in bank 1
if (attr & 0x20) px = 7 - px;
if (attr & 0x40) py = 7 - py;
const ci = this.tileColor(tileIdx, px, py, attr & 0x08 ? 0x2000 : 0);
```

**Colors come from palette RAM**, written through an index/data register pair
(BCPS/BCPD) with auto-increment. Each 2-byte entry is BGR555; the cache converts to
RGBA on write, expanding 5-bit channels exactly as the acid-test spec requires:

```ts
cache[i >> 1] = 0xff000000 |
  (((b << 3) | (b >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((r << 3) | (r >> 2));
```

**Priority is re-wired**: sprites rank by OAM index alone (the DMG's lower-X rule is
gone — the code just skips the sort), the BG attribute's bit 7 can hold the background
above sprites per tile, and `LCDC.0` — the DMG's "background off" switch — becomes a
*master priority* override that puts every sprite on top. One acid test pins all of
this at once: **cgb-acid2, pixel-perfect (0/23,040)**.

---

## 6. Joypad — [joypad.ts](../src/core/joypad.ts)

Smallest component, one non-obvious idea: the buttons are a 2×4 **matrix**. The game
writes bits 4-5 to pick a row (0 = selected!), reads bits 0-3 for that row's columns
(0 = pressed!). Everything is active-low:

```ts
read(): number {
  let lines = 0x0f;
  if (!(this.select & 0x10)) lines &= ~this.pressed & 0x0f;        // d-pad row
  if (!(this.select & 0x20)) lines &= (~this.pressed >> 4) & 0x0f; // buttons row
  return 0xc0 | this.select | lines;
}
```

A war story worth knowing: before this existed, the I/O stub returned `0x00` for
`FF00` — which, active-low, means *every button held at once*. Games behave bizarrely
under that. If your emulator misboots early, check what your joypad stub returns.

---

## 7. APU — [apu.ts](../src/core/apu.ts)

The APU is three subsystems stacked: **synthesis** (what the channels output *right
now*), **modulation** (the frame sequencer changing volumes/frequencies over time),
and **sampling** (turning the 4 MHz signal into 48 kHz audio).

### Synthesis

Each channel is a period timer plus a position, batched with the same idiom as the
system timer:

```ts
c.timer -= cycles;
while (c.timer <= 0) {
  c.timer += (2048 - c.freq) << 2;   // square-wave period in T-cycles
  c.pos = (c.pos + 1) & 7;           // advance through the 8-step duty pattern
}
```

The noise channel replaces the duty pattern with a 15-bit LFSR — three lines that
produce everything from hi-hats to explosions:

```ts
const bit = (n.lfsr ^ (n.lfsr >> 1)) & 1;
n.lfsr = (n.lfsr >> 1) | (bit << 14);
if (n.width7) n.lfsr = (n.lfsr & ~0x40) | (bit << 6);   // short mode: metallic
```

### Modulation — the frame sequencer

A 512 Hz ticker (8192 cycles) whose step number selects what runs — length counters at
256 Hz, sweep at 128 Hz, envelopes at 64 Hz. This *schedule* is the part to get right;
the units themselves are counters. The obscure-behavior cluster (extra length clocks on
enable edges, sweep negate-mode latching, length counters surviving power-off) is
concentrated in `lenEnableQuirk`/`triggerSquare`/`reset` — added *after* the basics
worked, guided test-by-test by Blargg's `dmg_sound` (5/12 → 9/12).

### Sampling and the DC problem

One stereo pair is emitted every `4194304 / sampleRate` cycles via a fractional
accumulator. Mixing maps each DAC's 0-15 to −1..1 — which leaves a hefty DC offset
(silent-but-enabled channels sit at −1). Real hardware removes it with an output
capacitor; the emulator uses Blargg's one-pole high-pass equivalent:

```ts
const outL = left - this.capL;
this.capL = left - outL * this.hpCharge;   // hpCharge = 0.999958 ^ cyclesPerSample
```

Measured effect: DC mean −0.75 → −0.0003.

### Audio as the master clock

The subtlest part of the whole emulator is in [main.ts](../src/frontend/main.ts), not
the APU: **the audio buffer paces emulation**.

```ts
while (audio.bufferedSeconds() < TARGET_BUFFER && guard++ < 8) {
  gb.runFrame();
  audio.push(gb.apu.drain());
}
```

The sound card consumes samples at *exactly* its rate, so "keep ~90 ms queued" is
simultaneously a speed governor and an anti-crackle guarantee — displays vary (60/90/144
Hz), audio clocks don't. Two real bugs are documented in
[audio.ts](../src/frontend/audio.ts) and worth reading: a transferred `ArrayBuffer`
detaches (read `chunk.length` *before* `postMessage`, or your accounting reads 0 and
emulation free-runs at 800%), and buffer underruns must re-anchor the clock baseline or
the loop fast-forwards to "catch up" after every stall.

---

## 8. Frontend — [src/frontend](../src/frontend)

- **[main.ts](../src/frontend/main.ts)** — machine lifecycle. Battery RAM is restored
  *before* construction (the game's first read must see it); dirty RAM flushes on a 2 s
  interval; `runToken` invalidates stale loops when a new ROM loads.
- **[zip.ts](../src/frontend/zip.ts)** — a complete ZIP reader in ~100 lines: scan
  backwards for the end-of-central-directory signature, walk the entries, inflate with
  the browser-native `DecompressionStream("deflate-raw")`. No dependencies.
- **[storage.ts](../src/frontend/storage.ts)** — IndexedDB in two promise-wrapped
  functions. Saves are keyed by `title + global checksum + ROM size`.
- **[audio-worklet.js](../public/audio-worklet.js)** — the audio-thread half: a queue
  of chunks fed by `postMessage`. Using the MessagePort (not SharedArrayBuffer) trades
  a few ms of latency for freedom from COOP/COEP deployment headers.

---

## 9. The testing methodology — how you *know* it works

This project never debugged by "play games and squint". Each layer has an oracle:

| Layer | Oracle | Channel |
|---|---|---|
| CPU semantics | Blargg `cpu_instrs` | writes to the serial port — the bus's `onSerial` hook captures them, **no PPU needed** |
| CPU timing | Blargg `instr_timing` | serial |
| MBC banking | Mooneye `emulator-only/mbc*` | registers B..L hold fibonacci `3,5,8,13,21,34` after `LD B,B` |
| PPU | dmg-acid2 | **pixel diff** of the framebuffer against the reference PNG |
| CGB PPU | cgb-acid2 | same pixel diff, in 15-bit color |
| APU | Blargg `dmg_sound` | result byte at `0xA000` (+ signature `DE B0 61`) |
| Integration | Super Mario Land | it boots, demos, plays |

Two habits made this workable in a browser:

- **A determinism hatch.** `window.gbDev` exposes `runFrames(n)` and `setPaused()`.
  The real-time loop *keeps running between your debugger calls* — an early "bug"
  where Start appeared broken was actually the attract demo cycling between calls.
  Freeze the loop, drive frames synchronously, and every test is reproducible.
- **Numbers over eyeballs.** The PPU was signed off by diffing 23,040 pixels (0
  mismatches), the APU by measuring sample counts, DC mean, and zero-crossings, the
  pacing by measuring 99.9% speed over a wall-clock window. Eyeballs missed a
  "missing" mouth that the pixel diff proved was present.
- **Trust the numbers, but audit the instrument.** The first cgb-acid2 diff reported
  560 mismatches — every one a ±1–2 channel shift. The renderer was perfect; Chrome's
  canvas *color management* was quietly transforming the reference PNG. Decoding with
  `createImageBitmap(blob, { colorSpaceConversion: "none" })` took the diff to zero.
  When a measurement disagrees with expectation by a suspiciously uniform epsilon,
  suspect the measuring device.

When something fails with no oracle, the technique of last resort is **trace
diffing**: log `PC + registers` per instruction here and in a known-good emulator, and
`diff` finds the first divergence.

---

## 10. Learning path — write yours

The commit history of this repo *is* the tutorial; each PR is one self-contained step
with its acceptance test:

| Step | Build | Gate |
|---|---|---|
| 1 | ROM loader, hex-dump the header | your eyes |
| 2 | full CPU + serial hook | Blargg `cpu_instrs` |
| 3 | timer, interrupts | Blargg `instr_timing` |
| 4 | scanline PPU | dmg-acid2 pixel diff |
| 5 | joypad matrix | a game becomes playable |
| 6 | MBCs + saves | Mooneye MBC suite |
| 7 | APU + audio pacing | Blargg `dmg_sound`, speed ≈ 100% |
| 8 | Game Boy Color: banking, palettes, double speed | cgb-acid2 pixel diff |

Suggested exercises against this codebase, in rising difficulty:

1. **Add MBC2** (`cartridge.ts`) — mooneye grades you.
2. **CGB compatibility palettes**: DMG carts on a real CGB get boot-ROM-assigned
   colors; this emulator shows them in DMG green. Implement the palette assignment.
3. **Fix `dmg_sound` 09/10/12** — requires modeling *when* within an instruction the
   wave channel fetches; a taste of cycle accuracy.
4. **Implement the HALT bug** (`cpu.ts` has the TODO) — then run Blargg's `halt_bug.gb`.
5. **CGB-mode APU**: on CGB, length counters do *not* survive power-off (the DMG
   behavior `reset()` preserves) — branch on mode and verify with `cgb_sound`.
6. **The event scheduler**: replace tick-along stepping with "run CPU until the next
   interesting event" (README §3) and measure the speedup.
7. **The GBA** — a second, bigger loop of exactly the same method (README phase B).

The meta-lesson to take away: *test ROMs before games, one subsystem per step, a
deterministic harness, and numeric verification*. That loop — not any particular
opcode table — is what lets one person build an emulator from zero.
