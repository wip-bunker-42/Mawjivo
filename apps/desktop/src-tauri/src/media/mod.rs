pub mod filenames;
pub mod jobs;
pub mod probe;
mod process;
pub mod transform;
use crate::contracts::AppError;
pub use filenames::sent_video_name;
pub use probe::probe;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
pub use transform::{TransformRequest, transform};
#[derive(Clone)]
pub struct MediaTools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}
impl MediaTools {
    pub fn from_directory(directory: PathBuf) -> Self {
        let extension = if cfg!(windows) { ".exe" } else { "" };
        Self {
            ffmpeg: directory.join(format!("ffmpeg{extension}")),
            ffprobe: directory.join(format!("ffprobe{extension}")),
        }
    }
    pub fn verify(&self) -> Result<(), AppError> {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../tools/media-tools.json"))
                .map_err(|_| AppError::new("MEDIA_TOOLS", "تعذر التحقق من أدوات الوسائط."))?;
        let target = format!(
            "{}-{}",
            std::env::consts::OS.replace("windows", "win32"),
            std::env::consts::ARCH.replace("x86_64", "x64")
        );
        let files = manifest["platforms"][target]["files"]
            .as_object()
            .ok_or_else(|| AppError::new("MEDIA_TOOLS", "أدوات الوسائط غير متوفرة لهذا النظام."))?;
        let directory = self
            .ffmpeg
            .parent()
            .ok_or_else(|| AppError::new("MEDIA_TOOLS", "أدوات الوسائط غير جاهزة."))?;
        for (name, digest) in files {
            let actual = hash_file(&directory.join(name)).map_err(|_| {
                AppError::new("MEDIA_TOOLS", "أدوات الوسائط غير جاهزة؛ أعد تثبيت التطبيق.")
            })?;
            if actual != digest.as_str().unwrap_or("") {
                return Err(AppError::new(
                    "MEDIA_TOOLS",
                    "تغيرت أدوات الوسائط؛ أعد تثبيت التطبيق.",
                ));
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone)]
pub struct MediaInfo {
    pub mime_type: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    pub duration_ms: Option<u64>,
    pub quality: Option<u8>,
}
pub fn hash_file(path: &Path) -> Result<String, AppError> {
    let mut file =
        File::open(path).map_err(|_| AppError::new("LOCAL_FILE", "تعذر قراءة الملف المحلي."))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 262_144];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| AppError::new("LOCAL_FILE", "تعذر قراءة الملف المحلي."))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
