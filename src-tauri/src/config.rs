use crate::error::IpcError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const VERSION: u64 = 1;
pub const MAX_RECENT_FILES: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Light,
    Dark,
}

/// `$XDG_CONFIG_HOME/nacho-viewer/config.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub version: u64,
    pub theme: Theme,
    pub default_zoom: u32,
    pub remote_images: bool,
    /// The sheet fills the window instead of keeping a book's line length.
    pub wide_sheet: bool,
    /// Settings › Style: the document's faces and spacing; an unknown one reads as Classic.
    pub style: String,
    pub recent_files: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: VERSION,
            theme: Theme::System,
            default_zoom: 100,
            remote_images: false,
            wide_sheet: false,
            style: "classic".into(),
            recent_files: Vec::new(),
        }
    }
}

impl Config {
    pub fn normalized(mut self) -> Self {
        self.version = VERSION;
        self.default_zoom = self.default_zoom.clamp(50, 300);
        self.recent_files.truncate(MAX_RECENT_FILES);
        self
    }
}

#[derive(Debug, Serialize)]
pub struct UserCss {
    pub css: Option<String>,
}

/// The app's settings folder, `$XDG_CONFIG_HOME/nacho-viewer` (or the platform's equivalent).
/// Settings from before the rename are carried over on first use.
pub fn config_dir() -> Option<PathBuf> {
    let base = dirs::config_dir()?;
    Some(settings_dir(
        &base.join(OLD_DIR),
        &base.join("nacho-viewer"),
    ))
}

/// `new`, after carrying the old folder over. While that has failed, the old folder: its
/// settings still apply, rather than defaults that would turn remote images back on.
fn settings_dir(old: &Path, new: &Path) -> PathBuf {
    carry_over(old, new);
    if new.exists() || !old.is_dir() {
        new.to_path_buf()
    } else {
        old.to_path_buf()
    }
}

/// The settings folder's name before the app was renamed (D-32).
const OLD_DIR: &str = "glossmark";

/// Copies the settings and user.css from the folder used before the rename into `new`, once:
/// only while `new` does not exist. The old folder is left as it was. The files go to a staging
/// folder that becomes `new` only once every copy succeeded, so a failed copy (a full disk) is
/// retried next time instead of leaving a half-made folder whose defaults would undo the user's
/// settings, such as turning remote images back on.
fn carry_over(old: &Path, new: &Path) {
    if new.exists() || !old.is_dir() {
        return;
    }
    let staging = new.with_extension("migrating");
    let _ = fs::remove_dir_all(&staging);
    let copied = fs::create_dir_all(&staging).is_ok()
        && ["config.json", "user.css"].iter().all(|name| {
            let from = old.join(name);
            !from.is_file() || fs::copy(&from, staging.join(name)).is_ok()
        });
    if !copied || fs::rename(&staging, new).is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
}

/// Reads the config. A missing or unreadable file gives the defaults and is left alone; a file
/// that does not parse, or has an unknown version, is moved aside to a fresh backup first.
pub fn load(path: &Path) -> Config {
    let Ok(text) = fs::read_to_string(path) else {
        return Config::default();
    };
    parse(&text).unwrap_or_else(|| {
        if let Some(bak) = free_backup(path) {
            let _ = fs::rename(path, bak);
        }
        Config::default()
    })
}

/// `config.json.bak`, or `config.json.1.bak`, `config.json.2.bak`, … if that is taken.
fn free_backup(path: &Path) -> Option<PathBuf> {
    (0..1000)
        .map(|n| match n {
            0 => path.with_extension("json.bak"),
            n => path.with_extension(format!("json.{n}.bak")),
        })
        .find(|p| fs::symlink_metadata(p).is_err())
}

fn parse(text: &str) -> Option<Config> {
    let value: Value = serde_json::from_str(text).ok()?;
    if value.get("version")?.as_u64()? != VERSION {
        return None;
    }
    serde_json::from_value::<Config>(value)
        .ok()
        .map(Config::normalized)
}

pub fn save(path: &Path, config: &Config) -> Result<(), IpcError> {
    let io_err = |e: io::Error| IpcError::from_io(&e, path);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(io_err)?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(config).expect("config serialises");
    fs::write(&tmp, text).map_err(io_err)?;
    fs::rename(&tmp, path).map_err(io_err)
}

pub fn read_user_css(path: &Path) -> Result<UserCss, IpcError> {
    match fs::read(path) {
        Ok(bytes) => Ok(UserCss {
            css: Some(String::from_utf8_lossy(&bytes).into_owned()),
        }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(UserCss { css: None }),
        Err(e) => Err(IpcError::from_io(&e, path)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_remote_images_off_by_default() {
        assert!(!Config::default().remote_images);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), r#"{"version": 1}"#).unwrap();
        assert!(!load(&dir.path().join("config.json")).remote_images);
    }

    #[test]
    fn test_config_unknown_version_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");

        assert_eq!(load(&path), Config::default());

        let texts = [r#"{"version": 2, "theme": "dark"}"#, "{not json", "{}"];
        for text in texts {
            fs::write(&path, text).unwrap();
            assert_eq!(load(&path), Config::default(), "{text}");
            assert!(!path.exists());
        }
        // Each bad file gets its own backup; none is overwritten.
        for (bak, text) in ["config.json.bak", "config.json.1.bak", "config.json.2.bak"]
            .iter()
            .zip(texts)
        {
            assert_eq!(fs::read_to_string(dir.path().join(bak)).unwrap(), text);
        }
    }

    #[test]
    fn test_config_falls_back_to_glossmark_folder() {
        let base = tempfile::tempdir().unwrap();
        let (old, new) = (base.path().join(OLD_DIR), base.path().join("nacho-viewer"));
        fs::create_dir(&old).unwrap();
        fs::write(
            old.join("config.json"),
            r#"{"version": 1, "theme": "dark"}"#,
        )
        .unwrap();
        fs::write(old.join("user.css"), "body { color: red }").unwrap();

        // Only the old folder: its settings and user.css are read through the new one.
        carry_over(&old, &new);
        assert_eq!(load(&new.join("config.json")).theme, Theme::Dark);
        assert_eq!(
            read_user_css(&new.join("user.css")).unwrap().css.as_deref(),
            Some("body { color: red }")
        );
        assert!(
            old.join("config.json").is_file(),
            "the old folder is left as it was"
        );

        // Both folders: the new one wins and is not overwritten.
        fs::write(
            new.join("config.json"),
            r#"{"version": 1, "theme": "light"}"#,
        )
        .unwrap();
        carry_over(&old, &new);
        assert_eq!(load(&new.join("config.json")).theme, Theme::Light);
    }

    #[test]
    fn test_config_failed_carry_over_is_retried() {
        let base = tempfile::tempdir().unwrap();
        let (old, new) = (base.path().join(OLD_DIR), base.path().join("nacho-viewer"));
        fs::create_dir(&old).unwrap();
        fs::write(
            old.join("config.json"),
            r#"{"version": 1, "theme": "dark", "remoteImages": false}"#,
        )
        .unwrap();

        // A file where the staging folder goes makes the copy fail: no half-made new folder,
        // and the old settings stay in force, remote images included.
        let blocker = new.with_extension("migrating");
        fs::write(&blocker, "").unwrap();
        let dir = settings_dir(&old, &new);
        assert!(!new.exists());
        assert!(!load(&dir.join("config.json")).remote_images);

        fs::remove_file(&blocker).unwrap();
        assert_eq!(settings_dir(&old, &new), new);
        assert_eq!(load(&new.join("config.json")).theme, Theme::Dark);
        assert!(!load(&new.join("config.json")).remote_images);
        assert!(!blocker.exists());
    }

    #[test]
    fn test_config_read_error_keeps_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::create_dir(&path).unwrap(); // EISDIR on read
        assert_eq!(load(&path), Config::default());
        assert!(path.is_dir());
        assert!(!dir.path().join("config.json.bak").exists());
    }

    #[test]
    fn test_config_round_trips_and_normalises() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nacho-viewer/config.json");
        let config = Config {
            theme: Theme::Dark,
            default_zoom: 1000,
            remote_images: false,
            recent_files: (0..12).map(|i| format!("/r/{i}.md")).collect(),
            ..Config::default()
        };
        save(&path, &config.clone().normalized()).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.default_zoom, 300);
        assert_eq!(loaded.recent_files.len(), MAX_RECENT_FILES);
        assert_eq!(loaded.theme, Theme::Dark);
        assert!(!loaded.remote_images);

        fs::write(&path, r#"{"version": 1, "theme": "light"}"#).unwrap();
        assert_eq!(load(&path).default_zoom, 100);
    }

    #[test]
    fn test_user_css_absent_is_null() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("user.css");
        assert_eq!(read_user_css(&path).unwrap().css, None);
        fs::write(&path, "body{}").unwrap();
        assert_eq!(read_user_css(&path).unwrap().css.as_deref(), Some("body{}"));
    }
}
