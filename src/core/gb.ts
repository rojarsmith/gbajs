import { Bus } from "./bus";
import type { Cartridge } from "./cartridge";
import { CPU } from "./cpu";
import { Timer } from "./timer";

/**
 * The assembled machine: every component advances on the shared clock.
 * PPU and APU join this loop in later roadmap steps.
 */
export class GameBoy {
  readonly bus: Bus;
  readonly cpu: CPU;
  readonly timer: Timer;

  constructor(readonly cart: Cartridge) {
    this.timer = new Timer();
    this.bus = new Bus(cart, this.timer);
    this.timer.requestInterrupt = () => this.bus.requestInterrupt(2);
    this.cpu = new CPU(this.bus);
  }

  /** Run one instruction and advance all components; returns T-cycles. */
  step(): number {
    const cycles = this.cpu.step();
    this.timer.step(cycles);
    return cycles;
  }
}
