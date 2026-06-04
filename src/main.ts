import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import "./styles.css";

type DictationEntry = {
  id: string;
  rawText: string;
  finalText: string;
  improved: boolean;
  model: string;
  createdAt: string;
};

type AppSettings = {
  apiKey: string;
  dictationMode: "ai" | "local";
  onboardingComplete: boolean;
  createDesktopShortcut: boolean;
  activeProfileId: string;
  profiles: DictationProfile[];
  transcriptionModel: string;
  improveWithAi: boolean;
  improvementModel: string;
  improvementPrompt: string;
  vocabulary: string;
};

type DictationProfile = {
  id: string;
  name: string;
  hotkey: string;
  transcriptionModel: string;
  improveWithAi: boolean;
  improvementModel: string;
  improvementPrompt: string;
  vocabulary: string;
};

type SpeechRecognitionConstructor = new () => SpeechRecognition;

type SpeechRecognition = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
};

type SpeechRecognitionEvent = {
  resultIndex: number;
  results: SpeechRecognitionResultList;
};

type SpeechRecognitionErrorEvent = {
  error: string;
};

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const HISTORY_KEY = "talkpro.dictationHistory.v2";
const SETTINGS_KEY = "talkpro.settings.v1";
const DOCK_POSITION_KEY = "talkpro.dockPosition.v1";
const POST_RELEASE_CAPTURE_MS = 450;
const DEFAULT_PROMPT =
  "Clean up this dictated text for accuracy, punctuation, capitalization, and readability. Use the user's vocabulary and context to preserve product names, codebase terms, file names, issue IDs, commands, APIs, acronyms, and technical wording. Expand spoken acronym phrases into uppercase acronyms when appropriate, for example \"S S H\" or \"secure shell\" can become \"SSH\", \"A P I\" can become \"API\", and \"U R L\" can become \"URL\". Do not invent facts. Return only the improved text.";

const defaultSettings: AppSettings = {
  apiKey: "",
  dictationMode: "ai",
  onboardingComplete: false,
  createDesktopShortcut: true,
  activeProfileId: "default",
  profiles: [
    {
      id: "default",
      name: "Default",
      hotkey: defaultHotkey(),
      transcriptionModel: "gpt-4o-transcribe",
      improveWithAi: true,
      improvementModel: "gpt-4o-mini",
      improvementPrompt: DEFAULT_PROMPT,
      vocabulary: "SSH, API, URL, JSON, GitHub, Tauri, OpenAI, TalkPro"
    },
    {
      id: "code",
      name: "Codebase",
      hotkey: defaultSecondaryHotkey(),
      transcriptionModel: "gpt-4o-transcribe",
      improveWithAi: true,
      improvementModel: "gpt-4o-mini",
      improvementPrompt: `${DEFAULT_PROMPT} Format the result as a concise engineering note. Preserve code symbols, commands, filenames, branches, package names, and acronyms exactly.`,
      vocabulary: "SSH, API, JSON, TypeScript, Rust, Tauri, GitHub Actions, npm, cargo, README, src-tauri"
    }
  ],
  transcriptionModel: "gpt-4o-transcribe",
  improveWithAi: true,
  improvementModel: "gpt-4o-mini",
  improvementPrompt: DEFAULT_PROMPT,
  vocabulary: "SSH, API, URL, JSON, GitHub, Tauri, OpenAI, TalkPro"
};

const app = document.querySelector<HTMLDivElement>("#app")!;
const currentWindow = getCurrentWindow();

if (!app) {
  throw new Error("App root was not found");
}

if (currentWindow.label === "dock") {
  renderDock();
} else {
  renderHome();
}

function renderHome() {
  app.innerHTML = `
    <section class="wizard" data-wizard>
      <div class="wizard-panel">
        <img src="/icon.png" alt="" class="wizard-icon" />
        <h2>Set up TalkPro</h2>
        <p>Choose how dictation should run on this computer.</p>
        <div class="choice-grid">
          <button class="choice is-selected" data-mode-choice="ai">
            <strong>AI dictation</strong>
            <span>Best accuracy. Uses your OpenAI API key from this device.</span>
          </button>
          <button class="choice" data-mode-choice="local">
            <strong>Local dictation</strong>
            <span>No API key. Uses the system speech fallback when available.</span>
          </button>
        </div>
        <div class="field">
          <label for="wizard-api-key">OpenAI API key</label>
          <input id="wizard-api-key" data-wizard-api-key type="password" autocomplete="off" placeholder="sk-..." />
          <small>Your key is stored only in this app's local settings on your computer. It is not bundled, uploaded to us, or committed to GitHub.</small>
        </div>
        <label class="toggle shortcut-toggle">
          <input data-wizard-shortcut type="checkbox" checked />
          <span>Create a desktop shortcut</span>
        </label>
        <button class="primary-button" data-finish-wizard>Start using TalkPro</button>
      </div>
    </section>

    <section class="shell">
      <header class="topbar">
        <div>
          <h1>TalkPro</h1>
          <p>Hold <span data-hotkey-label></span>, speak, release to paste.</p>
        </div>
        <div class="status" data-status>Idle</div>
      </header>

      <section class="settings-panel">
        <div class="field">
          <label for="dictation-mode">Dictation mode</label>
          <select id="dictation-mode" data-dictation-mode>
            <option value="ai">AI dictation</option>
            <option value="local">Local dictation</option>
          </select>
        </div>
        <div class="field api-field">
          <label for="api-key">OpenAI API key</label>
          <input id="api-key" data-api-key type="password" autocomplete="off" placeholder="sk-..." />
          <small>Stored only in local app settings on this computer. Open-source builds never include a key.</small>
        </div>
        <div class="field">
          <label for="transcription-model">Transcription</label>
          <select id="transcription-model" data-transcription-model>
            <option value="gpt-4o-transcribe">gpt-4o-transcribe</option>
            <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe</option>
            <option value="whisper-1">whisper-1</option>
          </select>
        </div>
        <label class="toggle">
          <input data-improve-toggle type="checkbox" />
          <span>AI improve</span>
        </label>
        <div class="field">
          <label for="profile-select">Dictation profile</label>
          <select id="profile-select" data-profile-select></select>
        </div>
        <div class="profile-actions">
          <button class="text-button" data-add-profile type="button">Add Profile</button>
        </div>
        <div class="field">
          <label for="profile-name">Profile name</label>
          <input id="profile-name" data-profile-name type="text" />
        </div>
        <div class="field">
          <label for="profile-hotkey">Profile hotkey</label>
          <input id="profile-hotkey" data-profile-hotkey type="text" placeholder="Ctrl+Alt+1" />
          <small>For Razer/Logitech M keys, map M1-M5 in Synapse or G HUB to shortcuts like Ctrl+Alt+1, then bind those here.</small>
        </div>
        <div class="field">
          <label for="improvement-model">Improve model</label>
          <input id="improvement-model" data-improvement-model type="text" />
        </div>
        <div class="field prompt-field">
          <label for="vocabulary">Vocabulary and acronyms</label>
          <textarea id="vocabulary" data-vocabulary rows="2"></textarea>
          <small>Put terms that dictation should preserve or correct, such as SSH, API, repo names, commands, customer names, product names, and acronyms.</small>
        </div>
        <div class="field prompt-field">
          <label for="improvement-prompt">Dictation improvement prompt</label>
          <textarea id="improvement-prompt" data-improvement-prompt rows="3"></textarea>
          <small>Add project context here: repo names, customer names, acronyms, commands, ticket formats, or rules for how TalkPro should rewrite your dictated text.</small>
        </div>
      </section>

      <section class="history-panel">
        <div class="panel-heading">
          <h2>Dictation History</h2>
          <div class="actions">
            <button class="text-button" data-export>Export</button>
            <button class="icon-button" data-clear title="Clear history" aria-label="Clear history">
              <span aria-hidden="true">x</span>
            </button>
          </div>
        </div>
        <ol class="history-list" data-history></ol>
      </section>
    </section>
  `;

  const settings = readSettings();
  const wizardNode = must<HTMLElement>("[data-wizard]");
  const wizardApiKeyInput = must<HTMLInputElement>("[data-wizard-api-key]");
  const wizardShortcutInput = must<HTMLInputElement>("[data-wizard-shortcut]");
  const finishWizardButton = must<HTMLButtonElement>("[data-finish-wizard]");
  const modeChoiceButtons = [...app.querySelectorAll<HTMLButtonElement>("[data-mode-choice]")];
  const hotkeyLabel = must<HTMLElement>("[data-hotkey-label]");
  const statusNode = must<HTMLElement>("[data-status]");
  const historyNode = must<HTMLOListElement>("[data-history]");
  const clearButton = must<HTMLButtonElement>("[data-clear]");
  const exportButton = must<HTMLButtonElement>("[data-export]");
  const dictationModeSelect = must<HTMLSelectElement>("[data-dictation-mode]");
  const apiKeyInput = must<HTMLInputElement>("[data-api-key]");
  const transcriptionModelSelect = must<HTMLSelectElement>("[data-transcription-model]");
  const improveToggle = must<HTMLInputElement>("[data-improve-toggle]");
  const improvementModelInput = must<HTMLInputElement>("[data-improvement-model]");
  const improvementPromptInput = must<HTMLTextAreaElement>("[data-improvement-prompt]");
  const vocabularyInput = must<HTMLTextAreaElement>("[data-vocabulary]");
  const profileSelect = must<HTMLSelectElement>("[data-profile-select]");
  const addProfileButton = must<HTMLButtonElement>("[data-add-profile]");
  const profileNameInput = must<HTMLInputElement>("[data-profile-name]");
  const profileHotkeyInput = must<HTMLInputElement>("[data-profile-hotkey]");

  hydrateHomeSettings(settings);
  renderHotkeyLabel(hotkeyLabel);
  renderHomeWizard(settings);
  renderHistory(historyNode);
  void registerProfileHotkeys(settings);

  clearButton.addEventListener("click", () => {
    writeHistory([]);
    renderHistory(historyNode);
  });

  exportButton.addEventListener("click", async () => {
    const payload = JSON.stringify(readHistory(), null, 2);
    const path = await invoke<string>("save_history_export", { json: payload });
    statusNode.textContent = "Exported";
    window.setTimeout(() => {
      statusNode.textContent = path ? "Idle" : "Idle";
    }, 1200);
  });

  [dictationModeSelect, apiKeyInput, profileNameInput, profileHotkeyInput, transcriptionModelSelect, improveToggle, improvementModelInput, vocabularyInput, improvementPromptInput].forEach(
    (element) => element.addEventListener("input", persistSettingsFromForm)
  );

  profileSelect.addEventListener("change", () => {
    const current = readSettings();
    const next: AppSettings = {
      ...current,
      activeProfileId: profileSelect.value
    };
    writeSettings(next);
    hydrateHomeSettings(next);
  });

  addProfileButton.addEventListener("click", () => {
    const current = readSettings();
    const profileNumber = current.profiles.length + 1;
    const profile: DictationProfile = {
      ...activeProfile(current),
      id: crypto.randomUUID(),
      name: `Profile ${profileNumber}`,
      hotkey: defaultProfileHotkey(profileNumber)
    };
    const next: AppSettings = {
      ...current,
      activeProfileId: profile.id,
      profiles: [...current.profiles, profile]
    };
    writeSettings(next);
    hydrateHomeSettings(next);
    void registerProfileHotkeys(next);
  });

  modeChoiceButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const next = readSettings();
      next.dictationMode = button.dataset.modeChoice === "local" ? "local" : "ai";
      writeSettings(next);
      modeChoiceButtons.forEach((item) => item.classList.toggle("is-selected", item === button));
    });
  });

  finishWizardButton.addEventListener("click", () => {
    const next = readSettings();
    next.apiKey = wizardApiKeyInput.value;
    next.createDesktopShortcut = wizardShortcutInput.checked;
    next.onboardingComplete = true;
    writeSettings(next);
    hydrateHomeSettings(next);
    renderHomeWizard(next);

    if (next.createDesktopShortcut) {
      void invoke("create_desktop_shortcut");
    }
  });

  void listen("talkpro://history-updated", () => {
    renderHistory(historyNode);
  });

  function hydrateHomeSettings(next: AppSettings) {
    const profile = activeProfile(next);
    dictationModeSelect.value = next.dictationMode;
    apiKeyInput.value = next.apiKey;
    profileSelect.innerHTML = next.profiles
      .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} - ${escapeHtml(item.hotkey)}</option>`)
      .join("");
    profileSelect.value = profile.id;
    profileNameInput.value = profile.name;
    profileHotkeyInput.value = profile.hotkey;
    transcriptionModelSelect.value = profile.transcriptionModel;
    improveToggle.checked = profile.improveWithAi;
    improvementModelInput.value = profile.improvementModel;
    vocabularyInput.value = profile.vocabulary;
    improvementPromptInput.value = profile.improvementPrompt;
  }

  function persistSettingsFromForm() {
    const current = readSettings();
    const selectedProfileId = profileSelect.value || current.activeProfileId;
    const profiles = current.profiles.map((profile) => profile.id === selectedProfileId
      ? {
          ...profile,
          name: profileNameInput.value || "Untitled",
          hotkey: normalizeHotkey(profileHotkeyInput.value),
          transcriptionModel: transcriptionModelSelect.value,
          improveWithAi: improveToggle.checked,
          improvementModel: improvementModelInput.value,
          vocabulary: vocabularyInput.value,
          improvementPrompt: improvementPromptInput.value
        }
      : profile);
    const next: AppSettings = {
      ...current,
      apiKey: apiKeyInput.value,
      dictationMode: dictationModeSelect.value === "local" ? "local" : "ai",
      activeProfileId: selectedProfileId,
      profiles
    };
    writeSettings(next);
    hydrateHomeSettings(next);
    void registerProfileHotkeys(next);
  }

  function renderHomeWizard(next: AppSettings) {
    wizardNode.classList.toggle("is-hidden", next.onboardingComplete);
    wizardApiKeyInput.value = next.apiKey;
    wizardShortcutInput.checked = next.createDesktopShortcut;
    modeChoiceButtons.forEach((button) => {
      button.classList.toggle("is-selected", button.dataset.modeChoice === next.dictationMode);
    });
  }
}

function renderDock() {
  document.body.classList.add("dock-body");
  app.innerHTML = `
    <section class="floating-dock">
      <button class="dock-grip" data-drag title="Move TalkPro dock" aria-label="Move TalkPro dock"></button>
      <div class="dock-copy">
        <span class="record-dot"></span>
        <strong data-dock-title>Ready</strong>
      </div>
      <canvas class="floating-waveform" data-waveform width="520" height="72"></canvas>
      <p data-transcript></p>
    </section>
  `;

  const dockTitleNode = must<HTMLElement>("[data-dock-title]");
  const transcriptNode = must<HTMLElement>("[data-transcript]");
  const dragButton = must<HTMLButtonElement>("[data-drag]");
  const canvas = must<HTMLCanvasElement>("[data-waveform]");
  const canvasContext = canvas.getContext("2d")!;

  let mediaStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let animationFrame = 0;
  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let localRecognition: SpeechRecognition | null = null;
  let localFinalTranscript = "";
  let localInterimTranscript = "";
  let localRecognitionEndResolver: (() => void) | null = null;
  let isRecording = false;
  let currentProfileId = readSettings().activeProfileId;

  void restoreDockPosition();
  drawIdleWaveform();
  void registerProfileHotkeys(readSettings());

  dragButton.addEventListener("mousedown", async () => {
    await currentWindow.startDragging();
    await saveDockPosition();
  });

  app.addEventListener("dblclick", async () => {
    const main = await Window.getByLabel("main");
    await main?.show();
    await main?.setFocus();
  });

  void listen<string>("talkpro://record-start", (event) => {
    void startDictation(event.payload);
  });

  void listen("talkpro://record-stop", () => {
    void stopDictation();
  });

  async function startDictation(profileId: string) {
    if (isRecording) return;

    const settings = readSettings();
    const profile = activeProfile(settings, profileId);
    currentProfileId = profile.id;
    await restoreDockPosition();
    await currentWindow.show();
    setDockLoading(false);

    if (settings.dictationMode === "ai" && !settings.apiKey.trim()) {
      dockTitleNode.textContent = "API key needed";
      transcriptNode.textContent = "Double-click to open settings.";
      return;
    }

    isRecording = true;
    audioChunks = [];
    transcriptNode.textContent = "";
    dockTitleNode.textContent = profile.name;

    try {
      if (settings.dictationMode === "local") {
        await startWaveform();
        startLocalRecognition();
      } else {
        await startAudioCapture();
      }
    } catch (error) {
      isRecording = false;
      dockTitleNode.textContent = "Mic unavailable";
      transcriptNode.textContent = error instanceof Error ? error.message : "Unable to access microphone.";
    }
  }

  async function stopDictation() {
    if (!isRecording) return;

    const settings = readSettings();
    const profile = activeProfile(settings, currentProfileId);
    isRecording = false;
    dockTitleNode.textContent = "Finishing";
    await delay(POST_RELEASE_CAPTURE_MS);

    if (settings.dictationMode === "local") {
      const text = normalizeTranscript(await stopLocalRecognition());
      stopWaveform();
      await pasteAndRemember(text, text, false, `${profile.name} / local`);
      return;
    }

    const audioBlob = await stopAudioCapture();
    if (!audioBlob || audioBlob.size === 0) {
      finishDock("No audio");
      return;
    }

    try {
      dockTitleNode.textContent = "Transcribing";
      setDockLoading(true);
      const rawText = normalizeTranscript(await transcribeAudio(audioBlob, settings, profile));
      if (!rawText) {
        setDockLoading(false);
        finishDock("No speech");
        return;
      }

      let finalText = rawText;
      let improved = false;
      if (profile.improveWithAi) {
        dockTitleNode.textContent = "Improving";
        transcriptNode.textContent = "Applying your dictation improvement prompt...";
        finalText = normalizeTranscript(await improveText(rawText, settings, profile));
        improved = finalText !== rawText;
      }

      setDockLoading(false);
      await pasteAndRemember(rawText, finalText, improved, `${profile.name} / ${profile.transcriptionModel}`);
    } catch (error) {
      setDockLoading(false);
      dockTitleNode.textContent = "Error";
      transcriptNode.textContent = error instanceof Error ? error.message : "Dictation failed.";
    }
  }

  async function startAudioCapture() {
    await startWaveform();
    if (!mediaStream) {
      throw new Error("Unable to access microphone.");
    }

    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: chooseMimeType() });
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };
    mediaRecorder.start();
  }

  async function startWaveform() {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioContext.createMediaStreamSource(mediaStream).connect(analyser);
    drawWaveform();
  }

  function stopAudioCapture() {
    return new Promise<Blob | null>((resolve) => {
      const recorder = mediaRecorder;
      stopWaveform();

      if (!recorder || recorder.state === "inactive") {
        resolve(null);
        return;
      }

      recorder.onstop = () => {
        const type = recorder.mimeType || "audio/webm";
        const blob = new Blob(audioChunks, { type });
        mediaRecorder = null;
        audioChunks = [];
        resolve(blob);
      };
      recorder.stop();
    });
  }

  function startLocalRecognition() {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      throw new Error("Local dictation is not available. Switch to AI dictation.");
    }

    localFinalTranscript = "";
    localInterimTranscript = "";
    localRecognition = new Recognition();
    localRecognition.continuous = true;
    localRecognition.interimResults = true;
    localRecognition.maxAlternatives = 1;
    localRecognition.lang = "en-US";
    localRecognition.onresult = (event) => {
      localInterimTranscript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const phrase = result[0]?.transcript ?? "";
        if (result.isFinal) {
          localFinalTranscript = `${localFinalTranscript} ${phrase}`;
        } else {
          localInterimTranscript = `${localInterimTranscript} ${phrase}`;
        }
      }
      transcriptNode.textContent = normalizeTranscript(`${localFinalTranscript} ${localInterimTranscript}`);
    };
    localRecognition.onerror = (event) => {
      dockTitleNode.textContent = `Speech error: ${event.error}`;
    };
    localRecognition.onend = () => {
      if (isRecording) {
        localRecognition?.start();
        return;
      }
      localRecognitionEndResolver?.();
      localRecognitionEndResolver = null;
    };
    localRecognition.start();
  }

  function stopLocalRecognition() {
    const activeRecognition = localRecognition;
    if (!activeRecognition) return Promise.resolve("");

    return new Promise<string>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        localRecognitionEndResolver = null;
        resolve(`${localFinalTranscript} ${localInterimTranscript}`);
      };

      localRecognitionEndResolver = finish;
      try {
        activeRecognition.stop();
      } catch {
        finish();
      }
      window.setTimeout(finish, 1800);
    });
  }

  async function pasteAndRemember(rawText: string, finalText: string, improved: boolean, model: string) {
    if (!finalText) {
      finishDock("No speech");
      return;
    }

    const history = readHistory();
    history.unshift({
      id: crypto.randomUUID(),
      rawText,
      finalText,
      improved,
      model,
      createdAt: new Date().toISOString()
    });
    writeHistory(history);
    await emit("talkpro://history-updated");

    transcriptNode.textContent = finalText;
    dockTitleNode.textContent = "Copying";
    await invoke("paste_text", { text: finalText });
    finishDock("Pasted");
  }

  function finishDock(message: string) {
    setDockLoading(false);
    dockTitleNode.textContent = message;
    window.setTimeout(() => {
      if (!isRecording) {
        void currentWindow.hide();
        drawIdleWaveform();
      }
    }, 900);
  }

  function setDockLoading(isLoading: boolean) {
    document.body.classList.toggle("is-loading", isLoading);
  }

  function stopWaveform() {
    cancelAnimationFrame(animationFrame);
    mediaStream?.getTracks().forEach((track) => track.stop());
    void audioContext?.close();
    mediaStream = null;
    audioContext = null;
    analyser = null;
  }

  function drawWaveform() {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    paintWaveform(data);
    animationFrame = requestAnimationFrame(drawWaveform);
  }

  function drawIdleWaveform() {
    const data = new Uint8Array(128);
    data.fill(128);
    paintWaveform(data);
  }

  function paintWaveform(data: Uint8Array) {
    const { width, height } = canvas;
    canvasContext.clearRect(0, 0, width, height);
    canvasContext.lineWidth = 3;
    canvasContext.lineCap = "round";
    canvasContext.strokeStyle = "#6df7d2";
    canvasContext.beginPath();
    const slice = width / Math.max(data.length - 1, 1);
    data.forEach((value, index) => {
      const x = index * slice;
      const y = (value / 255) * height;
      if (index === 0) canvasContext.moveTo(x, y);
      else canvasContext.lineTo(x, y);
    });
    canvasContext.stroke();
  }

  async function restoreDockPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem(DOCK_POSITION_KEY) ?? "null") as { x: number; y: number } | null;
      if (saved) {
        await currentWindow.setPosition(new LogicalPosition(saved.x, saved.y));
      }
    } catch {
      // Ignore invalid saved positions.
    }
  }

  async function saveDockPosition() {
    const position = await currentWindow.outerPosition();
    const factor = await currentWindow.scaleFactor();
    const logical = position.toLogical(factor);
    localStorage.setItem(DOCK_POSITION_KEY, JSON.stringify({ x: logical.x, y: logical.y }));
  }
}

async function transcribeAudio(audioBlob: Blob, settings: AppSettings, profile: DictationProfile) {
  const audioBase64 = await blobToBase64(audioBlob);
  return await invoke<string>("transcribe_audio", {
    request: {
      apiKey: settings.apiKey.trim(),
      model: profile.transcriptionModel,
      audioBase64,
      fileName: `talkpro-${Date.now()}.${extensionForMime(audioBlob.type)}`,
      mimeType: audioBlob.type || "audio/webm"
    }
  });
}

async function improveText(text: string, settings: AppSettings, profile: DictationProfile) {
  const vocabulary = profile.vocabulary.trim()
    ? `\n\nUser vocabulary and acronym list:\n${profile.vocabulary.trim()}`
    : "";

  return await invoke<string>("improve_text", {
    request: {
      apiKey: settings.apiKey.trim(),
      model: profile.improvementModel.trim() || defaultSettings.profiles[0].improvementModel,
      prompt: `${profile.improvementPrompt.trim() || DEFAULT_PROMPT}${vocabulary}`,
      text
    }
  });
}

function renderHistory(historyNode: HTMLOListElement) {
  const history = readHistory();
  if (history.length === 0) {
    historyNode.innerHTML = `<li class="empty">No dictation yet.</li>`;
    return;
  }

  historyNode.innerHTML = history
    .map((entry) => {
      const date = new Date(entry.createdAt);
      const raw = entry.improved && entry.rawText !== entry.finalText
        ? `<details><summary>Raw transcript</summary><p>${escapeHtml(entry.rawText)}</p></details>`
        : "";
      return `
        <li class="history-entry">
          <time datetime="${entry.createdAt}">${date.toLocaleString()} - ${escapeHtml(entry.model)}</time>
          <p>${escapeHtml(entry.finalText)}</p>
          ${raw}
        </li>
      `;
    })
    .join("");
}

function renderHotkeyLabel(node: HTMLElement) {
  const settings = readSettings();
  node.innerHTML = settings.profiles
    .map((profile) => `<kbd>${escapeHtml(profile.name)}</kbd> ${escapeHtml(profile.hotkey)}`)
    .join(" ");
}

function readHistory(): DictationEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) as DictationEntry[] : [];
  } catch {
    return [];
  }
}

function writeHistory(history: DictationEntry[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function readSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return migrateSettings(raw ? { ...defaultSettings, ...JSON.parse(raw) as Partial<AppSettings> } : defaultSettings);
  } catch {
    return defaultSettings;
  }
}

function writeSettings(settings: AppSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function migrateSettings(settings: AppSettings): AppSettings {
  if (settings.profiles?.length) {
    return settings;
  }

  const profile: DictationProfile = {
    id: "default",
    name: "Default",
    hotkey: defaultHotkey(),
    transcriptionModel: settings.transcriptionModel,
    improveWithAi: settings.improveWithAi,
    improvementModel: settings.improvementModel,
    improvementPrompt: settings.improvementPrompt,
    vocabulary: settings.vocabulary
  };

  return {
    ...settings,
    activeProfileId: profile.id,
    profiles: [profile]
  };
}

function activeProfile(settings: AppSettings, profileId = settings.activeProfileId) {
  return settings.profiles.find((profile) => profile.id === profileId)
    ?? settings.profiles[0]
    ?? defaultSettings.profiles[0];
}

async function registerProfileHotkeys(settings: AppSettings) {
  await invoke("register_hotkeys", {
    profiles: settings.profiles.map((profile) => ({
      id: profile.id,
      hotkey: normalizeHotkey(profile.hotkey)
    }))
  });
}

function normalizeHotkey(value: string) {
  return value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("+");
}

function defaultHotkey() {
  return navigator.platform.toLowerCase().includes("mac") ? "Command+Option+1" : "Ctrl+Alt+1";
}

function defaultSecondaryHotkey() {
  return navigator.platform.toLowerCase().includes("mac") ? "Command+Option+2" : "Ctrl+Alt+2";
}

function defaultProfileHotkey(profileNumber: number) {
  const key = Math.min(Math.max(profileNumber, 1), 9);
  return navigator.platform.toLowerCase().includes("mac") ? `Command+Option+${key}` : `Ctrl+Alt+${key}`;
}

function chooseMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/wav"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function extensionForMime(mimeType: string) {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg")) return "mp3";
  return "webm";
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function normalizeTranscript(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    };
    return entities[character];
  });
}

function must<T extends Element>(selector: string) {
  const element = app?.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}
