/**
 * ARM7TDMI interpreter — GBA phase B, step 1.
 *
 * ARMv4T: the full 32-bit ARM set and the 16-bit Thumb set, banked
 * registers per mode, and the 3-stage pipeline modeled the cheap way:
 * r15 always reads as fetch+8 (ARM) / +4 (Thumb), +12/+8 where the
 * hardware exposes it (register-specified shifts, STR/STM of r15), and any
 * write to r15 flushes and refetches. Validated against the SingleStepTests
 * ARM7TDMI vectors (scripts/arm7-tests.ts).
 *
 * Dispatch: ARM uses a 4096-entry table indexed by bits 27-20 and 7-4;
 * Thumb uses a 256-entry table indexed by the top byte.
 */

export interface Arm7Bus {
  read8(addr: number): number;
  read16(addr: number): number;
  read32(addr: number): number;
  write8(addr: number, v: number): void;
  write16(addr: number, v: number): void;
  write32(addr: number, v: number): void;
  /** Instruction fetches (waitstate/open-bus behavior differs from data). */
  fetch16(addr: number): number;
  fetch32(addr: number): number;
}

// CPSR bits
const N = 0x80000000 | 0;
const Z = 0x40000000;
const C = 0x20000000;
const V = 0x10000000;
const T = 0x20;
const IRQ_DISABLE = 0x80;

// Modes (low 5 bits of CPSR)
export const enum Mode {
  Usr = 0x10, Fiq = 0x11, Irq = 0x12, Svc = 0x13,
  Abt = 0x17, Und = 0x1b, Sys = 0x1f,
}

export class ARM7 {
  /** Active register view. Unsigned values are obtained with `>>> 0`. */
  readonly r = new Int32Array(16);
  cpsr = Mode.Svc | IRQ_DISABLE;

  // Banked storage for inactive modes. bankUsr[0..4] holds the shared
  // r8-r12 while in FIQ mode; bankUsr[5..6] holds usr/sys r13-r14.
  readonly bankUsr = new Int32Array(7);
  readonly bankFiq = new Int32Array(7);
  readonly bankSvc = new Int32Array(2);
  readonly bankAbt = new Int32Array(2);
  readonly bankIrq = new Int32Array(2);
  readonly bankUnd = new Int32Array(2);
  spsrFiq = 0; spsrSvc = 0; spsrAbt = 0; spsrIrq = 0; spsrUnd = 0;

  /** pipeline[0] = next to execute, pipeline[1] = just fetched. */
  readonly pipeline = new Int32Array(2);

  private branched = false;
  // Barrel shifter output (fields to avoid allocation)
  private shVal = 0;
  private shCarry = 0;

  constructor(readonly bus: Arm7Bus) {}

  // ---- flags ------------------------------------------------------------

  get thumb(): boolean { return (this.cpsr & T) !== 0; }
  private get carry(): number { return (this.cpsr >>> 29) & 1; }

  /** Used by the Thumb handlers (through the internals shim) and the core. */
  setNZ(v: number): void {
    this.cpsr = (this.cpsr & 0x3fffffff) | (v & N) | ((v | 0) === 0 ? Z : 0);
  }

  private setNZCV(v: number, c: boolean, ov: boolean): void {
    this.cpsr = (this.cpsr & 0x0fffffff) | (v & N) | ((v | 0) === 0 ? Z : 0) |
      (c ? C : 0) | (ov ? V : 0);
  }

  private setNZC(v: number, c: number): void {
    this.cpsr = (this.cpsr & 0x1fffffff) | (v & N) | ((v | 0) === 0 ? Z : 0) | (c ? C : 0);
  }

  // ---- banking ----------------------------------------------------------

  // Bank selection uses the low 4 mode bits (matching the hardware's
  // treatment of invalid modes, which the tests exercise).
  private static bankOf(mode: number): number {
    switch (mode & 0xf) {
      case 0x1: return 1; // fiq
      case 0x2: return 4; // irq
      case 0x3: return 2; // svc
      case 0x7: return 3; // abt
      case 0xb: return 5; // und
      default: return 0;  // usr/sys and invalid modes
    }
  }

  private bank2(mode: number): Int32Array {
    switch (ARM7.bankOf(mode)) {
      case 2: return this.bankSvc;
      case 3: return this.bankAbt;
      case 4: return this.bankIrq;
      case 5: return this.bankUnd;
      default: return this.bankUsr; // r13/r14 live at [5],[6] for usr
    }
  }

  /** Swap banked registers when the CPSR mode changes. */
  switchMode(newMode: number): void {
    const old = this.cpsr & 0x1f;
    if (ARM7.bankOf(old) === ARM7.bankOf(newMode)) return;

    // Save the active set into the old mode's bank
    if (ARM7.bankOf(old) === 1) {
      for (let i = 0; i < 7; i++) this.bankFiq[i] = this.r[8 + i];
    } else {
      const b = this.bank2(old);
      if (b === this.bankUsr) { b[5] = this.r[13]; b[6] = this.r[14]; }
      else { b[0] = this.r[13]; b[1] = this.r[14]; }
      for (let i = 0; i < 5; i++) this.bankUsr[i] = this.r[8 + i];
    }
    // Load the new mode's bank into the active set
    if (ARM7.bankOf(newMode) === 1) {
      for (let i = 0; i < 7; i++) this.r[8 + i] = this.bankFiq[i];
    } else {
      for (let i = 0; i < 5; i++) this.r[8 + i] = this.bankUsr[i];
      const b = this.bank2(newMode);
      if (b === this.bankUsr) { this.r[13] = b[5]; this.r[14] = b[6]; }
      else { this.r[13] = b[0]; this.r[14] = b[1]; }
    }
  }

  private getSpsr(): number {
    switch (this.cpsr & 0x1f) {
      case Mode.Fiq: return this.spsrFiq;
      case Mode.Svc: return this.spsrSvc;
      case Mode.Abt: return this.spsrAbt;
      case Mode.Irq: return this.spsrIrq;
      case Mode.Und: return this.spsrUnd;
      default: return this.cpsr; // usr/sys have no SPSR
    }
  }

  private setSpsr(v: number, mask: number): void {
    const merge = (old: number): number => (old & ~mask) | (v & mask);
    switch (this.cpsr & 0x1f) {
      case Mode.Fiq: this.spsrFiq = merge(this.spsrFiq); break;
      case Mode.Svc: this.spsrSvc = merge(this.spsrSvc); break;
      case Mode.Abt: this.spsrAbt = merge(this.spsrAbt); break;
      case Mode.Irq: this.spsrIrq = merge(this.spsrIrq); break;
      case Mode.Und: this.spsrUnd = merge(this.spsrUnd); break;
    }
  }

  /** CPSR = SPSR of the current mode (S-bit ops writing r15, LDM^ with pc). */
  private restoreCpsr(): void {
    const s = this.getSpsr();
    this.switchMode(s & 0x1f);
    this.cpsr = s;
  }

  // ---- pipeline ---------------------------------------------------------

  /**
   * Write to r15: refill the pipeline and leave r15 at target+8 (ARM) or
   * +4 (Thumb). Fetch ADDRESSES are aligned, but the register keeps the raw
   * value — matching ARM7TDMI (and the SingleStepTests expectations).
   */
  branchTo(addr: number): void {
    if (this.thumb) {
      const a = addr & ~1;
      this.pipeline[0] = this.bus.fetch16(a >>> 0);
      this.pipeline[1] = this.bus.fetch16((a + 2) >>> 0);
      this.r[15] = (addr + 4) | 0;
    } else {
      const a = addr & ~3;
      this.pipeline[0] = this.bus.fetch32(a >>> 0);
      this.pipeline[1] = this.bus.fetch32((a + 4) >>> 0);
      this.r[15] = (addr + 8) | 0;
    }
    this.branched = true;
  }

  /** BX-style branch: bit 0 selects the instruction set (and is consumed). */
  private branchExchange(addr: number): void {
    if (addr & 1) {
      this.cpsr |= T;
      this.branchTo(addr & ~1);
    } else {
      this.cpsr &= ~T;
      this.branchTo(addr); // bit 1 is NOT masked in the register
    }
  }

  /** Register write that flushes when the target is r15. */
  private writeReg(i: number, v: number): void {
    if (i === 15) this.branchTo(v);
    else this.r[i] = v;
  }

  /**
   * Base writeback for single/halfword transfers. The hardware re-reads the
   * base after the PC has advanced, so a base of r15 writes back base+offset
   * computed from +12 — and, being an r15 write, flushes the pipeline.
   */
  private writeBackBase(i: number, addr: number): void {
    if (i === 15) this.branchTo((addr + 4) | 0);
    else this.r[i] = addr;
  }

  private exception(mode: number, vector: number, lrOffset: number): void {
    const oldCpsr = this.cpsr;
    this.switchMode(mode);
    this.cpsr = (this.cpsr & ~0x3f) | mode | IRQ_DISABLE; // also clears T
    switch (mode) {
      case Mode.Svc: this.spsrSvc = oldCpsr; break;
      case Mode.Und: this.spsrUnd = oldCpsr; break;
      case Mode.Irq: this.spsrIrq = oldCpsr; break;
      case Mode.Abt: this.spsrAbt = oldCpsr; break;
      case Mode.Fiq: this.spsrFiq = oldCpsr; break;
    }
    this.r[14] = (this.r[15] + lrOffset) | 0;
    this.branchTo(vector);
  }

  irq(): void {
    if (this.cpsr & IRQ_DISABLE) return;
    this.exception(Mode.Irq, 0x18, this.thumb ? 0 : -4);
  }

  // ---- execution --------------------------------------------------------

  /** Execute the instruction in pipeline[0]. */
  step(): void {
    const op = this.pipeline[0] | 0;
    this.pipeline[0] = this.pipeline[1];
    this.branched = false;
    if (this.thumb) {
      this.pipeline[1] = this.bus.fetch16(this.r[15] >>> 0);
      THUMB[(op >>> 8) & 0xff](this, op & 0xffff);
      if (!this.branched) this.r[15] = (this.r[15] + 2) | 0;
    } else {
      this.pipeline[1] = this.bus.fetch32(this.r[15] >>> 0);
      if (this.checkCond(op >>> 28)) {
        ARM[((op >> 16) & 0xff0) | ((op >> 4) & 0xf)](this, op);
      }
      if (!this.branched) this.r[15] = (this.r[15] + 4) | 0;
    }
  }

  private checkCond(cond: number): boolean {
    const f = this.cpsr;
    switch (cond) {
      case 0x0: return (f & Z) !== 0;
      case 0x1: return (f & Z) === 0;
      case 0x2: return (f & C) !== 0;
      case 0x3: return (f & C) === 0;
      case 0x4: return (f & N) !== 0;
      case 0x5: return (f & N) === 0;
      case 0x6: return (f & V) !== 0;
      case 0x7: return (f & V) === 0;
      case 0x8: return (f & C) !== 0 && (f & Z) === 0;
      case 0x9: return (f & C) === 0 || (f & Z) !== 0;
      case 0xa: return ((f ^ (f << 3)) & N) === 0;          // N == V
      case 0xb: return ((f ^ (f << 3)) & N) !== 0;          // N != V
      case 0xc: return (f & Z) === 0 && ((f ^ (f << 3)) & N) === 0;
      case 0xd: return (f & Z) !== 0 || ((f ^ (f << 3)) & N) !== 0;
      case 0xe: return true;
      default: return false; // 0xF: never (ARMv4)
    }
  }

  // ---- barrel shifter ----------------------------------------------------
  // Results land in shVal/shCarry (carry only consumed when the instruction
  // updates flags on a logical operation).

  /** Shift by immediate amount, with the amount==0 special encodings. */
  private shiftImm(type: number, value: number, amount: number): void {
    switch (type) {
      case 0: // LSL
        if (amount === 0) { this.shVal = value; this.shCarry = this.carry; }
        else { this.shVal = value << amount; this.shCarry = (value >>> (32 - amount)) & 1; }
        break;
      case 1: // LSR (0 => 32)
        if (amount === 0) { this.shVal = 0; this.shCarry = value >>> 31; }
        else { this.shVal = value >>> amount; this.shCarry = (value >>> (amount - 1)) & 1; }
        break;
      case 2: // ASR (0 => 32)
        if (amount === 0) { this.shVal = value >> 31; this.shCarry = value >>> 31; }
        else { this.shVal = value >> amount; this.shCarry = (value >>> (amount - 1)) & 1; }
        break;
      default: // ROR (0 => RRX)
        if (amount === 0) {
          this.shVal = (this.carry << 31) | (value >>> 1);
          this.shCarry = value & 1;
        } else {
          this.shVal = (value >>> amount) | (value << (32 - amount));
          this.shCarry = (value >>> (amount - 1)) & 1;
        }
        break;
    }
  }

  /** Shift by register amount (bottom byte of Rs); 0 keeps value and carry. */
  private shiftReg(type: number, value: number, amount: number): void {
    if (amount === 0) { this.shVal = value; this.shCarry = this.carry; return; }
    switch (type) {
      case 0: // LSL
        if (amount < 32) { this.shVal = value << amount; this.shCarry = (value >>> (32 - amount)) & 1; }
        else if (amount === 32) { this.shVal = 0; this.shCarry = value & 1; }
        else { this.shVal = 0; this.shCarry = 0; }
        break;
      case 1: // LSR
        if (amount < 32) { this.shVal = value >>> amount; this.shCarry = (value >>> (amount - 1)) & 1; }
        else if (amount === 32) { this.shVal = 0; this.shCarry = value >>> 31; }
        else { this.shVal = 0; this.shCarry = 0; }
        break;
      case 2: // ASR
        if (amount < 32) { this.shVal = value >> amount; this.shCarry = (value >>> (amount - 1)) & 1; }
        else { this.shVal = value >> 31; this.shCarry = value >>> 31; }
        break;
      default: { // ROR
        const n = amount & 31;
        if (n === 0) { this.shVal = value; this.shCarry = value >>> 31; }
        else { this.shVal = (value >>> n) | (value << (32 - n)); this.shCarry = (value >>> (n - 1)) & 1; }
        break;
      }
    }
  }

  // ---- ALU building blocks ----------------------------------------------

  private add(a: number, b: number, setFlags: boolean): number {
    const r = (a + b) | 0;
    if (setFlags) {
      this.setNZCV(r, (a >>> 0) + (b >>> 0) > 0xffffffff, ((~(a ^ b) & (a ^ r)) >>> 31) !== 0);
    }
    return r;
  }

  private adc(a: number, b: number, setFlags: boolean): number {
    const cin = this.carry;
    const r = (a + b + cin) | 0;
    if (setFlags) {
      this.setNZCV(r, (a >>> 0) + (b >>> 0) + cin > 0xffffffff, ((~(a ^ b) & (a ^ r)) >>> 31) !== 0);
    }
    return r;
  }

  private sub(a: number, b: number, setFlags: boolean): number {
    const r = (a - b) | 0;
    if (setFlags) {
      this.setNZCV(r, (a >>> 0) >= (b >>> 0), (((a ^ b) & (a ^ r)) >>> 31) !== 0);
    }
    return r;
  }

  private sbc(a: number, b: number, setFlags: boolean): number {
    const borrow = 1 - this.carry;
    const r = (a - b - borrow) | 0;
    if (setFlags) {
      this.setNZCV(r, (a >>> 0) >= (b >>> 0) + borrow, (((a ^ b) & (a ^ r)) >>> 31) !== 0);
    }
    return r;
  }

  // ---- ARM instruction implementations -----------------------------------
  // These are wired into the ARM dispatch table below. `op` is the raw
  // 32-bit opcode (as a signed int; use >>> for unsigned views).

  /** Data processing. i = immediate op2, rs = register-specified shift. */
  armDataProc(op: number, imm: boolean, regShift: boolean): void {
    const opcode = (op >> 21) & 0xf;
    const s = (op & 0x100000) !== 0;
    const rnIdx = (op >> 16) & 0xf;
    const rdIdx = (op >> 12) & 0xf;

    // Operand 2 through the shifter
    if (imm) {
      const rot = ((op >> 8) & 0xf) << 1;
      const val = op & 0xff;
      if (rot === 0) { this.shVal = val; this.shCarry = this.carry; }
      else {
        this.shVal = (val >>> rot) | (val << (32 - rot));
        this.shCarry = (this.shVal >>> 31) & 1;
      }
    } else {
      const rmIdx = op & 0xf;
      let rm = this.r[rmIdx];
      const type = (op >> 5) & 3;
      if (regShift) {
        if (rmIdx === 15) rm = (rm + 4) | 0;              // PC reads +12
        this.shiftReg(type, rm, this.r[(op >> 8) & 0xf] & 0xff);
      } else {
        this.shiftImm(type, rm, (op >> 7) & 0x1f);
      }
    }
    const op2 = this.shVal;

    let rn = this.r[rnIdx];
    if (rnIdx === 15 && regShift && !imm) rn = (rn + 4) | 0; // PC reads +12

    let result = 0;
    let writeback = true;
    switch (opcode) {
      case 0x0: result = rn & op2; if (s) this.setNZC(result, this.shCarry); break;          // AND
      case 0x1: result = rn ^ op2; if (s) this.setNZC(result, this.shCarry); break;          // EOR
      case 0x2: result = this.sub(rn, op2, s); break;                                        // SUB
      case 0x3: result = this.sub(op2, rn, s); break;                                        // RSB
      case 0x4: result = this.add(rn, op2, s); break;                                        // ADD
      case 0x5: result = this.adc(rn, op2, s); break;                                        // ADC
      case 0x6: result = this.sbc(rn, op2, s); break;                                        // SBC
      case 0x7: { const c0 = this.carry; const borrow = 1 - c0;                              // RSC
        result = (op2 - rn - borrow) | 0;
        if (s) this.setNZCV(result, (op2 >>> 0) >= (rn >>> 0) + borrow,
          (((op2 ^ rn) & (op2 ^ result)) >>> 31) !== 0);
        break; }
      case 0x8: result = rn & op2; this.setNZC(result, this.shCarry); writeback = false; break; // TST
      case 0x9: result = rn ^ op2; this.setNZC(result, this.shCarry); writeback = false; break; // TEQ
      case 0xa: this.sub(rn, op2, true); writeback = false; break;                              // CMP
      case 0xb: this.add(rn, op2, true); writeback = false; break;                              // CMN
      case 0xc: result = rn | op2; if (s) this.setNZC(result, this.shCarry); break;          // ORR
      case 0xd: result = op2; if (s) this.setNZC(result, this.shCarry); break;               // MOV
      case 0xe: result = rn & ~op2; if (s) this.setNZC(result, this.shCarry); break;         // BIC
      default: result = ~op2; if (s) this.setNZC(result, this.shCarry); break;               // MVN
    }

    if (s && rdIdx === 15) this.restoreCpsr(); // may switch mode and set/clear T
    if (writeback) {
      if (rdIdx === 15) this.branchTo(result);
      else this.r[rdIdx] = result;
    } else if (s && rdIdx === 15) {
      // TST/TEQ/CMP/CMN with Rd=15: CPSR restore already applied, no branch.
    }
  }

  // ---- multiplier carry-flag model ---------------------------------------
  // The ARM7TDMI's multiplier destroys C with the internal carry of its
  // booth-recoded carry-save array. Algorithms ported from NanoBoyAdvance
  // (which the test vectors were generated from); the carry algorithm is
  // Copyright (C) 2024 zaydlang, calc84maniac (zlib-style license), used in
  // altered form. JS's shift-count masking (&31) matches x86, which the
  // reference relies on.

  /** True when the multiplier used all four internal cycles. */
  private static tickMultiply(multiplier: number, signed: boolean): boolean {
    let mask = 0xffffff00 | 0;
    for (;;) {
      multiplier = multiplier & mask;
      if (multiplier === 0) break;
      if (signed && multiplier === mask) break;
      mask = (mask << 8) | 0;
      if (mask === 0) { if ((multiplier & mask) === 0) break; }
    }
    return mask === 0;
  }

  private static mulCarrySimple(multiplier: number): number {
    // Final booth addend is negative only if the upper 2 bits are 10.
    return (multiplier >>> 30) === 2 ? 1 : 0;
  }

  private static mulCarryLo(multiplicand: number, multiplier: number, accum: number): number {
    multiplicand |= 1;
    let booth = (multiplier << 31) >> 31;
    let carry = Math.imul(multiplicand, booth) | 0;
    let sum = (carry + accum) | 0;
    let shift = 29;
    do {
      for (let i = 0; i < 4; i++, shift -= 2) {
        const nextBooth = (multiplier << shift) >> shift;
        const factor = (nextBooth - booth) | 0;
        booth = nextBooth;
        const addend = Math.imul(multiplicand, factor) | 0;
        accum = (accum ^ carry ^ addend) | 0;
        sum = (sum + addend) | 0;
        carry = (sum - accum) | 0;
      }
    } while (booth !== (multiplier | 0));
    return carry >>> 31;
  }

  private static mulCarryHi(
    multiplicand: number, multiplier: number, accumHi: number, signExtend: boolean,
  ): number {
    if (signExtend) {
      multiplicand = multiplicand >> 6;
      multiplier = multiplier >> 26;
    } else {
      multiplicand = multiplicand >>> 6;
      multiplier = multiplier >>> 26;
    }
    multiplicand |= 1;
    const carry = ~accumHi & 0x20000000;
    let accum = (accumHi - 0x08000000) | 0;
    const booth0 = (multiplier << 27) >> 27;
    const booth1 = (multiplier << 29) >> 29;
    const booth2 = (multiplier << 31) >> 31;
    const factor0 = (multiplier - booth0) | 0;
    const factor1 = (booth0 - booth1) | 0;
    const factor2 = (booth1 - booth2) | 0;
    let addend = Math.imul(multiplicand, factor2) | 0;
    accum = (accum - (addend & 0x10000000)) | 0;
    addend = Math.imul(multiplicand, factor1) | 0;
    accum = (accum - (addend & 0x40000000)) | 0;
    let sum = (accum + (addend & 0x20000000)) | 0;
    accum = (accum - carry) | 0;
    addend = Math.imul(multiplicand, factor0) | 0;
    sum = (sum + (addend & 0x40000000)) | 0;
    return (sum ^ accum) >>> 31;
  }

  /** Multiply operand read: r15 reads as +12 (extra internal cycle). */
  private mulReg(i: number): number {
    return i === 15 ? (this.r[15] + 4) | 0 : this.r[i];
  }

  armMultiply(op: number): void {
    const rd = (op >> 16) & 0xf;
    const acc = (op & 0x200000) !== 0;
    const lhs = this.mulReg(op & 0xf);
    const rhs = this.mulReg((op >> 8) & 0xf);
    const accum = acc ? this.mulReg((op >> 12) & 0xf) : 0;
    const result = (Math.imul(lhs, rhs) + accum) | 0;
    this.writeReg(rd, result);
    if (op & 0x100000) {
      const carry = ARM7.tickMultiply(rhs, true)
        ? ARM7.mulCarrySimple(rhs)
        : ARM7.mulCarryLo(lhs, rhs, accum);
      // S: N/Z from the result, C from the multiplier array, V preserved
      this.cpsr = (this.cpsr & 0x1fffffff) | (result & N) |
        ((result | 0) === 0 ? Z : 0) | (carry ? C : 0);
    }
  }

  armMultiplyLong(op: number): void {
    const rdHi = (op >> 16) & 0xf;
    const rdLo = (op >> 12) & 0xf;
    const signed = (op & 0x400000) !== 0;
    const acc = (op & 0x200000) !== 0;
    const lhs = this.mulReg(op & 0xf);
    const rhs = this.mulReg((op >> 8) & 0xf);
    const accLo = acc ? this.mulReg(rdLo) : 0;
    const accHi = acc ? this.mulReg(rdHi) : 0;
    const a = signed ? BigInt(lhs) : BigInt(lhs >>> 0);
    const b = signed ? BigInt(rhs) : BigInt(rhs >>> 0);
    let product = a * b;
    if (acc) product += (BigInt(accHi >>> 0) << 32n) | BigInt(accLo >>> 0);
    const lo = Number(product & 0xffffffffn) | 0;
    const hi = Number((product >> 32n) & 0xffffffffn) | 0;
    this.writeReg(rdLo, lo);
    this.writeReg(rdHi, hi);
    if (op & 0x100000) {
      const carry = ARM7.tickMultiply(rhs, signed)
        ? ARM7.mulCarryHi(lhs, rhs, accHi, signed)
        : ARM7.mulCarryLo(lhs, rhs, accLo);
      // S: N/Z from the 64-bit result, C from the multiplier, V preserved
      this.cpsr = (this.cpsr & 0x1fffffff) | (hi & N) |
        ((hi | 0) === 0 && (lo | 0) === 0 ? Z : 0) | (carry ? C : 0);
    }
  }

  armMrs(op: number): void {
    const value = op & 0x400000 ? this.getSpsr() : this.cpsr;
    this.r[(op >> 12) & 0xf] = value;
  }

  armMsr(op: number, imm: boolean): void {
    let value: number;
    if (imm) {
      const rot = ((op >> 8) & 0xf) << 1;
      const v = op & 0xff;
      value = rot === 0 ? v : (v >>> rot) | (v << (32 - rot));
    } else {
      value = this.r[op & 0xf];
    }
    let mask = 0;
    if (op & 0x80000) mask |= 0xff000000 | 0; // f: flags
    if (op & 0x40000) mask |= 0x00ff0000;     // s
    if (op & 0x20000) mask |= 0x0000ff00;     // x
    if (op & 0x10000) mask |= 0x000000ff;     // c: control (privileged only)

    if (op & 0x400000) {
      this.setSpsr(value, mask);
    } else {
      if ((this.cpsr & 0x1f) === Mode.Usr) mask &= 0xff000000 | 0;
      value |= 0x10; // mode bit 4 is hardwired to 1
      if (mask & 0xff) this.switchMode(value & 0x1f);
      this.cpsr = (this.cpsr & ~mask) | (value & mask);
    }
  }

  armBranch(op: number, link: boolean): void {
    const offset = (op << 8) >> 6; // sign-extend 24 bits, then <<2
    if (link) this.r[14] = (this.r[15] - 4) | 0;
    this.branchTo((this.r[15] + offset) | 0);
  }

  armBx(op: number): void {
    this.branchExchange(this.r[op & 0xf]);
  }

  /** LDR/STR word/byte with immediate or (immediate-shifted) register offset. */
  armSingleTransfer(op: number, regOffset: boolean): void {
    const pre = (op & 0x1000000) !== 0;
    const up = (op & 0x800000) !== 0;
    const byte = (op & 0x400000) !== 0;
    const wb = (op & 0x200000) !== 0;
    const load = (op & 0x100000) !== 0;
    const rnIdx = (op >> 16) & 0xf;
    const rdIdx = (op >> 12) & 0xf;

    let offset: number;
    if (regOffset) {
      this.shiftImm((op >> 5) & 3, this.r[op & 0xf], (op >> 7) & 0x1f);
      offset = this.shVal;
    } else {
      offset = op & 0xfff;
    }
    if (!up) offset = -offset;

    const base = this.r[rnIdx];
    const addr = pre ? (base + offset) | 0 : base;
    const wbAddr = (base + offset) | 0;

    if (load) {
      let value: number;
      if (byte) value = this.bus.read8(addr >>> 0);
      else {
        value = this.bus.read32((addr & ~3) >>> 0);
        const rot = (addr & 3) << 3;
        if (rot !== 0) value = (value >>> rot) | (value << (32 - rot));
      }
      if (!pre || wb) this.writeBackBase(rnIdx, wbAddr);
      if (rdIdx === 15) this.branchTo(value);
      else this.r[rdIdx] = value;
    } else {
      let value = this.r[rdIdx];
      if (rdIdx === 15) value = (value + 4) | 0; // STR pc stores +12
      if (byte) this.bus.write8(addr >>> 0, value & 0xff);
      else this.bus.write32((addr & ~3) >>> 0, value | 0);
      if (!pre || wb) this.writeBackBase(rnIdx, wbAddr);
    }
  }

  /** LDRH/STRH/LDRSB/LDRSH. */
  armHalfTransfer(op: number): void {
    const pre = (op & 0x1000000) !== 0;
    const up = (op & 0x800000) !== 0;
    const immOff = (op & 0x400000) !== 0;
    const wb = (op & 0x200000) !== 0;
    const load = (op & 0x100000) !== 0;
    const rnIdx = (op >> 16) & 0xf;
    const rdIdx = (op >> 12) & 0xf;
    const kind = (op >> 5) & 3; // 1=H, 2=SB, 3=SH

    let offset = immOff ? ((op >> 4) & 0xf0) | (op & 0xf) : this.r[op & 0xf];
    if (!up) offset = -offset;

    const base = this.r[rnIdx];
    const addr = pre ? (base + offset) | 0 : base;
    const wbAddr = (base + offset) | 0;

    if (load) {
      let value: number;
      switch (kind) {
        case 1: { // LDRH — unaligned rotates like LDR
          value = this.bus.read16((addr & ~1) >>> 0);
          if (addr & 1) value = ((value >>> 8) | (value << 24)) | 0;
          break;
        }
        case 2: value = (this.bus.read8(addr >>> 0) << 24) >> 24; break; // LDRSB
        default: { // LDRSH — misaligned sign-extends the aligned high byte
          const half = this.bus.read16((addr & ~1) >>> 0);
          value = addr & 1 ? (half << 16) >> 24 : (half << 16) >> 16;
          break;
        }
      }
      if (!pre || wb) this.writeBackBase(rnIdx, wbAddr);
      if (rdIdx === 15) this.branchTo(value);
      else this.r[rdIdx] = value;
    } else { // STRH only
      let value = this.r[rdIdx];
      if (rdIdx === 15) value = (value + 4) | 0;
      this.bus.write16((addr & ~1) >>> 0, value & 0xffff);
      if (!pre || wb) this.writeBackBase(rnIdx, wbAddr);
    }
  }

  armBlockTransfer(op: number): void {
    const pre = (op & 0x1000000) !== 0;
    const up = (op & 0x800000) !== 0;
    const sBit = (op & 0x400000) !== 0;
    let wb = (op & 0x200000) !== 0;
    const load = (op & 0x100000) !== 0;
    const rnIdx = (op >> 16) & 0xf;
    let list = op & 0xffff;

    // Empty list quirk: transfers r15 only and moves the base by 0x40
    let emptyList = false;
    if (list === 0) {
      list = 0x8000;
      emptyList = true;
    }
    let count = 0;
    for (let i = 0; i < 16; i++) if (list & (1 << i)) count++;
    const bytes = emptyList ? 0x40 : count * 4;

    const base = this.r[rnIdx];
    let addr: number;
    if (up) addr = pre ? (base + 4) | 0 : base;
    else addr = pre ? (base - bytes) | 0 : (base - bytes + 4) | 0;
    const newBase = up ? (base + bytes) | 0 : (base - bytes) | 0;

    // S-bit without r15-load: transfer the USER bank
    const userTransfer = sBit && !(load && (list & 0x8000));
    const oldMode = this.cpsr & 0x1f;
    if (userTransfer && oldMode !== Mode.Usr && oldMode !== Mode.Sys) {
      this.switchMode(Mode.Usr);
      this.cpsr = (this.cpsr & ~0x1f) | Mode.Usr;
    }

    if (load) {
      if (wb) this.writeReg(rnIdx, newBase); // loaded value may overwrite below
      for (let i = 0; i < 16; i++) {
        if (!(list & (1 << i))) continue;
        const value = this.bus.read32((addr & ~3) >>> 0);
        if (i === 15) {
          if (sBit) this.restoreCpsr();
          this.branchTo(value);
        } else {
          this.r[i] = value;
        }
        addr = (addr + 4) | 0;
      }
    } else {
      let first = true;
      for (let i = 0; i < 16; i++) {
        if (!(list & (1 << i))) continue;
        let value = this.r[i];
        if (i === 15) value = (value + 4) | 0;           // STM stores pc+12
        if (i === rnIdx && !first) value = newBase;      // base stored after wb
        this.bus.write32((addr & ~3) >>> 0, value | 0);
        addr = (addr + 4) | 0;
        if (wb) { this.writeReg(rnIdx, newBase); wb = false; } // wb after first store
        first = false;
      }
      if (wb) this.writeReg(rnIdx, newBase);
    }

    if (userTransfer && oldMode !== Mode.Usr && oldMode !== Mode.Sys) {
      this.switchMode(oldMode);
      this.cpsr = (this.cpsr & ~0x1f) | oldMode;
    }
  }

  armSwap(op: number): void {
    const byte = (op & 0x400000) !== 0;
    // All register reads happen after the PC advance (+12 for r15)
    const addr = this.mulReg((op >> 16) & 0xf);
    const rd = (op >> 12) & 0xf;
    const src = this.mulReg(op & 0xf);
    if (byte) {
      const value = this.bus.read8(addr >>> 0);
      this.bus.write8(addr >>> 0, src & 0xff);
      this.writeReg(rd, value);
    } else {
      let value = this.bus.read32((addr & ~3) >>> 0);
      const rot = (addr & 3) << 3;
      if (rot !== 0) value = (value >>> rot) | (value << (32 - rot));
      this.bus.write32((addr & ~3) >>> 0, src | 0);
      this.writeReg(rd, value);
    }
  }

  armSwi(): void {
    this.exception(Mode.Svc, 0x08, -4);
  }

  armUndefined(): void {
    this.exception(Mode.Und, 0x04, -4);
  }

  // ---- state import/export (test harness + save states) ------------------

  // The SingleStepTests convention: `R` is the USER-view register file and
  // R_fiq/R_svc/... are the banked sets, regardless of the current mode.
  // Internally the active set lives in `this.r`, so import overlays the
  // current mode's bank onto the active view and export reverses it.

  setState(s: {
    R: number[]; R_fiq: number[]; R_svc: number[]; R_abt: number[];
    R_irq: number[]; R_und: number[]; CPSR: number; SPSR: number[];
    pipeline: number[];
  }): void {
    this.cpsr = s.CPSR | 0;
    const mode = this.cpsr & 0x1f;
    for (let i = 0; i < 16; i++) this.r[i] = s.R[i] | 0;
    for (let i = 0; i < 5; i++) this.bankUsr[i] = s.R[8 + i] | 0;
    this.bankUsr[5] = s.R[13] | 0;
    this.bankUsr[6] = s.R[14] | 0;
    for (let i = 0; i < 7; i++) this.bankFiq[i] = s.R_fiq[i] | 0;
    for (let i = 0; i < 2; i++) {
      this.bankSvc[i] = s.R_svc[i] | 0;
      this.bankAbt[i] = s.R_abt[i] | 0;
      this.bankIrq[i] = s.R_irq[i] | 0;
      this.bankUnd[i] = s.R_und[i] | 0;
    }
    // Overlay the active mode's banked registers
    const bank = ARM7.bankOf(mode);
    if (bank === 1) {
      for (let i = 0; i < 7; i++) this.r[8 + i] = this.bankFiq[i];
    } else if (bank !== 0) {
      const b = this.bank2(mode);
      this.r[13] = b[0];
      this.r[14] = b[1];
    }
    this.spsrFiq = s.SPSR[0] | 0;
    this.spsrSvc = s.SPSR[1] | 0;
    this.spsrAbt = s.SPSR[2] | 0;
    this.spsrIrq = s.SPSR[3] | 0;
    this.spsrUnd = s.SPSR[4] | 0;
    this.pipeline[0] = s.pipeline[0] | 0;
    this.pipeline[1] = s.pipeline[1] | 0;
  }

  getState(): {
    R: number[]; R_fiq: number[]; R_svc: number[]; R_abt: number[];
    R_irq: number[]; R_und: number[]; CPSR: number; SPSR: number[];
    pipeline: number[];
  } {
    const u = (x: number): number => x >>> 0;
    const mode = this.cpsr & 0x1f;
    const R = Array.from(this.r, u);
    let R_fiq = Array.from(this.bankFiq, u);
    let R_svc = Array.from(this.bankSvc, u);
    let R_abt = Array.from(this.bankAbt, u);
    let R_irq = Array.from(this.bankIrq, u);
    let R_und = Array.from(this.bankUnd, u);
    const bank = ARM7.bankOf(mode);
    if (bank === 1) {
      R_fiq = [u(this.r[8]), u(this.r[9]), u(this.r[10]), u(this.r[11]), u(this.r[12]), u(this.r[13]), u(this.r[14])];
      for (let i = 0; i < 5; i++) R[8 + i] = u(this.bankUsr[i]);
      R[13] = u(this.bankUsr[5]);
      R[14] = u(this.bankUsr[6]);
    } else if (bank !== 0) {
      const active = [u(this.r[13]), u(this.r[14])];
      if (bank === 2) R_svc = active;
      else if (bank === 3) R_abt = active;
      else if (bank === 4) R_irq = active;
      else R_und = active;
      R[13] = u(this.bankUsr[5]);
      R[14] = u(this.bankUsr[6]);
    }
    return {
      R, R_fiq, R_svc, R_abt, R_irq, R_und,
      CPSR: this.cpsr >>> 0,
      SPSR: [u(this.spsrFiq), u(this.spsrSvc), u(this.spsrAbt), u(this.spsrIrq), u(this.spsrUnd)],
      pipeline: [this.pipeline[0] >>> 0, this.pipeline[1] >>> 0],
    };
  }
}

// ---- ARM dispatch table ---------------------------------------------------

type ArmHandler = (c: ARM7, op: number) => void;

const ARM: ArmHandler[] = new Array(4096);

for (let idx = 0; idx < 4096; idx++) {
  const hi = idx >> 4;   // opcode bits 27-20
  const lo = idx & 0xf;  // opcode bits 7-4

  let h: ArmHandler;
  if ((hi & 0xfc) === 0x00 && lo === 0x9) {
    h = (c, op) => c.armMultiply(op);
  } else if ((hi & 0xf8) === 0x08 && lo === 0x9) {
    h = (c, op) => c.armMultiplyLong(op);
  } else if ((hi & 0xfb) === 0x10 && lo === 0x9) {
    h = (c, op) => c.armSwap(op);
  } else if (hi === 0x12 && lo === 0x1) {
    h = (c, op) => c.armBx(op);
  } else if ((hi & 0xe0) === 0x00 && (lo & 0x9) === 0x9 && (lo & 0x6) !== 0) {
    h = (c, op) => c.armHalfTransfer(op);
  } else if ((hi & 0xfb) === 0x10 && lo === 0x0) {
    h = (c, op) => c.armMrs(op);
  } else if ((hi & 0xfb) === 0x12 && lo === 0x0) {
    h = (c, op) => c.armMsr(op, false);
  } else if ((hi & 0xfb) === 0x32) {
    h = (c, op) => c.armMsr(op, true);
  } else if ((hi & 0xe0) === 0x00) {
    // Data processing. TST/TEQ/CMP/CMN without S are the PSR ops above;
    // anything left in that hole is undefined.
    const opcode = (hi >> 1) & 0xf;
    const s = (hi & 1) !== 0;
    if (!s && opcode >= 8 && opcode <= 0xb) {
      h = c => c.armUndefined();
    } else if ((lo & 1) !== 0 && (lo & 8) !== 0) {
      h = c => c.armUndefined(); // bit7&bit4 set but not mul/hw: invalid
    } else {
      const regShift = (lo & 1) !== 0;
      h = (c, op) => c.armDataProc(op, false, regShift);
    }
  } else if ((hi & 0xe0) === 0x20) {
    const opcode = (hi >> 1) & 0xf;
    const s = (hi & 1) !== 0;
    if (!s && opcode >= 8 && opcode <= 0xb) {
      h = c => c.armUndefined(); // covered by MSR imm above except stray combos
    } else {
      h = (c, op) => c.armDataProc(op, true, false);
    }
  } else if ((hi & 0xe0) === 0x40) {
    h = (c, op) => c.armSingleTransfer(op, false);
  } else if ((hi & 0xe0) === 0x60) {
    if (lo & 1) h = c => c.armUndefined();
    else h = (c, op) => c.armSingleTransfer(op, true);
  } else if ((hi & 0xe0) === 0x80) {
    h = (c, op) => c.armBlockTransfer(op);
  } else if ((hi & 0xe0) === 0xa0) {
    const link = (hi & 0x10) !== 0;
    h = (c, op) => c.armBranch(op, link);
  } else if ((hi & 0xf0) === 0xf0) {
    h = c => c.armSwi();
  } else {
    h = c => c.armUndefined(); // coprocessor space (LDC/STC/CDP/MCR/MRC)
  }
  ARM[idx] = h;
}

// ---- Thumb dispatch table -------------------------------------------------
// Handlers receive the 16-bit opcode. They reuse the ARM building blocks
// through public-ish methods on the class where practical.

type ThumbHandler = (c: ARM7, op: number) => void;

const THUMB: ThumbHandler[] = new Array(256);

// The Thumb handlers need access to a few private helpers; they are defined
// as closures over the class via casts kept in one place.
interface Arm7Internals {
  shVal: number;
  shCarry: number;
  shiftImm(type: number, value: number, amount: number): void;
  shiftReg(type: number, value: number, amount: number): void;
  add(a: number, b: number, s: boolean): number;
  adc(a: number, b: number, s: boolean): number;
  sub(a: number, b: number, s: boolean): number;
  sbc(a: number, b: number, s: boolean): number;
  setNZ(v: number): void;
  setNZC(v: number, c: number): void;
  branchExchange(addr: number): void;
  exception(mode: number, vector: number, lrOffset: number): void;
}
const priv = (c: ARM7): Arm7Internals => c as unknown as Arm7Internals;

for (let b = 0; b < 256; b++) {
  let h: ThumbHandler;

  if (b < 0x18) {
    // Format 1: LSL/LSR/ASR Rd, Rs, #imm5
    const type = b >> 3;
    h = (c, op) => {
      const p = priv(c);
      p.shiftImm(type, c.r[(op >> 3) & 7], (op >> 6) & 0x1f);
      c.r[op & 7] = p.shVal;
      p.setNZC(p.shVal, p.shCarry);
    };
  } else if (b < 0x20) {
    // Format 2: ADD/SUB Rd, Rs, Rn/#imm3
    const sub = (b & 2) !== 0;
    const imm = (b & 4) !== 0;
    h = (c, op) => {
      const p = priv(c);
      const a = c.r[(op >> 3) & 7];
      const bval = imm ? (op >> 6) & 7 : c.r[(op >> 6) & 7];
      c.r[op & 7] = sub ? p.sub(a, bval, true) : p.add(a, bval, true);
    };
  } else if (b < 0x40) {
    // Format 3: MOV/CMP/ADD/SUB Rd, #imm8
    const opc = (b >> 3) & 3;
    const rd = b & 7;
    h = (c, op) => {
      const p = priv(c);
      const imm = op & 0xff;
      switch (opc) {
        case 0: c.r[rd] = imm; p.setNZ(imm); break;
        case 1: p.sub(c.r[rd], imm, true); break;
        case 2: c.r[rd] = p.add(c.r[rd], imm, true); break;
        default: c.r[rd] = p.sub(c.r[rd], imm, true); break;
      }
    };
  } else if (b < 0x44) {
    // Format 4: ALU operations
    h = (c, op) => {
      const p = priv(c);
      const rd = op & 7;
      const rs = (op >> 3) & 7;
      const a = c.r[rd];
      const bv = c.r[rs];
      switch ((op >> 6) & 0xf) {
        case 0x0: c.r[rd] = a & bv; p.setNZ(c.r[rd]); break;                 // AND
        case 0x1: c.r[rd] = a ^ bv; p.setNZ(c.r[rd]); break;                 // EOR
        case 0x2: p.shiftReg(0, a, bv & 0xff); c.r[rd] = p.shVal; p.setNZC(p.shVal, p.shCarry); break; // LSL
        case 0x3: p.shiftReg(1, a, bv & 0xff); c.r[rd] = p.shVal; p.setNZC(p.shVal, p.shCarry); break; // LSR
        case 0x4: p.shiftReg(2, a, bv & 0xff); c.r[rd] = p.shVal; p.setNZC(p.shVal, p.shCarry); break; // ASR
        case 0x5: c.r[rd] = p.adc(a, bv, true); break;                       // ADC
        case 0x6: c.r[rd] = p.sbc(a, bv, true); break;                       // SBC
        case 0x7: p.shiftReg(3, a, bv & 0xff); c.r[rd] = p.shVal; p.setNZC(p.shVal, p.shCarry); break; // ROR
        case 0x8: p.setNZ(a & bv); break;                                    // TST
        case 0x9: c.r[rd] = p.sub(0, bv, true); break;                       // NEG
        case 0xa: p.sub(a, bv, true); break;                                 // CMP
        case 0xb: p.add(a, bv, true); break;                                 // CMN
        case 0xc: c.r[rd] = a | bv; p.setNZ(c.r[rd]); break;                 // ORR
        case 0xd: { // MUL — multiplicand = Rs, multiplier = old Rd
          const r = Math.imul(bv, a);
          c.r[rd] = r;
          const arm7 = ARM7 as unknown as {
            tickMultiply(m: number, s: boolean): boolean;
            mulCarrySimple(m: number): number;
            mulCarryLo(x: number, m: number, acc: number): number;
          };
          const mc = arm7.tickMultiply(a, true)
            ? arm7.mulCarrySimple(a)
            : arm7.mulCarryLo(bv, a, 0);
          p.setNZC(r, mc);
          break;
        }
        case 0xe: c.r[rd] = a & ~bv; p.setNZ(c.r[rd]); break;                // BIC
        default: c.r[rd] = ~bv; p.setNZ(c.r[rd]); break;                     // MVN
      }
    };
  } else if (b < 0x48) {
    // Format 5: hi-register ADD/CMP/MOV and BX
    h = (c, op) => {
      const p = priv(c);
      const rd = (op & 7) | ((op >> 4) & 8);
      const rs = ((op >> 3) & 7) | ((op >> 3) & 8);
      const bv = c.r[rs];
      switch ((op >> 8) & 3) {
        case 0: { // ADD (no flags)
          const result = (c.r[rd] + bv) | 0;
          if (rd === 15) c.branchTo(result & ~1);
          else c.r[rd] = result;
          break;
        }
        case 1: p.sub(c.r[rd], bv, true); break; // CMP
        case 2:
          if (rd === 15) c.branchTo(bv & ~1);
          else c.r[rd] = bv;
          break;
        default: p.branchExchange(bv); break;    // BX
      }
    };
  } else if (b < 0x50) {
    // Format 6: LDR Rd, [PC, #imm8*4]
    const rd = b & 7;
    h = (c, op) => {
      const addr = ((c.r[15] & ~2) + ((op & 0xff) << 2)) | 0;
      c.r[rd] = c.bus.read32((addr & ~3) >>> 0);
    };
  } else if (b < 0x60) {
    // Formats 7/8: load/store with register offset
    h = (c, op) => {
      const addr = (c.r[(op >> 3) & 7] + c.r[(op >> 6) & 7]) | 0;
      const rd = op & 7;
      switch ((op >> 9) & 7) {
        case 0: c.bus.write32((addr & ~3) >>> 0, c.r[rd] | 0); break;        // STR
        case 1: c.bus.write16((addr & ~1) >>> 0, c.r[rd] & 0xffff); break;   // STRH
        case 2: c.bus.write8(addr >>> 0, c.r[rd] & 0xff); break;             // STRB
        case 3: c.r[rd] = (c.bus.read8(addr >>> 0) << 24) >> 24; break;      // LDRSB
        case 4: { // LDR (rotated)
          let v = c.bus.read32((addr & ~3) >>> 0);
          const rot = (addr & 3) << 3;
          if (rot !== 0) v = (v >>> rot) | (v << (32 - rot));
          c.r[rd] = v;
          break;
        }
        case 5: { // LDRH (rotated on misalign)
          let v = c.bus.read16((addr & ~1) >>> 0);
          if (addr & 1) v = ((v >>> 8) | (v << 24)) | 0;
          c.r[rd] = v;
          break;
        }
        case 6: c.r[rd] = c.bus.read8(addr >>> 0); break;                    // LDRB
        default: { // LDRSH — misaligned sign-extends the aligned high byte
          const half = c.bus.read16((addr & ~1) >>> 0);
          c.r[rd] = addr & 1 ? (half << 16) >> 24 : (half << 16) >> 16;
          break;
        }
      }
    };
  } else if (b < 0x80) {
    // Format 9: LDR/STR word/byte with imm5 offset
    const byte = (b & 0x10) !== 0;
    const load = (b & 0x08) !== 0;
    h = (c, op) => {
      const rd = op & 7;
      const base = c.r[(op >> 3) & 7];
      const imm = (op >> 6) & 0x1f;
      if (byte) {
        const addr = (base + imm) | 0;
        if (load) c.r[rd] = c.bus.read8(addr >>> 0);
        else c.bus.write8(addr >>> 0, c.r[rd] & 0xff);
      } else {
        const addr = (base + (imm << 2)) | 0;
        if (load) {
          let v = c.bus.read32((addr & ~3) >>> 0);
          const rot = (addr & 3) << 3;
          if (rot !== 0) v = (v >>> rot) | (v << (32 - rot));
          c.r[rd] = v;
        } else {
          c.bus.write32((addr & ~3) >>> 0, c.r[rd] | 0);
        }
      }
    };
  } else if (b < 0x90) {
    // Format 10: LDRH/STRH with imm5 offset
    const load = (b & 0x08) !== 0;
    h = (c, op) => {
      const rd = op & 7;
      const addr = (c.r[(op >> 3) & 7] + (((op >> 6) & 0x1f) << 1)) | 0;
      if (load) {
        let v = c.bus.read16((addr & ~1) >>> 0);
        if (addr & 1) v = ((v >>> 8) | (v << 24)) | 0;
        c.r[rd] = v;
      } else {
        c.bus.write16((addr & ~1) >>> 0, c.r[rd] & 0xffff);
      }
    };
  } else if (b < 0xa0) {
    // Format 11: SP-relative LDR/STR
    const load = (b & 0x08) !== 0;
    const rd = b & 7;
    h = (c, op) => {
      const addr = (c.r[13] + ((op & 0xff) << 2)) | 0;
      if (load) {
        let v = c.bus.read32((addr & ~3) >>> 0);
        const rot = (addr & 3) << 3;
        if (rot !== 0) v = (v >>> rot) | (v << (32 - rot));
        c.r[rd] = v;
      } else {
        c.bus.write32((addr & ~3) >>> 0, c.r[rd] | 0);
      }
    };
  } else if (b < 0xb0) {
    // Format 12: ADD Rd, PC/SP, #imm8*4
    const sp = (b & 0x08) !== 0;
    const rd = b & 7;
    h = (c, op) => {
      const base = sp ? c.r[13] : c.r[15] & ~2;
      c.r[rd] = (base + ((op & 0xff) << 2)) | 0;
    };
  } else if (b === 0xb0) {
    // Format 13: ADD/SUB SP, #imm7*4
    h = (c, op) => {
      const off = (op & 0x7f) << 2;
      c.r[13] = (op & 0x80 ? c.r[13] - off : c.r[13] + off) | 0;
    };
  } else if (b === 0xb4 || b === 0xb5 || b === 0xbc || b === 0xbd) {
    // Format 14: PUSH/POP
    const pop = (b & 0x08) !== 0;
    const pclr = (b & 0x01) !== 0;
    h = (c, op) => {
      let list = op & 0xff;
      if (list === 0 && !pclr) {
        // Empty list quirk: transfer r15, move SP by 0x40
        if (pop) {
          const value = c.bus.read32((c.r[13] & ~3) >>> 0);
          c.r[13] = (c.r[13] + 0x40) | 0;
          c.branchTo(value);
        } else {
          c.bus.write32(((c.r[13] - 0x40) & ~3) >>> 0, (c.r[15] + 2) | 0);
          c.r[13] = (c.r[13] - 0x40) | 0;
        }
        return;
      }
      if (pop) {
        let addr = c.r[13];
        for (let i = 0; i < 8; i++) {
          if (!(list & (1 << i))) continue;
          c.r[i] = c.bus.read32((addr & ~3) >>> 0);
          addr = (addr + 4) | 0;
        }
        if (pclr) {
          const value = c.bus.read32((addr & ~3) >>> 0);
          addr = (addr + 4) | 0;
          c.r[13] = addr;
          c.branchTo(value & ~1); // ARMv4T: stays Thumb
          return;
        }
        c.r[13] = addr;
      } else {
        let count = 0;
        for (let i = 0; i < 8; i++) if (list & (1 << i)) count++;
        if (pclr) count++;
        let addr = (c.r[13] - count * 4) | 0;
        c.r[13] = addr;
        for (let i = 0; i < 8; i++) {
          if (!(list & (1 << i))) continue;
          c.bus.write32((addr & ~3) >>> 0, c.r[i] | 0);
          addr = (addr + 4) | 0;
        }
        if (pclr) c.bus.write32((addr & ~3) >>> 0, c.r[14] | 0);
      }
    };
  } else if (b >= 0xc0 && b < 0xd0) {
    // Format 15: STMIA/LDMIA Rn!, {list}
    const load = (b & 0x08) !== 0;
    const rn = b & 7;
    h = (c, op) => {
      let list = op & 0xff;
      let addr = c.r[rn];
      if (list === 0) {
        // Empty list quirk: transfer r15 (raw on load), base += 0x40
        const quirkVal = load ? c.bus.read32((addr & ~3) >>> 0) : 0;
        if (!load) c.bus.write32((addr & ~3) >>> 0, (c.r[15] + 2) | 0);
        c.r[rn] = (c.r[rn] + 0x40) | 0;
        if (load) c.branchTo(quirkVal);
        return;
      }
      if (load) {
        const baseInList = (list & (1 << rn)) !== 0;
        for (let i = 0; i < 8; i++) {
          if (!(list & (1 << i))) continue;
          c.r[i] = c.bus.read32((addr & ~3) >>> 0);
          addr = (addr + 4) | 0;
        }
        if (!baseInList) c.r[rn] = addr;
      } else {
        let first = true;
        let count = 0;
        for (let i = 0; i < 8; i++) if (list & (1 << i)) count++;
        const newBase = (c.r[rn] + count * 4) | 0;
        for (let i = 0; i < 8; i++) {
          if (!(list & (1 << i))) continue;
          let value = c.r[i];
          if (i === rn && !first) value = newBase;
          c.bus.write32((addr & ~3) >>> 0, value | 0);
          addr = (addr + 4) | 0;
          first = false;
        }
        c.r[rn] = newBase;
      }
    };
  } else if (b >= 0xd0 && b < 0xdf) {
    // Format 16: conditional branch. 0xDE (cond 0xE) is architecturally
    // undefined but executes as an always-taken branch on the ARM7TDMI.
    const cond = b & 0xf;
    h = (c, op) => {
      const p = priv(c);
      // reuse ARM condition evaluation through a tiny shim
      if ((c as unknown as { checkCond(cc: number): boolean }).checkCond(cond)) {
        const off = ((op & 0xff) << 24) >> 23;
        c.branchTo((c.r[15] + off) | 0);
      }
      void p;
    };
  } else if (b === 0xdf) {
    h = c => priv(c).exception(Mode.Svc, 0x08, -2);
  } else if (b >= 0xe0 && b < 0xe8) {
    // Format 18: unconditional branch
    h = (c, op) => {
      const off = ((op & 0x7ff) << 21) >> 20;
      c.branchTo((c.r[15] + off) | 0);
    };
  } else if (b >= 0xf0 && b < 0xf8) {
    // Format 19a: BL prefix
    h = (c, op) => {
      const off = ((op & 0x7ff) << 21) >> 9; // sign-extended, << 12
      c.r[14] = (c.r[15] + off) | 0;
    };
  } else if (b >= 0xf8) {
    // Format 19b: BL suffix
    h = (c, op) => {
      const target = (c.r[14] + ((op & 0x7ff) << 1)) | 0;
      c.r[14] = (c.r[15] - 2) | 1;
      c.branchTo(target & ~1);
    };
  } else {
    // 0xb1-0xbb gaps, 0xbe-0xbf, 0xe8-0xef: undefined
    h = c => priv(c).exception(Mode.Und, 0x04, -2);
  }
  THUMB[b] = h;
}
