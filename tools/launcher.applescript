-- microSAMPLER Editor launcher (AppleScript applet).
-- Build the clickable app with:  ./tools/make_launcher.sh
--
-- Starts native-tools/bridge.py as root (libusb must claim the USB
-- interface CoreMIDI holds — same reason the CLI needs sudo), waits for
-- the HTTP port, then opens a Chrome app-mode window (or the default
-- browser). Re-opening while the bridge runs offers Open Editor /
-- Stop Bridge. Bridge output: ~/Library/Logs/microsampler-bridge.log

on portOpen()
	try
		do shell script "nc -z localhost 8765"
		return true
	on error
		return false
	end try
end portOpen

on openUI()
	do shell script "open -na 'Google Chrome' --args --app='http://localhost:8765' 2>/dev/null || open 'http://localhost:8765'"
end openUI

on run
	-- the .app lives in the repo root; resolve it relative to ourselves
	set appPath to POSIX path of (path to me)
	set repoRoot to do shell script "dirname " & quoted form of appPath

	if portOpen() then
		set btn to button returned of (display dialog ¬
			"The microSAMPLER bridge is already running." buttons {"Stop Bridge", "Open Editor"} ¬
			default button "Open Editor" with title "microSAMPLER Editor")
		if btn is "Stop Bridge" then
			do shell script "pkill -f native-tools/bridge.py" with administrator privileges
			return
		end if
		openUI()
		return
	end if

	-- use the SAME python3 the user's terminal would (login-shell PATH —
	-- the bare do-shell-script PATH lacks /usr/local & /opt/homebrew)
	set py to do shell script "zsh -lc 'command -v python3' 2>/dev/null || echo /usr/bin/python3"

	-- start the bridge as root; ( … & ) + redirect lets the call return
	do shell script "cd " & quoted form of (repoRoot & "/native-tools") & ¬
		" && ( " & quoted form of py & " bridge.py >> \"$HOME/Library/Logs/microsampler-bridge.log\" 2>&1 & )" ¬
		with administrator privileges

	-- wait up to 15 s for the server
	repeat 60 times
		if portOpen() then
			openUI()
			return
		end if
		delay 0.25
	end repeat

	display dialog "The bridge did not start. Is the microSAMPLER connected and on?" & return & return & ¬
		"Details: ~/Library/Logs/microsampler-bridge.log" ¬
		buttons {"OK"} default button "OK" with icon stop with title "microSAMPLER Editor"
end run
