' Media Studio launcher: starts the server without a console window (pythonw) and opens the app window.
' A server that already runs only opens a new window.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root
sh.Run "pythonw """ & root & "\server.py"" --open", 0, False
