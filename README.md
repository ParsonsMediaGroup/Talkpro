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

## Profile Examples

Profiles let each hotkey behave like a different dictation assistant. A user can hold one hotkey for normal writing, another for codebase-aware notes, another for translation, and another for polished email replies.

Example profile setup:

| Profile | Hotkey | Prompt idea |
| --- | --- | --- |
| Default | `Ctrl+Alt` | Clean up punctuation and capitalization. Preserve the speaker's meaning. Return only the improved text. |
| Spanish Translator | `Ctrl+Alt+1` | Translate everything I dictate from English into natural Spanish. Keep names, numbers, product terms, and code terms unchanged unless translation is clearly appropriate. Return only Spanish text. |
| Email Writer | `Ctrl+Alt+2` | Rewrite my dictation as a clear, professional email. Keep it concise, polite, and action-oriented. Add a subject line only if I ask for one. |
| Codebase Notes | `Ctrl+Alt+3` | Format my dictation as an engineering note. Preserve file paths, branch names, commands, functions, APIs, acronyms, and ticket IDs. Use the vocabulary and project context below. |
| Support Persona | `Ctrl+Alt+4` | Rewrite my dictation as a helpful customer support reply. Keep it friendly, direct, and easy to understand. Do not overpromise. |
| Executive Summary | `Ctrl+Alt+5` | Turn my dictation into a concise executive summary with decisions, blockers, and next steps. |

More examples:

- Translate dictated English into Spanish, French, or another language before pasting.
- Create a "strict punctuation" profile for legal, operations, or documentation work.
- Create a "casual voice" profile for chat messages.
- Create a "support reply" profile that follows company tone and escalation rules.
- Create a "codebase" profile that knows project names, common files, CLI commands, API names, branch formats, and internal acronyms from the profile prompt and vocabulary field.
- Create persona-based profiles, such as concise, friendly, technical, executive, sales, or support.

For codebase-specific dictation, put the relevant context directly in the profile prompt or vocabulary field, for example:

```text
This profile is for the TalkPro codebase. Preserve TypeScript, Rust, Tauri, src/main.ts, src-tauri/src/lib.rs, tauri.conf.json, npm, cargo, GitHub Actions, OpenAI, SSH, API, JSON, MSI, and NSIS. If I mention a file, keep the exact file path format when possible. Return only the cleaned-up text.
```

## Macro Keys

TalkPro hotkeys can be bound to shortcuts such as `Ctrl+Alt+1`, `Ctrl+Alt+2`, or `Command+Option+1`.

For Razer, Logitech, Corsair, Elgato, and similar macro keyboards, configure each macro key in the vendor app to emit a normal shortcut, then bind that shortcut to a TalkPro profile. For example:

- M1 -> `Ctrl+Alt+1` -> Default profile
- M2 -> `Ctrl+Alt+2` -> Codebase profile
- M3 -> `Ctrl+Alt+3` -> Support reply profile

## Privacy

TalkPro does not ship with an API key and does not include one in the source code or release builds.

When a user enters an OpenAI API key, it is stored only in that user's local app settings on their computer. AI dictation sends recorded audio to OpenAI for transcription. AI improvement sends the transcript, vocabulary list, and improvement prompt to OpenAI. Dictation history is stored locally in the app and can be exported as JSON.

## Security Warnings

TalkPro is open source. Early builds are unsigned, so antivirus or endpoint security tools may warn because the app uses global hotkeys, microphone access, clipboard access, and optional auto-paste. These behaviors are required for desktop dictation.

If you are unsure, review the source code, build it locally, or ask someone technical to audit it before running a downloaded binary.

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
