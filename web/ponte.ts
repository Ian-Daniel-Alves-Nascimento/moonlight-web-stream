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
    window.addEventListener("message", onMessage)

    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input == "string" ? input : input instanceof URL ? input.href : input.url, location.href)
        if (url.origin == location.origin && url.pathname.startsWith(apiPath)) {
            return bridgedFetch(url.pathname + url.search, init)
        }
        return originalFetch(input, init)
    }
}

/// Tells the parent the user left the stream. Returns false when not bridged.
export function notifyParentExit(): boolean {
    if (!isBridged()) return false
    post({ type: "lt-exit" })
    return true
}
