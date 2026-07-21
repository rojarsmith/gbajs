# gbajs 程式碼導讀——逐檔解析這台模擬器如何運作

[English](./CODE_TOUR.md) | **繁體中文**

這是一份對照真實原始碼的導覽，寫給想搞懂——並最終能親手重現——一台可運作 Game Boy
模擬器的軟體工程師。它與[從零開始指南](../README.zh-TW.md)（理論與路線圖）互為表裡：
本文件是實作面——程式碼在做什麼、*為什麼*長成這個形狀、哪些演算法承重。以下所有
程式片段都是本儲存庫的真實程式碼。

**建議閱讀順序**（即依賴順序，也是實際開發的順序）：

```text
1. src/core/cartridge.ts   ROM 解析 + 分頁切換       （約 200 行）
2. src/core/bus.ts         記憶體映射                 （約 160 行）
3. src/core/cpu.ts         SM83 直譯器                （約 450 行）
4. src/core/timer.ts       最簡單的時脈裝置           （約 80 行）
5. src/core/ppu.ts         掃描線渲染 + CGB           （約 340 行）
6. src/core/joypad.ts      最小的元件                 （約 50 行）
7. src/core/apu.ts         聲音合成                   （約 450 行）
8. src/core/gb.ts          30 行的主機組裝
9. src/frontend/*          瀏覽器整合
```

---

## 0. 一切懸掛其上的那一個觀念

遊戲主機就是幾顆共用一個時脈的晶片。整個模擬器的架構就是把這句話變成可執行的程式——
[gb.ts](../src/core/gb.ts) *就是*設計本身：

```ts
step(): number {
  const cycles = this.cpu.step();
  this.timer.step(cycles); // the timer follows the CPU clock
  const vc = this.bus.doubleSpeed ? cycles >> 1 : cycles;
  this.ppu.step(vc);
  this.apu.step(vc);
  return vc;
}
```

Cycle（T-cycle，每秒 4,194,304 個）是*貨幣*。每個元件的 `step()` 接收經過的 cycle
數並更新內部狀態。沒有任何元件看牆上的時鐘；決定論因此免費而來——這正是整套測試
策略（§9）得以成立的原因。

`vc` 那一行是 Game Boy Color 的**雙倍速模式**濃縮成的一個分支：遊戲透過 `STOP`
切換 KEY1 後，CPU 與計時器以兩倍速運轉，但影像與聲音維持真實世界的時序——所以
PPU/APU（以及使用回傳值的畫格配速）直接收到 *CPU cycle 數的一半*。兩個時脈域，
一個除法。

注意貫穿全案的解耦技巧：元件之間從不互相持有參照。計時器要觸發中斷時，呼叫的是
組裝層接好的 callback：

```ts
this.timer.requestInterrupt = () => this.bus.requestInterrupt(2);
this.ppu.requestInterrupt = bit => this.bus.requestInterrupt(bit);
```

如果你要寫自己的模擬器：先讓這副骨架用空殼元件站起來。剩下的一切都是往格子裡填東西。

---

## 1. 卡帶——[cartridge.ts](../src/core/cartridge.ts)

### 標頭解析

每顆 ROM 的 `0x100-0x14F` 描述卡帶本身。有趣的是標頭 checksum——完全重現開機 ROM
的計算：

```ts
let sum = 0;
for (let i = 0x134; i <= 0x14c; i++) {
  sum = (sum - rom[i] - 1) & 0xff;
}
```

### 分頁切換——關鍵演算法

GB 的位址空間只露出 32 KiB 的 ROM。更大的卡帶在匯流排與 ROM 晶片之間放一顆
*記憶體分頁控制器（MBC）*；**對 ROM 位址寫入**（本來毫無意義的操作）就是在設定它的
暫存器。整個把戲就是位址組合：

```ts
readRom(addr: number): number {
  let bank: number;
  if (addr < 0x4000) {
    bank = this.kind === "mbc1" && this.mode ? (this.bank2 << 5) & this.romBankMask : 0;
  } else if (this.kind === "mbc1") {
    bank = ((this.bank2 << 5) | this.romBank) & this.romBankMask;
  } else {
    bank = this.romBank & this.romBankMask;
  }
  return this.rom[(bank << 14) | (addr & 0x3fff)];
}
```

要內化的三件事：

- **Bank 號碼由暫存器碎片拼裝而成。**MBC1 的 5-bit `romBank` 加 2-bit `bank2` 湊成
  7 bits；MBC5 的 9-bit bank 拆在兩個暫存器裡。
- **`& romBankMask` 是迴繞規則。**ROM 大小都是 2 的冪，所以用 `(size >> 14) - 1`
  做遮罩就重現了「位址線沒接」的硬體行為——在 4-bank 卡帶上寫 bank 0x42 會選到
  bank 2。Mooneye 的 `rom_*` 測試正是為了驗證這個。
- **`(bank << 14) | (addr & 0x3fff)`**——bank 是 16 KiB，所以 bank 號碼與偏移量直接
  串接成平坦索引，不需要查表。

同樣的迴繞想法處理「RAM 比定址範圍小」的情況（`% this.ram.length` 產生鏡像）；
MBC1 的 `mode` 位元決定 `bank2` 是重映射 `0000-3FFF`/RAM 還是擴充 ROM 分頁——
程式碼讀起來就是 Pan Docs 的描述。

**練習：**加入 MBC2（512×4-bit 內建 RAM、bank 暫存器與 RAM enable 重疊）。mooneye
的 `emulator-only/mbc2` 測試會幫你打分數。

---

## 2. 匯流排——[bus.ts](../src/core/bus.ts)

機器裡每一次記憶體存取都收斂到兩個函式。設計規則：`read8`/`write8` 是**依位址排序
的範圍檢查鏈**，每個區域背後是一個 `Uint8Array` 或委派給擁有它的元件：

```ts
read8(addr: number): number {
  addr &= 0xffff;
  if (addr < 0x8000) return this.cart.readRom(addr);
  if (addr < 0xa000) return this.ppu.vram[addr - 0x8000];
  if (addr < 0xc000) return this.cart.readRam(addr - 0xa000);
  if (addr < 0xe000) return this.wram[addr - 0xc000];
  if (addr < 0xfe00) return this.wram[addr - 0xe000]; // echo RAM
  ...
}
```

為什麼是一個函式而不是各元件自帶記憶體映射？因為*硬體怪癖都住在邊界上*：echo RAM
是配線的副產品、讀未映射的 `FEA0-FEFF` 回 `0xFF`、`IF` 的上位三 bits 讀起來是 1。
單一分派點意味著所有怪癖只有一個家。

I/O（`FF00-FF7F`）是讀寫不再是「儲存」而變成「*行為*」的地方——讀 `LY` 回傳 PPU
的即時掃描線，而這一行就是一顆完整的 DMA 引擎：

```ts
if (addr === 0xff46) { // OAM DMA：從 value<<8 複製 160 bytes
  const src = value << 8;
  for (let i = 0; i < 0xa0; i++) this.ppu.oam[i] = this.read8(src + i);
}
```

（真實 DMA 佔用 160 M-cycles、期間 CPU 只能碰 HRAM；瞬間完成的版本在你去追
Mooneye 的 OAM DMA 測試之前都*夠*準確。）

### CGB 擴充

彩色硬體把匯流排加寬了，但沒有改變它的形狀。所有 CGB 功能都閘在一個旗標後面,
讓 DMG 卡帶看到的匯流排*一模一樣*：

- **WRAM 分頁**（`SVBK`）：`C000-CFFF` 固定、`D000-DFFF` 在 7 個 bank 間切換——
  一個索引函式同時服務讀、寫與 echo RAM：

  ```ts
  private wramIndex(addr: number): number {
    return addr < 0xd000 ? addr - 0xc000 : (this.svbk << 12) + (addr - 0xd000);
  }
  ```

- **VRAM 分頁**（`VBK`）：匯流排委派給 `ppu.readVram`/`writeVram`，內部套用
  `(vbk << 13) | offset`——由 PPU 持有兩個 bank，因為渲染需要同時讀它們
  （tile 在 bank 0/1、屬性永遠在 bank 1）。
- **KEY1 + `speedSwitch()`**：一個準備位元，加上由 `STOP` 執行的切換。
- **HDMA/GDMA**（`FF51-FF55`）：一般 DMA 立即複製全部區塊；HBlank DMA 每條掃描線
  透過 PPU 回呼搬 16 bytes——與中斷相同的解耦模式：

  ```ts
  hdmaHblank(): void {
    if (!this.hdmaActive) return;
    this.hdmaCopyBlock();
    if (--this.hdmaBlocks === 0) this.hdmaActive = false;
  }
  ```

---

## 3. CPU——[cpu.ts](../src/core/cpu.ts)

最大的檔案，但結構單純：狀態 + 輔助函式 + 256 格分派表 + 256 格 CB 表。

### 用迴圈生成的分派表

SM83 的 opcode 編排出了名地規律，程式碼徹底利用這點：**表的大部分由迴圈填入**，
不是手寫。整個 63 條 `LD r, r'` 區塊只有五行：

```ts
for (let i = 0x40; i < 0x80; i++) {
  if (i === 0x76) continue; // 那一格是 HALT
  const dst = (i >> 3) & 7;
  const src = i & 7;
  OPS[i] = c => { R8_SET[dst](c, R8_GET[src](c)); return dst === 6 || src === 6 ? 8 : 4; };
}
```

魔法在**暫存器存取表**，索引 0-7 = `B C D E H L (HL) A`：

```ts
const R8_GET: ((c: CPU) => number)[] = [
  c => c.b, c => c.c, c => c.d, c => c.e, c => c.h, c => c.l,
  c => c.bus.read8(c.hl), c => c.a,   // 索引 6 是「HL 指向的記憶體」！
];
```

第 6 格是「HL 指向的記憶體」而非暫存器——這正是硬體編碼的實際樣貌；把它做成一等
公民的存取器之後，`INC (HL)` 和 `INC B` 就是同一段生成碼。ALU 區塊（64 條）、所有
立即值形式（8 條）、整張 CB 前綴表（256 條）都用同樣方式生成。手寫的 opcode 只有
幾十條。

### 旗標運算——所有 bug 的老家

值得背下來的程式碼小抄：

```ts
// 8-bit 加法：half-carry = bit 3 的進位，用「NIBBLE」計算
this.fl((r & 0xff) === 0, false, (this.a & 0xf) + (v & 0xf) + carry > 0xf, r > 0xff);
// 8-bit 減法：同一件事的借位版本
this.fl((r & 0xff) === 0, true, (this.a & 0xf) - (v & 0xf) - borrow < 0, r < 0);
// ADD HL,rr：half-carry 出自 bit 11，而且 Z「保留不動」
this.f = (this.f & FZ) | ((hl & 0xfff) + (v & 0xfff) > 0xfff ? FH : 0) | (r > 0xffff ? FC : 0);
// ADD SP,e / LD HL,SP+e：運算元有號，旗標卻來自「無號」低位元組運算
this.fl(false, false, (this.sp & 0xf) + (raw & 0xf) > 0xf, (this.sp & 0xff) + (raw & 0xff) > 0xff);
```

還有 `DAA`——GB 模擬器裡最常寫錯的一條指令。別自己推導，照抄：

```ts
if (this.f & FN) {                       // 減法之後
  if (this.f & FC) a = (a - 0x60) & 0xff;
  if (this.f & FH) a = (a - 0x06) & 0xff;
} else {                                 // 加法之後
  if ((this.f & FC) || a > 0x99) { a = (a + 0x60) & 0xff; this.f |= FC; }
  if ((this.f & FH) || (a & 0xf) > 0x09) a = (a + 0x06) & 0xff;
}
```

### 中斷，以及 EI 延遲

中斷分派是位元運算——最低的 set bit = 最高優先權：

```ts
const bit = pending & -pending;          // 孤立出最低的 set bit
const idx = 31 - Math.clz32(bit);        // 位元索引
this.pc = 0x40 + (idx << 3);             // 向量是 0x40,0x48,……
```

`EI` 要到*下一條指令之後*才開啟中斷——遊戲仰賴 `EI; RET` 這兩條之間永遠不會被
插斷。實作方式：執行前先抓住排程旗標、執行後才套用、並讓 `DI` 能取消它：

```ts
const willEnable = this.imeScheduled;
const cycles = handler(this);
if (willEnable && this.imeScheduled) { this.ime = true; this.imeScheduled = false; }
```

這裡也有兩處 CGB 痕跡：開機後的 `A` 暫存器兼作遊戲檢查的硬體型號訊號
（`0x01` DMG、`0x11` CGB）；`STOP` 會呼叫 `bus.speedSwitch()`——KEY1 雙倍速切換。

**怎麼知道 CPU 寫對了：**Blargg 的 `cpu_instrs` 驗證每條 opcode 的語意、
`instr_timing` 驗證每條的 cycle 數。在 PPU 存在之前，結果經由匯流排的序列埠
hook 送出（§9）。這台模擬器在計時器完成後首跑就拿下 11/11 與 `instr_timing`
通過——這是「照抄旗標規則、不要即興發揮」的回報。

---

## 4. 計時器——[timer.ts](../src/core/timer.ts)

計時器示範了每個時脈裝置都用的模式：**用整數數學把「經過了幾個 cycle」換算成
「發生了幾次事件」，而不是逐 cycle 迴圈。**

硬體：一個自由運轉的 16-bit 計數器。`DIV` 是它的高位元組；`TIMA` 在 TAC 選定的
計數器位元 1→0 時遞增，也就是每 `2^shift` 個 cycle 一次。所以一步之內的遞增次數
就是商的差：

```ts
const old = this.counter;
const now = old + cycles;
this.counter = now & 0xffff;
const shift = SHIFTS[this.tac & 3];              // 10, 4, 6, 8
let tima = this.tima + ((now >> shift) - (old >> shift));
```

`(now >> shift) - (old >> shift)` 精確數出這段跨越了幾個週期邊界——任意步長皆可
批次處理、零漂移。同一個「商差」慣用法在 APU 的 frame sequencer 與取樣裡再度登場。

---

## 5. PPU——[ppu.ts](../src/core/ppu.ts)

### 模式狀態機

PPU 的時序骨架是對一個 dot 計數器的兩行算術：

```ts
this.dot += cycles;
while (this.dot >= 456) { this.dot -= 456; this.ly++; ... }     // 下一條掃描線
const mode = this.ly >= 144 ? 1 : this.dot < 80 ? 2 : this.dot < 252 ? 3 : 0;
```

觸發一切的是模式*轉換*（不是狀態本身）：進入模式 0 就渲染該行、進入模式 1 就發
VBlank 並完成一幀，每次轉換都在啟用時發出對應的 STAT 中斷。**在 3→0 轉換時一次
渲染整行**是承重的設計決策：遊戲會在行與行之間改捲軸/調色盤暫存器（逐行特效），
逐行渲染尊重這件事，同時比逐像素模擬便宜約百倍。dmg-acid2——靠 LYC 中斷逐行切換
LCDC 位元——在這個渲染器上逐像素全對。

### Tile 取像——六行搞定位元平面繪圖

GB 所有圖形都是 8×8 tile、每像素 2 bits、拆在兩個*位元平面*上：

```ts
private tilePixel(tileIdx: number, px: number, py: number): number {
  const base = this.lcdc & 0x10
    ? tileIdx << 4                                // 0x8000 區，無號索引
    : 0x1000 + (((tileIdx << 24) >> 24) << 4);    // 0x8800 區，「有號」索引
  const lo = this.vram[base + (py << 1)];
  const hi = this.vram[base + (py << 1) + 1];
  const bit = 7 - px;
  return (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
}
```

注意 `(tileIdx << 24) >> 24`——JS 把位元組做符號延伸的標準慣用法，因為兩種 tile
定址模式之一把索引當有號數。背景捲動就是 `(x + scx) & 0xff`（圖在 256 像素處迴繞）；
視窗是同一套取像，但由它自己的**內部行計數器**驅動——只在視窗實際可見的行遞增,
正是 dmg-acid2 的「鼻子」所檢驗的怪癖。

### 精靈優先權——先排序，再從後往前畫

```ts
// 掃描出覆蓋本行的前 10 個精靈（OAM 順序）
// DMG 優先權：X 小者勝，再比 OAM 索引
found.sort((a, b) => this.oam[a*4+1] - this.oam[b*4+1] || a - b);
for (let k = found.length - 1; k >= 0; k--) { /* 繪製 */ }
```

**從後往前**畫讓畫家演算法解決重疊：最高優先權的精靈最後畫；高優先權精靈的透明
像素（顏色 0）自然讓低優先權的透出來。再補兩條規則就完整了：每行 10 個的上限來自
*掃描*而非繪製；behind-BG 旗標查的是 `lineColor[x]`——背景階段逐像素記下的背景
色索引。

### CGB：屬性、調色盤、與一套新的優先權秩序

彩色模式重用整套掃描線機器，只改三件事。

**每個 BG tile 多了一個屬性位元組**，位於 VRAM bank 1 的相同圖址——調色盤、
tile bank、翻轉與一個優先權位元：

```ts
const attr = this.vram[0x2000 + mi]; // attribute map lives in bank 1
if (attr & 0x20) px = 7 - px;
if (attr & 0x40) py = 7 - py;
const ci = this.tileColor(tileIdx, px, py, attr & 0x08 ? 0x2000 : 0);
```

**顏色來自調色盤 RAM**，經由索引/資料暫存器對（BCPS/BCPD）帶自動遞增寫入。每筆
2 位元組是 BGR555；快取在寫入當下轉成 RGBA，5-bit 通道的展開公式正是 acid 測試
規定的那一條：

```ts
cache[i >> 1] = 0xff000000 |
  (((b << 3) | (b >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((r << 3) | (r >> 2));
```

**優先權重新配線**：精靈只看 OAM 索引（DMG 的 X 座標規則消失——程式碼直接跳過
排序）、BG 屬性的 bit 7 能讓該 tile 的背景壓在精靈上、而 `LCDC.0`——DMG 的
「關背景」開關——變成把所有精靈抬到最上層的*主優先權*覆寫。一張 acid 測試同時
釘死上述全部：**cgb-acid2，逐像素完全一致（0/23,040）**。

---

## 6. 搖桿——[joypad.ts](../src/core/joypad.ts)

最小的元件，一個不直觀的觀念：按鍵是 2×4 的**矩陣**。遊戲寫 bits 4-5 選一列
（0 = 選中！）、讀 bits 0-3 得到該列的行（0 = 按下！）。一切都是低電位有效：

```ts
read(): number {
  let lines = 0x0f;
  if (!(this.select & 0x10)) lines &= ~this.pressed & 0x0f;        // 十字鍵列
  if (!(this.select & 0x20)) lines &= (~this.pressed >> 4) & 0x0f; // 按鈕列
  return 0xc0 | this.select | lines;
}
```

一個值得記住的實戰故事：這個元件存在之前，I/O 空殼對 `FF00` 回傳 `0x00`——在
低電位有效的世界裡，那等於*所有按鍵同時按住*。遊戲在那種狀態下行為詭異。如果你的
模擬器很早期就開機異常，先檢查搖桿空殼回傳什麼。

---

## 7. APU——[apu.ts](../src/core/apu.ts)

APU 是三個子系統疊起來的：**合成**（聲道*此刻*輸出什麼）、**調變**（frame
sequencer 隨時間改變音量/頻率）、**取樣**（把 4 MHz 的訊號變成 48 kHz 的音訊）。

### 合成

每個聲道是一個週期計時器加一個位置，用與系統計時器相同的慣用法批次處理：

```ts
c.timer -= cycles;
while (c.timer <= 0) {
  c.timer += (2048 - c.freq) << 2;   // 方波週期（T-cycles）
  c.pos = (c.pos + 1) & 7;           // 前進 8 步 duty 型樣
}
```

雜訊聲道把 duty 型樣換成 15-bit LFSR——三行程式碼，從 hi-hat 到爆炸聲全包：

```ts
const bit = (n.lfsr ^ (n.lfsr >> 1)) & 1;
n.lfsr = (n.lfsr >> 1) | (bit << 14);
if (n.width7) n.lfsr = (n.lfsr & ~0x40) | (bit << 6);   // 短模式：金屬聲
```

### 調變——frame sequencer

一個 512 Hz 的節拍器（8192 cycles），由步號決定執行什麼——length counter 在
256 Hz、掃頻在 128 Hz、包絡在 64 Hz。要做對的是這張*時刻表*；單元本身都只是
計數器。冷門行為叢集（enable 邊緣的額外 length 時脈、sweep negate 模式閂鎖、
length counter 在斷電後存活）集中在 `lenEnableQuirk`/`triggerSquare`/`reset`——
在基本功能可用*之後*，被 Blargg `dmg_sound` 一項一項測著加上去（5/12 → 9/12）。

### 取樣與直流問題

每 `4194304 / sampleRate` 個 cycle 經小數累加器產出一組立體聲取樣。混音把每個
DAC 的 0-15 映到 −1..1——留下可觀的直流偏移（開著但靜音的聲道停在 −1）。實機用
輸出電容移除它；模擬器用 Blargg 的一階高通等效：

```ts
const outL = left - this.capL;
this.capL = left - outL * this.hpCharge;   // hpCharge = 0.999958 ^ cyclesPerSample
```

實測效果：直流平均 −0.75 → −0.0003。

### 音訊作為主時鐘

整台模擬器最精妙的部分在 [main.ts](../src/frontend/main.ts) 而不在 APU：
**音訊緩衝區帶動模擬的節奏**。

```ts
while (audio.bufferedSeconds() < TARGET_BUFFER && guard++ < 8) {
  gb.runFrame();
  audio.push(gb.apu.drain());
}
```

音效卡以*精確*的速率消耗取樣，所以「維持約 90 ms 的佇列」同時是速度調節器與防爆音
保證——螢幕更新率各有不同（60/90/144 Hz），音訊時鐘不會。兩個真實 bug 記錄在
[audio.ts](../src/frontend/audio.ts) 裡、值得一讀：被 transfer 的 `ArrayBuffer`
會分離（要在 `postMessage` *之前*讀 `chunk.length`，否則計量讀到 0、模擬以 800%
狂奔）；緩衝欠載必須重新錨定時鐘基準,不然主迴圈會在每次停頓後快轉「追進度」。

---

## 8. 前端——[src/frontend](../src/frontend)

- **[main.ts](../src/frontend/main.ts)**——機器生命週期。電池 RAM 在建構*之前*
  還原（遊戲的第一次讀取就必須看到它）；髒 RAM 每 2 秒沖寫；`runToken` 讓載入新
  ROM 時舊迴圈自動失效。
- **[zip.ts](../src/frontend/zip.ts)**——約 100 行的完整 ZIP 讀取器：從檔尾反向
  掃描 end-of-central-directory 簽章、走訪條目、用瀏覽器原生
  `DecompressionStream("deflate-raw")` 解壓。零依賴。
- **[storage.ts](../src/frontend/storage.ts)**——兩個 promise 包裝函式搞定
  IndexedDB。存檔以 `標題 + 全域 checksum + ROM 大小` 為鍵。
- **[audio-worklet.js](../public/audio-worklet.js)**——音訊執行緒那一半：由
  `postMessage` 餵入的區塊佇列。用 MessagePort（而非 SharedArrayBuffer）以幾毫秒
  延遲換取不需要 COOP/COEP 部署標頭的自由。

---

## 9. 測試方法論——你怎麼「知道」它是對的

本專案從未用「玩玩遊戲瞇眼看」除錯。每一層都有裁判：

| 層 | 裁判 | 通道 |
|---|---|---|
| CPU 語意 | Blargg `cpu_instrs` | 寫序列埠——匯流排的 `onSerial` hook 擷取，**不需要 PPU** |
| CPU 時序 | Blargg `instr_timing` | 序列埠 |
| MBC 分頁 | Mooneye `emulator-only/mbc*` | `LD B,B` 後暫存器 B..L 持有費氏數列 `3,5,8,13,21,34` |
| PPU | dmg-acid2 | framebuffer 與參考 PNG 的**逐像素 diff** |
| CGB PPU | cgb-acid2 | 相同的逐像素 diff，換成 15-bit 色彩 |
| APU | Blargg `dmg_sound` | `0xA000` 的結果位元組（+ 簽章 `DE B0 61`） |
| 整合 | 超級瑪利歐樂園 | 能開機、播 demo、能玩 |

兩個讓這一切能在瀏覽器裡運作的習慣：

- **決定論逃生口。**`window.gbDev` 暴露 `runFrames(n)` 與 `setPaused()`。即時
  迴圈*在你每次除錯呼叫之間持續運轉*——早期一個「Start 按了沒反應」的 bug，真相
  是 attract demo 在呼叫之間輪替走位。凍結迴圈、同步驅動畫格，每個測試都可重現。
- **數字勝過肉眼。**PPU 用 23,040 像素的 diff 簽收（0 差異）、APU 量測取樣數/
  直流平均/過零次數、配速量測 3 秒牆鐘窗口內 99.9% 速度。肉眼曾誤判嘴巴「沒
  渲染」，像素 diff 證明它在。
- **相信數字，但要校驗量具。**第一次 cgb-acid2 diff 回報 560 個不符——每一個都是
  ±1~2 的通道偏移。渲染器其實是完美的；是 Chrome 的 canvas *色彩管理*悄悄轉換了
  參考 PNG。改用 `createImageBitmap(blob, { colorSpaceConversion: "none" })` 解碼後
  diff 歸零。當量測值與預期相差一個可疑地均勻的小量時，先懷疑量測儀器。

當某個東西壞了又沒有裁判時，最後手段是**軌跡比對（trace diffing）**：這裡與一台
已知正確的模擬器都逐指令記錄 `PC + 暫存器`，`diff` 會找出第一個分歧點。

---

## 10. 學習路徑——寫出你自己的

本 repo 的 commit 歷史*就是*教程；每個 PR 是一個自足的步驟，附驗收測試：

| 步驟 | 建造 | 關卡 |
|---|---|---|
| 1 | ROM 載入器、hex-dump 標頭 | 你的眼睛 |
| 2 | 完整 CPU + 序列埠 hook | Blargg `cpu_instrs` |
| 3 | 計時器、中斷 | Blargg `instr_timing` |
| 4 | 掃描線 PPU | dmg-acid2 像素 diff |
| 5 | 搖桿矩陣 | 一款遊戲變得能玩 |
| 6 | MBC + 存檔 | Mooneye MBC 套件 |
| 7 | APU + 音訊配速 | Blargg `dmg_sound`、速度 ≈ 100% |
| 8 | Game Boy Color：分頁、調色盤、雙倍速 | cgb-acid2 像素 diff |

對照本程式碼庫的建議練習，難度遞增：

1. **加入 MBC2**（`cartridge.ts`）——mooneye 幫你打分數。
2. **CGB 相容調色盤**：DMG 卡帶在真實 CGB 上會拿到開機 ROM 指派的顏色；本模擬器
   目前以 DMG 綠階顯示。實作那套調色盤指派。
3. **修好 `dmg_sound` 09/10/12**——需要模擬 wave 聲道在指令*內*的哪個時刻取資料；
   淺嚐 cycle 級精確度。
4. **實作 HALT bug**（`cpu.ts` 裡有 TODO）——然後跑 Blargg 的 `halt_bug.gb`。
5. **CGB 模式 APU**：CGB 上 length counter *不會*在斷電後存活（`reset()` 目前保留
   的是 DMG 行為）——依模式分支，並用 `cgb_sound` 驗證。
6. **事件排程器**：把逐步推進換成「CPU 一路跑到下一個有趣事件」（README §3），
   量測加速幅度。
7. **GBA**——用完全相同的方法再走一圈更大的迴圈（README 階段 B）。

要帶走的元課題是：*先測試 ROM 再遊戲、一步一個子系統、一個決定論測具、數值化
驗證*。是這個迴圈——而不是哪張 opcode 表——讓一個人能從零寫出一台模擬器。
