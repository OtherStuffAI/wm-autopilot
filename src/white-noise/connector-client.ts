import { connect, type Socket } from "node:net";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const PROTOCOL = "marmot.agent-control.v2";
const MAX_FRAME = 262144;
export type ConnectorEnvelope = Record<string, unknown>;
export class ConnectorClient {
  private sockets = new Set<Socket>();
  constructor(private readonly path: string, private readonly token?: string) {}
  close(): void { for (const socket of this.sockets) socket.destroy(); }
  private open(): Socket {
    const dir = lstatSync(dirname(this.path)), socketInfo = lstatSync(this.path);
    if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0
      || !socketInfo.isSocket() || socketInfo.uid !== process.getuid?.() || (socketInfo.mode & 0o077) !== 0) throw new Error("connector_socket_unsafe");
    const socket = connect(this.path);
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    return socket;
  }
  private async *frames(socket: Socket): AsyncGenerator<ConnectorEnvelope> {
    let buffered = Buffer.alloc(0);
    for await (const chunk of socket) {
      buffered = Buffer.concat([buffered, chunk]);
      let end: number;
      while ((end = buffered.indexOf(10)) >= 0) {
        if (end > MAX_FRAME) throw new Error("connector_frame_too_large");
        const value = JSON.parse(buffered.subarray(0, end).toString("utf8")) as ConnectorEnvelope;
        buffered = buffered.subarray(end + 1);
        if (value.marmot_agent_control !== PROTOCOL || typeof value.type !== "string") throw new Error("connector_protocol_mismatch");
        if (value.type === "error") throw new Error("connector_request_failed");
        yield value;
      }
      if (buffered.length > MAX_FRAME) throw new Error("connector_frame_too_large");
    }
    if (buffered.length) throw new Error("connector_partial_frame");
  }
  private write(socket: Socket, id: string, request: ConnectorEnvelope): void {
    const frame = JSON.stringify({ ...request, id, marmot_agent_control: PROTOCOL, ...(this.token ? { auth_token: this.token } : {}) });
    if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error("connector_request_too_large");
    socket.write(`${frame}\n`);
  }
  async request(request: ConnectorEnvelope): Promise<ConnectorEnvelope> {
    const socket = this.open(), id = randomUUID();
    const deadline = setTimeout(() => socket.destroy(new Error("connector_timeout")), 15000);
    try {
      this.write(socket, id, request);
      for await (const frame of this.frames(socket)) {
        if (frame.id !== id) throw new Error("connector_response_id_mismatch");
        return frame;
      }
      throw new Error("connector_closed");
    } finally { clearTimeout(deadline); socket.destroy(); }
  }
  async subscribe(account: string, group: string, receive: (frame: ConnectorEnvelope) => Promise<void>): Promise<void> {
    const socket = this.open(), id = randomUUID();
    let acknowledged = false;
    const deadline = setTimeout(() => socket.destroy(new Error("connector_subscription_timeout")), 15000);
    try {
      this.write(socket, id, { type: "subscribe_inbound", account_id_hex: account, group_id_hex: group });
      for await (const frame of this.frames(socket)) {
        if (!acknowledged) {
          if (frame.type !== "ack" || frame.id !== id) throw new Error("connector_subscription_rejected");
          acknowledged = true;
          clearTimeout(deadline);
        } else await receive(frame);
      }
      throw new Error("connector_subscription_closed");
    } finally { clearTimeout(deadline); socket.destroy(); }
  }
}
