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
/// names, with that file selected where the file manager supports it. The call only queues a
/// request, so this waits for its Response (a portal drops a request whose sender disconnects),
/// and a refusal is an error the caller can fall back from.
#[cfg(target_os = "linux")]
fn portal_open_directory(path: &Path) -> Result<(), String> {
    use std::collections::HashMap;
    use zbus::blocking::{Connection, MessageIterator};
    use zbus::zvariant::{Fd, OwnedValue, Value};
    let err = |e: zbus::Error| e.to_string();
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let connection = Connection::session().map_err(err)?;
    let sender = connection.unique_name().ok_or("no D-Bus name")?.as_str();
    let token = format!("nacho{}", std::process::id());
    let request = format!(
        "/org/freedesktop/portal/desktop/request/{}/{token}",
        sender.trim_start_matches(':').replace('.', "_")
    );
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface("org.freedesktop.portal.Request")
        .and_then(|b| b.member("Response"))
        .and_then(|b| b.path(request))
        .map_err(err)?
        .build();
    let mut responses = MessageIterator::for_match_rule(rule, &connection, Some(1)).map_err(err)?;
    let options = HashMap::from([("handle_token", Value::from(token.as_str()))]);
    connection
        .call_method(
            Some("org.freedesktop.portal.Desktop"),
            "/org/freedesktop/portal/desktop",
            Some("org.freedesktop.portal.OpenURI"),
            "OpenDirectory",
            &("", Fd::from(&file), options),
        )
        .map_err(err)?;
    let message = responses.next().ok_or("no portal response")?.map_err(err)?;
    let (code, _): (u32, HashMap<String, OwnedValue>) =
        message.body().deserialize().map_err(err)?;
    match code {
        0 => Ok(()),
        code => Err(format!("portal response {code}")),
    }
}
