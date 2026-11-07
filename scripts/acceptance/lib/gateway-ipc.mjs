// Minimal framed IPC client for acceptance scripts — same 4-byte
// length-prefixed JSON envelope protocol the gateway serves on its
// unix socket. Speaks hello + request/response; can also answer
// server-initiated requests (browser.tool.request) so a script can
// impersonate an extension browser host.
import net from "node:net";
import { randomUUID } from "node:crypto";

const FRAME_HEADER = 4;

export class GatewayIpc {
  #socket = null;
  #buf = Buffer.alloc(0);
  #pending = new Map();
  // hello is per-connection — a cached promise is not enough: the
  // socket can die and reconnect underneath us (gateway restart) and
  // a rejected hello must not poison later requests.
  #helloedSocket = null;
  #helloInflight = new Map();
  #requestHandler = null;
  constructor(endpoint, token, hello = {}) {
    this.endpoint = endpoint;
    this.token = token;
    this.hello = {
      protocolVersion: 1,
      clientVersion: "chromex-accept-ipc/0.1.0",
      clientId: "accept-ipc",
      profileId: "accept",
      browserInstanceId: null,
      hostInstanceId: "",
      ...hello,
    };
  }
  /** fn(method, payload) → result | throws {code,message} */
  setRequestHandler(fn) {
    this.#requestHandler = fn;
  }
  #connect() {
    if (this.#socket && !this.#socket.destroyed) return Promise.resolve(this.#socket);
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.endpoint);
      sock.once("error", reject);
      sock.once("connect", () => {
        sock.off("error", reject);
        sock.on("error", () => this.#failAll(new Error("ipc socket error")));
        sock.on("data", (d) => this.#onData(d));
        sock.on("close", () => this.#failAll(new Error("ipc socket closed")));
        this.#socket = sock;
        resolve(sock);
      });
    });
  }
  #failAll(err) {
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
    this.#socket = null;
    this.#helloedSocket = null;
  }
  #onData(d) {
    this.#buf = Buffer.concat([this.#buf, d]);
    for (;;) {
      if (this.#buf.length < FRAME_HEADER) return;
      const len = this.#buf.readUInt32LE(0);
      if (this.#buf.length < FRAME_HEADER + len) return;
      const body = this.#buf.subarray(FRAME_HEADER, FRAME_HEADER + len);
      this.#buf = this.#buf.subarray(FRAME_HEADER + len);
      let env;
      try { env = JSON.parse(body.toString("utf8")); } catch { continue; }
      if (env.kind === "response" && typeof env.id === "string") {
        const p = this.#pending.get(env.id);
        if (!p) continue;
        this.#pending.delete(env.id);
        if (env.error) p.reject(Object.assign(new Error(`${env.error.code ?? "error"}: ${env.error.message ?? ""}`), { code: env.error.code }));
        else p.resolve(env.result);
      } else if (env.kind === "request" && typeof env.id === "string") {
        void this.#answerRequest(env);
      }
    }
  }
  async #answerRequest(env) {
    const sock = this.#socket;
    if (!sock || !this.#requestHandler) {
      this.#send(sock, { v: 1, kind: "response", id: env.id, error: { code: "proto.unimplemented", message: "no request handler" } });
      return;
    }
    try {
      const result = await this.#requestHandler(env.method, env.payload);
      this.#send(sock, { v: 1, kind: "response", id: env.id, result });
    } catch (err) {
      this.#send(sock, {
        v: 1, kind: "response", id: env.id,
        error: { code: err?.code ?? "host.error", message: err?.message ?? String(err) },
      });
    }
  }
  #send(sock, env) {
    const body = Buffer.from(JSON.stringify(env), "utf8");
    const frame = Buffer.alloc(FRAME_HEADER + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, FRAME_HEADER);
    sock.write(frame);
  }
  #helloOnce(sock) {
    let p = this.#helloInflight.get(sock);
    if (!p) {
      p = (async () => {
        const id = `hello-${randomUUID()}`;
        await new Promise((resolve, reject) => {
          this.#pending.set(id, { resolve, reject });
          this.#send(sock, {
            v: 1, kind: "request", id, method: "hello",
            payload: { ...this.hello, token: this.token },
          });
        });
        this.#helloedSocket = sock;
      })().finally(() => this.#helloInflight.delete(sock));
      this.#helloInflight.set(sock, p);
    }
    return p;
  }
  async #ensureHello() {
    for (;;) {
      const sock = await this.#connect();
      if (this.#helloedSocket === sock) return;
      try {
        await this.#helloOnce(sock);
        return;
      } catch (err) {
        if (this.#socket === sock && !sock.destroyed) throw err;
      }
    }
  }
  async request(method, payload) {
    await this.#ensureHello();
    const sock = await this.#connect();
    const id = `req-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send(sock, { v: 1, kind: "request", id, method, payload });
    });
  }
  close() {
    try { this.#socket?.destroy(); } catch {}
    this.#socket = null;
    this.#failAll(new Error("ipc closed"));
  }
}
