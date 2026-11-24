//! Show in File Manager. The opener plugin asks the file manager over D-Bus
//! (org.freedesktop.FileManager1), which a Snap or Flatpak sandbox cannot reach, and its own
//! portal fallback calls OpenDirectory with the wrong interface and argument types, so it always
//! fails. On Linux this falls back to the portal done right (a file descriptor, which sandboxes
//! may pass), and last to opening the folder without selecting the file.
use std::path::Path;
use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

pub fn reveal<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), String> {
    let shown = app
        .opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string());
    #[cfg(target_os = "linux")]
    let shown = shown
        .or_else(|e| portal_open_directory(path).map_err(|p| format!("{e}; portal: {p}")))
        .or_else(|e| {
            let dir = path.parent().ok_or_else(|| e.clone())?;
            app.opener()
                .open_path(dir.to_string_lossy(), None::<&str>)
                .map_err(|o| format!("{e}; open folder: {o}"))
        });
    shown
}

/// xdg-desktop-portal's OpenURI.OpenDirectory: opens the folder holding the file the descriptor
/// names, with that file selected where the file manager supports it.
#[cfg(target_os = "linux")]
fn portal_open_directory(path: &Path) -> Result<(), String> {
    use std::collections::HashMap;
    use zbus::zvariant::{Fd, Value};
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let options: HashMap<&str, Value> = HashMap::new();
    let connection = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    connection
        .call_method(
            Some("org.freedesktop.portal.Desktop"),
            "/org/freedesktop/portal/desktop",
            Some("org.freedesktop.portal.OpenURI"),
            "OpenDirectory",
            &("", Fd::from(&file), options),
        )
        .map(drop)
        .map_err(|e| e.to_string())
}
