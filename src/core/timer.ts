/**
 * DMG timer: DIV (FF04), TIMA (FF05), TMA (FF06), TAC (FF07).
 *
 * The hardware has one 16-bit counter ticking every T-cycle; DIV is its upper
 * byte, and TIMA increments on falling edges of a counter bit selected by
 * TAC. We advance in bulk per instruction, counting how many times the
 * selected bit's period boundary was crossed.
 *
 * Not modeled (Mooneye-level edge cases): the 4-cycle TIMA reload delay, and
 * the spurious increment when a DIV write clears a set selected bit.
 */
export class Timer {
  private counter = 0xabcc; // post-boot-ROM DIV state (DIV reads 0xAB)
  private tima = 0;
  private tma = 0;
  private tac = 0;

  /** Wired to Bus.requestInterrupt(2) by the GameBoy assembly. */
  requestInterrupt: () => void = () => {};

  readReg(addr: number): number {
    switch (addr) {
      case 0xff04: return (this.counter >> 8) & 0xff;
      case 0xff05: return this.tima;
      case 0xff06: return this.tma;
      default: return this.tac | 0xf8;
    }
  }

  writeReg(addr: number, v: number): void {
    switch (addr) {
      case 0xff04: this.counter = 0; break; // any write resets
      case 0xff05: this.tima = v; break;
      case 0xff06: this.tma = v; break;
      default: this.tac = v & 7;
    }
  }

  /** Advance by elapsed T-cycles; raises the Timer interrupt on TIMA overflow. */
  step(cycles: number): void {
    const old = this.counter;
    const now = old + cycles;
    this.counter = now & 0xffff;
    if (!(this.tac & 4)) return; // timer disabled (DIV always runs)

    // TAC freq select -> log2 of T-cycles per TIMA increment:
    // 00: 4096 Hz (1024), 01: 262144 Hz (16), 10: 65536 Hz (64), 11: 16384 Hz (256)
    const shift = SHIFTS[this.tac & 3];
    let tima = this.tima + ((now >> shift) - (old >> shift));
    if (tima > 0xff) {
      tima = this.tma + (tima - 0x100); // reload (cycles<=24, so at most once)
      this.requestInterrupt();
    }
    this.tima = tima & 0xff;
  }
}

const SHIFTS = [10, 4, 6, 8];
