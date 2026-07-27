import { spawn } from "node:child_process";
import { platform } from "node:os";

import type { BrowserPort, FetchResponse } from "./types.js";

interface ChromeOptions {
  chromePath?: string;
  profileDir: string;
  port: number;
  headless: boolean;
  autoLaunch: boolean;
  timeoutMs: number;
}

type JsonObject = Record<string, unknown>;
type Pending = { resolve: (value: JsonObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

const BASE_URL = "https://www.intermarche.com/drive-catalogue";
const DEFAULT_BIN: Record<string, string> = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "chromium",
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function tryJson(url: string, method = "GET"): Promise<any | null> {
  try {
    const response = await fetch(url, { method });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export class ChromeSession implements BrowserPort {
  private ws?: WebSocket;
  private messageId = 0;
  private pending = new Map<number, Pending>();
  private connectPromise?: Promise<void>;

  constructor(private readonly options: ChromeOptions) {}

  async status(): Promise<{ connected: boolean; url?: string; title?: string }> {
    try {
      await this.ensureConnected();
      return await this.evaluate<{ connected: boolean; url: string; title: string }>(
        "({connected:true,url:location.href,title:document.title})",
      );
    } catch {
      return { connected: false };
    }
  }

  async evaluate<T>(expression: string): Promise<T> {
    await this.ensureConnected();
    const response = await this.cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const result = (response.result as JsonObject | undefined)?.result as JsonObject | undefined;
    const exception = (response.result as JsonObject | undefined)?.exceptionDetails;
    if (exception || !result) throw new Error(`Évaluation CDP échouée: ${JSON.stringify(exception ?? response)}`);
    return result.value as T;
  }

  async fetch(
    baseUrl: string,
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<FetchResponse> {
    await this.ensureConnected();
    await this.ensureOrigin(baseUrl);
    const args = {
      url,
      timeoutMs: Math.max(1_000, this.options.timeoutMs - 2_000),
      init: {
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        body: options.body,
        credentials: "include",
      },
    };
    const value = await this.evaluate<{
      status?: number;
      ok?: boolean;
      statusText?: string;
      body?: string;
      error?: string;
    }>(`(async()=>{const a=${JSON.stringify(args)};const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),a.timeoutMs);try{a.init.signal=controller.signal;const r=await fetch(a.url,a.init);const body=await r.text();return {status:r.status,ok:r.ok,statusText:r.statusText,body};}catch(e){return {error:String(e)}}finally{clearTimeout(timer)}})()`);
    if (value.error || value.status === undefined || value.body === undefined) {
      throw new Error(`Requête navigateur échouée: ${value.error ?? "réponse CDP invalide"}`);
    }
    return {
      status: value.status,
      ok: Boolean(value.ok),
      statusText: value.statusText ?? "",
      text: () => value.body!,
      json: () => JSON.parse(value.body!),
    };
  }

  async close(): Promise<void> {
    this.rejectPending(new Error("Connexion CDP fermée."));
    try {
      this.ws?.close();
    } catch {
      // Best effort only. The MCP never closes Chrome itself.
    }
    this.ws = undefined;
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.connectPromise ??= this.connect().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    const endpoint = `http://127.0.0.1:${this.options.port}`;
    let version = await tryJson(`${endpoint}/json/version`);
    if (!version) {
      if (!this.options.autoLaunch) {
        throw new Error(`Aucun Chrome CDP sur le port ${this.options.port}. Démarre Chromium avec --remote-debugging-port=${this.options.port}.`);
      }
      const binary = this.options.chromePath || DEFAULT_BIN[platform()] || "chromium";
      const args = [
        `--remote-debugging-address=127.0.0.1`,
        `--remote-debugging-port=${this.options.port}`,
        `--user-data-dir=${this.options.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ];
      if (this.options.headless) args.unshift("--headless=new");
      const child = spawn(binary, args, { detached: true, stdio: "ignore" });
      child.unref();
      for (let attempt = 0; attempt < 40 && !version; attempt++) {
        await pause(500);
        version = await tryJson(`${endpoint}/json/version`);
      }
      if (!version) throw new Error(`Chromium n'a pas démarré sur le port ${this.options.port}.`);
    }

    const targets = ((await tryJson(`${endpoint}/json/list`)) ?? []) as Array<{
      type?: string;
      url?: string;
      title?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const pages = targets.filter((target) => target.type === "page");
    let page = pages.find((target) => isIntermarcheUrl(target.url));
    if (!page) {
      const blanks = pages.filter((target) => !target.url || target.url === "about:blank");
      if (blanks.length === 1) page = blanks[0];
    }
    if (!page && pages.length === 0) page = await tryJson(`${endpoint}/json/new?${encodeURIComponent("about:blank")}`, "PUT");
    if (!page?.webSocketDebuggerUrl) {
      throw new Error(
        "Aucun onglet Intermarché disponible dans Chromium CDP. Ouvre Intermarché dans cet unique onglet; le serveur ne crée pas d'onglet supplémentaire.",
      );
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Connexion CDP expirée.")), this.options.timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Connexion CDP échouée."));
      };
    });
    ws.onmessage = (event) => this.onMessage(String(event.data));
    ws.onclose = () => {
      this.rejectPending(new Error("L'onglet Chromium CDP a été fermé."));
      this.ws = undefined;
    };
    this.ws = ws;
    await this.cdp("Page.enable");
    if (!isIntermarcheUrl(page.url)) await this.navigate(BASE_URL);
  }

  private async ensureOrigin(baseUrl: string): Promise<void> {
    const current = await this.evaluate<string>("location.origin");
    if (current === new URL(baseUrl).origin) return;
    await this.navigate(baseUrl);
  }

  private async navigate(url: string): Promise<void> {
    await this.cdp("Page.navigate", { url });
    for (let attempt = 0; attempt < 60; attempt++) {
      await pause(250);
      const state = await this.evaluate<string>("document.readyState").catch(() => "loading");
      if (state === "interactive" || state === "complete") break;
    }
    await pause(1800);
  }

  private cdp(method: string, params: JsonObject = {}): Promise<JsonObject> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP non connecté."));
    const id = ++this.messageId;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} a dépassé ${this.options.timeoutMs} ms.`));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  private onMessage(raw: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(raw) as JsonObject;
    } catch {
      return;
    }
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (message.error) pending.reject(new Error(`CDP: ${JSON.stringify(message.error)}`));
    else pending.resolve(message);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isIntermarcheUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "intermarche.com" || host.endsWith(".intermarche.com");
  } catch {
    return false;
  }
}
