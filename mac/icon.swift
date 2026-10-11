import AppKit

// Genera el ícono de Glosa: un botón de reproducción del que salen líneas de texto (video → transcripción),
// sobre un degradado coral → violeta.
func render(size: CGFloat, mac: Bool) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    let s = size / 1024
    func C(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor { NSColor(srgbRed: r/255, green: g/255, blue: b/255, alpha: a) }
    let bgRect = mac ? NSRect(x: 100*s, y: 100*s, width: 824*s, height: 824*s) : NSRect(x: 0, y: 0, width: size, height: size)
    let bg = mac ? NSBezierPath(roundedRect: bgRect, xRadius: 185*s, yRadius: 185*s) : NSBezierPath(rect: bgRect)
    if mac {
        NSGraphicsContext.saveGraphicsState()
        let sh = NSShadow(); sh.shadowColor = NSColor.black.withAlphaComponent(0.32); sh.shadowOffset = NSSize(width: 0, height: -12*s); sh.shadowBlurRadius = 28*s; sh.set()
        NSColor.black.setFill(); bg.fill()
        NSGraphicsContext.restoreGraphicsState()
    }
    NSGradient(colors: [C(255, 122, 89), C(255, 92, 138), C(139, 123, 255), C(92, 72, 230)], atLocations: [0, 0.35, 0.75, 1], colorSpace: .sRGB)!.draw(in: bg, angle: -50)
    NSGradient(colors: [NSColor.white.withAlphaComponent(0.22), NSColor.white.withAlphaComponent(0)])!.draw(in: bg, angle: -90)

    let k: CGFloat = mac ? 0.805 : 1.0
    ctx.saveGState()
    ctx.translateBy(x: size/2, y: size/2)
    ctx.scaleBy(x: s*k, y: -s*k)
    ctx.translateBy(x: -512, y: -512)

    // tarjeta blanca con sombra
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 22), blur: 50, color: NSColor.black.withAlphaComponent(0.28).cgColor)
    ctx.addPath(CGPath(roundedRect: CGRect(x: 170, y: 250, width: 684, height: 524), cornerWidth: 110, cornerHeight: 110, transform: nil))
    ctx.setFillColor(NSColor.white.cgColor); ctx.fillPath()
    ctx.restoreGState()

    // círculo de reproducción con degradado
    ctx.saveGState()
    let circle = CGPath(ellipseIn: CGRect(x: 240, y: 382, width: 260, height: 260), transform: nil)
    ctx.addPath(circle); ctx.clip()
    let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [C(255, 110, 100).cgColor, C(139, 123, 255).cgColor] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(g, start: CGPoint(x: 240, y: 382), end: CGPoint(x: 500, y: 642), options: [])
    ctx.restoreGState()
    ctx.setFillColor(NSColor.white.cgColor)
    ctx.move(to: CGPoint(x: 340, y: 448)); ctx.addLine(to: CGPoint(x: 340, y: 576)); ctx.addLine(to: CGPoint(x: 446, y: 512)); ctx.closePath()
    ctx.setLineJoin(.round); ctx.setLineWidth(18); ctx.setStrokeColor(NSColor.white.cgColor)
    ctx.drawPath(using: .fillStroke)

    // líneas de transcripción
    ctx.setLineCap(.round); ctx.setLineWidth(40)
    let lines: [(CGFloat, CGFloat, NSColor)] = [(420, 230, C(139, 123, 255)), (512, 180, C(255, 92, 138, 0.85)), (604, 210, C(200, 196, 222))]
    for (y, w, c) in lines {
        ctx.setStrokeColor(c.cgColor)
        ctx.move(to: CGPoint(x: 570, y: y)); ctx.addLine(to: CGPoint(x: 570 + w, y: y)); ctx.strokePath()
    }
    ctx.restoreGState()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments[1]
try! render(size: 1024, mac: true).write(to: URL(fileURLWithPath: out + "/icon-mac-1024.png"))
try! render(size: 1024, mac: false).write(to: URL(fileURLWithPath: out + "/icon-ios-1024.png"))
