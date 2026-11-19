<!-- Generated from docs/troubleshooting.html by tools/make-docs-markdown.py. Edit the HTML, then run npm run docs-markdown. -->

# Troubleshooting & FAQ

Web page: https://benjamindehli.github.io/microsampler-editor-librarian/troubleshooting

Common issues and fixes, the gotchas worth knowing, and answers to frequent questions.

## Gotchas worth knowing

> **RAM vs. SAVED**
>
> Edits and uploads go to the device's **current bank, which is RAM**. They're lost on power-off or bank-switch. To keep them, do a **WRITE** on the device, or restore to a user bank from the editor. **Back up your bank** (Utility → BACKUP) before bulk operations, and never disconnect mid-transfer. More in [RAM vs saved](https://benjamindehli.github.io/microsampler-editor-librarian/concepts#persistence).

- **One USB owner at a time.** Close other MIDI applications (and Korg's editor) while the bridge is running. Only one program can hold the device.
- **Pattern playback** needs `GLOBAL → MIDI CLK = AUTO` on the device.
- **Remote sampling & record** give no feedback in the editor, so watch the device screen.
- **Panel edits** only transmit while the device is on its sample-edit page. Press **RECEIVE**, or return to the window with **AUTO-SYNC** on (the default), to re-sync after working on the hardware.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "microSAMPLER not responding" / "no inquiry reply" | Usually a brief hiccup while claiming the USB connection, not a real fault. Click **Retry** in the panel first (the bridge also retries, including a USB reset, on its own). Only power-cycle the device if it keeps failing. |
| "microSAMPLER disconnected" / "\[Errno 19\] No such device" | The USB connection dropped: the microSAMPLER was switched off, the cable was unplugged, or the computer slept. Make sure the device is on and connected, then click **Retry**. If Retry doesn't help, restart the editor (macOS app: menu bar ♪ → **Release Device**, then reload the page). |
| "BRIDGE OFFLINE" | The local bridge isn't running. Open the app (menu bar ♪ → Open Editor), or start the classic launcher (or `sudo python3 native-tools/bridge.py`). The page reconnects by itself. |
| No sound from the computer when playing pads | Expected: the editor plays on the microSAMPLER, so listen to the device's outputs. See [the FAQ below](https://benjamindehli.github.io/microsampler-editor-librarian/troubleshooting#no-sound). |
| macOS won't open the launcher ("unidentified developer") | Only the classic ZIP's launcher scripts are unsigned (the [desktop apps](https://benjamindehli.github.io/microsampler-editor-librarian/getting-started#download) are signed and notarized, with no approval dance). Approve the launcher once: right-click (Control-click) → **Open** → **Open**. On newer macOS without that option, double-click once, then **System Settings → Privacy & Security → Open Anyway**. See [Getting started](https://benjamindehli.github.io/microsampler-editor-librarian/getting-started#macos) for the Terminal alternative. |
| Device not found / permission error | Run with administrator rights (the launcher does this), check the cable, and close any other MIDI app holding the device. On Windows, switch the driver to WinUSB with [Zadig](https://zadig.akeo.ie/). |
| Edits made on the device don't show in the app | The microSAMPLER only transmits panel edits while it's on its sample-edit page. Press **RECEIVE**, or return to the window with **AUTO-SYNC** on, to re-read the bank. |
| Pattern play does nothing | Set `GLOBAL → MIDI CLK = AUTO` (or EXT MIDI) on the device. |
| A connected MIDI keyboard doesn't play | Tick **MIDI IN** on the Samples view and approve the browser's Web MIDI prompt. Web MIDI needs Chrome, Edge or Firefox (not Safari). If notes arrive but trigger the wrong thing, check the **SMP CH** / **KBD CH** fields next to MIDI IN. |
| Held loops or a playing pattern stop when I switch back to the editor | That's **AUTO-SYNC** re-reading the bank: a bank read stops the sequencer and releases held notes. Untick AUTO-SYNC in the top bar, and press **RECEIVE** yourself after editing on the device. |
| A MIDI-learned knob changes the wrong pad, or nothing | A binding belongs to the pad that was selected when you learned it. Select that pad to see its badge, or learn the knob again on the pad you want. |
| Sustain pedal or pitch bend stopped working | CC#64 or the pitch-bend wheel is MIDI-learned to a sample control. Click **LEARN**, right-click that control to clear its binding, then press `Esc`. |
| Uploaded sample sounds wrong | The device plays 16-bit audio at 48, 24, 12 or 6 kHz, and the upload resamples to the nearest of those, so a low-rate source stays lo-fi. Heavy **GAIN** can clip, so upload again with less gain, or with **NORMALIZE** instead. |
| USB seems stuck after many reconnects | Power-cycle the microSAMPLER. Heavy connect/disconnect churn can wedge its USB firmware, which only a power-cycle fully resets. |
| macOS app won't reopen or seems stuck | Quit it from the menu bar and open it again. Right after an update, the Editor app refreshes its background helper on first launch. If that shows a one-time error, quit and reopen it. |
| Editor app opens the browser to "This site can't be reached" | The macOS Editor app serves the editor from a background service that needs a one-time approval, usually right after a fresh install or an update. Enable it in **System Settings → General → Login Items & Extensions** ("microSAMPLER Editor Librarian"), then reopen the app. |

## FAQ

### Is this made or supported by Korg?

No. It's an independent, unofficial project, not affiliated with or endorsed by Korg, and it contains no Korg software or firmware. The protocol was reverse-engineered for interoperability with hardware you own.

### Why does it need administrator rights (sudo)?

Your operating system's MIDI driver normally owns the device's USB interface, so taking it over needs elevated rights. The macOS Editor app handles this with a background service you approve once (no typed password). The classic launchers ask for `sudo` each start. The Library app and library mode never touch USB, so they need no elevation at all.

### Do my edits save automatically?

No. Edits go to the [current bank, which is RAM](https://benjamindehli.github.io/microsampler-editor-librarian/concepts#persistence). WRITE to a user bank on the device, or restore a backup into a user bank from the Utility view, to keep them across power cycles. Back up before bulk changes.

### Can I use it without a microSAMPLER?

Yes. [Library mode](https://benjamindehli.github.io/microsampler-editor-librarian/guide#library) opens bank backups (Korg `.msmpl_bank` files or this app's ZIPs) and extracts their samples as WAVs and patterns as MIDI, with no hardware. There's also a `--mock` mode for exploring the interface.

### Can I use the banks I saved with Korg's original editor?

Yes. In the Utility view, **IMPORT…** takes a `.msmpl_bank` file, and **RESTORE…** writes the whole bank to the device: samples, their settings, the effect and the patterns. If RESTORE… is greyed out for an older import, import the file again.

### Why don't I hear anything from my computer?

The editor plays everything on the microSAMPLER itself: pads, audition, the on-screen keyboard and patterns. Listen to the device's own outputs (headphones or line out), not your computer's speakers. That way you hear exactly what the hardware sounds like, envelope and effects included. If the device is silent too, check its volume knob and the editor's master volume. The Library app is the exception: it works without the device, so it plays samples through your computer.

### Can I run it alongside my DAW?

Not at the same time. The device can only have one USB owner, and its sample/pattern transfers aren't ordinary MIDI. Close the DAW (and any other MIDI software) while the bridge is running, and close the bridge before using the microSAMPLER as a USB-MIDI device in your DAW. The macOS Editor app lets go of the device a few minutes after you close the editor tab, or right away via menu bar ♪ → **Release Device**.

### Why does pattern playback do nothing?

The microSAMPLER's sequencer advances on incoming MIDI clock. Set `GLOBAL → MIDI CLK = AUTO` (or EXT MIDI) on the device so it follows the editor's transport.

### Will it work on Windows?

It's experimental and untested there. libusb can't open the device until its USB driver is switched to WinUSB with [Zadig](https://zadig.akeo.ie/). See [Getting started](https://benjamindehli.github.io/microsampler-editor-librarian/getting-started#windows).

### Is my data safe?

The software is provided "as is", without warranty. It writes to the device's memory, so back up your banks before bulk operations and never disconnect mid-transfer. The author accepts no responsibility for any damage to your device or loss of data.

Didn't find it? Open an issue or check the changelog on [GitHub](https://github.com/benjamindehli/microsampler-editor-librarian).
