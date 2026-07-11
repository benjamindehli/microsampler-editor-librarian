// microSAMPLER Editor Librarian — menu-bar app (macOS 13+).
//
// A thin native shell around the bridge: the actual work happens in the
// launchd ROOT daemon this app registers via SMAppService (the frozen
// PyInstaller bridge in Contents/Resources/bridge/, declared by
// Contents/Library/LaunchDaemons/no.dehlimusikk.msmpl.bridge.plist).
// The user approves the background service ONCE in System Settings →
// Login Items; after that the daemon runs whenever the Mac is up, holding
// the USB device only while the editor UI is open (claim-on-demand +
// idle-release, implemented in the bridge's --daemon mode).
//
// Built by make_editor_app.sh with plain swiftc — no Xcode project.
import AppKit
import Foundation
import ServiceManagement

let bridgeURL = URL(string: "http://localhost:8765")!
let statusURL = URL(string: "http://localhost:8765/api/status")!
let releaseURL = URL(string: "http://localhost:8765/api/release")!
let daemonPlist = "no.dehlimusikk.msmpl.bridge.plist"

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!
    let menu = NSMenu()
    let deviceLine = NSMenuItem(title: "Bridge: checking…", action: nil, keyEquivalent: "")
    let serviceLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    var service: SMAppService { SMAppService.daemon(plistName: daemonPlist) }

    func applicationDidFinishLaunching(_ note: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let img = NSImage(systemSymbolName: "pianokeys",
                             accessibilityDescription: "microSAMPLER") {
            statusItem.button?.image = img
        } else {
            statusItem.button?.title = "♪"
        }

        menu.delegate = self
        let open = NSMenuItem(title: "Open Editor", action: #selector(openEditor), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)
        deviceLine.isEnabled = false
        menu.addItem(deviceLine)
        let release = NSMenuItem(title: "Release Device", action: #selector(releaseDevice), keyEquivalent: "")
        release.target = self
        menu.addItem(release)
        menu.addItem(NSMenuItem.separator())
        serviceLine.target = self
        menu.addItem(serviceLine)
        menu.addItem(NSMenuItem.separator())
        let quit = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        statusItem.menu = menu

        ensureService(interactive: true)
    }

    // ── background service lifecycle ─────────────────────────────────────────
    func ensureService(interactive: Bool) {
        // SMAppService needs the app at a stable path; a translocated or
        // ad-hoc location makes register() fail confusingly — say so instead.
        // App Translocation: a quarantined app can RUN from a randomized
        // read-only path even though its file sits in /Applications (e.g. the
        // zip was unpacked in place instead of Finder-dragging the app) — the
        // fix is de-quarantining, not moving.
        if interactive && Bundle.main.bundlePath.contains("/AppTranslocation/") {
            alert("One more step",
                  "macOS is running a temporary copy of this app (quarantine translocation), so the background service can’t be installed yet.\n\nIn Terminal, run:\nxattr -d com.apple.quarantine \"/Applications/microSAMPLER Editor Librarian.app\"\n\nIf that says “Operation not permitted”, first enable Terminal under System Settings → Privacy & Security → App Management, then run it again. Reopen this app afterwards.")
            return
        }
        if interactive && !Bundle.main.bundlePath.hasPrefix("/Applications") {
            alert("Move to Applications",
                  "Please move “microSAMPLER Editor Librarian” into the Applications folder, then open it again.\n\nmacOS only allows background services from apps installed in /Applications.")
            return
        }
        switch service.status {
        case .enabled:
            if interactive { openWhenBridgeUp() }
        case .requiresApproval:
            if interactive { promptApproval() }
        default:   // .notRegistered / .notFound
            do {
                try service.register()
                if service.status == .enabled {
                    if interactive { openWhenBridgeUp() }
                } else if interactive {
                    promptApproval()
                }
            } catch {
                // QUIRK: for daemons register() THROWS "Operation not
                // permitted" when user approval is PENDING — the registration
                // landed and status is .requiresApproval. That's the normal
                // first-run path, not a failure.
                if service.status == .requiresApproval {
                    if interactive { promptApproval() }
                } else if interactive {
                    alert("Could not install the background service",
                          "\(error.localizedDescription)\n\nIf the app was just downloaded, move it to /Applications and open it again.")
                }
            }
        }
    }

    func promptApproval() {
        alert("Approve the background service",
              "macOS needs a one-time approval for the microSAMPLER bridge.\n\nIn System Settings → General → Login Items & Extensions, enable “microSAMPLER Editor Librarian”, then reopen this app.")
        SMAppService.openSystemSettingsLoginItems()
    }

    @objc func toggleService() {
        if service.status == .enabled {
            let a = NSAlert()
            a.messageText = "Uninstall the background service?"
            a.informativeText = "The bridge daemon will be removed. The editor stops working until you install it again (just reopen this app)."
            a.addButton(withTitle: "Uninstall")
            a.addButton(withTitle: "Cancel")
            if a.runModal() == .alertFirstButtonReturn {
                do { try service.unregister() }
                catch { alert("Uninstall failed", error.localizedDescription) }
            }
        } else {
            ensureService(interactive: true)
        }
    }

    // ── menu actions ─────────────────────────────────────────────────────────
    @objc func openEditor() {
        if service.status == .enabled {
            openUI()
        } else {
            ensureService(interactive: true)
        }
    }

    /// Open the editor in a Chromium "app mode" window when one is installed
    /// (own window, no tabs/URL bar — app-like, keeps Web MIDI + downloads);
    /// otherwise the default browser. Runs off the main thread: each `open`
    /// probe waits for exit, and a LaunchServices stall must not beachball
    /// the menu bar.
    func openUI() {
        DispatchQueue.global(qos: .userInitiated).async {
            for app in ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"] {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                p.arguments = ["-na", app, "--args", "--app=" + bridgeURL.absoluteString]
                p.standardOutput = FileHandle.nullDevice
                p.standardError = FileHandle.nullDevice
                do { try p.run() } catch { continue }
                p.waitUntilExit()
                if p.terminationStatus == 0 { return }
            }
            DispatchQueue.main.async { NSWorkspace.shared.open(bridgeURL) }
        }
    }

    @objc func releaseDevice() {
        var req = URLRequest(url: releaseURL)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req).resume()
    }

    func openWhenBridgeUp() {
        // poll status until the freshly-registered daemon answers, then open
        pollBridge(attempt: 0)
    }

    func pollBridge(attempt: Int) {
        if attempt > 40 {   // ~20 s — daemon should be up long before this
            alert("Bridge not responding",
                  "The background service is installed but not answering on port 8765. Check /Library/Logs/DehliMusikk/msmpl-bridge.log")
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

    // ── live status in the menu ──────────────────────────────────────────────
    func menuWillOpen(_ menu: NSMenu) {
        switch service.status {
        case .enabled:
            serviceLine.title = "Uninstall Background Service…"
        case .requiresApproval:
            serviceLine.title = "Approve Background Service…"
        default:
            serviceLine.title = "Install Background Service"
        }
        serviceLine.action = #selector(toggleService)

        deviceLine.title = "Bridge: checking…"
        URLSession.shared.dataTask(with: statusURL) { data, _, _ in
            var line = "Bridge: not running"
            if let d = data,
               let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                if obj["connected"] as? Bool == true {
                    line = "Device: connected"
                } else if let err = obj["error"] as? String, !err.isEmpty {
                    line = "Device: unavailable"
                } else {
                    line = "Device: released (idle)"
                }
            }
            DispatchQueue.main.async { self.deviceLine.title = line }
        }.resume()
    }

    func alert(_ title: String, _ text: String) {
        // an .accessory (menu-bar) app isn't frontmost — without activating,
        // first-run alerts can appear behind other windows
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.runModal()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)      // menu-bar only (also LSUIElement)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
