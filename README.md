# Building a Game Boy & Game Boy Advance Emulator for the Browser — From Scratch

**English** | [繁體中文](./README.zh-TW.md)

This document explains how console emulators work in principle, what the Game Boy (GB) and
Game Boy Advance (GBA) hardware actually consists of, and how to build an emulator for both
systems that runs entirely in a web browser — starting from an empty folder.

> Note: although the GBA can play GB cartridges, it does so with a *separate* CPU on the
> real hardware. A "GB + GBA emulator" is therefore really **two emulators** that share a
> frontend (screen, audio, input, save files). Build the GB core first — it is an order of
> magnitude simpler and teaches you every concept the GBA needs.

---

## Table of contents

1. [What an emulator actually is](#1-what-an-emulator-actually-is)
2. [The hardware you are imitating](#2-the-hardware-you-are-imitating)
3. [Core architecture of an emulator](#3-core-architecture-of-an-emulator)
4. [Making it run in a browser](#4-making-it-run-in-a-browser)
5. [Development roadmap, step by step](#5-development-roadmap-step-by-step)
6. [Test ROMs and documentation](#6-test-roms-and-documentation)
7. [Common pitfalls](#7-common-pitfalls)

---

## 1. What an emulator actually is

An emulator is a **state machine** that reproduces the observable behavior of a physical
machine. The console is a handful of chips wired to a shared bus:

- a **CPU** that endlessly fetches, decodes, and executes instructions from memory;
- a **PPU** (picture processing unit) that races the electron beam / LCD driver, producing
  one pixel line at a time;
- an **APU** (audio processing unit) generating waveforms;
- **timers**, **DMA controllers**, and an **interrupt controller**;
- a **cartridge** containing ROM, often extra RAM, and sometimes a memory-bank controller.

Your emulator keeps all of that state in variables and arrays, and advances it in lockstep:

```text
loop forever:
    cycles = cpu.step()        # execute one instruction, return how long it took
    ppu.step(cycles)           # advance the video chip by the same amount of time
    apu.step(cycles)           # advance audio
    timers.step(cycles)        # advance timers, possibly raising interrupts
    dma.step(cycles)
```

The single most important idea is the **shared clock**. Games are written against exact
hardware timing: they change video registers *mid-frame*, race the scanline counter, and
time audio with hardware timers. If your CPU and PPU do not agree on what time it is,
games glitch or hang. Every component therefore consumes the same currency — **cycles**
(GB: "T-cycles" at 4,194,304 Hz; GBA: 16,777,216 Hz).

### Accuracy levels

| Level | Meaning | Enough for |
|---|---|---|
| Instruction-level | Components sync once per CPU instruction | Most games, a first emulator |
| Cycle-accurate | Components sync every cycle; memory accesses happen at the right cycle within an instruction | Stubborn games, accuracy test ROMs |
| Sub-cycle / circuit-level | Model internal chip signals | Research (not needed here) |

Start at instruction-level with per-instruction cycle counts. You can tighten accuracy
later without rewriting the architecture, as long as everything already flows through the
shared clock.

### Interpreter vs. JIT

An **interpreter** decodes every instruction each time it runs — simple and fast enough in
JavaScript/WASM for both GB and GBA. A **dynamic recompiler (JIT)** translates blocks of
guest code to host code — a large complexity jump you do not need for these consoles in a
modern browser. Write an interpreter.

---

## 2. The hardware you are imitating

### 2.1 Game Boy (DMG / Game Boy Color)

| Component | Details |
|---|---|
| CPU | Sharp **SM83** (often called LR35902) — an 8080/Z80-*like* 8-bit CPU, **not** a Z80. 4.194304 MHz. |
| Registers | `A F B C D E H L` (pairable as `AF BC DE HL`), `SP`, `PC`. Flags in `F`: **Z N H C**. |
| Instruction set | 256 base opcodes + 256 `0xCB`-prefixed (bit ops, shifts). ~500 total. |
| WRAM | 8 KiB (CGB: 32 KiB banked) |
| VRAM | 8 KiB (CGB: 16 KiB banked) |
| Screen | 160×144, 4 shades (CGB: 15-bit color, 8 BG + 8 OBJ palettes) |
| Audio | 4 channels: 2 square (one with sweep), programmable wave, noise |
| Frame rate | 59.73 Hz — 70,224 T-cycles per frame |

**Memory map** — the bus is a 16-bit address space; every read/write dispatches on region:

```text
0000-3FFF  ROM bank 0            (cartridge)
4000-7FFF  ROM bank 1..N         (switchable via MBC)
8000-9FFF  VRAM
A000-BFFF  External (cartridge) RAM — battery-backed saves live here
C000-DFFF  WRAM
E000-FDFF  Echo RAM (mirror of C000-DDFF)
FE00-FE9F  OAM (sprite attribute table, 40 entries × 4 bytes)
FF00-FF7F  I/O registers (joypad, serial, timer, audio, PPU, DMA...)
FF80-FFFE  HRAM
FFFF       IE (interrupt enable)
```

**PPU.** Graphics are built from 8×8 **tiles** (2 bits per pixel). A 32×32-tile
**background map** scrolls via `SCX/SCY`; a **window** layer overlays it; up to 40
**sprites** (10 per line) come from OAM. The PPU walks each scanline through modes —
**2** (OAM scan, 80 dots) → **3** (pixel transfer, ~172–289 dots) → **0** (HBlank) — each
line lasting 456 dots, for 154 lines (144 visible, then 10 lines of mode **1** VBlank).
Games rely on these mode timings and on the `LY`/`LYC` compare interrupt to do
raster effects, so a **scanline renderer** (draw one full line whenever the PPU reaches
HBlank) is the standard first implementation.

**Interrupts.** Five sources — VBlank, LCD STAT, Timer, Serial, Joypad — with flags in
`IF (FF0F)`, masks in `IE (FFFF)`, and a master switch (`IME`, set by `EI`/`DI`).
Servicing pushes `PC` and jumps to a fixed vector (`0x40/0x48/0x50/0x58/0x60`).

**Timers.** `DIV` (FF04) ticks at 16,384 Hz; `TIMA` (FF05) counts at a rate selected by
`TAC` (FF07) and, on overflow, reloads from `TMA` (FF06) and raises the Timer interrupt.

**Cartridge / MBC.** Addresses only reach 32 KiB of ROM, so bigger cartridges add a
**Memory Bank Controller**: writes to ROM address ranges select which bank appears at
`4000-7FFF`. Implement **MBC1**, **MBC3** (adds a real-time clock), and **MBC5** — that
covers almost the whole library. The header byte at `0x147` tells you which one to use.

### 2.2 Game Boy Advance

| Component | Details |
|---|---|
| CPU | **ARM7TDMI** — 32-bit ARMv4T, 16.777216 MHz, 3-stage pipeline |
| Instruction sets | **ARM** (32-bit wide) and **Thumb** (16-bit wide); games switch constantly via `BX` |
| Registers | `r0–r15` (`r15` = PC), `CPSR`, banked registers + `SPSR` per mode (IRQ, SVC, ...) |
| Screen | 240×160, 15-bit color, 59.7275 Hz — 280,896 cycles/frame, 1,232 per scanline, 228 lines (160 visible + 68 VBlank) |
| Audio | 2 **Direct Sound** channels (8-bit PCM via DMA-fed FIFOs) + the 4 legacy GB channels |
| BIOS | 16 KiB ROM with software-interrupt (SWI) system calls games actually use |

**Memory map** (32-bit address space, region in bits 24–27):

```text
00000000  BIOS         16 KiB   (protected: readable only while executing it)
02000000  EWRAM       256 KiB   (16-bit bus, 2 wait states — slow)
03000000  IWRAM        32 KiB   (32-bit bus, fast — hot code goes here)
04000000  I/O registers
05000000  Palette RAM   1 KiB   (256 BG + 256 OBJ colors, 15-bit)
06000000  VRAM         96 KiB
07000000  OAM           1 KiB   (128 sprite entries)
08000000  Cartridge ROM up to 32 MiB  (3 mirrors with different wait states)
0E000000  Cartridge SRAM/Flash        (8-bit bus)
```

**PPU.** Six video modes. Modes **0–2** are tiled: up to four background layers, some of
which can be **affine** (rotated/scaled with a 2×2 matrix, like SNES "Mode 7"). Modes
**3–5** are bitmap framebuffers (mode 3: 16-bpp 240×160; mode 4: 8-bpp paletted,
double-buffered — the famous "first demo" mode). On top: 128 sprites (regular and affine),
**windows** that clip layers, **alpha blending**, brightness fades, and mosaic.

**DMA.** Four channels copy memory blocks instantly (from the CPU's point of view), can
trigger on VBlank/HBlank, and channels 1–2 refill the audio FIFOs. Games use DMA
constantly — you need it early.

**Timers.** Four 16-bit timers with prescalers (1/64/256/1024), cascadable; timers 0–1
clock the Direct Sound sample rate.

**Backup media.** Cartridges save via SRAM (32 KiB), Flash (64/128 KiB, command
protocol), or EEPROM (512 B / 8 KiB, serial protocol over the ROM bus). Detect the type
by scanning the ROM for ID strings (`SRAM_V`, `FLASH1M_V`, `EEPROM_V`, ...).

**BIOS.** Either ship an open-source replacement BIOS, or implement **HLE**: trap `SWI`
and implement the calls (division, memcpy, decompression, `IntrWait`...) in your own code.

---

## 3. Core architecture of an emulator

A clean module layout mirrors the hardware:

```text
core/
  cpu.ts        # fetch/decode/execute, interrupt handling
  bus.ts        # memory map dispatch: read8/16/32, write8/16/32
  ppu.ts        # scanline renderer, produces a framebuffer
  apu.ts        # sample generator, produces an audio ring buffer
  timers.ts
  dma.ts        # (GBA)
  cartridge.ts  # ROM + MBC / backup chip
  scheduler.ts  # the shared clock
frontend/
  screen.ts     # canvas / WebGL
  audio.ts      # AudioWorklet
  input.ts      # keyboard / gamepad / touch
  storage.ts    # IndexedDB saves, save states
```

### The CPU loop

For the GB's 256+256 opcodes, a **dispatch table** of small functions (or one big
`switch`) is ideal:

```ts
// GB (SM83) — one entry per opcode, returns cycles consumed
const ops: ((cpu: CPU) => number)[] = new Array(256);

ops[0x3e] = c => { c.a = c.fetch8(); return 8; };           // LD A, n
ops[0x80] = c => { c.a = c.add8(c.a, c.b); return 4; };     // ADD A, B
ops[0xcb] = c => cbOps[c.fetch8()](c);                      // CB prefix

function step(c: CPU): number {
  if (c.handleInterrupts()) return 20;
  return ops[c.fetch8()](c);
}
```

For the ARM7TDMI you cannot enumerate 2³² encodings, but bits **27–20 and 7–4** of an ARM
instruction (12 bits) identify the operation. Build a 4096-entry lookup table once at
startup; Thumb similarly uses the top 8–10 bits. Model the pipeline the cheap way: when
`r15` is read it returns the fetch address + 8 (ARM) or + 4 (Thumb), and any write to
`r15` flushes and refetches.

### The bus

Every memory access funnels through one function that dispatches on address region.
Back each region with a **typed array** (`Uint8Array`); this is what makes JS emulators
fast:

```ts
function read8(addr: number): number {
  switch (addr >>> 24) {           // GBA: region = top byte
    case 0x03: return iwram[addr & 0x7fff];
    case 0x04: return ioRead(addr);
    case 0x06: return vram[addr % 0x18000];
    case 0x08: case 0x09: return rom[addr & (rom.length - 1)];
    // ...
  }
}
```

I/O registers are the one place that needs per-address logic — reading `LY` returns the
current scanline; writing `DMA3CNT` may start a transfer *right now*.

### The scheduler

Two workable designs:

- **Tick-along** (start here): after each CPU instruction, pass the elapsed cycles to
  every component, as in the loop in §1.
- **Event scheduler** (optimize later): components register "next interesting event at
  cycle X" (end of scanline, timer overflow, FIFO drain); the CPU runs freely until the
  earliest event. Much faster, same observable behavior — this is what mGBA does.

### PPU strategy

Keep a framebuffer (`Uint32Array`, one RGBA pixel per element). When the shared clock
says a scanline ended, render that whole line: background layer(s), window, then sprites,
respecting per-line register state. Per-pixel FIFO accuracy (GB) can come much later.

### APU strategy

Audio is a **producer/consumer** problem: the emulated APU produces samples at its native
rate (GB channels are simple oscillators; GBA Direct Sound pops 8-bit samples from a FIFO
each timer tick), you downsample to 44.1/48 kHz, and push into a **ring buffer** the
browser audio thread drains. Audio is also your best *clock source* — see §4.

---

## 4. Making it run in a browser

### Language

- **TypeScript/JavaScript**: zero build friction, debuggable in DevTools, plenty fast for
  GB; fast enough for GBA if you avoid allocation in hot loops. Recommended for a first
  emulator.
- **Rust / C++ / Zig → WebAssembly**: 2–5× faster core, at the cost of toolchain and
  JS-interop complexity. A common path is: prototype in TS, port the CPU/PPU hot core to
  WASM later. (Existing proof: mGBA compiled with Emscripten runs fine in browsers.)

### Main loop and timing

`requestAnimationFrame` gives you a callback per display refresh — but the display is not
guaranteed to be 60 Hz (144 Hz monitors exist) and rAF pauses in background tabs. So:

- run emulation in fixed chunks of **one emulated frame** (70,224 GB cycles / 280,896 GBA
  cycles);
- decide *how many* frames to run per rAF from real elapsed time, or better, **let the
  audio buffer pace you**: run emulation until the audio ring buffer is full, then stop.
  Audio hardware consumes samples at exactly the right rate, so syncing to audio gives
  you correct speed *and* no crackling with one mechanism.

```ts
function onFrame() {
  while (audioRing.spaceAvailable() > SAMPLES_PER_EMU_FRAME) {
    emu.runFrame();                     // advances CPU/PPU/APU by one frame
    audioRing.push(emu.takeSamples());
  }
  screen.present(emu.framebuffer);
  requestAnimationFrame(onFrame);
}
```

### Video

Simplest: a `<canvas>` at 160×144 / 240×160 with `ctx.putImageData(imageData, 0, 0)`
where `imageData.data` shares the buffer of your `Uint32Array` framebuffer, scaled up via
CSS `image-rendering: pixelated`. Faster / fancier (shaders, rotation): upload the
framebuffer as a **WebGL/WebGPU texture** each frame.

### Audio

Use an **`AudioWorklet`** — a small processor running on the audio thread that reads from
your ring buffer. Share the buffer via `SharedArrayBuffer` (requires the page to be
**cross-origin isolated**: serve with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`), or fall back to `port.postMessage` chunks.
Remember browsers block audio until a user gesture — start/resume the `AudioContext` in a
click handler.

### Input

- **Keyboard**: `keydown`/`keyup` → set/clear bits in the joypad register (GB: `FF00`
  with its odd select-line scheme; GBA: `KEYINPUT` at `0x4000130`, active-low).
- **Gamepad API**: poll `navigator.getGamepads()` once per frame.
- **Touch**: positioned `<div>` overlays with `pointerdown/up` for mobile.

### ROMs and saves

- Load ROMs with `<input type="file">` or drag-and-drop → `File.arrayBuffer()` →
  `Uint8Array`. Never hardcode or bundle commercial ROMs; use homebrew and test ROMs.
- **Battery saves**: whenever the game writes cartridge RAM, mark it dirty; periodically
  (and on `visibilitychange`) persist the bytes to **IndexedDB** keyed by a hash of the
  ROM header.
- **Save states**: serialize *all* emulator state (every register, every array, every
  counter — miss one and loads desync) into a versioned binary blob; store in IndexedDB.

### Performance rules for JS

1. **No allocation in the hot loop.** Preallocate every buffer; reuse objects. GC pauses
   are your enemy.
2. Typed arrays for all memory; integer math with `| 0` / `>>> 0`.
3. Monomorphic functions (always same argument types) so the JIT stays happy.
4. Consider running the core in a **Web Worker** (render via `OffscreenCanvas` or post
   the framebuffer) so the UI thread never stalls emulation.
5. Profile with DevTools before optimizing — the bottleneck is usually the PPU, not the
   CPU.

---

## 5. Development roadmap, step by step

### Phase A — Game Boy core

| Step | Goal | You know it works when |
|---|---|---|
| 1 | Project skeleton, ROM loader, bus with flat memory | You can hex-dump the ROM header |
| 2 | SM83 interpreter, all opcodes + flags | **Blargg's `cpu_instrs`** passes — it prints results over the serial port register, so you need *no PPU yet*: log writes to `FF01/FF02` |
| 3 | Interrupts + timers | Blargg's `instr_timing` passes |
| 4 | PPU: background → window → sprites, scanline renderer, canvas output | The bootup logo & Tetris title screen render; then **dmg-acid2** renders correctly |
| 5 | Joypad | Tetris is playable |
| 6 | MBC1/MBC3/MBC5 + battery saves to IndexedDB | Pokémon Red saves and reloads |
| 7 | APU (4 channels) + AudioWorklet | Music sounds right; Blargg's `dmg_sound` mostly passes |
| 8 | (Optional) Game Boy Color: banking, palettes, double speed | CGB games run; **cgb-acid2** passes |

### Phase B — GBA core

| Step | Goal | You know it works when |
|---|---|---|
| 1 | ARM + Thumb interpreter, banked registers, pipeline-visible PC | **jsmoo/SingleStepTests** (per-instruction JSON vectors) pass; then `armwrestler`, `gba-suite`, `FuzzARM` |
| 2 | Memory map + I/O scaffold, keypad | BIOS replacement reaches the boot animation |
| 3 | PPU bitmap modes 3/4 | Simple demos (Tonc's first examples) display |
| 4 | DMA + timers + VBlank/HBlank interrupts | Games stop hanging on `IntrWait` |
| 5 | PPU tiled modes 0–2, sprites | Menus and most 2D games render |
| 6 | Affine BG/OBJ, windows, blending | *Mode 7*-style games (e.g. racing games) look right |
| 7 | Direct Sound audio (FIFO + timer + DMA1/2) | Music plays at correct pitch |
| 8 | Backup autodetection (SRAM/Flash/EEPROM) | Commercial-style homebrew saves persist |
| 9 | Waitstate accuracy, open-bus behavior, optimization | mGBA suite scores climb; full-speed on mid-range phones |

At every step, **test ROMs before games, games before polish**. Emulator bugs compound:
a wrong flag in step 2 surfaces as a garbled screen in step 5. When something breaks,
compare execution traces (PC + registers per instruction) against a known-good emulator —
this "trace diffing" is the single most effective debugging technique in emulation.

---

## 6. Test ROMs and documentation

### Game Boy

| Resource | What it is |
|---|---|
| **Pan Docs** (gbdev.io/pandocs) | *The* GB hardware reference |
| **gbops** opcode table | Every SM83 opcode, cycles, flags |
| Blargg's test ROMs | CPU, timing, sound correctness |
| **dmg-acid2 / cgb-acid2** | One-screenshot PPU correctness tests |
| Mooneye test suite | Cycle-accurate corner cases (timers, OAM DMA...) |
| *The Ultimate Game Boy Talk* (33c3) | Best one-hour architecture overview |

### GBA

| Resource | What it is |
|---|---|
| **GBATEK** | *The* GBA (and DS) hardware reference — terse but complete |
| **Tonc** | GBA *programming* tutorial — invaluable for understanding what games do |
| jsmoo / SingleStepTests (ARM7TDMI) | JSON per-instruction test vectors — test your CPU with zero hardware emulated |
| armwrestler, gba-suite (jsmolka), FuzzARM | CPU test ROMs |
| mGBA test suite | Hundreds of timing/PPU/memory tests with a score |
| mGBA development blog | Deep dives into real accuracy bugs |
| Cult-of-GBA BIOS / Normmatt's BIOS | Open-source replacement BIOS images |

### Community

- **gbdev** community (gbdev.io) — docs, Discord, homebrew.
- **Emulation Development Discord** ("emudev") — active help for exactly this project.
- **NanoBoyAdvance**, **mGBA**, **SameBoy** — high-quality open-source references when
  you are stuck on "what does hardware *really* do here?".

---

## 7. Common pitfalls

**Game Boy**

- The SM83 is *not* a Z80 — no `IX/IY`, different flags, different opcodes. Z80 docs will
  mislead you.
- `DAA` (decimal adjust) is the most-often-wrong instruction; take the algorithm from a
  reference, don't derive it.
- The **HALT bug**, `EI` delay (interrupts enable one instruction late), and the exact
  timer/`DIV` relationship are classic test-ROM failures.
- Sprite priority: lower X wins on DMG; OAM order wins on CGB. 10-sprites-per-line limit
  is real and games depend on it.
- During PPU mode 3 the CPU cannot access VRAM (reads return `0xFF`) — some games rely on
  this.

**GBA**

- Thumb is not optional decoration — games run *mostly* Thumb. Implement both sets from
  the start.
- Get the pipeline-offset PC (`+8` ARM / `+4` Thumb) right immediately; nearly every
  branch/literal-load depends on it.
- **Open bus**: reading unmapped memory returns the last prefetched value, not zero —
  several games depend on it.
- EEPROM is addressed through the *ROM* region with a serial bit protocol, and its size
  (512 B vs 8 KiB) is not stated anywhere in the header — detect from DMA transfer length.
- Don't forget `IntrWait`/`Halt` (SWI or `HALTCNT`): without them your emulator burns
  cycles spinning and audio timing drifts.
- I/O registers have odd read/write behavior (write-only bits reading back as 0, `IF`
  acknowledged by *writing 1s*). Read GBATEK's per-register notes, not just the layout.

---

*Written as a from-scratch design guide; no ROMs, BIOS images, or copyrighted material are
included or linked. Use homebrew and test ROMs for development.*
