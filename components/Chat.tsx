"use client";

import { db, ensureAnon } from "@/firebase/firebase";
import {
  arrayUnion,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { JSX, useEffect, useMemo, useRef, useState } from "react";

type Role = "user" | "assistant";
type Msg = { id: string; role: Role; content: string; ts: number };

const STORAGE_KEY = "smartdoctor_chat_history_v1";

// ---------- utils ----------
function isMsg(x: any): x is Msg {
  return (
    x &&
    (x.role === "user" || x.role === "assistant") &&
    typeof x.content === "string"
  );
}
function loadHistory(): Msg[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isMsg) : [];
  } catch {
    return [];
  }
}
function saveHistory(m: Msg[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(m));
  } catch {}
}

// Simple Arabic detection
function isArabic(s: string): boolean {
  return /[\u0600-\u06FF]/.test(s);
}

// detect first maps link
const MAPS_RX =
  /(https?:\/\/(?:maps\.app\.goo\.gl|www\.google\.com\/maps)[^\s)]+)(?=[\s)\]}]|$)/i;
const URL_RX = /(https?:\/\/[^\s)]+)(?=[\s)\]}]|$)/gi;

function useLinkedText(text: string) {
  return useMemo(() => {
    const parts: Array<string | JSX.Element> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    const rx = new RegExp(URL_RX);
    while ((match = rx.exec(text)) !== null) {
      const [url] = match;
      const start = match.index;
      if (start > lastIndex) parts.push(text.slice(lastIndex, start));
      parts.push(
        <a
          key={`${start}-${url}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#1d4ed8", textDecoration: "underline" }}
        >
          {url}
        </a>
      );
      lastIndex = start + url.length;
    }
    parts.push(text.slice(lastIndex));
    return parts;
  }, [text]);
}

// ---------- UI ----------
export default function Chat() {
  const booted = useRef(false);

  const [uid, setUid] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>(() => {
    const hist = loadHistory();
    return hist.length
      ? hist
      : [
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content:
              "مرحبًا! أنا هنا لمساعدتك بطريقة ودّية—اسألني من مواضيعنا الصحية. 🙂",
            ts: Date.now(),
          },
        ];
  });

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  // ✅ onboarding states
  const [districtChosen, setDistrictChosen] = useState(false);
  const [genderChosen, setGenderChosen] = useState(false);
  const [ageEntered, setAgeEntered] = useState(false);
  const [userInfo, setUserInfo] = useState({
    district: "",
    gender: "",
    age: "",
  });

  const listRef = useRef<HTMLDivElement>(null);

  // Bootstrap: sign in anonymously, create doc if missing, and preload onboarding flags
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;

    (async () => {
      const _uid = await ensureAnon();
      setUid(_uid);

      const ref = doc(db, "userChats", _uid);
      const snap = await getDoc(ref);

      if (!snap.exists()) {
        await setDoc(ref, {
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          userInfo: { district: "", gender: "", age: "" },
          messages: [],
        });
      } else {
        const data: any = snap.data();
        const ui = data?.userInfo || {};
        const hasAll =
          typeof ui?.district === "string" &&
          ui.district &&
          typeof ui?.gender === "string" &&
          ui.gender &&
          typeof ui?.age === "string" &&
          ui.age;
        if (hasAll) {
          setUserInfo({
            district: ui.district,
            gender: ui.gender,
            age: ui.age,
          });
          setDistrictChosen(true);
          setGenderChosen(true);
          setAgeEntered(true);
        }
      }
    })();
  }, []);

  // persist local UI history and keep scroll pinned
  useEffect(() => {
    saveHistory(messages);
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function appendToFirestore(newMsgs: Msg[]) {
    if (!uid) return;
    const ref = doc(db, "userChats", uid);
    await updateDoc(ref, {
      messages: arrayUnion(...newMsgs),
      updatedAt: serverTimestamp(),
    });
  }

  // ---------- chat send ----------
  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Msg = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      ts: Date.now(),
    };
    const updated: Msg[] = [...messages, userMsg];

    setMessages(updated);
    setInput("");
    setLoading(true);

    try {
      await appendToFirestore([userMsg]);

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: updated, userInfo }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);

      const botMsg: Msg = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: data.reply ?? "(no reply)",
        ts: Date.now(),
      };
      setMessages((m) => [...m, botMsg]);
      await appendToFirestore([botMsg]);
    } catch (e: any) {
      const errMsg: Msg = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "Error: " + (e?.message || String(e)),
        ts: Date.now(),
      };
      setMessages((m) => [...m, errMsg]);
      await appendToFirestore([errMsg]);
    } finally {
      setLoading(false);
    }
  }

  // ---------- reset (does NOT clear userInfo; questions are asked once only) ----------
  function onReset() {
    setMessages([
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          "مرحبًا! أنا هنا لمساعدتك بطريقة ودّية—اسألني من مواضيعنا الصحية. 🙂",
        ts: Date.now(),
      },
    ]);
  }

  // ---------- onboarding flow (persist once) ----------
  async function persistUserInfo(partial: Partial<typeof userInfo>) {
    const next = { ...userInfo, ...partial };
    setUserInfo(next);
    if (uid) {
      await updateDoc(doc(db, "userChats", uid), {
        userInfo: next,
        updatedAt: serverTimestamp(),
      });
    }
  }

  function handleDistrictSelect(district: string) {
    setDistrictChosen(true);
    persistUserInfo({ district });
  }

  function handleGenderSelect(gender: string) {
    setGenderChosen(true);
    persistUserInfo({ gender });
  }

  function handleAgeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!userInfo.age.trim()) return;
    setAgeEntered(true);

    const userMsgs: Msg[] = [
      {
        id: crypto.randomUUID(),
        role: "user",
        content: `I'm in ${userInfo.district} district.`,
        ts: Date.now(),
      },
      {
        id: crypto.randomUUID(),
        role: "user",
        content: `My gender is ${userInfo.gender}.`,
        ts: Date.now(),
      },
      {
        id: crypto.randomUUID(),
        role: "user",
        content: `My age is ${userInfo.age}.`,
        ts: Date.now(),
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "New chat started. How can I help? 🙂 كيف اساعدك؟",
        ts: Date.now(),
      },
    ];
    setMessages((prev) => [...prev, ...userMsgs]);
    appendToFirestore(userMsgs);

    // mark profile complete so onboarding won't repeat
    persistUserInfo({});
  }

  // ---------- download & save (download only) ----------
  async function onDownload() {
    const blob = new Blob([JSON.stringify(messages, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      {/* iOS Safari fix */}
      <style jsx global>{`
        input,
        select,
        textarea {
          font-size: 16px;
        }
      `}</style>

      {/* Top controls */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          onClick={onReset}
          disabled={loading}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            background: "#e2e8f0",
            border: "1px solid #cbd5e1",
            fontWeight: 600,
          }}
        >
          Reset
        </button>
      </div>

      {/* ✅ Onboarding sequence (asked once per UID) */}
      {!districtChosen && (
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            padding: 16,
            background: "#f9fafb",
            marginBottom: 16,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 16 }}>
            Which district are you in? من اي قضاء انت؟
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            {["بقاع Beqaa", "Tripoli طرابلس"].map((d) => (
              <button
                key={d}
                onClick={() => handleDistrictSelect(d)}
                style={{
                  padding: "10px 16px",
                  background: "#2563eb",
                  color: "#fff",
                  borderRadius: 10,
                  fontWeight: 600,
                  border: "none",
                }}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      )}

      {districtChosen && !genderChosen && (
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            padding: 16,
            background: "#f9fafb",
            marginBottom: 16,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 16 }}>
            Select your gender, اختر الجنس:
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            {["Male", "Female"].map((g) => (
              <button
                key={g}
                onClick={() => handleGenderSelect(g)}
                style={{
                  padding: "10px 16px",
                  background: "#2563eb",
                  color: "#fff",
                  borderRadius: 10,
                  fontWeight: 600,
                  border: "none",
                }}
              >
                {g}
              </button>
            ))}
          </div>
        </div>
      )}

      {districtChosen && genderChosen && !ageEntered && (
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            padding: 16,
            background: "#f9fafb",
            marginBottom: 16,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 16 }}>
            Please enter your age، ما هو عمرك:
          </div>
          <form
            onSubmit={handleAgeSubmit}
            style={{ display: "flex", gap: 10, marginTop: 8 }}
          >
            <input
              type="number"
              value={userInfo.age}
              onChange={(e) =>
                setUserInfo((prev) => ({ ...prev, age: e.target.value }))
              }
              placeholder="Enter age..."
              style={{
                flex: 1,
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #cbd5e1",
              }}
            />
            <button
              type="submit"
              style={{
                padding: "10px 16px",
                background: "#2563eb",
                color: "#fff",
                borderRadius: 10,
                fontWeight: 600,
                border: "none",
              }}
            >
              Submit
            </button>
          </form>
        </div>
      )}

      {/* Chat area */}
      <div
        ref={listRef}
        style={{
          height: 480,
          overflowY: "auto",
          border: "1px solid #e2e8f0",
          borderRadius: 12,
          padding: 16,
          background: "#fff",
        }}
      >
        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}
        {loading && (
          <div style={{ fontSize: 12, color: "#64748b" }}>Thinking…</div>
        )}
      </div>

      {/* Input area locked until onboarding done */}
      <form
        onSubmit={onSend}
        style={{ display: "flex", gap: 8, marginTop: 12 }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            ageEntered
              ? "Ask in English or Arabic…"
              : "Please complete setup first..."
          }
          inputMode="text"
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          dir="auto"
          disabled={!ageEntered}
          style={{
            flex: 1,
            padding: "12px 14px",
            borderRadius: 10,
            border: "1px solid #e2e8f0",
            fontSize: "16px",
            lineHeight: "22px",
            opacity: ageEntered ? 1 : 0.5,
            background: ageEntered ? "#fff" : "#f1f5f9",
            cursor: ageEntered ? "text" : "not-allowed",
          }}
        />
        <button
          type="submit"
          disabled={loading || !ageEntered}
          style={{
            padding: "12px 16px",
            borderRadius: 10,
            background: loading || !ageEntered ? "#94a3b8" : "#0f172a",
            color: "#fff",
            fontWeight: 700,
            cursor: loading || !ageEntered ? "not-allowed" : "pointer",
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}

// ---------- Message bubbles ----------
function MessageBubble({ msg }: { msg: Msg }) {
  const hasMap = MAPS_RX.test(msg.content);
  const mapsUrl = hasMap ? msg.content.match(MAPS_RX)?.[1] : undefined;
  const linked = useLinkedText(msg.content);
  const rtl = isArabic(msg.content);

  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 999,
          background: msg.role === "user" ? "#0f172a" : "#2563eb",
          flex: "0 0 28px",
        }}
      />
      <div
        dir={rtl ? "rtl" : "ltr"}
        style={{
          whiteSpace: "pre-wrap",
          background: msg.role === "user" ? "#f1f5f9" : "#eff6ff",
          padding: 12,
          borderRadius: 10,
          maxWidth: 780,
          unicodeBidi: "plaintext" as any,
          textAlign: "start",
        }}
      >
        <div>{linked}</div>

        {mapsUrl && (
          <div
            style={{
              marginTop: 10,
              display: "flex",
              gap: 8,
              direction: "ltr",
            }}
          >
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 10px",
                borderRadius: 10,
                background: "#1d4ed8",
                color: "#fff",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              <MapPinIcon />
              Open map
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function MapPinIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block" }}
    >
      <path
        d="M12 2C8.686 2 6 4.686 6 8c0 4.418 6 12 6 12s6-7.582 6-12c0-3.314-2.686-6-6-6zm0 8.5A2.5 2.5 0 1 1 12 5.5a2.5 2.5 0 0 1 0 5z"
        fill="currentColor"
      />
    </svg>
  );
}
