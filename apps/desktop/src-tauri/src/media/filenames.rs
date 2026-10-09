use unicode_segmentation::UnicodeSegmentation;
// Transport name only; the source file is never renamed.
pub fn sent_video_name(title: &str, mime: &str) -> String {
    let extension = match mime {
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "video/x-msvideo" => "avi",
        "video/mpeg" => "mpeg",
        _ => "mp4",
    };
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let mut stem = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    stem = stem.trim_end_matches(['.', ' ']).to_owned();
    if stem.is_empty() {
        stem = "فيديو".into();
    }
    let device = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&device.as_str())
        || (device.len() == 4
            && (device.starts_with("COM") || device.starts_with("LPT"))
            && matches!(device.as_bytes()[3], b'1'..=b'9'))
    {
        stem = format!("فيديو-{stem}");
    }
    let budget = 180 - extension.len() - 1;
    let mut count = 0;
    stem = stem
        .graphemes(true)
        .take_while(|part| {
            count += part.encode_utf16().count();
            count <= budget
        })
        .collect();
    format!("{}.{extension}", stem.trim_end_matches(['.', ' ']))
}
