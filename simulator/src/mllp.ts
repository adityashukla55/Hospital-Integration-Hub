import net from 'node:net';
import { parseAck } from './hl7.ts';

const SB = 0x0b;
const EB = 0x1c;
const CR = 0x0d;

export function frame(message: string): Buffer {
  return Buffer.concat([Buffer.from([SB]), Buffer.from(message, 'utf8'), Buffer.from([EB, CR])]);
}

/**
 * Persistent MLLP connection that sends one message at a time and waits for
 * its ACK (original acknowledgment mode, as most KIS interfaces work).
 */
export class MllpClient {
  private socket?: net.Socket;
  private buffer = Buffer.alloc(0);
  private waiting?: { resolve: (ack: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private host: string;
  private port: number;
  private timeoutMs: number;

  constructor(host: string, port: number, timeoutMs = 10000) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port }, () => resolve());
      s.on('error', (e) => {
        if (this.waiting) this.fail(e);
        reject(e);
      });
      s.on('data', (chunk) => this.onData(chunk));
      s.on('close', () => this.fail(new Error('connection closed')));
      this.socket = s;
    });
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const start = this.buffer.indexOf(SB);
    const end = this.buffer.indexOf(EB);
    if (start >= 0 && end > start) {
      const ack = this.buffer.subarray(start + 1, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 2);
      const w = this.waiting;
      this.waiting = undefined;
      if (w) {
        clearTimeout(w.timer);
        w.resolve(ack);
      }
    }
  }

  private fail(e: Error) {
    const w = this.waiting;
    this.waiting = undefined;
    if (w) {
      clearTimeout(w.timer);
      w.reject(e);
    }
  }

  send(message: string): Promise<{ code: string; controlId: string; text: string; raw: string }> {
    if (!this.socket) throw new Error('not connected');
    if (this.waiting) throw new Error('a message is already in flight');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`no ACK within ${this.timeoutMs} ms`)), this.timeoutMs);
      this.waiting = { resolve: (raw) => resolve({ ...parseAck(raw), raw }), reject, timer };
      this.socket!.write(frame(message));
    });
  }

  close() {
    this.socket?.end();
    this.socket = undefined;
  }
}
