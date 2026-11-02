//! More › User guide: the guide ships inside the app and opens as an ordinary document from the
//! app's data folder, so print, export and find work on it as on any file.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const GUIDE: &str = "Nacho Viewer Guide.md";

/// The guide and the pictures it links to, by their paths relative to it.
const FILES: [(&str, &[u8]); 3] = [
    (GUIDE, include_bytes!("../../docs/guide.md")),
    (
        "fixtures/currentcolor.svg",
        include_bytes!("../../docs/fixtures/currentcolor.svg"),
    ),
    (
        "fixtures/sample.png",
        include_bytes!("../../docs/fixtures/sample.png"),
    ),
];

/// Writes the guide under `dir`, replacing a copy from an older version, and returns its path.
pub fn write(dir: &Path) -> io::Result<PathBuf> {
    fs::create_dir_all(dir.join("fixtures"))?;
    for (name, bytes) in FILES {
        fs::write(dir.join(name), bytes)?;
    }
    Ok(dir.join(GUIDE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_help_writes_the_guide_with_every_picture_it_links_to() {
        let dir = tempfile::tempdir().unwrap();
        let guide = write(dir.path()).unwrap();
        let text = fs::read_to_string(guide).unwrap();
        let linked: Vec<_> = text
            .split("fixtures/")
            .skip(1)
            .map(|rest| rest.split(['"', ')']).next().unwrap())
            .collect();
        assert_eq!(linked.len(), FILES.len() - 1);
        for name in linked {
            assert!(dir.path().join("fixtures").join(name).is_file(), "{name}");
        }
    }

    #[test]
    fn test_help_replaces_an_older_copy() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(GUIDE), "old").unwrap();
        let guide = write(dir.path()).unwrap();
        assert_ne!(fs::read_to_string(guide).unwrap(), "old");
    }
}
