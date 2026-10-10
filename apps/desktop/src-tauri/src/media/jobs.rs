use super::{MediaTools, TransformRequest, hash_file, probe, transform};
use crate::contracts::{
    AppError, MediaAsset, MediaKind, MediaRecipe, PreparedLocalAsset, SelectedFile,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::SystemTime,
};
use tauri::{Emitter, Manager, State, Window};
use tauri_plugin_dialog::DialogExt;

struct LocalFile {
    owner: String,
    path: PathBuf,
    bytes: u64,
    modified: SystemTime,
    info: Option<super::MediaInfo>,
    source: Option<String>,
    recipe: Option<String>,
}
#[derive(Default)]
pub struct MediaRegistry {
    files: Mutex<HashMap<String, LocalFile>>,
}
impl MediaRegistry {
    pub fn register_probed(
        &self,
        window: &str,
        path: &Path,
        info: super::MediaInfo,
    ) -> Result<String, AppError> {
        self.register_file(window, path, Some(info), None, None)
    }
    pub fn register_prepared(
        &self,
        window: &str,
        path: &Path,
        source: &str,
        recipe: &str,
        info: super::MediaInfo,
    ) -> Result<String, AppError> {
        self.file_for(window, source)?;
        self.register_file(
            window,
            path,
            Some(info),
            Some(source.into()),
            Some(recipe.into()),
        )
    }
    pub fn upload_for(
        &self,
        window: &str,
        input: &crate::contracts::UploadInput,
    ) -> Result<(PathBuf, crate::contracts::UploadManifest), AppError> {
        let path = self.file_for(window, &input.file_id)?;
        let source_path = self.file_for(window, &input.source_asset_id)?;
        let invalid = || {
            AppError::new(
                "INVALID_UPLOAD_MANIFEST",
                "بيانات الرفع لا تطابق الملف المختار.",
            )
        };
        let files = self
            .files
            .lock()
            .map_err(|_| AppError::new("LOCAL_STATE", "تعذر فتح قائمة الملفات."))?;
        let file = files.get(&input.file_id).ok_or_else(invalid)?;
        let source = files.get(&input.source_asset_id).ok_or_else(invalid)?;
        let info = file.info.as_ref().ok_or_else(invalid)?;
        let source_info = source.info.as_ref().ok_or_else(invalid)?;
        if file.recipe != input.recipe_id
            || file.source.as_deref().unwrap_or(&input.file_id) != input.source_asset_id
            || input.manifest.source_asset_id != input.source_asset_id
            || input.manifest.recipe_id != input.recipe_id
        {
            return Err(invalid());
        }
        let original_name = source_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(invalid)?;
        let name = if info.mime_type == source_info.mime_type || info.duration_ms.is_some() {
            original_name.to_owned()
        } else if info.mime_type == "image/jpeg" {
            let stem = original_name
                .rsplit_once('.')
                .filter(|(stem, _)| !stem.is_empty())
                .map(|(stem, _)| stem)
                .unwrap_or(original_name);
            format!("{stem}.jpg")
        } else {
            return Err(invalid());
        };
        let kind = if info.duration_ms.is_some() {
            MediaKind::Video
        } else {
            MediaKind::Image
        };
        let m = &input.manifest;
        if m.original_name != name
            || m.kind != kind
            || m.bytes != info.bytes
            || m.mime_type != info.mime_type
            || m.width.is_some_and(|v| v != info.width)
            || m.height.is_some_and(|v| v != info.height)
            || m.duration_ms.is_some_and(|v| Some(v) != info.duration_ms)
        {
            return Err(invalid());
        }
        let mut manifest = m.clone();
        manifest.width = Some(info.width);
        manifest.height = Some(info.height);
        manifest.duration_ms = info.duration_ms;
        Ok((path, manifest))
    }
    pub fn register(&self, window: &str, path: &Path) -> Result<String, AppError> {
        self.register_file(window, path, None, None, None)
    }
    fn register_file(
        &self,
        window: &str,
        path: &Path,
        info: Option<super::MediaInfo>,
        source: Option<String>,
        recipe: Option<String>,
    ) -> Result<String, AppError> {
        let path = path
            .canonicalize()
            .map_err(|_| AppError::new("LOCAL_FILE", "تعذر فتح الملف المختار."))?;
        let metadata = std::fs::metadata(&path)
            .map_err(|_| AppError::new("LOCAL_FILE", "تعذر قراءة الملف المختار."))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 9_000_000_000 {
            return Err(AppError::new(
                "MEDIA_SIZE",
                "اختر ملفًا غير فارغ وأصغر من 9 جيجابايت.",
            ));
        }
        if info.as_ref().is_some_and(|v| v.bytes != metadata.len()) {
            return Err(AppError::new(
                "LOCAL_FILE_CHANGED",
                "تغير الملف المحلي؛ اختره مجددًا.",
            ));
        }
        let modified = metadata
            .modified()
            .map_err(|_| AppError::new("LOCAL_FILE", "تعذر فحص الملف المختار."))?;
        let id = format!("file-{}", uuid::Uuid::new_v4());
        self.files
            .lock()
            .map_err(|_| AppError::new("LOCAL_STATE", "تعذر فتح قائمة الملفات."))?
            .insert(
                id.clone(),
                LocalFile {
                    owner: window.into(),
                    path,
                    bytes: metadata.len(),
                    modified,
                    info,
                    source,
                    recipe,
                },
            );
        Ok(id)
    }
    pub fn file_for(&self, window: &str, id: &str) -> Result<PathBuf, AppError> {
        let files = self
            .files
            .lock()
            .map_err(|_| AppError::new("LOCAL_STATE", "تعذر فتح قائمة الملفات."))?;
        let file = files
            .get(id)
            .filter(|file| file.owner == window)
            .ok_or_else(|| {
                AppError::new(
                    "LOCAL_FILE_SCOPE",
                    "هذا الملف لا يخص النافذة الحالية؛ اختره مجددًا.",
                )
            })?;
        let metadata = std::fs::metadata(&file.path)
            .map_err(|_| AppError::new("LOCAL_FILE", "الملف المحلي غير موجود."))?;
        if metadata.len() != file.bytes || metadata.modified().ok() != Some(file.modified) {
            return Err(AppError::new(
                "LOCAL_FILE_CHANGED",
                "تغير الملف المحلي؛ اختره مجددًا.",
            ));
        }
        Ok(file.path.clone())
    }
    fn authorize(&self, window: &str, id: &str) -> Result<(), AppError> {
        let files = self
            .files
            .lock()
            .map_err(|_| AppError::new("LOCAL_STATE", "تعذر فتح قائمة الملفات."))?;
        if files.get(id).is_some_and(|file| file.owner == window) {
            Ok(())
        } else {
            Err(AppError::new(
                "LOCAL_FILE_SCOPE",
                "هذا الملف لا يخص النافذة الحالية.",
            ))
        }
    }
}
type CancelMap = HashMap<String, (String, Arc<AtomicBool>)>;
pub struct MediaState {
    pub registry: MediaRegistry,
    tools: MediaTools,
    directory: PathBuf,
    verified: OnceLock<Result<(), AppError>>,
    heavy: tokio::sync::Mutex<()>,
    cancellations: Mutex<CancelMap>,
}
impl MediaState {
    pub fn new(tools: MediaTools, directory: PathBuf) -> Self {
        Self {
            registry: MediaRegistry::default(),
            tools,
            directory,
            verified: OnceLock::new(),
            heavy: tokio::sync::Mutex::new(()),
            cancellations: Mutex::new(HashMap::new()),
        }
    }
    fn tools(&self) -> Result<&MediaTools, AppError> {
        self.verified.get_or_init(|| self.tools.verify()).clone()?;
        Ok(&self.tools)
    }
    fn begin(&self, owner: &str, id: &str) -> Result<Arc<AtomicBool>, AppError> {
        let mut jobs = self
            .cancellations
            .lock()
            .map_err(|_| AppError::new("LOCAL_STATE", "تعذر بدء المعالجة."))?;
        if jobs.contains_key(id) {
            return Err(AppError::new(
                "MEDIA_BUSY",
                "هذا الملف قيد المعالجة بالفعل.",
            ));
        }
        let flag = Arc::new(AtomicBool::new(false));
        jobs.insert(id.into(), (owner.into(), flag.clone()));
        Ok(flag)
    }
    fn finish(&self, id: &str) {
        if let Ok(mut jobs) = self.cancellations.lock() {
            jobs.remove(id);
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaProgress<'a> {
    asset_id: &'a str,
    stage: &'a str,
    percent: u8,
}
fn emit(window: &Window, id: &str, stage: &str, percent: u8) {
    let _ = window.emit(
        "media-progress",
        MediaProgress {
            asset_id: id,
            stage,
            percent,
        },
    );
}

#[tauri::command]
pub async fn pick_media(
    window: Window,
    state: State<'_, Arc<MediaState>>,
) -> Result<Vec<SelectedFile>, AppError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let files = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("اختيار صور أو فيديو")
            .add_filter(
                "الصور والفيديو",
                &[
                    "jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "jxl", "bmp", "tif",
                    "tiff", "gif", "mp4", "mov", "m4v", "webm", "avi", "mpeg", "mpg",
                ],
            )
            .blocking_pick_files()
            .unwrap_or_default();
        if files.len() > 20 {
            return Err(AppError::new(
                "MEDIA_COUNT",
                "يمكن اختيار 20 ملفًا في المرة الواحدة.",
            ));
        }
        files
            .into_iter()
            .map(|file| {
                let path = file
                    .into_path()
                    .map_err(|_| AppError::new("LOCAL_FILE", "اختر ملفًا من جهازك."))?;
                let info = probe(state.tools()?, &path)?;
                let original_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| AppError::new("MEDIA_NAME", "اسم الملف غير صالح."))?
                    .to_owned();
                let file_id =
                    state
                        .registry
                        .register_probed(window.label(), &path, info.clone())?;
                Ok(SelectedFile {
                    file_id,
                    original_name,
                    bytes: info.bytes,
                    mime_type: info.mime_type,
                })
            })
            .collect()
    })
    .await
    .map_err(|_| AppError::new("LOCAL_TASK", "تعذر اختيار الوسائط."))?
}
#[tauri::command]
pub async fn probe_media(
    window: Window,
    state: State<'_, Arc<MediaState>>,
    file_id: String,
) -> Result<MediaAsset, AppError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = state.registry.file_for(window.label(), &file_id)?;
        emit(&window, &file_id, "probe", 0);
        let info = probe(state.tools()?, &path)?;
        emit(&window, &file_id, "probe", 100);
        Ok(MediaAsset {
            id: file_id,
            original_name: path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("وسائط")
                .into(),
            kind: if info.duration_ms.is_some() {
                MediaKind::Video
            } else {
                MediaKind::Image
            },
            bytes: info.bytes,
            mime_type: info.mime_type,
            sha256: None,
            width: Some(info.width),
            height: Some(info.height),
            duration_ms: info.duration_ms,
            derived_from: None,
        })
    })
    .await
    .map_err(|_| AppError::new("LOCAL_TASK", "تعذر فحص الوسائط."))?
}
#[tauri::command]
pub async fn prepare_media(
    window: Window,
    state: State<'_, Arc<MediaState>>,
    file_id: String,
    recipe: MediaRecipe,
) -> Result<PreparedLocalAsset, AppError> {
    let state = state.inner().clone();
    let path = state.registry.file_for(window.label(), &file_id)?;
    if recipe.source_asset_id != file_id {
        return Err(AppError::new(
            "MEDIA_RECIPE",
            "خطة المعالجة لا تخص هذا الملف.",
        ));
    }
    let cancel = state.begin(window.label(), &file_id)?;
    let _lock = state.heavy.lock().await;
    emit(&window, &file_id, "prepare", 0);
    let task_state = state.clone();
    let task_id = file_id.clone();
    let task_window = window.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        task_state
            .registry
            .file_for(task_window.label(), &task_id)?;
        let tools = task_state.tools()?;
        let directory = task_state.directory.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&directory)
            .map_err(|_| AppError::new("LOCAL_DISK_FULL", "تعذر إنشاء مجلد المعالجة."))?;
        let extension = if recipe.output_mime_type == "image/jpeg" {
            "jpg"
        } else {
            "mp4"
        };
        let mut output = directory.join(
            path.file_name()
                .ok_or_else(|| AppError::new("MEDIA_NAME", "اسم الملف غير صالح."))?,
        );
        output.set_extension(extension);
        let available_bytes = fs4::available_space(&directory)
            .map_err(|_| AppError::new("LOCAL_DISK", "تعذر فحص المساحة المحلية."))?;
        let info = transform(
            tools,
            TransformRequest {
                source: &path,
                output: &output,
                recipe: &recipe,
                cancel,
                available_bytes,
            },
        );
        let info = match info {
            Ok(info) => info,
            Err(error) => {
                let _ = std::fs::remove_dir(&directory);
                return Err(error);
            }
        };
        let sha256 = hash_file(&output)?;
        let output_id = task_state.registry.register_prepared(
            task_window.label(),
            &output,
            &task_id,
            &recipe.id,
            info.clone(),
        )?;
        Ok(PreparedLocalAsset {
            file_id: output_id,
            source_asset_id: task_id,
            recipe_id: recipe.id,
            mime_type: info.mime_type,
            bytes: info.bytes,
            sha256,
        })
    })
    .await
    .map_err(|_| AppError::new("LOCAL_TASK", "تعذر إكمال معالجة الوسائط."));
    state.finish(&file_id);
    match result {
        Ok(Ok(prepared)) => {
            emit(&window, &file_id, "prepare", 100);
            Ok(prepared)
        }
        Ok(Err(error)) | Err(error) => Err(error),
    }
}
#[tauri::command]
pub fn cancel_media(
    window: Window,
    state: State<'_, Arc<MediaState>>,
    job_id: String,
) -> Result<(), AppError> {
    state.registry.authorize(window.label(), &job_id)?;
    let jobs = state
        .cancellations
        .lock()
        .map_err(|_| AppError::new("LOCAL_STATE", "تعذر إلغاء المعالجة."))?;
    if let Some((owner, flag)) = jobs.get(&job_id)
        && owner == window.label()
    {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let directory = app.path().app_local_data_dir()?.join("media-cache");
    std::fs::create_dir_all(&directory)?;
    let tools_directory = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("media-tools")
    } else {
        app.path().resource_dir()?.join("media-tools")
    };
    app.manage(Arc::new(MediaState::new(
        MediaTools::from_directory(tools_directory),
        directory,
    )));
    Ok(())
}
