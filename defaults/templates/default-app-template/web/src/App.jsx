import { useState, useEffect } from "react";

export function App() {
  const [message, setMessage] = useState("Loading...");

  useEffect(() => {
    fetch("api/hello")
      .then((res) => res.json())
      .then((data) => setMessage(data.message))
      .catch(() => setMessage("Could not reach API"));
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <nav className="bg-nav text-white px-6 py-3 flex items-center gap-3">
        <h1 className="text-lg font-semibold">My App</h1>
      </nav>
      <main className="flex-1 p-6 flex flex-col items-center gap-6">
        <div className="bg-card rounded-md p-6 shadow-sm border border-border max-w-md w-full mt-8">
          <h2 className="text-lg font-semibold mb-2">Welcome</h2>
          <p className="text-text-secondary text-sm mb-4">
            This is your starter app. Edit the code and the preview will update automatically.
          </p>
          <div className="bg-page-bg rounded px-4 py-3 text-sm">
            <span className="text-text-muted">API says:</span>{" "}
            <span className="font-semibold">{message}</span>
          </div>
        </div>
      </main>
    </div>
  );
}
