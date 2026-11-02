//! WebKitGTK writes no links into a PDF. So `markForPdf` (ui/links.ts) gives each link and link
//! target a background too faint to see, with its index as the colour; here those boxes are found
//! on the printed pages and real links go over them. Page content is left as WebKit wrote it.

use lopdf::content::Content;
use lopdf::{dictionary, Document, Object, ObjectId, Result};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

type Rect = [f32; 4];

/// Adds the marks' links to the PDF at `path`.
pub fn add(path: &Path, marks: &[crate::export::Mark]) -> Result<()> {
    let mut doc = Document::load(path)?;
    let mut boxes: Vec<Vec<(ObjectId, Rect)>> = vec![vec![]; marks.len()];
    for page in doc.get_pages().into_values() {
        for (index, rect) in marked_boxes(&doc.get_and_decode_page_content(page)?) {
            if let Some(found) = boxes.get_mut(index) {
                found.push((page, rect));
            }
        }
    }
    let mut links: BTreeMap<ObjectId, Vec<Object>> = BTreeMap::new();
    for (mark, found) in marks.iter().zip(&boxes) {
        let action = if let Some(uri) = &mark.uri {
            let action = dictionary! {
                "S" => "URI",
                "URI" => Object::string_literal(uri.as_str()),
            };
            ("A", Object::Dictionary(action))
        } else if let Some(&(page, rect)) = mark.to.and_then(|to| boxes.get(to)?.first()) {
            let place = [
                page.into(),
                "XYZ".into(),
                rect[0].into(),
                rect[3].into(),
                Object::Null,
            ];
            ("Dest", Object::Array(place.into()))
        } else {
            continue;
        };
        for &(page, rect) in found {
            let mut link = dictionary! {
                "Type" => "Annot",
                "Subtype" => "Link",
                "Rect" => rect.map(Object::Real).to_vec(),
                "Border" => vec![0.into(), 0.into(), 0.into()],
            };
            link.set(action.0, action.1.clone());
            links.entry(page).or_default().push(link.into());
        }
    }
    if links.is_empty() {
        return Ok(());
    }
    for (page, list) in links {
        doc.get_object_mut(page)?.as_dict_mut()?.set("Annots", list);
    }
    let mut bytes = vec![];
    doc.save_to(&mut bytes)?;
    // Beside the file and renamed over it, so a failed write leaves the PDF as it was.
    let staging = path.with_extension("pdf.tmp");
    fs::write(&staging, bytes)?;
    fs::rename(&staging, path)?;
    Ok(())
}

/// The mark index a fill colour stands for: red 1/255, the index in green and blue.
fn mark_index([red, green, blue]: [f32; 3]) -> Option<usize> {
    let byte = |v: f32| (v * 255.0).round() as usize;
    (byte(red) == 1).then(|| byte(green) * 256 + byte(blue))
}

fn multiply([a, b, c, d, e, f]: [f32; 6], m: [f32; 6]) -> [f32; 6] {
    [
        a * m[0] + b * m[2],
        a * m[1] + b * m[3],
        c * m[0] + d * m[2],
        c * m[1] + d * m[3],
        e * m[0] + f * m[2] + m[4],
        e * m[1] + f * m[3] + m[5],
    ]
}

/// A path rectangle as it lands on the page, as [left, bottom, right, top].
fn on_page([a, b, c, d, e, f]: [f32; 6], [x0, y0, x1, y1]: Rect) -> Rect {
    let (ax, ay) = (a * x0 + c * y0 + e, b * x0 + d * y0 + f);
    let (bx, by) = (a * x1 + c * y1 + e, b * x1 + d * y1 + f);
    [ax.min(bx), ay.min(by), ax.max(bx), ay.max(by)]
}

fn overlap(a: Rect, b: Rect) -> Rect {
    [
        a[0].max(b[0]),
        a[1].max(b[1]),
        a[2].min(b[2]),
        a[3].min(b[3]),
    ]
}

/// Every rectangle filled in a mark's colour and visible, as (index, rectangle) on the page. A box
/// on a page break is drawn on both pages; each page's clip keeps the part that shows there.
/// ponytail: a page's own fill of exactly rgb(1, g, b) reads as a mark, at worst one stray link.
fn marked_boxes(content: &Content) -> Vec<(usize, Rect)> {
    let mut found = vec![];
    let mut matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    let mut color = [0.0; 3];
    let mut clip = [f32::MIN, f32::MIN, f32::MAX, f32::MAX];
    let mut saved = vec![];
    let mut path = None;
    for op in &content.operations {
        let numbers: Vec<f32> = op
            .operands
            .iter()
            .filter_map(|o| o.as_float().ok())
            .collect();
        match (op.operator.as_str(), numbers.as_slice()) {
            ("q", _) => saved.push((matrix, color, clip)),
            ("Q", _) => (matrix, color, clip) = saved.pop().unwrap_or((matrix, color, clip)),
            ("cm", &[a, b, c, d, e, f]) => matrix = multiply([a, b, c, d, e, f], matrix),
            ("rg", &[r, g, b]) => color = [r, g, b],
            ("re", &[x, y, w, h]) => path = Some([x, y, x + w, y + h]),
            ("W" | "W*", _) => {
                if let Some(rect) = path {
                    clip = overlap(clip, on_page(matrix, rect));
                }
            }
            ("n", _) => path = None,
            ("f", _) => {
                if let (Some(rect), Some(index)) = (path.take(), mark_index(color)) {
                    let shown = overlap(clip, on_page(matrix, rect));
                    if shown[0] < shown[2] && shown[1] < shown[3] {
                        found.push((index, shown));
                    }
                }
            }
            _ => {}
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::Mark;
    use lopdf::{Dictionary, Stream};

    /// Two pages as WebKit prints them: y flipped, clipped to the printed area, then scaled, the
    /// marks among other fills. Mark 3 sits below page one's clip, so it is really on page two.
    const PAGES: [&str; 2] = [
        "1 0 0 -1 0 800 cm 0 0 600 700 re W* n q .5 0 0 .5 10 20 cm 1 1 1 rg 0 0 600 800 re f Q \
         q .5 0 0 .5 10 20 cm .0039 0 .0078 rg 20 40 100 10 re f 0 0 1 rg 20 49 100 1 re f Q \
         q .0039 0 .0118 rg 30 700 200 20 re f Q",
        "1 0 0 -1 0 800 cm 0 0 600 700 re W* n \
         q .0039 0 .0118 rg 30 50 200 20 re f Q 0 0 1 rg 0 0 9 9 re f",
    ];

    fn pdf(path: &Path) {
        let mut doc = Document::with_version("1.4");
        let pages = doc.new_object_id();
        let kids: Vec<Object> = PAGES
            .iter()
            .map(|text| {
                let contents = Stream::new(Dictionary::new(), text.as_bytes().to_vec());
                let contents = doc.add_object(contents);
                let page = dictionary! {
                    "Type" => "Page",
                    "Parent" => pages,
                    "Contents" => contents,
                    "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()],
                };
                doc.add_object(page).into()
            })
            .collect();
        let tree = dictionary! { "Type" => "Pages", "Count" => 2, "Kids" => kids };
        doc.objects.insert(pages, tree.into());
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        doc.save(path).unwrap();
    }

    fn annots(doc: &Document, page: ObjectId) -> Vec<Dictionary> {
        let Ok(list) = doc.get_dictionary(page).unwrap().get(b"Annots") else {
            return vec![];
        };
        let list = list.as_array().unwrap();
        list.iter().map(|o| o.as_dict().unwrap().clone()).collect()
    }

    fn numbers(dict: &Dictionary, key: &[u8]) -> Vec<f32> {
        let list = dict.get(key).unwrap().as_array().unwrap();
        list.iter().filter_map(|o| o.as_float().ok()).collect()
    }

    #[test]
    fn test_pdf_links_land_on_their_boxes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.pdf");
        pdf(&path);
        let uri = Some("https://example.com/a".to_string());
        let marks = [
            Mark {
                uri: None,
                to: None,
            },
            Mark { uri, to: None },
            Mark {
                uri: None,
                to: Some(3),
            },
            Mark {
                uri: None,
                to: None,
            },
        ];
        // Mark 2 goes to mark 3 on page two; mark 1 has no box, so it has no link.
        add(&path, &marks[..]).unwrap();
        let doc = Document::load(&path).unwrap();
        let pages: Vec<_> = doc.get_pages().into_values().collect();
        let first = annots(&doc, pages[0]);
        assert_eq!(first.len(), 1);
        assert_eq!(numbers(&first[0], b"Rect"), [20.0, 755.0, 70.0, 760.0]);
        let dest = first[0].get(b"Dest").unwrap().as_array().unwrap();
        assert_eq!(dest[0].as_reference().unwrap(), pages[1]);
        assert_eq!(dest[2].as_float().unwrap(), 30.0);
        assert_eq!(dest[3].as_float().unwrap(), 750.0);
        assert!(annots(&doc, pages[1]).is_empty());
    }

    #[test]
    fn test_pdf_links_open_their_address() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.pdf");
        pdf(&path);
        let uri = |u: &str| Mark {
            uri: Some(u.to_string()),
            to: None,
        };
        add(&path, &[uri("a"), uri("b"), uri("https://example.com/a")]).unwrap();
        let doc = Document::load(&path).unwrap();
        let pages: Vec<_> = doc.get_pages().into_values().collect();
        let first = annots(&doc, pages[0]);
        let action = first[0].get(b"A").unwrap().as_dict().unwrap();
        let address = action.get(b"URI").unwrap().as_str().unwrap();
        assert_eq!(address, b"https://example.com/a");
        assert_eq!(annots(&doc, pages[1]).len(), 0);
    }

    #[test]
    fn test_pdf_without_marks_stays_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.pdf");
        pdf(&path);
        let before = fs::read(&path).unwrap();
        add(&path, &[]).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}
