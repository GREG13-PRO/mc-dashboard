type ServerMessage =
  | { type: "output"; data: string }
  | { type: "status"; running: boolean }
  | { type: "error"; message: string };

function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

export class ConsoleSocket {
  private ws: WebSocket;

  constructor(
    serverId: string,
    private handlers: {
      onOutput: (text: string) => void;
      onStatus: (running: boolean) => void;
      onError?: (message: string) => void;
      onClose?: () => void;
    }
  ) {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${protocol}//${location.host}/ws/console/${serverId}`);
    this.ws.onmessage = (event) => this.handleMessage(event.data);
    this.ws.onclose = () => this.handlers.onClose?.();
  }

  private handleMessage(raw: string) {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "output":
        this.handlers.onOutput(base64ToUtf8(msg.data));
        break;
      case "status":
        this.handlers.onStatus(msg.running);
        break;
      case "error":
        this.handlers.onError?.(msg.message);
        break;
    }
  }

  private send(payload: Record<string, unknown>) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  sendInput(line: string) {
    this.send({ type: "input", data: line.endsWith("\n") ? line : `${line}\n` });
  }

  close() {
    this.ws.close();
  }
}
