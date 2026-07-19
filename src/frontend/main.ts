import { Cartridge } from "../core/cartridge";
import { Bus } from "../core/bus";
import { CPU } from "../core/cpu";
import { extractZipEntry, isZip, listZip } from "./zip";

const dropZone = document.getElementById("drop") as HTMLDivElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
const loadTestBtn = document.getElementById("load-test") as HTMLButtonElement;
const headerTable = document.getElementById("header-info") as HTMLTableElement;
const hexdumpPre = document.getElementById("hexdump") as HTMLPreElement;

function hex(n: number, width: number): string {
  return "0x" + n.toString(16).toUpperCase().padStart(width, "0");
}

function hexdump(data: Uint8Array, start: number, end: number): string {
  const lines: string[] = [];
  for (let base = start; base < end; base += 16) {
    const bytes: string[] = [];
    let ascii = "";
    for (let i = base; i < Math.min(base + 16, end); i++) {
      bytes.push(data[i].toString(16).padStart(2, "0"));
      ascii += data[i] >= 0x20 && data[i] < 0x7f ? String.fromCharCode(data[i]) : ".";
    }
    lines.push(`${base.toString(16).padStart(4, "0")}  ${bytes.join(" ").padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
}

function showRom(rom: Uint8Array, source: string): void {
  let cart: Cartridge;
  try {
    cart = new Cartridge(rom);
  } catch (e) {
    headerTable.innerHTML = `<tr><td class="bad">${(e as Error).message}</td></tr>`;
    hexdumpPre.textContent = "";
    return;
  }
  const h = cart.header;
  const rows: [string, string][] = [
    ["Source", source],
    ["Title", h.title || "(empty)"],
    ["CGB flag", h.cgbFlag ? hex(h.cgbFlag, 2) : "no"],
    ["Cartridge type", `${h.cartTypeName} (${hex(h.cartTypeCode, 2)})`],
    ["ROM size (header)", `${h.romSize / 1024} KiB — actual file: ${rom.length / 1024} KiB`],
    ["RAM size (header)", `${h.ramSize / 1024} KiB`],
    ["Header checksum", `${hex(h.headerChecksum, 2)} ${h.headerChecksumOk ? "✓ ok" : "✗ MISMATCH"}`],
    ["Global checksum", hex(h.globalChecksum, 4)],
  ];
  headerTable.innerHTML = rows
    .map(([k, v]) => {
      const cls = v.includes("✗") ? "bad" : v.includes("✓") ? "ok" : "";
      return `<tr><td>${k}</td><td class="${cls}">${v}</td></tr>`;
    })
    .join("");
  hexdumpPre.textContent = "Header region (0x0100-0x0150):\n" + hexdump(rom, 0x100, 0x150);

  // Wire up the core (CPU is a skeleton — this proves the plumbing works).
  const bus = new Bus(cart);
  bus.onSerial = b => console.log("[serial]", String.fromCharCode(b));
  const cpu = new CPU(bus);
  try {
    for (let i = 0; i < 100 && !cpu.halted; i++) cpu.step();
    console.log(`CPU ran 100 steps, PC=${hex(cpu.pc, 4)}`);
  } catch (e) {
    console.log(`CPU stopped: ${(e as Error).message}`);
  }
}

/** Accepts a raw ROM or a .zip containing one; unwraps zips transparently. */
async function loadRomData(data: Uint8Array, source: string): Promise<void> {
  if (isZip(data)) {
    try {
      const entries = listZip(data);
      const romEntry = entries.find(e => /\.(gb|gbc|gba)$/i.test(e.name));
      if (!romEntry) {
        headerTable.innerHTML = `<tr><td class="bad">No .gb/.gbc/.gba file inside ${source}</td></tr>`;
        hexdumpPre.textContent = "ZIP contents:\n" + entries.map(e => `  ${e.name}`).join("\n");
        return;
      }
      data = await extractZipEntry(data, romEntry);
      source = `${source} → ${romEntry.name}`;
    } catch (e) {
      headerTable.innerHTML = `<tr><td class="bad">${(e as Error).message}</td></tr>`;
      hexdumpPre.textContent = "";
      return;
    }
  }
  showRom(data, source);
}

async function loadFile(file: File): Promise<void> {
  await loadRomData(new Uint8Array(await file.arrayBuffer()), file.name);
}

fileInput.addEventListener("change", () => {
  if (fileInput.files?.[0]) void loadFile(fileInput.files[0]);
});

dropZone.addEventListener("dragover", e => {
  e.preventDefault();
  dropZone.classList.add("hover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("hover"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("hover");
  if (e.dataTransfer?.files[0]) void loadFile(e.dataTransfer.files[0]);
});

loadTestBtn.addEventListener("click", async () => {
  const res = await fetch("/test-roms/boot.gb");
  showRom(new Uint8Array(await res.arrayBuffer()), "built-in test ROM");
});

// Dev convenience: ?rom=/roms/foo.gb auto-loads a ROM served from the project
// root (the roms/ folder is gitignored — local files only).
const romParam = new URLSearchParams(location.search).get("rom");
if (romParam) {
  void (async () => {
    const res = await fetch(romParam);
    if (res.ok) {
      await loadRomData(new Uint8Array(await res.arrayBuffer()), romParam);
    } else {
      hexdumpPre.textContent = `Failed to fetch ${romParam}: HTTP ${res.status}`;
    }
  })();
}
