use std::{
    collections::HashSet,
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Router,
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, State, multipart::MultipartError},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Json, Response},
    routing::{get, patch, post},
};
use clap::Parser;
use serde::{Deserialize, Serialize};
use tokio::{fs::File, io::AsyncWriteExt, net::TcpListener, time::sleep};
use tokio_util::io::ReaderStream;
use tracing::{error, info, warn};
use uuid::Uuid;

const METADATA_VERSION: u32 = 1;

#[derive(Parser, Debug)]
#[command(
    name = "share-web",
    version,
    about = "LAN text and file sharing web service"
)]
struct Args {
    /// Address to listen on, for example 0.0.0.0:8080.
    #[arg(long, default_value = "0.0.0.0:8080")]
    listen: String,

    /// Persistent directory for metadata, files and temporary uploads.
    #[arg(long, default_value = "./data")]
    data_dir: PathBuf,

    /// Total committed storage limit. 0 means unlimited. Examples: 100G, 10GiB.
    #[arg(long, default_value = "0")]
    max_total_size: String,

    /// Per-file upload limit. 0 means unlimited. Examples: 2G, 512MiB.
    #[arg(long, default_value = "0")]
    max_upload_size: String,

    /// Maximum size of one clipboard text item. Examples: 1MiB, 512K.
    #[arg(long, default_value = "1MiB")]
    max_clip_size: String,

    /// Interval in seconds between expired-item cleanup runs.
    #[arg(long, default_value_t = 60)]
    cleanup_interval: u64,
}

#[derive(Clone)]
struct AppState {
    store: Arc<Mutex<Store>>,
    max_total_size: u64,
    max_upload_size: u64,
    max_clip_size: u64,
}

#[derive(Debug)]
enum ApiError {
    BadRequest(String),
    NotFound(String),
    PayloadTooLarge(String),
    Conflict(String),
    Internal(String),
}

impl ApiError {
    fn internal<E: std::fmt::Display>(error: E) -> Self {
        Self::Internal(error.to_string())
    }
}

impl From<MultipartError> for ApiError {
    fn from(error: MultipartError) -> Self {
        Self::BadRequest(format!("multipart request is invalid: {error}"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            Self::NotFound(message) => (StatusCode::NOT_FOUND, message),
            Self::PayloadTooLarge(message) => (StatusCode::PAYLOAD_TOO_LARGE, message),
            Self::Conflict(message) => (StatusCode::CONFLICT, message),
            Self::Internal(message) => {
                error!(error = %message, "request failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal server error".to_string(),
                )
            }
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ItemKind {
    File,
    Clip,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Item {
    id: String,
    kind: ItemKind,
    name: String,
    mime: Option<String>,
    size: u64,
    created_at: u64,
    expires_at: Option<u64>,
    stored_name: Option<String>,
    text: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Metadata {
    version: u32,
    items: Vec<Item>,
}

impl Default for Metadata {
    fn default() -> Self {
        Self {
            version: METADATA_VERSION,
            items: Vec::new(),
        }
    }
}

struct Store {
    metadata_path: PathBuf,
    objects_dir: PathBuf,
    tmp_dir: PathBuf,
    metadata: Metadata,
}

impl Store {
    fn open(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
        let objects_dir = data_dir.join("objects");
        let tmp_dir = data_dir.join("tmp");
        fs::create_dir_all(&objects_dir).map_err(|error| error.to_string())?;
        fs::create_dir_all(&tmp_dir).map_err(|error| error.to_string())?;

        let metadata_path = data_dir.join("metadata.json");
        let metadata: Metadata = if metadata_path.exists() {
            let bytes = fs::read(&metadata_path).map_err(|error| error.to_string())?;
            serde_json::from_slice(&bytes)
                .map_err(|error| format!("cannot parse {}: {error}", metadata_path.display()))?
        } else {
            let metadata = Metadata::default();
            let store = Self {
                metadata_path: metadata_path.clone(),
                objects_dir: objects_dir.clone(),
                tmp_dir: tmp_dir.clone(),
                metadata,
            };
            store.persist()?;
            return Ok(store);
        };

        if metadata.version != METADATA_VERSION {
            return Err(format!(
                "unsupported metadata version {}, expected {}",
                metadata.version, METADATA_VERSION
            ));
        }

        let mut store = Self {
            metadata_path,
            objects_dir,
            tmp_dir,
            metadata,
        };
        store.cleanup_temporary()?;
        store.cleanup_expired()?;
        store.reconcile_objects()?;
        Ok(store)
    }

    fn persist(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&self.metadata).map_err(|error| error.to_string())?;
        let temporary = self.metadata_path.with_extension("json.tmp");
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        fs::rename(&temporary, &self.metadata_path).map_err(|error| error.to_string())?;
        Ok(())
    }

    fn used_bytes(&self) -> u64 {
        self.metadata.items.iter().map(|item| item.size).sum()
    }

    fn cleanup_expired(&mut self) -> Result<usize, String> {
        let now = now_seconds();
        let mut expired = Vec::new();
        self.metadata.items.retain(|item| {
            let is_expired = item.expires_at.is_some_and(|expires_at| expires_at <= now);
            if is_expired {
                expired.push(item.clone());
            }
            !is_expired
        });

        if expired.is_empty() {
            return Ok(0);
        }

        self.persist()?;
        for item in &expired {
            if let Some(stored_name) = &item.stored_name {
                let path = self.objects_dir.join(stored_name);
                if let Err(error) = fs::remove_file(&path)
                    && error.kind() != std::io::ErrorKind::NotFound
                {
                    warn!(path = %path.display(), error = %error, "cannot remove expired object");
                }
            }
        }
        Ok(expired.len())
    }

    fn cleanup_temporary(&self) -> Result<(), String> {
        let entries = fs::read_dir(&self.tmp_dir).map_err(|error| error.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path.is_file() {
                fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    fn reconcile_objects(&mut self) -> Result<(), String> {
        let mut referenced = HashSet::new();
        let mut changed = false;
        let items = std::mem::take(&mut self.metadata.items);
        let mut retained = Vec::with_capacity(items.len());

        for mut item in items {
            if let Some(stored_name) = &item.stored_name {
                let path = self.object_path(stored_name);
                match fs::metadata(&path) {
                    Ok(metadata) if metadata.is_file() => {
                        let actual_size = metadata.len();
                        if item.size != actual_size {
                            item.size = actual_size;
                            changed = true;
                        }
                        referenced.insert(stored_name.clone());
                        retained.push(item);
                    }
                    Ok(_) | Err(_) => {
                        changed = true;
                    }
                }
            } else {
                retained.push(item);
            }
        }
        self.metadata.items = retained;

        for entry in fs::read_dir(&self.objects_dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_file() && !referenced.contains(&name) {
                fs::remove_file(path).map_err(|error| error.to_string())?;
                changed = true;
            }
        }

        if changed {
            self.persist()?;
        }
        Ok(())
    }

    fn find(&self, id: &str) -> Option<Item> {
        self.metadata
            .items
            .iter()
            .find(|item| item.id == id)
            .cloned()
    }

    fn object_path(&self, stored_name: &str) -> PathBuf {
        self.objects_dir.join(stored_name)
    }

    fn remove(&mut self, id: &str) -> Result<bool, String> {
        let Some(item) = self.find(id) else {
            return Ok(false);
        };

        self.metadata.items.retain(|candidate| candidate.id != id);
        self.persist()?;

        if let Some(stored_name) = item.stored_name {
            let path = self.object_path(&stored_name);
            if let Err(error) = fs::remove_file(&path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                warn!(path = %path.display(), error = %error, "cannot remove object");
            }
        }
        Ok(true)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemView {
    id: String,
    kind: ItemKind,
    name: String,
    mime: Option<String>,
    size: u64,
    created_at: u64,
    expires_at: Option<u64>,
    text: Option<String>,
}

impl From<Item> for ItemView {
    fn from(item: Item) -> Self {
        Self {
            id: item.id,
            kind: item.kind,
            name: item.name,
            mime: item.mime,
            size: item.size,
            created_at: item.created_at,
            expires_at: item.expires_at,
            text: item.text,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemsResponse {
    items: Vec<ItemView>,
    used_bytes: u64,
    max_total_size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    used_bytes: u64,
    max_total_size: u64,
}

#[derive(Deserialize)]
struct CreateClip {
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateItem {
    expires_at: Option<u64>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let args = Args::parse();
    let listen: SocketAddr = args
        .listen
        .parse()
        .map_err(|error| format!("invalid --listen value: {error}"))?;
    let max_total_size = parse_size(&args.max_total_size)?;
    let max_upload_size = parse_size(&args.max_upload_size)?;
    let max_clip_size = parse_size(&args.max_clip_size)?;
    let store = Store::open(&args.data_dir).map_err(|error| {
        format!(
            "cannot open data directory {}: {error}",
            args.data_dir.display()
        )
    })?;

    info!(
        listen = %listen,
        data_dir = %args.data_dir.display(),
        max_total_size,
        max_upload_size,
        max_clip_size,
        "starting share-web"
    );

    let state = AppState {
        store: Arc::new(Mutex::new(store)),
        max_total_size,
        max_upload_size,
        max_clip_size,
    };

    let cleanup_state = state.clone();
    let cleanup_interval = args.cleanup_interval.max(1);
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(cleanup_interval)).await;
            let result = cleanup_state
                .store
                .lock()
                .map_err(|error| error.to_string())
                .and_then(|mut store| store.cleanup_expired());
            match result {
                Ok(count) if count > 0 => info!(count, "expired items removed"),
                Ok(_) => {}
                Err(error) => error!(error = %error, "expired-item cleanup failed"),
            }
        }
    });

    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/style.css", get(style_css))
        .route("/api/items", get(list_items))
        .route("/api/files", post(upload_file))
        .route("/api/files/{id}/download", get(download_file))
        .route("/api/clips", post(create_clip))
        .route("/api/items/{id}", patch(update_item).delete(delete_item))
        .route("/api/health", get(health))
        .layer(DefaultBodyLimit::disable())
        .with_state(state);

    let listener = TcpListener::bind(listen).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../static/index.html"))
}

async fn app_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        include_str!("../static/app.js"),
    )
}

async fn style_css() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../static/style.css"),
    )
}

async fn list_items(State(state): State<AppState>) -> Result<Json<ItemsResponse>, ApiError> {
    let mut store = lock_store(&state)?;
    store.cleanup_expired().map_err(ApiError::internal)?;
    let mut items: Vec<Item> = store.metadata.items.clone();
    items.sort_by_key(|item| std::cmp::Reverse(item.created_at));
    Ok(Json(ItemsResponse {
        items: items.into_iter().map(ItemView::from).collect(),
        used_bytes: store.used_bytes(),
        max_total_size: state.max_total_size,
    }))
}

async fn health(State(state): State<AppState>) -> Result<Json<HealthResponse>, ApiError> {
    let store = lock_store(&state)?;
    Ok(Json(HealthResponse {
        status: "ok",
        used_bytes: store.used_bytes(),
        max_total_size: state.max_total_size,
    }))
}

async fn create_clip(
    State(state): State<AppState>,
    Json(payload): Json<CreateClip>,
) -> Result<(StatusCode, Json<ItemView>), ApiError> {
    let size = payload.text.len() as u64;
    if payload.text.trim().is_empty() {
        return Err(ApiError::BadRequest("text cannot be empty".to_string()));
    }
    if state.max_clip_size > 0 && size > state.max_clip_size {
        return Err(ApiError::PayloadTooLarge(format!(
            "clipboard text exceeds the {} byte limit",
            state.max_clip_size
        )));
    }

    let mut store = lock_store(&state)?;
    store.cleanup_expired().map_err(ApiError::internal)?;
    ensure_capacity(&store, state.max_total_size, size)?;

    let item = Item {
        id: Uuid::new_v4().to_string(),
        kind: ItemKind::Clip,
        name: "剪切板文字".to_string(),
        mime: Some("text/plain; charset=utf-8".to_string()),
        size,
        created_at: now_seconds(),
        expires_at: None,
        stored_name: None,
        text: Some(payload.text),
    };
    let view = ItemView::from(item.clone());
    store.metadata.items.push(item);
    store.persist().map_err(ApiError::internal)?;
    Ok((StatusCode::CREATED, Json(view)))
}

async fn upload_file(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<ItemView>), ApiError> {
    while let Some(mut field) = multipart.next_field().await? {
        if field.name() != Some("file") {
            continue;
        }

        let original_name = clean_file_name(field.file_name().unwrap_or("未命名文件"));
        let mime = field
            .content_type()
            .map(str::to_string)
            .filter(|value| !value.is_empty());
        let id = Uuid::new_v4().to_string();
        let temporary_path = {
            let store = lock_store(&state)?;
            store.tmp_dir.join(format!("upload-{id}.tmp"))
        };

        let result = write_upload(&mut field, &temporary_path, state.max_upload_size).await;
        let size = match result {
            Ok(size) => size,
            Err(error) => {
                let _ = tokio::fs::remove_file(&temporary_path).await;
                return Err(error);
            }
        };

        let mut store = lock_store(&state)?;
        if let Err(error) = store.cleanup_expired() {
            let _ = fs::remove_file(&temporary_path);
            return Err(ApiError::internal(error));
        }
        if let Err(error) = ensure_capacity(&store, state.max_total_size, size) {
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }

        let stored_name = format!("{id}.bin");
        let final_path = store.object_path(&stored_name);
        fs::rename(&temporary_path, &final_path).map_err(|error| {
            let _ = fs::remove_file(&temporary_path);
            ApiError::internal(error)
        })?;

        let item = Item {
            id,
            kind: ItemKind::File,
            name: original_name,
            mime,
            size,
            created_at: now_seconds(),
            expires_at: None,
            stored_name: Some(stored_name),
            text: None,
        };
        let view = ItemView::from(item.clone());
        store.metadata.items.push(item);
        if let Err(error) = store.persist() {
            let _ = fs::remove_file(&final_path);
            return Err(ApiError::internal(error));
        }
        return Ok((StatusCode::CREATED, Json(view)));
    }

    Err(ApiError::BadRequest(
        "multipart field 'file' is required".to_string(),
    ))
}

async fn write_upload(
    field: &mut axum::extract::multipart::Field<'_>,
    path: &Path,
    max_upload_size: u64,
) -> Result<u64, ApiError> {
    let mut file = File::create(path).await.map_err(ApiError::internal)?;
    let mut size = 0_u64;
    while let Some(chunk) = field.chunk().await? {
        size = size.saturating_add(chunk.len() as u64);
        if max_upload_size > 0 && size > max_upload_size {
            return Err(ApiError::PayloadTooLarge(format!(
                "file exceeds the {} byte limit",
                max_upload_size
            )));
        }
        file.write_all(&chunk).await.map_err(ApiError::internal)?;
    }
    file.flush().await.map_err(ApiError::internal)?;
    Ok(size)
}

async fn download_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, ApiError> {
    let (path, name, mime, size) = {
        let mut store = lock_store(&state)?;
        store.cleanup_expired().map_err(ApiError::internal)?;
        let item = store
            .find(&id)
            .ok_or_else(|| ApiError::NotFound("item not found or expired".to_string()))?;
        if !matches!(item.kind, ItemKind::File) {
            return Err(ApiError::BadRequest("item is not a file".to_string()));
        }
        let stored_name = item
            .stored_name
            .ok_or_else(|| ApiError::Internal("file has no stored object".to_string()))?;
        (
            store.object_path(&stored_name),
            item.name,
            item.mime,
            item.size,
        )
    };

    let file = File::open(&path)
        .await
        .map_err(|_| ApiError::NotFound("file object is missing".to_string()))?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_deref().unwrap_or("application/octet-stream"))
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&size.to_string()).map_err(ApiError::internal)?,
    );
    let disposition = format!(
        "attachment; filename=\"download\"; filename*=UTF-8''{}",
        percent_encode_filename(&name)
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition).map_err(ApiError::internal)?,
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );

    Ok((headers, Body::from_stream(ReaderStream::new(file))).into_response())
}

async fn update_item(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(payload): Json<UpdateItem>,
) -> Result<StatusCode, ApiError> {
    let mut store = lock_store(&state)?;
    store.cleanup_expired().map_err(ApiError::internal)?;
    let item = store
        .metadata
        .items
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| ApiError::NotFound("item not found or expired".to_string()))?;
    if let Some(expires_at) = payload.expires_at {
        if expires_at <= now_seconds() {
            return Err(ApiError::BadRequest(
                "expiresAt must be in the future or null".to_string(),
            ));
        }
        item.expires_at = Some(expires_at);
    } else {
        item.expires_at = None;
    }
    store.persist().map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_item(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    let mut store = lock_store(&state)?;
    store.cleanup_expired().map_err(ApiError::internal)?;
    if store.remove(&id).map_err(ApiError::internal)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound("item not found or expired".to_string()))
    }
}

fn lock_store(state: &AppState) -> Result<std::sync::MutexGuard<'_, Store>, ApiError> {
    state
        .store
        .lock()
        .map_err(|error| ApiError::internal(format!("store lock poisoned: {error}")))
}

fn ensure_capacity(store: &Store, max_total_size: u64, incoming_size: u64) -> Result<(), ApiError> {
    if max_total_size > 0 && store.used_bytes().saturating_add(incoming_size) > max_total_size {
        return Err(ApiError::Conflict(format!(
            "total storage limit exceeded (limit: {max_total_size} bytes)"
        )));
    }
    Ok(())
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn clean_file_name(input: &str) -> String {
    let basename = Path::new(input)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名文件");
    let cleaned: String = basename
        .chars()
        .filter(|character| !character.is_control())
        .take(255)
        .collect();
    if cleaned.trim().is_empty() {
        "未命名文件".to_string()
    } else {
        cleaned
    }
}

fn percent_encode_filename(input: &str) -> String {
    input
        .as_bytes()
        .iter()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                (*byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn parse_size(input: &str) -> Result<u64, String> {
    let compact = input.trim().replace('_', "").to_ascii_uppercase();
    if compact.is_empty() {
        return Err("size cannot be empty".to_string());
    }

    let units: [(&str, u128); 9] = [
        ("TIB", 1024_u128.pow(4)),
        ("TB", 1000_u128.pow(4)),
        ("T", 1000_u128.pow(4)),
        ("GIB", 1024_u128.pow(3)),
        ("GB", 1000_u128.pow(3)),
        ("G", 1000_u128.pow(3)),
        ("MIB", 1024_u128.pow(2)),
        ("MB", 1000_u128.pow(2)),
        ("M", 1000_u128.pow(2)),
    ];
    let units_small: [(&str, u128); 6] = [
        ("KIB", 1024),
        ("KB", 1000),
        ("K", 1000),
        ("B", 1),
        ("", 1),
        ("0", 1),
    ];

    let (number, multiplier) = units
        .iter()
        .chain(units_small.iter())
        .find_map(|(suffix, multiplier)| {
            compact
                .strip_suffix(suffix)
                .map(|number| (number, *multiplier))
        })
        .ok_or_else(|| format!("unsupported size: {input}"))?;
    let number = if number.is_empty() { "0" } else { number };
    let value: u128 = number
        .parse()
        .map_err(|_| format!("invalid size: {input}"))?;
    let bytes = value
        .checked_mul(multiplier)
        .ok_or_else(|| format!("size is too large: {input}"))?;
    u64::try_from(bytes).map_err(|_| format!("size is too large: {input}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_capacity_units() {
        assert_eq!(parse_size("0").unwrap(), 0);
        assert_eq!(parse_size("100B").unwrap(), 100);
        assert_eq!(parse_size("10K").unwrap(), 10_000);
        assert_eq!(parse_size("1KiB").unwrap(), 1024);
        assert_eq!(parse_size("2G").unwrap(), 2_000_000_000);
        assert_eq!(parse_size("2GiB").unwrap(), 2 * 1024 * 1024 * 1024);
    }

    #[test]
    fn rejects_invalid_capacity() {
        assert!(parse_size("").is_err());
        assert!(parse_size("abc").is_err());
        assert!(parse_size("1.5G").is_err());
    }

    #[test]
    fn sanitizes_file_names() {
        assert_eq!(clean_file_name("../../secret.txt"), "secret.txt");
        assert_eq!(clean_file_name("\n\t"), "未命名文件");
        assert_eq!(
            percent_encode_filename("中文.txt"),
            "%E4%B8%AD%E6%96%87.txt"
        );
    }
}
