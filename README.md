# TalkPro

TalkPro is a fast, open-source push-to-talk dictation app for desktop. Hold a hotkey, speak, release, and TalkPro transcribes, optionally improves the text with your own prompt, saves it to local history, copies it to the clipboard, and pastes it into the active app.

GitHub description:

> Open-source desktop dictation with push-to-talk, local history, custom AI cleanup prompts, and user-owned API keys.

## Defaults

- Windows and Linux: `Ctrl + Alt`
- macOS: `Command + Option`

## Dictation Modes

- AI dictation: records the audio locally, sends it to OpenAI using the user's API key, then copies and pastes the transcript.
- Local dictation: uses the operating system/WebView speech fallback when available. This mode does not require an API key, but quality varies by platform.

## Prompt-Based Improvement

Users can create multiple dictation profiles. Each profile can have its own hotkey, transcription model, improvement model, vocabulary, and prompt. This makes it possible to keep separate dictation "personalities" for code review, support replies, notes, documentation, or casual writing.

AI improvement prompts are intended for project-specific context, such as:

- Acronyms like `SSH`, `API`, `URL`, and `JSON`.
- Codebase names, file names, commands, APIs, and framework terms.
- Customer or product names that speech recognition often mishears.
- Ticket formats, issue IDs, branch naming, or support macros.
- Writing rules such as "preserve technical terms" or "format this as a GitHub comment."

The improvement prompt runs after transcription and before clipboard/paste/history.

## Macro Keys

TalkPro hotkeys can be bound to shortcuts such as `Ctrl+Alt+1`, `Ctrl+Alt+2`, or `Command+Option+1`.

For Razer, Logitech, Corsair, Elgato, and similar macro keyboards, configure each macro key in the vendor app to emit a normal shortcut, then bind that shortcut to a TalkPro profile. For example:

- M1 -> `Ctrl+Alt+1` -> Default profile
- M2 -> `Ctrl+Alt+2` -> Codebase profile
- M3 -> `Ctrl+Alt+3` -> Support reply profile

## Privacy

TalkPro does not ship with an API key and does not include one in the source code or release builds.

When a user enters an OpenAI API key, it is stored only in that user's local app settings on their computer. AI dictation sends recorded audio to OpenAI for transcription. AI improvement sends the transcript, vocabulary list, and improvement prompt to OpenAI. Dictation history is stored locally in the app and can be exported as JSON.

## Development

```powershell
npm install
npm run tauri:dev
```

## Build

```powershell
npm run tauri -- build
```

Windows installers are generated under:

```text
src-tauri/target/release/bundle/
```

## GitHub Releases

This repository includes a GitHub Actions workflow that builds downloadable Windows and macOS files when a tag like `v0.1.0` is pushed:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

Users can download the Windows installer or macOS disk image from the GitHub Releases page.
