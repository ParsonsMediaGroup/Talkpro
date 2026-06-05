use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use arboard::Clipboard;
use base64::{engine::general_purpose, Engine};
use enigo::{Enigo, Key as EnigoKey, KeyboardControllable};
use reqwest::multipart;
use rdev::{listen, Event, EventType, Key};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

const OPENAI_TRANSCRIPTIONS_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_CHAT_URL: &str = "https://api.openai.com/v1/chat/completions";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HotkeyProfile {
    id: String,
    hotkey: String,
}

struct HotkeyState {
    pressed_keys: HashSet<Key>,
    key_pressed_at: HashMap<Key, Instant>,
    active_profile_id: Option<String>,
    pending_profile: Option<PendingProfile>,
    profiles: Vec<HotkeyProfile>,
}

#[derive(Clone)]
struct PendingProfile {
    id: String,
    hotkey: String,
    started_at: Instant,
}

impl Default for HotkeyState {
    fn default() -> Self {
        Self {
            pressed_keys: HashSet::new(),
            key_pressed_at: HashMap::new(),
            active_profile_id: None,
            pending_profile: None,
            profiles: default_hotkey_profiles(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeRequest {
    api_key: String,
    model: String,
    audio_base64: String,
    file_name: String,
    mime_type: String,
    duration_seconds: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImproveRequest {
    api_key: String,
    model: String,
    prompt: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct ClientLogRequest {
    message: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiTranscription {
    text: String,
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct OpenAiUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Deserialize, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[tauri::command]
fn paste_text(text: String) -> Result<(), String> {
    append_log(format!("paste_text len={}", text.len()));
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set_text(text)
        .map_err(|error| format!("Unable to set clipboard text: {error}"))?;

    thread::sleep(Duration::from_millis(120));

    let mut enigo = Enigo::new();
    enigo.key_down(EnigoKey::Control);
    enigo.key_click(EnigoKey::Layout('v'));
    enigo.key_up(EnigoKey::Control);

    Ok(())
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    append_log(format!("copy_text len={}", text.len()));
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set_text(text)
        .map_err(|error| format!("Unable to set clipboard text: {error}"))?;

    Ok(())
}

#[tauri::command]
async fn transcribe_audio(request: TranscribeRequest) -> Result<String, String> {
    append_log(format!(
        "transcribe_audio model={} file={} mime={} base64_len={} duration_seconds={}",
        request.model,
        request.file_name,
        request.mime_type,
        request.audio_base64.len(),
        request
            .duration_seconds
            .map(|duration| format!("{duration:.2}"))
            .unwrap_or_else(|| "unknown".to_string())
    ));

    if request.api_key.trim().is_empty() {
        append_log("transcribe_audio missing_api_key");
        return Err("OpenAI API key is required for AI dictation.".to_string());
    }

    let audio = general_purpose::STANDARD
        .decode(request.audio_base64)
        .map_err(|error| format!("Unable to decode audio: {error}"))?;

    let part = multipart::Part::bytes(audio)
        .file_name(request.file_name)
        .mime_str(&request.mime_type)
        .map_err(|error| format!("Unsupported audio type: {error}"))?;
    let model = request.model.clone();
    let form = multipart::Form::new()
        .text("model", model)
        .part("file", part);

    let response = reqwest::Client::new()
        .post(OPENAI_TRANSCRIPTIONS_URL)
        .bearer_auth(request.api_key.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("Transcription request failed: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("OpenAI transcription failed ({status}): {body}"));
    }

    let transcription = response
        .json::<OpenAiTranscription>()
        .await
        .map_err(|error| format!("Unable to read transcription response: {error}"))?;

    log_transcription_cost(&request.model, request.duration_seconds, transcription.usage.as_ref());
    Ok(transcription.text)
}

#[tauri::command]
async fn improve_text(request: ImproveRequest) -> Result<String, String> {
    append_log(format!(
        "improve_text model={} text_len={} prompt_len={}",
        request.model,
        request.text.len(),
        request.prompt.len()
    ));

    if request.api_key.trim().is_empty() {
        return Err("OpenAI API key is required for AI improvement.".to_string());
    }

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: request.prompt,
        },
        ChatMessage {
            role: "user".to_string(),
            content: request.text.clone(),
        },
    ];

    let response = reqwest::Client::new()
        .post(OPENAI_CHAT_URL)
        .bearer_auth(request.api_key.trim())
        .json(&serde_json::json!({
            "model": request.model,
            "messages": messages,
            "temperature": 0.1
        }))
        .send()
        .await
        .map_err(|error| format!("AI improvement request failed: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("OpenAI improvement failed ({status}): {body}"));
    }

    let completion = response
        .json::<ChatCompletionResponse>()
        .await
        .map_err(|error| format!("Unable to read improvement response: {error}"))?;

    log_text_cost(&request.model, completion.usage.as_ref());
    Ok(completion
        .choices
        .first()
        .map(|choice| choice.message.content.trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or(request.text))
}

#[tauri::command]
fn log_client_event(request: ClientLogRequest) {
    append_log(format!("client {}", request.message));
}

#[tauri::command]
fn diagnostics_log_path() -> String {
    diagnostics_log_file().to_string_lossy().to_string()
}

#[tauri::command]
fn save_history_export(json: String) -> Result<String, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let mut path = dirs::download_dir()
        .or_else(dirs::document_dir)
        .ok_or_else(|| "Unable to find a downloads or documents folder.".to_string())?;

    path.push(format!("talkpro-history-{timestamp}.json"));
    fs::write(&path, json).map_err(|error| format!("Unable to save history export: {error}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn create_desktop_shortcut() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let desktop = dirs::desktop_dir()
            .ok_or_else(|| "Unable to find the current user's desktop folder.".to_string())?;
        let shortcut = desktop.join("TalkPro.lnk");
        let exe = std::env::current_exe()
            .map_err(|error| format!("Unable to resolve TalkPro executable: {error}"))?;
        let working_dir = exe
            .parent()
            .ok_or_else(|| "Unable to resolve TalkPro install folder.".to_string())?;

        let script = format!(
            "$shell = New-Object -ComObject WScript.Shell; \
             $shortcut = $shell.CreateShortcut('{}'); \
             $shortcut.TargetPath = '{}'; \
             $shortcut.WorkingDirectory = '{}'; \
             $shortcut.IconLocation = '{}'; \
             $shortcut.Save()",
            escape_powershell_path(&shortcut),
            escape_powershell_path(&exe),
            escape_powershell_path(working_dir),
            escape_powershell_path(&exe)
        );

        let output = Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
            .output()
            .map_err(|error| format!("Unable to create desktop shortcut: {error}"))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
    }

    Ok(())
}

#[tauri::command]
fn register_hotkeys(profiles: Vec<HotkeyProfile>, state: tauri::State<Arc<Mutex<HotkeyState>>>) {
    append_log(format!(
        "register_hotkeys {}",
        profiles
            .iter()
            .map(|profile| format!("{}={}", profile.id, profile.hotkey))
            .collect::<Vec<_>>()
            .join(", ")
    ));

    if let Ok(mut hotkey_state) = state.lock() {
        let mut seen = HashSet::new();
        hotkey_state.profiles = profiles
            .into_iter()
            .filter(|profile| !profile.id.trim().is_empty() && !profile.hotkey.trim().is_empty())
            .filter(|profile| seen.insert(normalize_hotkey_tokens(&profile.hotkey).join("+")))
            .collect();
    }
}

pub fn run() {
    let hotkey_state = Arc::new(Mutex::new(HotkeyState::default()));

    tauri::Builder::default()
        .manage(Arc::clone(&hotkey_state))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            paste_text,
            copy_text,
            transcribe_audio,
            improve_text,
            save_history_export,
            create_desktop_shortcut,
            register_hotkeys,
            log_client_event,
            diagnostics_log_path
        ])
        .setup(|app| {
            append_log("app setup");
            create_tray_icon(app)?;
            start_modifier_hotkey_listener(app.handle().clone(), hotkey_state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TalkPro");
}

#[cfg(target_os = "windows")]
fn escape_powershell_path(path: impl AsRef<std::path::Path>) -> String {
    path.as_ref().to_string_lossy().replace('\'', "''")
}

fn create_tray_icon(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show TalkPro", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let icon = app
        .default_window_icon()
        .expect("TalkPro icon should be available")
        .clone();

    TrayIconBuilder::with_id("talkpro")
        .tooltip("TalkPro")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn start_modifier_hotkey_listener(app: AppHandle, state: Arc<Mutex<HotkeyState>>) {
    thread::spawn(move || {
        append_log("hotkey listener starting");
        let listener_state = Arc::clone(&state);

        let callback = move |event: Event| {
            let Ok(mut state) = listener_state.lock() else {
                return;
            };

            match event.event_type {
                EventType::KeyPress(key) => {
                    cleanup_stale_keys(&mut state);
                    if state.pressed_keys.insert(key) {
                        append_log(format!("key_press {key:?} pressed={:?}", state.pressed_keys));
                    }
                    state.key_pressed_at.insert(key, Instant::now());
                }
                EventType::KeyRelease(key) => {
                    if state.pressed_keys.remove(&key) {
                        append_log(format!("key_release {key:?} pressed={:?}", state.pressed_keys));
                    }
                    state.key_pressed_at.remove(&key);
                    let should_clear_pending = state
                        .pending_profile
                        .as_ref()
                        .map(|pending| !hotkey_matches(&state.pressed_keys, &pending.hotkey))
                        .unwrap_or(false);
                    if should_clear_pending {
                        append_log("pending_hotkey cancelled");
                        state.pending_profile = None;
                    }
                }
                _ => return,
            }

            if let Some(active_profile_id) = state.active_profile_id.clone() {
                let active_profile = state
                    .profiles
                    .iter()
                    .find(|profile| profile.id == active_profile_id);
                let should_continue = active_profile
                    .map(|profile| hotkey_matches(&state.pressed_keys, &profile.hotkey))
                    .unwrap_or(false);

                if !should_continue {
                    state.active_profile_id = None;
                    append_log(format!("record_stop profile={active_profile_id}"));
                    let _ = app.emit("talkpro://record-stop", active_profile_id);
                }
                return;
            }

            let matched_profile = state
                .profiles
                .iter()
                .filter(|profile| hotkey_matches(&state.pressed_keys, &profile.hotkey))
                .max_by_key(|profile| hotkey_score(&profile.hotkey))
                .cloned();

            if let Some(profile) = matched_profile {
                if hotkey_is_modifier_only(&profile.hotkey) {
                    let already_pending = state
                        .pending_profile
                        .as_ref()
                        .map(|pending| pending.id == profile.id && pending.hotkey == profile.hotkey)
                        .unwrap_or(false);
                    if !already_pending {
                        state.pending_profile = Some(PendingProfile {
                            id: profile.id.clone(),
                            hotkey: profile.hotkey.clone(),
                            started_at: Instant::now(),
                        });
                        append_log(format!(
                            "pending_hotkey profile={} hotkey={} pressed={:?}",
                            profile.id, profile.hotkey, state.pressed_keys
                        ));
                        spawn_pending_hotkey_timer(
                            app.clone(),
                            Arc::clone(&listener_state),
                            profile.id.clone(),
                            profile.hotkey.clone(),
                        );
                    }
                    return;
                }

                state.pending_profile = None;
                state.active_profile_id = Some(profile.id.clone());
                append_log(format!(
                    "record_start profile={} hotkey={} pressed={:?}",
                    profile.id, profile.hotkey, state.pressed_keys
                ));
                let _ = app.emit("talkpro://record-start", profile.id);
            }
        };

        if let Err(error) = listen(callback) {
            append_log(format!("global keyboard listener failed: {error:?}"));
        }
    });
}

fn cleanup_stale_keys(state: &mut HotkeyState) {
    if state.active_profile_id.is_some() {
        return;
    }

    let now = Instant::now();
    let stale_keys = state
        .key_pressed_at
        .iter()
        .filter_map(|(key, started_at)| {
            if now.duration_since(*started_at) > Duration::from_secs(3) {
                Some(*key)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    if stale_keys.is_empty() {
        return;
    }

    for key in stale_keys {
        state.pressed_keys.remove(&key);
        state.key_pressed_at.remove(&key);
    }
    append_log(format!("stale_keys_cleared pressed={:?}", state.pressed_keys));
}

fn spawn_pending_hotkey_timer(
    app: AppHandle,
    state: Arc<Mutex<HotkeyState>>,
    profile_id: String,
    hotkey: String,
) {
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(170));
        let Ok(mut state) = state.lock() else {
            return;
        };

        let Some(pending) = state.pending_profile.clone() else {
            return;
        };

        if pending.id != profile_id || pending.hotkey != hotkey {
            return;
        }

        if state.active_profile_id.is_some() || !hotkey_matches(&state.pressed_keys, &hotkey) {
            state.pending_profile = None;
            return;
        }

        state.pending_profile = None;
        state.active_profile_id = Some(profile_id.clone());
        append_log(format!(
            "record_start profile={} hotkey={} pending_ms={} pressed={:?}",
            profile_id,
            hotkey,
            pending.started_at.elapsed().as_millis(),
            state.pressed_keys
        ));
        let _ = app.emit("talkpro://record-start", profile_id);
    });
}

fn hotkey_matches(pressed_keys: &HashSet<Key>, hotkey: &str) -> bool {
    let Some(required_keys) = hotkey_required_keys(hotkey) else {
        return false;
    };
    let normalized_pressed = normalize_pressed_keys(pressed_keys);

    normalized_pressed.len() == required_keys.len()
        && required_keys.iter().all(|required| normalized_pressed.contains(required))
}

fn normalize_pressed_keys(pressed_keys: &HashSet<Key>) -> HashSet<Key> {
    pressed_keys
        .iter()
        .map(|key| match key {
            Key::ControlLeft | Key::ControlRight => Key::ControlLeft,
            Key::Alt | Key::AltGr => Key::Alt,
            Key::ShiftLeft | Key::ShiftRight => Key::ShiftLeft,
            Key::MetaLeft | Key::MetaRight => Key::MetaLeft,
            other => *other,
        })
        .collect()
}

fn hotkey_required_keys(hotkey: &str) -> Option<HashSet<Key>> {
    let mut required_keys = HashSet::new();

    for token in normalize_hotkey_tokens(hotkey) {
        match token.as_str() {
            "ctrl" | "control" | "alt" | "option" | "shift" | "cmd" | "command" | "meta" | "win" | "windows" => {
                required_keys.insert(canonical_modifier_key(&token));
            }
            _ => {
                if let Some(key) = key_from_token(&token) {
                    required_keys.insert(key);
                } else {
                    return None;
                }
            }
        }
    }

    if required_keys.is_empty() {
        None
    } else {
        Some(required_keys)
    }
}

fn canonical_modifier_key(token: &str) -> Key {
    match token {
        "ctrl" | "control" => Key::ControlLeft,
        "alt" | "option" => Key::Alt,
        "shift" => Key::ShiftLeft,
        "cmd" | "command" | "meta" | "win" | "windows" => Key::MetaLeft,
        _ => Key::Alt,
    }
}

fn normalize_hotkey_tokens(hotkey: &str) -> Vec<String> {
    let trimmed = hotkey.trim().to_lowercase();
    if trimmed.len() == 2 && trimmed.ends_with('@') {
        return vec![
            "win".to_string(),
            trimmed.chars().next().unwrap_or_default().to_string(),
        ];
    }

    hotkey
        .split('+')
        .map(|part| part.trim().to_lowercase())
        .filter(|part| !part.is_empty())
        .collect()
}

fn hotkey_score(hotkey: &str) -> usize {
    normalize_hotkey_tokens(hotkey).len()
}

fn hotkey_is_modifier_only(hotkey: &str) -> bool {
    let tokens = normalize_hotkey_tokens(hotkey);
    !tokens.is_empty()
        && tokens
            .iter()
            .all(|token| matches!(token.as_str(), "ctrl" | "control" | "alt" | "option" | "shift" | "cmd" | "command" | "meta" | "win" | "windows"))
}

fn key_from_token(token: &str) -> Option<Key> {
    match token {
        "a" => Some(Key::KeyA),
        "b" => Some(Key::KeyB),
        "c" => Some(Key::KeyC),
        "d" => Some(Key::KeyD),
        "e" => Some(Key::KeyE),
        "f" => Some(Key::KeyF),
        "g" => Some(Key::KeyG),
        "h" => Some(Key::KeyH),
        "i" => Some(Key::KeyI),
        "j" => Some(Key::KeyJ),
        "k" => Some(Key::KeyK),
        "l" => Some(Key::KeyL),
        "m" => Some(Key::KeyM),
        "n" => Some(Key::KeyN),
        "o" => Some(Key::KeyO),
        "p" => Some(Key::KeyP),
        "q" => Some(Key::KeyQ),
        "r" => Some(Key::KeyR),
        "s" => Some(Key::KeyS),
        "t" => Some(Key::KeyT),
        "u" => Some(Key::KeyU),
        "v" => Some(Key::KeyV),
        "w" => Some(Key::KeyW),
        "x" => Some(Key::KeyX),
        "y" => Some(Key::KeyY),
        "z" => Some(Key::KeyZ),
        "0" => Some(Key::Num0),
        "1" => Some(Key::Num1),
        "2" => Some(Key::Num2),
        "3" => Some(Key::Num3),
        "4" => Some(Key::Num4),
        "5" => Some(Key::Num5),
        "6" => Some(Key::Num6),
        "7" => Some(Key::Num7),
        "8" => Some(Key::Num8),
        "9" => Some(Key::Num9),
        "f1" => Some(Key::F1),
        "f2" => Some(Key::F2),
        "f3" => Some(Key::F3),
        "f4" => Some(Key::F4),
        "f5" => Some(Key::F5),
        "f6" => Some(Key::F6),
        "f7" => Some(Key::F7),
        "f8" => Some(Key::F8),
        "f9" => Some(Key::F9),
        "f10" => Some(Key::F10),
        "f11" => Some(Key::F11),
        "f12" => Some(Key::F12),
        _ => None,
    }
}

fn diagnostics_log_file() -> PathBuf {
    let mut dir = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    dir.push("TalkPro");
    let _ = fs::create_dir_all(&dir);
    dir.push("talkpro.log");
    dir
}

fn append_log(message: impl AsRef<str>) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let line = format!("[{timestamp}] {}\n", message.as_ref());
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(diagnostics_log_file())
    {
        let _ = file.write_all(line.as_bytes());
    }
}

fn log_transcription_cost(model: &str, duration_seconds: Option<f64>, usage: Option<&OpenAiUsage>) {
    let usage_summary = usage
        .map(format_usage)
        .unwrap_or_else(|| "usage=unavailable".to_string());
    let estimate = estimate_transcription_cost(model, duration_seconds, usage);
    append_log(format!(
        "cost transcription model={} duration_seconds={} {} estimated_usd={}",
        model,
        duration_seconds
            .map(|duration| format!("{duration:.2}"))
            .unwrap_or_else(|| "unknown".to_string()),
        usage_summary,
        estimate
            .map(|cost| format!("{cost:.6}"))
            .unwrap_or_else(|| "unknown".to_string())
    ));
}

fn log_text_cost(model: &str, usage: Option<&OpenAiUsage>) {
    let usage_summary = usage
        .map(format_usage)
        .unwrap_or_else(|| "usage=unavailable".to_string());
    let estimate = estimate_text_cost(model, usage);
    append_log(format!(
        "cost improvement model={} {} estimated_usd={}",
        model,
        usage_summary,
        estimate
            .map(|cost| format!("{cost:.6}"))
            .unwrap_or_else(|| "unknown".to_string())
    ));
}

fn format_usage(usage: &OpenAiUsage) -> String {
    format!(
        "prompt_tokens={} completion_tokens={} total_tokens={} input_tokens={} output_tokens={}",
        usage.prompt_tokens.unwrap_or(0),
        usage.completion_tokens.unwrap_or(0),
        usage.total_tokens.unwrap_or(0),
        usage.input_tokens.unwrap_or(0),
        usage.output_tokens.unwrap_or(0)
    )
}

fn estimate_transcription_cost(model: &str, duration_seconds: Option<f64>, usage: Option<&OpenAiUsage>) -> Option<f64> {
    if model.eq_ignore_ascii_case("whisper-1") {
        return duration_seconds.map(|seconds| (seconds / 60.0) * 0.006);
    }

    let usage = usage?;
    let input_tokens = usage.input_tokens.or(usage.prompt_tokens).unwrap_or(0) as f64;
    let output_tokens = usage.output_tokens.or(usage.completion_tokens).unwrap_or(0) as f64;
    let (input_per_million, output_per_million) = match model {
        "gpt-4o-mini-transcribe" => (1.25, 5.00),
        "gpt-4o-transcribe" => (2.50, 10.00),
        _ => return None,
    };
    Some((input_tokens / 1_000_000.0) * input_per_million + (output_tokens / 1_000_000.0) * output_per_million)
}

fn estimate_text_cost(model: &str, usage: Option<&OpenAiUsage>) -> Option<f64> {
    let usage = usage?;
    let input_tokens = usage.input_tokens.or(usage.prompt_tokens).unwrap_or(0) as f64;
    let output_tokens = usage.output_tokens.or(usage.completion_tokens).unwrap_or(0) as f64;
    let (input_per_million, output_per_million) = match model {
        "gpt-4o-mini" => (0.15, 0.60),
        "gpt-4o" => (2.50, 10.00),
        _ => return None,
    };
    Some((input_tokens / 1_000_000.0) * input_per_million + (output_tokens / 1_000_000.0) * output_per_million)
}

fn default_hotkey_profiles() -> Vec<HotkeyProfile> {
    vec![
        HotkeyProfile {
            id: "default".to_string(),
            hotkey: if cfg!(target_os = "macos") {
                "Command+Option".to_string()
            } else {
                "Ctrl+Alt".to_string()
            },
        },
        HotkeyProfile {
            id: "code".to_string(),
            hotkey: if cfg!(target_os = "macos") {
                "Command+Shift+Option+2".to_string()
            } else {
                "Ctrl+Win+2".to_string()
            },
        },
    ]
}
