use super::{MediaInfo, MediaTools, hash_file, probe, process};
use crate::contracts::{AppError, MediaRecipe};
use image::{
    DynamicImage, ImageDecoder, ImageEncoder, ImageReader, Rgb, RgbImage,
    codecs::jpeg::JpegEncoder,
    imageops::{self, FilterType},
};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

pub struct TransformRequest<'a> {
    pub source: &'a Path,
    pub output: &'a Path,
    pub recipe: &'a MediaRecipe,
    pub cancel: Arc<AtomicBool>,
    pub available_bytes: u64,
}
struct Partial<'a>(&'a Path, bool);
impl Drop for Partial<'_> {
    fn drop(&mut self) {
        if !self.1 {
            let _ = fs::remove_file(self.0);
        }
    }
}
fn cancelled(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        Err(AppError::new("MEDIA_CANCELLED", "أُلغيت معالجة الوسائط."))
    } else {
        Ok(())
    }
}
pub fn transform(tools: &MediaTools, request: TransformRequest<'_>) -> Result<MediaInfo, AppError> {
    cancelled(&request.cancel)?;
    if request.output.exists() || request.source == request.output {
        return Err(AppError::new("MEDIA_OUTPUT", "ملف المعالجة موجود مسبقًا."));
    }
    let metadata = probe(tools, request.source)?;
    let budget = request
        .recipe
        .max_bytes
        .unwrap_or(9_000_000_000)
        .min(9_000_000_000);
    if budget == 0 {
        return Err(AppError::new("MEDIA_LIMIT", "حد حجم الملف غير صالح."));
    }
    let estimated = if request.recipe.output_mime_type == "image/jpeg" {
        u64::from(metadata.width) * u64::from(metadata.height) * 4 + budget.min(50_000_000)
    } else {
        // Reserve for the encoded output and faststart's temporary rewrite, not the compressed input size.
        metadata
            .duration_ms
            .unwrap_or(0)
            .min(request.recipe.max_duration_ms.unwrap_or(u64::MAX))
            .saturating_mul(25_128_000)
            .checked_div(8000)
            .unwrap_or(u64::MAX)
            .min(budget)
            .saturating_mul(2)
    };
    if request.available_bytes < estimated.saturating_add(16_777_216) {
        return Err(AppError::new(
            "LOCAL_DISK_FULL",
            "المساحة المحلية لا تكفي لمعالجة هذا الملف.",
        ));
    }
    let before = hash_file(request.source)?;
    // Reserve the path before arming cleanup, so cleanup never removes another writer's file.
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(request.output)
        .map_err(|_| AppError::new("MEDIA_OUTPUT", "تعذر إنشاء ملف المعالجة."))?;
    let mut partial = Partial(request.output, false);
    let mut info = match request.recipe.output_mime_type.as_str() {
        "image/jpeg" if metadata.duration_ms.is_none() => {
            prepare_image(tools, &request, &metadata)?
        }
        "video/mp4" if metadata.duration_ms.is_some() => prepare_video(tools, &request, &metadata)?,
        _ => return Err(AppError::new("MEDIA_RECIPE", "خطة معالجة الملف غير صالحة.")),
    };
    cancelled(&request.cancel)?;
    if hash_file(request.source)? != before {
        return Err(AppError::new(
            "LOCAL_FILE_CHANGED",
            "تغير الملف الأصلي أثناء المعالجة؛ اختره مجددًا.",
        ));
    }
    info.bytes = fs::metadata(request.output)
        .map_err(|_| AppError::new("MEDIA_OUTPUT", "تعذر قراءة ناتج المعالجة."))?
        .len();
    verify_output(&info, request.recipe)?;
    partial.1 = true;
    Ok(info)
}
fn verify_output(info: &MediaInfo, recipe: &MediaRecipe) -> Result<(), AppError> {
    let ratio = f64::from(info.width) / f64::from(info.height);
    if recipe.max_bytes.is_some_and(|n| info.bytes > n)
        || recipe
            .max_duration_ms
            .zip(info.duration_ms)
            .is_some_and(|(max, n)| n > max)
        || recipe.min_width.is_some_and(|n| info.width < n)
        || recipe.max_width.is_some_and(|n| info.width > n)
        || recipe.min_height.is_some_and(|n| info.height < n)
        || recipe.max_height.is_some_and(|n| info.height > n)
        || recipe.min_aspect_ratio.is_some_and(|n| ratio + 1e-9 < n)
        || recipe.max_aspect_ratio.is_some_and(|n| ratio - 1e-9 > n)
    {
        return Err(AppError::new(
            "MEDIA_LIMIT",
            "تعذر إنتاج ملف يلائم حدود المنصة.",
        ));
    }
    Ok(())
}
// Choose integer dimensions within the bounds, retaining the whole source inside the canvas.
fn canvas(
    width: u32,
    height: u32,
    recipe: &MediaRecipe,
    even: bool,
) -> Result<(u32, u32), AppError> {
    let minimum = recipe.min_aspect_ratio.unwrap_or(0.01);
    let maximum = recipe.max_aspect_ratio.unwrap_or(100.0);
    if !minimum.is_finite() || !maximum.is_finite() || minimum <= 0.0 || maximum < minimum {
        return Err(AppError::new("MEDIA_RECIPE", "حدود أبعاد الملف غير صالحة."));
    }
    let target = (f64::from(width) / f64::from(height)).clamp(minimum, maximum);
    let min_w = recipe.min_width.unwrap_or(1).max(1);
    let max_w = recipe.max_width.unwrap_or(8192).min(16384);
    let min_h = recipe.min_height.unwrap_or(1).max(1);
    let max_h = recipe.max_height.unwrap_or(8192).min(16384);
    let wanted = f64::from(width)
        .max(f64::from(min_w))
        .max(f64::from(min_h) * target)
        .min(f64::from(max_w))
        .min(f64::from(max_h) * target);
    let mut best: Option<(f64, u32, u32)> = None;
    for w in min_w..=max_w {
        if even && !w.is_multiple_of(2) {
            continue;
        }
        let lower = ((f64::from(w) / maximum - 1e-9).ceil() as u32).max(min_h);
        let upper = ((f64::from(w) / minimum + 1e-9).floor() as u32).min(max_h);
        if lower > upper {
            continue;
        }
        let mut h = (f64::from(w) / target).round() as u32;
        h = h.clamp(lower, upper);
        if even && !h.is_multiple_of(2) {
            h = if h < upper {
                h + 1
            } else {
                h.saturating_sub(1)
            };
        }
        if h < lower || h == 0 || u64::from(w) * u64::from(h) > 100_000_000 {
            continue;
        }
        let score =
            (f64::from(w) / wanted).ln().abs() + (f64::from(w) / f64::from(h) / target).ln().abs();
        if best.as_ref().is_none_or(|old| score < old.0) {
            best = Some((score, w, h));
        }
    }
    best.map(|(_, w, h)| (w, h))
        .ok_or_else(|| AppError::new("MEDIA_RECIPE", "لا توجد أبعاد صالحة لحدود هذه المنصة."))
}
fn load_image(path: &Path) -> Result<(DynamicImage, Option<Vec<u8>>), AppError> {
    let mut reader = ImageReader::open(path)
        .and_then(|r| r.with_guessed_format())
        .map_err(|_| AppError::new("MEDIA_IMAGE", "تعذر قراءة الصورة."))?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(512_000_000);
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| AppError::new("MEDIA_IMAGE", "تعذر فك ترميز الصورة."))?;
    let orientation = decoder
        .orientation()
        .map_err(|_| AppError::new("MEDIA_IMAGE", "تعذر قراءة اتجاه الصورة."))?;
    let icc = decoder
        .icc_profile()
        .map_err(|_| AppError::new("MEDIA_IMAGE", "تعذر قراءة ألوان الصورة."))?;
    if icc.as_ref().is_some_and(|p| p.len() > 4_000_000) {
        return Err(AppError::new(
            "MEDIA_COLOR",
            "ملف ألوان الصورة أكبر من الحد الآمن.",
        ));
    }
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|_| AppError::new("MEDIA_IMAGE", "تعذر فك ترميز الصورة."))?;
    image.apply_orientation(orientation);
    if icc.is_none() {
        image
            .convert_color_space(
                image::metadata::Cicp::SRGB,
                Default::default(),
                image::ColorType::Rgba8,
            )
            .map_err(|_| AppError::new("MEDIA_COLOR", "تعذر تحويل ألوان هذه الصورة بأمان."))?;
    }
    Ok((image, icc))
}
fn prepare_image(
    tools: &MediaTools,
    request: &TransformRequest<'_>,
    metadata: &MediaInfo,
) -> Result<MediaInfo, AppError> {
    let temporary = request
        .output
        .with_file_name(format!("decode-{}.png", uuid::Uuid::new_v4()));
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| AppError::new("MEDIA_OUTPUT", "تعذر إنشاء ملف تحويل الصورة."))?;
    let _decoded_guard = Partial(&temporary, false);
    let decoded = match load_image(request.source) {
        Ok(value) => value,
        Err(_) => {
            let mut command = Command::new(&tools.ffmpeg);
            command
                .args([
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-nostdin",
                    "-protocol_whitelist",
                    "file,pipe",
                    "-format_whitelist",
                    process::FORMATS,
                    "-i",
                ])
                .arg(request.source)
                .args(["-frames:v", "1", "-update", "1", "-f", "image2"])
                .arg(&temporary);
            process::run(
                &mut command,
                request.cancel.clone(),
                Duration::from_secs(180),
                false,
            )?;
            load_image(&temporary)?
        }
    };
    cancelled(&request.cancel)?;
    let (width, height) = canvas(metadata.width, metadata.height, request.recipe, false)?;
    let rgba = decoded.0.to_rgba8();
    let rgb = RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let pixel = rgba.get_pixel(x, y);
        let a = u32::from(pixel[3]);
        Rgb([0, 1, 2].map(|i| ((u32::from(pixel[i]) * a + 255 * (255 - a) + 127) / 255) as u8))
    });
    let scale = (f64::from(width) / f64::from(rgb.width()))
        .min(f64::from(height) / f64::from(rgb.height()));
    let resized = imageops::resize(
        &rgb,
        (f64::from(rgb.width()) * scale).round().max(1.0) as u32,
        (f64::from(rgb.height()) * scale).round().max(1.0) as u32,
        FilterType::Lanczos3,
    );
    let mut canvas = RgbImage::from_pixel(width, height, Rgb([255; 3]));
    imageops::overlay(
        &mut canvas,
        &resized,
        i64::from((width - resized.width()) / 2),
        i64::from((height - resized.height()) / 2),
    );
    let limit = request.recipe.max_bytes.unwrap_or(9_000_000_000);
    let ceiling = request.recipe.quality.unwrap_or(95).clamp(1, 95);
    for quality in (1..=ceiling).rev() {
        cancelled(&request.cancel)?;
        let mut bytes = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut bytes, quality);
        if let Some(icc) = &decoded.1 {
            encoder
                .set_icc_profile(icc.clone())
                .map_err(|_| AppError::new("MEDIA_COLOR", "تعذر الاحتفاظ بألوان الصورة."))?;
        }
        encoder
            .encode_image(&canvas)
            .map_err(|_| AppError::new("MEDIA_IMAGE", "تعذر تحويل الصورة إلى JPEG."))?;
        if bytes.len() as u64 <= limit {
            let mut output = OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(request.output)
                .map_err(|_| AppError::new("MEDIA_OUTPUT", "تعذر إنشاء الصورة المعالجة."))?;
            output
                .write_all(&bytes)
                .and_then(|_| output.sync_all())
                .map_err(|_| {
                    AppError::new(
                        "LOCAL_DISK_FULL",
                        "تعذر حفظ الصورة؛ تحقق من المساحة المحلية.",
                    )
                })?;
            return Ok(MediaInfo {
                mime_type: "image/jpeg".into(),
                bytes: bytes.len() as u64,
                width,
                height,
                duration_ms: None,
                quality: Some(quality),
            });
        }
    }
    Err(AppError::new(
        "MEDIA_LIMIT",
        "حجم الصورة لا يلائم حد المنصة حتى بعد التحويل.",
    ))
}
fn prepare_video(
    tools: &MediaTools,
    request: &TransformRequest<'_>,
    metadata: &MediaInfo,
) -> Result<MediaInfo, AppError> {
    let (width, height) = canvas(metadata.width, metadata.height, request.recipe, true)?;
    let duration = metadata
        .duration_ms
        .unwrap_or(0)
        .min(request.recipe.max_duration_ms.unwrap_or(u64::MAX));
    if duration < 100 {
        return Err(AppError::new(
            "MEDIA_DURATION",
            "مدة الفيديو غير صالحة للمعالجة.",
        ));
    }
    let frames = duration * 30 / 1000;
    let limit = request.recipe.max_bytes.unwrap_or(9_000_000_000);
    let audio_bitrate = 128_000_u64;
    let mut bitrate = (limit.saturating_mul(8).saturating_mul(1000) / duration * 9 / 10)
        .saturating_sub(audio_bitrate)
        .min(25_000_000);
    for attempt in 0..3 {
        cancelled(&request.cancel)?;
        if bitrate < 64_000 {
            return Err(AppError::new(
                "MEDIA_LIMIT",
                "حد الحجم لا يكفي لهذا الفيديو.",
            ));
        }
        if attempt > 0 {
            fs::remove_file(request.output)
                .map_err(|_| AppError::new("MEDIA_OUTPUT", "تعذر إعادة معالجة الفيديو."))?;
        }
        let filter = format!(
            "fps=30,scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p"
        );
        // Audio is trimmed to the same frame boundary; AAC encoder padding is verified afterward.
        let seconds = format!("{:.6}", frames as f64 / 30.0);
        let mut command = Command::new(&tools.ffmpeg);
        command
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-protocol_whitelist",
                "file,pipe",
                "-format_whitelist",
                process::FORMATS,
                "-i",
            ])
            .arg(request.source)
            .args([
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-map_metadata",
                "-1",
                "-vf",
                &filter,
                "-c:v",
                "libopenh264",
                "-profile:v",
                "high",
                "-rc_mode",
                "bitrate",
                "-b:v",
                &bitrate.to_string(),
                "-maxrate",
                &bitrate.to_string(),
                "-frames:v",
                &frames.to_string(),
                "-t",
                &seconds,
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-ar",
                "48000",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
            ])
            .arg(request.output);
        process::run(
            &mut command,
            request.cancel.clone(),
            Duration::from_secs((duration / 1000 * 20).clamp(180, 43200)),
            false,
        )?;
        let info = probe(tools, request.output)?;
        if info.bytes <= limit && info.duration_ms.is_some_and(|n| n <= duration) {
            return Ok(info);
        }
        if info.duration_ms.is_some_and(|n| n > duration) {
            return Err(AppError::new(
                "MEDIA_DURATION",
                "تجاوز ناتج القص الحد الزمني للمنصة.",
            ));
        }
        bitrate = bitrate * 7 / 10;
    }
    Err(AppError::new(
        "MEDIA_LIMIT",
        "تعذر إنتاج فيديو يلائم حد الحجم.",
    ))
}
