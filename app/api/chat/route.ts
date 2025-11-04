// app/api/chat/route.ts
import { detectArabic, retrieve, type KB } from "@/utils/retrieval";
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

/* =================== KB loader =================== */
let KB_CACHE: KB | null = null;
function loadKB(): KB {
  if (KB_CACHE) return KB_CACHE as KB;
  const p = path.join(process.cwd(), "data", "intents_merged.json");
  const raw = fs.readFileSync(p, "utf-8");
  KB_CACHE = JSON.parse(raw) as KB;
  return KB_CACHE as KB;
}

/* =================== Types & utils =================== */
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

/* =================== Intent detectors =================== */
// Arabic greetings (avoid \b; whole message)
const AR_GREET = /^\s*(?:هاي|مرحبا|مرحبًا|اهلا|أهلًا|هلا)\s*$/i;
const AR_SMALLTALK =
  /^\s*(?:كيفك|كيف الحال|شو الأخبار|شو الاخبار|شو اخبارك|عامل ايه|عامل إيه)\s*\??\s*$/i;

const RX = {
  greetEn: /^(hi|hey|hello|yo)\s*$/i,
  greetAr: AR_GREET,
  testEn:
    /\b(this\s*is\s*a\s*test|just\s*testing|testing|test msg|test message|test)\b/i,
  testAr: /(هذا|هيدا)\s*اختبار|مجرد اختبار|عم\s*جرّ?ب|تجربة/i,

  // language switch / translate
  arSwitch:
    /(بالعربي|بالعربية|ترجم|ترجمة|قل.*بالعربي|اشرح.*بالعربي|translate\s+to\s+arabic)/i,
  enSwitch:
    /\b(in english|english please|translate to english|say.*in english|explain.*in english)\b/i,
};

function isGreeting(s: string): boolean {
  const t = s.trim();
  return RX.greetEn.test(t) || RX.greetAr.test(t);
}
function isTestMsg(s: string): boolean {
  return RX.testEn.test(s) || RX.testAr.test(s);
}

/** Health / medication intent (permissive; catches typos) */
const HEALTH_RX = [
  /\b(health|doctor|clinic|hospital|symptom|fever|pain|rash|period|puberty|pregnan|sexual|sex|std|sti|anxiety|depress|stress)\b/i,
  /\b(medicine|medication|drug|pill|tablet|syrup|dose|dosage|mg|ml)\b/i,
  /\b(antibiot(ic|ics)?|antibit|antibiotoc|antibitocs|antibotic|antibotics)\b/i,
  /\b(paracetamol|acetaminophen|panadol|ibuprofen|amoxicillin|augmentin|penicillin)\b/i,
];
function isHealthLike(s: string) {
  const n = s ?? "";
  return HEALTH_RX.some((rx) => rx.test(n));
}

/* =================== Chit-chat (expanded) =================== */
function isChitChat(s: string): boolean {
  const n = normalizeInline(s);
  const raw = s.trim();
  if (/^(hi|hello|hey|yo)$/.test(n)) return true;
  if (/^how are (you|u)\??$/.test(n)) return true;
  if (/^(can i|may i) ask( a)? question\??$/.test(n)) return true;
  if (/^(thanks|thank you)$/.test(n)) return true;
  if (/^(bye|goodbye|see you)$/.test(n)) return true;
  if (AR_GREET.test(raw)) return true;
  if (AR_SMALLTALK.test(raw)) return true;
  return false;
}

function chitChatReply(s: string, lang: "ar" | "en"): string {
  const raw = s.trim();
  const n = normalizeInline(s);

  if (RX.greetEn.test(n) || AR_GREET.test(raw)) {
    return lang === "ar"
      ? "هاي! كيف فيني ساعدك اليوم؟ 😊"
      : "Hey there! How can I help you today? 😄";
  }
  if (/^how are (you|u)\??$/.test(n) || AR_SMALLTALK.test(raw)) {
    return lang === "ar"
      ? "منيح، شكرًا لسؤالك! كيف فيني ساعدك اليوم؟"
      : "I’m good, thanks for asking! How can I help today?";
  }
  if (/^(can i|may i) ask( a)? question\??$/.test(n)) {
    return lang === "ar"
      ? "أكيد! اسألني أي سؤال. 🙂"
      : "Of course! Ask me anything. 🙂";
  }
  if (/^(thanks|thank you)$/.test(n)) {
    return lang === "ar"
      ? "عفوًا! إذا بدك شي خبرني. 🙏"
      : "You’re welcome! Anything else I can help with? 🙏";
  }
  if (/^(bye|goodbye|see you)$/.test(n)) {
    return lang === "ar" ? "إلى اللقاء! 👋" : "Goodbye! 👋";
  }
  return lang === "ar"
    ? "مرحبًا! كيف فيني ساعدك اليوم؟"
    : "Hi! How can I help you today?";
}

/* =================== Output sanitizer =================== */
function sanitize(output: string): string {
  output = output.replace(/^\s*([*\-•]\s*)+/gm, "");
  output = output.replace(
    /\b(Snippet\s*\d+|from snippet\s*\d+|from the snippet|according to the snippet)\b.*?:?/gi,
    ""
  );
  output = output.replace(/\n{3,}/g, "\n\n").trim();
  return output;
}

/* =================== System prompt builder =================== */
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
    '3) If the question is related to puberty/relationships/safety **or medications/medical terms** but not covered by CONTEXT, reply: "It’s better to ask a doctor or a trusted adult."',
    '4) If the question is outside the domain entirely, reply exactly: "I cant answer this question"',
    "5) For specific questions, paraphrase from the CONTEXT. You may quote short lines.",
    "6) Be concise and kind. Use short paragraphs (no lists).",
    "7) If the user writes “in Arabic/بالعربي/بالعربية/ترجم” or “in English”, switch to that language for that turn and keep it for subsequent turns until told otherwise.",
    "8) If you don’t know, say “I’m not sure” and offer a next step.",
    "9) If the user says “this is a test”, “testing”, “just testing”, or similar, reply with a short reassurance that you’re working, then a quick offer to help. Keep the reply in the user’s language.",
    '10) If the user asks a medical question that might show they have any kind of infection it should answer as "This is a serious issue, you should check with a doctor as soon as possible" ',
    "EXTRA RULES:",
    "A) Keep a warm, supportive, doctor-like tone. Use light emojis when appropriate (🙂🤝), but keep answers short and clear.",
    "B) For “nearest/closest clinic/health center” around Tripoli/Akkar:",
    "   - If the user didn’t specify an area, politely ask for their area/neighborhood first.",
    "   - Otherwise, answer using the JSON health-centers responses (the Akkar links). Encourage opening the Google Maps links.",
    "C) DO NOT use markdown bullets or lists (no *, -, •, 1.). Answer in plain sentences/paragraphs only.",
    "D) DO NOT mention snippets, tags, patterns, context, dataset, or sources. Just answer directly.",
    "E) If the input was hey or hi answer it with greetings.",
    "F) If the user says “say/explain X in Arabic/English”, do exactly that: restate/translate X and then (if appropriate) add a one-sentence helpful note—nothing off-topic.",
    "G) If the user says “hi”, “hey”, “hello”, “هاي”, “مرحبا”, “اهلا/أهلًا”, or similar, reply only with a short friendly greeting and a follow-up question such as “How can I help you today?” / “كيف فيني ساعدك اليوم؟”. Do not answer with any health or safety message unless the greeting contains a health topic.",
    langInstruction,
  ];

  return rules.join("\n");
}

/* =================== Area→link hint (optional) =================== */
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

/* =================== Chat endpoint helper =================== */
function buildChatEndpoint(base: string): string {
  if (!base) return "/api/v1/chat/completions";
  const trimmed = base.replace(/\/+$/, "");
  if (/\/api\/v1$/.test(trimmed)) return `${trimmed}/chat/completions`;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/api/v1/chat/completions`;
}

/* ============== Arabic translation utilities (strict) ============== */
function hasLatin(s: string) {
  return /[A-Za-z]/.test(s);
}
function tidyArabic(s: string) {
  const fixes: [RegExp, string][] = [
    [/\bchanges?\b/gi, "تغيّرات"],
    [/\bemotion(al|s)?\b/gi, "عاطفية"],
    [/\bphysical\b/gi, "جسدية"],
    [/\bpuberty\b/gi, "البلوغ"],
    [/\breproduction\b/gi, "التكاثر"],
    [/\bsexual maturity\b/gi, "النضج الجنسي"],
    [/\s+,/g, "،"],
    [/,\s*/g, "، "],
    [/\s+،/g, "،"],
    [/\s+\./g, "."],
    [/\s{2,}/g, " "],
  ];
  let out = s;
  for (const [rx, rep] of fixes) out = out.replace(rx, rep);
  return out.trim();
}

/* ============== Translator helper (strict, validated) ============== */
async function translateWithLLM({
  text,
  target,
  baseURL,
  apiKey,
  model,
}: {
  text: string;
  target: "ar" | "en";
  baseURL: string;
  apiKey: string;
  model: string;
}) {
  const endpoint = buildChatEndpoint(baseURL);

  const sysPrimary =
    target === "ar"
      ? [
          "You are a precise translator to Modern Standard Arabic.",
          "Output must be Arabic script only. No Latin letters, no transliteration, no extra explanations.",
          "Keep meaning, tone, and emojis. Use simple sentences.",
        ].join(" ")
      : [
          "You are a precise translator to clear, simple English.",
          "Output English only. No Arabic script, no extra explanations.",
          "Keep meaning, tone, and emojis. Use short sentences.",
        ].join(" ");

  const payload = {
    model,
    messages: [
      { role: "system", content: sysPrimary },
      { role: "user", content: text },
    ],
    stream: false,
    options: { temperature: 0.1, top_p: 0.9 },
  };

  // Primary translation
  let r = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: apiKey ? `Bearer ${apiKey}` : "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`Translator error ${r.status}: ${await r.text()}`);
  let data = await r.json();
  let out: string = data?.choices?.[0]?.message?.content ?? "";
  out = sanitize(out);

  // Arabic: validate and retry if Latin remains
  if (target === "ar" && hasLatin(out)) {
    const sysFix =
      "Rewrite the following text in Modern Standard Arabic ONLY. Replace any Latin words with Arabic equivalents. No English, no transliteration, no added info. Output Arabic text only.";
    const fixPayload = {
      model,
      messages: [
        { role: "system", content: sysFix },
        { role: "user", content: out },
      ],
      stream: false,
      options: { temperature: 0.1, top_p: 0.9 },
    };
    const r2 = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: apiKey ? `Bearer ${apiKey}` : "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(fixPayload),
      cache: "no-store",
    });
    if (r2.ok) {
      const d2 = await r2.json();
      out = sanitize(d2?.choices?.[0]?.message?.content ?? out);
    }
    out = tidyArabic(out);
  }
  if (target === "en") out = out.replace(/\s{2,}/g, " ").trim();

  return out;
}

/* =================== POST handler =================== */
export async function POST(req: Request) {
  try {
    const { messages } = (await req.json()) as { messages: Msg[] };
    if (!messages?.length)
      return NextResponse.json({ error: "Missing messages" }, { status: 400 });

    const kb = loadKB();
    const latest = messages[messages.length - 1]?.content || "";
    const userLang: "ar" | "en" = detectArabic(latest) ? "ar" : "en";

    /* ---- 0) HARD SHORT-CIRCUITS: test + greetings/smalltalk ---- */
    if (isTestMsg(latest)) {
      const reply =
        userLang === "ar"
          ? "تمام—أنا شغّال منيح 😄 كيف فيني ساعدك اليوم؟"
          : "All good—I’m working fine 😄 How can I help you today?";
      return NextResponse.json({ reply, meta: { intent: "test" } });
    }
    if (isGreeting(latest) || isChitChat(latest)) {
      const reply = chitChatReply(latest, userLang);
      return NextResponse.json({ reply, meta: { chitchat: true } });
    }

    /* ---- 1) LANGUAGE SWITCH / TRANSLATE LAST ASSISTANT ---- */
    const lastAssistant =
      [...messages].reverse().find((m) => m.role === "assistant")?.content ??
      "";

    if (
      (RX.arSwitch.test(latest) || RX.enSwitch.test(latest)) &&
      lastAssistant
    ) {
      const baseURL = process.env.DO_AGENT_URL || "";
      const apiKey = process.env.DO_AGENT_KEY || "";
      const model = "llama3-8b-instruct";
      const target: "ar" | "en" = RX.arSwitch.test(latest) ? "ar" : "en";

      const translated = await translateWithLLM({
        text: lastAssistant,
        target,
        baseURL,
        apiKey,
        model,
      });

      return NextResponse.json({
        reply: translated,
        meta: {
          translatedFrom: userLang,
          to: target,
          intent: "translate_last",
        },
      });
    }
    if (
      (RX.arSwitch.test(latest) || RX.enSwitch.test(latest)) &&
      !lastAssistant
    ) {
      const fallback = RX.arSwitch.test(latest)
        ? "شو بتحبّ ترجم؟ اكتبلي النص اللي بدّك بالعربي."
        : "What would you like me to translate? Paste the text.";
      return NextResponse.json({
        reply: fallback,
        meta: { intent: "translate_request" },
      });
    }

    /* ---- 2) NORMAL KB RETRIEVAL FLOW ---- */
    const dialogueCtx = buildDialogueContext(messages, latest);
    const retrievalQuery = dialogueCtx
      ? `${latest}

Follow-up context (for meaning only):
${dialogueCtx}`
      : latest;

    const { top, best, globalRelatedness } = retrieve(retrievalQuery, kb, 10);

    // Thresholds
    const BEST_MIN = 0.18;
    const RELATED_MIN = 0.1;

    // 1) Out-of-domain → if health-like → doctor; else hard stop
    if (best.score < RELATED_MIN && globalRelatedness < 0.22) {
      const doctorMsg =
        userLang === "ar"
          ? "من الأفضل سؤال طبيب أو شخص بالغ موثوق."
          : "It’s better to ask a doctor or a trusted adult.";
      const fallbackMsg =
        userLang === "ar"
          ? "I cant answer this question"
          : "I cant answer this question";
      return NextResponse.json({
        reply: isHealthLike(latest) ? doctorMsg : fallbackMsg,
        meta: {
          reason: isHealthLike(latest) ? "ood_health_like" : "out_of_domain",
          score: best.score,
          globalRelatedness,
        },
      });
    }

    // 2) Health/medication but NOT strongly covered by KB → always doctor
    if (isHealthLike(latest) && best.score < BEST_MIN) {
      const msg =
        userLang === "ar"
          ? "من الأفضل سؤال طبيب أو شخص بالغ موثوق."
          : "It’s better to ask a doctor or a trusted adult.";
      return NextResponse.json({
        reply: msg,
        meta: { reason: "health_like_weak_coverage", bestScore: best.score },
      });
    }

    // 3) In-domain but not covered (general) → doctor
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

    // Build CONTEXT from top matches
    const context = top
      .map((m) => `Q: ${m.pattern}\nA: ${m.response}`)
      .join("\n\n");

    // System instructions
    const system = buildSystemPrompt(userLang);

    // Optional area hint
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const hint = lastUser ? guessNearestLink(lastUser.content || "") : null;
    const preface = hint
      ? `This may be closest based on your area: ${hint}\n`
      : "";

    // Provider config (DigitalOcean Agent / OpenAI-style)
    const baseURL = process.env.DO_AGENT_URL || "";
    const apiKey = process.env.DO_AGENT_KEY || "";
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
