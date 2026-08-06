' Launches the host with NO console window, and WAITS for it.
'
' Both halves matter:
'
' * Hidden (the 0 below) is the point. A scheduled task whose action is cmd.exe
'   under an interactive logon parks a console window on the desktop forever.
'   One sat there from 2026-08-05 to 08-07, the owner took it for litter and
'   closed it, and that killed the host: 0xC000013A is STATUS_CONTROL_C_EXIT,
'   i.e. "the console went away". The device fell to its clock face and was
'   reported as stuck. A window that is visible is a window that gets closed.
'
' * Waiting (the True below) is what keeps the scheduled task honest. If this
'   script launched the host and exited, the task would go straight back to
'   Ready and MultipleInstancesPolicy=IgnoreNew would stop protecting anything,
'   so the every-minute trigger would start a second host onto the same serial
'   port. Blocking here means the task is Running for exactly as long as the
'   host is.
'
' Why not S4U ("run whether the user is logged on or not"), which needs no
' wrapper at all: registering an S4U task requires elevation, and this install
' has to work from an ordinary prompt. Try S4U first if you ever have admin.
'
' VBScript is deprecated on Windows 11 (still present, and this machine logs a
' VBScriptDeprecationAlert when it runs). If it is ever removed, the replacement
' is the S4U principal above, not another wrapper.
Option Explicit

Dim fso, sh, q, hostDir, nodePath, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
q = Chr(34)

If WScript.Arguments.Count < 1 Then
  WScript.Quit 2
End If
nodePath = WScript.Arguments(0)

' <host>/scripts/this.vbs -> <host>
hostDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = hostDir

' cmd /c ""<node>" src\index.js >> out\host-autostart.log 2>&1"
' The outer pair is there because cmd strips it when /c's argument starts with a
' quote; without it the quoted node path breaks on the space in "Program Files".
command = "cmd /c " & q & q & nodePath & q & " src\index.js >> out\host-autostart.log 2>&1" & q

' 0 = hidden window, True = wait for it to exit and return its code.
WScript.Quit sh.Run(command, 0, True)
