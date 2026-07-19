import { APU } from "./apu";
import { Bus } from "./bus";
import type { Cartridge } from "./cartridge";
import { CPU } from "./cpu";
import { Joypad } from "./joypad";
import { PPU } from "./ppu";
import { Timer } from "./timer";

/** T-cycles per frame: 154 lines x 456 dots. */
export const CYCLES_PER_FRAME = 70224;

/** The assembled machine: every component advances on the shared clock. */
export class GameBoy {
  readonly bus: Bus;
  readonly cpu: CPU;
  readonly timer: Timer;
  readonly ppu: PPU;
  readonly joypad: Joypad;
  readonly apu: APU;

  constructor(readonly cart: Cartridge) {
    this.timer = new Timer();
    this.ppu = new PPU();
    this.joypad = new Joypad();
    this.apu = new APU();
    this.bus = new Bus(cart, this.timer, this.ppu, this.joypad, this.apu);
    this.timer.requestInterrupt = () => this.bus.requestInterrupt(2);
    this.ppu.requestInterrupt = bit => this.bus.requestInterrupt(bit);
    this.joypad.requestInterrupt = () => this.bus.requestInterrupt(4);
    this.cpu = new CPU(this.bus);
  }

  /** Run one instruction and advance all components; returns T-cycles. */
  step(): number {
    const cycles = this.cpu.step();
    this.timer.step(cycles);
    this.ppu.step(cycles);
    this.apu.step(cycles);
    return cycles;
  }

  /** Advance by (at least) one video frame's worth of cycles. */
  runFrame(): void {
    for (let c = 0; c < CYCLES_PER_FRAME; c += this.step());
  }
}
