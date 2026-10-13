' Media Studio launcher: opens index.html as an app window in Chrome (else Edge) with its own profile. No server, no console.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)

Function Find(paths)
  Find = ""
  For Each p In paths
    If fso.FileExists(p) Then
      Find = p
      Exit Function
    End If
  Next
End Function

pf = sh.ExpandEnvironmentStrings("%ProgramFiles%")
pf86 = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%")
la = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%")
browser = Find(Array(pf & "\Google\Chrome\Application\chrome.exe", pf86 & "\Google\Chrome\Application\chrome.exe", la & "\Google\Chrome\Application\chrome.exe"))
If browser = "" Then browser = Find(Array(pf86 & "\Microsoft\Edge\Application\msedge.exe", pf & "\Microsoft\Edge\Application\msedge.exe", la & "\Microsoft\Edge\Application\msedge.exe"))
If browser = "" Then
  MsgBox "Media Studio needs Google Chrome or Microsoft Edge.", 16, "Media Studio"
  WScript.Quit 1
End If

url = "file:///" & Replace(Replace(root, "\", "/"), " ", "%20") & "/index.html"
profile = la & "\MediaStudio\window"
sh.Run """" & browser & """ --app=""" & url & """ --user-data-dir=""" & profile & """ --window-size=1500,950", 1, False
