/**
 * SingleStepTests/ARM7TDMI harness. Parses the .json.bin files directly
 * (format documented by v1/transcode_json.py in that repo) and runs each
 * vector against src/gba/arm7.ts:
 *
 *   npx tsx scripts/arm7-tests.ts roms/arm7-tests/*.json.bin [--max N] [--verbose N]
 *
 * Per test: load the initial state (registers, banks, CPSR, SPSRs, 2-deep
 * pipeline), execute ONE instruction, compare the final state. The bus
 * replays the recorded memory transactions: reads return the recorded data
 * (matched by kind/size/address), instruction fetches fall back to
 * "opcode at base_addr, else the address itself".
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ARM7, type Arm7Bus } from "../src/gba/arm7";

interface State {
  R: number[]; R_fiq: number[]; R_svc: number[]; R_abt: number[];
  R_irq: number[]; R_und: number[]; CPSR: number; SPSR: number[];
  pipeline: number[];
}

interface Txn { kind: number; size: number; addr: number; data: number; used: boolean }

interface Test {
  initial: State;
  final: State;
  transactions: Txn[];
  opcode: number;
  baseAddr: number;
}

function parseState(view: DataView, ptr: number): [number, State] {
  const size = view.getInt32(ptr, true);
  let p = ptr + 8;
  const u = (): number => { const v = view.getUint32(p, true); p += 4; return v; };
  const arr = (n: number): number[] => Array.from({ length: n }, u);
  const s: State = {
    R: arr(16), R_fiq: arr(7), R_svc: arr(2), R_abt: arr(2), R_irq: arr(2), R_und: arr(2),
    CPSR: u(), SPSR: arr(5), pipeline: arr(2),
  };
  u(); // trailing "access" field, ignored
  return [size, s];
}

function parseFile(path: string): Test[] {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, true) !== 0xd33dbae0) throw new Error(`bad magic in ${path}`);
  const count = view.getUint32(4, true);
  const tests: Test[] = [];
  let ptr = 8;
  for (let i = 0; i < count; i++) {
    const testSize = view.getInt32(ptr, true);
    let p = ptr + 4;
    const [s1, initial] = parseState(view, p);
    p += s1;
    const [s2, final] = parseState(view, p);
    p += s2;
    const txnSize = view.getInt32(p, true);
    const numTxns = view.getInt32(p + 8, true);
    const transactions: Txn[] = [];
    let tp = p + 12;
    for (let t = 0; t < numTxns; t++) {
      transactions.push({
        kind: view.getUint32(tp, true),
        size: view.getUint32(tp + 4, true),
        addr: view.getUint32(tp + 8, true),
        data: view.getUint32(tp + 12, true),
        used: false,
      });
      tp += 24;
    }
    p += txnSize;
    const opcode = view.getUint32(p + 8, true);
    const baseAddr = view.getUint32(p + 12, true);
    tests.push({ initial, final, transactions, opcode, baseAddr });
    ptr += testSize;
  }
  return tests;
}

class ReplayBus implements Arm7Bus {
  test!: Test;
  anomalies = 0;

  private lookup(kind: number, size: number, addr: number): number | null {
    const mask = ~(size - 1);
    for (const t of this.test.transactions) {
      if (t.used || t.kind !== kind || t.size !== size) continue;
      if ((t.addr & mask) >>> 0 === (addr & mask) >>> 0) {
        t.used = true;
        return t.data | 0;
      }
    }
    return null;
  }

  private readData(size: number, addr: number): number {
    // Kind 1 = plain read; SWP's locked accesses are recorded as kind 3.
    const hit = this.lookup(1, size, addr) ?? this.lookup(3, size, addr);
    if (hit !== null) return hit;
    this.anomalies++;
    return addr | 0;
  }

  private readCode(size: number, addr: number): number {
    const hit = this.lookup(0, size, addr);
    if (hit !== null) return hit;
    const mask = ~(size - 1);
    if ((addr & mask) >>> 0 === (this.test.baseAddr & mask) >>> 0) return this.test.opcode | 0;
    return addr | 0;
  }

  read8(addr: number): number { return this.readData(1, addr) & 0xff; }
  read16(addr: number): number { return this.readData(2, addr) & 0xffff; }
  read32(addr: number): number { return this.readData(4, addr); }
  fetch16(addr: number): number { return this.readCode(2, addr) & 0xffff; }
  fetch32(addr: number): number { return this.readCode(4, addr); }
  write8(_addr: number, _v: number): void {}
  write16(_addr: number, _v: number): void {}
  write32(_addr: number, _v: number): void {}
}

function diffStates(actual: State, expected: State): string[] {
  const diffs: string[] = [];
  const cmp = (name: string, a: number, e: number): void => {
    if ((a >>> 0) !== (e >>> 0)) {
      diffs.push(`${name}: got ${(a >>> 0).toString(16)} want ${(e >>> 0).toString(16)}`);
    }
  };
  for (let i = 0; i < 16; i++) cmp(`R${i}`, actual.R[i], expected.R[i]);
  for (let i = 0; i < 7; i++) cmp(`R_fiq${i + 8}`, actual.R_fiq[i], expected.R_fiq[i]);
  for (let i = 0; i < 2; i++) {
    cmp(`R_svc${i + 13}`, actual.R_svc[i], expected.R_svc[i]);
    cmp(`R_abt${i + 13}`, actual.R_abt[i], expected.R_abt[i]);
    cmp(`R_irq${i + 13}`, actual.R_irq[i], expected.R_irq[i]);
    cmp(`R_und${i + 13}`, actual.R_und[i], expected.R_und[i]);
  }
  cmp("CPSR", actual.CPSR, expected.CPSR);
  const spsrNames = ["fiq", "svc", "abt", "irq", "und"];
  for (let i = 0; i < 5; i++) cmp(`SPSR_${spsrNames[i]}`, actual.SPSR[i], expected.SPSR[i]);
  cmp("pipe0", actual.pipeline[0], expected.pipeline[0]);
  cmp("pipe1", actual.pipeline[1], expected.pipeline[1]);
  return diffs;
}

// ---- main -----------------------------------------------------------------

const args = process.argv.slice(2);
const files: string[] = [];
let maxTests = Infinity;
let verbose = 3;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--max") maxTests = Number(args[++i]);
  else if (args[i] === "--verbose") verbose = Number(args[++i]);
  else if (statSync(args[i]).isDirectory()) {
    for (const f of readdirSync(args[i]).sort()) {
      if (f.endsWith(".json.bin")) files.push(join(args[i], f));
    }
  } else {
    files.push(args[i]);
  }
}

let totalPass = 0;
let totalFail = 0;

for (const file of files) {
  const tests = parseFile(file);
  const bus = new ReplayBus();
  const cpu = new ARM7(bus);
  let pass = 0;
  let fail = 0;
  let shown = 0;

  const n = Math.min(tests.length, maxTests);
  for (let i = 0; i < n; i++) {
    const test = tests[i];
    for (const t of test.transactions) t.used = false;
    bus.test = test;
    cpu.setState(test.initial);
    cpu.step();
    const diffs = diffStates(cpu.getState(), test.final);
    if (diffs.length === 0) pass++;
    else {
      fail++;
      if (shown < verbose) {
        shown++;
        console.log(`  #${i} op=${(test.opcode >>> 0).toString(16).padStart(8, "0")} ` +
          `cpsr=${(test.initial.CPSR >>> 0).toString(16)} ${diffs.join("; ")}`);
      }
    }
  }
  const name = file.split(/[\\/]/).pop();
  console.log(`${fail === 0 ? "PASS" : "FAIL"} ${name}: ${pass}/${n}`);
  totalPass += pass;
  totalFail += fail;
}

console.log(`\nTOTAL: ${totalPass} passed, ${totalFail} failed`);
process.exit(totalFail === 0 ? 0 : 1);
