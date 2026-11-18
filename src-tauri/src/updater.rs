//! Self-update (D-28, D-31): only builds that can replace themselves update through the Tauri
//! updater; Flatpak, Snap and the .deb update through their channel.

use crate::error::{ErrorKind, IpcError};
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_updater::UpdaterExt;

/// Payload of the `update-available` event.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateAvailable {
    pub version: String,
}

/// Off under Flatpak or Snap, and for a binary below `/usr` (the .deb, from apt or by hand).
pub fn enabled() -> bool {
    std::env::current_exe()
        .is_ok_and(|exe| enabled_for(|name| std::env::var_os(name).is_some(), &exe))
}

fn enabled_for(is_set: impl Fn(&str) -> bool, exe: &Path) -> bool {
    !is_set("FLATPAK_ID") && !is_set("SNAP") && !exe.starts_with("/usr")
}

fn failed(err: tauri_plugin_updater::Error) -> IpcError {
    IpcError::new(ErrorKind::Io, err.to_string())
}

/// Emits `update-available` when `latest.json` names a newer version.
pub async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<(), IpcError> {
    if !enabled() {
        return Ok(());
    }
    if let Some(update) = app
        .updater()
        .map_err(failed)?
        .check()
        .await
        .map_err(failed)?
    {
        let _ = app.emit(
            "update-available",
            UpdateAvailable {
                version: update.version,
            },
        );
    }
    Ok(())
}

/// Downloads, verifies and installs the newer version, then restarts into it.
pub async fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), IpcError> {
    // Callable from the page regardless of the build, so it carries the same guard as `check`.
    if !enabled() {
        return Err(IpcError::new(
            ErrorKind::Io,
            "this build updates through its package",
        ));
    }
    let update = app
        .updater()
        .map_err(failed)?
        .check()
        .await
        .map_err(failed)?
        .ok_or_else(|| IpcError::new(ErrorKind::Io, "no update is available"))?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(failed)?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_updater_is_off_in_flatpak_snap_and_usr() {
        let appimage = Path::new("/tmp/.mount_NachoXYZ/usr/bin/nacho-viewer");
        let none = |_: &str| false;
        assert!(enabled_for(none, appimage));
        assert!(!enabled_for(|name| name == "FLATPAK_ID", appimage));
        assert!(!enabled_for(|name| name == "SNAP", appimage));
        assert!(!enabled_for(none, Path::new("/usr/bin/nacho-viewer")));
        assert!(enabled_for(
            none,
            Path::new(r"C:\Program Files\Nacho Viewer\nacho-viewer.exe")
        ));
    }
}
