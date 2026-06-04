use std::{
    collections::HashSet,
    fs,
    process::Command,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
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

#[derive(Default)]
struct HotkeyState {
    pressed_keys: HashSet<Key>,
    active_profile_id: Option<String>,
    profiles: Vec<HotkeyProfile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeRequest {
    api_key: String,
    model: String,
    audio_base64: String,
    file_name: String,
    mime_type: String,
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
struct OpenAiTranscription {
    text: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
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
async fn transcribe_audio(request: TranscribeRequest) -> Result<String, String> {
    if request.api_key.trim().is_empty() {
        return Err("OpenAI API key is required for AI dictation.".to_string());
    }

    let audio = general_purpose::STANDARD
        .decode(request.audio_base64)
        .map_err(|error| format!("Unable to decode audio: {error}"))?;

    let part = multipart::Part::bytes(audio)
        .file_name(request.file_name)
        .mime_str(&request.mime_type)
        .map_err(|error| format!("Unsupported audio type: {error}"))?;
    let form = multipart::Form::new()
        .text("model", request.model)
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

    Ok(transcription.text)
}

#[tauri::command]
async fn improve_text(request: ImproveRequest) -> Result<String, String> {
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

    Ok(completion
        .choices
        .first()
        .map(|choice| choice.message.content.trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or(request.text))
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
    if let Ok(mut hotkey_state) = state.lock() {
        hotkey_state.profiles = profiles
            .into_iter()
            .filter(|profile| !profile.id.trim().is_empty() && !profile.hotkey.trim().is_empty())
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
            transcribe_audio,
            improve_text,
            save_history_export,
            create_desktop_shortcut,
            register_hotkeys
        ])
        .setup(|app| {
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
        let listener_state = Arc::clone(&state);

        let callback = move |event: Event| {
            let Ok(mut state) = listener_state.lock() else {
                return;
            };

            match event.event_type {
                EventType::KeyPress(key) => {
                    state.pressed_keys.insert(key);
                }
                EventType::KeyRelease(key) => {
                    state.pressed_keys.remove(&key);
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
                    let _ = app.emit("talkpro://record-stop", active_profile_id);
                }
                return;
            }

            let matched_profile = state
                .profiles
                .iter()
                .find(|profile| hotkey_matches(&state.pressed_keys, &profile.hotkey))
                .cloned();

            if let Some(profile) = matched_profile {
                state.active_profile_id = Some(profile.id.clone());
                let _ = app.emit("talkpro://record-start", profile.id);
            }
        };

        if let Err(error) = listen(callback) {
            eprintln!("global keyboard listener failed: {error:?}");
        }
    });
}

fn hotkey_matches(pressed_keys: &HashSet<Key>, hotkey: &str) -> bool {
    let mut required_non_modifier: Vec<Key> = Vec::new();

    for token in hotkey.split('+').map(|part| part.trim().to_lowercase()) {
        match token.as_str() {
            "ctrl" | "control" if !modifier_down(pressed_keys, Key::ControlLeft, Key::ControlRight) => return false,
            "alt" | "option" if !modifier_down(pressed_keys, Key::Alt, Key::AltGr) => return false,
            "shift" if !modifier_down(pressed_keys, Key::ShiftLeft, Key::ShiftRight) => return false,
            "cmd" | "command" | "meta" if !modifier_down(pressed_keys, Key::MetaLeft, Key::MetaRight) => return false,
            "ctrl" | "control" | "alt" | "option" | "shift" | "cmd" | "command" | "meta" => {}
            _ => {
                if let Some(key) = key_from_token(&token) {
                    required_non_modifier.push(key);
                } else {
                    return false;
                }
            }
        }
    }

    !required_non_modifier.is_empty()
        && required_non_modifier
            .iter()
            .all(|key| pressed_keys.contains(key))
}

fn modifier_down(pressed_keys: &HashSet<Key>, left: Key, right: Key) -> bool {
    pressed_keys.contains(&left) || pressed_keys.contains(&right)
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
