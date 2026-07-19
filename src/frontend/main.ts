import { Cartridge } from "../core/cartridge";
import { GameBoy } from "../core/gb";
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

  startMachine(cart);
}

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const serialPre = document.getElementById("serial") as HTMLPreElement;

let runToken = 0; // bumped on each load to cancel the previous run loop

// setTimeout chains get throttled hard in hidden tabs; a MessageChannel task
// does not, so the test-harness run loop keeps going regardless of focus.
const chunkChannel = new MessageChannel();
let nextChunk: (() => void) | null = null;
chunkChannel.port1.onmessage = () => nextChunk?.();
function scheduleChunk(fn: () => void): void {
  nextChunk = fn;
  chunkChannel.port2.postMessage(0);
}

/**
 * Run the CPU in chunks so the page stays responsive. Serial output (how
 * Blargg's test ROMs report results) accumulates on the page; the loop stops
 * on "Passed"/"Failed", on a CPU error, or at a step cap (games will sit in
 * a wait loop forever until the PPU/interrupts exist — that's expected).
 */
function startMachine(cart: Cartridge): void {
  const gb = new GameBoy(cart);
  let serialText = "";
  serialPre.textContent = "";
  gb.bus.onSerial = byte => {
    serialText += String.fromCharCode(byte);
    serialPre.textContent = serialText;
  };

  const token = ++runToken;
  const STEPS_PER_CHUNK = 1_000_000;
  const MAX_STEPS = 60_000_000;
  let steps = 0;

  const chunk = (): void => {
    if (token !== runToken) return; // a newer ROM was loaded
    try {
      for (let i = 0; i < STEPS_PER_CHUNK; i++) gb.step();
    } catch (e) {
      statusEl.textContent = `CPU stopped: ${(e as Error).message}`;
      return;
    }
    steps += STEPS_PER_CHUNK;
    if (/Passed|Failed/.test(serialText)) {
      statusEl.textContent = `Test ROM finished after ~${steps / 1e6}M steps.`;
      return;
    }
    if (steps >= MAX_STEPS) {
      statusEl.textContent =
        `Paused after ${steps / 1e6}M steps at PC=${hex(gb.cpu.pc, 4)}` +
        (gb.cpu.halted ? " (halted)" : "") +
        " — likely waiting for the PPU; expected until step 4.";
      return;
    }
    statusEl.textContent = `CPU running… ${steps / 1e6}M steps`;
    scheduleChunk(chunk);
  };
  statusEl.textContent = "CPU running…";
  chunk();
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
