// microSAMPLER Library — Dock-app shell (macOS 12+).
//
// A plain frozen (PyInstaller) process has no macOS app lifecycle: it can't
// receive reopen events (double-clicking the "running" app does nothing),
// has no ⌘Q, and lingers as an invisible ghost after its browser window
// closes — which also confuses LaunchServices into "The application is not
// open anymore" states. This tiny NSApplication supervises the frozen
// library bridge (Contents/Resources/bridge/) as a child process and gives
// it real app semantics:
//   • launch → start the bridge → open the UI window
//   • Dock click / app reopen → open the UI window (again)
//   • ⌘Q / Quit → SIGTERM the bridge (its clean-shutdown path) and exit
//   • bridge exits by itself (web QUIT button, 2-min idle-exit) → shell
//     quits too, so the Dock icon never outlives the server
//
// Built by make_library_app.sh with plain swiftc — no Xcode project.
import AppKit
import Foundation

let uiURL = URL(string: "http://localhost:8766")!
let bridgePort: UInt16 = 8766

// Is the bridge accepting connections? A raw socket connect to an explicit
// IPv4 127.0.0.1 — NOT URLSession, whose per-request proxy discovery + IPv6
// (localhost → ::1) attempt stalled ~60 s EACH on localhost here, so the two
// launch-time checks cost ~2 min before the window appeared (measured). A
// POSIX connect is instant: immediate refusal when nothing listens, immediate
// accept when it's up. Same approach the Python side already uses.
func bridgeIsUp() -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 { return false }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = bridgePort.bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    return withUnsafePointer(to: &addr) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
            connect(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
        }
    }
}

// timestamped shell log next to the bridge's own library.log, so a slow or
// failed launch pins the exact step (which browser, how long) instead of
// leaving us guessing — this whole file has no other visible output.
let shellLogPath = ("~/Library/Application Support/DehliMusikk/microSAMPLER Library/shell.log"
                    as NSString).expandingTildeInPath

func shellLog(_ msg: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    guard let data = "\(stamp)  \(msg)\n".data(using: .utf8) else { return }
    if let fh = FileHandle(forWritingAtPath: shellLogPath) {
        fh.seekToEndOfFile(); fh.write(data); try? fh.close()
    } else {
        try? data.write(to: URL(fileURLWithPath: shellLogPath))
    }
}

// The user's DEFAULT browser first when it's a Chromium (already running &
// healthy → its app-mode window opens instantly); otherwise probe the known
// Chromium browsers. Forcing a non-default, possibly-cold Chrome via a new
// instance was the cause of multi-minute stalls before an app window appeared.
func browserOrder() -> [String] {
    let byBundleID = ["com.google.Chrome": "Google Chrome",
                      "com.microsoft.edgemac": "Microsoft Edge",
                      "com.brave.Browser": "Brave Browser",
                      "org.chromium.Chromium": "Chromium"]
    var order: [String] = []
    if let def = NSWorkspace.shared.urlForApplication(toOpen: uiURL),
       let bid = Bundle(url: def)?.bundleIdentifier,
       let name = byBundleID[bid] {
        order.append(name)
    }
    for name in ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"]
        where !order.contains(name) { order.append(name) }
    return order
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var child: Process?
    var quitting = false

    func applicationDidFinishLaunching(_ note: Notification) {
        shellLog("shell launched")
        buildMenu()
        openOrStart()
    }

    // Dock icon click (and app double-click while running) lands here — the
    // whole reason this shell exists.
    func applicationShouldHandleReopen(_ sender: NSApplication,
                                       hasVisibleWindows: Bool) -> Bool {
        openOrStart()
        return true
    }

    func applicationWillTerminate(_ note: Notification) {
        quitting = true
        // SIGTERM → the bridge's signal handler closes down cleanly (the same
        // proven path as Ctrl+C); no HTTP round-trip needed at quit time
        child?.terminate()
    }

    // ── lifecycle ────────────────────────────────────────────────────────────
    func openOrStart() {
        DispatchQueue.global(qos: .userInitiated).async {
            let up = bridgeIsUp()
            DispatchQueue.main.async {
                if up {
                    shellLog("bridge already up — opening UI")
                    self.openUI()          // bridge already up (ours or a CLI one)
                } else {
                    self.startChild()
                    self.pollBridge(attempt: 0)
                }
            }
        }
    }

    func startChild() {
        if let c = child, c.isRunning { return }
        shellLog("starting child bridge")
        let p = Process()
        p.executableURL = Bundle.main.resourceURL!
            .appendingPathComponent("bridge/microSAMPLER Library")
        var env = ProcessInfo.processInfo.environment
        env["MSMPL_NO_OPEN"] = "1"         // the shell opens the UI itself
        p.environment = env
        p.terminationHandler = { proc in
            DispatchQueue.main.async {
                // the bridge ended on its own (web QUIT button, idle-exit, or
                // a crash) — the Dock icon must not outlive the server
                if !self.quitting {
                    shellLog("child bridge exited (status \(proc.terminationStatus)) — quitting shell")
                    NSApp.terminate(nil)
                }
            }
        }
        do {
            try p.run()
            child = p
        } catch {
            alert("Could not start the library",
                  "\(error.localizedDescription)\n\nCheck ~/Library/Application Support/DehliMusikk/microSAMPLER Library/library.log")
        }
    }

    func pollBridge(attempt: Int) {
        if attempt > 60 {   // ~18 s at 0.3 s spacing
            shellLog("bridge never came up after \(attempt) polls")
            alert("Library not responding",
                  "The bridge started but isn't answering on port 8766. Check ~/Library/Application Support/DehliMusikk/microSAMPLER Library/library.log")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let up = bridgeIsUp()
            DispatchQueue.main.async {
                if up {
                    shellLog("bridge up after \(attempt) poll(s) — opening UI")
                    self.openUI()
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        self.pollBridge(attempt: attempt + 1)
                    }
                }
            }
        }
    }

    /// Open the UI in a Chromium "app mode" window — the user's default browser
    /// first when it's Chromium (see browserOrder), else the known list; falls
    /// back to the plain default browser. Off the main thread: each `open`
    /// probe waits for exit.
    func openUI() {
        DispatchQueue.global(qos: .userInitiated).async {
            for app in browserOrder() {
                shellLog("opening UI via \(app)…")
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                p.arguments = ["-na", app, "--args", "--app=" + uiURL.absoluteString]
                p.standardOutput = FileHandle.nullDevice
                p.standardError = FileHandle.nullDevice
                do { try p.run() } catch {
                    shellLog("  \(app): \(error.localizedDescription)")
                    continue
                }
                p.waitUntilExit()
                shellLog("  \(app): open exited \(p.terminationStatus)")
                if p.terminationStatus == 0 { return }
            }
            shellLog("no Chromium app-mode browser — using the default browser")
            DispatchQueue.main.async { NSWorkspace.shared.open(uiURL) }
        }
    }

    // ── chrome ───────────────────────────────────────────────────────────────
    func buildMenu() {
        // minimal main menu so ⌘O / ⌘Q work like in any app
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        let open = NSMenuItem(title: "Open Library Window",
                              action: #selector(openWindow), keyEquivalent: "o")
        open.target = self
        appMenu.addItem(open)
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Quit microSAMPLER Library",
                                   action: #selector(NSApplication.terminate(_:)),
                                   keyEquivalent: "q"))
        appItem.submenu = appMenu
        NSApp.mainMenu = main
    }

    @objc func openWindow() { openOrStart() }

    func alert(_ title: String, _ text: String) {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.runModal()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)        // real Dock app — that's the point
let delegate = AppDelegate()
app.delegate = delegate
app.run()
