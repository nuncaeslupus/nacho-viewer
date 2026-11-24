//! More › User guide: the guide ships inside the app and opens as an ordinary document from the
//! app's data folder, so print, export and find work on it as on any file.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const GUIDE: &str = "Nacho Viewer Guide.md";

/// The guide in each UI language; English first, for any other code.
const GUIDES: [(&str, &[u8]); 15] = [
    ("en", include_bytes!("../../docs/guide.md")),
    ("es", include_bytes!("../../docs/guide.es.md")),
    ("de", include_bytes!("../../docs/guide.de.md")),
    ("fr", include_bytes!("../../docs/guide.fr.md")),
    ("it", include_bytes!("../../docs/guide.it.md")),
    ("pt", include_bytes!("../../docs/guide.pt.md")),
    ("zh", include_bytes!("../../docs/guide.zh.md")),
    ("ja", include_bytes!("../../docs/guide.ja.md")),
    ("hi", include_bytes!("../../docs/guide.hi.md")),
    ("bn", include_bytes!("../../docs/guide.bn.md")),
    ("id", include_bytes!("../../docs/guide.id.md")),
    ("ko", include_bytes!("../../docs/guide.ko.md")),
    ("tr", include_bytes!("../../docs/guide.tr.md")),
    ("vi", include_bytes!("../../docs/guide.vi.md")),
    ("ca", include_bytes!("../../docs/guide.ca.md")),
];

/// The pictures the guides link to, by their paths relative to the guide.
const PICTURES: [(&str, &[u8]); 2] = [
    (
        "fixtures/currentcolor.svg",
        include_bytes!("../../docs/fixtures/currentcolor.svg"),
    ),
    (
        "fixtures/sample.png",
        include_bytes!("../../docs/fixtures/sample.png"),
    ),
];

/// Writes the guide in `language` under `dir`, replacing a copy from an older version or
/// another language, and returns its path.
pub fn write(dir: &Path, language: &str) -> io::Result<PathBuf> {
    fs::create_dir_all(dir.join("fixtures"))?;
    for (name, bytes) in PICTURES {
        fs::write(dir.join(name), bytes)?;
    }
    let guide = GUIDES
        .iter()
        .find(|(code, _)| *code == language)
        .unwrap_or(&GUIDES[0]);
    fs::write(dir.join(GUIDE), guide.1)?;
    Ok(dir.join(GUIDE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_help_writes_the_guide_with_every_picture_it_links_to() {
        for (language, _) in GUIDES {
            let dir = tempfile::tempdir().unwrap();
            let guide = write(dir.path(), language).unwrap();
            let text = fs::read_to_string(guide).unwrap();
            let linked: Vec<_> = text
                .split("fixtures/")
                .skip(1)
                .map(|rest| rest.split(['"', ')']).next().unwrap())
                .collect();
            assert_eq!(linked.len(), PICTURES.len(), "{language}");
            for name in linked {
                assert!(dir.path().join("fixtures").join(name).is_file(), "{name}");
            }
        }
    }

    #[test]
    fn test_help_writes_the_guide_in_the_language_asked_for() {
        let dir = tempfile::tempdir().unwrap();
        let es = fs::read_to_string(write(dir.path(), "es").unwrap()).unwrap();
        assert_eq!(es.as_bytes(), GUIDES[1].1);
        let unknown = fs::read_to_string(write(dir.path(), "xx").unwrap()).unwrap();
        assert_eq!(unknown.as_bytes(), GUIDES[0].1);
    }

    #[test]
    fn test_help_replaces_an_older_copy() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(GUIDE), "old").unwrap();
        let guide = write(dir.path(), "en").unwrap();
        assert_ne!(fs::read_to_string(guide).unwrap(), "old");
    }
}
