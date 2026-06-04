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

#[derive(Default)]
struct HotkeyState {
    pressed_keys: HashSet<Key>,
    recording: bool,
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            paste_text,
            transcribe_audio,
            improve_text,
            save_history_export,
            create_desktop_shortcut
        ])
        .setup(|app| {
            create_tray_icon(app)?;
            start_modifier_hotkey_listener(app.handle().clone());
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

fn start_modifier_hotkey_listener(app: AppHandle) {
    thread::spawn(move || {
        let state = Arc::new(Mutex::new(HotkeyState::default()));
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

            let control_down = state.pressed_keys.contains(&Key::ControlLeft)
                || state.pressed_keys.contains(&Key::ControlRight);
            let meta_down = state.pressed_keys.contains(&Key::MetaLeft)
                || state.pressed_keys.contains(&Key::MetaRight);
            let alt_down = state.pressed_keys.contains(&Key::Alt)
                || state.pressed_keys.contains(&Key::AltGr);
            let should_record = default_primary_modifier_down(control_down, meta_down) && alt_down;

            if should_record && !state.recording {
                state.recording = true;
                let _ = app.emit("talkpro://record-start", ());
            } else if !should_record && state.recording {
                state.recording = false;
                let _ = app.emit("talkpro://record-stop", ());
            }
        };

        if let Err(error) = listen(callback) {
            eprintln!("global keyboard listener failed: {error:?}");
        }
    });
}

fn default_primary_modifier_down(control_down: bool, meta_down: bool) -> bool {
    if cfg!(target_os = "macos") {
        meta_down
    } else {
        control_down
    }
}
