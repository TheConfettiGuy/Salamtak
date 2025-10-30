export const metadata = {
  title: "Smart Doctor Chat (Dataset-Limited)",
  description:
    "Ollama RAG chatbot limited to intents_merged.json, with memory and friendly small-talk.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-sans-serif,system-ui",
          background: "#f8fafc",
          color: "#0f172a",
        }}
      >
        <main style={{ maxWidth: 960, margin: "0 auto", padding: "24px" }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>
            Your AI Chatbot
          </h1>
          {children}
        </main>
      </body>
    </html>
  );
}
