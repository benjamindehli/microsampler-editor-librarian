#!/usr/bin/env python3
"""
microSAMPLER native USB probe (libusb / pyusb).

Goal: find out whether libusb can take over the microSAMPLER's bulk MIDI
interface on your Mac. If it can, we can do sample/bank transfer in Python
(no Xcode needed). The WebUSB probe already showed the bulk endpoints live on
the Audio-class interface, which the browser can't touch — this checks the
native path instead.

Setup (macOS):
    brew install libusb
    python3 -m pip install pyusb
    # If macOS / CoreMIDI is holding the device, you may need to run as root:
    #   sudo python3 usb_probe.py
    # Close any DAW, the Web MIDI editor, and other MIDI apps first.

Then:
    python3 usb_probe.py
"""

import sys

try:
    import usb.core, usb.util
except ImportError:
    sys.exit("pyusb not installed. Run:  python3 -m pip install pyusb   "
             "(and: brew install libusb)")

VID, PID = 0x0944, 0x010C
CLASS = {0x00: 'Per-interface', 0x01: 'Audio', 0x02: 'CDC', 0x03: 'HID',
         0x08: 'Mass Storage', 0xfe: 'App-specific', 0xff: 'Vendor-specific'}


def ep_str(ep):
    direction = 'IN' if usb.util.endpoint_direction(ep.bEndpointAddress) == usb.util.ENDPOINT_IN else 'OUT'
    types = {0: 'control', 1: 'iso', 2: 'bulk', 3: 'interrupt'}
    t = types.get(usb.util.endpoint_type(ep.bmAttributes), '?')
    return f"{t}/{direction} addr=0x{ep.bEndpointAddress:02x} max={ep.wMaxPacketSize}"


def main():
    dev = usb.core.find(idVendor=VID, idProduct=PID)
    if dev is None:
        sys.exit(f"microSAMPLER (VID 0x{VID:04x} PID 0x{PID:04x}) not found. "
                 "Is it plugged in and powered on?")

    print("=== Device ===")
    try:
        print(f"  {usb.util.get_string(dev, dev.iManufacturer)} "
              f"{usb.util.get_string(dev, dev.iProduct)}")
    except Exception as e:
        print(f"  (string descriptors unavailable: {e})")
    print(f"  VID 0x{dev.idVendor:04x}  PID 0x{dev.idProduct:04x}  "
          f"USB {dev.bcdUSB >> 8}.{dev.bcdUSB & 0xff}")

    cfg = dev.get_active_configuration() if dev.get_active_configuration() else dev[0]
    bulk_out = bulk_in = None
    target_iface = None
    print("\n=== Interfaces ===")
    for itf in cfg:
        cls = CLASS.get(itf.bInterfaceClass, itf.bInterfaceClass)
        print(f"  itf {itf.bInterfaceNumber}.{itf.bAlternateSetting}  "
              f"class={cls} sub={itf.bInterfaceSubClass}")
        for ep in itf:
            print(f"      {ep_str(ep)}")
            etype = usb.util.endpoint_type(ep.bmAttributes)
            edir = usb.util.endpoint_direction(ep.bEndpointAddress)
            if etype == usb.util.ENDPOINT_TYPE_BULK:
                if edir == usb.util.ENDPOINT_OUT and bulk_out is None:
                    bulk_out, target_iface = ep, itf
                if edir == usb.util.ENDPOINT_IN and bulk_in is None:
                    bulk_in = ep

    if not (bulk_out and bulk_in):
        sys.exit("\nNo bulk in+out endpoints found — unexpected.")

    iface_num = target_iface.bInterfaceNumber
    print(f"\n=== Trying to take over interface {iface_num} ===")

    # On macOS, CoreMIDI/AppleUSBAudio usually owns this interface.
    detached = False
    try:
        if dev.is_kernel_driver_active(iface_num):
            print("  kernel driver active — attempting detach...")
            dev.detach_kernel_driver(iface_num)
            detached = True
            print("  detach_kernel_driver: ✓")
        else:
            print("  no kernel driver reported active")
    except NotImplementedError:
        print("  is_kernel_driver_active not implemented on this platform (normal on macOS)")
    except usb.core.USBError as e:
        print(f"  detach failed: {e}")

    try:
        usb.util.claim_interface(dev, iface_num)
        print(f"  claim_interface({iface_num}): ✓ CLAIMED")
    except usb.core.USBError as e:
        print(f"  claim_interface({iface_num}): ✗ {e}")
        print("\nVERDICT: ✗ libusb could NOT claim the interface on this Mac.")
        print("  Try:  sudo python3 usb_probe.py   (and close all MIDI apps).")
        print("  If sudo also fails, a deeper IOKit approach (or a kext-level")
        print("  workaround) is needed — tell me the exact error above.")
        return

    # End-to-end proof: send a Universal Device Inquiry as USB-MIDI packets and
    # read the reply. USB-MIDI wraps MIDI bytes in 4-byte packets:
    #   [cable<<4 | CIN, b0, b1, b2]   CIN 0x4=sysex-start/continue(3),
    #   0x5/0x6/0x7 = sysex ends with 1/2/3 bytes.
    print("\n=== End-to-end test: Device Inquiry over USB-MIDI ===")
    inquiry_packets = bytes([0x04, 0xF0, 0x7E, 0x7F,    # F0 7E 7F
                             0x07, 0x06, 0x01, 0xF7])    # 06 01 F7 (ends, 3 bytes)
    try:
        n = bulk_out.write(inquiry_packets, timeout=1000)
        print(f"  sent {n} bytes to {ep_str(bulk_out)}")
        raw = bytes(bulk_in.read(64, timeout=1500))
        # Decode 4-byte USB-MIDI event packets -> MIDI byte stream.
        # CIN (low nibble of byte 0) -> number of valid MIDI data bytes.
        cin_len = {0x4: 3, 0x5: 1, 0x6: 2, 0x7: 3, 0x8: 3, 0x9: 3, 0xa: 3,
                   0xb: 3, 0xc: 2, 0xd: 2, 0xe: 3, 0xf: 1}
        midi = bytearray()
        for i in range(0, len(raw) - 3, 4):
            cin = raw[i] & 0x0f
            midi += raw[i + 1:i + 1 + cin_len.get(cin, 0)]
        print(f"  raw USB-MIDI in : {raw.hex(' ')}")
        print(f"  decoded MIDI    : {bytes(midi).hex(' ')}")
        if 0x42 in midi and 0x7f in midi:
            print("  ✓ Got a Korg reply — libusb can talk to the microSAMPLER!")
    except usb.core.USBError as e:
        print(f"  bulk transfer error: {e}")

    usb.util.release_interface(dev, iface_num)
    if detached:
        try: dev.attach_kernel_driver(iface_num)
        except Exception: pass

    print("\nVERDICT: ✓ libusb CAN claim the interface — Python sample transfer is viable.")
    print("  Paste me this whole output and I'll build the upload tool.")


if __name__ == "__main__":
    main()
