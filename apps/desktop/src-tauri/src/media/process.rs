use crate::contracts::AppError;
use std::{
    io::Read,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
pub const FORMATS: &str = "mov,matroska,webm,avi,mpeg,mpegts,flv,asf,image2,image2pipe,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif,avif,heif,jpegxl_pipe";
pub fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.stdin(Stdio::null()).stderr(Stdio::null())
}
pub fn run(
    command: &mut Command,
    cancel: Arc<AtomicBool>,
    timeout: Duration,
    capture: bool,
) -> Result<Vec<u8>, AppError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::new("MEDIA_CANCELLED", "أُلغيت معالجة الوسائط."));
    }
    hidden(command).stdout(if capture {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let mut child = command
        .spawn()
        .map_err(|_| AppError::new("MEDIA_TOOLS", "تعذر تشغيل أدوات الوسائط المرفقة."))?;
    let reader = child.stdout.take().map(|stdout| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stdout.take(1_048_577).read_to_end(&mut bytes);
            bytes
        })
    });
    let start = Instant::now();
    let outcome = loop {
        if cancel.load(Ordering::Relaxed) || start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            break Err(AppError::new(
                if cancel.load(Ordering::Relaxed) {
                    "MEDIA_CANCELLED"
                } else {
                    "MEDIA_TIMEOUT"
                },
                "توقفت معالجة الوسائط؛ يمكنك المحاولة مجددًا.",
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(AppError::new(
                        "MEDIA_PROCESSING",
                        "تعذر معالجة هذا الملف؛ تأكد من سلامته وصيغته.",
                    ))
                };
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(AppError::new(
                    "MEDIA_PROCESSING",
                    "تعذر إكمال معالجة الملف.",
                ));
            }
        }
    };
    let bytes = reader
        .map(|reader| reader.join().unwrap_or_default())
        .unwrap_or_default();
    outcome?;
    if bytes.len() > 1_048_576 {
        return Err(AppError::new(
            "MEDIA_METADATA",
            "بيانات الملف أكبر من الحد المقبول.",
        ));
    }
    Ok(bytes)
}
