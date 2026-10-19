import { describe, it, expect, afterEach } from "vitest";
import {
  connect as http2Connect,
  createServer,
  type ClientHttp2Session,
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import {
  ApnsClient,
  apnsAuthority,
  APNS_HOSTS,
  type ApnsSendRequest,
} from "../../lib/lambda/apns-relay/apns-client";

const TOKEN = "80" + "12".repeat(39);
const APNS_ID = "8E4A2F6B-1C3D-4E5F-A6B7-C8D9E0F1A2B3";

type Handler = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, body: string) => void;

interface TestServer {
  authority: string;
  server: Http2Server;
  sessions: ServerHttp2Session[];
  requests: { headers: IncomingHttpHeaders; body: string }[];
  close(): Promise<void>;
}

const open: { clients: ApnsClient[]; servers: TestServer[] } = { clients: [], servers: [] };

afterEach(async () => {
  for (const c of open.clients.splice(0)) c.close();
  for (const s of open.servers.splice(0)) await s.close();
});

async function startServer(handler: Handler): Promise<TestServer> {
  const server = createServer();
  const sessions: ServerHttp2Session[] = [];
  const requests: TestServer["requests"] = [];
  server.on("session", (s) => sessions.push(s));
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ headers, body });
      handler(stream, headers, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const t: TestServer = {
    authority: `http://127.0.0.1:${port}`,
    server,
    sessions,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sessions) s.destroy();
        server.close(() => resolve());
      }),
  };
  open.servers.push(t);
  return t;
}

function client(opts: ConstructorParameters<typeof ApnsClient>[0] = {}): ApnsClient {
  const c = new ApnsClient(opts);
  open.clients.push(c);
  return c;
}

function request(authority: string, overrides: Partial<ApnsSendRequest> = {}): ApnsSendRequest {
  return {
    authority,
    pushToken: TOKEN,
    jwt: "header.claims.signature",
    topic: "com.moonloaf.geospoof.push-type.liveactivity",
    pushType: "liveactivity",
    priority: "10",
    payload: JSON.stringify({ aps: { timestamp: 1, event: "update" } }),
    ...overrides,
  };
}

const ok200: Handler = (stream) => {
  stream.respond({ ":status": 200, "apns-id": APNS_ID });
  stream.end();
};

describe("ApnsClient", () => {
  it("knows the two APNs hosts", () => {
    expect(APNS_HOSTS).toEqual({
      sandbox: "api.sandbox.push.apple.com",
      production: "api.push.apple.com",
    });
    expect(apnsAuthority("sandbox")).toBe("https://api.sandbox.push.apple.com");
    expect(apnsAuthority("production")).toBe("https://api.push.apple.com");
  });

  it("sends exactly the script's request", async () => {
    const s = await startServer(ok200);
    const req = request(s.authority, { priority: "5" });
    await client().send(req);
    expect(s.requests).toHaveLength(1);
    const { headers, body } = s.requests[0];
    expect(headers[":method"]).toBe("POST");
    expect(headers[":path"]).toBe(`/3/device/${TOKEN}`);
    expect(headers.authorization).toBe("bearer header.claims.signature");
    expect(headers["apns-topic"]).toBe("com.moonloaf.geospoof.push-type.liveactivity");
    expect(headers["apns-push-type"]).toBe("liveactivity");
    expect(headers["apns-priority"]).toBe("5");
    expect(headers["apns-expiration"]).toBeUndefined();
    expect(headers["apns-collapse-id"]).toBeUndefined();
    expect(headers["apns-id"]).toBeUndefined();
    expect(body).toBe(req.payload);
  });

  it("reports a 200 with its apns-id", async () => {
    const s = await startServer(ok200);
    expect(await client().send(request(s.authority))).toEqual({
      kind: "response",
      status: 200,
      apnsId: APNS_ID,
    });
  });

  it("surfaces a 400 reason, and drops a reason that is not a plain enum", async () => {
    let reason = "BadDeviceToken";
    const s = await startServer((stream) => {
      stream.respond({ ":status": 400, "apns-id": APNS_ID });
      stream.end(JSON.stringify({ reason }));
    });
    const c = client();
    expect(await c.send(request(s.authority))).toEqual({
      kind: "response",
      status: 400,
      apnsId: APNS_ID,
      reason: "BadDeviceToken",
    });
    reason = "Bad<script>Token";
    expect(await c.send(request(s.authority))).toEqual({
      kind: "response",
      status: 400,
      apnsId: APNS_ID,
    });
  });

  it("drops a malformed apns-id and tolerates a non-JSON body", async () => {
    const s = await startServer((stream) => {
      stream.respond({ ":status": 500, "apns-id": "not-an-id" });
      stream.end("<html>oops</html>");
    });
    expect(await client().send(request(s.authority))).toEqual({ kind: "response", status: 500 });
  });

  it("reuses one session across sends", async () => {
    const s = await startServer(ok200);
    const c = client();
    await c.send(request(s.authority));
    await c.send(request(s.authority));
    await c.send(request(s.authority));
    expect(s.requests).toHaveLength(3);
    expect(s.sessions).toHaveLength(1);
  });

  it("opens a new session after the server sends GOAWAY", async () => {
    const s = await startServer((stream) => {
      const session = stream.session;
      ok200(stream, {}, "");
      session?.goaway();
    });
    const c = client();
    expect((await c.send(request(s.authority))).kind).toBe("response");
    await new Promise((r) => setTimeout(r, 50));
    expect(await c.send(request(s.authority))).toMatchObject({ kind: "response", status: 200 });
    expect(s.sessions).toHaveLength(2);
  });

  it("opens a new session after the server closes the connection", async () => {
    const s = await startServer((stream) => {
      const session = stream.session;
      ok200(stream, {}, "");
      setTimeout(() => session?.destroy(), 10);
    });
    const c = client();
    await c.send(request(s.authority));
    await new Promise((r) => setTimeout(r, 80));
    expect(await c.send(request(s.authority))).toMatchObject({ kind: "response", status: 200 });
    expect(s.sessions).toHaveLength(2);
  });

  it("reconnects proactively after idling longer than idleReconnectMs", async () => {
    const s = await startServer(ok200);
    let now = 1_000_000;
    const c = client({ nowMs: () => now, idleReconnectMs: 180_000 });
    await c.send(request(s.authority));
    now += 179_000;
    await c.send(request(s.authority));
    expect(s.sessions).toHaveLength(1);
    now += 180_001;
    await c.send(request(s.authority));
    expect(s.sessions).toHaveLength(2);
  });

  it("times out within timeoutMs when APNs never answers, and destroys the session", async () => {
    const s = await startServer(() => undefined);
    const sessions: ClientHttp2Session[] = [];
    const c = client({
      timeoutMs: 150,
      connect: (a) => {
        const session = http2Connect(a);
        sessions.push(session);
        return session;
      },
    });
    const started = Date.now();
    expect(await c.send(request(s.authority))).toEqual({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(sessions[0].destroyed).toBe(true);
    // And it does not retry a timeout.
    expect(sessions).toHaveLength(1);
  });

  it("retries once on a fresh session when a reused session fails before headers", async () => {
    const s = await startServer(ok200);
    const sessions: ClientHttp2Session[] = [];
    const c = client({
      connect: (a) => {
        const session = http2Connect(a);
        sessions.push(session);
        return session;
      },
    });
    await c.send(request(s.authority));
    // Simulate the socket having died while the container was frozen.
    sessions[0].request = () => {
      throw Object.assign(new Error("dead socket"), { code: "ERR_HTTP2_INVALID_SESSION" });
    };
    expect(await c.send(request(s.authority))).toMatchObject({ kind: "response", status: 200 });
    expect(sessions).toHaveLength(2);
  });

  it("returns network without retrying when a fresh session cannot connect", async () => {
    const s = await startServer(ok200);
    const authority = s.authority;
    await s.close();
    open.servers.splice(open.servers.indexOf(s), 1);
    let connects = 0;
    const c = client({
      connect: (a) => {
        connects++;
        return http2Connect(a);
      },
    });
    const r = await c.send(request(authority));
    expect(r).toEqual({ kind: "network", code: "ECONNREFUSED" });
    expect(connects).toBe(1);
  });
});
