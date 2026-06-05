import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow, monitorFromPoint, primaryMonitor, Window } from "@tauri-apps/api/window";
import "./styles.css";

type DictationEntry = {
  id: string;
  rawText: string;
  finalText: string;
  improved: boolean;
  model: string;
  createdAt: string;
  estimatedCostUsd?: number;
};

type MonitorWorkArea = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type AppSettings = {
  settingsVersion: number;
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
  dictationMode: "ai" | "local";
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
const DOCK_MONITOR_POSITIONS_KEY = "talkpro.dockMonitorPositions.v1";
const POST_RELEASE_CAPTURE_MS = 450;
const LEGACY_DEFAULT_PROMPT =
  "Clean up this dictated text for accuracy, punctuation, capitalization, and readability. Use the user's vocabulary and context to preserve product names, codebase terms, file names, issue IDs, commands, APIs, acronyms, and technical wording. Expand spoken acronym phrases into uppercase acronyms when appropriate, for example \"S S H\" or \"secure shell\" can become \"SSH\", \"A P I\" can become \"API\", and \"U R L\" can become \"URL\". Do not invent facts. Return only the improved text.";
const DEFAULT_PROMPT =
  "Clean up this dictation for punctuation, capitalization, and readability. Preserve the speaker's meaning, names, acronyms, numbers, and technical terms. Return only the improved text.";
const CODEBASE_PROMPT =
  "Clean up this dictation as an engineering note. Preserve code symbols, commands, filenames, branches, package names, issue IDs, APIs, acronyms, and exact technical wording. Return only the improved text.";

const defaultSettings: AppSettings = {
  settingsVersion: 5,
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
      dictationMode: "ai",
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
      dictationMode: "ai",
      transcriptionModel: "gpt-4o-transcribe",
      improveWithAi: true,
      improvementModel: "gpt-4o-mini",
      improvementPrompt: CODEBASE_PROMPT,
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

      <nav class="tabs" aria-label="TalkPro sections">
        <button class="tab is-active" data-tab="history" type="button">History</button>
        <button class="tab" data-tab="dictation" type="button">Dictation</button>
        <button class="tab" data-tab="profiles" type="button">Profiles</button>
        <button class="tab" data-tab="settings" type="button">Settings</button>
        <button class="tab" data-tab="diagnostics" type="button">Diagnostics</button>
      </nav>

      <section class="history-panel tab-panel is-active" data-tab-panel="history">
        <div class="cost-summary" data-cost-summary></div>
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

      <section class="settings-panel tab-panel" data-tab-panel="dictation">
        <div class="section-heading">
          <h2>Dictation</h2>
          <p>Choose local or AI dictation, then hold a hotkey or the manual button.</p>
        </div>
        <div class="diagnostics-bar">
          <span>Manual dictation test</span>
          <div class="diagnostics-actions">
            <button class="text-button compact-button" data-test-mic type="button">Test microphone</button>
            <button class="text-button compact-button" data-hold-dictation type="button">Hold to dictate</button>
          </div>
        </div>
        <div class="field">
          <label for="dictation-mode">Dictation mode</label>
          <select id="dictation-mode" data-dictation-mode>
            <option value="ai">AI dictation</option>
            <option value="local">Local dictation</option>
          </select>
        </div>
      </section>

      <section class="settings-panel tab-panel" data-tab-panel="profiles">
        <div class="section-heading">
          <h2>Profiles</h2>
          <p>Profiles can use different hotkeys, prompts, models, and vocabulary.</p>
        </div>
        <div class="profile-section is-active" data-profile-section-panel="profiles">
          <div class="section-heading compact-heading">
            <h2>Profile</h2>
            <p>Select a profile, set its hotkey, and name it.</p>
          </div>
          <div class="field">
            <label for="profile-select">Active profile</label>
            <select id="profile-select" data-profile-select></select>
          </div>
          <div class="profile-actions">
            <button class="text-button" data-add-profile type="button">Add Profile</button>
            <button class="text-button danger-button" data-delete-profile type="button">Delete Profile</button>
          </div>
          <div class="profile-list" data-profile-list></div>
          <div class="field">
            <label for="profile-name">Profile name</label>
            <input id="profile-name" data-profile-name type="text" />
          </div>
          <div class="field">
            <label for="profile-hotkey">Profile hotkey</label>
            <div class="hotkey-recorder">
              <input id="profile-hotkey" data-profile-hotkey type="text" placeholder="Ctrl+Win+1" />
              <button class="text-button" data-record-hotkey type="button">Record</button>
            </div>
            <small data-hotkey-status>Click Record, press a shortcut, then release. Hotkeys must be unique across profiles.</small>
          </div>
          <div class="profile-inline-notice">
            <strong>Dictation type and AI prompt are below.</strong>
            <span>Use the Models and AI Prompt sections to configure the selected profile.</span>
          </div>
        </div>
        <div class="profile-section is-active" data-profile-section-panel="models">
          <div class="section-heading compact-heading">
            <h2>Dictation Type</h2>
            <p>This selected profile can use local or AI dictation independently.</p>
          </div>
          <div class="field">
            <label for="profile-dictation-mode">Dictation mode for this profile</label>
            <select id="profile-dictation-mode" data-profile-dictation-mode>
              <option value="ai">AI dictation</option>
              <option value="local">Local dictation</option>
            </select>
            <small>Each profile can use local dictation or AI dictation independently.</small>
          </div>
          <div class="field">
            <label for="transcription-model">Transcription model</label>
            <select id="transcription-model" data-transcription-model>
              <option value="gpt-4o-transcribe">gpt-4o-transcribe</option>
              <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe</option>
              <option value="whisper-1">whisper-1</option>
            </select>
          </div>
          <div class="field">
            <label for="improvement-model">Improve model</label>
            <select id="improvement-model" data-improvement-model>
              <option value="gpt-4o-mini">gpt-4o-mini</option>
              <option value="gpt-4o">gpt-4o</option>
            </select>
          </div>
          <label class="toggle">
            <input data-improve-toggle type="checkbox" />
            <span>AI improve</span>
          </label>
        </div>
        <div class="profile-section is-active" data-profile-section-panel="prompt">
          <div class="section-heading compact-heading">
            <h2>AI Prompt</h2>
            <p>Edit the improvement prompt sent for this selected profile.</p>
          </div>
          <textarea data-vocabulary class="is-hidden" rows="1"></textarea>
          <div class="prompt-banner">
            <strong data-prompt-profile-name>Selected profile</strong>
            <span>This prompt is sent only when this profile has AI improve enabled.</span>
          </div>
          <div class="field prompt-field">
            <label for="improvement-prompt">Dictation improvement prompt</label>
            <textarea id="improvement-prompt" data-improvement-prompt rows="6"></textarea>
            <small>Add project context here: repo names, customer names, acronyms, commands, ticket formats, or rules for how TalkPro should rewrite your dictated text.</small>
          </div>
        </div>
      </section>

      <section class="settings-panel tab-panel" data-tab-panel="settings">
        <div class="section-heading">
          <h2>Settings</h2>
          <p>API keys stay on this computer. Open-source builds never include a key.</p>
        </div>
        <div class="field api-field">
          <label for="api-key">OpenAI API key</label>
          <input id="api-key" data-api-key type="password" autocomplete="off" placeholder="sk-..." />
          <small>Stored only in local app settings on this computer. Open-source builds never include a key.</small>
        </div>
        <label class="toggle setting-toggle">
          <input data-run-on-login type="checkbox" />
          <span>Run TalkPro when I log in</span>
        </label>
        <div class="macro-help">
          <strong>Advanced macro setup</strong>
          <span>M1-M5 keys usually need to be assigned in Synapse, G HUB, Stream Deck, or your keyboard software first. Set them to normal shortcuts, then use the same shortcut in each TalkPro profile.</span>
        </div>
      </section>

      <section class="settings-panel tab-panel" data-tab-panel="diagnostics">
        <div class="section-heading">
          <h2>Diagnostics</h2>
          <p>Use this when hotkeys, microphone permissions, or AI requests need troubleshooting.</p>
        </div>
        <div class="diagnostics-bar">
          <span data-diagnostics-path>Diagnostics log loading...</span>
          <div class="diagnostics-actions">
            <button class="text-button compact-button" data-test-mic type="button">Test microphone</button>
            <button class="text-button compact-button" data-hold-dictation type="button">Hold to dictate</button>
          </div>
        </div>
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
  const diagnosticsPathNode = must<HTMLElement>("[data-diagnostics-path]");
  const tabButtons = [...app.querySelectorAll<HTMLButtonElement>("[data-tab]")];
  const tabPanels = [...app.querySelectorAll<HTMLElement>("[data-tab-panel]")];
  const testMicButtons = [...app.querySelectorAll<HTMLButtonElement>("[data-test-mic]")];
  const holdDictationButtons = [...app.querySelectorAll<HTMLButtonElement>("[data-hold-dictation]")];
  const historyNode = must<HTMLOListElement>("[data-history]");
  const costSummaryNode = must<HTMLElement>("[data-cost-summary]");
  const clearButton = must<HTMLButtonElement>("[data-clear]");
  const exportButton = must<HTMLButtonElement>("[data-export]");
  const dictationModeSelect = must<HTMLSelectElement>("[data-dictation-mode]");
  const apiKeyInput = must<HTMLInputElement>("[data-api-key]");
  const runOnLoginInput = must<HTMLInputElement>("[data-run-on-login]");
  const profileDictationModeSelect = must<HTMLSelectElement>("[data-profile-dictation-mode]");
  const transcriptionModelSelect = must<HTMLSelectElement>("[data-transcription-model]");
  const improveToggle = must<HTMLInputElement>("[data-improve-toggle]");
  const improvementModelInput = must<HTMLInputElement>("[data-improvement-model]");
  const improvementPromptInput = must<HTMLTextAreaElement>("[data-improvement-prompt]");
  const vocabularyInput = must<HTMLTextAreaElement>("[data-vocabulary]");
  const profileSelect = must<HTMLSelectElement>("[data-profile-select]");
  const profileListNode = must<HTMLElement>("[data-profile-list]");
  const profileSubtabButtons = [...app.querySelectorAll<HTMLButtonElement>("[data-profile-section]")];
  const addProfileButton = must<HTMLButtonElement>("[data-add-profile]");
  const deleteProfileButton = must<HTMLButtonElement>("[data-delete-profile]");
  const recordHotkeyButton = must<HTMLButtonElement>("[data-record-hotkey]");
  const hotkeyStatus = must<HTMLElement>("[data-hotkey-status]");
  const promptProfileName = must<HTMLElement>("[data-prompt-profile-name]");
  const profileNameInput = must<HTMLInputElement>("[data-profile-name]");
  const profileHotkeyInput = must<HTMLInputElement>("[data-profile-hotkey]");
  let isRecordingHotkey = false;
  let hotkeyRecorderTimeout = 0;
  let lastValidHotkey = "";

  hydrateHomeSettings(settings);
  void hydrateDiagnosticsPath(diagnosticsPathNode);
  renderHotkeyLabel(hotkeyLabel);
  renderHomeWizard(settings);
  renderHistory(historyNode);
  renderCostSummary(costSummaryNode, settings);
  void hydrateRunOnLogin(runOnLoginInput);
  void registerProfileHotkeys(settings);

  clearButton.addEventListener("click", () => {
    writeHistory([]);
    renderHistory(historyNode);
    renderCostSummary(costSummaryNode, readSettings());
  });

  historyNode.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-copy-entry]");
    if (!button) return;
    const entry = readHistory().find((item) => item.id === button.dataset.copyEntry);
    if (!entry) return;
    await invoke("copy_text", { text: entry.finalText });
    statusNode.textContent = "Copied";
    window.setTimeout(() => {
      if (statusNode.textContent === "Copied") statusNode.textContent = "Idle";
    }, 1000);
  });

  exportButton.addEventListener("click", async () => {
    const payload = JSON.stringify(readHistory(), null, 2);
    const path = await invoke<string>("save_history_export", { json: payload });
    statusNode.textContent = "Exported";
    window.setTimeout(() => {
      statusNode.textContent = path ? "Idle" : "Idle";
    }, 1200);
  });

  [dictationModeSelect, apiKeyInput, profileNameInput, profileHotkeyInput, profileDictationModeSelect, transcriptionModelSelect, improveToggle, improvementModelInput, vocabularyInput, improvementPromptInput].forEach(
    (element) => element.addEventListener("input", () => persistSettingsFromForm(element === profileHotkeyInput))
  );

  runOnLoginInput.addEventListener("change", async () => {
    const enabled = runOnLoginInput.checked;
    try {
      await invoke("set_run_on_login", { enabled });
      statusNode.textContent = enabled ? "Starts on login" : "Login start off";
    } catch (error) {
      runOnLoginInput.checked = !enabled;
      statusNode.textContent = "Startup update failed";
      void logClientEvent(`run_on_login error=${error instanceof Error ? error.message : String(error)}`);
    }
  });

  profileSelect.addEventListener("change", () => {
    const current = readSettings();
    const next: AppSettings = {
      ...current,
      activeProfileId: profileSelect.value
    };
    writeSettings(next);
    hydrateHomeSettings(next);
    renderCostSummary(costSummaryNode, next);
  });

  profileSubtabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      profileSubtabButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    });
  });

  profileListNode.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-select-profile]");
    if (!button) return;
    const current = readSettings();
    const next: AppSettings = {
      ...current,
      activeProfileId: button.dataset.selectProfile ?? current.activeProfileId
    };
    writeSettings(next);
    hydrateHomeSettings(next);
    renderCostSummary(costSummaryNode, next);
  });

  addProfileButton.addEventListener("click", () => {
    const current = readSettings();
    const profileNumber = current.profiles.length + 1;
    const profile: DictationProfile = {
      ...activeProfile(current),
      id: crypto.randomUUID(),
      name: `Profile ${profileNumber}`,
      dictationMode: activeProfile(current).dictationMode ?? current.dictationMode,
      hotkey: defaultProfileHotkey(profileNumber)
    };
    const next: AppSettings = {
      ...current,
      activeProfileId: profile.id,
      profiles: [...current.profiles, profile]
    };
    writeSettings(next);
    hydrateHomeSettings(next);
    renderCostSummary(costSummaryNode, next);
    void registerProfileHotkeys(next);
  });

  deleteProfileButton.addEventListener("click", () => {
    deleteActiveProfile();
  });

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab ?? "history";
      tabButtons.forEach((item) => item.classList.toggle("is-active", item === button));
      tabPanels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.tabPanel === tab));
    });
  });

  testMicButtons.forEach((button) => button.addEventListener("click", async () => {
    statusNode.textContent = "Testing mic";
    try {
      void logClientEvent("home test microphone begin");
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone capture is not available in this WebView.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tracks = stream.getAudioTracks();
      tracks.forEach((track) => track.stop());
      statusNode.textContent = tracks.length ? "Mic allowed" : "No mic";
      void logClientEvent(`home test microphone ok tracks=${tracks.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Microphone test failed.";
      statusNode.textContent = "Mic blocked";
      void logClientEvent(`home test microphone error=${message}`);
    }
  }));

  holdDictationButtons.forEach((button) => button.addEventListener("pointerdown", async (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    statusNode.textContent = "Dictating";
    const profileId = readSettings().activeProfileId;
    void logClientEvent(`manual hold dictation start profile=${profileId}`);
    await emit("talkpro://record-start", profileId);
  }));

  const stopManualDictation = async () => {
    if (statusNode.textContent !== "Dictating") return;
    statusNode.textContent = "Finishing";
    void logClientEvent("manual hold dictation stop");
    await emit("talkpro://record-stop");
    window.setTimeout(() => {
      if (statusNode.textContent === "Finishing") statusNode.textContent = "Idle";
    }, 1200);
  };

  holdDictationButtons.forEach((button) => {
    button.addEventListener("pointerup", () => {
      void stopManualDictation();
    });
    button.addEventListener("pointercancel", () => {
      void stopManualDictation();
    });
  });

  recordHotkeyButton.addEventListener("click", () => {
    isRecordingHotkey = true;
    recordHotkeyButton.textContent = "Press keys";
    profileHotkeyInput.value = "";
    hotkeyStatus.textContent = "Listening. Press a full shortcut now. If an M key does nothing here, map it in Synapse or G HUB first.";
    profileHotkeyInput.focus();
    window.clearTimeout(hotkeyRecorderTimeout);
    hotkeyRecorderTimeout = window.setTimeout(() => {
      if (!isRecordingHotkey) return;
      isRecordingHotkey = false;
      recordHotkeyButton.textContent = "Record";
      hotkeyStatus.textContent = "No usable key event was received. Map M1-M5 to Ctrl+Win+1 through Ctrl+Win+5, then try Record again.";
    }, 7000);
  });

  window.addEventListener("keydown", (event) => {
    if (!isRecordingHotkey) return;

    event.preventDefault();
    event.stopPropagation();

    const hotkey = hotkeyFromKeyboardEvent(event);
    void logClientEvent(`hotkey_recorder key=${event.key} code=${event.code} ctrl=${event.ctrlKey} alt=${event.altKey} shift=${event.shiftKey} meta=${event.metaKey} result=${hotkey || "none"}`);
    if (!hotkey) return;

    profileHotkeyInput.value = hotkey;
    isRecordingHotkey = false;
    window.clearTimeout(hotkeyRecorderTimeout);
    recordHotkeyButton.textContent = "Record";
    hotkeyStatus.textContent = `Recorded ${hotkey}.`;
    persistSettingsFromForm(true);
  }, true);

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
    renderCostSummary(costSummaryNode, next);
    renderHomeWizard(next);

    if (next.createDesktopShortcut) {
      void invoke("create_desktop_shortcut");
    }
  });

  void listen("talkpro://history-updated", () => {
    renderHistory(historyNode);
    renderCostSummary(costSummaryNode, readSettings());
  });

  function hydrateHomeSettings(next: AppSettings) {
    const profile = activeProfile(next);
    dictationModeSelect.value = next.dictationMode;
    apiKeyInput.value = next.apiKey;
    profileSelect.innerHTML = next.profiles
      .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} - ${escapeHtml(item.hotkey)}</option>`)
      .join("");
    profileSelect.value = profile.id;
    profileListNode.innerHTML = renderProfileList(next);
    profileNameInput.value = profile.name;
    promptProfileName.textContent = `${profile.name} prompt`;
    profileHotkeyInput.value = profile.hotkey;
    lastValidHotkey = normalizeHotkey(profile.hotkey);
    profileDictationModeSelect.value = profile.dictationMode ?? next.dictationMode;
    transcriptionModelSelect.value = profile.transcriptionModel;
    improveToggle.checked = profile.improveWithAi;
    improvementModelInput.value = profile.improvementModel;
    vocabularyInput.value = profile.vocabulary;
    improvementPromptInput.value = profile.improvementPrompt;
  }

  function persistSettingsFromForm(validateHotkey = false) {
    const current = readSettings();
    const selectedProfileId = profileSelect.value || current.activeProfileId;
    const normalizedHotkey = normalizeHotkey(profileHotkeyInput.value);

    if (validateHotkey) {
      const duplicateProfile = current.profiles.find((profile) =>
        profile.id !== selectedProfileId && normalizeHotkey(profile.hotkey).toLowerCase() === normalizedHotkey.toLowerCase()
      );

      if (duplicateProfile) {
        hotkeyStatus.textContent = `${normalizedHotkey} is already used by ${duplicateProfile.name}. Choose a different hotkey.`;
        profileHotkeyInput.setCustomValidity("This hotkey is already used by another profile.");
        profileHotkeyInput.reportValidity();
        profileHotkeyInput.value = lastValidHotkey;
        return;
      }

      lastValidHotkey = normalizedHotkey;
      profileHotkeyInput.setCustomValidity("");
      hotkeyStatus.textContent = normalizedHotkey ? `Hotkey: ${normalizedHotkey}` : "Enter or record a hotkey.";
    }

    profileHotkeyInput.setCustomValidity("");

    const profileDictationMode: "ai" | "local" = profileDictationModeSelect.value === "local" ? "local" : "ai";
    const profiles = current.profiles.map((profile) => profile.id === selectedProfileId
      ? {
          ...profile,
          name: profileNameInput.value || "Untitled",
          hotkey: normalizedHotkey,
          dictationMode: profileDictationMode,
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

  function deleteActiveProfile() {
    const current = readSettings();
    if (current.profiles.length <= 1) {
      statusNode.textContent = "Keep one profile";
      window.setTimeout(() => {
        if (statusNode.textContent === "Keep one profile") statusNode.textContent = "Idle";
      }, 1200);
      return;
    }

    const selectedProfileId = profileSelect.value || current.activeProfileId;
    const profiles = current.profiles.filter((profile) => profile.id !== selectedProfileId);
    const next: AppSettings = {
      ...current,
      activeProfileId: profiles[0].id,
      profiles
    };
    writeSettings(next);
    hydrateHomeSettings(next);
    renderCostSummary(costSummaryNode, next);
    renderHotkeyLabel(hotkeyLabel);
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
  document.documentElement.classList.add("dock-html");
  document.body.classList.add("dock-body");
  app.innerHTML = `
    <section class="floating-dock" title="Click to open TalkPro">
      <div class="dock-copy">
        <span class="record-dot"></span>
        <strong data-dock-title>Ready</strong>
      </div>
      <canvas class="floating-waveform" data-waveform width="520" height="72"></canvas>
      <button class="dock-menu-button" data-open-home data-no-drag title="Open TalkPro settings" aria-label="Open TalkPro settings">...</button>
      <p data-transcript></p>
    </section>
  `;

  const dockNode = must<HTMLElement>(".floating-dock");
  const dockTitleNode = must<HTMLElement>("[data-dock-title]");
  const transcriptNode = must<HTMLElement>("[data-transcript]");
  const openHomeButton = must<HTMLButtonElement>("[data-open-home]");
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
  let isFinishingDictation = false;
  let recordingStartedAt = 0;
  let currentProfileId = readSettings().activeProfileId;
  let dragState: {
    pointerId: number;
    startScreenX: number;
    startScreenY: number;
    startWindowX: number;
    startWindowY: number;
  } | null = null;
  let wasDragged = false;

  void restoreDockPositionOrCenter();
  drawIdleWaveform();
  void registerProfileHotkeys(readSettings());
  void logClientEvent("dock rendered");

  dockNode.addEventListener("pointerdown", async (event) => {
    if ((event.target as HTMLElement).closest("[data-no-drag]")) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.detail > 1) return;

    try {
      wasDragged = true;
      void logClientEvent("dock native drag start");
      await currentWindow.startDragging();
      window.setTimeout(() => {
        void saveDockPosition();
        wasDragged = false;
      }, 150);
    } catch (error) {
      void logClientEvent(`dock native drag failed=${error instanceof Error ? error.message : String(error)}`);
      await startManualDrag(event);
    }
  });

  document.addEventListener("pointermove", (event) => {
    void moveManualDrag(event);
  });

  document.addEventListener("pointerup", (event) => {
    stopManualDrag(event);
  });

  document.addEventListener("pointercancel", (event) => {
    stopManualDrag(event);
  });

  async function startManualDrag(event: PointerEvent) {
    wasDragged = false;
    try {
      dockNode.setPointerCapture(event.pointerId);
      const factor = await currentWindow.scaleFactor();
      const windowPosition = (await currentWindow.outerPosition()).toLogical(factor);
      dragState = {
        pointerId: event.pointerId,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        startWindowX: windowPosition.x,
        startWindowY: windowPosition.y
      };
      void logClientEvent(`dock manual drag start screen=${event.screenX},${event.screenY} window=${windowPosition.x},${windowPosition.y}`);
    } catch (error) {
      void logClientEvent(`dock manual drag failed=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function moveManualDrag(event: PointerEvent) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const deltaX = event.screenX - dragState.startScreenX;
      const deltaY = event.screenY - dragState.startScreenY;
      if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
        wasDragged = true;
      }
      await currentWindow.setPosition(new LogicalPosition(dragState.startWindowX + deltaX, dragState.startWindowY + deltaY));
    } catch (error) {
      void logClientEvent(`dock manual drag move failed=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function stopManualDrag(event: PointerEvent) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    try {
      dockNode.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the platform.
    }
    dragState = null;
    void saveDockPosition();
    void logClientEvent(`dock manual drag stop moved=${wasDragged}`);
    window.setTimeout(() => {
      wasDragged = false;
    }, 100);
  }

  dockNode.addEventListener("click", (event) => {
    if (!wasDragged) return;
    event.preventDefault();
    event.stopPropagation();
  });

  app.addEventListener("click", async (event) => {
    if (wasDragged) return;
    await openHomeWindow();
  });

  app.addEventListener("dblclick", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await openHomeWindow();
  });

  openHomeButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await openHomeWindow();
  });

  async function openHomeWindow() {
    const main = await Window.getByLabel("main");
    await main?.show();
    await main?.setFocus();
  }

  void listen<string>("talkpro://record-start", (event) => {
    void startDictation(event.payload);
  });

  void listen("talkpro://record-stop", () => {
    void stopDictation();
  });

  async function startDictation(profileId: string) {
    if (isRecording || isFinishingDictation) {
      void logClientEvent(`record-start ignored profile=${profileId} recording=${isRecording} finishing=${isFinishingDictation}`);
      return;
    }

    const settings = readSettings();
    const profile = activeProfile(settings, profileId);
    const dictationMode = profile.dictationMode ?? settings.dictationMode;
    void logClientEvent(`record-start event profile=${profileId} resolved=${profile.id} mode=${dictationMode}`);
    currentProfileId = profile.id;
    void positionDockForForegroundMonitor().catch((error) => {
      void logClientEvent(`dock follow screen failed=${error instanceof Error ? error.message : String(error)}`);
    });
    void currentWindow.show().catch((error) => {
      void logClientEvent(`dock show failed=${error instanceof Error ? error.message : String(error)}`);
    });
    setDockLoading(false);

    if (dictationMode === "ai" && !settings.apiKey.trim()) {
      dockTitleNode.textContent = "API key needed";
      transcriptNode.textContent = "Click to open settings.";
      return;
    }

    isRecording = true;
    recordingStartedAt = performance.now();
    audioChunks = [];
    transcriptNode.textContent = "";
    dockTitleNode.textContent = profile.name;

    try {
      if (dictationMode === "local") {
        void logClientEvent("startDictation local begin");
        await startWaveform();
        void logClientEvent("startDictation local waveform ok");
        startLocalRecognition();
        void logClientEvent("startDictation local recognition started");
      } else {
        void logClientEvent("startDictation ai begin");
        await startAudioCapture();
      }
    } catch (error) {
      isRecording = false;
      dockTitleNode.textContent = "Mic unavailable";
      transcriptNode.textContent = error instanceof Error ? error.message : "Unable to access microphone.";
      void logClientEvent(`startDictation error=${transcriptNode.textContent}`);
    }
  }

  async function stopDictation() {
    if (!isRecording) return;

    const settings = readSettings();
    const profile = activeProfile(settings, currentProfileId);
    const dictationMode = profile.dictationMode ?? settings.dictationMode;
    void logClientEvent(`record-stop event profile=${profile.id}`);
    isRecording = false;
    isFinishingDictation = true;
    dockTitleNode.textContent = "Finishing";
    try {
      await delay(POST_RELEASE_CAPTURE_MS);

      if (dictationMode === "local") {
        const text = normalizeTranscript(await stopLocalRecognition());
        stopWaveform();
        void logClientEvent(`local dictation text_len=${text.length}`);
        await pasteAndRemember(text, text, false, `${profile.name} / local`, 0);
        return;
      }

      const audioBlob = await stopAudioCapture();
      void logClientEvent(`audio capture stopped size=${audioBlob?.size ?? 0} type=${audioBlob?.type ?? "none"}`);
      if (!audioBlob || audioBlob.size === 0) {
        finishDock("No audio");
        return;
      }

      dockTitleNode.textContent = "Transcribing";
      setDockLoading(true);
      const durationSeconds = recordingStartedAt ? Math.max((performance.now() - recordingStartedAt) / 1000, 0) : undefined;
      let estimatedCostUsd = estimateTranscriptionCost(profile.transcriptionModel, durationSeconds);
      const rawText = normalizeTranscript(await transcribeAudio(audioBlob, settings, profile, durationSeconds));
      void logClientEvent(`transcription ok text_len=${rawText.length}`);
      if (!hasUsableDictation(rawText)) {
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
        void logClientEvent(`improvement ok text_len=${finalText.length}`);
        improved = finalText !== rawText;
        estimatedCostUsd += estimateImprovementCost(profile.improvementModel, rawText, finalText, profile.improvementPrompt, profile.vocabulary);
      }

      setDockLoading(false);
      await pasteAndRemember(rawText, finalText, improved, `${profile.name} / ${profile.transcriptionModel}`, estimatedCostUsd);
    } catch (error) {
      setDockLoading(false);
      dockTitleNode.textContent = "Error";
      transcriptNode.textContent = error instanceof Error ? error.message : "Dictation failed.";
      void logClientEvent(`stopDictation error=${transcriptNode.textContent}`);
    } finally {
      isFinishingDictation = false;
    }
  }

  async function startAudioCapture() {
    void logClientEvent("startAudioCapture begin");
    await startWaveform();
    if (!mediaStream) {
      throw new Error("Unable to access microphone.");
    }

    const mimeType = chooseMimeType();
    void logClientEvent(`MediaRecorder mime=${mimeType || "default"}`);
    mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };
    mediaRecorder.start(250);
    void logClientEvent(`MediaRecorder started state=${mediaRecorder.state}`);
  }

  async function startWaveform() {
    void logClientEvent(`startWaveform mediaDevices=${Boolean(navigator.mediaDevices?.getUserMedia)}`);
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not available in this window.");
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    void logClientEvent(`getUserMedia ok tracks=${mediaStream.getAudioTracks().length}`);
    if (!mediaStream.getAudioTracks().length) {
      throw new Error("No microphone track was returned. Check Windows microphone privacy settings.");
    }

    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioContext.createMediaStreamSource(mediaStream).connect(analyser);
    void logClientEvent(`audioContext state=${audioContext.state}`);
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
      void logClientEvent("local recognition unavailable");
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
      void logClientEvent(`local recognition error=${event.error}`);
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

  async function pasteAndRemember(rawText: string, finalText: string, improved: boolean, model: string, estimatedCostUsd?: number) {
    if (!hasUsableDictation(finalText)) {
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
      createdAt: new Date().toISOString(),
      estimatedCostUsd
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

  async function positionDockBottomCenter() {
    try {
      const cursor = await cursorPosition();
      const monitor = await monitorFromPoint(cursor.x, cursor.y) ?? await primaryMonitor();
      if (!monitor) return;

      const factor = await currentWindow.scaleFactor();
      const workArea = monitor.workArea;
      const logicalX = (workArea.position.x + (workArea.size.width - 300) / 2) / factor;
      const logicalY = (workArea.position.y + workArea.size.height - 52) / factor;
      await currentWindow.setPosition(new LogicalPosition(logicalX, logicalY));
    } catch {
      await restoreDockPosition();
    }
  }

  async function positionDockForForegroundMonitor() {
    const workArea = await invoke<MonitorWorkArea | null>("foreground_monitor_work_area");
    if (!workArea) {
      await positionDockBottomCenter();
      return;
    }

    const saved = readDockMonitorPositions()[workArea.id];
    if (saved) {
      await currentWindow.setPosition(new LogicalPosition(saved.x, saved.y));
      return;
    }

    const factor = await currentWindow.scaleFactor();
    const logicalX = (workArea.x + (workArea.width - 300) / 2) / factor;
    const logicalY = (workArea.y + workArea.height - 52) / factor;
    await currentWindow.setPosition(new LogicalPosition(logicalX, logicalY));
  }

  async function restoreDockPositionOrCenter() {
    const restored = await restoreDockPosition();
    if (!restored) {
      await positionDockBottomCenter();
    }
  }

  async function restoreDockPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem(DOCK_POSITION_KEY) ?? "null") as { x: number; y: number } | null;
      if (saved) {
        await currentWindow.setPosition(new LogicalPosition(saved.x, saved.y));
        return true;
      }
    } catch {
      // Ignore invalid saved positions.
    }
    return false;
  }

  async function saveDockPosition() {
    const position = await currentWindow.outerPosition();
    const factor = await currentWindow.scaleFactor();
    const logical = position.toLogical(factor);
    localStorage.setItem(DOCK_POSITION_KEY, JSON.stringify({ x: logical.x, y: logical.y }));

    try {
      const size = await currentWindow.outerSize();
      const centerX = position.x + Math.round(size.width / 2);
      const centerY = position.y + Math.round(size.height / 2);
      const monitor = await monitorFromPoint(centerX, centerY);
      if (!monitor) return;
      const monitorId = `${monitor.position.x}:${monitor.position.y}:${monitor.size.width}:${monitor.size.height}`;
      const positions = readDockMonitorPositions();
      positions[monitorId] = { x: logical.x, y: logical.y };
      localStorage.setItem(DOCK_MONITOR_POSITIONS_KEY, JSON.stringify(positions));
    } catch {
      // Per-monitor position persistence is best effort.
    }
  }
}

function readDockMonitorPositions() {
  try {
    return JSON.parse(localStorage.getItem(DOCK_MONITOR_POSITIONS_KEY) ?? "{}") as Record<string, { x: number; y: number }>;
  } catch {
    return {};
  }
}

async function transcribeAudio(audioBlob: Blob, settings: AppSettings, profile: DictationProfile, durationSeconds?: number) {
  const audioBase64 = await blobToBase64(audioBlob);
  return await invoke<string>("transcribe_audio", {
    request: {
      apiKey: settings.apiKey.trim(),
      model: profile.transcriptionModel,
      audioBase64,
      fileName: `talkpro-${Date.now()}.${extensionForMime(audioBlob.type)}`,
      mimeType: audioBlob.type || "audio/webm",
      durationSeconds
    }
  });
}

function renderCostSummary(node: HTMLElement, settings: AppSettings) {
  const history = readHistory();
  const total = history.reduce((sum, entry) => sum + (entry.estimatedCostUsd ?? 0), 0);
  const latest = history.find((entry) => typeof entry.estimatedCostUsd === "number");
  const activeMode = activeProfile(settings).dictationMode ?? settings.dictationMode;
  const mode = activeMode === "ai" ? "AI dictation enabled" : "Local dictation enabled";
  node.innerHTML = `
    <div>
      <strong>${escapeHtml(mode)}</strong>
      <span>${activeMode === "ai" ? "Estimated API cost appears here after each AI dictation." : "Local dictation does not use OpenAI API billing."}</span>
    </div>
    <div class="cost-metrics">
      <span>Latest ${formatUsd(latest?.estimatedCostUsd ?? 0)}</span>
      <span>Total ${formatUsd(total)}</span>
    </div>
  `;
}

function renderProfileList(settings: AppSettings) {
  return settings.profiles
    .map((profile) => `
      <button class="profile-row ${profile.id === settings.activeProfileId ? "is-active" : ""}" data-select-profile="${escapeHtml(profile.id)}" type="button">
        <span>
          <strong>${escapeHtml(profile.name)}</strong>
          <small>${escapeHtml(profile.hotkey || "No hotkey")} - ${escapeHtml((profile.dictationMode ?? settings.dictationMode).toUpperCase())}</small>
        </span>
        <em>${escapeHtml(profile.transcriptionModel)}</em>
      </button>
    `)
    .join("");
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
          <span class="entry-cost">${formatUsd(entry.estimatedCostUsd ?? 0)}</span>
          <button class="copy-entry-button" data-copy-entry="${escapeHtml(entry.id)}" type="button" title="Copy dictation" aria-label="Copy dictation">
            <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="9" width="10" height="10" rx="2"></rect><path d="M5 15V7a2 2 0 0 1 2-2h8"></path></svg>
          </button>
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
  if (settings.profiles?.length && settings.settingsVersion >= 5) {
    return settings;
  }

  const profiles = settings.profiles?.length
    ? settings.profiles.map((profile) => {
        let nextProfile = profile;
        if (profile.id === "default" && (profile.hotkey === "Ctrl+Alt+1" || profile.hotkey === "Command+Option+1")) {
          nextProfile = { ...nextProfile, hotkey: defaultHotkey() };
        }

        if (profile.id === "code" && (profile.hotkey === "Ctrl+Alt+2" || profile.hotkey === "Ctrl+Shift+Alt+2" || profile.hotkey === "Command+Option+2" || profile.hotkey === "Command+Shift+Option+2")) {
          nextProfile = { ...nextProfile, hotkey: defaultSecondaryHotkey() };
        }

        if (profile.id === "default" && isBuiltInPrompt(profile.improvementPrompt)) {
          nextProfile = { ...nextProfile, improvementPrompt: DEFAULT_PROMPT };
        }

        if (profile.id === "code" && isBuiltInPrompt(profile.improvementPrompt)) {
          nextProfile = { ...nextProfile, improvementPrompt: CODEBASE_PROMPT };
        }

        if (!nextProfile.dictationMode) {
          nextProfile = { ...nextProfile, dictationMode: settings.dictationMode };
        }

        return nextProfile;
      })
    : [
        {
          id: "default",
          name: "Default",
          hotkey: defaultHotkey(),
          dictationMode: settings.dictationMode,
          transcriptionModel: settings.transcriptionModel,
          improveWithAi: settings.improveWithAi,
          improvementModel: settings.improvementModel,
          improvementPrompt: settings.improvementPrompt,
          vocabulary: settings.vocabulary
        }
      ];

  return {
    ...settings,
    settingsVersion: 5,
    activeProfileId: settings.activeProfileId || profiles[0].id,
    profiles
  };
}

function isBuiltInPrompt(value: string) {
  const prompt = value.trim();
  return !prompt
    || prompt === LEGACY_DEFAULT_PROMPT
    || prompt === DEFAULT_PROMPT
    || prompt === CODEBASE_PROMPT
    || prompt.includes("Clean up this dictated text for accuracy")
    || prompt.includes("Format the result as a concise engineering note");
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

async function hydrateDiagnosticsPath(node: HTMLElement) {
  try {
    const path = await invoke<string>("diagnostics_log_path");
    node.textContent = `Diagnostics log: ${path}`;
  } catch {
    node.textContent = "Diagnostics log unavailable.";
  }
}

async function hydrateRunOnLogin(input: HTMLInputElement) {
  try {
    input.checked = await invoke<boolean>("get_run_on_login");
  } catch {
    input.checked = false;
  }
}

async function logClientEvent(message: string) {
  try {
    await invoke("log_client_event", { request: { message } });
  } catch {
    // Diagnostics should never block dictation.
  }
}

function normalizeHotkey(value: string) {
  const trimmed = value.trim();
  if (/^[a-z0-9]@$/i.test(trimmed)) {
    return `Win+${trimmed[0].toUpperCase()}`;
  }

  return trimmed
    .split("+")
    .map((part) => normalizeHotkeyToken(part.trim()))
    .filter(Boolean)
    .join("+");
}

function defaultHotkey() {
  return navigator.platform.toLowerCase().includes("mac") ? "Command+Option" : "Ctrl+Alt";
}

function defaultSecondaryHotkey() {
  return navigator.platform.toLowerCase().includes("mac") ? "Command+Option+2" : "Ctrl+Win+2";
}

function defaultProfileHotkey(profileNumber: number) {
  const key = Math.min(Math.max(profileNumber, 1), 9);
  return navigator.platform.toLowerCase().includes("mac") ? `Command+Option+${key}` : `Ctrl+Win+${key}`;
}

function normalizeHotkeyToken(token: string) {
  const lower = token.toLowerCase();
  if (lower === "control") return "Ctrl";
  if (lower === "windows" || lower === "window" || lower === "meta") return "Win";
  if (lower === "cmd") return "Command";
  if (lower === "option") return "Option";
  if (lower === "alt") return "Alt";
  if (lower === "shift") return "Shift";
  if (lower === "@") return "2";
  if (lower === "#") return "3";
  if (lower === "$") return "4";
  if (lower === "%") return "5";
  if (lower === "^") return "6";
  if (lower === "&") return "7";
  if (lower === "*") return "8";
  if (lower === "(") return "9";
  if (lower === ")") return "0";
  if (/^[a-z0-9]@$/.test(lower)) return lower[0].toUpperCase();
  return token.length === 1 ? token.toUpperCase() : token;
}

function hotkeyFromKeyboardEvent(event: KeyboardEvent) {
  const parts: string[] = [];
  const key = physicalKeyFromKeyboardEvent(event) ?? event.key;
  const modifierOnly = ["Control", "Shift", "Alt", "Meta"].includes(key);

  if (event.ctrlKey) parts.push("Ctrl");
  if (event.metaKey) parts.push(navigator.platform.toLowerCase().includes("mac") ? "Command" : "Win");
  if (event.altKey) parts.push(navigator.platform.toLowerCase().includes("mac") ? "Option" : "Alt");
  if (event.shiftKey) parts.push("Shift");

  if (!modifierOnly) {
    parts.push(normalizeHotkeyToken(key === " " ? "Space" : key));
  }

  if (modifierOnly && parts.length < 2) return "";
  return parts.length >= 1 ? Array.from(new Set(parts)).join("+") : "";
}

function physicalKeyFromKeyboardEvent(event: KeyboardEvent) {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.replace("Key", "");
  if (/^Digit[0-9]$/.test(event.code)) return event.code.replace("Digit", "");
  if (/^F(?:[1-9]|1[0-2])$/.test(event.code)) return event.code;
  if (event.code === "Space") return "Space";
  return null;
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

function hasUsableDictation(value: string) {
  const normalized = normalizeTranscript(value).toLowerCase();
  if (!normalized) return false;
  const noSpeechValues = new Set([
    "no speech",
    "no audio",
    "silence",
    "[no speech]",
    "(no speech)",
    "[inaudible]",
    "(inaudible)",
    "inaudible"
  ]);
  return !noSpeechValues.has(normalized);
}

function estimateTranscriptionCost(model: string, durationSeconds?: number) {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  if (model === "whisper-1") return (durationSeconds / 60) * 0.006;
  if (model === "gpt-4o-transcribe") return (durationSeconds / 60) * 0.012;
  if (model === "gpt-4o-mini-transcribe") return (durationSeconds / 60) * 0.006;
  return 0;
}

function estimateImprovementCost(model: string, rawText: string, finalText: string, prompt: string, vocabulary: string) {
  const inputTokens = estimateTokenCount(`${prompt}\n${vocabulary}\n${rawText}`);
  const outputTokens = estimateTokenCount(finalText);
  if (model === "gpt-4o-mini") return (inputTokens / 1_000_000) * 0.15 + (outputTokens / 1_000_000) * 0.60;
  if (model === "gpt-4o") return (inputTokens / 1_000_000) * 2.50 + (outputTokens / 1_000_000) * 10.00;
  return 0;
}

function estimateTokenCount(value: string) {
  return Math.ceil(value.length / 4);
}

function formatUsd(value: number) {
  if (value > 0 && value < 0.0001) return "<$0.0001";
  return `$${value.toFixed(4)}`;
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
