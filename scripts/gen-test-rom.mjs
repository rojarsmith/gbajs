// Generates homebrew test ROMs into public/test-roms/ — no copyrighted
// material. The Nintendo logo area is left zeroed: this emulator does not
// verify it.
//
// boot.gb    — minimal ROM-only cart: NOP; JP 0x0150; infinite loop.
// battery.gb — MBC1+RAM+BATTERY cart that enables cartridge RAM and
//              increments the byte at 0xA000 once per boot, for verifying
//              battery-save persistence end to end.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function makeRom({ title, cartType, ramSize, program }) {
  const rom = new Uint8Array(32 * 1024);

  // Entry point: NOP; JP 0x0150
  rom.set([0x00, 0xc3, 0x50, 0x01], 0x100);
  for (let i = 0; i < title.length; i++) rom[0x134 + i] = title.charCodeAt(i);
  rom[0x147] = cartType;
  rom[0x148] = 0x00; // 32 KiB ROM
  rom[0x149] = ramSize;
  rom.set(program, 0x150);

  // Header checksum over 0x134-0x14C
  let sum = 0;
  for (let i = 0x134; i <= 0x14c; i++) sum = (sum - rom[i] - 1) & 0xff;
  rom[0x14d] = sum;

  // Global checksum: sum of all bytes except 0x14E/0x14F
  let global = 0;
  for (let i = 0; i < rom.length; i++) {
    if (i !== 0x14e && i !== 0x14f) global = (global + rom[i]) & 0xffff;
  }
  rom[0x14e] = global >>> 8;
  rom[0x14f] = global & 0xff;
  return rom;
}

const roms = {
  "boot.gb": makeRom({
    title: "GBAJS TEST",
    cartType: 0x00,
    ramSize: 0x00,
    program: [0x18, 0xfe], // JR -2
  }),
  "battery.gb": makeRom({
    title: "BATTERY TEST",
    cartType: 0x03, // MBC1+RAM+BATTERY
    ramSize: 0x02,  // 8 KiB
    program: [
      0x3e, 0x0a,       // LD A, 0x0A
      0xea, 0x00, 0x00, // LD (0x0000), A  ; enable cart RAM
      0xfa, 0x00, 0xa0, // LD A, (0xA000)  ; read boot counter
      0x3c,             // INC A
      0xea, 0x00, 0xa0, // LD (0xA000), A  ; write back
      0x18, 0xfe,       // JR -2
    ],
  }),
};

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "test-roms");
mkdirSync(out, { recursive: true });
for (const [name, rom] of Object.entries(roms)) {
  writeFileSync(join(out, name), rom);
  console.log(`wrote ${join(out, name)} (${rom.length} bytes)`);
}
