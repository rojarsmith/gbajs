# 從零開始打造可在瀏覽器執行的 Game Boy 與 GBA 模擬器

[English](./README.md) | **繁體中文**

本文件說明遊戲機模擬器的運作原理、Game Boy（GB）與 Game Boy Advance（GBA）的實際硬體
構成，以及如何從一個空資料夾開始，打造一款完全在瀏覽器中執行、同時支援兩種主機的模擬器。

> 注意：雖然 GBA 實機可以執行 GB 卡帶，但那是靠機器裡「另一顆」CPU 達成的。所以
> 「GB + GBA 模擬器」實際上是**兩套模擬器核心**，共用同一個前端（畫面、聲音、輸入、
> 存檔）。請先做 GB 核心——它簡單一個數量級，而且會教你 GBA 需要的所有概念。

---

## 目錄

1. [模擬器到底是什麼](#1-模擬器到底是什麼)
2. [你要模仿的硬體](#2-你要模仿的硬體)
3. [模擬器的核心架構](#3-模擬器的核心架構)
4. [讓它在瀏覽器裡跑起來](#4-讓它在瀏覽器裡跑起來)
5. [逐步開發路線圖](#5-逐步開發路線圖)
6. [測試 ROM 與文件資源](#6-測試-rom-與文件資源)
7. [常見地雷](#7-常見地雷)

---

## 1. 模擬器到底是什麼

模擬器是一台**狀態機**，重現實體機器可觀察到的行為。遊戲主機其實就是幾顆晶片掛在共用
匯流排上：

- **CPU**：不斷從記憶體取指令、解碼、執行；
- **PPU**（圖形處理單元）：跟著掃描線一行一行地產生像素；
- **APU**（音訊處理單元）：產生波形；
- **計時器（Timer）**、**DMA 控制器**、**中斷控制器**；
- **卡帶**：內含 ROM、常有額外 RAM，有時還有記憶體分頁控制器（MBC）。

你的模擬器把上述所有狀態放進變數與陣列中，並讓它們同步前進：

```text
loop forever:
    cycles = cpu.step()        # 執行一條指令，回傳花了幾個 cycle
    ppu.step(cycles)           # 讓顯示晶片前進同樣的時間
    apu.step(cycles)           # 推進音訊
    timers.step(cycles)        # 推進計時器，可能觸發中斷
    dma.step(cycles)
```

最重要的一個觀念是**共用時脈**。遊戲是針對精確的硬體時序寫的：它們會在一個畫格
「中途」改寫顯示暫存器、和掃描線計數器賽跑、用硬體計時器對音訊計時。如果你的 CPU 和
PPU 對「現在幾點」沒有共識，遊戲就會破圖或當機。因此所有元件都消耗同一種貨幣——
**cycle**（GB：4,194,304 Hz 的「T-cycle」；GBA：16,777,216 Hz）。

### 精確度層級

| 層級 | 意義 | 足以應付 |
|---|---|---|
| 指令級 | 每執行完一條 CPU 指令才同步各元件 | 大多數遊戲、第一款模擬器 |
| Cycle 精確 | 每個 cycle 同步；記憶體存取發生在指令內正確的 cycle | 難搞的遊戲、精確度測試 ROM |
| 次 cycle / 電路級 | 模擬晶片內部訊號 | 研究用途（這裡不需要） |

從「指令級 + 每條指令的 cycle 數」開始即可。只要一切都經過共用時脈，之後可以逐步收緊
精確度而不必重寫架構。

### 直譯器 vs. JIT

**直譯器（interpreter）**每次執行都重新解碼指令——簡單，而且以 JavaScript/WASM 跑 GB
和 GBA 都夠快。**動態重編譯（JIT / dynarec）**把客體程式碼整塊翻譯成宿主機器碼——複雜度
大增，在現代瀏覽器上模擬這兩台主機並不需要。寫直譯器就好。

---

## 2. 你要模仿的硬體

### 2.1 Game Boy（DMG / Game Boy Color）

| 元件 | 細節 |
|---|---|
| CPU | Sharp **SM83**（常被稱為 LR35902）——「類」8080/Z80 的 8 位元 CPU，**不是** Z80。4.194304 MHz。 |
| 暫存器 | `A F B C D E H L`（可成對為 `AF BC DE HL`）、`SP`、`PC`。旗標在 `F`：**Z N H C**。 |
| 指令集 | 256 個基本 opcode + 256 個 `0xCB` 前綴（位元操作、移位），共約 500 個。 |
| WRAM | 8 KiB（CGB：32 KiB，分頁） |
| VRAM | 8 KiB（CGB：16 KiB，分頁） |
| 螢幕 | 160×144、4 階灰階（CGB：15 位元色彩，8 組 BG + 8 組 OBJ 調色盤） |
| 音訊 | 4 聲道：2 個方波（其一含掃頻）、可程式化波形、雜訊 |
| 畫面更新率 | 59.73 Hz——每畫格 70,224 T-cycles |

**記憶體映射**——匯流排是 16 位元位址空間，每次讀寫依區域分派：

```text
0000-3FFF  ROM bank 0            （卡帶）
4000-7FFF  ROM bank 1..N         （由 MBC 切換）
8000-9FFF  VRAM
A000-BFFF  外部（卡帶）RAM——電池記憶存檔就放這裡
C000-DFFF  WRAM
E000-FDFF  Echo RAM（C000-DDFF 的鏡像）
FE00-FE9F  OAM（精靈屬性表，40 筆 × 4 bytes）
FF00-FF7F  I/O 暫存器（搖桿、序列埠、計時器、音訊、PPU、DMA…）
FF80-FFFE  HRAM
FFFF       IE（中斷致能）
```

**PPU。**畫面由 8×8 的**圖塊（tile）**組成（每像素 2 bit）。一張 32×32 圖塊的
**背景圖（background map）**由 `SCX/SCY` 捲動；上面疊一層**視窗（window）**；OAM 中
最多 40 個**精靈（sprite）**（每行上限 10 個）。PPU 在每條掃描線上依序經過模式
**2**（掃描 OAM，80 dots）→ **3**（像素傳輸，約 172–289 dots）→ **0**（HBlank），
每行共 456 dots，共 154 行（144 行可見，之後 10 行為模式 **1** 的 VBlank）。
遊戲仰賴這些模式時序以及 `LY`/`LYC` 比較中斷來做逐行（raster）特效，因此
**掃描線渲染器**（PPU 走到 HBlank 時一次畫完整行）是標準的第一版實作。

**中斷。**五個來源——VBlank、LCD STAT、Timer、Serial、Joypad——旗標在 `IF (FF0F)`、
遮罩在 `IE (FFFF)`，外加總開關（`IME`，由 `EI`/`DI` 控制）。觸發時把 `PC` 推入堆疊並
跳到固定向量（`0x40/0x48/0x50/0x58/0x60`）。

**計時器。**`DIV`（FF04）以 16,384 Hz 遞增；`TIMA`（FF05）依 `TAC`（FF07）選擇的
頻率計數，溢位時從 `TMA`（FF06）重新載入並觸發 Timer 中斷。

**卡帶 / MBC。**位址空間只看得到 32 KiB 的 ROM，更大的卡帶靠**記憶體分頁控制器
（MBC）**：對 ROM 位址範圍「寫入」會選擇哪個 bank 出現在 `4000-7FFF`。實作
**MBC1**、**MBC3**（多了即時時鐘 RTC）與 **MBC5** 就幾乎涵蓋整個遊戲庫。ROM 標頭
`0x147` 那個 byte 會告訴你該用哪一種。

### 2.2 Game Boy Advance

| 元件 | 細節 |
|---|---|
| CPU | **ARM7TDMI**——32 位元 ARMv4T，16.777216 MHz，3 級管線 |
| 指令集 | **ARM**（32 位元寬）與 **Thumb**（16 位元寬）；遊戲透過 `BX` 頻繁切換 |
| 暫存器 | `r0–r15`（`r15` = PC）、`CPSR`、各模式（IRQ、SVC…）的分組暫存器與 `SPSR` |
| 螢幕 | 240×160、15 位元色彩、59.7275 Hz——每畫格 280,896 cycles，每行 1,232，共 228 行（160 可見 + 68 VBlank） |
| 音訊 | 2 個 **Direct Sound** 聲道（8 位元 PCM，經 DMA 餵入 FIFO）+ 4 個傳統 GB 聲道 |
| BIOS | 16 KiB ROM，內含遊戲實際會呼叫的軟體中斷（SWI）系統呼叫 |

**記憶體映射**（32 位元位址空間，區域看位元 24–27）：

```text
00000000  BIOS         16 KiB   （受保護：只有執行其中程式時可讀）
02000000  EWRAM       256 KiB   （16 位元匯流排、2 個等待週期——慢）
03000000  IWRAM        32 KiB   （32 位元匯流排、快——熱點程式碼放這裡）
04000000  I/O 暫存器
05000000  調色盤 RAM     1 KiB   （256 BG + 256 OBJ 色，15 位元）
06000000  VRAM         96 KiB
07000000  OAM           1 KiB   （128 筆精靈資料）
08000000  卡帶 ROM 最大 32 MiB   （3 個鏡像，各有不同等待週期）
0E000000  卡帶 SRAM/Flash        （8 位元匯流排）
```

**PPU。**共六種顯示模式。模式 **0–2** 是圖塊式：最多四層背景，部分可做
**仿射（affine）**變換（用 2×2 矩陣旋轉／縮放，類似 SNES 的「Mode 7」）。模式
**3–5** 是點陣圖 framebuffer（模式 3：16-bpp 240×160；模式 4：8-bpp 調色盤、
雙緩衝——著名的「第一個 demo」模式）。再疊上：128 個精靈（一般與仿射）、可裁切圖層的
**視窗（window）**、**半透明混合（alpha blending）**、亮度淡入淡出與馬賽克效果。

**DMA。**四個通道可（就 CPU 觀點而言）瞬間搬移記憶體區塊，可在 VBlank/HBlank 觸發，
其中通道 1–2 負責補充音訊 FIFO。遊戲極度依賴 DMA——要早點實作。

**計時器。**四個 16 位元計時器，含預除器（1/64/256/1024）、可串接；計時器 0–1 決定
Direct Sound 的取樣率。

**存檔媒體。**卡帶存檔可能是 SRAM（32 KiB）、Flash（64/128 KiB，指令協定）或
EEPROM（512 B / 8 KiB，走 ROM 匯流排的序列協定）。偵測方式是掃描 ROM 中的識別字串
（`SRAM_V`、`FLASH1M_V`、`EEPROM_V`…）。

**BIOS。**可以搭配開源替代 BIOS，或實作 **HLE**：攔截 `SWI`，用自己的程式碼實作那些
呼叫（除法、memcpy、解壓縮、`IntrWait`…）。

---

## 3. 模擬器的核心架構

乾淨的模組切分會直接對應硬體：

```text
core/
  cpu.ts        # 取指/解碼/執行、中斷處理
  bus.ts        # 記憶體映射分派：read8/16/32、write8/16/32
  ppu.ts        # 掃描線渲染器，輸出 framebuffer
  apu.ts        # 取樣產生器，輸出音訊環形緩衝區
  timers.ts
  dma.ts        # （GBA）
  cartridge.ts  # ROM + MBC / 存檔晶片
  scheduler.ts  # 共用時脈
frontend/
  screen.ts     # canvas / WebGL
  audio.ts      # AudioWorklet
  input.ts      # 鍵盤 / 手把 / 觸控
  storage.ts    # IndexedDB 存檔、即時存檔（save state）
```

### CPU 迴圈

GB 的 256+256 個 opcode 很適合用**分派表**（一堆小函式，或一個大 `switch`）：

```ts
// GB (SM83)——每個 opcode 一個項目，回傳消耗的 cycle 數
const ops: ((cpu: CPU) => number)[] = new Array(256);

ops[0x3e] = c => { c.a = c.fetch8(); return 8; };           // LD A, n
ops[0x80] = c => { c.a = c.add8(c.a, c.b); return 4; };     // ADD A, B
ops[0xcb] = c => cbOps[c.fetch8()](c);                      // CB 前綴

function step(c: CPU): number {
  if (c.handleInterrupts()) return 20;
  return ops[c.fetch8()](c);
}
```

ARM7TDMI 不可能列舉 2³² 種編碼，但 ARM 指令的位元 **27–20 與 7–4**（共 12 bits）足以
辨識操作類型。啟動時建一張 4096 項的查找表；Thumb 同理用最高 8–10 bits。管線用便宜的
方式模擬即可：讀 `r15` 時回傳「取指位址 + 8（ARM）/ + 4（Thumb）」，任何對 `r15` 的
寫入則清空管線並重新取指。

### 匯流排（Bus）

所有記憶體存取都收斂到一個函式，依位址區域分派。每個區域背後放一個
**typed array**（`Uint8Array`）——這就是 JS 模擬器跑得快的關鍵：

```ts
function read8(addr: number): number {
  switch (addr >>> 24) {           // GBA：最高 byte 即區域
    case 0x03: return iwram[addr & 0x7fff];
    case 0x04: return ioRead(addr);
    case 0x06: return vram[addr % 0x18000];
    case 0x08: case 0x09: return rom[addr & (rom.length - 1)];
    // ...
  }
}
```

I/O 暫存器是唯一需要「逐位址邏輯」的地方——讀 `LY` 要回傳目前掃描線；寫 `DMA3CNT`
可能「當下」就啟動一次傳輸。

### 排程器（Scheduler）

兩種可行設計：

- **逐步推進（tick-along）**（先用這個）：每條 CPU 指令執行完，把經過的 cycle 數傳給
  每個元件，如 §1 的迴圈。
- **事件排程器**（之後再優化）：各元件登記「下一個有趣事件在第 X cycle」（掃描線結束、
  計時器溢位、FIFO 耗盡…），CPU 一路跑到最早的事件為止。快很多、可觀察行為相同——
  mGBA 就是這樣做的。

### PPU 策略

維護一個 framebuffer（`Uint32Array`，一格一個 RGBA 像素）。當共用時脈說某條掃描線
結束了，就依「該行當下」的暫存器狀態一次渲染整行：背景層、視窗、再來精靈。逐像素
FIFO 級的精確度（GB）可以留到很後面。

### APU 策略

音訊是**生產者／消費者**問題：被模擬的 APU 以原生頻率產生取樣（GB 聲道是簡單的
振盪器；GBA Direct Sound 則是每次計時器觸發就從 FIFO 取出一個 8 位元取樣），你把它
降頻到 44.1/48 kHz，推進一個由瀏覽器音訊執行緒消費的**環形緩衝區**。音訊同時也是
你最好的*時鐘來源*——見 §4。

---

## 4. 讓它在瀏覽器裡跑起來

### 語言選擇

- **TypeScript/JavaScript**：零建置阻力、可用 DevTools 除錯，跑 GB 綽綽有餘；只要
  避免在熱迴圈裡配置記憶體，跑 GBA 也夠快。第一款模擬器推薦用它。
- **Rust / C++ / Zig → WebAssembly**：核心快 2–5 倍，代價是工具鏈與 JS 互通的複雜度。
  常見路線是：先用 TS 打原型，之後再把 CPU/PPU 熱點核心移植到 WASM。（既有證據：
  mGBA 用 Emscripten 編譯後在瀏覽器裡跑得很好。）

### 主迴圈與時序

`requestAnimationFrame` 在每次螢幕更新時給你一次回呼——但螢幕不保證是 60 Hz
（144 Hz 螢幕很常見），而且分頁進背景時 rAF 會暫停。所以：

- 以「**一個模擬畫格**」為固定單位推進模擬（GB 70,224 cycles / GBA 280,896 cycles）；
- 每次 rAF 要跑幾個畫格，由實際經過的時間決定；或者更好——**讓音訊緩衝區帶節奏**：
  模擬一直跑到音訊環形緩衝區填滿為止。音訊硬體以精準的速率消耗取樣，所以對音訊同步
  能用同一套機制同時得到「速度正確」和「不爆音」。

```ts
function onFrame() {
  while (audioRing.spaceAvailable() > SAMPLES_PER_EMU_FRAME) {
    emu.runFrame();                     // 讓 CPU/PPU/APU 前進一個畫格
    audioRing.push(emu.takeSamples());
  }
  screen.present(emu.framebuffer);
  requestAnimationFrame(onFrame);
}
```

### 畫面

最簡單：一個 160×144 / 240×160 的 `<canvas>`，用 `ctx.putImageData(imageData, 0, 0)`，
讓 `imageData.data` 與你的 `Uint32Array` framebuffer 共用同一塊 buffer，再用 CSS
`image-rendering: pixelated` 放大。想更快／更花俏（濾鏡 shader、旋轉）：每畫格把
framebuffer 當 **WebGL/WebGPU 貼圖**上傳。

### 音訊

用 **`AudioWorklet`**——一小段在音訊執行緒上執行的處理器，從你的環形緩衝區讀取。
緩衝區用 `SharedArrayBuffer` 共享（頁面必須是 **cross-origin isolated**：伺服器要送
`Cross-Origin-Opener-Policy: same-origin` 與
`Cross-Origin-Embedder-Policy: require-corp`），或退而求其次用 `port.postMessage`
傳區塊。記得瀏覽器在使用者互動前會封鎖音訊——要在點擊事件裡啟動／恢復
`AudioContext`。

### 輸入

- **鍵盤**：`keydown`/`keyup` → 設定／清除搖桿暫存器的位元（GB：`FF00`，有它特殊的
  選擇線機制；GBA：`0x4000130` 的 `KEYINPUT`，低電位有效）。
- **Gamepad API**：每畫格輪詢一次 `navigator.getGamepads()`。
- **觸控**：定位好的 `<div>` 疊層搭配 `pointerdown/up`，給行動裝置用。

### ROM 與存檔

- 用 `<input type="file">` 或拖放載入 ROM → `File.arrayBuffer()` → `Uint8Array`。
  絕不要內建或寫死商業 ROM；開發請用自製（homebrew）與測試 ROM。
- **電池存檔**：遊戲寫入卡帶 RAM 時標記為 dirty；定期（以及在 `visibilitychange` 時）
  把位元組存進 **IndexedDB**，以 ROM 標頭的雜湊當 key。
- **即時存檔（save state）**：把「全部」模擬器狀態（每個暫存器、每個陣列、每個計數器
  ——漏掉一個，載入就會走鐘）序列化成帶版本號的二進位 blob，存進 IndexedDB。

### JS 效能守則

1. **熱迴圈內不配置記憶體。**所有 buffer 預先配置、物件重複使用。GC 停頓是你的敵人。
2. 所有記憶體用 typed array；整數運算配 `| 0` / `>>> 0`。
3. 函式保持單型（monomorphic，參數型別固定），讓 JIT 開心。
4. 考慮把核心放進 **Web Worker**（用 `OffscreenCanvas` 渲染，或把 framebuffer post
   出來），UI 執行緒卡頓就不會拖累模擬。
5. 優化前先用 DevTools 做效能分析——瓶頸通常在 PPU，不是 CPU。

---

## 5. 逐步開發路線圖

### 階段 A——Game Boy 核心

| 步驟 | 目標 | 驗收標準 |
|---|---|---|
| 1 | 專案骨架、ROM 載入器、平坦記憶體的匯流排 | 能 hex-dump 出 ROM 標頭 |
| 2 | SM83 直譯器，全部 opcode + 旗標 | **Blargg 的 `cpu_instrs`** 通過——它把結果印到序列埠暫存器，所以*還不需要 PPU*：把寫進 `FF01/FF02` 的資料 log 出來即可 |
| 3 | 中斷 + 計時器 | Blargg 的 `instr_timing` 通過 |
| 4 | PPU：背景 → 視窗 → 精靈、掃描線渲染、canvas 輸出 | 開機 Logo 與俄羅斯方塊標題畫面正確；接著 **dmg-acid2** 渲染正確 |
| 5 | 搖桿 | 俄羅斯方塊可以玩了 |
| 6 | MBC1/MBC3/MBC5 + 電池存檔進 IndexedDB | 寶可夢紅版可存檔並重新載入 |
| 7 | APU（4 聲道）+ AudioWorklet | 音樂聽起來對；Blargg 的 `dmg_sound` 大致通過 |
| 8 | （選配）Game Boy Color：分頁、調色盤、雙倍速 | CGB 遊戲能跑；**cgb-acid2** 通過 |

### 階段 B——GBA 核心

| 步驟 | 目標 | 驗收標準 |
|---|---|---|
| 1 | ARM + Thumb 直譯器、分組暫存器、含管線偏移的 PC | **jsmoo/SingleStepTests**（逐指令 JSON 測試向量）通過；再過 `armwrestler`、`gba-suite`、`FuzzARM` |
| 2 | 記憶體映射 + I/O 骨架、按鍵 | 替代 BIOS 能跑到開機動畫 |
| 3 | PPU 點陣圖模式 3/4 | 簡單 demo（Tonc 最前面的範例）能顯示 |
| 4 | DMA + 計時器 + VBlank/HBlank 中斷 | 遊戲不再卡死在 `IntrWait` |
| 5 | PPU 圖塊模式 0–2、精靈 | 選單與多數 2D 遊戲正常渲染 |
| 6 | 仿射 BG/OBJ、視窗、混合 | *Mode 7* 風格的遊戲（如賽車）看起來正確 |
| 7 | Direct Sound 音訊（FIFO + 計時器 + DMA1/2） | 音樂音高正確 |
| 8 | 存檔類型自動偵測（SRAM/Flash/EEPROM） | 商業級自製遊戲的存檔能保存 |
| 9 | 等待週期精確度、open bus 行為、效能優化 | mGBA 測試套件分數上升；中階手機也能全速 |

每一步都遵守：**先測試 ROM、再遊戲、最後才打磨**。模擬器的 bug 會複利累積：第 2 步
一個錯的旗標，會在第 5 步變成一整片花掉的畫面。出問題時，把執行軌跡（每條指令的
PC + 暫存器）和一款已知正確的模擬器**比對差異（trace diffing）**——這是模擬器開發中
最有效的除錯手段，沒有之一。

---

## 6. 測試 ROM 與文件資源

### Game Boy

| 資源 | 說明 |
|---|---|
| **Pan Docs**（gbdev.io/pandocs） | GB 硬體參考文件的*唯一正解* |
| **gbops** opcode 表 | 每個 SM83 opcode 的 cycle 數與旗標 |
| Blargg 測試 ROM | CPU、時序、音訊正確性 |
| **dmg-acid2 / cgb-acid2** | 一張截圖驗證 PPU 正確性 |
| Mooneye 測試套件 | cycle 級的邊角案例（計時器、OAM DMA…） |
| *The Ultimate Game Boy Talk*（33c3） | 最棒的一小時架構總覽 |

### GBA

| 資源 | 說明 |
|---|---|
| **GBATEK** | GBA（與 DS）硬體參考的*唯一正解*——精簡但完整 |
| **Tonc** | GBA *程式開發*教學——理解遊戲在幹嘛的無價之寶 |
| jsmoo / SingleStepTests（ARM7TDMI） | 逐指令 JSON 測試向量——不用模擬任何硬體就能測 CPU |
| armwrestler、gba-suite（jsmolka）、FuzzARM | CPU 測試 ROM |
| mGBA 測試套件 | 數百項時序/PPU/記憶體測試，附分數 |
| mGBA 開發部落格 | 真實精確度 bug 的深度剖析 |
| Cult-of-GBA BIOS / Normmatt BIOS | 開源替代 BIOS |

### 社群

- **gbdev** 社群（gbdev.io）——文件、Discord、自製遊戲。
- **Emulation Development Discord**（「emudev」）——正是做這種專案時最活躍的求助處。
- **NanoBoyAdvance**、**mGBA**、**SameBoy**——當你卡在「硬體*到底*怎麼做的？」時，
  最高品質的開源參考。

---

## 7. 常見地雷

**Game Boy**

- SM83 *不是* Z80——沒有 `IX/IY`、旗標不同、opcode 不同。Z80 的文件會誤導你。
- `DAA`（十進位調整）是最常寫錯的指令；演算法直接抄參考文件，不要自己推導。
- **HALT bug**、`EI` 延遲（中斷晚一條指令才生效）、以及計時器與 `DIV` 的精確關係，
  是測試 ROM 的經典死點。
- 精靈優先權：DMG 上 X 座標小者優先；CGB 上依 OAM 順序。每行 10 個精靈的上限是真的，
  而且有遊戲依賴它。
- PPU 模式 3 期間 CPU 不能存取 VRAM（讀到 `0xFF`）——有些遊戲依賴這個行為。

**GBA**

- Thumb 不是可有可無的裝飾——遊戲*大部分時間*都在跑 Thumb。兩套指令集要一開始就一起做。
- 管線偏移的 PC（ARM `+8` / Thumb `+4`）要立刻做對；幾乎所有分支和常數載入都依賴它。
- **Open bus**：讀未映射的記憶體會回傳最後預取的值，不是 0——好幾款遊戲依賴這點。
- EEPROM 是透過 *ROM* 區域以序列位元協定存取的，而且容量（512 B 或 8 KiB）在標頭裡
  完全沒寫——要靠 DMA 傳輸長度來判斷。
- 別忘了 `IntrWait`/`Halt`（SWI 或 `HALTCNT`）：少了它們，你的模擬器會空轉燒 cycle，
  音訊時序也會漂移。
- I/O 暫存器有各種怪異的讀寫行為（唯寫位元讀回為 0、`IF` 要*寫 1* 才能清除）。
  請讀 GBATEK 每個暫存器的註記，不要只看排版圖。

---

*本文為從零開始的設計指南；不含也不連結任何 ROM、BIOS 映像或受版權保護的素材。
開發請使用自製（homebrew）與測試 ROM。*
