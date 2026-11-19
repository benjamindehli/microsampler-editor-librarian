<!-- Generated from docs/concepts.html by tools/make-docs-markdown.py. Edit the HTML, then run npm run docs-markdown. -->

# How the microSAMPLER works

Web page: https://benjamindehli.github.io/microsampler-editor-librarian/concepts

A plain-English tour of the concepts behind the hardware, so the editor's parameters and views make sense. This is a primer written for editor users. Your microSAMPLER's own manual is the authoritative reference.

## Banks & memory

Everything on the microSAMPLER lives in a **bank**. A bank is a complete kit: its 36 sample slots, all their parameters, the bank's name and tempo, one effect setting, and 16 pattern slots. Only **one bank is loaded at a time**. That's the "current bank" you're editing.

- **The current bank lives in RAM.** When you sample, upload or tweak a parameter, you're changing this working copy. Switching banks or powering off discards it unless you save (see below).
- **User banks** are persistent storage on the device. Saving the current bank into a user bank keeps it across power cycles.
- **ROM banks** are factory content (samples and patterns) you can load as a starting point. You can't overwrite them, but you can load one, edit it, and save the result to a user bank.

Each bank draws on two separate memory pools: a large one for sample audio and a small one for pattern sequences. The editor's **memory meters** show how full each pool is for the current bank, which is useful before sampling something long or recording busy patterns.

## RAM vs saved

> **EDITS ARE TEMPORARY UNTIL YOU SAVE**
>
> The editor writes to the device's **current bank, which is RAM**. Those changes are lost on power-off or a bank switch. To keep them: do a **WRITE** on the device to a user bank, or restore a backup into a user bank from the editor's [Utility](https://benjamindehli.github.io/microsampler-editor-librarian/guide#utility) view. Always **back up a bank** before bulk operations, and never disconnect mid-transfer.

Because the current bank is a working copy, nothing the editor does is permanent until you save it. A pattern preview, for example, overwrites that pattern in RAM but not in your user banks. It's also why bank backups matter: a backup captures the whole RAM bank to a file you can restore later.

## Samples & the two play modes

A bank has **36 sample slots**, laid out across the device's keys (and mirrored on the editor's pad grid). Each slot holds one recorded or imported sound plus its parameters. The microSAMPLER plays those 36 sounds in two ways:

- **Sample mode**. Each key triggers its *own* slot at its original pitch, like a drum kit or a pad bank. This is how you play a kit where every key is a different sound.
- **Keyboard mode**. The keys play a *single, selected* sample chromatically, like a sampler instrument: hold a melody and the one sample follows the pitches.

The on-screen keyboard's **SAMPLE / KEYBOARD** toggle, and MIDI-keyboard input, map straight onto these two modes. The two modes are also why a [pattern](https://benjamindehli.github.io/microsampler-editor-librarian/concepts#patterns) has two tracks: one for sample-mode hits (which pad, when) and one for keyboard-mode notes (which pitch of the selected sample).

## Sample parameters

Every slot carries a set of parameters the editor exposes and writes live:

| Parameter | What it does |
| --- | --- |
| Start / End | The portion of the recording that actually plays. Trim on the waveform or type exact frames. |
| Loop | Whether playback loops between the start and end points (sustained sounds) or plays once (one-shots). |
| Reverse | Plays the sample backwards. |
| Level / Pan | Per-slot volume and stereo position. |
| Decay / Release | How the sound fades while held and after release, its amplitude envelope. |
| Semitone / Tune | Coarse (±24 semitones) and fine (cents) pitch offset. |
| Velocity intensity | How strongly playing harder/softer affects the level. |
| FX switch | Whether the bank's effect is applied to this slot (see [Effects](https://benjamindehli.github.io/microsampler-editor-librarian/concepts#effects)). |
| BPM-sync / Original BPM | Time-stretch or pitch behaviour relative to the bank tempo (see below). |

> **PANEL EDITS & LIVE SYNC**
>
> The microSAMPLER only transmits a knob move while it's on its sample-edit page. Turned elsewhere, the value changes silently. So the editor re-reads the bank when you press **RECEIVE**, or when you return to the window with **AUTO-SYNC** on (the default), keeping the two in sync after you work on the hardware.

## BPM-sync & original BPM

A bank has a tempo, and each sample remembers the tempo it was recorded at, its **original BPM**. **BPM-sync** decides what happens when the bank tempo differs from a loop's original tempo:

- **Off**. The sample plays at its natural speed and pitch.
- **Stretch**. The sample is time-stretched to match the bank tempo, keeping its pitch. Great for keeping a drum loop in time across tempos.
- **Pitch**. The sample is sped up or slowed down to match the tempo, and its pitch changes with it (classic sampler behaviour).

For stretch/pitch to track correctly, the sample's **original BPM** must be right. That's why the editor lets you edit it (the **BPM** chip on the Samples view). When BPM-sync is on, the editor's waveform playhead even sweeps at the stretched rate.

## Sampling on the device

Sampling itself happens on the hardware (the editor can remotely trigger it via the [Utility](https://benjamindehli.github.io/microsampler-editor-librarian/guide#utility) view, but you watch the device screen). A few concepts shape how a recording turns into a playable slot:

- **Input**. Record from the audio input(s) or the built-in mic, or **resample** the device's own output (to bounce a sound through the effect, for example).
- **Trigger style**. The device offers several ways a sample is captured and replayed, e.g. looping material, one-shots, gated (only while a key is held), key-gated, and "auto next" for capturing a run of slots in sequence. These map onto the loop/one-shot behaviour you see per slot.
- **Audio-in through the effect**. The bank's effect can process the live input, so you can monitor and even sample through it.

Whichever way you capture audio, you can also bring sounds in from your computer: the editor uploads WAVs (resampling them to the device's rates), with optional normalize / trim / fade and auto-slicing across pads.

## Effects

Each bank has **one effect**, chosen from 22 types (filters, modulation, delays, reverb, a looper, and more). It's applied to any sample whose **FX switch** is on, and optionally to the live audio input. Two of the effect's parameters are assigned to the hardware's **FX EDIT 1/2** knobs for quick hands-on tweaking. The editor badges those two and tracks the physical knobs live. Which parameters are available, and how some gray out or swap, depends on the chosen type. The editor mirrors the hardware's behaviour exactly, and you can save/load whole effect setups as presets.

## The pattern sequencer

Each bank holds **16 patterns**. A pattern is a short, looping performance recorded across **two tracks** that match the two play modes:

- a **sample-mode track** for which pads were hit and when, and
- a **keyboard-mode track** for notes played on the selected keyboard-mode sample.

You can record patterns on the device, edit them in the editor's built-in piano roll (both tracks at once), and import/export them as Standard MIDI Files for your DAW. Because a pattern is just notes on two tracks, a MIDI file round-trips cleanly: channel 1 becomes the sample-mode track, other channels the keyboard-mode track.

> **THE SEQUENCER IS A CLOCK SLAVE**
>
> The device's sequencer doesn't run on its own clock when driven externally. It advances on incoming MIDI clock. That's why the editor streams clock at the bank tempo to play a pattern, and why the device needs `GLOBAL → MIDI CLK = AUTO`. See [device setup](https://benjamindehli.github.io/microsampler-editor-librarian/getting-started#device-setup).

## MIDI & the USB link

The microSAMPLER speaks MIDI over its USB connection. The editor uses that for the small, live things (playing notes, nudging parameters, transport), while large transfers (samples, whole banks, patterns) use a higher-throughput mode on the same USB pipe. A few consequences worth knowing:

- **One owner at a time.** Because those transfers aren't ordinary MIDI, the device can't be shared with a DAW or other MIDI software while the editor's bridge is running, so close them first.
- **Notes & velocity** play samples, and in keyboard mode they play the selected sample pitched. **Pitch bend** bends the keyboard-mode voice, and the **sustain pedal** holds notes. The editor forwards all of these from a connected MIDI controller via your browser's Web MIDI.
- **Continuous controllers and NRPNs** drive things like volume, pan, pattern selection, and triggering record or sampling. That's how the editor's remote record/sampling buttons work.
- **MIDI clock** advances the sequencer (above).

The editor can also map your controller's knobs to sample parameters (MIDI Learn). That mapping happens in the browser, and the values reach the device as ordinary parameter edits.

The editor never talks to the microSAMPLER through your computer's MIDI system (it only reads your MIDI controller, via Web MIDI). A small local **bridge** owns the USB connection and the browser talks to it over HTTP, which is why the bridge needs elevated rights while it holds the device (the macOS app's background service handles that after a one-time approval, and the classic launchers ask for `sudo`).

## Audio format

The microSAMPLER stores samples as **16-bit audio** at one of four sample rates (48 / 24 / 12 / 6 kHz), where lower rates trade fidelity for more recording time. When you upload a WAV the editor resamples it to the nearest device rate automatically, and when you download a slot you get a standard WAV back. The memory meter reflects the total sample time, which depends on the sample rate and whether the audio is mono or stereo.

Ready to use it? Head to [the guide](https://benjamindehli.github.io/microsampler-editor-librarian/guide) for each view, or [get set up](https://benjamindehli.github.io/microsampler-editor-librarian/getting-started) first.
