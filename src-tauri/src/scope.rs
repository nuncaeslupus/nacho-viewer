use crate::error::IpcError;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// What the frontend may read: the files the user opened, and Markdown files under their folders.
#[derive(Debug, Default)]
pub struct Scope {
    files: HashSet<PathBuf>,
    /// Folders whose whole tree the frontend may read from (images, SVGs, linked Markdown).
    folders: HashSet<PathBuf>,
    /// Folders too broad to grant as a tree (a filesystem root, the home folder): only their
    /// direct children are readable, never what lies below.
    flat_folders: HashSet<PathBuf>,
    /// Extra broad folders beyond a filesystem root, e.g. the home folder and its parent.
    broad: Vec<PathBuf>,
}

impl Scope {
    /// A scope that treats the user's home folder (and the folder holding it) as too broad to
    /// grant recursively.
    pub fn guarded() -> Self {
        let home = dirs::home_dir().and_then(|h| resolve(&h));
        let broad = home
            .iter()
            .flat_map(|h| [Some(h.clone()), h.parent().map(Path::to_path_buf)])
            .flatten()
            .collect();
        Self {
            broad,
            ..Self::default()
        }
    }

    /// Records a file the user opened and returns its canonical path. A folder is refused.
    pub fn allow(&mut self, path: &Path) -> Option<PathBuf> {
        let path = resolve(path).filter(|p| !p.is_dir())?;
        let folder = path.parent()?.to_path_buf();
        if folder.parent().is_none() || self.broad.contains(&folder) {
            self.flat_folders.insert(folder);
        } else {
            self.folders.insert(folder);
        }
        self.files.insert(path.clone());
        Some(path)
    }

    /// A recent file from the config: readable as a document, but its folder stays closed until
    /// the user opens it (`promote`), so a launch grants no folder trees.
    pub fn allow_recent(&mut self, path: &Path) {
        if let Some(path) = resolve(path).filter(|p| !p.is_dir()) {
            self.files.insert(path);
        }
    }

    /// The user opened `path` (a recent file read for display): grant its folder as `allow` does.
    pub fn promote(&mut self, path: &Path) {
        if self.files.contains(path) {
            self.allow(path);
        }
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
            || path.parent().is_some_and(|p| self.flat_folders.contains(p))
    }
}

/// Under Flatpak a file the desktop hands over arrives as `/run/flatpak/doc/<id>/<name>`, a
/// portal copy without its folder. Its real path, when the sandbox can read it (`home:ro`),
/// brings back the document's images, links and live reload, and the dialogs' start folder.
pub fn host_path(path: &Path) -> PathBuf {
    portal_doc_id(path)
        .and_then(portal_host_path)
        .filter(|real| real.is_file())
        .unwrap_or_else(|| path.to_path_buf())
}

fn portal_doc_id(path: &Path) -> Option<&str> {
    path.strip_prefix(PORTAL_DOCS).ok()?.iter().next()?.to_str()
}

const PORTAL_DOCS: &str = "/run/flatpak/doc";

#[cfg(target_os = "linux")]
fn portal_host_path(id: &str) -> Option<PathBuf> {
    use gtk::gio;
    use gtk::glib::{ToVariant, VariantTy};
    use std::os::unix::ffi::OsStrExt;

    let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).ok()?;
    let reply = bus
        .call_sync(
            Some("org.freedesktop.portal.Documents"),
            "/org/freedesktop/portal/documents",
            "org.freedesktop.portal.Documents",
            "GetHostPaths",
            Some(&(vec![id],).to_variant()),
            Some(VariantTy::new("(a{say})").ok()?),
            gio::DBusCallFlags::NONE,
            1000,
            gio::Cancellable::NONE,
        )
        .ok()?;
    let (paths,): (std::collections::HashMap<String, Vec<u8>>,) = reply.get()?;
    // A bytestring: the path with a trailing NUL.
    let bytes = paths.get(id)?;
    let bytes = bytes.strip_suffix(&[0]).unwrap_or(bytes);
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
}

#[cfg(not(target_os = "linux"))]
fn portal_host_path(_: &str) -> Option<PathBuf> {
    None
}

/// The host cannot see a portal folder, so a dialog must not start in one.
pub fn is_portal_path(path: &Path) -> bool {
    path.starts_with(PORTAL_DOCS)
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
    fn test_recent_file_grants_no_folder_until_opened() {
        let root = tempfile::tempdir().unwrap();
        let notes = dunce::canonicalize(root.path()).unwrap().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join("readme.md"), "# hi").unwrap();
        fs::write(notes.join("pic.png"), "x").unwrap();
        fs::write(notes.join("other.md"), "# o").unwrap();

        let mut scope = Scope::default();
        scope.allow_recent(&notes.join("readme.md"));
        assert!(scope.check_document(&notes.join("readme.md")).is_ok());
        assert!(scope.check_image(&notes.join("pic.png")).is_err());
        assert!(scope.check_document(&notes.join("other.md")).is_err());

        scope.promote(&notes.join("readme.md"));
        assert!(scope.check_image(&notes.join("pic.png")).is_ok());
        // Promoting a file the scope never held grants nothing.
        let mut scope = Scope::default();
        scope.promote(&notes.join("readme.md"));
        assert!(scope.check_image(&notes.join("pic.png")).is_err());
    }

    #[test]
    fn test_broad_folder_is_not_granted_recursively() {
        let root = tempfile::tempdir().unwrap();
        let home = dunce::canonicalize(root.path()).unwrap();
        fs::create_dir_all(home.join("deep/er")).unwrap();
        fs::write(home.join("notes.md"), "# n").unwrap();
        fs::write(home.join("pic.png"), "x").unwrap();
        fs::write(home.join("deep/er/secret.png"), "x").unwrap();

        let mut scope = Scope {
            broad: vec![home.clone()],
            ..Scope::default()
        };
        scope.allow(&home.join("notes.md")).unwrap();
        assert!(scope.check_image(&home.join("pic.png")).is_ok());
        assert!(scope.check_image(&home.join("deep/er/secret.png")).is_err());
    }

    #[test]
    fn test_read_document_outside_scope_not_permitted() {
        let root = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(root.path()).unwrap();
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
        let root = dunce::canonicalize(root.path()).unwrap();
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

    #[test]
    fn test_portal_paths_are_recognised_and_others_pass_through() {
        let doc = Path::new("/run/flatpak/doc/f0c39a09/notes.md");
        assert_eq!(portal_doc_id(doc), Some("f0c39a09"));
        assert!(is_portal_path(doc.parent().unwrap()));
        let plain = Path::new("/home/someone/notes.md");
        assert_eq!(portal_doc_id(plain), None);
        assert!(!is_portal_path(plain));
        assert_eq!(host_path(plain), plain);
        assert_eq!(portal_doc_id(Path::new("/run/flatpak/docs/x/a.md")), None);
    }
}
