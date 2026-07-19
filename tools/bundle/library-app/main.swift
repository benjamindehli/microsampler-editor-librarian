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
let statusURL = URL(string: "http://localhost:8766/api/status")!

final class AppDelegate: NSObject, NSApplicationDelegate {
    var child: Process?
    var quitting = false

    func applicationDidFinishLaunching(_ note: Notification) {
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
        URLSession.shared.dataTask(with: statusURL) { data, _, _ in
            DispatchQueue.main.async {
                if data != nil {
                    self.openUI()          // bridge already up (ours or a CLI one)
                } else {
                    self.startChild()
                    self.pollBridge(attempt: 0)
                }
            }
        }.resume()
    }

    func startChild() {
        if let c = child, c.isRunning { return }
        let p = Process()
        p.executableURL = Bundle.main.resourceURL!
            .appendingPathComponent("bridge/microSAMPLER Library")
        var env = ProcessInfo.processInfo.environment
        env["MSMPL_NO_OPEN"] = "1"         // the shell opens the UI itself
        p.environment = env
        p.terminationHandler = { _ in
            DispatchQueue.main.async {
                // the bridge ended on its own (web QUIT button, idle-exit, or
                // a crash) — the Dock icon must not outlive the server
                if !self.quitting { NSApp.terminate(nil) }
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
        if attempt > 40 {   // ~20 s
            alert("Library not responding",
                  "The bridge started but isn't answering on port 8766. Check ~/Library/Application Support/DehliMusikk/microSAMPLER Library/library.log")
            return
        }
        URLSession.shared.dataTask(with: statusURL) { data, _, _ in
            DispatchQueue.main.async {
                if data != nil {
                    self.openUI()
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        self.pollBridge(attempt: attempt + 1)
                    }
                }
            }
        }.resume()
    }

    /// Open the UI in a Chromium "app mode" window when one is installed
    /// (own window, no tabs/URL bar); otherwise the default browser. Off the
    /// main thread: each `open` probe waits for exit.
    func openUI() {
        DispatchQueue.global(qos: .userInitiated).async {
            for app in ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"] {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                p.arguments = ["-na", app, "--args", "--app=" + uiURL.absoluteString]
                p.standardOutput = FileHandle.nullDevice
                p.standardError = FileHandle.nullDevice
                do { try p.run() } catch { continue }
                p.waitUntilExit()
                if p.terminationStatus == 0 { return }
            }
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
