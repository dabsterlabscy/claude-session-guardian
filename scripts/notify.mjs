// Fire-and-forget desktop notification. Cross-platform, dependency-free.
// Title/body are passed via env vars so there's no shell-quoting/injection risk.
import { spawn } from 'node:child_process';

const WIN_PS = [
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$x = $t.GetElementsByTagName('text')",
  "$x.Item(0).AppendChild($t.CreateTextNode($env:GUARDIAN_TOAST_TITLE)) | Out-Null",
  "$x.Item(1).AppendChild($t.CreateTextNode($env:GUARDIAN_TOAST_BODY)) | Out-Null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($t)",
  "$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)",
].join('; ');

export function notify(title, body) {
  try {
    const env = { ...process.env, GUARDIAN_TOAST_TITLE: String(title || ''), GUARDIAN_TOAST_BODY: String(body || '') };
    const opts = { detached: true, stdio: 'ignore', env, windowsHide: true };
    let child;
    if (process.platform === 'win32') {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN_PS], opts);
    } else if (process.platform === 'darwin') {
      child = spawn('osascript', ['-e', 'display notification (system attribute "GUARDIAN_TOAST_BODY") with title (system attribute "GUARDIAN_TOAST_TITLE")'], opts);
    } else {
      child = spawn('sh', ['-c', 'command -v notify-send >/dev/null 2>&1 && notify-send "$GUARDIAN_TOAST_TITLE" "$GUARDIAN_TOAST_BODY"'], opts);
    }
    child.unref();
  } catch { /* notifications are best-effort; never break the caller */ }
}
