import { detectArabic, retrieve, type KB } from "@/utils/retrieval";
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

let KB_CACHE: KB | null = null;
function loadKB(): KB {
  if (KB_CACHE) return KB_CACHE as KB;
  const p = path.join(process.cwd(), "data", "intents_merged.json");
  const raw = fs.readFileSync(p, "utf-8");
  KB_CACHE = JSON.parse(raw) as KB;
  return KB_CACHE as KB;
}

type Role = "user" | "assistant";
type Msg = { role: Role; content: string };

function normalizeInline(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccardFromStrings(a: string, b: string) {
  const A = new Set(normalizeInline(a).split(" ").filter(Boolean));
  const B = new Set(normalizeInline(b).split(" ").filter(Boolean));
  const inter = new Set([...A].filter((x) => B.has(x))).size;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

function buildDialogueContext(messages: Msg[], latest: string) {
  const MAX_BACK = 8;
  const SIM_THRESHOLD = 0.2;
  const prev = messages.slice(0, -1).slice(-MAX_BACK);
  const related: { q: string; a: string }[] = [];
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i];
    if (m.role === "user") {
      const sim = jaccardFromStrings(m.content, latest);
      if (sim >= SIM_THRESHOLD) {
        const ans =
          i + 1 < prev.length && prev[i + 1].role === "assistant"
            ? prev[i + 1].content
            : "";
        related.push({ q: m.content, a: ans });
      }
    }
  }
  if (!related.length) return "";
  return related
    .slice(0, 2)
    .map((p) => `Q: ${p.q}\nA: ${p.a}`)
    .join("\n\n");
}

function isChitChat(s: string): boolean {
  const n = normalizeInline(s);
  const patterns = [
    /^hi\b|^hello\b|^hey\b|^salam\b|^marhaba\b/,
    /\bhow are (you|u)\b/,
    /\bcan i ask (a )?question\b/,
    /\bthank(s| you)\b/,
    /\bbye\b|\bgoodbye\b|\bsee you\b/,
  ];
  return patterns.some((rx) => rx.test(n));
}

function chitChatReply(s: string, lang: "ar" | "en"): string {
  const hi = lang === "ar" ? "مرحبًا! 😊" : "Hi there! 😊";
  const norm = normalizeInline(s);

  if (/\bhow are (you|u)\b/.test(norm)) {
    return lang === "ar"
      ? "أنا بخير، شكرًا لسؤالك! كيف يمكنني مساعدتك؟"
      : "I’m doing well, thanks for asking! How can I help today?";
  }
  if (/(^|\b)(can i|may i) ask( a)? question(\b|$)/.test(norm)) {
    return lang === "ar"
      ? "أكيد! اسألني أي سؤال تريده. 🙂"
      : "Of course! Ask me anything. 🙂";
  }
  if (/\bthank(s| you)\b/.test(norm)) {
    return lang === "ar"
      ? "على الرحب والسعة! إذا أردت، اسألني أي شيء. 🙏"
      : "You’re welcome! Feel free to ask me anything. 🙏";
  }
  if (/\bbye\b|\bgoodbye\b|\bsee you\b/.test(norm)) {
    return lang === "ar"
      ? "إلى اللقاء! اعتنِ بنفسك. 👋"
      : "Goodbye! Take care. 👋";
  }
  return lang === "ar"
    ? `${hi} اسألني ما تشاء—سأجيب بناءً على المعلومات المتاحة.`
    : `${hi} Ask me anything — I’ll answer based on the info I have.`;
}

// sanitize reply: remove bullets/snippet mentions; keep paragraphs
function sanitize(output: string): string {
  output = output.replace(/^\s*([*\-•]\s*)+/gm, "");
  output = output.replace(
    /\b(Snippet\s*\d+|from snippet\s*\d+|from the snippet|according to the snippet)\b.*?:?/gi,
    ""
  );
  output = output.replace(/\n{3,}/g, "\n\n").trim();
  return output;
}

// ===== Friendly + strict doctor persona rules (AR/EN) =====
function buildSystemPrompt(userLang: "ar" | "en") {
  const langInstruction =
    userLang === "ar"
      ? "أجب باللغة العربية ما لم يطلب المستخدم غير ذلك."
      : "Answer in English unless the user requests Arabic.";

  const persona =
    userLang === "ar"
      ? "أنت طبيب/ة ودود/ة ومتعاطف/ة مختص/ة بصحة المراهقين. تحدّث ببساطة وطمأنة، وبأسلوب مهني قريب من الناس."
      : "You are a warm, empathetic medical doctor specializing in adolescent health. Speak clearly, reassuringly, and professionally.";

  const rules = [
    persona,
    "You MUST answer only using the provided CONTEXT.",
    "Continuity: If the user is asking a follow-up about the same subject, keep answers consistent with earlier turns. If the subject changed, treat it as a new question.",
    "RULES:",
    "1) Do NOT invent or guess. No information outside the CONTEXT.",
    "2) If asked to summarize, summarize faithfully from the CONTEXT only.",
    '3) If the question is related to puberty/relationships/safety but not covered by CONTEXT, reply: "It’s better to ask a doctor or a trusted adult."',
    '4) If the question is outside the domain entirely, reply exactly: "I cant answer this question"',
    "5) For specific questions, paraphrase from the CONTEXT. You may quote short lines.",
    "6) Be concise and kind. Use short paragraphs (no lists).",
    "EXTRA RULES:",
    "A) Keep a warm, supportive, doctor-like tone. Use light emojis when appropriate (🙂🤝), but keep answers short and clear.",
    "B) For “nearest/closest clinic/health center” around Tripoli/Akkar:",
    "   - If the user didn’t specify an area, politely ask for their area/neighborhood first.",
    "   - Otherwise, answer using the JSON health-centers responses (the Akkar links). Encourage opening the Google Maps links.",
    "C) DO NOT use markdown bullets or lists (no *, -, •, 1.). Answer in plain sentences/paragraphs only.",
    "D) DO NOT mention snippets, tags, patterns, context, dataset, or sources. Just answer directly.",
    langInstruction,
  ];

  return rules.join("\n");
}

// ===== Simple area→link hint for Akkar locations (optional preface) =====
const AREA_MAP: Record<string, string> = {
  tripoli: "https://maps.app.goo.gl/WQKfbTVWTD6TUwrL8",
  mina: "https://maps.app.goo.gl/WQKfbTVWTD6TUwrL8",
  minaa: "https://maps.app.goo.gl/WQKfbTVWTD6TUwrL8",
  qobbeh: "https://maps.app.goo.gl/WQKfbTVWTD6TUwrL8",
  kobbeh: "https://maps.app.goo.gl/WQKfbTVWTD6TUwrL8",
  halba: "https://maps.app.goo.gl/gi46nv51nsE7tHJY6",
  bebnine: "https://maps.app.goo.gl/ujc7GUmEJouMYwJS9",
  bkarzla: "https://maps.app.goo.gl/m3GerH3EgVm1ShTq6",
  akkar: "https://maps.app.goo.gl/gi46nv51nsE7tHJY6",
};

function guessNearestLink(s: string): string | null {
  const t = (s || "").toLowerCase();
  for (const k of Object.keys(AREA_MAP)) {
    if (t.includes(k)) return AREA_MAP[k];
  }
  return null;
}

// ===== Build the correct chat endpoint (avoids double /v1) =====
function buildChatEndpoint(base: string): string {
  if (!base) return "/api/v1/chat/completions";
  const trimmed = base.replace(/\/+$/, "");
  // If base already ends with /api/v1, append /chat/completions
  if (/\/api\/v1$/.test(trimmed)) return `${trimmed}/chat/completions`;
  // If base already ends with /v1, append /chat/completions
  if (/\/v1$/.test(trimmed)) return `${trimmed}/chat/completions`;
  // Otherwise assume origin; append /api/v1/chat/completions
  return `${trimmed}/api/v1/chat/completions`;
}

export async function POST(req: Request) {
  try {
    const { messages } = (await req.json()) as { messages: Msg[] };
    if (!messages?.length)
      return NextResponse.json({ error: "Missing messages" }, { status: 400 });

    const kb = loadKB();
    const latest = messages[messages.length - 1]?.content || "";
    const userLang: "ar" | "en" = detectArabic(latest) ? "ar" : "en";

    // Friendly chit-chat (allowed exception)
    if (isChitChat(latest)) {
      const reply = chitChatReply(latest, userLang);
      return NextResponse.json({ reply, meta: { chitchat: true } });
    }

    // Dialogue continuity context
    const dialogueCtx = buildDialogueContext(messages, latest);
    const retrievalQuery = dialogueCtx
      ? `${latest}

Follow-up context (for meaning only):
${dialogueCtx}`
      : latest;

    // Retrieve from your JSON KB
    const { top, best, globalRelatedness } = retrieve(retrievalQuery, kb, 10);

    // Thresholds
    const BEST_MIN = 0.18;
    const RELATED_MIN = 0.1;

    // Out-of-domain hard stop
    if (best.score < RELATED_MIN && globalRelatedness < 0.22) {
      const msg =
        userLang === "ar"
          ? "I cant answer this question"
          : "I cant answer this question";
      return NextResponse.json({
        reply: msg,
        meta: { reason: "out_of_domain", score: best.score, globalRelatedness },
      });
    }

    // In-domain but not covered → doctor referral
    const hasDomainSignal = globalRelatedness >= 0.22;
    if (best.score < BEST_MIN && !hasDomainSignal) {
      const msg =
        userLang === "ar"
          ? "من الأفضل سؤال طبيب أو شخص بالغ موثوق."
          : "It’s better to ask a doctor or a trusted adult.";
      return NextResponse.json({
        reply: msg,
        meta: { reason: "in_domain_not_covered", score: best.score },
      });
    }

    // Build CONTEXT from top matches (no snippet mentions)
    const context = top
      .map((m) => `Q: ${m.pattern}\nA: ${m.response}`)
      .join("\n\n");

    // System instructions
    const system = buildSystemPrompt(userLang);

    // Optional: if user mentioned an area word, suggest a likely nearest link up-front
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const hint = lastUser ? guessNearestLink(lastUser.content || "") : null;
    const preface = hint
      ? `This may be closest based on your area: ${hint}\n`
      : "";

    // === Provider config (DigitalOcean Agent / OpenAI-style) ===
    const baseURL = process.env.DO_AGENT_URL || ""; // e.g. https://...agents.do-ai.run or .../api/v1
    const apiKey = process.env.DO_AGENT_KEY || ""; // Bearer key
    const endpoint = buildChatEndpoint(baseURL);

    const payload = {
      model: "llama3-8b-instruct",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `CONTEXT (authoritative):\n${context}` },
        ...(dialogueCtx
          ? [
              {
                role: "user",
                content:
                  "DIALOGUE CONTEXT (use only to maintain continuity; do NOT create facts from this):\n" +
                  dialogueCtx,
              } as const,
            ]
          : []),
        {
          role: "user",
          content: `USER QUESTION:\n${latest}\n\nAnswer now. Remember all RULES.`,
        },
      ],
      stream: false,
      options: { temperature: 0.4 },
    };

    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: apiKey ? `Bearer ${apiKey}` : "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    if (!r.ok) {
      const text = await r.text();
      console.error("❌ Agent error:", r.status, text);
      return NextResponse.json(
        { error: `Agent error ${r.status}: ${text}` },
        { status: 500 }
      );
    }

    const data = await r.json();
    let reply = data?.choices?.[0]?.message?.content ?? "(no reply)";
    reply = sanitize(reply);

    if (preface && reply) reply = `${preface}${reply}`;

    return NextResponse.json({
      reply,
      meta: {
        bestScore: best?.score ?? 0,
        globalRelatedness: globalRelatedness ?? 0,
        usedSnippets: top.length,
      },
    });
  } catch (e: any) {
    console.error("🔥 /api/chat error:", e);
    return NextResponse.json(
      { error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
