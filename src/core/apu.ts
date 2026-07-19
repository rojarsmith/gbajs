/**
 * DMG APU (roadmap step 7): 2 square channels (one with sweep), the
 * programmable wave channel, and the LFSR noise channel.
 *
 * Model: channel period timers and the 512 Hz frame sequencer (length /
 * sweep / envelope) advance on the shared clock; one stereo sample pair is
 * produced every cyclesPerSample T-cycles into an internal buffer that the
 * frontend drains each animation frame. Sample timing therefore jitters by
 * up to one instruction — inaudible, and standard for instruction-level
 * emulators. Obscure trigger/length edge cases (Blargg dmg_sound tests
 * 03/07/09-style quirks) are not modeled yet.
 */

const CPU_HZ = 4194304;

// Duty patterns (gbdev wiki order)
const DUTY = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
];

// Read-back OR masks for FF10-FF26 (unused/write-only bits read as 1)
const READ_OR = [
  0x80, 0x3f, 0x00, 0xff, 0xbf, // NR10-NR14
  0xff, 0x3f, 0x00, 0xff, 0xbf, // FF15, NR21-NR24
  0x7f, 0xff, 0x9f, 0xff, 0xbf, // NR30-NR34
  0xff, 0xff, 0x00, 0x00, 0xbf, // FF1F, NR41-NR44
  0x00, 0x00, 0x70,             // NR50-NR52
];

const NOISE_DIVISOR = [8, 16, 32, 48, 64, 80, 96, 112];
const WAVE_SHIFT = [4, 0, 1, 2];

export class APU {
  private regs = new Uint8Array(0x17); // FF10-FF26 raw values (for reads)
  readonly waveRam = new Uint8Array(16);
  private power = true;

  // Square 1 (with sweep) & square 2
  private sq = [
    { on: false, dac: false, duty: 0, pos: 0, timer: 0, freq: 0, len: 0, lenOn: false,
      vol: 0, envDir: 0, envPer: 0, envTimer: 0,
      swPer: 0, swDir: 0, swShift: 0, swTimer: 0, swOn: false, shadow: 0, swNegUsed: false },
    { on: false, dac: false, duty: 0, pos: 0, timer: 0, freq: 0, len: 0, lenOn: false,
      vol: 0, envDir: 0, envPer: 0, envTimer: 0,
      swPer: 0, swDir: 0, swShift: 0, swTimer: 0, swOn: false, shadow: 0, swNegUsed: false },
  ];
  // Wave
  private wv = { on: false, dac: false, timer: 0, freq: 0, len: 0, lenOn: false, volCode: 0, pos: 0 };
  // Noise
  private ns = { on: false, dac: false, timer: 0, len: 0, lenOn: false,
    vol: 0, envDir: 0, envPer: 0, envTimer: 0, shift: 0, width7: false, div: 0, lfsr: 0x7fff };

  private fsTimer = 0;
  private fsStep = 0;

  private cyclesPerSample = CPU_HZ / 48000;
  private sampleTimer = 0;
  private buf = new Float32Array(32768); // interleaved stereo
  private bufLen = 0;
  // High-pass ("capacitor") filter removing the DAC DC offset, as the real
  // hardware's output stage does. Charge factor per Blargg: 0.999958^cycles.
  private hpCharge = Math.pow(0.999958, CPU_HZ / 48000);
  private capL = 0;
  private capR = 0;

  setSampleRate(rate: number): void {
    this.cyclesPerSample = CPU_HZ / rate;
    this.hpCharge = Math.pow(0.999958, this.cyclesPerSample);
  }

  /** Drain generated samples (interleaved stereo). Returns a copy. */
  drain(): Float32Array {
    const out = this.buf.slice(0, this.bufLen);
    this.bufLen = 0;
    return out;
  }

  // ---- clock ------------------------------------------------------------

  step(cycles: number): void {
    if (this.power) {
      this.tickSquare(0, cycles);
      this.tickSquare(1, cycles);
      this.tickWave(cycles);
      this.tickNoise(cycles);

      this.fsTimer += cycles;
      while (this.fsTimer >= 8192) {
        this.fsTimer -= 8192;
        this.frameSequencer();
      }
    }

    this.sampleTimer += cycles;
    while (this.sampleTimer >= this.cyclesPerSample) {
      this.sampleTimer -= this.cyclesPerSample;
      this.emitSample();
    }
  }

  private tickSquare(i: number, cycles: number): void {
    const c = this.sq[i];
    c.timer -= cycles;
    while (c.timer <= 0) {
      c.timer += (2048 - c.freq) << 2;
      c.pos = (c.pos + 1) & 7;
    }
  }

  private tickWave(cycles: number): void {
    const w = this.wv;
    w.timer -= cycles;
    while (w.timer <= 0) {
      w.timer += (2048 - w.freq) << 1;
      w.pos = (w.pos + 1) & 31;
    }
  }

  private tickNoise(cycles: number): void {
    const n = this.ns;
    n.timer -= cycles;
    const period = NOISE_DIVISOR[n.div] << n.shift;
    while (n.timer <= 0) {
      n.timer += period;
      const bit = (n.lfsr ^ (n.lfsr >> 1)) & 1;
      n.lfsr = (n.lfsr >> 1) | (bit << 14);
      if (n.width7) n.lfsr = (n.lfsr & ~0x40) | (bit << 6);
    }
  }

  private frameSequencer(): void {
    const s = this.fsStep;
    this.fsStep = (s + 1) & 7;
    if ((s & 1) === 0) this.tickLengths();          // 256 Hz: steps 0,2,4,6
    if (s === 2 || s === 6) this.tickSweep();       // 128 Hz
    if (s === 7) this.tickEnvelopes();              // 64 Hz
  }

  private tickLengths(): void {
    for (const c of this.sq) {
      if (c.lenOn && c.len > 0 && --c.len === 0) c.on = false;
    }
    const w = this.wv;
    if (w.lenOn && w.len > 0 && --w.len === 0) w.on = false;
    const n = this.ns;
    if (n.lenOn && n.len > 0 && --n.len === 0) n.on = false;
  }

  private tickEnvelopes(): void {
    for (const c of [this.sq[0], this.sq[1], this.ns] as const) {
      if (c.envPer === 0) continue;
      if (--c.envTimer <= 0) {
        c.envTimer = c.envPer;
        const v = c.vol + (c.envDir ? 1 : -1);
        if (v >= 0 && v <= 15) c.vol = v;
      }
    }
  }

  private sweepCalc(write: boolean): number {
    const c = this.sq[0];
    if (c.swDir) c.swNegUsed = true;
    let f = c.shadow + (c.swDir ? -(c.shadow >> c.swShift) : c.shadow >> c.swShift);
    if (f > 2047) { c.on = false; return f; }
    if (write && c.swShift > 0) {
      c.shadow = f;
      c.freq = f;
      this.regs[3] = f & 0xff;
      this.regs[4] = (this.regs[4] & 0xf8) | (f >> 8);
    }
    return f;
  }

  private tickSweep(): void {
    const c = this.sq[0];
    if (--c.swTimer > 0) return;
    c.swTimer = c.swPer || 8;
    if (c.swOn && c.swPer > 0) {
      this.sweepCalc(true);
      this.sweepCalc(false); // second overflow check
    }
  }

  // ---- output -----------------------------------------------------------

  private channelOut(i: number): number {
    switch (i) {
      case 0: case 1: {
        const c = this.sq[i];
        return c.on && c.dac ? (DUTY[c.duty][c.pos] ? c.vol : 0) : 0;
      }
      case 2: {
        const w = this.wv;
        if (!(w.on && w.dac)) return 0;
        const byte = this.waveRam[w.pos >> 1];
        const nib = w.pos & 1 ? byte & 0xf : byte >> 4;
        return nib >> WAVE_SHIFT[w.volCode];
      }
      default: {
        const n = this.ns;
        return n.on && n.dac ? ((~n.lfsr & 1) ? n.vol : 0) : 0;
      }
    }
  }

  private emitSample(): void {
    if (this.bufLen >= this.buf.length) this.bufLen = 0; // overflow: drop (turbo)
    let left = 0;
    let right = 0;
    const nr51 = this.regs[0x15];
    for (let i = 0; i < 4; i++) {
      const dac = this.channelOut(i) / 7.5 - 1; // 0-15 -> -1..1
      // A silent-but-enabled DAC outputs -1; approximate by only mixing
      // channels whose DAC is on.
      const dacOn = i < 2 ? this.sq[i].dac : i === 2 ? this.wv.dac : this.ns.dac;
      if (!dacOn) continue;
      if (nr51 & (1 << (i + 4))) left += dac;
      if (nr51 & (1 << i)) right += dac;
    }
    const nr50 = this.regs[0x14];
    left = (left / 4) * ((((nr50 >> 4) & 7) + 1) / 8);
    right = (right / 4) * (((nr50 & 7) + 1) / 8);
    const outL = left - this.capL;
    const outR = right - this.capR;
    this.capL = left - outL * this.hpCharge;
    this.capR = right - outR * this.hpCharge;
    this.buf[this.bufLen++] = outL;
    this.buf[this.bufLen++] = outR;
  }

  // ---- registers --------------------------------------------------------

  readReg(addr: number): number {
    if (addr >= 0xff30 && addr <= 0xff3f) return this.waveRam[addr - 0xff30];
    if (addr < 0xff10 || addr > 0xff26) return 0xff;
    const i = addr - 0xff10;
    if (addr === 0xff26) {
      return 0x70 | (this.power ? 0x80 : 0) |
        (this.ns.on ? 8 : 0) | (this.wv.on ? 4 : 0) |
        (this.sq[1].on ? 2 : 0) | (this.sq[0].on ? 1 : 0);
    }
    return this.regs[i] | READ_OR[i];
  }

  writeReg(addr: number, v: number): void {
    if (addr >= 0xff30 && addr <= 0xff3f) {
      this.waveRam[addr - 0xff30] = v;
      return;
    }
    if (addr < 0xff10 || addr > 0xff26) return;
    if (addr === 0xff26) {
      const wasOn = this.power;
      this.power = (v & 0x80) !== 0;
      if (wasOn && !this.power) this.reset();
      else if (!wasOn && this.power) {
        // Power-on restarts the frame sequencer and duty positions
        this.fsStep = 0;
        this.sq[0].pos = this.sq[1].pos = 0;
        this.wv.pos = 0;
      }
      return;
    }
    const i = addr - 0xff10;
    if (!this.power) {
      // DMG quirk: length counters remain writable while the APU is off
      if (i === 0x01) this.sq[0].len = 64 - (v & 0x3f);
      else if (i === 0x06) this.sq[1].len = 64 - (v & 0x3f);
      else if (i === 0x0b) this.wv.len = 256 - v;
      else if (i === 0x10) this.ns.len = 64 - (v & 0x3f);
      return;
    }
    this.regs[i] = v;

    const sq = i < 5 ? this.sq[0] : i < 10 ? this.sq[1] : null;
    switch (i) {
      // --- square channels (NR10-NR24) ---
      case 0x00:
        sq!.swPer = (v >> 4) & 7;
        sq!.swDir = (v >> 3) & 1;
        sq!.swShift = v & 7;
        // Clearing negate after it was used in a sweep calc kills the channel
        if (!sq!.swDir && sq!.swNegUsed) sq!.on = false;
        break;
      case 0x01: case 0x06:
        sq!.duty = v >> 6;
        sq!.len = 64 - (v & 0x3f);
        break;
      case 0x02: case 0x07:
        sq!.dac = (v & 0xf8) !== 0;
        if (!sq!.dac) sq!.on = false;
        break;
      case 0x03: case 0x08:
        sq!.freq = (sq!.freq & 0x700) | v;
        break;
      case 0x04: case 0x09:
        sq!.freq = (sq!.freq & 0xff) | ((v & 7) << 8);
        this.lenEnableQuirk(sq!, v);
        if (v & 0x80) this.triggerSquare(sq!);
        break;
      // --- wave channel (NR30-NR34) ---
      case 0x0a:
        this.wv.dac = (v & 0x80) !== 0;
        if (!this.wv.dac) this.wv.on = false;
        break;
      case 0x0b: this.wv.len = 256 - v; break;
      case 0x0c: this.wv.volCode = (v >> 5) & 3; break;
      case 0x0d: this.wv.freq = (this.wv.freq & 0x700) | v; break;
      case 0x0e:
        this.wv.freq = (this.wv.freq & 0xff) | ((v & 7) << 8);
        this.lenEnableQuirk(this.wv, v);
        if (v & 0x80) {
          const w = this.wv;
          w.on = w.dac;
          if (w.len === 0) {
            w.len = 256;
            if (w.lenOn && this.nextStepNoLength()) w.len--;
          }
          w.timer = (2048 - w.freq) << 1;
          w.pos = 0;
        }
        break;
      // --- noise channel (NR41-NR44) ---
      case 0x10: this.ns.len = 64 - (v & 0x3f); break;
      case 0x11:
        this.ns.vol = v >> 4;
        this.ns.envDir = (v >> 3) & 1;
        this.ns.envPer = v & 7;
        this.ns.dac = (v & 0xf8) !== 0;
        if (!this.ns.dac) this.ns.on = false;
        break;
      case 0x12:
        this.ns.shift = v >> 4;
        this.ns.width7 = (v & 8) !== 0;
        this.ns.div = v & 7;
        break;
      case 0x13:
        this.lenEnableQuirk(this.ns, v);
        if (v & 0x80) {
          const n = this.ns;
          n.on = n.dac;
          if (n.len === 0) {
            n.len = 64;
            if (n.lenOn && this.nextStepNoLength()) n.len--;
          }
          n.timer = NOISE_DIVISOR[n.div] << n.shift;
          n.lfsr = 0x7fff;
          n.envTimer = n.envPer;
          n.vol = this.regs[0x11] >> 4;
        }
        break;
    }
    // Envelope registers also latch initial volume for the squares
    if (i === 0x02) { this.sq[0].envDir = (v >> 3) & 1; this.sq[0].envPer = v & 7; }
    if (i === 0x07) { this.sq[1].envDir = (v >> 3) & 1; this.sq[1].envPer = v & 7; }
  }

  /** True when the frame sequencer's next step does NOT clock length. */
  private nextStepNoLength(): boolean {
    return (this.fsStep & 1) === 1;
  }

  /**
   * Length-enable write quirk: a 0->1 transition while the next frame
   * sequencer step doesn't clock length gives one extra length clock.
   */
  private lenEnableQuirk(c: { len: number; lenOn: boolean; on: boolean }, v: number): void {
    const was = c.lenOn;
    c.lenOn = (v & 0x40) !== 0;
    if (!was && c.lenOn && this.nextStepNoLength() && c.len > 0) {
      if (--c.len === 0 && !(v & 0x80)) c.on = false;
    }
  }

  private triggerSquare(c: (typeof this.sq)[0]): void {
    c.on = c.dac;
    if (c.len === 0) {
      c.len = 64;
      if (c.lenOn && this.nextStepNoLength()) c.len--; // reload quirk
    }
    c.timer = (2048 - c.freq) << 2;
    const nr2 = c === this.sq[0] ? this.regs[0x02] : this.regs[0x07];
    c.vol = nr2 >> 4;
    c.envTimer = c.envPer;
    if (c === this.sq[0]) {
      c.shadow = c.freq;
      c.swTimer = c.swPer || 8;
      c.swOn = c.swPer > 0 || c.swShift > 0;
      c.swNegUsed = false;
      if (c.swShift > 0) this.sweepCalc(false); // immediate overflow check
    }
  }

  /**
   * Power off: clear every register and channel. Wave RAM survives, and on
   * DMG the length counters survive too (dmg_sound test 08).
   */
  private reset(): void {
    this.regs.fill(0);
    for (const c of this.sq) {
      c.on = c.dac = c.lenOn = c.swOn = c.swNegUsed = false;
      c.duty = c.pos = c.freq = c.vol = c.envDir = c.envPer = 0;
      c.swPer = c.swDir = c.swShift = c.shadow = 0;
    }
    const w = this.wv;
    w.on = w.dac = w.lenOn = false;
    w.freq = w.volCode = w.pos = 0;
    const n = this.ns;
    n.on = n.dac = n.lenOn = false;
    n.vol = n.envDir = n.envPer = n.shift = n.div = 0;
    n.width7 = false;
    n.lfsr = 0x7fff;
  }
}
