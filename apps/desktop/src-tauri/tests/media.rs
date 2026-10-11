use image::{Rgb, RgbImage};
use mawjivo_lib::{
    contracts::MediaRecipe,
    media::{MediaTools, TransformRequest, hash_file, probe, sent_video_name, transform},
};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
fn tools() -> MediaTools {
    MediaTools::from_directory(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("media-tools"))
}
fn image_fixture(path: &Path) {
    let img = RgbImage::from_fn(320, 180, |x, _| {
        if x < 15 {
            Rgb([255, 0, 0])
        } else if x > 304 {
            Rgb([0, 255, 0])
        } else {
            Rgb([25, 75, 200])
        }
    });
    img.save(path).unwrap();
}
fn recipe(mime: &str) -> MediaRecipe {
    serde_json::from_value(serde_json::json!({"id":"recipe-synthetic","sourceAssetId":"source","outputMimeType":mime,"maxBytes":8000000,"quality":95})).unwrap()
}
fn request<'a>(
    source: &'a Path,
    output: &'a Path,
    recipe: &'a MediaRecipe,
    cancel: Arc<AtomicBool>,
    available_bytes: u64,
) -> TransformRequest<'a> {
    TransformRequest {
        source,
        output,
        recipe,
        cancel,
        available_bytes,
    }
}
#[test]
fn png_to_jpeg_keeps_basename_and_highest_fitting_quality() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("صورتي العربية.png");
    image_fixture(&source);
    let output = temp.path().join("صورتي العربية.jpg");
    let before = hash_file(&source).unwrap();
    let info = transform(
        &tools(),
        request(
            &source,
            &output,
            &recipe("image/jpeg"),
            Arc::new(AtomicBool::new(false)),
            u64::MAX,
        ),
    )
    .unwrap();
    assert_eq!(info.mime_type, "image/jpeg");
    assert_eq!(output.file_stem(), source.file_stem());
    assert!(info.bytes <= 8_000_000);
    assert_eq!(info.quality, Some(95));
    assert_eq!(before, hash_file(&source).unwrap());
    assert_eq!(probe(&tools(), &output).unwrap().mime_type, "image/jpeg");
}
#[test]
fn avif_and_jpegxl_convert_locally_preserving_basename_and_source() {
    let temp = tempfile::tempdir().unwrap();
    for (extension, mime) in [("avif", "image/avif"), ("jxl", "image/jxl")] {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/fixtures/media")
            .join(format!("blue.{extension}"));
        let source = temp.path().join(format!("صورتي.{extension}"));
        std::fs::copy(fixture, &source).unwrap();
        let before = hash_file(&source).unwrap();
        assert_eq!(probe(&tools(), &source).unwrap().mime_type, mime);
        let output = temp.path().join(extension).join("صورتي.jpg");
        std::fs::create_dir_all(output.parent().unwrap()).unwrap();
        let info = transform(
            &tools(),
            request(
                &source,
                &output,
                &recipe("image/jpeg"),
                Arc::new(AtomicBool::new(false)),
                u64::MAX,
            ),
        )
        .unwrap();
        assert_eq!((info.width, info.height), (32, 24));
        assert_eq!(info.mime_type, "image/jpeg");
        assert_eq!(output.file_stem(), source.file_stem());
        assert_eq!(before, hash_file(&source).unwrap());
    }
}
#[test]
fn video_uses_title_without_renaming_source() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source.mp4");
    std::fs::write(&source, b"synthetic-original").unwrap();
    let hash = hash_file(&source).unwrap();
    assert_eq!(
        sent_video_name("عنوان فيديو: اختبار؟", "video/mp4"),
        "عنوان فيديو اختبار؟.mp4"
    );
    assert!(source.exists());
    assert_eq!(hash_file(&source).unwrap(), hash);
    let long = sent_video_name(&"👩🏽‍💻 عنوان ".repeat(100), "video/mp4");
    assert!(long.encode_utf16().count() <= 180);
    assert!(long.ends_with(".mp4"));
}
#[test]
fn portrait_padding_preserves_original_scene() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("edges.png");
    image_fixture(&source);
    let output = temp.path().join("edges.jpg");
    let mut limits = recipe("image/jpeg");
    limits.min_aspect_ratio = Some(9.0 / 16.0);
    limits.max_aspect_ratio = Some(9.0 / 16.0);
    limits.frame_mode = Some("pad".into());
    transform(
        &tools(),
        request(
            &source,
            &output,
            &limits,
            Arc::new(AtomicBool::new(false)),
            u64::MAX,
        ),
    )
    .unwrap();
    let img = image::open(&output).unwrap().to_rgb8();
    assert!((f64::from(img.width()) / f64::from(img.height()) - 9.0 / 16.0).abs() < 0.001);
    let center = img.height() / 2;
    assert!(img.get_pixel(5, center)[0] > 180);
    assert!(img.get_pixel(img.width() - 6, center)[1] > 180);
}
#[test]
fn no_space_and_cancel_preserve_source_and_remove_partial() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source.png");
    image_fixture(&source);
    let output = temp.path().join("partial.jpg");
    let error = transform(
        &tools(),
        request(
            &source,
            &output,
            &recipe("image/jpeg"),
            Arc::new(AtomicBool::new(false)),
            1,
        ),
    )
    .unwrap_err();
    assert_eq!(error.code, "LOCAL_DISK_FULL");
    assert!(source.exists());
    assert!(!output.exists());
    let cancel = Arc::new(AtomicBool::new(true));
    let error = transform(
        &tools(),
        request(&source, &output, &recipe("image/jpeg"), cancel, u64::MAX),
    )
    .unwrap_err();
    assert_eq!(error.code, "MEDIA_CANCELLED");
    assert!(source.exists());
    assert!(!output.exists());
}
#[test]
fn clip_takes_first_140000ms_or_180000ms() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source.mp4");
    let media = tools();
    let status = Command::new(&media.ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=128x72:rate=1:duration=185",
            "-c:v",
            "libopenh264",
            "-pix_fmt",
            "yuv420p",
            "-b:v",
            "128k",
        ])
        .arg(&source)
        .status()
        .unwrap();
    assert!(status.success());
    let before = hash_file(&source).unwrap();
    let cancellation = Arc::new(AtomicBool::new(false));
    let mut disk_limits = recipe("video/mp4");
    disk_limits.max_bytes = Some(20_000_000);
    let disk_output = temp.path().join("disk-check.mp4");
    assert_eq!(
        transform(
            &media,
            request(
                &source,
                &disk_output,
                &disk_limits,
                cancellation.clone(),
                50_000_000
            )
        )
        .unwrap_err()
        .code,
        "LOCAL_DISK_FULL"
    );
    for limit in [140_000, 180_000] {
        let output = temp.path().join(format!("first-{limit}.mp4"));
        let mut limits = recipe("video/mp4");
        limits.max_duration_ms = Some(limit);
        limits.max_bytes = Some(20_000_000);
        transform(
            &media,
            request(&source, &output, &limits, cancellation.clone(), u64::MAX),
        )
        .unwrap();
        let info = probe(&media, &output).unwrap();
        let duration = info.duration_ms.unwrap();
        assert!(duration <= limit, "{duration} exceeds {limit}");
        assert!(duration >= limit - 100);
        assert!(info.bytes <= 20_000_000);
    }
    assert_eq!(before, hash_file(&source).unwrap());
    cancellation.store(true, Ordering::Relaxed);
}
#[test]
fn file_handles_are_opaque_scoped_to_window_and_detect_source_changes() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("original.png");
    image_fixture(&source);
    let registry = mawjivo_lib::media::jobs::MediaRegistry::default();
    let id = registry.register("first", &source).unwrap();
    assert!(!id.contains("original"));
    assert_eq!(
        registry.file_for("first", &id).unwrap(),
        source.canonicalize().unwrap()
    );
    assert_eq!(
        registry.file_for("second", &id).unwrap_err().code,
        "LOCAL_FILE_SCOPE"
    );
    assert!(
        registry
            .file_for("first", &source.to_string_lossy())
            .is_err()
    );
    std::fs::write(&source, b"changed").unwrap();
    assert_eq!(
        registry.file_for("first", &id).unwrap_err().code,
        "LOCAL_FILE_CHANGED"
    );
}
#[test]
fn clip_with_audio_stays_within_frame_boundary() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("audio.mp4");
    let media = tools();
    let status = Command::new(&media.ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=128x72:rate=30:duration=3.4",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=3.4",
            "-c:v",
            "libopenh264",
            "-b:v",
            "128k",
            "-c:a",
            "aac",
        ])
        .arg(&source)
        .status()
        .unwrap();
    assert!(status.success());
    let mut limits = recipe("video/mp4");
    limits.max_duration_ms = Some(3001);
    let output = temp.path().join("clip.mp4");
    transform(
        &media,
        request(
            &source,
            &output,
            &limits,
            Arc::new(AtomicBool::new(false)),
            u64::MAX,
        ),
    )
    .unwrap();
    assert!(probe(&media, &output).unwrap().duration_ms.unwrap() <= 3001);
}
#[test]
fn jpeg_uses_highest_quality_that_fits_small_budget() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("noise.png");
    let img = RgbImage::from_fn(192, 108, |x, y| {
        Rgb([
            ((x * 37 + y * 11) % 256) as u8,
            ((x * 13 + y * 67) % 256) as u8,
            ((x * 89 + y * 23) % 256) as u8,
        ])
    });
    img.save(&source).unwrap();
    let output = temp.path().join("noise.jpg");
    let mut limits = recipe("image/jpeg");
    limits.max_bytes = Some(5000);
    let info = transform(
        &tools(),
        request(
            &source,
            &output,
            &limits,
            Arc::new(AtomicBool::new(false)),
            u64::MAX,
        ),
    )
    .unwrap();
    assert!(info.bytes <= 5000);
    let quality = info.quality.unwrap();
    assert!(quality < 95);
    let mut next = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut next, quality + 1)
        .encode_image(&img)
        .unwrap();
    assert!(next.len() > 5000, "A higher fitting quality was skipped");
}
#[test]
fn tool_hash_verification_rejects_corruption() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("avcodec-63.dll"), b"tampered").unwrap();
    assert_eq!(
        MediaTools::from_directory(temp.path().into())
            .verify()
            .unwrap_err()
            .code,
        "MEDIA_TOOLS"
    );
    tools().verify().unwrap();
}
#[test]
fn mime_is_detected_from_bytes_and_existing_output_is_preserved() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("actual-png.jpg");
    image::DynamicImage::ImageRgb8(RgbImage::new(10, 10))
        .save_with_format(&source, image::ImageFormat::Png)
        .unwrap();
    assert_eq!(probe(&tools(), &source).unwrap().mime_type, "image/png");
    let output = temp.path().join("existing.jpg");
    std::fs::write(&output, b"do-not-change").unwrap();
    assert!(
        transform(
            &tools(),
            request(
                &source,
                &output,
                &recipe("image/jpeg"),
                Arc::new(AtomicBool::new(false)),
                u64::MAX
            )
        )
        .is_err()
    );
    assert_eq!(std::fs::read(&output).unwrap(), b"do-not-change");
}
#[test]
fn png_resizing_preserves_format_transparency_and_original_file() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("شفافة.PNG");
    let output = temp.path().join("شفافة-نسخة.PNG");
    image::RgbaImage::from_fn(64, 32, |x, _| {
        if x < 32 {
            image::Rgba([0, 0, 0, 0])
        } else {
            image::Rgba([10, 70, 150, 255])
        }
    })
    .save(&source)
    .unwrap();
    let before = hash_file(&source).unwrap();
    let mut limits = recipe("image/png");
    limits.max_width = Some(32);
    limits.max_height = Some(16);
    let info = transform(
        &tools(),
        request(
            &source,
            &output,
            &limits,
            Arc::new(AtomicBool::new(false)),
            u64::MAX,
        ),
    )
    .unwrap();
    assert_eq!(info.mime_type, "image/png");
    assert_eq!((info.width, info.height), (32, 16));
    assert_eq!(before, hash_file(&source).unwrap());
    let actual = image::open(&output).unwrap().to_rgba8();
    assert_eq!(actual.get_pixel(0, 0)[3], 0);
    assert_eq!(actual.get_pixel(31, 0)[3], 255);
}
