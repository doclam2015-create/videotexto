import UIKit
import WebKit
import Network
import AVFoundation
import UniformTypeIdentifiers
import Speech

// Glosa para iPhone/iPad: la misma interfaz web dentro de un WKWebView, servida desde un pequeño servidor local
// (http://127.0.0.1:47623, como en el Mac, para que el reproductor de YouTube funcione). Habla con iOS por
// window.webkit.messageHandlers.glosa: subtítulos y datos de YouTube sin cuota, dictado de Apple en el equipo,
// guardar en Archivos, imprimir y pegar.

let fm = FileManager.default
let PORT: UInt16 = 47623
let mediaDir = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("media", isDirectory: true)

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

func httpGet(_ s: String) -> Data? {
    guard let u = URL(string: s) else { return nil }
    var r = URLRequest(url: u, timeoutInterval: 20)
    r.setValue("es-CL,es;q=0.9,en;q=0.5", forHTTPHeaderField: "Accept-Language")
    r.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", forHTTPHeaderField: "User-Agent")
    let sem = DispatchSemaphore(value: 0); var out: Data?
    URLSession.shared.dataTask(with: r) { d, _, _ in out = d; sem.signal() }.resume()
    _ = sem.wait(timeout: .now() + 25); return out
}

// Datos y subtítulos de YouTube por la API interna con el cliente de iOS (no exige token; sin yt-dlp ni cuota de Gemini)
func youtubePlayer(_ id: String) -> [String: Any]? {
    guard let u = URL(string: "https://www.youtube.com/youtubei/v1/player?prettyPrint=false") else { return nil }
    var r = URLRequest(url: u, timeoutInterval: 20)
    r.httpMethod = "POST"
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.setValue("com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X;)", forHTTPHeaderField: "User-Agent")
    r.httpBody = try? JSONSerialization.data(withJSONObject: ["videoId": id, "context": ["client": ["clientName": "IOS", "clientVersion": "20.10.4", "deviceModel": "iPhone16,2", "hl": "es"]]])
    let sem = DispatchSemaphore(value: 0); var out: Data?
    URLSession.shared.dataTask(with: r) { d, _, _ in out = d; sem.signal() }.resume()
    _ = sem.wait(timeout: .now() + 25)
    return out.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
}

func youtubeInfo(_ id: String, subs wantSubs: Bool) -> [String: Any] {
    guard let j = youtubePlayer(id) else { return ["meta": NSNull()] }
    var out: [String: Any] = ["meta": NSNull()]
    if let v = j["videoDetails"] as? [String: Any] {
        out["meta"] = ["title": v["title"] ?? "", "uploader": v["author"] ?? "", "description": v["shortDescription"] ?? "",
                       "duration": Double(v["lengthSeconds"] as? String ?? "") ?? 0, "view_count": Int(v["viewCount"] as? String ?? "") ?? 0,
                       "tags": v["keywords"] ?? []]
    }
    if wantSubs, let tracks = ((j["captions"] as? [String: Any])?["playerCaptionsTracklistRenderer"] as? [String: Any])?["captionTracks"] as? [[String: Any]], !tracks.isEmpty {
        let manual = tracks.filter { ($0["kind"] as? String) != "asr" }
        let pick = manual.first { ($0["languageCode"] as? String ?? "").hasPrefix("es") } ?? tracks.first { ($0["languageCode"] as? String ?? "").hasPrefix("es") } ?? manual.first ?? tracks[0]
        if let base = pick["baseUrl"] as? String, let cd = httpGet(base + "&fmt=json3"),
           let cj = try? JSONSerialization.jsonObject(with: cd) as? [String: Any], let events = cj["events"] as? [[String: Any]] {
            var segs: [[String: Any]] = []
            for e in events {
                let text = (e["segs"] as? [[String: Any]] ?? []).compactMap { $0["utf8"] as? String }.joined().replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
                if text.isEmpty { continue }
                segs.append(["t": Double(e["tStartMs"] as? Int ?? 0) / 1000, "s": "", "x": text])
            }
            if !segs.isEmpty { out["subs"] = segs; out["subsLang"] = pick["languageCode"] as? String ?? "" }
        }
    }
    return out
}

final class SpeechCollector: NSObject, SFSpeechRecognitionTaskDelegate {
    var words: [SFTranscriptionSegment] = []
    let done = DispatchSemaphore(value: 0)
    func speechRecognitionTask(_ task: SFSpeechRecognitionTask, didFinishRecognition r: SFSpeechRecognitionResult) {
        let segs = r.bestTranscription.segments
        // evita duplicar si el reconocedor entrega el texto acumulado
        if let f = segs.first, let l = words.last, f.timestamp <= l.timestamp { words.removeAll { $0.timestamp >= f.timestamp } }
        words += segs
    }
    func speechRecognitionTask(_ task: SFSpeechRecognitionTask, didFinishSuccessfully ok: Bool) { done.signal() }
}

// Dictado de Apple en el equipo: corta el audio en tramos de 55 s y reconoce cada uno
func speechTranscribe(_ file: URL, lang: String, progress: @escaping (Double) -> Void) throws -> [[String: Any]] {
    func err(_ m: String) -> NSError { NSError(domain: "glosa", code: 1, userInfo: [NSLocalizedDescriptionKey: m]) }
    let sem0 = DispatchSemaphore(value: 0); var status = SFSpeechRecognizerAuthorizationStatus.notDetermined
    SFSpeechRecognizer.requestAuthorization { st in status = st; sem0.signal() }
    sem0.wait()
    guard status == .authorized else { throw err("Permite el Reconocimiento de voz para Glosa en Ajustes › Privacidad y seguridad.") }
    let locales = (lang.hasPrefix("en") ? ["en-US", "en-GB"] : lang.hasPrefix("pt") ? ["pt-BR", "pt-PT"] : lang.hasPrefix("fr") ? ["fr-FR"] : lang.hasPrefix("de") ? ["de-DE"] : lang.hasPrefix("it") ? ["it-IT"] : ["es-CL", "es-ES", "es-MX", "es-US"])
    guard let rec = locales.compactMap({ SFSpeechRecognizer(locale: Locale(identifier: $0)) }).first(where: { $0.isAvailable }) else {
        throw err("El reconocimiento de voz para «\(lang)» no está disponible en este equipo.")
    }
    let asset = AVURLAsset(url: file)
    let total = CMTimeGetSeconds(asset.duration)
    guard total.isFinite, total > 0 else { throw err("No se pudo leer el audio del archivo.") }
    let dir = fm.temporaryDirectory.appendingPathComponent("glosa-tr-\(UUID().uuidString)", isDirectory: true)
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: dir) }
    let n = Int(ceil(total / 55))
    var out: [[String: Any]] = []
    for i in 0..<n {
        let base = Double(i) * 55
        guard let ex = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else { throw err("No se pudo preparar el audio.") }
        let part = dir.appendingPathComponent("p\(i).m4a")
        ex.outputURL = part; ex.outputFileType = .m4a
        ex.timeRange = CMTimeRange(start: CMTime(seconds: base, preferredTimescale: 600), duration: CMTime(seconds: min(55, total - base), preferredTimescale: 600))
        let s = DispatchSemaphore(value: 0)
        ex.exportAsynchronously { s.signal() }
        s.wait()
        guard ex.status == .completed else { throw err("No se pudo preparar el audio: " + (ex.error?.localizedDescription ?? "")) }
        // primero en el equipo; si el modelo local no está, con el servicio de Apple
        func recognize(_ onDevice: Bool) -> SpeechCollector {
            let req = SFSpeechURLRecognitionRequest(url: part)
            req.requiresOnDeviceRecognition = onDevice
            req.addsPunctuation = true
            req.shouldReportPartialResults = false
            let del = SpeechCollector()
            let task = rec.recognitionTask(with: req, delegate: del)
            if del.done.wait(timeout: .now() + 240) == .timedOut { task.cancel() }
            return del
        }
        var del = recognize(rec.supportsOnDeviceRecognition)
        if del.words.isEmpty && rec.supportsOnDeviceRecognition { del = recognize(false) }
        var cur = "", start = -1.0, last = 0.0, k = 0
        func flush() { let t = cur.trimmingCharacters(in: .whitespaces); if !t.isEmpty { out.append(["t": base + max(0, start), "s": "", "x": t]) }; cur = ""; start = -1; k = 0 }
        for w in del.words {
            if start >= 0 && w.timestamp - last > 1.2 { flush() }
            if start < 0 { start = w.timestamp }
            cur += (cur.isEmpty ? "" : " ") + w.substring; k += 1
            last = w.timestamp + w.duration
            if let c = w.substring.last, ".?!".contains(c), k > 4 { flush() } else if k >= 28 { flush() }
        }
        flush()
        progress(100 * Double(i + 1) / Double(n))
    }
    return out
}

// Selector de documentos con cierre (se retiene hasta que el usuario elige o cancela)
final class Picker: NSObject, UIDocumentPickerDelegate {
    static var live: [Picker] = []
    let done: ([URL]) -> Void
    init(_ done: @escaping ([URL]) -> Void) { self.done = done }
    func documentPicker(_ c: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { done(urls); Picker.live.removeAll { $0 === self } }
    func documentPickerWasCancelled(_ c: UIDocumentPickerViewController) { done([]); Picker.live.removeAll { $0 === self } }
}

let server = LocalServer()

final class AppDelegate: UIResponder, UIApplicationDelegate {}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    let vc = WebVC()
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        let w = UIWindow(windowScene: ws)
        w.rootViewController = vc
        w.makeKeyAndVisible()
        window = w
        if let u = options.urlContexts.first?.url { vc.openLink(u) }
    }
    func scene(_ scene: UIScene, openURLContexts c: Set<UIOpenURLContext>) { if let u = c.first?.url { vc.openLink(u) } }
    // iOS cierra el servidor al pasar a segundo plano: se vuelve a abrir al volver
    func sceneWillEnterForeground(_ scene: UIScene) {
        if let l = server.listener, case .ready = l.state { return }
        server.listener?.cancel()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { try? server.start() }
    }
}

final class WebVC: UIViewController, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    var web: WKWebView!
    var pageReady = false, pendingURL: String?

    override func loadView() {
        try? fm.createDirectory(at: mediaDir, withIntermediateDirectories: true)
        try? server.start()
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "glosa")
        cfg.userContentController.addUserScript(WKUserScript(source: "window.GLOSA_IOS=true", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = .systemBackground
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.isInspectable = true
        view = web
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            self.web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(PORT)/index.html")!))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView !== web { return }
        pageReady = true
        // prueba automática en el simulador: GLOSA_EVAL=archivo.js ejecuta ese código e imprime el resultado
        if let f = ProcessInfo.processInfo.environment["GLOSA_EVAL"], let code = try? String(contentsOfFile: f, encoding: .utf8) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                self.web.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { r in
                    switch r { case .success(let v): print("EVAL", v); case .failure(let e): print("EVAL ERROR", e) }
                    fflush(stdout)
                }
            }
        }
        if let u = pendingURL { pendingURL = nil; DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.send(u) } }
    }
    // glosa://open?u=… (Atajos, marcador del navegador)
    func openLink(_ url: URL) {
        let s = url.absoluteString
        let u = URLComponents(string: s)?.queryItems?.first(where: { $0.name == "u" || $0.name == "url" })?.value ?? String(s.dropFirst("glosa://".count))
        if pageReady { send(u) } else { pendingURL = u }
    }
    func send(_ u: String) {
        if let j = try? JSONSerialization.data(withJSONObject: [u]), let s = String(data: j, encoding: .utf8) {
            web.evaluateJavaScript("App.nativeOpen(\(s)[0])", completionHandler: nil)
        }
    }
    func evt(_ obj: [String: Any]) {
        guard let j = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: j, encoding: .utf8) else { return }
        DispatchQueue.main.async { self.web.evaluateJavaScript("window.__glosaEvt && __glosaEvt(\(s))", completionHandler: nil) }
    }

    func present(_ c: UIViewController) {
        if let p = c.popoverPresentationController {
            p.sourceView = web
            p.sourceRect = CGRect(x: web.bounds.midX, y: web.bounds.midY, width: 1, height: 1)
            p.permittedArrowDirections = []
        }
        var top: UIViewController = self
        while let p = top.presentedViewController { top = p }
        top.present(c, animated: true)
    }

    // MARK: puente JS
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let b = message.body as? [String: Any], let op = b["op"] as? String else { replyHandler(nil, "mensaje inválido"); return }
        let reply: (Any?) -> Void = { v in DispatchQueue.main.async { replyHandler(v, nil) } }
        let fail: (String) -> Void = { m in DispatchQueue.main.async { replyHandler(nil, m) } }
        switch op {
        case "paste":
            replyHandler(UIPasteboard.general.string ?? "", nil)

        case "ytinfo":
            let id = b["id"] as? String ?? "", wantSubs = b["subs"] as? Bool ?? false
            DispatchQueue.global().async { reply(youtubeInfo(id, subs: wantSubs)) }

        case "localtranscribe":
            guard let s = b["data"] as? String, let data = Data(base64Encoded: s) else { fail("En iPhone/iPad el dictado funciona con archivos subidos."); return }
            let id = b["id"] as? String ?? "", lang = b["lang"] as? String ?? "es"
            let ext = (b["ext"] as? String ?? "m4a").replacingOccurrences(of: "mpeg", with: "mp3").replacingOccurrences(of: "quicktime", with: "mov").replacingOccurrences(of: "x-m4a", with: "m4a")
            let f = fm.temporaryDirectory.appendingPathComponent("glosa-\(UUID().uuidString).\(ext)")
            DispatchQueue.global(qos: .userInitiated).async {
                defer { try? fm.removeItem(at: f) }
                do {
                    try data.write(to: f)
                    let segs = try speechTranscribe(f, lang: lang) { p in self.evt(["type": "tr", "id": id, "pct": p]) }
                    if segs.isEmpty { fail("El dictado de Apple no reconoció voz en el audio."); return }
                    reply(segs)
                } catch { fail(error.localizedDescription) }
            }

        case "save":
            let text = b["text"] as? String ?? ""
            let tmp = fm.temporaryDirectory.appendingPathComponent((b["name"] as? String ?? "glosa.txt").replacingOccurrences(of: "/", with: "-"))
            do { try text.write(to: tmp, atomically: true, encoding: .utf8) } catch { fail(error.localizedDescription); return }
            let c = UIDocumentPickerViewController(forExporting: [tmp], asCopy: true)
            let p = Picker { urls in try? fm.removeItem(at: tmp); replyHandler(!urls.isEmpty, nil) }
            Picker.live.append(p); c.delegate = p
            present(c)

        case "print":
            let p = UIPrintInteractionController.shared
            p.printFormatter = UIMarkupTextPrintFormatter(markupText: b["html"] as? String ?? "")
            p.present(animated: true)
            replyHandler(true, nil)

        default:
            fail("Esta función solo está en Glosa para Mac.")
        }
    }

    // enlaces externos en Safari; YouTube incrustado se permite; micrófono
    func webView(_ webView: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = a.request.url, let sc = url.scheme, !["about", "blob", "data"].contains(sc), url.host != "127.0.0.1" {
            if let f = a.targetFrame, !f.isMainFrame { decisionHandler(.allow); return }
            UIApplication.shared.open(url); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = a.request.url, url.scheme != "blob" { UIApplication.shared.open(url) }
        return nil
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: m, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a)
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
