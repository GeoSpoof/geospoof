/**
 * The relay worker (`RELAY_SOURCE` in worker-relay.ts), run in a `node:vm`
 * context that stands in for a dedicated worker's global scope: a fake `self`
 * (listeners, a recording `postMessage`, `name`), a recording fake `Worker`
 * for the child, a fake `ErrorEvent`, timers the test fires by hand, and
 * Node's real `Blob`, `URL` (with `createObjectURL`), `atob`, and
 * `structuredClone`. Child blob URLs are read back with `resolveObjectURL`.
 */
import { describe, test, expect, beforeAll } from "vitest";
import vm from "node:vm";
import { Blob as NodeBlob, atob as nodeAtob, resolveObjectURL } from "node:buffer";
import { URL as NodeURL } from "node:url";

/** `state.ts` captures navigator.geolocation at import time and jsdom has none. */
function polyfillGeolocation(): void {
  if (!("geolocation" in navigator)) {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: () => undefined,
        watchPosition: () => 0,
        clearWatch: () => undefined,
      },
      configurable: true,
    });
  }
}

let RELAY_SOURCE = "";
let COMPOSE_DATA_SOURCE = "";

beforeAll(async () => {
  polyfillGeolocation();
  ({ RELAY_SOURCE } = await import("@/content/injected/worker-relay"));
  ({ COMPOSE_DATA_SOURCE } = await import("@/content/injected/worker-data-url"));
});

type Handler = (event: unknown) => void;

class FakeTarget {
  listeners: Record<string, Handler[]> = {};
  addEventListener(type: string, fn: Handler): void {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, event: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
}

interface Post {
  data: unknown;
  transfer: unknown[];
}

interface Timer {
  id: number;
  fn: () => void;
  delay: number;
  cleared: boolean;
  fired: boolean;
}

class FakeErrorEvent {
  prevented = false;
  preventDefault(): void {
    this.prevented = true;
  }
}

const KEY = "0123456789abcdef0123456789abcdef";
const SOURCE = "postMessage('page code');";
const PAYLOAD = "/* payload */ var spoofed = true;";

function makeRelay() {
  const timers: Timer[] = [];
  let nextTimer = 1;
  const fakeSetTimeout = (fn: () => void, delay: number): number => {
    const t: Timer = { id: nextTimer++, fn, delay, cleared: false, fired: false };
    timers.push(t);
    return t.id;
  };
  const fakeClearTimeout = (id: number): void => {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  };

  const selfPosts: Post[] = [];
  const self = Object.assign(new FakeTarget(), {
    name: "relay-name",
    postMessage(data: unknown, transfer: unknown[]): void {
      selfPosts.push({ data, transfer });
    },
  });

  const children: FakeWorker[] = [];
  const workerBehavior = { throwsRemaining: 0 };
  class FakeWorker extends FakeTarget {
    url: string;
    options: { name?: string } | undefined;
    posts: Post[] = [];
    postImpl: ((data: unknown, transfer: unknown[]) => void) | null = null;
    constructor(url: string, options?: { name?: string }) {
      super();
      if (workerBehavior.throwsRemaining > 0) {
        workerBehavior.throwsRemaining--;
        throw new Error("child construction failed");
      }
      this.url = url;
      this.options = options;
      children.push(this);
    }
    postMessage(data: unknown, transfer: unknown[]): void {
      if (this.postImpl) {
        this.postImpl(data, transfer);
        return;
      }
      this.posts.push({ data, transfer });
    }
  }

  const context = vm.createContext({
    self,
    Worker: FakeWorker,
    ErrorEvent: FakeErrorEvent,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    Blob: NodeBlob,
    URL: NodeURL,
    atob: nodeAtob,
    structuredClone,
    console,
  });
  vm.runInContext(RELAY_SOURCE, context);

  const deliver = (data: unknown, ports: unknown[] = []): void => {
    self.emit("message", { data, ports });
  };
  const go = (payload: string, debug = false): void => {
    deliver({ [KEY]: 1, payload, debug });
  };
  /** Fire every live timer with this delay (the relay's own timers by delay). */
  const fire = (delay: number): void => {
    for (const t of timers) {
      if (t.delay === delay && !t.cleared && !t.fired) {
        t.fired = true;
        t.fn();
      }
    }
  };
  /** Timers the relay scheduled with delay 0: each is a surfaced throw. */
  const surfaced = (): Timer[] => timers.filter((t) => t.delay === 0);

  return { self, selfPosts, children, workerBehavior, timers, deliver, go, fire, surfaced };
}

type Relay = ReturnType<typeof makeRelay>;

function initBlob(relay: Relay, source = SOURCE): NodeBlob {
  const blob = new NodeBlob([source], { type: "application/javascript" });
  relay.deliver({ k: KEY, kind: "blob", blob });
  return blob;
}

function initData(relay: Relay, url: string): void {
  relay.deliver({ k: KEY, kind: "data", url });
}

async function blobText(url: string): Promise<string> {
  const blob = resolveObjectURL(url);
  if (!blob) throw new Error(`no blob behind ${url}`);
  return blob.text();
}

function loadCompose(): (url: string, payload: string) => string | null {
  const context = vm.createContext({ URL: NodeURL, atob: nodeAtob, encodeURIComponent });
  return vm.runInContext(`${COMPOSE_DATA_SOURCE}\n__gsComposeData`, context) as (
    url: string,
    payload: string
  ) => string | null;
}

function fakePort(): object {
  return { [Symbol.toStringTag]: "MessagePort" };
}

function dataCloneError(): Error {
  const err = new Error("could not be cloned");
  err.name = "DataCloneError";
  return err;
}

describe("relay worker: control protocol", () => {
  test("1. the first message sets the key and source and isn't forwarded", () => {
    const relay = makeRelay();
    initBlob(relay);
    // The self-timeout is armed at the init, SETTINGS_WAIT_TIMEOUT + 500.
    expect(relay.timers.map((t) => t.delay)).toEqual([3500]);
    relay.go(PAYLOAD);
    expect(relay.children).toHaveLength(1);
    expect(relay.children[0].posts).toEqual([]);
    expect(relay.timers[0].cleared).toBe(true);
  });

  test("1. a malformed first message sets no key; the self-timeout surfaces one error", () => {
    const relay = makeRelay();
    relay.deliver("not an init");
    relay.deliver("m1");
    // Without a key, nothing can be a go message: it's queued as page data.
    relay.go(PAYLOAD);
    relay.deliver("m2");
    expect(relay.children).toHaveLength(0);
    relay.fire(3500);
    expect(relay.children).toHaveLength(0);
    expect(relay.surfaced()).toHaveLength(1);
    expect(() => relay.surfaced()[0].fn()).toThrow("Worker script failed to load");
    relay.deliver("m3");
    expect(relay.children).toHaveLength(0);
    expect(relay.surfaced()).toHaveLength(1);
  });

  test("2. messages before go are queued and forwarded in order; later ones directly", () => {
    const relay = makeRelay();
    initBlob(relay);
    const notGo = { payload: "ignored", "k-not-the-key": true };
    relay.deliver("first");
    relay.deliver({ n: 2 });
    relay.deliver(notGo);
    relay.go(PAYLOAD);
    const child = relay.children[0];
    expect(child.posts.map((p) => p.data)).toEqual(["first", { n: 2 }, notGo]);
    relay.deliver("after");
    expect(child.posts.map((p) => p.data)).toEqual(["first", { n: 2 }, notGo, "after"]);
  });

  test("3. blob source: the child's Blob is payload, newline, source; name is self.name", async () => {
    const relay = makeRelay();
    initBlob(relay);
    relay.go(PAYLOAD);
    const child = relay.children[0];
    expect(child.url.startsWith("blob:")).toBe(true);
    expect(child.options).toEqual({ name: "relay-name" });
    expect(await blobText(child.url)).toBe(PAYLOAD + "\n" + SOURCE);
  });

  test("3. blob source, go with an empty payload: the child's Blob is the source alone", async () => {
    const relay = makeRelay();
    initBlob(relay);
    relay.go("");
    expect(await blobText(relay.children[0].url)).toBe(SOURCE);
  });

  test("4. data source: the child URL is __gsComposeData(url, payload)", () => {
    const compose = loadCompose();
    const url = "data:application/javascript,postMessage(%22hi%22)";
    const relay = makeRelay();
    initData(relay, url);
    relay.go(PAYLOAD);
    const expected = compose(url, PAYLOAD);
    expect(expected).not.toBeNull();
    expect(relay.children[0].url).toBe(expected);
  });

  test("4. data source, go with an empty payload or a URL the composer rejects: the page's URL", () => {
    const url = "data:application/javascript,postMessage(1)";
    const unpatched = makeRelay();
    initData(unpatched, url);
    unpatched.go("");
    expect(unpatched.children[0].url).toBe(url);

    const rejected = "data:application/javascript";
    const relay = makeRelay();
    initData(relay, rejected);
    relay.go(PAYLOAD);
    expect(relay.children[0].url).toBe(rejected);
  });

  test("5. no go within SELF_TIMEOUT: the child starts unpatched; a later go is ignored", async () => {
    const relay = makeRelay();
    initBlob(relay);
    relay.deliver("queued");
    relay.fire(3500);
    expect(relay.children).toHaveLength(1);
    expect(await blobText(relay.children[0].url)).toBe(SOURCE);
    expect(relay.children[0].posts.map((p) => p.data)).toEqual(["queued"]);
    relay.go(PAYLOAD);
    expect(relay.children).toHaveLength(1);
    expect(relay.children[0].posts.map((p) => p.data)).toEqual(["queued"]);
  });

  test("5. a second go is ignored", () => {
    const relay = makeRelay();
    initBlob(relay);
    relay.go(PAYLOAD);
    relay.go("second");
    expect(relay.children).toHaveLength(1);
    expect(relay.children[0].posts).toEqual([]);
  });

  test("6. a child constructor that throws with the payload is retried without it", async () => {
    const relay = makeRelay();
    initBlob(relay);
    relay.workerBehavior.throwsRemaining = 1;
    relay.go(PAYLOAD);
    expect(relay.children).toHaveLength(1);
    expect(await blobText(relay.children[0].url)).toBe(SOURCE);
    expect(relay.surfaced()).toHaveLength(0);
  });

  test("6. a child constructor that throws both times surfaces one error; later messages drop", () => {
    const relay = makeRelay();
    initBlob(relay);
    relay.deliver("queued");
    relay.workerBehavior.throwsRemaining = 2;
    relay.go(PAYLOAD);
    expect(relay.children).toHaveLength(0);
    expect(relay.surfaced()).toHaveLength(1);
    relay.deliver("later");
    expect(relay.children).toHaveLength(0);
    expect(relay.surfaced()).toHaveLength(1);
  });

  test("7. a child ErrorEvent schedules nothing and isn't cancelled; a plain event surfaces one", () => {
    const relay = makeRelay();
    initBlob(relay);
    relay.go(PAYLOAD);
    const child = relay.children[0];
    const runtimeError = new FakeErrorEvent();
    child.emit("error", runtimeError);
    expect(runtimeError.prevented).toBe(false);
    expect(relay.surfaced()).toHaveLength(0);

    let prevented = false;
    child.emit("error", {
      type: "error",
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(false);
    expect(relay.surfaced()).toHaveLength(1);
  });

  test("8. child messages are forwarded to self.postMessage with their ports", () => {
    const relay = makeRelay();
    initBlob(relay);
    relay.go(PAYLOAD);
    const port = fakePort();
    relay.children[0].emit("message", { data: { hello: "page" }, ports: [port] });
    expect(relay.selfPosts).toHaveLength(1);
    expect(relay.selfPosts[0].data).toEqual({ hello: "page" });
    expect(relay.selfPosts[0].transfer).toEqual([port]);
  });
});

describe("relay worker: forwarding", () => {
  function started(): { relay: Relay; child: Relay["children"][number] } {
    const relay = makeRelay();
    initBlob(relay);
    relay.go(PAYLOAD);
    return { relay, child: relay.children[0] };
  }

  test("9. the transfer list collects every transferable once and skips shared memory", () => {
    const { relay, child } = started();
    const ab = new ArrayBuffer(8);
    const u8 = new Uint8Array(new ArrayBuffer(16));
    const dv = new DataView(new ArrayBuffer(4));
    const sab = new SharedArrayBuffer(8);
    const sabView = new Int32Array(sab);
    const portInData = fakePort();
    const portInPorts = fakePort();
    const mapKey = { buf: new ArrayBuffer(1) };
    const mapValue = { buf: new ArrayBuffer(2) };
    const setValue = { buf: new ArrayBuffer(3) };
    const arr = [1, 2] as unknown[] & { named?: { buf: ArrayBuffer } };
    arr.named = { buf: new ArrayBuffer(5) };
    const cycle: Record<string, unknown> = { ab };
    cycle.self = cycle;
    const data = {
      deep: { deeper: { ab } },
      dup: ab,
      u8,
      dv,
      sab,
      sabView,
      port: portInData,
      map: new Map([[mapKey, mapValue]]),
      set: new Set([setValue]),
      arr,
      cycle,
      text: "x",
      n: 1,
    };
    relay.deliver(data, [portInPorts]);
    const transfer = child.posts[0].transfer;
    const expected = [
      ab,
      u8.buffer,
      dv.buffer,
      portInData,
      portInPorts,
      mapKey.buf,
      mapValue.buf,
      setValue.buf,
      arr.named.buf,
    ];
    expect(transfer).toHaveLength(expected.length);
    for (const item of expected) expect(transfer).toContain(item);
    expect(transfer).not.toContain(sab);
    expect(child.posts[0].data).toBe(data);
  });

  test("10. a sparse array is walked by its values, not its length", () => {
    const { relay, child } = started();
    const sparse: unknown[] = [];
    sparse[5e7] = { buf: new ArrayBuffer(8) };
    const cloned = structuredClone(sparse);
    const t0 = performance.now();
    relay.deliver(cloned);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
    expect(child.posts[0].transfer).toEqual([(cloned[5e7] as { buf: ArrayBuffer }).buf]);
  });

  test("11. a first DataCloneError is retried once with the generic probe", () => {
    const { relay, child } = started();
    const ab = new ArrayBuffer(4);
    // A leaf structuredClone rejects stands in for a transferable the tag list doesn't know.
    const unknownTransferable = { [Symbol.toStringTag]: "FancyHandle", fn(): void {} };
    let calls = 0;
    child.postImpl = (data, transfer) => {
      calls++;
      if (calls === 1) throw dataCloneError();
      child.posts.push({ data, transfer });
    };
    relay.deliver({ ab, handle: unknownTransferable });
    expect(calls).toBe(2);
    expect(child.posts).toHaveLength(1);
    expect(child.posts[0].transfer).toContain(ab);
    expect(child.posts[0].transfer).toContain(unknownTransferable);
  });

  test("11. a second DataCloneError drops only that message", () => {
    const { relay, child } = started();
    let calls = 0;
    child.postImpl = (data, transfer) => {
      calls++;
      if (calls <= 2) throw dataCloneError();
      child.posts.push({ data, transfer });
    };
    relay.deliver("dropped");
    relay.deliver("next");
    expect(calls).toBe(3);
    expect(child.posts.map((p) => p.data)).toEqual(["next"]);
    expect(relay.surfaced()).toHaveLength(0);
  });

  test("12. a TypeError from postMessage drops that message and surfaces nothing", () => {
    const { relay, child } = started();
    let calls = 0;
    child.postImpl = (data, transfer) => {
      calls++;
      if (calls === 1) throw new TypeError("not postable");
      child.posts.push({ data, transfer });
    };
    relay.deliver("dropped");
    relay.deliver("next");
    expect(calls).toBe(2);
    expect(child.posts.map((p) => p.data)).toEqual(["next"]);
    expect(relay.surfaced()).toHaveLength(0);
  });

  test("12. a walk that throws still posts the message with its ports alone", () => {
    const { relay, child } = started();
    const port = fakePort();
    const data = {
      get boom(): never {
        throw new Error("walk bug");
      },
    };
    relay.deliver(data, [port]);
    expect(child.posts).toHaveLength(1);
    expect(child.posts[0].data).toBe(data);
    expect(child.posts[0].transfer).toEqual([port]);
    relay.deliver("next");
    expect(child.posts.map((p) => p.data)).toEqual([data, "next"]);
    expect(relay.surfaced()).toHaveLength(0);
  });
});
