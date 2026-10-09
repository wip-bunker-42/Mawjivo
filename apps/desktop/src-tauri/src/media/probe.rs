use super::{MediaInfo, MediaTools, process};
use crate::contracts::AppError;
use image::{ImageDecoder, ImageFormat, ImageReader};
use serde_json::Value;
use std::{
    path::Path,
    process::Command,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
pub fn probe(tools: &MediaTools, path: &Path) -> Result<MediaInfo, AppError> {
    let bytes = std::fs::metadata(path)
        .map_err(|_| AppError::new("LOCAL_FILE", "الملف المحلي غير موجود."))?
        .len();
    if bytes == 0 || bytes > 9_000_000_000 {
        return Err(AppError::new(
            "MEDIA_SIZE",
            "الملف فارغ أو أكبر من 9 جيجابايت.",
        ));
    }
    if let Ok(reader) = ImageReader::open(path).and_then(|reader| reader.with_guessed_format()) {
        let format = reader.format();
        if let Ok(mut decoder) = reader.into_decoder() {
            let (mut width, mut height) = decoder.dimensions();
            use image::metadata::Orientation::*;
            if matches!(
                decoder.orientation().ok(),
                Some(Rotate90 | Rotate270 | Rotate90FlipH | Rotate270FlipH)
            ) {
                std::mem::swap(&mut width, &mut height);
            }
            validate_dimensions(width, height)?;
            let mime_type = match format {
                Some(ImageFormat::Jpeg) => "image/jpeg",
                Some(ImageFormat::Png) => "image/png",
                Some(ImageFormat::WebP) => "image/webp",
                Some(ImageFormat::Gif) => "image/gif",
                Some(ImageFormat::Bmp) => "image/bmp",
                Some(ImageFormat::Tiff) => "image/tiff",
                _ => "image/x-portable-anymap",
            };
            return Ok(MediaInfo {
                mime_type: mime_type.into(),
                bytes,
                width,
                height,
                duration_ms: None,
                quality: None,
            });
        }
    }
    let mut command = Command::new(&tools.ffprobe);
    command.args(["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", process::FORMATS, "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height:stream_side_data=rotation", "-of", "json"]).arg(path);
    let json = process::run(
        &mut command,
        Arc::new(AtomicBool::new(false)),
        Duration::from_secs(45),
        true,
    )?;
    let value: Value = serde_json::from_slice(&json)
        .map_err(|_| AppError::new("MEDIA_METADATA", "تعذر فحص بيانات الملف."))?;
    let stream = value["streams"]
        .as_array()
        .and_then(|streams| streams.iter().find(|s| s["codec_type"] == "video"))
        .ok_or_else(|| AppError::new("MEDIA_UNSUPPORTED", "اختر صورة أو فيديو صالحًا."))?;
    let mut width = stream["width"].as_u64().unwrap_or(0) as u32;
    let mut height = stream["height"].as_u64().unwrap_or(0) as u32;
    let rotation = stream["side_data_list"]
        .as_array()
        .and_then(|data| data.iter().find_map(|item| item["rotation"].as_i64()))
        .unwrap_or(0);
    if rotation.unsigned_abs() % 180 == 90 {
        std::mem::swap(&mut width, &mut height);
    }
    validate_dimensions(width, height)?;
    let mut header = [0_u8; 4096];
    use std::io::Read;
    let _ = std::fs::File::open(path).and_then(|mut file| file.read(&mut header));
    let brand = &header[8..12];
    let format = value["format"]["format_name"].as_str().unwrap_or("");
    let image_mime = if [b"avif".as_slice(), b"avis"].contains(&brand) {
        Some("image/avif")
    } else if [
        b"heic".as_slice(),
        b"heix",
        b"hevc",
        b"hevx",
        b"mif1",
        b"msf1",
    ]
    .contains(&brand)
    {
        Some("image/heic")
    } else if format == "jxl_pipe" {
        Some("image/jxl")
    } else {
        None
    };
    let duration_ms = if image_mime.is_some() {
        None
    } else {
        let seconds = value["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| n.is_finite() && *n > 0.0 && *n <= 86400.0)
            .ok_or_else(|| AppError::new("MEDIA_DURATION", "تعذر تحديد مدة الفيديو."))?;
        Some((seconds * 1000.0).ceil() as u64)
    };
    let mime_type = image_mime.unwrap_or_else(|| {
        if format.contains("matroska") {
            if header.windows(4).any(|bytes| bytes == b"webm") {
                "video/webm"
            } else {
                "video/x-matroska"
            }
        } else if format.contains("avi") {
            "video/x-msvideo"
        } else if format.contains("mpeg") && !format.contains("mov") {
            "video/mpeg"
        } else if brand == b"qt  " {
            "video/quicktime"
        } else if format.contains("flv") {
            "video/x-flv"
        } else if format.contains("asf") {
            "video/x-ms-asf"
        } else {
            "video/mp4"
        }
    });
    Ok(MediaInfo {
        mime_type: mime_type.into(),
        bytes,
        width,
        height,
        duration_ms,
        quality: None,
    })
}
pub(crate) fn validate_dimensions(width: u32, height: u32) -> Result<(), AppError> {
    if width == 0
        || height == 0
        || width > 16384
        || height > 16384
        || u64::from(width) * u64::from(height) > 100_000_000
    {
        return Err(AppError::new(
            "MEDIA_DIMENSIONS",
            "أبعاد الملف أكبر من الحد الآمن للمعالجة.",
        ));
    }
    Ok(())
}
