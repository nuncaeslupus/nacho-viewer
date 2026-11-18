use crate::error::{ErrorKind, IpcError};
use serde::Serialize;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const MAX_DOCUMENT_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_SVG_BYTES: u64 = 2 * 1024 * 1024;

/// Response of `read_svg`: the raw markup, sanitised by the frontend before inlining.
#[derive(Debug, Serialize)]
pub struct Svg {
    pub svg: String,
}

#[derive(Debug, Serialize)]
pub struct Document {
    pub path: String,
    pub text: String,
    pub mtime_ms: u64,
}

/// Payload of the `document-changed` event.
#[derive(Debug, Clone, Serialize)]
pub struct DocumentChanged {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<u64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
    /// Not sent: with the mtime, what tells one version of the file from the next.
    #[serde(skip)]
    pub size: Option<u64>,
}

impl DocumentChanged {
    pub fn of(path: &Path) -> Self {
        let meta = fs::metadata(path).ok();
        let mtime_ms = meta.as_ref().map(mtime_ms);
        Self {
            path: path.display().to_string(),
            deleted: mtime_ms.is_none(),
            mtime_ms,
            size: meta.map(|m| m.len()),
        }
    }
}

/// Checks `path` against `scope`, then reads it (the command takes the scope lock for the check only).
#[cfg(test)]
pub fn read_document(scope: &crate::scope::Scope, path: &Path) -> Result<Document, IpcError> {
    read_file(&scope.check_document(path)?)
}

#[cfg(test)]
pub fn read_svg(scope: &crate::scope::Scope, path: &Path) -> Result<Svg, IpcError> {
    read_svg_file(&scope.check_svg(path)?)
}

/// Reads a path already checked against the scope.
pub fn read_file(path: &Path) -> Result<Document, IpcError> {
    let (bytes, meta) = read_capped(path, MAX_DOCUMENT_BYTES, "20 MB")?;
    Ok(Document {
        path: path.display().to_string(),
        text: String::from_utf8_lossy(&bytes).into_owned(),
        mtime_ms: mtime_ms(&meta),
    })
}

/// Reads an SVG already checked against the scope.
pub fn read_svg_file(path: &Path) -> Result<Svg, IpcError> {
    let (bytes, _) = read_capped(path, MAX_SVG_BYTES, "2 MB")?;
    Ok(Svg {
        svg: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// Only regular files are read: a FIFO or device would pass the size cap and then block the
/// read forever.
pub fn read_capped(
    path: &Path,
    max: u64,
    max_label: &str,
) -> Result<(Vec<u8>, fs::Metadata), IpcError> {
    let meta = fs::metadata(path).map_err(|e| IpcError::from_io(&e, path))?;
    if !meta.is_file() {
        return Err(IpcError::new(
            ErrorKind::NotPermitted,
            format!("{} is not a regular file", path.display()),
        ));
    }
    if meta.len() > max {
        return Err(IpcError::new(
            ErrorKind::TooLarge,
            format!("{} is over {max_label}", path.display()),
        ));
    }
    let bytes = fs::read(path).map_err(|e| IpcError::from_io(&e, path))?;
    Ok((bytes, meta))
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// Absolute paths from command-line arguments, resolved against `cwd`; flags are skipped.
pub fn paths_from_args<I, S>(args: I, cwd: &Path) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    // ponytail: no `file://` URIs; the .desktop entry passes plain paths (%F).
    args.into_iter()
        .map(|a| Path::new(a.as_ref()).to_path_buf())
        .filter(|p| !p.to_string_lossy().starts_with('-'))
        .map(|p| cwd.join(p))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scope::Scope;

    #[test]
    fn test_read_document_decodes_invalid_utf8_lossily_and_caps_size() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("a.md");
        fs::write(&doc, b"ok \xff").unwrap();
        let mut scope = Scope::default();
        scope.allow(&doc).unwrap();
        assert_eq!(read_document(&scope, &doc).unwrap().text, "ok \u{fffd}");

        let big = dir.path().join("big.md");
        fs::File::create(&big)
            .unwrap()
            .set_len(MAX_DOCUMENT_BYTES + 1)
            .unwrap();
        assert_eq!(
            read_document(&scope, &big).unwrap_err().kind,
            ErrorKind::TooLarge
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_read_document_refuses_non_regular_files() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("pipe.md");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(status.success());
        let mut scope = Scope::default();
        scope.allow(&dir.path().join("a.md")).unwrap();
        assert_eq!(
            read_document(&scope, &fifo).unwrap_err().kind,
            ErrorKind::NotPermitted
        );
    }

    #[test]
    fn test_paths_from_args_resolves_relative_and_skips_flags() {
        let cwd = Path::new("/home/u");
        let paths = paths_from_args(["a.md", "--verbose", "/abs/b.md"], cwd);
        assert_eq!(
            paths,
            [Path::new("/home/u/a.md"), Path::new("/abs/b.md")].map(Path::to_path_buf)
        );
    }
}
