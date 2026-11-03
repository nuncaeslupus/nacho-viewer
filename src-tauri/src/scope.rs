use crate::error::IpcError;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// What the frontend may read: the files the user opened, and Markdown files under their folders.
#[derive(Debug, Default)]
pub struct Scope {
    files: HashSet<PathBuf>,
    folders: HashSet<PathBuf>,
}

impl Scope {
    /// Records a file the user opened and returns its canonical path. A folder is refused.
    pub fn allow(&mut self, path: &Path) -> Option<PathBuf> {
        let path = resolve(path).filter(|p| !p.is_dir())?;
        self.folders.insert(path.parent()?.to_path_buf());
        self.files.insert(path.clone());
        Some(path)
    }

    pub fn is_opened(&self, path: &Path) -> bool {
        resolve(path).is_some_and(|p| self.files.contains(&p))
    }

    /// The canonical path of a document the frontend may read, or `not_permitted`.
    pub fn check_document(&self, path: &Path) -> Result<PathBuf, IpcError> {
        // A relative path is never permitted; an absolute one that does not resolve has lost
        // its folder, which a recent file renamed away from is the common case of.
        let resolved = resolve(path).ok_or_else(|| match path.is_absolute() {
            true => IpcError::not_found(path),
            false => IpcError::not_permitted(path),
        })?;
        if self.files.contains(&resolved) || (is_markdown(&resolved) && self.in_folders(&resolved))
        {
            Ok(resolved)
        } else {
            Err(IpcError::not_permitted(path))
        }
    }

    /// The canonical path of an image (by extension) under an opened document's folder, or
    /// `not_permitted`.
    pub fn check_image(&self, path: &Path) -> Result<PathBuf, IpcError> {
        resolve(path)
            .filter(|p| crate::image::media_type(p).is_some() && self.in_folders(p))
            .ok_or_else(|| IpcError::not_permitted(path))
    }

    /// The canonical path of an SVG under an opened document's folder, or `not_permitted`.
    pub fn check_svg(&self, path: &Path) -> Result<PathBuf, IpcError> {
        resolve(path)
            .filter(|p| has_extension(p, &["svg"]) && self.in_folders(p))
            .ok_or_else(|| IpcError::not_permitted(path))
    }

    fn in_folders(&self, path: &Path) -> bool {
        path.ancestors().skip(1).any(|a| self.folders.contains(a))
    }
}

/// The canonical form of an absolute path, with `..` and symlinks resolved, and on Windows
/// without the `\\?\` prefix where the plain form means the same file. A missing file
/// resolves through its parent folder, so it can still be in scope (and then `not_found`).
pub fn resolve(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    dunce::canonicalize(path).ok().or_else(|| {
        let parent = dunce::canonicalize(path.parent()?).ok()?;
        Some(parent.join(path.file_name()?))
    })
}

pub const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];

fn is_markdown(path: &Path) -> bool {
    has_extension(path, &MARKDOWN_EXTENSIONS)
}

fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| extensions.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{read_document, read_svg, MAX_SVG_BYTES};
    use crate::error::ErrorKind;
    use std::fs;

    #[test]
    fn test_resolve_gives_plain_paths_the_page_can_join() {
        // On Windows `fs::canonicalize` gives `\\?\C:\…`, which the page turns into `//?/C:/…`
        // when it resolves an image beside the document.
        let root = tempfile::tempdir().unwrap();
        let doc = root.path().join("a.md");
        fs::write(&doc, "# a").unwrap();
        for path in [doc.clone(), root.path().join("missing.md")] {
            let resolved = resolve(&path).unwrap();
            assert!(
                !resolved.to_string_lossy().starts_with(r"\\?\"),
                "{resolved:?}"
            );
        }
    }

    #[test]
    fn test_check_document_missing_folder_not_found() {
        let root = tempfile::tempdir().unwrap();
        let gone = root.path().join("renamed-away/readme.md");
        let err = Scope::default().check_document(&gone).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);
        assert!(err.message.contains("moved or renamed"), "{}", err.message);
        let err = Scope::default()
            .check_document(Path::new("readme.md"))
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotPermitted);
    }

    #[test]
    fn test_read_document_outside_scope_not_permitted() {
        let root = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(root.path()).unwrap();
        let notes = root.join("notes");
        let secret = root.join("secret");
        fs::create_dir_all(notes.join("sub")).unwrap();
        fs::create_dir_all(&secret).unwrap();
        for p in [
            notes.join("readme.md"),
            notes.join("other.md"),
            notes.join("sub/deep.md"),
            notes.join("id_rsa"),
            secret.join("diary.md"),
        ] {
            fs::write(p, "# hi").unwrap();
        }

        let mut scope = Scope::default();
        scope.allow(&notes.join("readme.md")).unwrap();

        for ok in ["readme.md", "other.md", "sub/deep.md"] {
            assert!(read_document(&scope, &notes.join(ok)).is_ok(), "{ok}");
        }
        assert_eq!(
            read_document(&scope, &notes.join("missing.md"))
                .unwrap_err()
                .kind,
            ErrorKind::NotFound
        );

        let mut denied = vec![
            secret.join("diary.md"),
            secret.join("missing.md"),
            notes.join("id_rsa"),
            notes.join("../secret/diary.md"),
            notes.join("sub/../../secret/diary.md"),
            PathBuf::from("notes/readme.md"),
            notes.clone(),
        ];
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(secret.join("diary.md"), notes.join("link.md")).unwrap();
            std::os::unix::fs::symlink(&secret, notes.join("linkdir")).unwrap();
            denied.push(notes.join("link.md"));
            denied.push(notes.join("linkdir/diary.md"));
        }
        let allowed: Vec<_> = denied
            .iter()
            .filter(|p| !matches!(read_document(&scope, p), Err(e) if e.kind == ErrorKind::NotPermitted))
            .collect();
        assert!(
            allowed.is_empty(),
            "out_of_scope_reads_allowed: {allowed:?}"
        );
    }

    #[test]
    fn test_read_svg_scoped_capped_regular_files_only() {
        let root = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(root.path()).unwrap();
        let notes = root.join("notes");
        let secret = root.join("secret");
        fs::create_dir_all(notes.join("img")).unwrap();
        fs::create_dir_all(&secret).unwrap();
        fs::write(notes.join("readme.md"), "# hi").unwrap();
        fs::write(notes.join("img/flow.svg"), "<svg/>").unwrap();
        fs::write(notes.join("img/flow.png"), "png").unwrap();
        fs::write(secret.join("x.svg"), "<svg/>").unwrap();
        fs::File::create(notes.join("big.svg"))
            .unwrap()
            .set_len(MAX_SVG_BYTES + 1)
            .unwrap();

        let mut scope = Scope::default();
        scope.allow(&notes.join("readme.md")).unwrap();

        assert_eq!(
            read_svg(&scope, &notes.join("img/flow.svg")).unwrap().svg,
            "<svg/>"
        );
        let kind = |p: PathBuf| read_svg(&scope, &p).unwrap_err().kind;
        assert_eq!(kind(notes.join("big.svg")), ErrorKind::TooLarge);
        assert_eq!(kind(notes.join("missing.svg")), ErrorKind::NotFound);
        for denied in [
            notes.join("img/flow.png"),
            notes.join("readme.md"),
            secret.join("x.svg"),
            notes.join("../secret/x.svg"),
        ] {
            assert_eq!(kind(denied.clone()), ErrorKind::NotPermitted, "{denied:?}");
        }
        #[cfg(unix)]
        {
            let fifo = notes.join("pipe.svg");
            let status = std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap();
            assert!(status.success());
            assert_eq!(kind(fifo), ErrorKind::NotPermitted);
        }
    }
}
