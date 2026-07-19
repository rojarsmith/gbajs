import { Cartridge } from "../core/cartridge";
import { GameBoy } from "../core/gb";
import { loadSave, storeSave } from "./storage";
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

  void startMachine(cart);
}

// Automation: load a ROM by URL without reloading the page.
(window as unknown as Record<string, unknown>).gbLoadRom = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await loadRomData(new Uint8Array(await res.arrayBuffer()), url);
};

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
const canvas = document.getElementById("screen") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

// Keyboard -> Joypad button index (see Joypad class for the numbering).
// Arrows = D-pad, X = A, Z = B, A = Select, S = Start.
const KEYMAP: Record<string, number> = {
  ArrowRight: 0, ArrowLeft: 1, ArrowUp: 2, ArrowDown: 3,
  KeyX: 4, KeyZ: 5, KeyA: 6, KeyS: 7,
};

let activeGb: GameBoy | null = null;

window.addEventListener("keydown", e => {
  const btn = KEYMAP[e.code];
  if (btn === undefined || activeGb === null) return;
  e.preventDefault();
  if (!e.repeat) activeGb.joypad.setButton(btn, true);
});
window.addEventListener("keyup", e => {
  const btn = KEYMAP[e.code];
  if (btn === undefined || activeGb === null) return;
  e.preventDefault();
  activeGb.joypad.setButton(btn, false);
});

let flushTimer: ReturnType<typeof setInterval> | null = null;
let currentFlush: (() => Promise<void>) | null = null;

document.addEventListener("visibilitychange", () => {
  if (document.hidden) void currentFlush?.();
});

async function startMachine(cart: Cartridge): Promise<void> {
  // Restore battery RAM before the game boots and reads it.
  if (cart.hasBattery) {
    try {
      const saved = await loadSave(cart.saveKey);
      if (saved) cart.importRam(saved);
    } catch (e) {
      console.warn("Save load failed:", e);
    }
  }

  const gb = new GameBoy(cart);
  activeGb = gb;
  let serialText = "";
  const serialBytes: number[] = [];
  serialPre.textContent = "";
  gb.bus.onSerial = byte => {
    serialBytes.push(byte);
    serialText += String.fromCharCode(byte);
    serialPre.textContent = serialText;
  };

  // Persist dirty battery RAM every 2 s and when the tab is hidden.
  const flush = async (): Promise<void> => {
    if (!cart.hasBattery || !cart.ramDirty) return;
    cart.ramDirty = false;
    try {
      await storeSave(cart.saveKey, cart.exportRam());
    } catch (e) {
      cart.ramDirty = true; // retry on the next tick
      console.warn("Save store failed:", e);
    }
  };
  if (flushTimer !== null) clearInterval(flushTimer);
  flushTimer = setInterval(flush, 2000);
  currentFlush = flush;

  const image = new ImageData(
    new Uint8ClampedArray(gb.ppu.framebuffer.buffer), 160, 144,
  );
  const present = (): void => ctx.putImageData(image, 0, 0);

  const token = ++runToken;
  const turbo = new URLSearchParams(location.search).has("turbo");

  // Debug/automation hook: drive the machine manually from the console.
  // setPaused(true) freezes the real-time loop so runFrames is deterministic.
  let paused = false;
  (window as unknown as Record<string, unknown>).gbDev = {
    gb,
    serialBytes,
    runFrames: (n: number) => { for (let i = 0; i < n; i++) gb.runFrame(); present(); },
    setPaused: (p: boolean) => { paused = p; },
    flushSave: flush,
  };

  if (turbo) {
    // Uncapped speed for test ROMs (serial output is the result channel).
    let steps = 0;
    const chunk = (): void => {
      if (token !== runToken) return;
      try {
        for (let i = 0; i < 1_000_000; i++) gb.step();
      } catch (e) {
        statusEl.textContent = `CPU stopped: ${(e as Error).message}`;
        return;
      }
      steps += 1_000_000;
      present();
      if (/Passed|Failed/.test(serialText)) {
        statusEl.textContent = `Test ROM finished after ~${steps / 1e6}M steps.`;
        return;
      }
      if (steps >= 60_000_000) {
        statusEl.textContent = `Turbo: paused after ${steps / 1e6}M steps at PC=${hex(gb.cpu.pc, 4)}.`;
        return;
      }
      statusEl.textContent = `Turbo… ${steps / 1e6}M steps`;
      scheduleChunk(chunk);
    };
    chunk();
    return;
  }

  // Real-time loop: one emulated frame per animation frame. (Display refresh
  // is assumed ~60 Hz for now; audio-driven pacing arrives with the APU.)
  const loop = (): void => {
    if (token !== runToken) return;
    if (!paused) {
      try {
        gb.runFrame();
      } catch (e) {
        statusEl.textContent = `CPU stopped: ${(e as Error).message}`;
        return;
      }
      present();
      statusEl.textContent = `Running — frame ${gb.ppu.frame}`;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
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
