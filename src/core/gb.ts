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
  /** True when the cartridge requests Game Boy Color mode. */
  readonly cgb: boolean;

  constructor(readonly cart: Cartridge) {
    this.cgb = cart.header.cgbFlag >= 0x80;
    this.timer = new Timer();
    this.ppu = new PPU();
    this.ppu.cgb = this.cgb;
    this.joypad = new Joypad();
    this.apu = new APU();
    this.bus = new Bus(cart, this.timer, this.ppu, this.joypad, this.apu, this.cgb);
    this.timer.requestInterrupt = () => this.bus.requestInterrupt(2);
    this.ppu.requestInterrupt = bit => this.bus.requestInterrupt(bit);
    this.joypad.requestInterrupt = () => this.bus.requestInterrupt(4);
    this.ppu.onHblank = () => this.bus.hdmaHblank();
    this.cpu = new CPU(this.bus, this.cgb);
  }

  /**
   * Run one instruction and advance all components. Returns VIDEO-time
   * cycles: in CGB double-speed mode the CPU and timer run twice as fast,
   * so the PPU/APU (and frame pacing) see half the CPU's cycle count.
   */
  step(): number {
    const cycles = this.cpu.step();
    this.timer.step(cycles); // the timer follows the CPU clock
    const vc = this.bus.doubleSpeed ? cycles >> 1 : cycles;
    this.ppu.step(vc);
    this.apu.step(vc);
    return vc;
  }

  /** Advance by (at least) one video frame's worth of cycles. */
  runFrame(): void {
    for (let c = 0; c < CYCLES_PER_FRAME; c += this.step());
  }
}
