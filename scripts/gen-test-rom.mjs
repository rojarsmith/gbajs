// Generates public/test-roms/boot.gb — a minimal homebrew ROM with a valid
// header, used to exercise the ROM loader without any commercial ROM.
// Entry: NOP; JP 0x0150. At 0x0150: JR -2 (infinite loop).
// The Nintendo logo area is left zeroed: this emulator does not verify it.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rom = new Uint8Array(32 * 1024);

// Entry point at 0x100
rom[0x100] = 0x00;                   // NOP
rom[0x101] = 0xc3;                   // JP 0x0150
rom[0x102] = 0x50;
rom[0x103] = 0x01;

// Title (0x134-0x143, ASCII, NUL-padded)
const title = "GBAJS TEST";
for (let i = 0; i < title.length; i++) rom[0x134 + i] = title.charCodeAt(i);

rom[0x147] = 0x00;                   // cartridge type: ROM only
rom[0x148] = 0x00;                   // ROM size: 32 KiB
rom[0x149] = 0x00;                   // RAM size: none

// Program at 0x150: infinite loop
rom[0x150] = 0x18;                   // JR -2
rom[0x151] = 0xfe;

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

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "test-roms");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "boot.gb"), rom);
console.log(`wrote ${join(out, "boot.gb")} (${rom.length} bytes, header checksum 0x${sum.toString(16)})`);
