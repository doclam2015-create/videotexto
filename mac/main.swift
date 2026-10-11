import Cocoa
import WebKit
import Network
import UniformTypeIdentifiers

// Glosa para macOS: ventana nativa con WKWebView. La interfaz se sirve desde un pequeño servidor local
// (http://127.0.0.1:47613) para que los reproductores de YouTube funcionen, y habla con el Mac por
// window.webkit.messageHandlers.glosa: yt-dlp (descargas de cualquier sitio, listas, subtítulos),
// inicio de sesión en sitios, guardar archivos, Obsidian e imprimir.

let fm = FileManager.default
let PORT: UInt16 = 47613
let support: URL = {
    let u = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Glosa", isDirectory: true)
    try? fm.createDirectory(at: u.appendingPathComponent("media"), withIntermediateDirectories: true)
    return u
}()
let mediaDir = support.appendingPathComponent("media", isDirectory: true)
let cookieFile = support.appendingPathComponent("cookies.txt")
let binPaths = ["/opt/homebrew/bin", "/usr/local/bin", fm.homeDirectoryForCurrentUser.path + "/.local/bin", "/usr/bin", "/bin"]

// MARK: - servidor HTTP local (con soporte de rangos para reproducir video)

final class LocalServer {
    let res = Bundle.main.resourceURL!.standardizedFileURL
    var listener: NWListener?

    func start() throws {
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true
        let l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: PORT)!)
        l.newConnectionHandler = { [weak self] c in self?.handle(c) }
        l.start(queue: .global())
        listener = l
    }

    func handle(_ c: NWConnection) {
        c.start(queue: .global())
        var buf = Data()
        func read() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, done, err in
                if let d = data { buf.append(d) }
                if let r = buf.range(of: Data("\r\n\r\n".utf8)) {
                    let head = String(data: buf[..<r.lowerBound], encoding: .utf8) ?? ""
                    self.respond(c, head)
                } else if done || err != nil || buf.count > 65536 { c.cancel() } else { read() }
            }
        }
        read()
    }

    func respond(_ c: NWConnection, _ head: String) {
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines.first?.split(separator: " ") ?? []
        guard parts.count >= 2 else { c.cancel(); return }
        var path = String(parts[1]).components(separatedBy: "?")[0].removingPercentEncoding ?? "/"
        if path == "/" { path = "/index.html" }
        let file: URL
        if path.hasPrefix("/media/") { file = mediaDir.appendingPathComponent(String(path.dropFirst(7))).standardizedFileURL }
        else { file = res.appendingPathComponent(String(path.dropFirst())).standardizedFileURL }
        guard (file.path.hasPrefix(res.path) || file.path.hasPrefix(mediaDir.standardizedFileURL.path)),
              let attrs = try? fm.attributesOfItem(atPath: file.path), let size = (attrs[.size] as? NSNumber)?.intValue,
              let fh = try? FileHandle(forReadingFrom: file) else {
            let msg = Data("No encontrado".utf8)
            send(c, "HTTP/1.1 404 Not Found\r\nContent-Length: \(msg.count)\r\nConnection: close\r\n\r\n", msg, nil, 0, 0); return
        }
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        var start = 0, end = size - 1, status = "200 OK", extra = ""
        if let rl = lines.first(where: { $0.lowercased().hasPrefix("range:") }), let eq = rl.firstIndex(of: "=") {
            let spec = rl[rl.index(after: eq)...].trimmingCharacters(in: .whitespaces).components(separatedBy: ",")[0].components(separatedBy: "-")
            if let a = Int(spec[0]) { start = a; if spec.count > 1, let b = Int(spec[1]) { end = min(b, size - 1) } }
            else if spec.count > 1, let n = Int(spec[1]) { start = max(0, size - n) }
            if start > end || start >= size {
                send(c, "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */\(size)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", nil, nil, 0, 0); return
            }
            status = "206 Partial Content"; extra = "Content-Range: bytes \(start)-\(end)/\(size)\r\n"
        }
        let len = end - start + 1
        let header = "HTTP/1.1 \(status)\r\nContent-Type: \(mime)\r\nContent-Length: \(len)\r\nAccept-Ranges: bytes\r\n\(extra)Cache-Control: no-cache\r\nConnection: close\r\n\r\n"
        try? fh.seek(toOffset: UInt64(start))
        send(c, header, nil, fh, len, 0)
    }

    // envía la cabecera y luego el archivo en bloques de 1 MB
    func send(_ c: NWConnection, _ header: String, _ body: Data?, _ fh: FileHandle?, _ total: Int, _ sent: Int) {
        var first = Data(header.utf8)
        if let b = body { first.append(b) }
        c.send(content: first, completion: .contentProcessed { _ in self.pump(c, fh, total, 0) })
    }
    func pump(_ c: NWConnection, _ fh: FileHandle?, _ total: Int, _ sent: Int) {
        guard let fh = fh, sent < total else { try? fh?.close(); c.send(content: nil, isComplete: true, completion: .contentProcessed { _ in c.cancel() }); return }
        let chunk = fh.readData(ofLength: min(1 << 20, total - sent))
        if chunk.isEmpty { try? fh.close(); c.cancel(); return }
        c.send(content: chunk, completion: .contentProcessed { err in
            if err != nil { try? fh.close(); c.cancel(); return }
            self.pump(c, fh, total, sent + chunk.count)
        })
    }
}

// MARK: - procesos (yt-dlp)

struct ProcResult { let out: String; let err: String; let code: Int32 }

func which(_ exe: String) -> String? { binPaths.map { $0 + "/" + exe }.first { fm.isExecutableFile(atPath: $0) } }

func run(_ exe: String, _ args: [String], timeout: TimeInterval = 900, onLine: ((String) -> Void)? = nil) throws -> ProcResult {
    guard let bin = which(exe) else {
        throw NSError(domain: "glosa", code: 1, userInfo: [NSLocalizedDescriptionKey: "Falta «\(exe)». Instálalo con: brew install yt-dlp ffmpeg"])
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: bin)
    p.arguments = args
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = binPaths.joined(separator: ":") + ":" + (env["PATH"] ?? "")
    p.environment = env
    let outP = Pipe(), errP = Pipe()
    p.standardOutput = outP; p.standardError = errP
    var out = Data(), err = Data(), pending = ""
    let lock = NSLock()
    outP.fileHandleForReading.readabilityHandler = { h in
        let d = h.availableData
        lock.lock(); out.append(d); lock.unlock()
        if let cb = onLine, let s = String(data: d, encoding: .utf8) {
            pending += s
            while let r = pending.range(of: "\n") { cb(String(pending[..<r.lowerBound])); pending = String(pending[r.upperBound...]) }
        }
    }
    errP.fileHandleForReading.readabilityHandler = { h in let d = h.availableData; lock.lock(); err.append(d); lock.unlock() }
    try p.run()
    let deadline = Date().addingTimeInterval(timeout)
    while p.isRunning { if Date() > deadline { p.terminate(); break }; Thread.sleep(forTimeInterval: 0.1) }
    p.waitUntilExit()
    outP.fileHandleForReading.readabilityHandler = nil; errP.fileHandleForReading.readabilityHandler = nil
    out.append(outP.fileHandleForReading.readDataToEndOfFile()); err.append(errP.fileHandleForReading.readDataToEndOfFile())
    return ProcResult(out: String(data: out, encoding: .utf8) ?? "", err: String(data: err, encoding: .utf8) ?? "", code: p.terminationStatus)
}

func authArgs(_ b: [String: Any]) -> [String] {
    var a: [String] = []
    if fm.fileExists(atPath: cookieFile.path) { a += ["--cookies", cookieFile.path] }
    if let u = b["user"] as? String, let p = b["pass"] as? String, !u.isEmpty { a += ["--username", u, "--password", p] }
    return a
}
func needsLogin(_ e: String) -> Bool {
    let l = e.lowercased()
    return ["login", "log in", "sign in", "authenticat", "cookies", "private video", "members-only", "members only", "subscriber", "premium", "http error 401", "http error 403", "account", "registered users"].contains { l.contains($0) }
}
func cleanErr(_ e: String) -> String {
    let lines = e.components(separatedBy: "\n").filter { $0.contains("ERROR") }
    return String((lines.last ?? e).replacingOccurrences(of: "ERROR: ", with: "").suffix(300))
}
func trimMeta(_ m: [String: Any]) -> [String: Any] {
    var o: [String: Any] = [:]
    for k in ["id", "title", "uploader", "channel", "description", "upload_date", "view_count", "duration", "chapters", "tags", "thumbnail", "extractor", "webpage_url"] { if let v = m[k], !(v is NSNull) { o[k] = v } }
    return o
}
func jsonObj(_ s: String) -> [String: Any]? {
    let line = s.components(separatedBy: "\n").last { $0.hasPrefix("{") } ?? s
    return (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
}
func httpGet(_ s: String) -> Data? {
    guard let u = URL(string: s) else { return nil }
    let sem = DispatchSemaphore(value: 0); var out: Data?
    URLSession.shared.dataTask(with: u) { d, _, _ in out = d; sem.signal() }.resume()
    _ = sem.wait(timeout: .now() + 30); return out
}

// MARK: - aplicación

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    let server = LocalServer()
    var pageReady = false, pendingURL: String?
    var loginWin: NSWindow?, loginReply: ((Any?, String?) -> Void)?
    var printView: WKWebView?

    func applicationWillFinishLaunching(_ n: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURL(_:_:)), forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do { try server.start() } catch { NSLog("Servidor: \(error)") }
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "glosa")
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.allowsAirPlayForMediaPlayback = true
        cfg.preferences.isElementFullscreenEnabled = true
        cfg.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        if #available(macOS 13.3, *) { web.isInspectable = true }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1380, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Glosa"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 420, height: 560)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("GlosaMain")
        window.makeKeyAndOrderFront(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            self.web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(PORT)/index.html")!))
        }
        buildMenu()
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // glosa://open?u=… (marcador del navegador o Atajos)
    @objc func handleURL(_ event: NSAppleEventDescriptor, _ reply: NSAppleEventDescriptor) {
        guard let s = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue, let c = URLComponents(string: s) else { return }
        let u = c.queryItems?.first(where: { $0.name == "u" || $0.name == "url" })?.value ?? String(s.dropFirst("glosa://".count))
        if pageReady { openLink(u) } else { pendingURL = u }
    }
    func openLink(_ u: String) {
        window?.makeKeyAndOrderFront(nil)
        if let j = try? JSONSerialization.data(withJSONObject: [u], options: .fragmentsAllowed), let s = String(data: j, encoding: .utf8) {
            web.evaluateJavaScript("App.nativeOpen(\(s)[0])", completionHandler: nil)
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === printView { return }
        pageReady = true
        if let u = pendingURL { pendingURL = nil; DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.openLink(u) } }
    }
    func evt(_ obj: [String: Any]) {
        guard let j = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: j, encoding: .utf8) else { return }
        DispatchQueue.main.async { self.web.evaluateJavaScript("window.__glosaEvt && __glosaEvt(\(s))", completionHandler: nil) }
    }

    // MARK: puente JS
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let b = message.body as? [String: Any], let op = b["op"] as? String else { replyHandler(nil, "mensaje inválido"); return }
        let reply: (Any?) -> Void = { v in DispatchQueue.main.async { replyHandler(v, nil) } }
        let fail: (String) -> Void = { m in DispatchQueue.main.async { replyHandler(nil, m) } }
        switch op {
        case "paste":
            replyHandler(NSPasteboard.general.string(forType: .string) ?? "", nil)

        case "ytinfo":
            let id = b["id"] as? String ?? "", wantSubs = b["subs"] as? Bool ?? false
            DispatchQueue.global().async {
                guard let r = try? run("yt-dlp", ["-J", "--skip-download", "--no-warnings", "--no-playlist"] + authArgs(b) + ["https://www.youtube.com/watch?v=\(id)"], timeout: 90),
                      let m = jsonObj(r.out) else { reply(["meta": NSNull()]); return }
                var out: [String: Any] = ["meta": trimMeta(m)]
                if wantSubs, let (segs, lang) = AppDelegate.subtitles(m) { out["subs"] = segs; out["subsLang"] = lang }
                reply(out)
            }

        case "list":
            let url = b["url"] as? String ?? ""
            DispatchQueue.global().async {
                do {
                    let r = try run("yt-dlp", ["-J", "--flat-playlist", "--playlist-end", "200", "--no-warnings"] + authArgs(b) + [url], timeout: 120)
                    guard let m = jsonObj(r.out) else {
                        if needsLogin(r.err) { reply(["auth": true, "error": cleanErr(r.err)]); return }
                        fail(cleanErr(r.err)); return
                    }
                    if (m["_type"] as? String) == "playlist", let entries = (m["entries"] as? [Any])?.compactMap({ $0 as? [String: Any] }), entries.count > 1 {
                        let list: [[String: Any]] = entries.compactMap { e in
                            var u = (e["url"] as? String) ?? (e["webpage_url"] as? String) ?? ""
                            if !u.hasPrefix("http"), let id = e["id"] as? String, (e["ie_key"] as? String ?? "").lowercased().contains("youtube") { u = "https://www.youtube.com/watch?v=\(id)" }
                            guard u.hasPrefix("http") else { return nil }
                            let thumbs = e["thumbnails"] as? [[String: Any]]
                            return ["url": u, "title": e["title"] as? String ?? "", "duration": e["duration"] as? Double ?? 0,
                                    "thumb": (thumbs?.last?["url"] as? String) ?? (e["thumbnail"] as? String) ?? ""]
                        }
                        reply(["entries": list, "title": m["title"] as? String ?? ""])
                    } else { reply(["single": true]) }
                } catch { fail(error.localizedDescription) }
            }

        case "grab":
            let url = b["url"] as? String ?? "", id = (b["id"] as? String ?? UUID().uuidString).replacingOccurrences(of: "/", with: "-")
            DispatchQueue.global().async {
                do {
                    let info = try run("yt-dlp", ["-J", "--no-playlist", "--no-warnings"] + authArgs(b) + [url], timeout: 120)
                    guard let m = jsonObj(info.out) else {
                        fail(needsLogin(info.err) ? "El sitio pide iniciar sesión: " + cleanErr(info.err) : cleanErr(info.err)); return
                    }
                    if (m["extractor"] as? String ?? "").lowercased().hasPrefix("youtube") { reply(["meta": trimMeta(m)]); return }
                    for f in (try? fm.contentsOfDirectory(atPath: mediaDir.path)) ?? [] where f.hasPrefix(id + ".") { try? fm.removeItem(at: mediaDir.appendingPathComponent(f)) }
                    var path = ""
                    let r = try run("yt-dlp", ["--no-playlist", "--no-warnings", "--newline", "-f", "b[height<=480]/bv*[height<=480]+ba/b/bv*+ba/ba",
                                               "-S", "res:480,ext:mp4:m4a", "--merge-output-format", "mp4",
                                               "--progress-template", "download:GLOSA %(progress._percent_str)s",
                                               "--print", "after_move:filepath", "-o", mediaDir.path + "/\(id).%(ext)s"] + authArgs(b) + [url], timeout: 3600) { line in
                        if line.hasPrefix("GLOSA") { let p = Double(line.dropFirst(6).trimmingCharacters(in: CharacterSet(charactersIn: " %"))) ?? 0; self.evt(["type": "dl", "id": id, "pct": p]) }
                        else if line.hasPrefix("/") { path = line }
                    }
                    if path.isEmpty || !fm.fileExists(atPath: path) { fail(cleanErr(r.err)); return }
                    reply(["meta": trimMeta(m), "media": "/media/" + (URL(fileURLWithPath: path).lastPathComponent.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "")])
                } catch { fail(error.localizedDescription) }
            }

        case "login":
            openLogin(b["url"] as? String ?? "", replyHandler)

        case "save":
            let text = b["text"] as? String ?? ""
            let p = NSSavePanel(); p.nameFieldStringValue = b["name"] as? String ?? "glosa.txt"; p.canCreateDirectories = true
            p.beginSheetModal(for: window) { r in
                guard r == .OK, let d = p.url else { replyHandler(false, nil); return }
                do { try text.write(to: d, atomically: true, encoding: .utf8); replyHandler(true, nil); NSWorkspace.shared.activateFileViewerSelecting([d]) }
                catch { replyHandler(nil, error.localizedDescription) }
            }

        case "obsidian":
            let vault = b["vault"] as? String ?? "obsidian vault", folder = b["folder"] as? String ?? "", name = b["name"] as? String ?? "video", text = b["text"] as? String ?? ""
            let home = fm.homeDirectoryForCurrentUser
            let candidates = [home.appendingPathComponent("Desktop/\(vault)"), home.appendingPathComponent("Documents/\(vault)"), home.appendingPathComponent(vault),
                              home.appendingPathComponent("Library/Mobile Documents/iCloud~md~obsidian/Documents/\(vault)")]
            guard let root = candidates.first(where: { fm.fileExists(atPath: $0.appendingPathComponent(".obsidian").path) }) ?? candidates.first(where: { fm.fileExists(atPath: $0.path) }) else {
                fail("No encontré la bóveda «\(vault)». Revisa el nombre en Ajustes."); return
            }
            let dir = folder.isEmpty ? root : root.appendingPathComponent(folder, isDirectory: true)
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
            var f = dir.appendingPathComponent(name + ".md"), n = 2
            while fm.fileExists(atPath: f.path) { f = dir.appendingPathComponent("\(name)-\(n).md"); n += 1 }
            do {
                try text.write(to: f, atomically: true, encoding: .utf8)
                replyHandler((folder.isEmpty ? "" : folder + "/") + f.lastPathComponent, nil)
                let rel = f.path.replacingOccurrences(of: root.path + "/", with: "")
                if let u = URL(string: "obsidian://open?vault=\(vault.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")&file=\(rel.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")") { NSWorkspace.shared.open(u) }
            } catch { fail(error.localizedDescription) }

        case "print":
            let html = b["html"] as? String ?? ""
            let pv = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 1100))
            pv.navigationDelegate = self
            printView = pv
            pv.loadHTMLString(html, baseURL: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                let info = NSPrintInfo.shared.copy() as! NSPrintInfo
                info.horizontalPagination = .fit; info.verticalPagination = .automatic
                info.topMargin = 36; info.bottomMargin = 36; info.leftMargin = 36; info.rightMargin = 36
                let op = pv.printOperation(with: info)
                op.view?.frame = pv.bounds
                op.runModal(for: self.window, delegate: nil, didRun: nil, contextInfo: nil)
                replyHandler(true, nil)
            }

        default:
            replyHandler(nil, "Operación desconocida: \(op)")
        }
    }

    // Subtítulos de YouTube (manuales primero; automáticos en el idioma original si no hay)
    static func subtitles(_ m: [String: Any]) -> ([[String: Any]], String)? {
        let lang = (m["language"] as? String) ?? ""
        func pick(_ dict: [String: Any]?, _ prefer: [String]) -> (String, String)? {
            guard let d = dict as? [String: [[String: Any]]] else { return nil }
            for p in prefer { if let (k, v) = d.first(where: { $0.key == p || $0.key.hasPrefix(p + "-") }), let u = v.first(where: { ($0["ext"] as? String) == "json3" })?["url"] as? String { return (k, u) } }
            return nil
        }
        let prefs = [lang, "es", "en"].filter { !$0.isEmpty }
        guard let (code, url) = pick(m["subtitles"] as? [String: Any], prefs) ?? pick(m["automatic_captions"] as? [String: Any], prefs.map { $0 + "-orig" } + prefs),
              let d = httpGet(url), let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let events = j["events"] as? [[String: Any]] else { return nil }
        var segs: [[String: Any]] = []
        for e in events {
            let text = (e["segs"] as? [[String: Any]] ?? []).compactMap { $0["utf8"] as? String }.joined().replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
            if text.isEmpty { continue }
            segs.append(["t": Double(e["tStartMs"] as? Int ?? 0) / 1000, "s": "", "x": text])
        }
        return segs.isEmpty ? nil : (segs, code)
    }

    // MARK: inicio de sesión en un sitio (las cookies se exportan para yt-dlp)
    func openLogin(_ url: String, _ reply: @escaping (Any?, String?) -> Void) {
        guard let u = URL(string: url) else { reply(nil, "Enlace inválido"); return }
        loginReply?(false, nil)
        loginReply = reply
        let cfg = WKWebViewConfiguration(); cfg.websiteDataStore = .default()
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
        wv.load(URLRequest(url: u))
        let bar = NSStackView()
        bar.orientation = .horizontal; bar.edgeInsets = NSEdgeInsets(top: 8, left: 14, bottom: 8, right: 14); bar.spacing = 10
        let label = NSTextField(labelWithString: "Inicia sesión con tu cuenta y luego toca «Listo, continuar».")
        label.textColor = .secondaryLabelColor
        let cancel = NSButton(title: "Cancelar", target: self, action: #selector(loginCancel))
        let ok = NSButton(title: "Listo, continuar", target: self, action: #selector(loginDone)); ok.bezelColor = .controlAccentColor; ok.keyEquivalent = "\r"
        bar.addArrangedSubview(label); bar.addArrangedSubview(NSView()); bar.addArrangedSubview(cancel); bar.addArrangedSubview(ok)
        let stack = NSStackView(views: [bar, wv]); stack.orientation = .vertical; stack.spacing = 0
        bar.setHuggingPriority(.required, for: .vertical)
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 760), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        w.title = "Iniciar sesión — \(u.host ?? "")"
        w.contentView = stack
        w.isReleasedWhenClosed = false
        w.center(); w.makeKeyAndOrderFront(nil)
        loginWin = w
    }
    @objc func loginCancel() { loginWin?.close(); loginWin = nil; loginReply?(false, nil); loginReply = nil }
    @objc func loginDone() {
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
            var lines = ["# Netscape HTTP Cookie File"]
            for c in cookies {
                let dom = c.domain, sub = dom.hasPrefix(".") ? "TRUE" : "FALSE"
                lines.append([dom, sub, c.path, c.isSecure ? "TRUE" : "FALSE", String(Int(c.expiresDate?.timeIntervalSince1970 ?? 0)), c.name, c.value].joined(separator: "\t"))
            }
            try? (lines.joined(separator: "\n") + "\n").write(to: cookieFile, atomically: true, encoding: .utf8)
            try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: cookieFile.path)
            self.loginWin?.close(); self.loginWin = nil
            self.loginReply?(true, nil); self.loginReply = nil
        }
    }

    // enlaces externos al navegador; los iframes de YouTube se permiten
    func webView(_ webView: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard webView === web, let url = a.request.url else { decisionHandler(.allow); return }
        let isMain = a.targetFrame?.isMainFrame ?? true
        if isMain && url.host != "127.0.0.1" && !["about", "blob", "data", "javascript"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = a.request.url, url.scheme != "blob", url.absoluteString != "about:blank" { NSWorkspace.shared.open(url) }
        return nil
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.runModal(); completionHandler()
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "Aceptar"); a.addButton(withTitle: "Cancelar"); completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt
        let f = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24)); f.stringValue = defaultText ?? ""; a.accessoryView = f
        a.addButton(withTitle: "Aceptar"); a.addButton(withTitle: "Cancelar")
        completionHandler(a.runModal() == .alertFirstButtonReturn ? f.stringValue : nil)
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel(); p.allowsMultipleSelection = parameters.allowsMultipleSelection; p.canChooseDirectories = false
        p.beginSheetModal(for: window) { r in completionHandler(r == .OK ? p.urls : nil) }
    }

    // MARK: menú
    @objc func runJS(_ s: NSMenuItem) { web.evaluateJavaScript(s.representedObject as? String ?? "", completionHandler: nil) }
    func item(_ t: String, _ js: String, _ k: String, _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let i = NSMenuItem(title: t, action: #selector(runJS(_:)), keyEquivalent: k); i.target = self; i.representedObject = js; i.keyEquivalentModifierMask = mods; return i
    }
    func buildMenu() {
        let bar = NSMenu()
        let appItem = NSMenuItem(); bar.addItem(appItem)
        let am = NSMenu()
        am.addItem(withTitle: "Acerca de Glosa", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        am.addItem(.separator())
        am.addItem(item("Ajustes…", "App.settings()", ","))
        am.addItem(.separator())
        am.addItem(withTitle: "Ocultar Glosa", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        am.addItem(withTitle: "Salir de Glosa", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = am

        let fItem = NSMenuItem(); bar.addItem(fItem)
        let f = NSMenu(title: "Archivo")
        f.addItem(item("Nuevo enlace", "location.hash='';setTimeout(()=>document.getElementById('omni')?.focus(),60)", "n"))
        f.addItem(item("Analizar enlace copiado", "bridge('paste').then(t=>t&&startInput(t))", "v", [.command, .shift]))
        f.addItem(item("Subir video o audio…", "App.pickFile()", "o"))
        f.addItem(.separator())
        f.addItem(item("Exportar…", "View.v&&Exporter.menu(document.querySelector('[aria-label=Exportar]'),View.v)", "e"))
        f.addItem(item("Enviar a Obsidian", "View.v&&Exporter.obsidian(View.v)", "o", [.command, .shift]))
        f.addItem(item("Imprimir…", "View.v&&Exporter.print(View.v)", "p"))
        f.addItem(.separator())
        let ms = NSMenuItem(title: "Mostrar videos descargados", action: #selector(openMedia), keyEquivalent: ""); ms.target = self; f.addItem(ms)
        let cs = NSMenuItem(title: "Cerrar sesiones de sitios", action: #selector(clearCookies), keyEquivalent: ""); cs.target = self; f.addItem(cs)
        fItem.submenu = f

        let eItem = NSMenuItem(); bar.addItem(eItem)
        let e = NSMenu(title: "Edición")
        e.addItem(withTitle: "Deshacer", action: Selector(("undo:")), keyEquivalent: "z")
        e.addItem(withTitle: "Rehacer", action: Selector(("redo:")), keyEquivalent: "Z")
        e.addItem(.separator())
        e.addItem(withTitle: "Cortar", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        e.addItem(withTitle: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        e.addItem(withTitle: "Pegar", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        e.addItem(withTitle: "Seleccionar todo", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        e.addItem(.separator())
        e.addItem(item("Buscar en la transcripción", "View.v?(View.tab='tr',View.renderTabs(),View.renderTab(),document.getElementById('trq')?.focus()):document.querySelector('.lib input')?.focus()", "f"))
        eItem.submenu = e

        let vItem = NSMenuItem(); bar.addItem(vItem)
        let v = NSMenu(title: "Ver")
        v.addItem(item("Biblioteca", "location.hash=''", "1", [.command, .shift]))
        v.addItem(item("Texto más grande", "View.font(1)", "+"))
        v.addItem(item("Texto más pequeño", "View.font(-1)", "-"))
        v.addItem(.separator())
        v.addItem(withTitle: "Pantalla completa", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
        vItem.submenu = v

        let wItem = NSMenuItem(); bar.addItem(wItem)
        let w = NSMenu(title: "Ventana")
        w.addItem(withTitle: "Minimizar", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        w.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        wItem.submenu = w
        NSApp.windowsMenu = w

        let hItem = NSMenuItem(); bar.addItem(hItem)
        let hm = NSMenu(title: "Ayuda")
        hm.addItem(item("Ayuda de Glosa", "App.help()", "?"))
        hItem.submenu = hm
        NSApp.helpMenu = hm
        NSApp.mainMenu = bar
    }
    @objc func openMedia() { NSWorkspace.shared.open(mediaDir) }
    @objc func clearCookies() {
        try? fm.removeItem(at: cookieFile)
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cs in
            for c in cs where c.domain != "127.0.0.1" { WKWebsiteDataStore.default().httpCookieStore.delete(c) }
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
