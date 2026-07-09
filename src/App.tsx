import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Check,
  FileUp,
  LogIn,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import logo from "./assets/hydra-icon.png";
import "./App.css";

const APP_NAME = "Hydra";
const APP_SUBTITLE = "Many Heads. One Command.";

type Profile = {
  id: string;
  name: string;
  email?: string;
  isActive: boolean;
  createdAt: string;
  lastUsedAt?: string;
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

function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [usage, setUsage] = useState<Record<string, Usage>>({});
  const [grokInstances, setGrokInstances] = useState<GrokInstance[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("Ready");

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
          } satisfies Usage;
        }
      }),
    );
    setUsage(Object.fromEntries(results.map((item) => [item.profileId, item])));
    setBusy(null);
    setMessage("Usage refreshed");
  }, [profiles]);

  useEffect(() => {
    if (profiles.length) void refreshUsage(profiles);
  }, [profiles.length]);

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

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img src={logo} alt="" className="brand-mark" />
          <div>
            <h1>{APP_NAME}</h1>
            <p>{APP_SUBTITLE}</p>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            title="Refresh usage"
            onClick={() => void refreshUsage()}
            disabled={busy === "usage"}
          >
            <RefreshCw size={18} className={busy === "usage" ? "spin" : ""} />
          </button>
          <button className="primary" onClick={() => void loginAndImport()}>
            <Plus size={18} />
            <span className="header-action-label">Add profile</span>
          </button>
        </div>
      </header>

      <section className="active-band">
        <div>
          <span className="eyebrow">ACTIVE CLI PROFILE</span>
          <strong>{active?.name ?? "No matching profile"}</strong>
          <span>{active?.email ?? "Import the current Grok login to begin"}</span>
        </div>
        <div className="runtime-panel">
          <ShieldCheck size={34} aria-hidden="true" />
          <div className={`instance-chip ${grokInstances.length ? "instance-chip-live" : ""}`}>
            <Terminal size={15} />
            <div>
              <strong>
                {grokInstances.length
                  ? `${grokInstances.length} Grok session${grokInstances.length === 1 ? "" : "s"} open`
                  : "No Grok sessions"}
              </strong>
              <span>
                {grokInstances.length
                  ? `PID ${grokInstances.map((item) => item.pid).join(", ")}`
                  : "Switch is clear"}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="toolbar">
        <button onClick={() => void loginAndImport()} disabled={busy === "login"}>
          <LogIn size={17} />
          Login with Grok
        </button>
        <button onClick={() => void importCurrent()} disabled={busy === "current"}>
          <Check size={17} />
          Import current
        </button>
        <button onClick={() => void importFile()} disabled={busy === "file"}>
          <FileUp size={17} />
          Import file
        </button>
      </section>

      <section className="profiles-section">
        <div className="section-heading">
          <div>
            <h2>Profiles</h2>
            <p>{profiles.length} stored on this device</p>
          </div>
        </div>

        {!profiles.length ? (
          <div className="empty-state">
            <img src={logo} alt="" />
            <h2>Add your first authorized profile</h2>
            <p>
              Hydra launches the official login and imports the local
              credential file after authentication finishes.
            </p>
            <button className="primary" onClick={() => void loginAndImport()}>
              <LogIn size={18} />
              Login with Grok
            </button>
          </div>
        ) : (
          <div className="profile-list">
            {profiles.map((profile) => {
              const stats = usage[profile.id];
              return (
                <article
                  className={`profile-row ${profile.isActive ? "active" : ""}`}
                  key={profile.id}
                >
                  <div className="profile-avatar">
                    {profile.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="profile-copy">
                    <div className="profile-title">
                      <strong>{profile.name}</strong>
                      {profile.isActive && <span className="active-pill">Active</span>}
                    </div>
                    <span>{profile.email ?? "Email unavailable"}</span>
                    {(() => {
                      // limit === 0 is a real, distinct state from "has usage" and from
                      // "needs re-login": the billing API returns HTTP 200 with genuine
                      // zero-everywhere data (checked directly against the live endpoint).
                      // Don't assert *why* it's zero -- confirmed the JWT's tier claim is
                      // identical (tier: 1) between a real SuperGrok subscription (zero
                      // credits by design, unrelated weekly limits this endpoint can't
                      // see) and an account that might genuinely have no plan, so Hydra
                      // has no reliable way to tell those apart. State only what's true:
                      // no credits-plan usage is tracked here. Don't call it "Usage
                      // available" (implies capacity that isn't there) or color it green
                      // (implies room to spend).
                      const noPlan = stats && !stats.error && stats.limit === 0;
                      return (
                        <div className="usage-line">
                          <div className={`usage-track ${noPlan ? "usage-track-empty" : ""}`}>
                            <div
                              className="usage-fill"
                              style={{ width: `${noPlan ? 0 : stats?.percent ?? 0}%` }}
                            />
                          </div>
                          <span className={stats?.error ? "usage-error" : ""}>
                            {stats?.error
                              ? "Re-login"
                              : noPlan
                                ? "No credits usage tracked (SuperGrok or no plan)"
                                : stats?.percent != null && stats?.used != null && stats?.limit != null
                                  ? `${stats.label} · ${formatCredits(stats.used)} / ${formatCredits(stats.limit)} this month`
                                  : stats?.label ?? "Loading..."}
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                  <div className="row-actions">
                    {!profile.isActive && (
                      <button
                        className="switch-button"
                        onClick={() => void switchTo(profile)}
                        disabled={busy === profile.id}
                      >
                        <Zap size={16} />
                        Switch
                      </button>
                    )}
                    <button
                      className="icon-button"
                      title="Rename profile"
                      onClick={() => void rename(profile)}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      className="icon-button danger"
                      title="Remove profile"
                      onClick={() => void remove(profile)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <footer>
        <span>{message}</span>
        <span>Credentials stay local</span>
      </footer>
    </main>
  );
}

export default App;
