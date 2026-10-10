import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { hashText, makeDiary, type DiaryDraft, type DiaryPlan } from "./diary";
import { parseMapCoordinates } from "./mapCoordinates.mjs";
import {
  checkGemmaCompatibility,
  forgetGemma,
  GEMMA_MODEL_SIZE,
  loadGemma,
  unloadGemma,
  writeGemmaDiary,
} from "./gemma";

type Profile = {
  name: string;
  about: string;
  interests: string;
  outingStyle: string;
  locality: string;
};

type Place = {
  id: string;
  name: string;
  locality: string;
  details: string;
  interests: string;
  source?: "openstreetmap";
  osmType?: "node" | "way" | "relation";
  osmId?: number;
  category?: string;
};

type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  tags?: Record<string, string>;
};

type OverpassResponse = {
  elements?: OverpassElement[];
};

type GeocodingResult = {
  lat: string;
  lon: string;
  display_name: string;
  address?: Record<string, string>;
};

type DiaryEntry = {
  id: string;
  placeName: string;
  locality: string;
  date: string;
  createdAt: number;
  story: string;
  moments: string[];
};

type OutingPlan = {
  locality: string;
  timing: string;
  duration: string;
  interests: string;
  friendJoining: boolean;
  friendPreferences: string;
  place: Place;
  narrativeSeed?: number;
};

type SessionDraft = {
  notes: string;
  mood: string;
  moments: string[];
};

type AppData = {
  profile: Profile;
  places: Place[];
  entries: DiaryEntry[];
  plan: OutingPlan | null;
  draft: SessionDraft;
};

type Screen = "onboarding" | "home" | "suggestion" | "outing" | "wrap-up" | "diary" | "entry" | "settings";
type GemmaPhase = "checking" | "unsupported" | "available" | "loading" | "ready" | "forgetting" | "error";
type GemmaStatus = { phase: GemmaPhase; message: string; progress: number };

const STORAGE_KEY = "wayfarer.local.v1";
const NEARBY_RADIUS_METERS = 3000;
const GPS_AREA_LABEL = "Near my current location (3 km search)";
const EMPTY_PROFILE: Profile = { name: "", about: "", interests: "", outingStyle: "", locality: "" };
const EMPTY_DRAFT: SessionDraft = { notes: "", mood: "", moments: [] };
const EMPTY_DATA: AppData = { profile: EMPTY_PROFILE, places: [], entries: [], plan: null, draft: EMPTY_DRAFT };
const NAV_ITEMS: { screen: Screen; label: string; icon: string }[] = [
  { screen: "home", label: "Today", icon: "sun" },
  { screen: "diary", label: "My diary", icon: "book" },
  { screen: "settings", label: "Settings", icon: "settings" },
];

function readSavedData(): { data: AppData; error: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { data: EMPTY_DATA, error: "" };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("Saved local data is not in the expected format.");
    const saved = parsed as Partial<AppData>;
    return {
      data: {
        profile: { ...EMPTY_PROFILE, ...(saved.profile ?? {}) },
        places: Array.isArray(saved.places) ? saved.places : [],
        entries: Array.isArray(saved.entries) ? saved.entries : [],
        plan: saved.plan ?? null,
        draft: { ...EMPTY_DRAFT, ...(saved.draft ?? {}) },
      },
      error: "",
    };
  } catch (error) {
    return {
      data: EMPTY_DATA,
      error: `I couldn’t read saved browser data. Your original data was left untouched. ${error instanceof Error ? error.message : ""}`,
    };
  }
}

function describeOsmElement(tags: Record<string, string>, interests: string): { category: string; interestLabels: string } {
  const fields = ["amenity", "leisure", "tourism", "sport", "historic", "shop"] as const;
  const value = fields.map((field) => tags[field]).find(Boolean) ?? "point of interest";
  const category = value === "books" ? "bookshop" : String(value).replaceAll("_", " ");
  const studyInterest = /stud|learn|read|book|quiet/i.test(interests);
  const adventureInterest = /adventure|thrill|active|explor|outdoor|activity|sport|hike|climb/i.test(interests);
  const adventureMatch =
    ["climbing", "escape_game", "amusement_arcade", "bowling_alley", "sports_centre", "boat_rental", "bicycle_rental"].includes(tags.amenity ?? "") ||
    ["climbing", "adventure_park", "water_park", "disc_golf_course", "nature_reserve", "park", "golf_course", "marina", "skatepark", "swimming_pool", "pitch"].includes(tags.leisure ?? "") ||
    ["theme_park", "viewpoint"].includes(tags.tourism ?? "") ||
    /^(canoe|kayak|paddling|rowing|whitewater|climbing|cycling|mountain_biking|bmx|hiking|horse_riding|skiing|snowboarding|surfing|sailing|skateboarding|roller_skating|swimming)$/i.test(tags.sport ?? "");
  const interestLabels = studyInterest && (["library", "university", "college", "school"].includes(String(value)) || tags.shop === "books")
    ? "studying, learning"
    : studyInterest && value === "cafe"
      ? "cafe, a possible study spot (check its visitor policy)"
      : adventureInterest && adventureMatch
        ? "adventure"
        : category;
  return { category, interestLabels };
}

async function fetchNearbyPlaces(latitude: number, longitude: number, interests: string, signal: AbortSignal, refinement = "", placeLocality = "your current location"): Promise<Place[]> {
  const response = await fetch("/api/nearby", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      latitude: Number(latitude.toFixed(3)),
      longitude: Number(longitude.toFixed(3)),
      radius: NEARBY_RADIUS_METERS,
      interests,
      refinement,
    }),
    signal,
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Nearby search returned an unreadable response. Check the server and try again; your entered details are unchanged.");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Nearby search returned an unexpected response. Check the server and try again; your entered details are unchanged.");
  }
  if (!response.ok) {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string") throw new Error(error.message);
    throw new Error(`Nearby search failed with HTTP ${response.status}. Your entered details are unchanged; try again shortly.`);
  }
  const elements = (payload as OverpassResponse).elements;
  if (!Array.isArray(elements)) {
    throw new Error("Nearby search returned malformed place data. Try again; your entered details are unchanged.");
  }
  const seen = new Set<string>();
  const studyInterest = /stud|learn|read|book|quiet|work/i.test(interests);
  const adventureInterest = /adventure|thrill|active|explor|outdoor|activity|sport|hike|climb/i.test(interests);
  return elements
      .filter((element) => element.tags?.name?.trim())
      .filter((element) => !["private", "no"].includes(element.tags?.access ?? "") &&
        !["yes", "true", "1"].includes(element.tags?.disused ?? "") &&
        !["yes", "true", "1"].includes(element.tags?.abandoned ?? "") &&
        !(adventureInterest && ["restaurant", "cafe", "bar", "pub", "fast_food", "food_court"].includes(element.tags?.amenity ?? "")) &&
        !(/kayak|canoe|paddl|whitewater/i.test(refinement) && element.tags?.leisure === "fitness_centre" && element.tags?.amenity !== "boat_rental"))
      .map((element) => {
        const tags = element.tags ?? {};
        const { category, interestLabels } = describeOsmElement(tags, interests);
        const mappedActivities = [
          tags.kayak_rental === "yes" ? "kayak rental" : "",
          tags.canoe_rental === "yes" ? "canoe rental" : "",
        ].filter(Boolean);
        const addressArea = [tags["addr:city"], tags["addr:state"]].filter(Boolean).join(", ");
        const searchableTags = Object.values(tags).join(" ").toLowerCase().replaceAll("_", " ");
        const refinementTokens = refinement.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
        const refinementScore = refinementTokens.filter((token) => searchableTags.includes(token)).length;
            const refinementAffinity = /kayak|canoe|paddl|rowing/i.test(refinement)
              ? /canoe|kayak|paddl|boat|marina|water/i.test(searchableTags)
          : /cycl|bik|mountain.?bike/i.test(refinement)
            ? /cycl|bik|bmx/i.test(searchableTags)
            : /climb|bould|zip.?line/i.test(refinement)
              ? /climb|bould|zip.?line/i.test(searchableTags)
              : /hike|walk|trail/i.test(refinement)
                ? /hike|walk|trail|nature|park/i.test(searchableTags)
                : /skat/i.test(refinement)
                  ? /skat/i.test(searchableTags)
                  : /swim|pool/i.test(refinement)
                    ? /swim|pool|water_park/i.test(searchableTags)
                    : false;
        return {
          element,
          category,
          interestLabels,
          name: tags.name.trim(),
          sourceKey: `${element.type}/${element.id}`,
          details: [
            `OpenStreetMap categorizes this as ${category}.`,
            mappedActivities.length ? `It also tags it as offering ${mappedActivities.join(" and ")}.` : "",
            addressArea ? `The mapped area is ${addressArea}.` : "",
            "The listing does not confirm current availability, opening hours, visitor access, or safety.",
          ].filter(Boolean).join(" "),
          relevance: (refinement ? refinementScore * 10 + (refinementAffinity ? 20 : 0) : 0) + (studyInterest ? (
            tags.amenity === "library" ? 5 :
              ["university", "college"].includes(tags.amenity ?? "") ? 4 :
                tags.shop === "books" ? 3 :
                  tags.amenity === "cafe" ? 2 : 0
          ) : adventureInterest ? (
            /^(canoe|kayak|paddling|rowing|whitewater|climbing|cycling|mountain_biking|bmx|hiking|horse_riding|skiing|snowboarding|surfing|sailing|skateboarding|roller_skating|swimming)$/i.test(tags.sport ?? "") ? 7 :
              ["climbing", "escape_game", "amusement_arcade", "bowling_alley", "sports_centre", "boat_rental", "bicycle_rental"].includes(tags.amenity ?? "") ? 6 :
                ["climbing", "adventure_park", "water_park", "disc_golf_course", "skatepark", "swimming_pool"].includes(tags.leisure ?? "") ? 6 :
                  ["theme_park", "viewpoint"].includes(tags.tourism ?? "") ? 4 :
                    ["nature_reserve", "golf_course", "marina", "pitch", "park"].includes(tags.leisure ?? "") ? 3 : 0
          ) : 0),
        };
      })
      .filter(({ sourceKey }) => {
        if (seen.has(sourceKey)) return false;
        seen.add(sourceKey);
        return true;
      })
      .sort((a, b) => b.relevance - a.relevance || a.name.localeCompare(b.name))
      .map(({ element, category, interestLabels, name, details }) => ({
        id: `osm-${element.type}-${element.id}`,
        name,
        locality: placeLocality,
        details,
        interests: interestLabels,
        source: "openstreetmap",
        osmType: element.type,
        osmId: element.id,
        category,
      }));
}

function requestDevicePosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser doesn’t offer location access. Enter your area or choose your location on OpenStreetMap below—no GPS needed."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      resolve,
      (error) => reject(new Error(
        error.code === error.PERMISSION_DENIED
          ? "Location permission wasn’t granted. Enter your area or choose your location on OpenStreetMap below—no GPS needed."
          : error.code === error.TIMEOUT
            ? "Your device didn’t provide a location in time. Enter your area or choose your location on OpenStreetMap below—no GPS needed."
            : "Your device location isn’t available right now. Enter your area or choose your location on OpenStreetMap below—no GPS needed.",
      )),
      { enableHighAccuracy: false, maximumAge: 300_000, timeout: 30_000 },
    );
  });
}

function Icon({ name, size = 19 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    sun: "M12 3v2m0 14v2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42M3 12h2m14 0h2M5.64 18.36l1.42-1.42m9.88-9.88 1.42-1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
    book: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21V5.5Zm0 0V19m4-12h8m-8 4h8",
    settings: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0-5.5v2m0 14v2m9-9h-2M5 12H3m15.36-6.36-1.41 1.41M7.05 16.95l-1.41 1.41m12.72 0-1.41-1.41M7.05 7.05 5.64 5.64",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    back: "M19 12H5m6 6-6-6 6-6",
    pin: "M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Zm-5 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
    clock: "M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
    plus: "M12 5v14m-7-7h14",
    heart: "M20.8 8.8c0 5.5-8.8 11-8.8 11s-8.8-5.5-8.8-11a4.8 4.8 0 0 1 8.8-2.3 4.8 4.8 0 0 1 8.8 2.3Z",
    lock: "M5 10h14v11H5V10Zm3 0V7a4 4 0 1 1 8 0v3m-4 5v2",
    camera: "M4 7h3l2-3h6l2 3h3v13H4V7Zm8 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
    download: "M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4",
  };
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name] ?? paths.sun} />
    </svg>
  );
}

export default function App() {
  const [initial] = useState(readSavedData);
  const [data, setData] = useState<AppData>(initial.data);
  const [screen, setScreen] = useState<Screen>(initial.data.profile.name || initial.data.profile.interests ? "home" : "onboarding");
  const [selectedEntryId, setSelectedEntryId] = useState("");
  const [storageError, setStorageError] = useState(initial.error);
  const [online, setOnline] = useState(navigator.onLine);
  const [localVoiceAvailable, setLocalVoiceAvailable] = useState(false);
  const [gemmaStatus, setGemmaStatus] = useState<GemmaStatus>({ phase: "checking", message: "Checking this browser for local Gemma support…", progress: 0 });
  const [toast, setToast] = useState("");

  async function setupGemma() {
    const compatibility = await checkGemmaCompatibility();
    if (!compatibility.supported) {
      setGemmaStatus({ phase: "unsupported", message: compatibility.reason, progress: 0 });
      return;
    }
    setGemmaStatus({ phase: "loading", message: "Loading the local inference runtime…", progress: 0 });
    try {
      await loadGemma((progress, message) => {
        setGemmaStatus({ phase: "loading", message: message || "Preparing Gemma on this device…", progress });
      });
      setGemmaStatus({ phase: "ready", message: "Gemma is loaded on this device. Diary prompts run locally.", progress: 100 });
    } catch (error) {
      setGemmaStatus({
        phase: "error",
        message: `Gemma could not be loaded. Check available GPU memory and model storage, then retry. ${error instanceof Error ? error.message : "Unknown runtime error."}`,
        progress: 0,
      });
    }
  }

  async function removeGemma() {
    setGemmaStatus({ phase: "forgetting", message: "Unloading Gemma and removing its cached model files…", progress: 0 });
    try {
      await forgetGemma();
      setGemmaStatus({ phase: "available", message: "Gemma and its cached model files were removed from this browser.", progress: 0 });
    } catch (error) {
      setGemmaStatus({
        phase: "error",
        message: `Gemma could not be fully removed from browser storage. ${error instanceof Error ? error.message : "Unknown storage error."}`,
        progress: 0,
      });
    }
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      const compatibility = await checkGemmaCompatibility();
      if (!active) return;
      if (!compatibility.supported) {
        setGemmaStatus({ phase: "unsupported", message: compatibility.reason, progress: 0 });
        return;
      }
      if (active) setGemmaStatus({
        phase: "available",
        message: "WebGPU is available. Gemma is loaded only when you choose to set it up; any cached model files will be reused.",
        progress: 0,
      });
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setOnline(navigator.onLine);
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  useEffect(() => {
    const updateVoices = () => {
      setLocalVoiceAvailable(
        "speechSynthesis" in window && speechSynthesis.getVoices().some((voice) => voice.localService),
      );
    };
    updateVoices();
    if ("speechSynthesis" in window) speechSynthesis.addEventListener("voiceschanged", updateVoices);
    return () => {
      if ("speechSynthesis" in window) speechSynthesis.removeEventListener("voiceschanged", updateVoices);
    };
  }, []);

  useEffect(() => {
    if (storageError) return;
    try {
      const hasContent = Object.values(data.profile).some((value) => value.trim()) ||
        data.places.length > 0 || data.entries.length > 0 || data.plan !== null ||
        Boolean(data.draft.notes.trim() || data.draft.mood.trim() || data.draft.moments.length);
      if (hasContent) localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      else localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      setStorageError(`I couldn’t save changes in this browser. Check available site storage. ${error instanceof Error ? error.message : ""}`);
    }
  }, [data, storageError]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const selectedEntry = data.entries.find((entry) => entry.id === selectedEntryId);
  const hasProfile = Boolean(data.profile.interests && data.profile.outingStyle);

  function updateData(update: (current: AppData) => AppData) {
    setData((current) => update(current));
  }

  function addPlace(place: Place) {
    updateData((current) => ({
      ...current,
      places: [...current.places, place],
    }));
    setToast("Saved on this device.");
  }

  function savePlan(plan: OutingPlan) {
    updateData((current) => ({ ...current, plan, draft: EMPTY_DRAFT }));
    setScreen("suggestion");
  }

  function saveEntry(draft: SessionDraft, generatedStory?: string) {
    if (!data.plan) return;
    const entry = makeDiary(data.plan, draft, generatedStory);
    updateData((current) => ({ ...current, entries: [entry, ...current.entries], plan: null, draft: EMPTY_DRAFT }));
    setSelectedEntryId(entry.id);
    setScreen("entry");
  }

  function updateDraft(draft: SessionDraft) {
    updateData((current) => ({ ...current, draft }));
  }

  function deleteEntry(id: string) {
    updateData((current) => ({ ...current, entries: current.entries.filter((entry) => entry.id !== id) }));
    setScreen("diary");
    setToast("Diary entry deleted from this device.");
  }

  function exportData() {
    const file = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "wayfarer-my-local-data.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function deleteAllData() {
    void unloadGemma().catch((error: unknown) => {
      setGemmaStatus({
        phase: "error",
        message: `Your diary data was deleted, but Gemma could not be unloaded from GPU memory. ${error instanceof Error ? error.message : "Unknown runtime error."}`,
        progress: 0,
      });
    });
    try {
      localStorage.removeItem(STORAGE_KEY);
      setData(EMPTY_DATA);
      setStorageError("");
      setScreen("onboarding");
      setToast("Your local data has been deleted.");
    } catch (error) {
      setStorageError(`I couldn’t delete browser storage. ${error instanceof Error ? error.message : ""}`);
    }
  }

  function finishOnboarding(profile: Profile) {
    updateData((current) => ({ ...current, profile }));
    setScreen("home");
  }

  const title: Record<Screen, string> = {
    onboarding: "A companion for going out",
    home: "Your next little adventure",
    suggestion: "A plan that feels like you",
    outing: "Out here, together",
    "wrap-up": "A few things to remember",
    diary: "Your diary",
    entry: "One day, remembered",
    settings: "Your space, your rules",
  };

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <button className="brand" onClick={() => setScreen("home")} aria-label="Wayfarer home">
          <span className="brand-mark"><Icon name="sun" size={22} /></span>
          <span>wayfarer<span className="brand-period">.</span></span>
        </button>
        <div className="sidebar-note">A little more wonder<br />in the everyday.</div>
        <p className="nav-caption">YOUR SPACE</p>
        <nav className="side-nav" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.screen}
              className={`nav-item ${screen === item.screen || (screen === "entry" && item.screen === "diary") ? "active" : ""}`}
              onClick={() => setScreen(item.screen)}
            >
              <Icon name={item.icon} /><span>{item.label}</span>
              {item.screen === "diary" && data.entries.length > 0 && <span className="nav-count">{data.entries.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-chip"><Icon name="lock" size={15} /><span>Your stories stay yours</span></div>
          <p className="sidebar-disclaimer">No account or cloud AI. GPS, manual map-point and area searches use OpenStreetMap only when you ask.</p>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb"><span>Wayfarer</span><span className="crumb-separator">/</span><strong>{title[screen]}</strong></div>
          <span className={`network-status ${online ? "" : "offline"}`}><span className="status-dot" />{online ? "Local-first" : "Offline"}</span>
        </header>
        {storageError && <div className="notice notice-error" role="alert">{storageError}</div>}
        <div className="page-area">
          {screen === "onboarding" && <Onboarding profile={data.profile} onComplete={finishOnboarding} />}
          {screen === "home" && (
            <Home
              profile={data.profile}
              places={data.places}
              onProfileChange={(profile) => updateData((current) => ({ ...current, profile }))}
              onAddPlace={addPlace}
              onSuggest={savePlan}
              onDiary={() => setScreen("diary")}
            />
          )}
          {screen === "suggestion" && data.plan && <Suggestion plan={data.plan} onStart={() => setScreen("outing")} onBack={() => setScreen("home")} />}
          {screen === "outing" && data.plan && <Outing plan={data.plan} draft={data.draft} localVoiceAvailable={localVoiceAvailable} onDraftChange={updateDraft} onEnd={() => setScreen("wrap-up")} onSpeak={(text) => {
            if (!localVoiceAvailable || !("speechSynthesis" in window)) {
              setToast("A local text-to-speech voice isn’t available in this browser. Your typed notes still work.");
              return;
            }
            const localVoice = speechSynthesis.getVoices().find((voice) => voice.localService);
            if (!localVoice) {
              setToast("A local text-to-speech voice isn’t available in this browser. Your typed notes still work.");
              return;
            }
            speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.voice = localVoice;
            speechSynthesis.speak(utterance);
          }} />}
          {screen === "wrap-up" && data.plan && <WrapUp
            plan={data.plan}
            draft={data.draft}
            gemmaStatus={gemmaStatus}
            onDraftChange={updateDraft}
            onSave={saveEntry}
            onBack={() => setScreen("outing")}
            onSetupGemma={setupGemma}
            onForgetGemma={removeGemma}
            onGenerate={writeGemmaDiary}
          />}
          {screen === "diary" && (
            <DiaryLibrary entries={data.entries} onOpen={(entry) => { setSelectedEntryId(entry.id); setScreen("entry"); }} onCreate={() => setScreen("home")} />
          )}
          {screen === "entry" && selectedEntry && <DiaryView entry={selectedEntry} onBack={() => setScreen("diary")} onDelete={() => deleteEntry(selectedEntry.id)} />}
          {screen === "entry" && !selectedEntry && <EmptyEntry onBack={() => setScreen("diary")} />}
          {screen === "settings" && <Settings
            data={data}
            localVoiceAvailable={localVoiceAvailable}
            gemmaStatus={gemmaStatus}
            onSetupGemma={setupGemma}
            onForgetGemma={removeGemma}
            onExport={exportData}
            onDeleteAll={deleteAllData}
          />}
        </div>
        <footer className="footer-note"><Icon name="lock" size={14} /><span>Private by design <span className="footer-dot">·</span> Stored in this browser, not encrypted by this app</span></footer>
      </main>
      <nav className="mobile-nav" aria-label="Main navigation">
        {NAV_ITEMS.map((item) => (
          <button key={item.screen} className={screen === item.screen || (screen === "entry" && item.screen === "diary") ? "mobile-active" : ""} onClick={() => setScreen(item.screen)}>
            <Icon name={item.icon} size={20} /><span>{item.label}</span>
          </button>
        ))}
      </nav>
      {toast && <div className="toast" role="status">{toast}</div>}
      {hasProfile && <span className="sr-only" aria-live="polite">Profile saved on this device.</span>}
    </div>
  );
}

function Onboarding({ profile, onComplete }: { profile: Profile; onComplete: (profile: Profile) => void }) {
  const [name, setName] = useState(profile.name);
  const [about, setAbout] = useState(profile.about);
  const [interests, setInterests] = useState(profile.interests);
  const [outingStyle, setOutingStyle] = useState(profile.outingStyle);
  const [locality, setLocality] = useState(profile.locality);
  const [error, setError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!interests.trim() || !outingStyle.trim()) {
      setError("A little about what you enjoy and your kind of outing will help me get started.");
      return;
    }
    onComplete({ name: name.trim(), about: about.trim(), interests: interests.trim(), outingStyle: outingStyle.trim(), locality: locality.trim() });
  }

  return (
    <div className="onboarding-layout">
      <section className="onboarding-copy">
        <p className="eyebrow">A FRESH LITTLE START</p>
        <h1>Going out is better<br /><em>when you notice more.</em></h1>
        <p className="lead">Let’s get to know what makes a good day out feel like <i>your</i> kind of day.</p>
        <div className="onboarding-art" aria-hidden="true">
          <div className="art-sun" />
          <div className="art-path" />
          <div className="art-hill art-hill-back" />
          <div className="art-hill art-hill-front" />
          <div className="art-flower flower-one">✳</div><div className="art-flower flower-two">✿</div>
          <span className="art-caption">made for the meandering</span>
        </div>
      </section>
      <form className="onboarding-form" onSubmit={submit}>
        <div className="form-heading"><span className="step-pill">A FEW THINGS ABOUT YOU</span><span className="step-count">01 / 01</span></div>
        <label className="field-label">What should I call you? <span className="optional-label">OPTIONAL</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="A name or nickname" autoComplete="given-name" />
        </label>
        <label className="field-label">A little about you <span className="optional-label">OPTIONAL</span>
          <textarea value={about} onChange={(event) => setAbout(event.target.value)} placeholder="The little things that make you, you…" rows={2} />
        </label>
        <label className="field-label">What do you love doing out in the world? <span className="required-mark">*</span>
          <textarea required value={interests} onChange={(event) => setInterests(event.target.value)} placeholder="Wandering bookshops, finding quiet corners, being near water…" rows={3} />
        </label>
        <label className="field-label">What kind of outing feels like you? <span className="required-mark">*</span>
          <textarea required value={outingStyle} onChange={(event) => setOutingStyle(event.target.value)} placeholder="Unhurried and outdoorsy, a little adventure, low-key…" rows={2} />
        </label>
        <label className="field-label">Where do you usually wander? <span className="optional-label">OPTIONAL</span>
          <input value={locality} onChange={(event) => setLocality(event.target.value)} placeholder="Your town or neighbourhood" autoComplete="address-level2" />
          <span className="field-hint">I’ll ask when I need your area. I don’t guess or track your location.</span>
        </label>
        <div className="story-transparency"><span className="transparency-icon"><Icon name="heart" size={17} /></span><span>This companion’s diary is a little creative narration, composed on this device from the details you choose to share. It isn’t a literal memory or an actual friend.</span></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary button-full" type="submit">Let’s begin <Icon name="arrow" /></button>
        <p className="form-privacy">No sign-up. Your answers stay right here.</p>
      </form>
    </div>
  );
}

function Home({
  profile, places, onProfileChange, onAddPlace, onSuggest, onDiary,
}: {
  profile: Profile; places: Place[]; onProfileChange: (profile: Profile) => void; onAddPlace: (place: Place) => void;
  onSuggest: (plan: OutingPlan) => void; onDiary: () => void;
}) {
  const [locality, setLocality] = useState(profile.locality);
  const [typedLocality, setTypedLocality] = useState(profile.locality);
  const [timing, setTiming] = useState("");
  const [duration, setDuration] = useState("");
  const [interests, setInterests] = useState(profile.interests);
  const [friendJoining, setFriendJoining] = useState(false);
  const [friendPreferences, setFriendPreferences] = useState("");
  const [error, setError] = useState("");
  const [showPlaceForm, setShowPlaceForm] = useState(false);
  const [placeName, setPlaceName] = useState("");
  const [placeArea, setPlaceArea] = useState(profile.locality);
  const [placeDetails, setPlaceDetails] = useState("");
  const [placeInterests, setPlaceInterests] = useState("");
  const [placeConfirmed, setPlaceConfirmed] = useState(false);
  const [placeError, setPlaceError] = useState("");
  const [nearbyPlaces, setNearbyPlaces] = useState<Place[]>([]);
  const [nearbyStatus, setNearbyStatus] = useState("");
  const [nearbyError, setNearbyError] = useState("");
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [showManualLocation, setShowManualLocation] = useState(false);
  const [manualLocationInput, setManualLocationInput] = useState("");
  const [chosenPlaceId, setChosenPlaceId] = useState("");
  const [visibleNearbyCount, setVisibleNearbyCount] = useState(6);
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [refinedInterests, setRefinedInterests] = useState("");
  const [nearbyAreaLabel, setNearbyAreaLabel] = useState(GPS_AREA_LABEL);
  const [searchPosition, setSearchPosition] = useState<{ latitude: number; longitude: number; locality: string } | null>(null);
  const nearbyController = useRef<AbortController | null>(null);

  useEffect(() => () => nearbyController.current?.abort(), []);

  const areaPlaces = useMemo(
    () => [
      ...places.filter((place) => place.locality.trim().toLocaleLowerCase() === locality.trim().toLocaleLowerCase()),
      ...(locality === nearbyAreaLabel ? nearbyPlaces : []),
    ],
    [places, locality, nearbyPlaces, nearbyAreaLabel],
  );

  async function findNearbyPlaces() {
    nearbyController.current?.abort();
    const controller = new AbortController();
    nearbyController.current = controller;
    setNearbyLoading(true);
    setNearbyError("");
    setNearbyStatus("");
    setNearbyPlaces([]);
    setSearchPosition(null);
    setChosenPlaceId("");
    setVisibleNearbyCount(6);
    setRefinedInterests("");
    setShowMoreOptions(false);
    try {
      const position = await requestDevicePosition();
      if (controller.signal.aborted) return;
      setSearchPosition({ latitude: position.coords.latitude, longitude: position.coords.longitude, locality: "your current location" });
      setNearbyAreaLabel(GPS_AREA_LABEL);
      setNearbyStatus("Location allowed. Looking for named places within 3 km of this device…");
      const results = await fetchNearbyPlaces(position.coords.latitude, position.coords.longitude, interests, controller.signal, "", "your current location");
      if (controller.signal.aborted) return;
      setLocality(GPS_AREA_LABEL);
      setNearbyPlaces(results);
      if (!results.length) setNearbyStatus("No named places matching these interests appeared in the 3 km OpenStreetMap search. Try another interest or add a place you know.");
      else setNearbyStatus(`Found ${results.length} named places in OpenStreetMap within 3 km. Choose one to use.`);
    } catch (error) {
      if (controller.signal.aborted) return;
      setShowManualLocation(true);
      setNearbyError(error instanceof Error ? error.message : "Nearby place search failed. You can still enter a place manually.");
      setNearbyStatus("");
    } finally {
      if (!controller.signal.aborted) setNearbyLoading(false);
    }
  }

  async function searchTypedArea() {
    const area = typedLocality.trim();
    if (!area) {
      setNearbyError("Enter a town, city, or neighbourhood first so I know which area to search.");
      return;
    }
    nearbyController.current?.abort();
    const controller = new AbortController();
    nearbyController.current = controller;
    setNearbyLoading(true);
    setNearbyError("");
    setNearbyStatus(`Finding the approximate centre of “${area}”…`);
    setNearbyPlaces([]);
    setChosenPlaceId("");
    setVisibleNearbyCount(6);
    setRefinedInterests("");
    setShowMoreOptions(false);
    try {
      const geocodeUrl = new URL("https://nominatim.openstreetmap.org/search");
      geocodeUrl.searchParams.set("format", "jsonv2");
      geocodeUrl.searchParams.set("limit", "1");
      geocodeUrl.searchParams.set("q", area);
      const response = await fetch(geocodeUrl, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(`OpenStreetMap area lookup returned HTTP ${response.status}. Try again or use GPS.`);
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) throw new Error("OpenStreetMap returned an unexpected area lookup response.");
      const candidate: unknown = payload[0];
      if (!candidate || typeof candidate !== "object") {
        setNearbyStatus(`I couldn’t find “${area}” in OpenStreetMap. Try a more specific area or add a place manually.`);
        return;
      }
      const result = candidate as GeocodingResult;
      if (typeof result.lat !== "string" || typeof result.lon !== "string" ||
        !Number.isFinite(Number(result.lat)) || !Number.isFinite(Number(result.lon)) ||
        typeof result.display_name !== "string") {
        throw new Error("OpenStreetMap returned an area result in an unexpected format.");
      }
      const localityName = [
        result.address?.city ?? result.address?.town ?? result.address?.village ?? result.address?.municipality ?? result.display_name.split(",")[0],
        result.address?.state,
      ].filter(Boolean).join(", ");
      const placeLabel = localityName || area;
      setSearchPosition({ latitude: Number(result.lat), longitude: Number(result.lon), locality: placeLabel });
      const areaLabel = `Near ${placeLabel} (3 km search)`;
      setNearbyAreaLabel(areaLabel);
      setNearbyStatus(`Searching within 3 km of the mapped centre of ${placeLabel}…`);
      const results = await fetchNearbyPlaces(Number(result.lat), Number(result.lon), interests, controller.signal, "", placeLabel);
      if (controller.signal.aborted) return;
      setLocality(areaLabel);
      setNearbyPlaces(results);
      setNearbyStatus(results.length
        ? `Found ${results.length} named places within 3 km of the mapped centre of ${placeLabel}. Choose one to use.`
        : `No named places matching these interests appeared within 3 km of ${placeLabel}. Try another area or add a place you know.`);
    } catch (error) {
      if (controller.signal.aborted) return;
      setNearbyError(error instanceof Error ? error.message : "The typed area search failed. You can still try GPS or add a place manually.");
      setNearbyStatus("");
    } finally {
      if (!controller.signal.aborted) setNearbyLoading(false);
    }
  }

  async function searchManualMapPoint() {
    const coordinates = parseMapCoordinates(manualLocationInput);
    if (!coordinates) {
      setNearbyError("Enter latitude and longitude, or paste a location link copied from OpenStreetMap’s Share panel.");
      return;
    }
    nearbyController.current?.abort();
    const controller = new AbortController();
    nearbyController.current = controller;
    const placeLabel = "your manually selected map point";
    const areaLabel = "Near selected map point (3 km search)";
    setNearbyLoading(true);
    setNearbyError("");
    setNearbyPlaces([]);
    setChosenPlaceId("");
    setVisibleNearbyCount(6);
    setRefinedInterests("");
    setShowMoreOptions(false);
    setSearchPosition({ ...coordinates, locality: placeLabel });
    setNearbyAreaLabel(areaLabel);
    setNearbyStatus("Searching within 3 km of the map point you selected…");
    try {
      const results = await fetchNearbyPlaces(
        coordinates.latitude,
        coordinates.longitude,
        interests,
        controller.signal,
        "",
        placeLabel,
      );
      if (controller.signal.aborted) return;
      setLocality(areaLabel);
      setNearbyPlaces(results);
      setNearbyStatus(results.length
        ? `Found ${results.length} named places within 3 km of your selected map point. Choose one to use.`
        : "No named places matching these interests appeared within 3 km of your selected map point. Try another point or add a place you know.");
    } catch (error) {
      if (controller.signal.aborted) return;
      setNearbyError(error instanceof Error ? error.message : "The map-point search failed. Check the coordinates or try again.");
      setNearbyStatus("");
    } finally {
      if (!controller.signal.aborted) setNearbyLoading(false);
    }
  }

  async function findMoreOptions(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!searchPosition || !refinedInterests.trim()) {
      setNearbyError("Tell me what you’d like to do, then I can look for more matching options nearby.");
      return;
    }
    nearbyController.current?.abort();
    const controller = new AbortController();
    nearbyController.current = controller;
    setNearbyLoading(true);
    setNearbyError("");
    setNearbyStatus(`Looking nearby for ${refinedInterests.trim()}…`);
    try {
      const results = await fetchNearbyPlaces(
        searchPosition.latitude,
        searchPosition.longitude,
        `${interests} ${refinedInterests.trim()}`,
        controller.signal,
        refinedInterests.trim(),
        searchPosition.locality,
      );
      if (controller.signal.aborted) return;
      if (results.length) {
        setNearbyPlaces(results);
        setChosenPlaceId("");
        setVisibleNearbyCount(6);
        setNearbyStatus(`Found ${results.length} places for “${refinedInterests.trim()}”. Choose the one you prefer, or ask for even more options.`);
      } else {
        setNearbyStatus(`I couldn’t find named places matching “${refinedInterests.trim()}” nearby. Your previous options are still here; try another activity.`);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setNearbyError(error instanceof Error ? error.message : "More nearby options couldn’t be loaded. Try again or keep browsing the current places.");
      setNearbyStatus("");
    } finally {
      if (!controller.signal.aborted) setNearbyLoading(false);
    }
  }

  function buildSuggestion(preferredPlace?: Place) {
    const hours = Number(duration);
    if (!locality.trim() || !timing.trim() || !duration || !Number.isFinite(hours) || hours <= 0 || hours > 24 || !interests.trim()) {
      setError("Before I make a plan, tell me where and when you’d like to go, how long you have, and what you feel like doing.");
      return;
    }
    const suggestionsFor = friendJoining && friendPreferences.trim()
      ? `${interests} ${friendPreferences}`
      : interests;
    const tokens = suggestionsFor.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
    const bestMatch = preferredPlace ?? areaPlaces.find((place) => place.id === chosenPlaceId) ?? [...areaPlaces].sort((a, b) => {
      const score = (place: Place) => tokens.filter((token) => `${place.name} ${place.details} ${place.interests}`.toLowerCase().includes(token)).length;
      return score(b) - score(a);
    })[0];
    if (!bestMatch) {
      setError(`I don’t have a confirmed place or OpenStreetMap result for ${locality.trim()} yet. Search nearby with GPS or add a place below.`);
      return;
    }
    const gpsSearch = bestMatch.source === "openstreetmap";
    const outingInterests = [interests.trim(), refinedInterests.trim()].filter(Boolean).join("; especially ");
    onProfileChange({ ...profile, interests: interests.trim(), locality: gpsSearch ? profile.locality : locality.trim() });
    onSuggest({
      locality: gpsSearch ? `within 3 km of ${bestMatch.locality}` : locality.trim(),
      timing: timing.trim(),
      duration: `${hours} ${hours === 1 ? "hour" : "hours"}`,
      interests: outingInterests,
      friendJoining,
      friendPreferences: friendPreferences.trim(),
      place: bestMatch,
      narrativeSeed: hashText(crypto.randomUUID()),
    });
  }

  function submitPlace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!placeConfirmed) {
      setPlaceError("Please confirm that you verified this place information yourself.");
      return;
    }
    const manualPlace: Place = {
      id: crypto.randomUUID(),
      name: placeName.trim(),
      locality: placeArea.trim(),
      details: placeDetails.trim(),
      interests: placeInterests.trim(),
    };
    onAddPlace(manualPlace);
    if (locality !== manualPlace.locality) setLocality(manualPlace.locality);
    setTypedLocality(manualPlace.locality);
    setChosenPlaceId(manualPlace.id);
    setNearbyStatus("Your place is ready to use for this outing.");
    setPlaceName("");
    setPlaceDetails("");
    setPlaceInterests("");
    setPlaceConfirmed(false);
    setPlaceError("");
  }

  function suggest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    buildSuggestion();
  }

  return (
    <div className="home-view">
      <section className="welcome-row">
        <div><p className="eyebrow">{getGreeting()}</p><h1>Somewhere to be.<br /><em>Nowhere to rush.</em></h1><p className="lead">Let’s find a little outing that fits the day you actually have.</p></div>
        <div className="welcome-stamp"><Icon name="sun" size={30} /><span>A day<br />your way</span></div>
      </section>
      <div className="home-grid">
        <form className="plan-card" onSubmit={suggest}>
          <div className="card-header"><div><span className="section-kicker">LET’S MAKE A PLAN</span><h2>What sounds good?</h2></div><span className="step-number">01</span></div>
          <label className="field-label">Where would you like to explore? <span className="required-mark">*</span>
            <div className="input-with-icon"><Icon name="pin" size={17} /><input required value={locality} onChange={(event) => {
              setLocality(event.target.value);
              setTypedLocality(event.target.value);
              setChosenPlaceId("");
              if (locality === nearbyAreaLabel) {
                setNearbyPlaces([]);
                setSearchPosition(null);
                setNearbyAreaLabel("");
                setNearbyStatus("");
                setNearbyError("");
              }
            }} placeholder="Town or neighbourhood" autoComplete="address-level2" /></div>
          </label>
          <div className="gps-search-card">
            <div className="gps-search-copy">
              <strong>Need somewhere nearby?</strong>
              <span>Share your current device location to find nearby places matched to your interests in OpenStreetMap. This searches where you are now, not the town typed above.</span>
            </div>
            <p className="gps-consent-note">GPS works only after browser permission. Coordinates rounded to about 100 m and your interests go to this app’s nearby-search server, which requests a 3 km search from OpenStreetMap. This app does not save the coordinates.</p>
            <button type="button" className="button button-secondary button-full" onClick={() => { void findNearbyPlaces(); }} disabled={nearbyLoading}>
              <Icon name="pin" size={16} />{nearbyLoading ? "Finding nearby places…" : "Allow GPS & find nearby places"}
            </button>
            <p className="gps-consent-note">If GPS is slow or unavailable, search the typed area instead. That sends the area text to OpenStreetMap Nominatim for an approximate centre, then sends rounded coordinates and your interests to this app’s nearby-search server. It does not request device location.</p>
            <button type="button" className="button button-quiet button-full" onClick={() => { void searchTypedArea(); }} disabled={nearbyLoading || !typedLocality.trim()}>
              {nearbyLoading ? "Searching…" : "Search typed area without GPS"}
            </button>
            <button
              type="button"
              className="text-link manual-location-toggle"
              aria-expanded={showManualLocation}
              onClick={() => setShowManualLocation((shown) => !shown)}
            >
              {showManualLocation ? "Hide manual map location" : "Set my location manually (no GPS)"}
            </button>
            {showManualLocation && (
              <div className="manual-location-panel">
                <strong>Choose your location on OpenStreetMap</strong>
                <p>Open the map, move it to where you are, then use its Share panel to copy the map link. Paste that link here; the app reads the map centre. You can also enter latitude, longitude directly.</p>
                <a
                  className="button button-secondary button-full"
                  href={typedLocality.trim()
                    ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(typedLocality.trim())}`
                    : "https://www.openstreetmap.org/"}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open OpenStreetMap in a new tab ↗
                </a>
                <label className="field-label">Coordinates or copied OpenStreetMap link
                  <input
                    value={manualLocationInput}
                    onChange={(event) => setManualLocationInput(event.target.value)}
                    placeholder="42.3601, -71.0589 or paste a map link"
                    autoComplete="off"
                  />
                </label>
                <p className="gps-consent-note">When you search, coordinates rounded to about 100 m and your interests are sent to this app’s nearby-search server, which requests results from OpenStreetMap. This does not request GPS or save your location.</p>
                <button
                  type="button"
                  className="button button-secondary button-full"
                  onClick={() => { void searchManualMapPoint(); }}
                  disabled={nearbyLoading || !manualLocationInput.trim()}
                >
                  {nearbyLoading ? "Finding places…" : "Search around this map point"}
                </button>
              </div>
            )}
            <div className="osm-attribution"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a> · Open Database License</div>
            {nearbyStatus && <p className="gps-search-status" role="status">{nearbyStatus}</p>}
            {nearbyError && <p className="form-error" role="alert">{nearbyError}</p>}
            {nearbyPlaces.length > 0 && (
              <>
                <div className="nearby-results" aria-label="Nearby places from OpenStreetMap">
                {nearbyPlaces.slice(0, visibleNearbyCount).map((place) => (
                  <div className={`nearby-result ${chosenPlaceId === place.id ? "nearby-result-selected" : ""}`} key={place.id}>
                    <div className="nearby-result-copy">
                      <strong>{place.name}</strong>
                      <span>{place.category}{place.interests === "adventure" ? " · adventure idea" : place.interests.includes("studying") || place.interests.includes("learning") ? " · may fit studying" : ""}</span>
                    </div>
                    <button type="button" className="text-link nearby-select" onClick={() => {
                      setChosenPlaceId(place.id);
                      setLocality(place.locality === "your current location" ? GPS_AREA_LABEL : nearbyAreaLabel);
                      setError("");
                      buildSuggestion(place);
                    }}>
                      I prefer this
                    </button>
                    <a className="osm-source-link" href={`https://www.openstreetmap.org/${place.osmType}/${place.osmId}`} target="_blank" rel="noreferrer" aria-label={`View ${place.name} OpenStreetMap record`}>OSM ↗</a>
                  </div>
                ))}
                </div>
                {nearbyPlaces.length > visibleNearbyCount && (
                  <button type="button" className="button button-secondary button-small more-results-button" onClick={() => setVisibleNearbyCount((count) => Math.min(count + 6, nearbyPlaces.length))}>
                    More nearby options ({nearbyPlaces.length - visibleNearbyCount} left)
                  </button>
                )}
                <button type="button" className="text-link more-options-toggle" onClick={() => setShowMoreOptions((shown) => !shown)}>
                  {showMoreOptions ? "Close activity preferences" : "Not quite? Ask for more options"}
                </button>
                {showMoreOptions && (
                  <div className="refine-form">
                    <label className="field-label">What else are you in the mood for?
                      <input value={refinedInterests} onChange={(event) => setRefinedInterests(event.target.value)} placeholder="Kayaking, climbing, a scenic walk…" />
                    </label>
                    <span className="field-hint">I’ll keep using this same current location and 3 km radius. OpenStreetMap receives the follow-up search request.</span>
                    <button type="button" className="button button-secondary button-full" onClick={() => { void findMoreOptions(); }} disabled={nearbyLoading || !refinedInterests.trim()}>
                      {nearbyLoading ? "Looking for options…" : "Find more like this"}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="field-pair">
            <label className="field-label">When? <span className="required-mark">*</span>
              <div className="input-with-icon"><Icon name="clock" size={17} /><input required value={timing} onChange={(event) => setTiming(event.target.value)} placeholder="Today, after 4" /></div>
            </label>
            <label className="field-label">How long? <span className="required-mark">*</span>
              <div className="input-with-icon"><input type="number" required min="1" max="24" step="1" value={duration} onChange={(event) => setDuration(event.target.value)} placeholder="Hours" /><span className="unit-label">hrs</span></div>
            </label>
          </div>
          <label className="field-label">What are you in the mood for? <span className="required-mark">*</span>
            <textarea required value={interests} onChange={(event) => setInterests(event.target.value)} placeholder="A little fresh air, something delicious, a slow wander…" rows={2} />
            {profile.interests && <span className="field-hint">I remember you enjoy: {profile.interests}</span>}
          </label>
          <div className="friend-toggle">
            <label className="toggle-row"><input type="checkbox" checked={friendJoining} onChange={(event) => setFriendJoining(event.target.checked)} /><span className="custom-checkbox" /><span>A friend I know is joining me</span></label>
            {friendJoining && <label className="field-label friend-field">What might they enjoy? <span className="optional-label">OPTIONAL</span><input value={friendPreferences} onChange={(event) => setFriendPreferences(event.target.value)} placeholder="Share whatever you know" /></label>}
          </div>
          <div className="place-availability"><div className="availability-icon"><Icon name="pin" size={17} /></div><div><strong>{areaPlaces.length ? `${areaPlaces.length} place${areaPlaces.length === 1 ? "" : "s"} available` : "No verified places found yet"}</strong><span>{areaPlaces.some((place) => place.source === "openstreetmap") ? "Named places found in OpenStreetMap; choose one above." : areaPlaces.length ? "Your personally confirmed places." : "Search nearby with GPS or add a place you know."}</span></div></div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button button-primary button-full" type="submit">Find me a little adventure <Icon name="arrow" /></button>
          <p className="form-privacy"><Icon name="lock" size={13} /> I won’t make up places, routes or opening times.</p>
        </form>
        <aside className="place-column">
          <div className="side-card side-card-cream">
            <div className="side-card-icon"><Icon name="heart" size={20} /></div>
            <span className="section-kicker">A NOTE TO MYSELF</span>
            <h3>{profile.name ? `Remember what matters to ${profile.name}.` : "Good plans start with what you love."}</h3>
            <p>{profile.outingStyle ? `${profile.outingStyle} — got it. I'll keep that in mind.` : "I’ll pay attention to what you enjoy, not just what’s nearby."}</p>
            {profile.about && <p className="profile-about">“{profile.about}”</p>}
          </div>
          <PlaceManager places={places} locality={locality} showForm={showPlaceForm} setShowForm={setShowPlaceForm} placeName={placeName} setPlaceName={setPlaceName} placeArea={placeArea} setPlaceArea={setPlaceArea} placeDetails={placeDetails} setPlaceDetails={setPlaceDetails} placeInterests={placeInterests} setPlaceInterests={setPlaceInterests} placeConfirmed={placeConfirmed} setPlaceConfirmed={setPlaceConfirmed} placeError={placeError} onSubmit={submitPlace} />
          <button type="button" className="diary-teaser" onClick={onDiary}><span className="diary-teaser-icon"><Icon name="book" /></span><span><strong>{profile.name ? `${profile.name}’s diary` : "Your little diary"}</strong><span>Revisit the days you’ve shared.</span></span><Icon name="arrow" size={17} /></button>
        </aside>
      </div>
    </div>
  );
}

function PlaceManager({
  places, locality, showForm, setShowForm, placeName, setPlaceName, placeArea, setPlaceArea, placeDetails, setPlaceDetails, placeInterests, setPlaceInterests, placeConfirmed, setPlaceConfirmed, placeError, onSubmit,
}: {
  places: Place[]; locality: string; showForm: boolean; setShowForm: (value: boolean) => void; placeName: string; setPlaceName: (value: string) => void;
  placeArea: string; setPlaceArea: (value: string) => void; placeDetails: string; setPlaceDetails: (value: string) => void; placeInterests: string; setPlaceInterests: (value: string) => void;
  placeConfirmed: boolean; setPlaceConfirmed: (value: boolean) => void; placeError: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [showSaved, setShowSaved] = useState(false);
  return (
    <div className="saved-places-card">
      <div className="saved-places-heading"><div><span className="section-kicker">YOUR OWN LITTLE GUIDE</span><h3>Places you trust</h3></div><span className="saved-count">{places.length}</span></div>
      <p>Your own places and nearby places you choose can inspire a plan.</p>
      {places.length > 0 && <button type="button" className="text-link saved-toggle" onClick={() => setShowSaved(!showSaved)}>{showSaved ? "Hide saved places" : "See your saved places"}</button>}
      {showSaved && places.map((place) => <div className="saved-place-item" key={place.id}><strong>{place.name}</strong><span>{place.locality}{place.interests ? ` · ${place.interests}` : ""}</span></div>)}
      <button type="button" className="button button-secondary button-full add-place-button" onClick={() => { setShowForm(!showForm); if (!showForm && locality.trim()) setPlaceArea(locality.trim()); }}>
        <Icon name="plus" size={17} /> {showForm ? "Close place form" : "Add a place you’ve checked"}
      </button>
      {showForm && (
        <form className="place-form" onSubmit={onSubmit}>
          <label className="field-label">Place name <span className="required-mark">*</span><input required value={placeName} onChange={(event) => setPlaceName(event.target.value)} placeholder="The name you know it by" /></label>
          <label className="field-label">Locality <span className="required-mark">*</span><input required value={placeArea} onChange={(event) => setPlaceArea(event.target.value)} placeholder="Town or area" /></label>
          <label className="field-label">Your verified notes <span className="optional-label">OPTIONAL</span><textarea value={placeDetails} onChange={(event) => setPlaceDetails(event.target.value)} placeholder="Only details you personally checked" rows={2} /></label>
          <label className="field-label">Interests it might fit <span className="optional-label">OPTIONAL</span><input value={placeInterests} onChange={(event) => setPlaceInterests(event.target.value)} placeholder="Garden, coffee, walking…" /></label>
          <label className="toggle-row confirmation-row"><input type="checkbox" checked={placeConfirmed} onChange={(event) => setPlaceConfirmed(event.target.checked)} /><span className="custom-checkbox" /><span>I’ve checked these details myself.</span></label>
          {placeError && <p className="form-error" role="alert">{placeError}</p>}
          <button className="button button-primary button-full" type="submit">Save on this device</button>
        </form>
      )}
    </div>
  );
}

function Suggestion({ plan, onStart, onBack }: { plan: OutingPlan; onStart: () => void; onBack: () => void }) {
  return (
    <div className="suggestion-layout">
      <button className="back-link" onClick={onBack}><Icon name="back" size={17} /> Back to the day</button>
      <section className="suggestion-hero">
        <div className="suggestion-art"><div className="art-sun" /><div className="art-hill art-hill-back" /><div className="art-hill art-hill-front" /><span className="art-caption">a little time, well spent</span></div>
        <div className="suggestion-copy"><p className="eyebrow">A THOUGHTFUL LITTLE PLAN</p><h1>{plan.place.name}</h1><p className="suggestion-location"><Icon name="pin" size={16} /> {plan.locality}</p><p className="suggestion-blurb">{plan.place.details || "A place you’ve personally saved and confirmed — a lovely starting point for your outing."}</p></div>
      </section>
      <div className="suggestion-details">
        <div className="suggestion-facts"><span><Icon name="clock" size={17} />{plan.timing}</span><span><Icon name="sun" size={17} />{plan.duration} to wander</span></div>
        <div className="reason-card"><div className="reason-icon"><Icon name="heart" /></div><div><strong>Why it feels like a fit</strong><p>You said you’re interested in {plan.interests}. {plan.place.source === "openstreetmap" ? `OpenStreetMap categorizes it as ${plan.place.category}${/stud|learn|read|book/i.test(plan.interests) && ["library", "university", "college", "books"].includes(plan.place.category ?? "") ? ", which may suit a study outing" : ""}.` : plan.place.interests ? `You tagged this place with ${plan.place.interests}, too.` : "This is one of your own trusted places."}{plan.friendJoining && plan.friendPreferences.trim() ? ` I kept your friend’s interest in ${plan.friendPreferences} in mind, too.` : ""}</p></div></div>
        {plan.friendJoining && <div className="reason-card friend-reason"><div className="reason-icon"><span>♡</span></div><div><strong>Room for your friend, too</strong><p>{plan.friendPreferences ? `I’ll keep in mind that they enjoy ${plan.friendPreferences}.` : "You can decide together what feels good once you’re there."} No account needed — just the people you already chose.</p></div></div>}
        <div className="honesty-note"><Icon name="lock" size={15} /><span>{plan.place.source === "openstreetmap" ? <>Place name and category from <a href={`https://www.openstreetmap.org/${plan.place.osmType}/${plan.place.osmId}`} target="_blank" rel="noreferrer">OpenStreetMap</a>. I haven’t checked current access, opening times, or routes.</> : "Based on a place you saved. I haven’t checked current access, opening times, or routes."}</span></div>
      </div>
      <div className="suggestion-actions"><button className="button button-primary" onClick={onStart}>Let’s go <Icon name="arrow" /></button><button className="button button-quiet" onClick={onBack}>Maybe another time</button></div>
    </div>
  );
}

function Outing({
  plan, draft, localVoiceAvailable, onDraftChange, onEnd, onSpeak,
}: { plan: OutingPlan; draft: SessionDraft; localVoiceAvailable: boolean; onDraftChange: (draft: SessionDraft) => void; onEnd: () => void; onSpeak: (text: string) => void }) {
  const [paused, setPaused] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<"off" | "starting" | "active" | "paused" | "error">("off");
  const [cameraError, setCameraError] = useState("");
  const [capturedImage, setCapturedImage] = useState("");
  const [momentInput, setMomentInput] = useState("");
  const [showImageNote, setShowImageNote] = useState(false);
  const [showCameraInfo, setShowCameraInfo] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (capturedImage) URL.revokeObjectURL(capturedImage);
  }, [capturedImage]);

  async function startCamera() {
    setCameraStatus("starting");
    setCameraError("");
    setShowCameraInfo(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is unavailable here. Try a supported browser on localhost or HTTPS.");
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraStatus("active");
    } catch (error) {
      setCameraStatus("error");
      setCameraError(error instanceof Error ? error.message : "The camera couldn’t be started. You can continue with typed notes.");
    }
  }

  function togglePause() {
    const nextPaused = !paused;
    setPaused(nextPaused);
    streamRef.current?.getVideoTracks().forEach((track) => { track.enabled = !nextPaused; });
    if (cameraStatus === "active" && nextPaused) setCameraStatus("paused");
    else if (cameraStatus === "paused" && !nextPaused) setCameraStatus("active");
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraStatus("off");
  }

  function captureFrame() {
    if (!videoRef.current || videoRef.current.videoWidth === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    const context = canvas.getContext("2d");
    context?.drawImage(videoRef.current, 0, 0);
    const nextImage = canvas.toDataURL("image/jpeg", 0.82);
    setCapturedImage(nextImage);
    setShowImageNote(true);
  }

  function addMoment() {
    const value = momentInput.trim();
    if (!value) return;
    if (draft.moments.length >= 3) return;
    onDraftChange({ ...draft, moments: [...draft.moments, value] });
    setMomentInput("");
  }

  return (
    <div className="outing-view">
      <div className="outing-top"><span className={`live-pill ${paused ? "paused" : ""}`}><span className="status-dot" />{paused ? "PAUSED" : "OUTING IN PROGRESS"}</span><button type="button" className="text-link" onClick={stopCamera}>End camera</button></div>
      <div className="outing-heading"><p className="eyebrow">{plan.locality.toUpperCase()} · {plan.timing.toUpperCase()}</p><h1>{paused ? "Take all the time you need." : "Look up. I’m right here."}</h1><p className="lead">{paused ? "Your outing is paused. Nothing is being recorded." : `I’m here while you explore ${plan.place.name}. The best part is the part you notice.`}</p></div>
      <div className="media-grid">
        <section className="media-card camera-card">
          <div className="media-card-heading"><span className="media-icon"><Icon name="camera" /></span><div><strong>Your surroundings</strong><span>{cameraStatus === "active" ? "Camera is on · preview stays on this device" : cameraStatus === "paused" ? "Camera paused" : "Camera is off"}</span></div><span className={`media-indicator ${cameraStatus === "active" ? "media-indicator-on" : ""}`} /></div>
          {cameraStatus === "active" || cameraStatus === "paused" ? (
            <div className="camera-preview">
              <video ref={videoRef} autoPlay playsInline muted aria-label="Live camera preview shown only on this device" />
              {paused && <span className="paused-overlay">Camera paused</span>}
              <div className="camera-controls"><button className="button button-camera" onClick={captureFrame}>Keep a photo for this moment</button><button className="button button-quiet button-small" onClick={stopCamera}>Turn camera off</button></div>
            </div>
          ) : (
            <div className="camera-placeholder"><div className="camera-placeholder-icon"><Icon name="camera" size={28} /></div><p>Nothing is being viewed until you choose to turn your camera on.</p><button className="button button-secondary button-small" onClick={() => setShowCameraInfo(!showCameraInfo)}>A note before camera access</button>{showCameraInfo && <p className="camera-permission-note">Your browser will ask permission next. The live preview stays in this tab. No photo is saved to your diary unless you choose to keep it, and this demo has no vision model to interpret it.</p>}<button className="button button-primary button-small" onClick={() => { void startCamera(); }}>Turn on camera</button></div>
          )}
          {cameraError && <p className="form-error" role="alert">{cameraError}</p>}
          {capturedImage && <div className="captured-preview"><img src={capturedImage} alt="Photo you just captured; currently held only in memory" /><div><strong>A little moment, just for us</strong><span>This image lives only in this tab’s memory, not your diary or local storage.</span>{showImageNote && <label className="toggle-row"><input type="checkbox" checked={draft.moments.some((moment) => moment.startsWith("I took a photo"))} onChange={(event) => { if (event.target.checked) onDraftChange({ ...draft, moments: [...draft.moments, "I took a photo to remember this scene."] }); else onDraftChange({ ...draft, moments: draft.moments.filter((moment) => !moment.startsWith("I took a photo")) }); }} /><span className="custom-checkbox" /><span>Keep a note about this photo in my diary</span></label>}</div></div>}
          <div className="camera-upload"><label className="text-link upload-label">Or choose an image to describe<input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (capturedImage) URL.revokeObjectURL(capturedImage); setCapturedImage(URL.createObjectURL(file)); setShowImageNote(true); }} /></label>{capturedImage && <button className="text-link" onClick={() => { URL.revokeObjectURL(capturedImage); setCapturedImage(""); setShowImageNote(false); }}>Forget image</button>}</div>
        </section>

        <section className="media-card voice-card">
          <div className="media-card-heading"><span className="media-icon"><Icon name="heart" /></span><div><strong>A little conversation</strong><span>Typed chat · your notes stay on this device</span></div></div>
          <div className="companion-message"><div className="companion-avatar">w.</div><div><p>We made it here. What’s caught your eye so far?</p><span>YOUR COMPANION</span></div></div>
          <label className="field-label">A thought to share<textarea value={draft.notes} disabled={paused} onChange={(event) => onDraftChange({ ...draft, notes: event.target.value })} placeholder="Type a thought, a detail, or what happened…" rows={3} /></label>
          <label className="field-label">A feeling you’d like me to remember <span className="optional-label">OPTIONAL</span><input value={draft.mood} disabled={paused} onChange={(event) => onDraftChange({ ...draft, mood: event.target.value })} placeholder="Only if you want to share how you feel" /></label>
          <div className="voice-actions"><button className="button button-secondary button-small" disabled={!draft.notes.trim() || paused || !localVoiceAvailable} onClick={() => onSpeak(draft.notes)}><span aria-hidden="true">◖)))</span> Read my note aloud</button><span>{localVoiceAvailable ? "Uses a voice marked local by your browser." : "No locally installed speech voice was detected."}</span></div>
          <div className="typed-fallback-note"><Icon name="lock" size={14} /><span>No local speech-recognition model is configured. Use typed notes instead of sending audio to a browser speech service.</span></div>
        </section>
      </div>
      <section className="moment-capture">
        <div className="moment-capture-copy"><div className="moment-icon"><Icon name="heart" /></div><div><h2>A moment worth keeping?</h2><p>Jot down the little things you want me to carry into our diary.</p></div></div>
        <div className="moment-input-row"><input value={momentInput} disabled={paused || draft.moments.length >= 3} onChange={(event) => setMomentInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addMoment(); } }} placeholder={draft.moments.length >= 3 ? "Three moments saved" : "Something you’d like to remember…"} /><button className="button button-secondary button-small" disabled={!momentInput.trim() || paused || draft.moments.length >= 3} onClick={addMoment}><Icon name="plus" size={16} /> Keep this</button></div>
        {draft.moments.length > 0 && <div className="moment-list">{draft.moments.map((moment, index) => <div key={`${moment}-${index}`}><span>{index + 1}</span><p>{moment}</p><button aria-label={`Remove saved moment: ${moment}`} onClick={() => onDraftChange({ ...draft, moments: draft.moments.filter((_, itemIndex) => itemIndex !== index) })}>×</button></div>)}</div>}
      </section>
      <div className="outing-footer"><div className="outing-status-note"><span className={`status-dot ${paused ? "" : "status-dot-green"}`} />{paused ? "Your outing is paused" : "All notes are saved locally, as you go"}</div><div className="outing-controls"><button className="button button-quiet" onClick={togglePause}>{paused ? "Keep going" : "Take a pause"}</button><button className="button button-primary" onClick={() => { stopCamera(); onEnd(); }}>Wrap up our day <Icon name="arrow" /></button></div></div>
    </div>
  );
}

function WrapUp({
  plan,
  draft,
  gemmaStatus,
  onDraftChange,
  onSave,
  onBack,
  onSetupGemma,
  onForgetGemma,
  onGenerate,
}: {
  plan: OutingPlan;
  draft: SessionDraft;
  gemmaStatus: GemmaStatus;
  onDraftChange: (draft: SessionDraft) => void;
  onSave: (draft: SessionDraft, generatedStory?: string) => void;
  onBack: () => void;
  onSetupGemma: () => Promise<void>;
  onForgetGemma: () => Promise<void>;
  onGenerate: (plan: DiaryPlan, draft: DiaryDraft) => Promise<string>;
}) {
  const [generatedStory, setGeneratedStory] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const preview = makeDiary(plan, draft, generatedStory || undefined);
  const [momentInput, setMomentInput] = useState("");

  useEffect(() => {
    setGeneratedStory("");
    setGenerationError("");
  }, [draft.notes, draft.mood, draft.moments]);

  async function generateStory() {
    setGenerating(true);
    setGenerationError("");
    try {
      setGeneratedStory(await onGenerate(plan, draft));
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Gemma couldn’t write this entry.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="wrapup-layout">
      <button className="back-link" onClick={onBack}><Icon name="back" size={17} /> Back to our outing</button>
      <div className="wrapup-heading"><p className="eyebrow">TAKE A LITTLE OF TODAY WITH YOU</p><h1>What should I remember?</h1><p className="lead">Tell me what happened in whatever words come. I’ll use that as material for a page of my own, not a transcript of yours.</p></div>
      {gemmaStatus.phase === "ready" ? (
        <section className="gemma-write-card">
          <div><strong>Write with Gemma on this device</strong><p>Only compact fact cues—not your original sentences—are sent to the local model.</p></div>
          <button type="button" className="button button-secondary" disabled={generating} onClick={() => { void generateStory(); }}>
            {generating ? "Writing on this device…" : generatedStory ? "Try another version" : "Write with Gemma"}
          </button>
          {generating && <p className="gemma-generation-status" role="status">The first response can take a little while as the GPU warms up. Your notes are not sent to a server.</p>}
          {generationError && <p className="form-error" role="alert">{generationError}</p>}
        </section>
      ) : (
        <GemmaModelCard status={gemmaStatus} onSetup={onSetupGemma} onForget={onForgetGemma} />
      )}
      <div className="wrapup-grid">
        <div className="wrapup-inputs">
          <label className="field-label">What happened, or what stood out? <span className="optional-label">OPTIONAL</span>
            <textarea value={draft.notes} disabled={generating} onChange={(event) => onDraftChange({ ...draft, notes: event.target.value })} placeholder="The bits you told me about, a detail you don't want to forget…" rows={5} />
          </label>
          <label className="field-label">What impression did you get of your mood? <span className="optional-label">OPTIONAL</span>
            <input value={draft.mood} disabled={generating} onChange={(event) => onDraftChange({ ...draft, mood: event.target.value })} placeholder="Only if you’d like me to include it…" />
            <span className="field-hint">I’ll describe this as my impression, never as a fact.</span>
          </label>
          <div className="wrapup-moments"><div className="saved-moments-title"><strong>Small things I’ll remember</strong><span>{draft.moments.length}/3</span></div>
            {draft.moments.map((moment, index) => <div className="wrapup-moment" key={`${moment}-${index}`}><span>{index + 1}</span><p>{moment}</p><button disabled={generating} aria-label={`Remove moment: ${moment}`} onClick={() => onDraftChange({ ...draft, moments: draft.moments.filter((_, itemIndex) => itemIndex !== index) })}>×</button></div>)}
            {draft.moments.length < 3 && <div className="moment-input-row"><input disabled={generating} value={momentInput} onChange={(event) => setMomentInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && momentInput.trim()) { event.preventDefault(); onDraftChange({ ...draft, moments: [...draft.moments, momentInput.trim()] }); setMomentInput(""); } }} placeholder="A detail worth keeping…" /><button className="button button-secondary button-small" disabled={generating || !momentInput.trim()} onClick={() => { onDraftChange({ ...draft, moments: [...draft.moments, momentInput.trim()] }); setMomentInput(""); }}><Icon name="plus" size={16} /></button></div>}
          </div>
          <button className="button button-primary button-full" disabled={generating} onClick={() => onSave(draft, generatedStory || undefined)}>Save this little story <Icon name="arrow" /></button>
        </div>
        <aside className="diary-preview-card"><div className="preview-label"><Icon name="book" size={16} /> A FIRST LOOK AT OUR DIARY</div><h2>A day at {plan.place.name}</h2><p className="preview-date">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} <span>·</span> {plan.locality}</p><div className="preview-rule" /><p className="preview-story">{preview.story}</p><span className="preview-note">{generatedStory ? "Written by Gemma 2 2B locally on this device from compact fact cues; your original notes were not sent to the model." : "Local creative-composition fallback. It does not use an LLM; saved moments stay in your words."}</span></aside>
      </div>
    </div>
  );
}

function DiaryLibrary({ entries, onOpen, onCreate }: { entries: DiaryEntry[]; onOpen: (entry: DiaryEntry) => void; onCreate: () => void }) {
  return (
    <div className="diary-library">
      <div className="diary-heading"><div><p className="eyebrow">THE LITTLE DAYS THAT ADD UP</p><h1>Your diary<span className="title-period">.</span></h1><p className="lead">A place to come back to wherever we’ve been.</p></div><div className="diary-flower" aria-hidden="true">✳</div></div>
      {entries.length === 0 ? (
        <div className="empty-diary"><div className="empty-book"><Icon name="book" size={31} /></div><p className="eyebrow">A BLANK PAGE, FOR NOW</p><h2>Every little adventure has a first page.</h2><p>When we come back from our first outing, our story will be waiting here — written from the things you chose to share.</p><button className="button button-primary" onClick={onCreate}>Let’s plan a little day <Icon name="arrow" /></button></div>
      ) : (
        <div className="diary-grid">{entries.map((entry, index) => <button key={entry.id} className={`diary-card diary-card-${index % 3}`} onClick={() => onOpen(entry)}><div className="diary-card-date">{new Date(entry.createdAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}<span className="diary-card-icon"><Icon name="book" size={17} /></span></div><h2>{entry.placeName}</h2><p className="diary-card-area"><Icon name="pin" size={14} /> {entry.locality}</p><p className="diary-card-excerpt">{entry.story.slice(0, 190)}{entry.story.length > 190 ? "…" : ""}</p>{entry.moments.length > 0 && <div className="diary-card-moment"><Icon name="heart" size={14} /><span>{entry.moments[0]}</span></div>}<span className="diary-card-open">Read our story <Icon name="arrow" size={15} /></span></button>)}</div>
      )}
      <div className="library-footnote"><Icon name="lock" size={14} /><span>Saved in this browser. No account, no cloud sync.</span></div>
    </div>
  );
}

function DiaryView({ entry, onBack, onDelete }: { entry: DiaryEntry; onBack: () => void; onDelete: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <article className="diary-entry-view">
      <button className="back-link" onClick={onBack}><Icon name="back" size={17} /> Back to your diary</button>
      <header className="entry-header"><p className="eyebrow">{new Date(entry.createdAt).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} · {entry.locality.toUpperCase()}</p><h1>A day at {entry.placeName}<span className="title-period">.</span></h1><div className="entry-decoration"><span /><Icon name="heart" /><span /></div></header>
      <div className="entry-story">{entry.story.split("\n\n").map((paragraph, index) => <p className={index === 0 ? "entry-first-paragraph" : ""} key={`${index}-${paragraph}`}>{paragraph}</p>)}</div>
      {entry.moments.length > 0 && <section className="entry-moments"><p className="eyebrow">KEEPS, IN MY HANDWRITING</p>{entry.moments.map((moment, index) => <div className="entry-moment" key={`${moment}-${index}`}><span>0{index + 1}</span><p>{moment}</p><Icon name="heart" size={16} /></div>)}</section>}
      <div className="entry-actions"><button className="button button-quiet button-small" onClick={() => setConfirmDelete(!confirmDelete)}>Delete this story</button>{confirmDelete && <div className="delete-confirm"><span>Remove this diary entry from this browser?</span><button className="text-link danger-link" onClick={onDelete}>Yes, delete it</button><button className="text-link" onClick={() => setConfirmDelete(false)}>Keep it</button></div>}</div>
      <p className="entry-colophon">A locally composed page. Your replies were used as material, not as wording to paste.</p>
    </article>
  );
}

function EmptyEntry({ onBack }: { onBack: () => void }) {
  return <div className="empty-diary"><h2>This page has wandered off.</h2><button className="button button-primary" onClick={onBack}>Back to the diary</button></div>;
}

function GemmaModelCard({
  status,
  onSetup,
  onForget,
}: {
  status: GemmaStatus;
  onSetup: () => Promise<void>;
  onForget: () => Promise<void>;
}) {
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const canLoad = status.phase === "available" || status.phase === "error";
  const busy = status.phase === "checking" || status.phase === "loading" || status.phase === "forgetting";
  const hasModelFiles = status.phase === "ready" || status.phase === "error";
  const [actionError, setActionError] = useState("");

  async function runAction(action: () => Promise<void>) {
    setActionError("");
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The model action could not be completed.");
    }
  }

  return (
    <section className="settings-card gemma-card" aria-labelledby="gemma-title">
      <div className="settings-card-title">
        <div className="settings-icon"><Icon name="sun" /></div>
        <div>
          <h2 id="gemma-title">On-device diary model: Gemma 2 2B</h2>
          <p>Open-weight, instruction-tuned Gemma runs in this browser through WebGPU. The model is quantized to 4-bit for local inference; setup downloads about {GEMMA_MODEL_SIZE} of model files and compiled runtime assets. The model needs a compatible WebGPU adapter with shader-f16 and approximately 1.9 GB of GPU memory.</p>
        </div>
      </div>
      <div className={`gemma-status gemma-status-${status.phase}`} role="status" aria-live="polite">
        <span className="status-dot" />
        <span>{status.message}</span>
      </div>
      {status.phase === "loading" && <progress className="gemma-progress" max={100} value={status.progress} aria-label="Gemma model setup progress" />}
      <p className="gemma-disclosure">For initial setup, model files are fetched from Hugging Face and the version-pinned WebGPU runtime from jsDelivr; those hosts receive ordinary network metadata, not your diary notes. After setup, diary prompts and generation stay in this browser. Browser storage can be evicted, and you can remove the downloaded model here.</p>
      <label className="toggle-row gemma-terms">
        <input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} />
        <span className="custom-checkbox" />
        <span>I have read and agree to the <a href="https://ai.google.dev/gemma/terms" target="_blank" rel="noreferrer">Gemma Terms of Use</a>.</span>
      </label>
      <div className="gemma-actions">
        {canLoad && <button
          type="button"
          className="button button-primary"
          disabled={!acceptedTerms || busy}
          onClick={() => { void runAction(onSetup); }}
        >
          {status.phase === "ready" ? "Load Gemma on this device" : `Agree and prepare Gemma (up to ${GEMMA_MODEL_SIZE} if not cached)`}
        </button>}
        {hasModelFiles && <button
          type="button"
          className="button button-quiet button-small"
          disabled={busy}
          onClick={() => { void runAction(onForget); }}
        >
          Forget downloaded model
        </button>}
      </div>
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
    </section>
  );
}

function Settings({
  data,
  localVoiceAvailable,
  gemmaStatus,
  onSetupGemma,
  onForgetGemma,
  onExport,
  onDeleteAll,
}: {
  data: AppData;
  localVoiceAvailable: boolean;
  gemmaStatus: GemmaStatus;
  onSetupGemma: () => Promise<void>;
  onForgetGemma: () => Promise<void>;
  onExport: () => void;
  onDeleteAll: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exportError, setExportError] = useState("");
  const cameraSupported = Boolean(navigator.mediaDevices?.getUserMedia);
  const speechSynthesisSupported = "speechSynthesis" in window;

  function exportWithError() {
    try {
      onExport();
      setExportError("");
    } catch (error) {
      setExportError(`Your data could not be exported. ${error instanceof Error ? error.message : ""}`);
    }
  }

  return (
    <div className="settings-layout">
      <div className="settings-heading"><p className="eyebrow">YOUR DEVICE, YOUR CHOICES</p><h1>Your space,<br /><em>your rules.</em></h1><p className="lead">A few notes on what stays here, and what this demo can do.</p></div>
      <GemmaModelCard status={gemmaStatus} onSetup={onSetupGemma} onForget={onForgetGemma} />
      <section className="settings-card"><div className="settings-card-title"><div className="settings-icon"><Icon name="lock" /></div><div><h2>Your local data</h2><p>Stories, preferences and saved places live in this browser’s local storage. This app does not encrypt that data. Coordinates are not saved. When you request a nearby search, coordinates rounded to about 100 m and your interest terms go to the application server, which forwards a fixed, interest-filtered query to OpenStreetMap Overpass; both services receive the location query and ordinary network metadata. Typed-area search also sends the area text to OpenStreetMap Nominatim to find an approximate centre. The application server does not store search coordinates.</p></div></div><div className="data-tally"><span>{data.entries.length} diary entr{data.entries.length === 1 ? "y" : "ies"}</span><span>{data.places.length} saved place{data.places.length === 1 ? "" : "s"}</span></div><button className="button button-secondary" onClick={exportWithError}><Icon name="download" size={17} /> Export my data</button>{exportError && <p className="form-error" role="alert">{exportError}</p>}</section>
      <section className="settings-card"><div className="settings-card-title"><div className="settings-icon"><Icon name="sun" /></div><div><h2>Browser & model capabilities</h2><p>Gemma availability is checked for this browser and GPU. Diary generation uses Gemma only after you accept its terms and set up the model; otherwise the local composition remains available as a clearly labelled fallback.</p></div></div><div className="capability-list"><Capability label="No hosted AI or analytics" detail="No diary prompts or content are sent to an inference service." active /><Capability label="Typed notes and local diary" detail="Works in modern browsers with local storage." active /><Capability label="GPS, manual map-point or typed-area place search" detail="On request only: coordinates or the typed area go to OpenStreetMap services. GPS requires permission; searches need internet." active /><Capability label="On-device image recognition" detail="Not available; describe an image in your own words." /><Capability label="Local speech-to-text model" detail="Not configured; browser speech recognition is intentionally not used." /><Capability label="Browser camera preview" detail={cameraSupported ? "Available on localhost or HTTPS after you explicitly allow it." : "This browser does not expose the camera API."} active={cameraSupported} /><Capability label="Installed, local text-to-speech voice" detail={!speechSynthesisSupported ? "Speech synthesis is not available." : localVoiceAvailable ? "A local voice is installed; the app uses only voices reported as local." : "No locally installed speech voice was detected."} active={localVoiceAvailable} /></div></section>
      <section className="settings-card"><div className="settings-card-title"><div className="settings-icon"><Icon name="camera" /></div><div><h2>Camera & microphone</h2><p>The browser asks before the camera is used; the preview is local and no photo is kept by default. This version doesn’t activate a microphone because there is no trustworthy local speech-recognition model installed.</p></div></div></section>
      <section className="settings-card settings-delete"><div className="settings-card-title"><div className="settings-icon"><span>×</span></div><div><h2>Start fresh</h2><p>Delete your profile, places, notes, and every diary entry from this browser.</p></div></div>{!confirmDelete ? <button className="button button-danger-outline" onClick={() => setConfirmDelete(true)}>Delete all my data</button> : <div className="delete-confirm"><span>This can’t be undone.</span><button className="button button-danger" onClick={onDeleteAll}>Delete everything</button><button className="button button-quiet" onClick={() => setConfirmDelete(false)}>Keep my data</button></div>}</section>
      <div className="settings-offline-note"><span className="status-dot status-dot-green" />The app shell is cached locally after your first visit. No remote fonts, analytics, or hosted AI. GPS, manual map-point, and typed-area searches need a network connection and send location queries through the application server to OpenStreetMap.</div>
    </div>
  );
}

function Capability({ label, detail, active = false }: { label: string; detail: string; active?: boolean }) {
  return <div className="capability-item"><span className={`capability-state ${active ? "capability-on" : ""}`} /><div><strong>{label}</strong><span>{detail}</span></div></div>;
}

function getGreeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "GOOD MORNING, A LITTLE WANDERER" : hour < 18 ? "A GOOD DAY TO STEP OUTSIDE" : "THE EVENING IS YOURS";
}
