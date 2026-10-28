// Bridge ("ponte"): run the player inside another page of the same origin.
//
// When a page of the player is opened with `?ponte=1` inside a same-origin iframe, every
// request to the API (`<path_prefix>/api/...`) is relayed to the parent window with
// postMessage instead of going to the network. The parent decides how the request reaches
// the server (for example over a WebRTC data channel it already has with the host) and
// answers with the HTTP response. Everything else — static files, the WebRTC stream
// itself — is unchanged.
//
// Protocol (all messages are plain objects, same origin only):
//   player → parent  { type: "lt-fetch", id, method, path, headers: [name, value][], body: string | null }
//                    { type: "lt-fetch-abort", id }
//                    { type: "lt-exit" }                         (the user left the stream)
//   parent → player  { type: "lt-fetch-head", id, status, headers: [name, value][] }
//                    { type: "lt-fetch-chunk", id, data: ArrayBuffer }
//                    { type: "lt-fetch-end", id }
//                    { type: "lt-fetch-error", id, message }
//
// Lightning fork, "single traversal" (`?ponte=1&ponteWs=1`): the stream's WebSocket also goes
// through the parent, over the connection it already has with the host, so the video doesn't
// need a second NAT traversal (the WebRTC stream used to fail where the parent's own
// connection worked). The player then uses the WebSocket transport instead of WebRTC.
//   player → parent  { type: "lt-ws-open", id, path }   { type: "lt-ws-send", id, data }
//                    { type: "lt-ws-close", id }
//   parent → player  { type: "lt-ws-opened", id }   { type: "lt-ws-message", id, data }
//                    { type: "lt-ws-closed", id }
import { buildUrl } from "./config_"

type Pending = {
    head: (status: number, headers: [string, string][]) => void
    chunk: (data: Uint8Array) => void
    end: () => void
    fail: (message: string) => void
}

const pending = new Map<number, Pending>()
let nextId = 1
let installed = false
let listening = false
function listen() {
    if (listening) return
    listening = true
    window.addEventListener("message", onMessage)
}

export function isBridged(): boolean {
    try {
        return new URLSearchParams(location.search).get("ponte") == "1"
            && window.parent !== window
            && window.parent.location.origin == location.origin
    } catch {
        return false
    }
}

function post(message: any, transfer?: Transferable[]) {
    window.parent.postMessage(message, location.origin, transfer)
}

function onMessage(event: MessageEvent) {
    if (event.source !== window.parent || event.origin !== location.origin) return
    const message = event.data
    if (!message || typeof message.type != "string" || typeof message.id != "number") return
    if (message.type.startsWith("lt-ws-")) {
        const socket = sockets.get(message.id)
        if (message.type == "lt-ws-opened") socket?.opened()
        else if (message.type == "lt-ws-message") socket?.received(message.data)
        else if (message.type == "lt-ws-closed") socket?.closed()
        return
    }
    const request = pending.get(message.id)
    if (!request) return

    if (message.type == "lt-fetch-head") {
        request.head(message.status, message.headers ?? [])
    } else if (message.type == "lt-fetch-chunk") {
        request.chunk(new Uint8Array(message.data))
    } else if (message.type == "lt-fetch-end") {
        pending.delete(message.id)
        request.end()
    } else if (message.type == "lt-fetch-error") {
        pending.delete(message.id)
        request.fail(String(message.message ?? "bridge error"))
    }
}

function bridgedFetch(path: string, init: RequestInit | undefined): Promise<Response> {
    const id = nextId++
    const method = (init?.method ?? "GET").toUpperCase()
    const headers: [string, string][] = []
    new Headers(init?.headers).forEach((value, name) => headers.push([name, value]))
    const body = typeof init?.body == "string" ? init.body : null
    const signal = init?.signal

    return new Promise((resolve, reject) => {
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null
        let settled = false

        const abort = () => {
            if (!pending.has(id)) return
            pending.delete(id)
            post({ type: "lt-fetch-abort", id })
            const error = new DOMException("The operation was aborted.", "AbortError")
            if (!settled) { settled = true; reject(error) } else { try { controller?.error(error) } catch { } }
        }
        if (signal) {
            if (signal.aborted) { abort(); return }
            signal.addEventListener("abort", abort, { once: true })
        }

        pending.set(id, {
            head: (status, responseHeaders) => {
                if (settled) return
                settled = true
                const noBody = [101, 204, 205, 304].includes(status)
                const stream = noBody ? null : new ReadableStream<Uint8Array>({ start: (c) => { controller = c } })
                resolve(new Response(stream, { status, headers: responseHeaders }))
            },
            chunk: (data) => { try { controller?.enqueue(data) } catch { } },
            end: () => { try { controller?.close() } catch { } },
            fail: (message) => {
                const error = new TypeError(message)
                if (!settled) { settled = true; reject(error) } else { try { controller?.error(error) } catch { } }
            },
        })
        post({ type: "lt-fetch", id, method, path, headers, body })
    })
}

/// Call once, before the first request. Does nothing unless the page is bridged.
export function installFetchBridge() {
    if (installed || !isBridged()) return
    installed = true

    const apiPath = new URL(buildUrl("/api/")).pathname
    const originalFetch = window.fetch.bind(window)
    listen()

    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input == "string" ? input : input instanceof URL ? input.href : input.url, location.href)
        if (url.origin == location.origin && url.pathname.startsWith(apiPath)) {
            return bridgedFetch(url.pathname + url.search, init)
        }
        return originalFetch(input, init)
    }
}

/// Lightning fork: whether the stream's WebSocket goes through the parent (see the top).
export function bridgesWebSocket(): boolean {
    return isBridged() && new URLSearchParams(location.search).get("ponteWs") == "1"
}

const sockets = new Map<number, PonteWebSocket>()
let nextSocketId = 1

/// A WebSocket whose bytes travel through the parent page. Only what the WebSocket transport
/// uses: send, close, readyState and the open/message/close/error events.
export class PonteWebSocket extends EventTarget {
    readonly id = nextSocketId++
    binaryType: BinaryType = "arraybuffer"
    readyState: number = 0   // CONNECTING

    constructor(path: string) {
        super()
        listen()
        sockets.set(this.id, this)
        post({ type: "lt-ws-open", id: this.id, path })
    }

    send(data: string | ArrayBuffer | ArrayBufferView) {
        if (this.readyState != 1) return
        if (typeof data == "string") {
            post({ type: "lt-ws-send", id: this.id, data })
            return
        }
        const buffer = data instanceof ArrayBuffer
            ? data.slice(0)
            : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength)
        post({ type: "lt-ws-send", id: this.id, data: buffer }, [buffer])
    }

    close() {
        if (this.readyState >= 2) return
        post({ type: "lt-ws-close", id: this.id })
        this.closed()
    }

    opened() {
        if (this.readyState != 0) return
        this.readyState = 1
        this.dispatchEvent(new Event("open"))
    }
    received(data: unknown) {
        if (this.readyState == 1) this.dispatchEvent(new MessageEvent("message", { data }))
    }
    closed() {
        if (this.readyState == 3) return
        const wasConnecting = this.readyState == 0
        this.readyState = 3
        sockets.delete(this.id)
        if (wasConnecting) this.dispatchEvent(new Event("error"))
        this.dispatchEvent(new CloseEvent("close"))
    }
}

/// Tells the parent the user left the stream. Returns false when not bridged.
export function notifyParentExit(): boolean {
    if (!isBridged()) return false
    post({ type: "lt-exit" })
    return true
}
