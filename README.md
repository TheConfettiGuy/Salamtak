# Smart Doctor Chat (Dataset-Limited, Ollama)

- Strictly answers from `data/intents_merged.json` using retrieval-augmented prompting.
- Doctor persona (warm, empathetic), Arabic/English, continuous chat.
- Friendly small‑talk (hello/thanks/bye) with emojis (allowed exception).
- Refusals:
  - Outside domain → **"I cant answer this question"**
  - In-domain but not covered → **"It’s better to ask a doctor or a trusted adult."**
- Memory persisted client-side (localStorage). Reset & Download (.json).

## Run
```bash
ollama pull llama3.1
ollama serve
npm install
cp .env.example .env.local
npm run dev
# open http://localhost:3000
```