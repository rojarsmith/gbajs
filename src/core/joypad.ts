/**
 * Joypad register (P1/JOYP, FF00).
 *
 * The game writes bits 4-5 to select a button group (0 = selected); reads
 * return that group's four lines in bits 0-3, active-low. Button indices in
 * `pressed`: 0 Right, 1 Left, 2 Up, 3 Down, 4 A, 5 B, 6 Select, 7 Start —
 * i.e. bits 0-3 are the direction group and 4-7 the action group, matching
 * the hardware line order within each group.
 */
export class Joypad {
  private select = 0x30; // bits 4-5 as last written by the game
  private pressed = 0;   // 1 = held

  /** Wired to Bus.requestInterrupt(4) by the GameBoy assembly. */
  requestInterrupt: () => void = () => {};

  read(): number {
    let lines = 0x0f;
    if (!(this.select & 0x10)) lines &= ~this.pressed & 0x0f;
    if (!(this.select & 0x20)) lines &= (~this.pressed >> 4) & 0x0f;
    return 0xc0 | this.select | lines;
  }

  write(v: number): void {
    this.select = v & 0x30;
  }

  /** Update one button (index as documented above). */
  setButton(index: number, down: boolean): void {
    const bit = 1 << index;
    const was = this.pressed;
    if (down) this.pressed |= bit;
    else this.pressed &= ~bit;
    // Simplified Joypad interrupt: fire on any new press. (Hardware fires on
    // a high->low edge of a *selected* line; games rarely depend on that.)
    if (down && this.pressed !== was) this.requestInterrupt();
  }
}
