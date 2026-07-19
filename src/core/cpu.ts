import type { Bus } from "./bus";

/**
 * Sharp SM83 CPU — skeleton for roadmap step 2.
 *
 * The dispatch-table pattern is in place with a handful of opcodes implemented
 * as examples. Step 2 is filling in all 256 base + 256 CB-prefixed opcodes,
 * then passing Blargg's cpu_instrs (results arrive via Bus.onSerial, no PPU
 * needed). Cycle counts returned are T-cycles.
 */

const FLAG_Z = 0x80;
const FLAG_N = 0x40;
const FLAG_H = 0x20;
const FLAG_C = 0x10;

export class CPU {
  // 8-bit registers. F only ever holds its top 4 bits.
  a = 0x01; f = 0xb0; b = 0x00; c = 0x13;
  d = 0x00; e = 0xd8; h = 0x01; l = 0x4d;
  sp = 0xfffe;
  pc = 0x0100; // post-boot-ROM entry point
  ime = false;
  halted = false;

  constructor(private bus: Bus) {}

  // ---- helpers ----------------------------------------------------------

  fetch8(): number {
    const v = this.bus.read8(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  fetch16(): number {
    return this.fetch8() | (this.fetch8() << 8);
  }

  get hl(): number { return (this.h << 8) | this.l; }
  set hl(v: number) { this.h = (v >>> 8) & 0xff; this.l = v & 0xff; }

  setFlags(z: boolean, n: boolean, hf: boolean, cf: boolean): void {
    this.f = (z ? FLAG_Z : 0) | (n ? FLAG_N : 0) | (hf ? FLAG_H : 0) | (cf ? FLAG_C : 0);
  }

  add8(x: number, y: number): number {
    const r = x + y;
    this.setFlags((r & 0xff) === 0, false, (x & 0xf) + (y & 0xf) > 0xf, r > 0xff);
    return r & 0xff;
  }

  // ---- execution --------------------------------------------------------

  /** Execute one instruction; return T-cycles consumed. */
  step(): number {
    // TODO(step 3): interrupt dispatch goes here, before the fetch.
    if (this.halted) return 4;
    const op = this.fetch8();
    const handler = OPS[op];
    if (!handler) {
      throw new Error(
        `Unimplemented opcode 0x${op.toString(16).padStart(2, "0")} at ` +
        `0x${((this.pc - 1) & 0xffff).toString(16).padStart(4, "0")}`,
      );
    }
    return handler(this, this.bus);
  }
}

type OpHandler = (c: CPU, bus: Bus) => number;

/** One entry per opcode. Sparse until step 2 fills it in. */
const OPS: (OpHandler | undefined)[] = new Array(256);

OPS[0x00] = () => 4;                                              // NOP
OPS[0x3e] = c => { c.a = c.fetch8(); return 8; };                 // LD A, n
OPS[0x80] = c => { c.a = c.add8(c.a, c.b); return 4; };           // ADD A, B
OPS[0xc3] = c => { c.pc = c.fetch16(); return 16; };              // JP nn
OPS[0xe0] = (c, bus) => { bus.write8(0xff00 + c.fetch8(), c.a); return 12; }; // LDH (n), A
OPS[0xf3] = c => { c.ime = false; return 4; };                    // DI
OPS[0x76] = c => { c.halted = true; return 4; };                  // HALT
OPS[0x18] = c => {                                                // JR e
  const off = (c.fetch8() << 24) >> 24; // sign-extend
  c.pc = (c.pc + off) & 0xffff;
  return 12;
};
