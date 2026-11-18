use crate::document::DocumentChanged;
use notify_debouncer_mini::notify::{self, RecommendedWatcher};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Quiet time before a change is reported, so one save that writes several times reloads once.
pub const DEBOUNCE: Duration = Duration::from_millis(100);

/// Reference counts for watched files. The folder is what gets watched, not the file: editors
/// that save by writing a new file and renaming it over the old one would end a file watch.
#[derive(Debug, Default)]
pub struct Registry {
    files: HashMap<PathBuf, usize>,
    folders: HashMap<PathBuf, usize>,
}

impl Registry {
    /// Counts one more watcher of `file`; returns its folder when that folder needs a watch.
    pub fn add(&mut self, file: &Path) -> Option<PathBuf> {
        let count = self.files.entry(file.to_path_buf()).or_default();
        *count += 1;
        if *count > 1 {
            return None;
        }
        let folder = file.parent()?.to_path_buf();
        let count = self.folders.entry(folder.clone()).or_default();
        *count += 1;
        (*count == 1).then_some(folder)
    }

    /// Counts one fewer watcher of `file`; returns its folder when that folder's watch can end.
    pub fn remove(&mut self, file: &Path) -> Option<PathBuf> {
        let count = self.files.get_mut(file)?;
        *count -= 1;
        if *count > 0 {
            return None;
        }
        self.files.remove(file);
        let folder = file.parent()?.to_path_buf();
        let count = self.folders.get_mut(&folder)?;
        *count -= 1;
        if *count > 0 {
            return None;
        }
        self.folders.remove(&folder);
        Some(folder)
    }

    pub fn contains(&self, file: &Path) -> bool {
        self.files.contains_key(file)
    }
}

/// A watcher whose events, debounced, become one `emit` per changed file in `registry`. Other
/// files in a watched folder are ignored, and so are events that leave a file's mtime and size as
/// last reported: inotify reports opens and reads, so a reload's own read would trigger the next
/// one. The size is there because a coarse-mtime filesystem, or `cp -p`, can change a file
/// without moving its mtime.
/// The caller adds folders through `watcher()`.
pub fn debouncer(
    registry: Arc<Mutex<Registry>>,
    emit: impl Fn(DocumentChanged) + Send + 'static,
) -> notify::Result<Debouncer<RecommendedWatcher>> {
    let mut reported = HashMap::new();
    new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let paths: BTreeSet<PathBuf> = {
            let registry = registry.lock().unwrap_or_else(|e| e.into_inner());
            events
                .into_iter()
                .map(|e| e.path)
                .filter(|p| registry.contains(p))
                .collect()
        };
        for path in paths {
            let changed = DocumentChanged::of(&path);
            let stamp = (changed.mtime_ms, changed.size);
            if reported.insert(path, stamp) != Some(stamp) {
                emit(changed);
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify_debouncer_mini::notify::RecursiveMode;
    use std::fs;
    use std::sync::mpsc;
    use std::time::Instant;

    /// Budget for the core's share of `live_reload_ms <= 500`: from the write to the event.
    const CORE_BUDGET: Duration = Duration::from_millis(350);

    #[test]
    fn test_save_by_rename_and_delete_emit_document_changed() {
        let dir = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(dir.path()).unwrap();
        let doc = dir.join("a.md");
        fs::write(&doc, "# one").unwrap();
        let registry = Arc::new(Mutex::new(Registry::default()));
        let folder = registry.lock().unwrap().add(&doc).unwrap();
        let (tx, rx) = mpsc::channel();
        let mut debouncer = debouncer(registry, move |c| tx.send(c).unwrap()).unwrap();
        debouncer
            .watcher()
            .watch(&folder, RecursiveMode::NonRecursive)
            .unwrap();

        // An unwatched neighbour is not reported; the editor's rename over `a.md` is, once.
        let saved = Instant::now();
        fs::write(dir.join("other.md"), "x").unwrap();
        fs::write(dir.join(".a.md.swp"), "# two").unwrap();
        fs::rename(dir.join(".a.md.swp"), &doc).unwrap();
        let changed = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let elapsed = saved.elapsed();
        println!("live_reload_ms core share: {}", elapsed.as_millis());
        assert!(elapsed <= CORE_BUDGET, "{elapsed:?}");
        assert_eq!(changed.path, doc.display().to_string());
        assert!(changed.mtime_ms.is_some() && !changed.deleted);
        assert!(rx.recv_timeout(DEBOUNCE * 3).is_err());

        fs::remove_file(&doc).unwrap();
        let changed = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(changed.deleted && changed.mtime_ms.is_none());
    }

    #[test]
    fn test_change_that_keeps_the_mtime_but_not_the_size_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(dir.path()).unwrap();
        let doc = dir.join("a.md");
        fs::write(&doc, "# one").unwrap();
        let registry = Arc::new(Mutex::new(Registry::default()));
        let folder = registry.lock().unwrap().add(&doc).unwrap();
        let (tx, rx) = mpsc::channel();
        let mut debouncer = debouncer(registry, move |c| tx.send(c).unwrap()).unwrap();
        debouncer
            .watcher()
            .watch(&folder, RecursiveMode::NonRecursive)
            .unwrap();

        fs::write(&doc, "# two").unwrap();
        let first = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        // The next save lands in the same mtime tick (or restores it, as `cp -p` does).
        let mtime = fs::metadata(&doc).unwrap().modified().unwrap();
        fs::write(&doc, "# three, longer").unwrap();
        fs::File::options()
            .write(true)
            .open(&doc)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        let second = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(second.mtime_ms, first.mtime_ms);
        assert_ne!(second.size, first.size);
    }

    #[test]
    fn test_reading_a_watched_file_emits_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(dir.path()).unwrap();
        let doc = dir.join("a.md");
        fs::write(&doc, "# one").unwrap();
        let registry = Arc::new(Mutex::new(Registry::default()));
        let folder = registry.lock().unwrap().add(&doc).unwrap();
        let (tx, rx) = mpsc::channel();
        let mut debouncer = debouncer(registry, move |c| tx.send(c).unwrap()).unwrap();
        debouncer
            .watcher()
            .watch(&folder, RecursiveMode::NonRecursive)
            .unwrap();

        // A reload reads the file; if that read emitted, every reload would trigger the next.
        fs::write(&doc, "# two").unwrap();
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        fs::read(&doc).unwrap();
        assert!(rx.recv_timeout(DEBOUNCE * 3).is_err());
    }

    #[test]
    fn test_watch_is_reference_counted_per_path() {
        let mut reg = Registry::default();
        let a = Path::new("/n/a.md");
        let b = Path::new("/n/b.md");
        let dir = Some(PathBuf::from("/n"));

        assert_eq!(reg.add(a), dir);
        assert_eq!(reg.add(a), None);
        assert_eq!(reg.add(b), None);
        assert_eq!(reg.remove(a), None);
        assert!(reg.contains(a));
        assert_eq!(reg.remove(a), None);
        assert!(!reg.contains(a));
        assert_eq!(reg.remove(a), None);
        assert_eq!(reg.remove(b), dir);
        assert_eq!(reg.add(b), dir);
    }
}
