//! File › Export (D-20): the page printed with its print styling straight to a PDF file; File ›
//! Print uses the same page.

use crate::error::{ErrorKind, IpcError};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::{Runtime, WebviewWindow};

/// What a link printed to PDF does: opens `uri`, or goes to mark number `to`. A mark with neither
/// is only somewhere to go to.
#[derive(Deserialize)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct Mark {
    pub uri: Option<String>,
    pub to: Option<usize>,
}

/// The Save dialog's answer, with `.pdf` added when the user typed a name without it.
pub fn with_pdf_extension(path: PathBuf) -> PathBuf {
    if is_pdf(&path) {
        return path;
    }
    let mut name = path.into_os_string();
    name.push(".pdf");
    name.into()
}

fn is_pdf(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// Only the Save dialog's last answer may be written, and only as a PDF.
pub fn target(picked: Option<PathBuf>, path: &str) -> Result<PathBuf, IpcError> {
    let path = PathBuf::from(path);
    if !is_pdf(&path) || picked.as_ref() != Some(&path) {
        return Err(IpcError::new(
            ErrorKind::NotPermitted,
            format!("{} was not chosen in the Export dialog", path.display()),
        ));
    }
    Ok(path)
}

/// WebKitGTK's print operation with "Print to File" settings: no dialog, the same page Print
/// shows. Returns once the file is written.
/// The margin on every side of a printed page, matching print.css's `@page`.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const PAGE_MARGIN_MM: f64 = 20.0;

/// Where a print goes: a PDF file, or the system print dialog.
#[cfg(target_os = "linux")]
enum Output<'a> {
    Pdf(&'a Path),
    Dialog,
}

pub fn print_to_pdf<R: Runtime>(
    window: &WebviewWindow<R>,
    path: &Path,
    marks: &[Mark],
) -> Result<(), IpcError> {
    #[cfg(target_os = "linux")]
    {
        print(window, Output::Pdf(path))?;
        // The PDF is good without its links, so a failure here does not fail the export.
        if let Err(e) = crate::pdf_links::add(path, marks) {
            eprintln!("no links in {}: {e}", path.display());
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = marks;
        print_macos(window, path)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (window, path, marks);
        Err(IpcError::new(
            ErrorKind::Io,
            "PDF export is not available on this system yet",
        ))
    }
}

/// File › Print with the same page as Export. `false` where the frontend's own print stays in use.
pub fn print_dialog<R: Runtime>(window: &WebviewWindow<R>) -> Result<bool, IpcError> {
    #[cfg(target_os = "linux")]
    return print(window, Output::Dialog).map(|()| true);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        Ok(false)
    }
}

/// One print operation for both: the same page setup, so the printout and the PDF match.
#[cfg(target_os = "linux")]
fn print<R: Runtime>(window: &WebviewWindow<R>, output: Output) -> Result<(), IpcError> {
    use gtk::prelude::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    use webkit2gtk::PrintOperationExt;

    let failed = |message: String| IpcError::new(ErrorKind::Io, message);
    let uri = match output {
        Output::Pdf(path) => Some(
            url::Url::from_file_path(path)
                .map_err(|()| failed(format!("{} is not an absolute path", path.display())))?
                .to_string(),
        ),
        Output::Dialog => None,
    };
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            // WebKitGTK ignores CSS @page margins, so the page gets them here (print.css keeps
            // its @page rule for the browsers that honour it).
            let setup = gtk::PageSetup::new();
            for set in [
                gtk::PageSetup::set_top_margin,
                gtk::PageSetup::set_bottom_margin,
                gtk::PageSetup::set_left_margin,
                gtk::PageSetup::set_right_margin,
            ] {
                set(&setup, PAGE_MARGIN_MM, gtk::Unit::Mm);
            }
            let view = webview.inner();
            let op = webkit2gtk::PrintOperation::new(&view);
            op.set_page_setup(&setup);
            let on_fail = tx.clone();
            op.connect_failed(move |_, err| {
                let _ = on_fail.send(Err(err.to_string()));
            });
            // The operation stays alive until it finishes; emptying the slot then frees it.
            let alive = Rc::new(RefCell::new(Some(op.clone())));
            let release = alive.clone();
            let on_done = tx.clone();
            op.connect_finished(move |_| {
                alive.borrow_mut().take();
                let _ = on_done.send(Ok(()));
            });
            match uri {
                Some(uri) => {
                    let settings = gtk::PrintSettings::new();
                    // GTK names its file printer in the desktop's language.
                    let printer = webkit2gtk::glib::dgettext(Some("gtk30"), "Print to File");
                    settings.set_printer(&printer);
                    settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
                    settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(&uri));
                    op.set_print_settings(&settings);
                    op.print();
                }
                None => {
                    let parent = view
                        .toplevel()
                        .and_then(|w| w.downcast::<gtk::Window>().ok());
                    // A cancelled dialog prints nothing and never emits `finished`.
                    if op.run_dialog(parent.as_ref()) == webkit2gtk::PrintOperationResponse::Cancel
                    {
                        release.borrow_mut().take();
                        let _ = tx.send(Ok(()));
                    }
                }
            }
        })
        .map_err(|e| failed(e.to_string()))?;
    // `failed` comes before `finished`, so the first message is the outcome.
    rx.recv()
        .map_err(|e| failed(e.to_string()))?
        .map_err(failed)
}

/// WKWebView's print operation as a save job to the chosen file (D-29): A4 portrait and paginated,
/// unlike `createPDF`, which makes one long page. Returns once the file is written.
#[cfg(target_os = "macos")]
fn print_macos<R: Runtime>(window: &WebviewWindow<R>, path: &Path) -> Result<(), IpcError> {
    use objc2::{rc::Retained, sel};
    use objc2_app_kit::{
        NSPaperOrientation, NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSWindow,
    };
    use objc2_foundation::{NSSize, NSURL};
    use objc2_web_kit::WKWebView;

    let failed = |message: String| IpcError::new(ErrorKind::Io, message);
    let file = path.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| unsafe {
            let Some(url) = NSURL::from_file_path(&file) else {
                let _ = tx.send(Err(format!("{} is not an absolute path", file.display())));
                return;
            };
            let view: &WKWebView = &*webview.inner().cast();
            let parent: &NSWindow = &*webview.ns_window().cast();
            let info = NSPrintInfo::new();
            // A4, in points.
            info.setPaperSize(NSSize::new(595.28, 841.89));
            let margin = PAGE_MARGIN_MM * 72.0 / 25.4;
            info.setTopMargin(margin);
            info.setBottomMargin(margin);
            info.setLeftMargin(margin);
            info.setRightMargin(margin);
            info.setOrientation(NSPaperOrientation::Portrait);
            info.setJobDisposition(NSPrintSaveJob);
            info.dictionary().insert(NSPrintJobSavingURL, &*url);
            let op = view.printOperationWithPrintInfo(&info);
            op.setShowsPrintPanel(false);
            op.setShowsProgressPanel(false);
            // The operation's view starts with no size, and then prints blank pages.
            if let Some(printed) = op.view() {
                printed.setFrame(view.bounds());
            }
            // The operation does not retain its delegate: it travels as the context and is
            // released in the callback.
            let done = Retained::into_raw(macos::ExportDone::new(tx));
            op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                parent,
                Some(&*done),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                done.cast(),
            );
        })
        .map_err(|e| failed(e.to_string()))?;
    rx.recv()
        .map_err(|e| failed(e.to_string()))?
        .map_err(failed)
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject};
    use objc2::{define_class, msg_send, AllocAnyThread, DeclaredClass};
    use objc2_app_kit::NSPrintOperation;
    use std::ffi::c_void;
    use std::sync::mpsc::Sender;

    define_class!(
        /// Reports the end of a print operation to the waiting `print_to_pdf`.
        #[unsafe(super(NSObject))]
        #[ivars = Sender<Result<(), String>>]
        pub struct ExportDone;

        impl ExportDone {
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn did_run(&self, _: &NSPrintOperation, success: Bool, context: *mut c_void) {
                let _ = self.ivars().send(if success.as_bool() {
                    Ok(())
                } else {
                    Err("the PDF could not be written".into())
                });
                // SAFETY: `context` is the `Retained::into_raw` of this object.
                let this = unsafe { Retained::from_raw(context.cast::<Self>()) };
                let _ = this.map(Retained::autorelease_ptr);
            }
        }
    );

    impl ExportDone {
        pub fn new(tx: Sender<Result<(), String>>) -> Retained<Self> {
            let this = Self::alloc().set_ivars(tx);
            unsafe { msg_send![super(this), init] }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_export_rejects_a_path_without_pdf() {
        let picked = Some(PathBuf::from("/out/notes.txt"));
        let err = target(picked, "/out/notes.txt").unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotPermitted);
    }

    #[test]
    fn test_export_writes_only_the_dialogs_answer() {
        let picked = || Some(PathBuf::from("/out/notes.pdf"));
        assert_eq!(
            target(picked(), "/out/notes.pdf").unwrap(),
            PathBuf::from("/out/notes.pdf")
        );
        assert!(target(picked(), "/etc/other.pdf").is_err());
        assert!(target(None, "/out/notes.pdf").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_export_target_rules_hold_on_macos() {
        let picked = || Some(PathBuf::from("/Users/me/notes.pdf"));
        assert!(target(picked(), "/Users/me/notes.pdf").is_ok());
        assert!(target(picked(), "/Users/me/other.pdf").is_err());
        assert!(target(
            Some(PathBuf::from("/Users/me/notes.PDF")),
            "/Users/me/notes.PDF"
        )
        .is_ok());
        assert_eq!(
            with_pdf_extension(PathBuf::from("/Users/me/notes")),
            PathBuf::from("/Users/me/notes.pdf")
        );
    }

    #[test]
    fn test_export_adds_pdf_to_a_bare_name() {
        let add = |p: &str| with_pdf_extension(PathBuf::from(p));
        assert_eq!(add("/out/notes"), PathBuf::from("/out/notes.pdf"));
        assert_eq!(add("/out/my.notes"), PathBuf::from("/out/my.notes.pdf"));
        assert_eq!(add("/out/a.PDF"), PathBuf::from("/out/a.PDF"));
    }
}
