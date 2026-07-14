import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Check,
  CircleX,
  FileUp,
  KeyRound,
  LogIn,
  Minus,
  Moon,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Square,
  SquareStack,
  Sun,
  Terminal,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import logo from "./assets/hydra-icon.png";
import "./App.css";

const APP_NAME = "Hydra";
const APP_SUBTITLE = "Profile Control // Rev 01";
const THEME_KEY = "hydra-theme";

type Theme = "day" | "night";

type Profile = {
  id: string;
  name: string;
  email?: string;
  isActive: boolean;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  canRefresh: boolean;
  refreshError?: string;
};

type TokenHealth = {
  tone: "ok" | "soon" | "warn" | "error";
  label: string;
};

type LoginStatus = {
  exists: boolean;
  fingerprint?: string;
  email?: string;
};

type Usage = {
  profileId: string;
  used?: number;
  limit?: number;
  percent?: number;
  label: string;
  periodLabel?: string;
  resetsAt?: string;
  source: string;
  error?: string;
};

type GrokInstance = {
  pid: number;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatCredits(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value < 10 ? 2 : 0,
  }).format(value);
}

function formatReset(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDuration(ms: number) {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function initialTheme(): Theme {
  if (typeof window === "undefined") return "night";
  const stored = window.localStorage.getItem(THEME_KEY);
  // First launch is always night; after that, honor the user's last choice.
  if (stored === "day" || stored === "night") return stored;
  return "night";
}

function isInteractiveTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "button, input, textarea, select, a, summary, [data-window-no-drag]",
      ),
    )
  );
}

function formatPoll(value: Date | null) {
  if (!value) return "Awaiting telemetry";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function usageCopy(stats?: Usage) {
  if (!stats) {
    return {
      percent: 0,
      headline: "Loading usage",
      detail: "Awaiting service telemetry",
      unavailable: true,
    };
  }
  if (stats.error) {
    return {
      percent: 0,
      headline: "Usage unavailable",
      detail: "Sign-in required",
      unavailable: true,
    };
  }
  if (stats.limit === 0) {
    return {
      percent: 0,
      headline: "No active subscription",
      detail: "No Build allocation reported",
      unavailable: true,
    };
  }

  const percent = Math.max(0, Math.min(100, stats.percent ?? 0));
  const reset = formatReset(stats.resetsAt);
  if (stats.source === "weekly") {
    return {
      percent,
      headline: stats.percent != null ? `${Math.round(percent)}% used` : stats.label,
      detail: [stats.periodLabel, reset ? `Resets ${reset}` : null]
        .filter(Boolean)
        .join(" · "),
      unavailable: false,
    };
  }
  if (stats.used != null && stats.limit != null) {
    return {
      percent,
      headline: `${Math.round(percent)}% used`,
      detail: `${formatCredits(stats.used)} / ${formatCredits(stats.limit)} this month`,
      unavailable: false,
    };
  }
  return {
    percent,
    headline: stats.label,
    detail: reset ? `Resets ${reset}` : stats.periodLabel ?? "Current period",
    unavailable: false,
  };
}

// Derives the login/token state shown per profile. Because Hydra now renews
// tokens silently, a healthy profile reads as "auto-renewing" rather than
// counting down toward a manual re-login.
function tokenHealth(profile: Profile): TokenHealth {
  if (profile.refreshError) {
    return { tone: "error", label: profile.refreshError };
  }
  if (!profile.canRefresh) {
    return { tone: "warn", label: "Re-login to enable auto-renew" };
  }
  if (!profile.expiresAt) {
    return { tone: "ok", label: "Auto-renew on" };
  }
  const remaining = new Date(profile.expiresAt).getTime() - Date.now();
  if (Number.isNaN(remaining)) {
    return { tone: "ok", label: "Auto-renew on" };
  }
  if (remaining <= 0) {
    return { tone: "soon", label: "Renewing token…" };
  }
  return { tone: "ok", label: `Auto-renew on · token valid ${formatDuration(remaining)}` };
}

function App() {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [maximized, setMaximized] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [usage, setUsage] = useState<Record<string, Usage>>({});
  const [grokInstances, setGrokInstances] = useState<GrokInstance[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("Ready");
  const [lastPoll, setLastPoll] = useState<Date | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === "night" ? "dark" : "light";
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const syncMaximized = async () => {
      try {
        const next = await appWindow.isMaximized();
        if (!disposed) setMaximized(next);
      } catch {
        /* browser / mock harness */
      }
    };

    void syncMaximized();
    void appWindow
      .onResized(() => void syncMaximized())
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        /* browser / mock harness */
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appWindow]);

  const startDragging = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) return;
    void appWindow.startDragging().catch(() => {
      /* browser / mock harness */
    });
  };

  const toggleMaximize = async () => {
    try {
      await appWindow.toggleMaximize();
      setMaximized(await appWindow.isMaximized());
    } catch {
      /* browser / mock harness */
    }
  };

  const onHeaderDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if (isInteractiveTarget(event.target)) return;
    void toggleMaximize();
  };

  const refreshInstances = useCallback(async () => {
    try {
      setGrokInstances(await invoke<GrokInstance[]>("grok_instances"));
    } catch {
      setGrokInstances([]);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setProfiles(await invoke<Profile[]>("list_profiles"));
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void load();
    void refreshInstances();
  }, [load, refreshInstances]);

  useEffect(() => {
    const id = window.setInterval(() => void refreshInstances(), 5000);
    return () => window.clearInterval(id);
  }, [refreshInstances]);

  const refreshUsage = useCallback(async (items = profiles) => {
    if (!items.length) return;
    setBusy("usage");
    const results = await Promise.all(
      items.map(async (profile) => {
        try {
          return await invoke<Usage>("get_profile_usage", {
            profileId: profile.id,
          });
        } catch (error) {
          return {
            profileId: profile.id,
            label: "Unavailable",
            error: errorMessage(error),
            source: "unavailable",
          } satisfies Usage;
        }
      }),
    );
    setUsage(Object.fromEntries(results.map((item) => [item.profileId, item])));
    setLastPoll(new Date());
    setBusy(null);
    setMessage("Usage refreshed");
  }, [profiles]);

  useEffect(() => {
    if (profiles.length) void refreshUsage(profiles);
  }, [profiles.length]);

  // Silent token renewal: renews any expired / near-expiry profile so usage
  // stays live and switching never lands on a dead token. Returns the fresh
  // profile list from the backend.
  const refreshAllStale = useCallback(async () => {
    try {
      const fresh = await invoke<Profile[]>("refresh_all_stale");
      setProfiles(fresh);
      return fresh;
    } catch (error) {
      setMessage(errorMessage(error));
      return null;
    }
  }, []);

  // Renew tokens on launch, then keep them fresh on a timer without any user
  // action — this is what turns Hydra into a set-and-forget dashboard.
  useEffect(() => {
    void refreshAllStale();
    const id = window.setInterval(() => void refreshAllStale(), 60_000);
    return () => window.clearInterval(id);
  }, [refreshAllStale]);

  // Re-render the countdown labels each minute even when nothing else changes.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((value) => value + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  async function refreshOne(profile: Profile) {
    setBusy(`refresh-${profile.id}`);
    try {
      await invoke<Profile>("refresh_profile", { profileId: profile.id });
      await load();
      await refreshUsage();
      setMessage(`Renewed token for ${profile.name}`);
    } catch (error) {
      setMessage(errorMessage(error));
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function switchTo(profile: Profile) {
    const closeRunning = window.confirm(
      `Switch to ${profile.name}?\n\nAny running Grok CLI session must close so it cannot restore the previous account.`,
    );
    if (!closeRunning) return;
    setBusy(profile.id);
    try {
      await invoke("switch_profile", {
        profileId: profile.id,
        closeRunning: true,
      });
      await load();
      await refreshInstances();
      setMessage(`Active profile: ${profile.name}. Start a new Grok session to use it.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function loginAndImport() {
    setBusy("login");
    try {
      const before = await invoke<LoginStatus>("login_status");
      await invoke("launch_grok_login");
      setMessage("Waiting for the official Grok login to finish...");
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        const current = await invoke<LoginStatus>("login_status");
        if (
          current.exists &&
          current.fingerprint &&
          current.fingerprint !== before.fingerprint
        ) {
          await invoke("import_current_profile", { name: null });
          await load();
          setMessage(`Imported ${current.email ?? "the current Grok profile"}`);
          return;
        }
      }
      setMessage("Login was not detected. Use Import current after login.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function importCurrent() {
    setBusy("current");
    try {
      await invoke("import_current_profile", { name: null });
      await load();
      setMessage("Current Grok profile imported");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function importFile() {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Grok auth", extensions: ["json"] }],
    });
    if (!path) return;
    setBusy("file");
    try {
      await invoke("import_profile_file", { path, name: null });
      await load();
      setMessage("Profile imported from file");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function openGrok() {
    setBusy("open-grok");
    try {
      await invoke("launch_grok");
      await refreshInstances();
      setMessage("Opened Grok");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function closeAllGrok() {
    if (!window.confirm("Close all open Grok sessions?")) return;
    setBusy("close-grok");
    try {
      await invoke("close_grok_instances");
      await refreshInstances();
      setMessage("Closed all Grok sessions");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function rename(profile: Profile) {
    const name = window.prompt("Profile name", profile.name)?.trim();
    if (!name || name === profile.name) return;
    try {
      await invoke("rename_profile", { profileId: profile.id, name });
      await load();
      setMessage("Profile renamed");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function remove(profile: Profile) {
    if (!window.confirm(`Remove ${profile.name} from this device?`)) return;
    try {
      await invoke("delete_profile", { profileId: profile.id });
      await load();
      setMessage("Profile removed");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  const active = profiles.find((profile) => profile.isActive);
  const storedProfiles = active
    ? profiles.filter((profile) => profile.id !== active.id)
    : profiles;
  const activeUsage = usageCopy(active ? usage[active.id] : undefined);
  const activeHealth = active ? tokenHealth(active) : null;
  const activeRenewing = active ? busy === `refresh-${active.id}` : false;
  const activeRefreshBlocked = Boolean(active && grokInstances.length > 0);

  return (
    <main className="app-shell" data-theme={theme}>
      <header
        className="app-header"
        onMouseDown={startDragging}
        onDoubleClick={onHeaderDoubleClick}
      >
        <div className="brand">
          <img src={logo} alt="" className="brand-mark" />
          <div className="brand-copy">
            <h1>{APP_NAME}</h1>
            <p>{APP_SUBTITLE}</p>
          </div>
        </div>

        <div className="header-actions" data-window-no-drag>
          <div className="theme-control" role="group" aria-label="Color theme">
            <button
              type="button"
              className="theme-icon-button"
              aria-label="Use day theme"
              title="Day"
              aria-pressed={theme === "day"}
              onClick={() => setTheme("day")}
            >
              <Sun size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="theme-icon-button"
              aria-label="Use night theme"
              title="Night"
              aria-pressed={theme === "night"}
              onClick={() => setTheme("night")}
            >
              <Moon size={15} aria-hidden="true" />
            </button>
          </div>

          <button
            className="add-account-button"
            onClick={() => void loginAndImport()}
            disabled={busy === "login"}
          >
            <Plus size={19} aria-hidden="true" />
            ADD ACCOUNT
          </button>

          <details className="action-menu">
            <summary aria-label="More account actions" title="More account actions">
              <MoreHorizontal size={20} aria-hidden="true" />
            </summary>
            <div className="menu-panel">
              <button onClick={() => void importCurrent()} disabled={busy === "current"}>
                <Check size={16} aria-hidden="true" />
                Import current login
              </button>
              <button onClick={() => void importFile()} disabled={busy === "file"}>
                <FileUp size={16} aria-hidden="true" />
                Import auth file
              </button>
              <button
                className="menu-danger"
                onClick={() => void closeAllGrok()}
                disabled={busy === "close-grok" || grokInstances.length === 0}
              >
                <CircleX size={16} aria-hidden="true" />
                Close Grok sessions
              </button>
            </div>
          </details>

          <div className="window-controls" aria-label="Window controls">
            <button
              type="button"
              className="window-control-button"
              aria-label="Minimize"
              title="Minimize"
              onClick={() => void appWindow.minimize().catch(() => undefined)}
            >
              <Minus size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="window-control-button"
              aria-label={maximized ? "Restore window" : "Maximize window"}
              title={maximized ? "Restore" : "Maximize"}
              onClick={() => void toggleMaximize()}
            >
              {maximized ? (
                <SquareStack size={13} aria-hidden="true" />
              ) : (
                <Square size={13} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="window-control-button window-close"
              aria-label="Close"
              title="Close"
              onClick={() => void appWindow.close().catch(() => undefined)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <section className="active-console" aria-labelledby="active-profile-heading">
        <img src={logo} alt="" className="console-watermark" aria-hidden="true" />
        <div className="active-identity">
          <span className="technical-label">ACTIVE ACCOUNT / 01</span>
          <h2 id="active-profile-heading">{active?.name ?? "No active account"}</h2>
          <p>{active?.email ?? "Add an authorized Grok profile to begin"}</p>
          {active && (
            <div className="active-tools" aria-label="Active account tools">
              <button
                className="console-icon-button"
                title={
                  activeRefreshBlocked
                    ? "Close running Grok sessions before renewing"
                    : "Renew active account token"
                }
                aria-label={
                  activeRefreshBlocked
                    ? "Close running Grok sessions before renewing active account"
                    : "Renew active account token"
                }
                onClick={() => void refreshOne(active)}
                disabled={!active.canRefresh || activeRefreshBlocked || activeRenewing}
              >
                <KeyRound
                  size={15}
                  aria-hidden="true"
                  className={activeRenewing ? "spin" : ""}
                />
              </button>
              <button
                className="console-icon-button"
                title="Rename active account"
                aria-label="Rename active account"
                onClick={() => void rename(active)}
              >
                <Pencil size={15} aria-hidden="true" />
              </button>
              <button
                className="console-icon-button danger"
                title="Remove active account"
                aria-label="Remove active account"
                onClick={() => void remove(active)}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        <div className="active-usage">
          <div className="active-percent">
            {activeUsage.unavailable ? "--" : Math.round(activeUsage.percent)}
            <span>{activeUsage.unavailable ? "" : "%"}</span>
          </div>
          <span className="capacity-title">WEEKLY CAPACITY USED</span>
          <div
            className={`capacity-meter ${activeUsage.unavailable ? "meter-unavailable" : ""}`}
            role="progressbar"
            aria-label="Active account weekly usage"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(activeUsage.percent)}
          >
            <span style={{ width: `${activeUsage.percent}%` }} />
          </div>
          <p>{activeUsage.detail || activeUsage.headline}</p>
        </div>

        <div className="active-launch">
          <button
            className="launch-button"
            onClick={() => void openGrok()}
            disabled={!active || busy === "open-grok"}
          >
            <Terminal size={20} aria-hidden="true" />
            OPEN GROK
          </button>
          <span className={grokInstances.length ? "sessions-live" : ""}>
            SESSIONS: {grokInstances.length} / {grokInstances.length ? "RUNNING" : "STANDBY"}
          </span>
          {grokInstances.length > 0 && (
            <button
              className="close-sessions-button"
              onClick={() => void closeAllGrok()}
              disabled={busy === "close-grok"}
            >
              Close all sessions
            </button>
          )}
          {activeHealth && (
            <span className={`active-auth active-auth-${activeHealth.tone}`}>
              AUTH: {activeRenewing ? "RENEWING" : activeHealth.tone === "ok" ? "READY" : "ATTENTION"}
            </span>
          )}
        </div>
      </section>

      <section className="profiles-section" aria-labelledby="stored-profiles-heading">
        <div className="section-heading">
          <h2 id="stored-profiles-heading">STORED PROFILES // {String(storedProfiles.length).padStart(2, "0")}</h2>
        </div>

        {!profiles.length ? (
          <div className="empty-state">
            <img src={logo} alt="" />
            <span className="technical-label">LOCAL VAULT EMPTY</span>
            <h2>Add your first authorized profile</h2>
            <p>
              Hydra opens the official Grok login and stores the authorized profile only
              on this device.
            </p>
            <button className="launch-button empty-login" onClick={() => void loginAndImport()}>
              <LogIn size={18} aria-hidden="true" />
              LOGIN WITH GROK
            </button>
          </div>
        ) : storedProfiles.length === 0 ? (
          <div className="standby-empty">
            <span>NO STANDBY PROFILES STORED</span>
            <button onClick={() => void loginAndImport()}>
              <Plus size={16} aria-hidden="true" /> Add account
            </button>
          </div>
        ) : (
          <div className="profile-list">
            {storedProfiles.map((profile, index) => {
              const stats = usage[profile.id];
              const copy = usageCopy(stats);
              const health = tokenHealth(profile);
              const renewing = busy === `refresh-${profile.id}`;
              const needsSignIn = Boolean(
                profile.refreshError || !profile.canRefresh || stats?.error,
              );
              const profileNumber = String(index + (active ? 2 : 1)).padStart(2, "0");

              return (
                <article className="profile-row" key={profile.id}>
                  <div className="profile-index" aria-hidden="true">{profileNumber}</div>

                  <div className="profile-copy">
                    <strong>{profile.name}</strong>
                    <span>{profile.email ?? "Email unavailable"}</span>
                  </div>

                  <div className="row-usage">
                    <strong>{copy.headline.toUpperCase()}</strong>
                    <div
                      className={`row-meter ${copy.unavailable ? "meter-unavailable" : ""}`}
                      role="progressbar"
                      aria-label={`${profile.name} usage`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(copy.percent)}
                    >
                      <span style={{ width: `${copy.percent}%` }} />
                    </div>
                    <small>{copy.detail}</small>
                  </div>

                  <div
                    className={`auth-state auth-${
                      renewing ? "soon" : needsSignIn ? "warn" : health.tone
                    }`}
                    title={renewing ? "Renewing token" : health.label}
                  >
                    <span aria-hidden="true" />
                    AUTH: {renewing ? "RENEWING" : needsSignIn ? "SIGN-IN REQUIRED" : "READY"}
                  </div>

                  <div className="profile-primary-action">
                    <button
                      className={`switch-button metal-button ${needsSignIn ? "sign-in-button" : ""}`}
                      onClick={() =>
                        needsSignIn ? void loginAndImport() : void switchTo(profile)
                      }
                      disabled={busy === profile.id || busy === "login"}
                    >
                      {needsSignIn ? (
                        <LogIn size={16} aria-hidden="true" />
                      ) : (
                        <Zap size={16} aria-hidden="true" />
                      )}
                      {needsSignIn ? "SIGN IN" : "SWITCH"}
                    </button>
                  </div>

                  <div className="row-actions" aria-label={`${profile.name} tools`}>
                    <button
                      className="icon-button"
                      title={
                        profile.canRefresh
                          ? `Renew token for ${profile.name}`
                          : `Sign in again to renew ${profile.name}`
                      }
                      aria-label={
                        profile.canRefresh
                          ? `Renew token for ${profile.name}`
                          : `Sign in again to renew ${profile.name}`
                      }
                      aria-busy={renewing}
                      onClick={() => void refreshOne(profile)}
                      disabled={!profile.canRefresh || renewing}
                    >
                      <KeyRound
                        size={15}
                        aria-hidden="true"
                        className={renewing ? "spin" : ""}
                      />
                    </button>
                    <button
                      className="icon-button"
                      title={`Rename ${profile.name}`}
                      aria-label={`Rename ${profile.name}`}
                      onClick={() => void rename(profile)}
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                    <button
                      className="icon-button danger"
                      title={`Remove ${profile.name}`}
                      aria-label={`Remove ${profile.name}`}
                      onClick={() => void remove(profile)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <footer className="status-rail">
        <span className="status-cell auto-refresh-state">
          <i aria-hidden="true" /> AUTO REFRESH: ENABLED
        </span>
        <span className="status-cell">LAST POLL {formatPoll(lastPoll)}</span>
        <button
          className="manual-refresh-button"
          onClick={() => void refreshUsage()}
          disabled={busy === "usage" || profiles.length === 0}
          aria-busy={busy === "usage"}
        >
          MANUAL REFRESH
          <RefreshCw
            size={17}
            aria-hidden="true"
            className={busy === "usage" ? "spin" : ""}
          />
        </button>
        <span className="status-message" role="status" aria-live="polite">
          {message}
        </span>
      </footer>
    </main>
  );
}

export default App;
