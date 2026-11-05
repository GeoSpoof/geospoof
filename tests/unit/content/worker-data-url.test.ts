// @vitest-environment node
/**
 * `__gsComposeData` (COMPOSE_DATA_SOURCE) composes a patched `data:` worker URL
 * from a page's `data:` URL. It runs in worker scope, so it is evaluated here
 * in a `node:vm` context that holds only `URL`, `atob`, and
 * `encodeURIComponent`, which proves the source is self-contained. Node's
 * `fetch` on `data:` URLs (undici's implementation of the fetch `data:` URL
 * processor) is the reference decoder: a composed URL is right when it decodes
 * to the payload, a newline, and whatever the page's own URL decodes to.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import vm from "node:vm";
import { Worker } from "node:worker_threads";
import { COMPOSE_DATA_SOURCE, MAX_DATA_URL } from "@/content/injected/worker-data-url";

type Compose = (url: string, payload: string) => string | null;

function loadCompose(): Compose {
  const context = vm.createContext({ URL, atob, encodeURIComponent });
  return vm.runInContext(`${COMPOSE_DATA_SOURCE}\n__gsComposeData`, context) as Compose;
}

// tests/setup.ts replaces the global `fetch` with a mock, so the reference
// decoder runs Node's own fetch in a worker thread, whose globals it doesn't touch.
const DECODER_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", async ({ id, url }) => {
  try {
    const text = await (await fetch(url)).text();
    parentPort.postMessage({ id, text });
  } catch (err) {
    parentPort.postMessage({ id, error: String(err) });
  }
});
`;

let decoder: Worker;
let nextId = 0;
const waiting = new Map<number, { resolve: (text: string) => void; reject: (e: Error) => void }>();

beforeAll(() => {
  decoder = new Worker(DECODER_SOURCE, { eval: true });
  decoder.on("message", (msg: { id: number; text?: string; error?: string }) => {
    const entry = waiting.get(msg.id);
    if (!entry) return;
    waiting.delete(msg.id);
    if (msg.error !== undefined) entry.reject(new Error(msg.error));
    else entry.resolve(msg.text ?? "");
  });
});

afterAll(async () => {
  await decoder.terminate();
});

function decode(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    decoder.postMessage({ id, url: dataUrl });
  });
}

const compose = loadCompose();
const PAYLOAD = 'var __p = "payload ✓ 100% #1 $& \\u00e9";';

/** What every composed URL starts with, before the page's body. */
function prefixFor(payload: string): string {
  return "data:application/javascript," + encodeURIComponent(payload + "\n");
}

describe("__gsComposeData", () => {
  test("the source names none of the WORKER_WRAPPER placeholders", () => {
    expect(COMPOSE_DATA_SOURCE).not.toContain("__ORIGINAL_SCRIPT_URL__");
    expect(COMPOSE_DATA_SOURCE).not.toContain("__SPOOF_CORE__");
    expect(COMPOSE_DATA_SOURCE).not.toContain("__NESTED_WRAPPER_TEMPLATE__");
    expect(COMPOSE_DATA_SOURCE).toContain(String(MAX_DATA_URL));
  });

  test("percent-encoded body is appended verbatim (lone %, #fragment, raw non-ASCII)", async () => {
    const page =
      'data:text/javascript;charset=utf-8,var a = "50%"; var b = "%41%zz"; var c = "é日本"; postMessage(a)#frag';
    const composed = compose(page, PAYLOAD);
    expect(composed).not.toBeNull();
    expect(composed).toBe(prefixFor(PAYLOAD) + page.slice(page.indexOf(",") + 1));
    const pageText = await decode(page);
    expect(pageText).toBe('var a = "50%"; var b = "A%zz"; var c = "é日本"; postMessage(a)');
    expect(await decode(composed as string)).toBe(PAYLOAD + "\n" + pageText);
  });

  test("base64 body: decodes to the same bytes, printable bytes kept literally", async () => {
    let printable = "";
    for (let c = 0x20; c <= 0x7e; c++) printable += String.fromCharCode(c);
    const source = `${printable}\u0000\u007f\t\r\n é日本😀 // end`;
    const b64 = Buffer.from(source, "utf8").toString("base64");
    const page = `data:application/javascript;base64,${b64}`;

    const composed = compose(page, PAYLOAD);
    expect(composed).not.toBeNull();
    const pageText = await decode(page);
    expect(pageText).toBe(source);
    expect(await decode(composed as string)).toBe(PAYLOAD + "\n" + source);

    const rest = (composed as string).slice(prefixFor(PAYLOAD).length);
    for (let c = 0x21; c <= 0x7e; c++) {
      const ch = String.fromCharCode(c);
      if (ch === "#" || ch === "%") continue;
      expect(rest, `byte 0x${c.toString(16)} should appear literally`).toContain(ch);
    }
    expect(rest).not.toContain("#");
    expect(rest.replace(/%[0-9A-F]{2}/g, "")).not.toContain("%");
  });

  test("base64 metadata is matched with spaces and in any case; the fragment is dropped", async () => {
    const source = "postMessage(1)";
    const b64 = Buffer.from(source, "utf8").toString("base64");
    const page = `data:application/javascript ; BASE64 ,${b64}#frag`;
    const composed = compose(page, PAYLOAD);
    expect(composed).not.toBeNull();
    expect(composed).not.toContain("#");
    expect(await decode(composed as string)).toBe(PAYLOAD + "\n" + source);
  });

  test("the guard measures the parsed length: raw é counts as %C3%A9", () => {
    const body = "é".repeat(400_000);
    const page = `data:application/javascript,${body}`;
    // Under the limit as a string, over it once parsed.
    expect(prefixFor("p").length + body.length).toBeLessThanOrEqual(MAX_DATA_URL);
    expect(new URL(prefixFor("p") + body).href.length).toBeGreaterThan(MAX_DATA_URL);
    expect(compose(page, "p")).toBeNull();
  });

  test("a parsed length of exactly MAX_DATA_URL is accepted, one more is rejected", () => {
    const prefixLength = new URL(prefixFor(PAYLOAD)).href.length;
    const fits = "a".repeat(MAX_DATA_URL - prefixLength);
    const accepted = compose(`data:application/javascript,${fits}`, PAYLOAD);
    expect(accepted).not.toBeNull();
    expect(new URL(accepted as string).href.length).toBe(MAX_DATA_URL);
    expect(compose(`data:application/javascript,${fits}a`, PAYLOAD)).toBeNull();
  });

  test("no comma, or invalid base64: null", () => {
    expect(compose("data:application/javascript", PAYLOAD)).toBeNull();
    expect(compose("data:application/javascript;base64,@@@@", PAYLOAD)).toBeNull();
    expect(compose("data:application/javascript;base64,a", PAYLOAD)).toBeNull();
    expect(compose("data:application/javascript;base64,é", PAYLOAD)).toBeNull();
  });
});
